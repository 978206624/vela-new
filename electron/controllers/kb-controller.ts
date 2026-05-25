import { ipcMain, dialog } from 'electron'
import fs from 'node:fs'
import {
  importDocument, importFolder, importText, searchKnowledge, searchKnowledgeFTS,
  listDocuments, removeDocument, getKnowledgeStats,
  getVectorlessCount, rebuildVectorIndex,
} from '../knowledge-base'
import { getKnownEmbeddingDimension } from '../embedding'
import { readJsonFile, GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG, MODELS_CONFIG_PATH, RECENT_PROJECTS_PATH } from '../utils/config-utils'
import { GlobalConfig, ModelProfile } from '../../src/shared/ipc-channels'

function getEmbeddingConfig(): { protocol: 'openai' | 'gemini'; model: { baseUrl: string; apiKey: string; modelName: string } } | null {
  const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
  const targetModelId = config.defaultEmbeddingModelId || config.defaultModelId
  if (!targetModelId) return null

  const models = readJsonFile<ModelProfile[]>(MODELS_CONFIG_PATH, [])
  const model = models.find((m) => m.id === targetModelId)
  if (!model) return null
  return {
    protocol: model.protocol as 'openai' | 'gemini',
    model: { baseUrl: model.baseUrl, apiKey: model.apiKey, modelName: model.modelName },
  }
}

function getCurrentProjectPath(): string | null {
  try {
    const recent = JSON.parse(fs.readFileSync(RECENT_PROJECTS_PATH, 'utf-8')) as Array<{ path: string }>
    return recent[0]?.path ?? null
  } catch { return null }
}

export function registerKBController() {
  ipcMain.handle('kb:import-document', async (_event, filePath: string) => {
    const embConfig = getEmbeddingConfig()
    const projectPath = getCurrentProjectPath()
    if (!projectPath) return { success: false, error: '未打开项目' }
    const protocol = embConfig?.protocol ?? 'openai'
    const model = embConfig?.model ?? { baseUrl: '', apiKey: '' }
    return importDocument(filePath, projectPath, protocol, model)
  })

  ipcMain.handle('kb:import-folder', async (_event, folderPath: string) => {
    const embConfig = getEmbeddingConfig()
    const projectPath = getCurrentProjectPath()
    if (!projectPath) return { success: false, error: '未打开项目' }
    const protocol = embConfig?.protocol ?? 'openai'
    const model = embConfig?.model ?? { baseUrl: '', apiKey: '' }
    return importFolder(folderPath, projectPath, protocol, model)
  })

  ipcMain.handle('kb:import-text', async (_event, text: string, fileName: string, projectPath: string) => {
    const embConfig = getEmbeddingConfig()
    const protocol = embConfig?.protocol ?? 'openai'
    const model = embConfig?.model ?? { baseUrl: '', apiKey: '' }
    return importText(text, fileName, projectPath, protocol, model)
  })

  ipcMain.handle('kb:search', async (_event, query: string, topK?: number, mode?: 'semantic' | 'keyword') => {
    const embConfig = getEmbeddingConfig()
    const projectPath = getCurrentProjectPath()
    if (!projectPath) return []

    // 关键词模式：强制走 FTS（LIKE），跳过嵌入；语义模式（默认）：有嵌入配置则向量优先
    if (mode === 'keyword' || !embConfig) {
      return searchKnowledgeFTS(query, projectPath, topK ?? 5)
    }
    return searchKnowledge(query, projectPath, embConfig.protocol, embConfig.model, topK ?? 5)
  })

  ipcMain.handle('kb:search-with-scope', async (_event, query: string, fromChapter: number, toChapter: number, topK?: number) => {
    const embConfig = getEmbeddingConfig()
    const projectPath = getCurrentProjectPath()
    if (!projectPath) return []

    const scope: [number, number] = [fromChapter, toChapter]
    if (embConfig) {
      return searchKnowledge(query, projectPath, embConfig.protocol, embConfig.model, topK ?? 5, scope)
    }
    return searchKnowledgeFTS(query, projectPath, topK ?? 5, scope)
  })

  ipcMain.handle('kb:list-documents', async () => {
    const projectPath = getCurrentProjectPath()
    if (!projectPath) return []
    return listDocuments(projectPath)
  })

  ipcMain.handle('kb:remove-document', async (_event, docId: string) => {
    const projectPath = getCurrentProjectPath()
    if (!projectPath) return { success: false }
    const success = await removeDocument(docId, projectPath)
    return { success }
  })

  ipcMain.handle('kb:stats', async () => {
    const projectPath = getCurrentProjectPath()
    if (!projectPath) {
      return { documentCount: 0, totalChunks: 0, vectorDimension: 0, embeddingModel: null, expectedDimension: null, dimensionMismatch: false }
    }
    const stats = await getKnowledgeStats(projectPath)

    // 用当前配置的嵌入模型推断「期望维度」，与已建索引维度对比，提示是否需重建
    const embConfig = getEmbeddingConfig()
    const currentModel = embConfig?.model.modelName ?? null
    const expectedDimension = getKnownEmbeddingDimension(currentModel)
    const dimensionMismatch =
      stats.vectorDimension > 0 && expectedDimension != null && expectedDimension !== stats.vectorDimension

    return {
      documentCount: stats.documentCount,
      totalChunks: stats.totalChunks,
      vectorDimension: stats.vectorDimension,
      // 已建索引所用模型（meta）优先；无则回退当前配置的模型名
      embeddingModel: stats.embeddingModel ?? currentModel,
      expectedDimension,
      dimensionMismatch,
    }
  })

  ipcMain.handle('kb:get-vectorless-count', async () => {
    const projectPath = getCurrentProjectPath()
    if (!projectPath) return { count: 0 }
    return getVectorlessCount(projectPath)
  })

  ipcMain.handle('kb:rebuild-index', async () => {
    const embConfig = getEmbeddingConfig()
    if (!embConfig) return { success: false, processed: 0, failed: 0, error: '未配置嵌入模型，请先在设置中为「嵌入」用途选择模型' }
    const projectPath = getCurrentProjectPath()
    if (!projectPath) return { success: false, processed: 0, failed: 0, error: '未打开项目' }
    return rebuildVectorIndex(projectPath, embConfig.protocol, embConfig.model)
  })

  ipcMain.handle('dialog:select-files', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      title: '选择要导入的文档',
      filters: [{ name: '文本文件', extensions: ['txt', 'md', 'markdown'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths
  })

  ipcMain.handle('dialog:select-import-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: '选择要批量导入的文件夹',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}

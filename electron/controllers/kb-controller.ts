import { ipcMain, dialog } from 'electron'
import {
  importDocument, importFolder, importText, searchKnowledge, searchKnowledgeFTS,
  listDocuments, removeDocument, getKnowledgeStats,
  getVectorlessCount, rebuildVectorIndex,
} from '../knowledge-base'
import { getKnownEmbeddingDimension } from '../embedding'
import { readJsonFile, GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG, MODELS_CONFIG_PATH } from '../utils/config-utils'
import { getCurrentProjectPath } from '../utils/current-project'
import { GlobalConfig, ModelProfile } from '../../src/shared/ipc-channels'

/**
 * 取"嵌入"用途的模型配置。
 *
 * 仅接受 purposes 显式包含 'embedding' 的模型——否则会把 chat 模型（如 Deepseek
 * 的 deepseek-v4-pro）当嵌入模型用，调 /embeddings 端点必然失败、且失败被
 * importText 的 try/catch 静默吞掉，造成"裸 chunk 入库"。
 *
 * 选择顺序：
 * 1. **显式配置优先**：若用户在 config 里设置了 defaultEmbeddingModelId，必须命中且
 *    该模型 purposes 含 'embedding'，否则返回 null（不静默回退）——避免用户的显式
 *    选择被"找下一个能用的"覆盖。
 * 2. **未配置时自动**：defaultEmbeddingModelId 为空时，找 models.json 第一个带
 *    'embedding' purpose 的模型。
 * 3. 都找不到 → 返回 null，由调用方告知"未配置嵌入模型"。
 */
function getEmbeddingConfig(): { protocol: 'openai' | 'gemini'; model: { baseUrl: string; apiKey: string; modelName: string } } | null {
  const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
  const models = readJsonFile<ModelProfile[]>(MODELS_CONFIG_PATH, [])

  let model: ModelProfile | undefined
  if (config.defaultEmbeddingModelId) {
    // 用户显式指定 → 必须命中合规模型，否则直接返回 null，不静默回退
    model = models.find((m) => m.id === config.defaultEmbeddingModelId && m.purposes?.includes('embedding'))
    if (!model) return null
  } else {
    // 未显式指定 → 自动选第一个带 embedding purpose 的模型
    model = models.find((m) => m.purposes?.includes('embedding'))
    if (!model) return null
  }

  // embedding 路径仅支持 openai / gemini 协议——Anthropic 没出 embedding 模型，
  // 防御性 guard：即便用户把 Claude 模型勾上 'embedding' purpose，也拒绝把它当嵌入模型用
  if (model.protocol !== 'openai' && model.protocol !== 'gemini') return null

  return {
    protocol: model.protocol,
    model: { baseUrl: model.baseUrl, apiKey: model.apiKey, modelName: model.modelName },
  }
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

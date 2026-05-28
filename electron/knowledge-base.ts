/**
 * Vela 知识库管理 — 主进程使用
 *
 * 管理文档导入、向量化和检索
 * 底层存储已从 vectors.json 迁移至 LanceDB（{projectPath}/.vela/lancedb/）
 *
 * 检索模式：
 * - 默认：BM25 全文检索（FTS），零配置即可用
 * - 增强：FTS + 向量近邻混合检索（需配置 Embedding 模型）
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as lancedb from '@lancedb/lancedb'
import { chunkText, generateEmbeddings } from './embedding'
import {
  addChunks,
  buildChunkSchema,
  removeDocument as removeDocFromStore,
  searchWithScope as storeSearchWithScope,
  listDocuments as storeListDocuments,
  getStats as storeGetStats,
  migrateFromJSON,
  getChunksWithoutVectors as storeGetChunksWithoutVectors,
} from './vector-store'

// ===== 知识库 meta 持久化（向量维度 + 嵌入模型） =====

/** 知识库索引元信息（落盘到 {projectPath}/.vela/kb-meta.json） */
export interface KBMeta {
  /** 当前向量索引的实际维度 */
  vectorDimension?: number
  /** 构建当前索引所用的嵌入模型名 */
  embeddingModel?: string
}

function getKBMetaPath(projectPath: string): string {
  return path.join(projectPath, '.vela', 'kb-meta.json')
}

/** 读取知识库 meta（不存在/损坏返回空对象） */
export function readKBMeta(projectPath: string): KBMeta {
  try {
    return JSON.parse(fs.readFileSync(getKBMetaPath(projectPath), 'utf-8')) as KBMeta
  } catch {
    return {}
  }
}

/** 合并写入知识库 meta（read-modify-write，各字段各自更新互不覆盖） */
function writeKBMeta(projectPath: string, patch: KBMeta): void {
  try {
    const next = { ...readKBMeta(projectPath), ...patch }
    fs.mkdirSync(path.dirname(getKBMetaPath(projectPath)), { recursive: true })
    fs.writeFileSync(getKBMetaPath(projectPath), JSON.stringify(next, null, 2), 'utf-8')
  } catch (e) {
    console.warn('[Vela KB] 写入 kb-meta.json 失败:', e)
  }
}

/** 嵌入模型引用（baseUrl/apiKey 必备，modelName 用于落 meta 与默认模型名推断） */
export type EmbeddingModelRef = { baseUrl: string; apiKey: string; modelName?: string }

// ===== 迁移状态跟踪 =====

/** 已执行过迁移检查的项目路径集合 */
const migratedProjects = new Set<string>()

/** 确保旧数据已迁移 */
async function ensureMigration(projectPath: string): Promise<void> {
  if (migratedProjects.has(projectPath)) return

  const jsonPath = path.join(projectPath, '.vela', 'vectors.json')
  if (!fs.existsSync(jsonPath)) {
    migratedProjects.add(projectPath) // 无旧数据，标记已检查
    return
  }

  // 仅在迁移真正成功后才标记，失败则下次（或重启后）重试，避免静默丢数据
  const result = await migrateFromJSON(projectPath)
  if (result.success) {
    migratedProjects.add(projectPath)
  }
}

// ===== 导出函数（保持旧签名，IPC 层零改动） =====

/**
 * 导入文档到知识库（单文件，从磁盘读取）
 * 始终建立 FTS 索引；有 Embedding 配置时额外生成向量
 */
export async function importDocument(
  filePath: string,
  projectPath: string,
  protocol: 'openai' | 'gemini',
  model: EmbeddingModelRef,
  onProgress?: (progress: number, message: string) => void,
): Promise<{ success: boolean; docId?: string; chunkCount?: number; error?: string; embeddingFailed?: boolean; embeddingError?: string }> {
  try {
    await ensureMigration(projectPath)

    // 1. 读取文件
    const fileName = path.basename(filePath)
    const ext = path.extname(filePath).toLowerCase()
    if (!['.txt', '.md', '.markdown'].includes(ext)) {
      return { success: false, error: `不支持的文件类型: ${ext}，仅支持 .txt / .md` }
    }

    onProgress?.(5, `正在读取 ${fileName}...`)
    const content = fs.readFileSync(filePath, 'utf-8')
    if (!content.trim()) {
      return { success: false, error: '文件内容为空' }
    }

    // 2. 分块
    onProgress?.(10, '正在分块...')
    const chunks = chunkText(content, 500, 50)
    const docId = randomUUID()

    // 3. 可选：生成向量（如果有 Embedding 配置）
    // embeddingFailed 仅在「配了 apiKey 却调用失败」时为 true，用于告知用户已降级为关键词模式
    // embeddingError 把具体失败原因冒泡给 UI，便于排查（如鉴权失败/端点错误）
    let vectors: number[][] | undefined
    let embeddingFailed = false
    let embeddingError: string | undefined
    if (model.apiKey) {
      try {
        onProgress?.(20, `正在向量化 ${chunks.length} 个块...`)
        vectors = await generateEmbeddings(chunks, protocol, model)
      } catch (e) {
        console.warn('[Vela KB] Embedding 调用失败，降级为 FTS-only:', e)
        embeddingFailed = true
        embeddingError = String(e instanceof Error ? e.message : e)
        // 不影响导入，仅 FTS
      }
    }

    // 4. 写入 LanceDB（text + 元数据 + 可选向量）
    onProgress?.(80, '正在保存...')
    const result = await addChunks(projectPath, docId, fileName, chunks, vectors, filePath)

    if (!result.success) {
      return { success: false, error: result.error }
    }

    // 落 meta：记录本次索引的实际维度与嵌入模型，供 UI 展示与换模型检测
    if (result.dimension) {
      writeKBMeta(projectPath, { vectorDimension: result.dimension, embeddingModel: model.modelName })
    }

    onProgress?.(100, `✅ 已导入 ${fileName}（${chunks.length} 个块）`)
    return { success: true, docId, chunkCount: chunks.length, embeddingFailed, embeddingError }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

/**
 * 检索知识库
 * 有 Embedding 配置时 → 混合检索（FTS + 向量）
 * 无 Embedding 配置时 → 纯 FTS 检索
 */
export async function searchKnowledge(
  query: string,
  projectPath: string,
  protocol: 'openai' | 'gemini',
  model: EmbeddingModelRef,
  topK: number = 5,
  chapterScope?: [number, number],
): Promise<Array<{ text: string; score: number; fileName: string }>> {
  await ensureMigration(projectPath)

  // 可选：生成查询向量
  let queryVector: number[] | undefined
  if (model.apiKey && query.trim()) {
    try {
      const [vec] = await generateEmbeddings([query], protocol, model)
      if (vec && vec.length > 0) {
        queryVector = vec
      }
    } catch {
      // Embedding 不可用，降级为 FTS
    }
  }

  return storeSearchWithScope(projectPath, query, queryVector, topK, chapterScope)
}

/**
 * 列出已导入文档
 */
export function listDocuments(projectPath: string) {
  return storeListDocuments(projectPath)
}

/**
 * 删除文档
 */
export async function removeDocument(docId: string, projectPath: string): Promise<boolean> {
  return removeDocFromStore(projectPath, docId)
}

/**
 * 获取知识库统计
 */
export async function getKnowledgeStats(projectPath: string): Promise<{
  documentCount: number
  totalChunks: number
  vectorDimension: number
  embeddingModel: string | null
}> {
  const stats = await storeGetStats(projectPath)
  const meta = readKBMeta(projectPath)
  return {
    documentCount: stats.documentCount,
    totalChunks: stats.totalChunks,
    vectorDimension: stats.vectorDimension,
    embeddingModel: meta.embeddingModel ?? null,
  }
}

/**
 * 批量导入文件夹到知识库（递归扫描所有 .txt / .md 文件）
 */
export async function importFolder(
  folderPath: string,
  projectPath: string,
  protocol: 'openai' | 'gemini',
  model: EmbeddingModelRef,
  onProgress?: (current: number, total: number, fileName: string) => void,
): Promise<{
  success: boolean
  importedCount: number
  failedFiles: string[]
  error?: string
  embeddingFailedCount?: number
  firstEmbeddingError?: string
}> {
  try {
    // 递归收集所有 .txt / .md 文件
    const collectFiles = (dir: string): string[] => {
      const result: string[] = []
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          result.push(...collectFiles(fullPath))
        } else if (/\.(txt|md|markdown)$/i.test(entry.name)) {
          result.push(fullPath)
        }
      }
      return result
    }

    const files = collectFiles(folderPath)
    if (files.length === 0) return { success: true, importedCount: 0, failedFiles: [] }

    const failedFiles: string[] = []
    let importedCount = 0
    let firstError: string | undefined
    // 嵌入失败但 FTS 入库成功的文件数——避免与"入库失败"混为一谈被静默吞
    let embeddingFailedCount = 0
    let firstEmbeddingError: string | undefined

    for (let i = 0; i < files.length; i++) {
      const filePath = files[i]
      const fileName = path.basename(filePath)
      onProgress?.(i + 1, files.length, fileName)

      const result = await importDocument(filePath, projectPath, protocol, model)
      if (result.success) {
        importedCount++
        if (result.embeddingFailed) {
          embeddingFailedCount++
          if (!firstEmbeddingError && result.embeddingError) firstEmbeddingError = result.embeddingError
        }
      } else {
        failedFiles.push(fileName)
        if (!firstError && result.error) firstError = result.error
      }
    }

    // 全部失败（如维度不一致）时返回失败并带出首个错误，避免静默"成功"
    if (importedCount === 0 && failedFiles.length > 0) {
      return { success: false, importedCount, failedFiles, error: firstError || '全部文件导入失败', embeddingFailedCount, firstEmbeddingError }
    }
    return { success: true, importedCount, failedFiles, embeddingFailedCount, firstEmbeddingError }
  } catch (error) {
    return { success: false, importedCount: 0, failedFiles: [], error: String(error) }
  }
}

/**
 * 直接将文本字符串内容导入知识库
 * 用于定稿后自动导入、按章推演等无文件场景
 */
/**
 * 从文件名解析章节元数据
 * 支持格式：第{N}章 {title} xxx.md
 */
function parseChapterMetaFromFileName(fileName: string): { chapterNumber?: number; chapterTitle?: string } | undefined {
  const match = fileName.match(/^第(\d+)章\s+(.+?)\s+(正文|要点|蓝图)\.md$/)
  if (match) {
    return {
      chapterNumber: parseInt(match[1]),
      chapterTitle: match[2],
    }
  }
  return undefined
}

export async function importText(
  text: string,
  fileName: string,
  projectPath: string,
  protocol: 'openai' | 'gemini',
  model: EmbeddingModelRef,
): Promise<{ success: boolean; docId?: string; chunkCount?: number; error?: string; embeddingFailed?: boolean; embeddingError?: string }> {
  try {
    if (!text.trim()) return { success: false, error: '文本内容为空' }

    await ensureMigration(projectPath)

    // 分块
    const chunks = chunkText(text)
    const docId = randomUUID()

    // 解析章节元数据（从文件名提取）
    const chapterMeta = parseChapterMetaFromFileName(fileName)

    // 可选：生成向量
    // embeddingFailed 仅在「调用嵌入接口失败」时为 true，用于让上层提示"已降级为关键词模式"；
    // 入库本身仍会成功（FTS-only），与 importDocument 行为一致。
    let vectors: number[][] | undefined
    let embeddingFailed = false
    let embeddingError: string | undefined
    if (model.apiKey) {
      try {
        vectors = await generateEmbeddings(chunks, protocol, model)
      } catch (e) {
        console.warn('[Vela KB] importText Embedding 失败，降级 FTS-only:', e)
        embeddingFailed = true
        embeddingError = String(e instanceof Error ? e.message : e)
      }
    }

    // 先记录同名旧文档的 docId（仅查询、不删除），以便写入成功后再清理其残留块。
    // 注意：必须先记录——addChunks 内部会按 fileName 删除 documents 表旧条目，
    // 之后就再也查不到旧 docId，旧 chunks 会变孤儿。
    const existingDocs = await storeListDocuments(projectPath)
    const existingDoc = existingDocs.find(d => d.fileName === fileName)

    // 先写新块（新 docId）。维度不一致时 addChunks 在写入前即返回失败，旧数据完整保留，
    // 不会因「先删后写」在失败时丢数据（Codex must-fix）。
    const result = await addChunks(projectPath, docId, fileName, chunks, vectors, undefined, chapterMeta)
    if (!result.success) {
      return { success: false, error: result.error }
    }

    // 写入成功后再清理同名旧文档的残留 chunks（documents 表条目已被 addChunks 按 fileName 去重）
    if (existingDoc && existingDoc.id !== docId) {
      await removeDocFromStore(projectPath, existingDoc.id)
    }

    if (result.dimension) {
      writeKBMeta(projectPath, { vectorDimension: result.dimension, embeddingModel: model.modelName })
    }

    return { success: true, docId, chunkCount: chunks.length, embeddingFailed, embeddingError }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// ===== 向量索引重建 =====

/**
 * 获取缺少向量的块数量
 */
export async function getVectorlessCount(projectPath: string): Promise<{ count: number }> {
  return storeGetChunksWithoutVectors(projectPath)
}

/**
 * 重建向量索引：对全部文本块用**当前嵌入模型**重新生成向量，按其实际维度重建 chunks 表。
 *
 * 一并解决两类问题：
 * 1. 缺向量（FTS-only 导入的块）—— 补齐向量启用语义检索；
 * 2. 维度不一致（换了嵌入模型，旧索引维度与新模型不符）—— 删表后按新维度重建，不再崩溃。
 *
 * 维度完全由 API 实际返回的向量长度决定（不再硬编码 2048），并写入 kb-meta.json。
 */
export async function rebuildVectorIndex(
  projectPath: string,
  protocol: 'openai' | 'gemini',
  model: EmbeddingModelRef,
): Promise<{ success: boolean; processed: number; failed: number; error?: string }> {
  try {
    await ensureMigration(projectPath)

    const { getConnection } = await import('./vector-store')
    const db = await getConnection(projectPath)
    const tableNames = await db.tableNames()
    if (!tableNames.includes('chunks')) {
      return { success: true, processed: 0, failed: 0 }
    }

    const table = await db.openTable('chunks')
    const allRows = await table.query().toArray()
    if (allRows.length === 0) {
      return { success: true, processed: 0, failed: 0 }
    }

    // 用当前模型对所有块重新生成向量
    const texts = allRows.map((r: { text?: unknown }) => String(r.text ?? ''))
    const vectors = await generateEmbeddings(texts, protocol, model)

    // 实际维度以返回向量长度为准
    const newDim = vectors.find((v) => Array.isArray(v) && v.length > 0)?.length ?? 0
    if (newDim === 0) {
      return { success: false, processed: 0, failed: allRows.length, error: '嵌入生成失败，请检查嵌入模型配置' }
    }

    // 重建行：丢弃旧向量，写入新向量（维度一致的才采用）
    const idToVector = new Map<string, number[]>()
    allRows.forEach((r: { id?: unknown }, i: number) => {
      if (vectors[i] && vectors[i].length === newDim) {
        idToVector.set(String(r.id), vectors[i])
      }
    })

    const updatedRows = allRows.map((r: Record<string, unknown>) => {
      const cleaned: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(r)) {
        if (k === 'vector') continue // 旧向量丢弃，下面统一重写
        cleaned[k] = v
      }
      const v = idToVector.get(String(r.id))
      if (v) cleaned.vector = v
      return cleaned
    })

    // 删表 + 按新维度重建（无 DB 迁移机制，维度变更即全量重建，见技术决策）
    await db.dropTable('chunks')
    await db.createTable('chunks', updatedRows, { schema: buildChunkSchema(newDim) })

    const newTable = await db.openTable('chunks')
    try {
      await newTable.createIndex('text', { config: lancedb.Index.fts() })
    } catch { /* 索引可能已存在 */ }

    const processed = idToVector.size

    // 全表统计实际写入向量的行数（不抽样），与预期对比验证 schema 写入是否成功
    const verifyRows = await newTable.query().select(['id', 'vector']).toArray()
    const persisted = verifyRows.filter((r: { vector?: unknown }) => {
      if (!r.vector) return false
      const vec = r.vector as { length?: number; toArray?: () => unknown[] }
      if (typeof vec.toArray === 'function') return vec.toArray().length > 0
      return (vec.length ?? 0) > 0
    }).length

    // 期望写入 processed 条向量，却一条都没落盘 → 判定 schema 写入失败
    if (processed > 0 && persisted === 0) {
      return { success: false, processed: 0, failed: allRows.length, error: '重建后向量未落盘，可能是 LanceDB schema 写入失败' }
    }

    writeKBMeta(projectPath, { vectorDimension: newDim, embeddingModel: model.modelName })

    return { success: true, processed, failed: allRows.length - processed }
  } catch (error) {
    console.error('[Vela KB] 向量索引重建异常:', error)
    return { success: false, processed: 0, failed: 0, error: String(error) }
  }
}

/**
 * FTS-only 检索（不需要 Embedding 配置）
 * 用于 IPC 层在无 Embedding 模型时直接调用
 */
export async function searchKnowledgeFTS(
  query: string,
  projectPath: string,
  topK: number = 5,
  chapterScope?: [number, number],
): Promise<Array<{ text: string; score: number; fileName: string }>> {
  await ensureMigration(projectPath)
  return storeSearchWithScope(projectPath, query, undefined, topK, chapterScope)
}

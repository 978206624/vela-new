/**
 * Vela 向量数据库封装 — 基于 LanceDB
 *
 * 提供本地嵌入式向量数据库能力，替代旧的 vectors.json 方案。
 * 支持两种检索模式：
 * - FTS-only（BM25 全文检索，零配置默认可用）
 * - 混合检索（FTS + 向量近邻，需要 Embedding 模型）
 *
 * 存储位置：{projectPath}/.vela/lancedb/
 */
import * as lancedb from '@lancedb/lancedb'
import { Field, FixedSizeList as ArrowFixedSizeList, Float32, Int32, Utf8, Schema as ArrowSchema } from 'apache-arrow'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

// ===== 类型定义 =====

/** 写入 LanceDB 的文本块记录 */
export interface ChunkRecord {
  [key: string]: unknown
  id: string
  docId: string
  fileName: string
  /** 章节号（可选，用于范围检索） */
  chapterNumber?: number
  /** 章节标题（可选，用于展示） */
  chapterTitle?: string
  text: string
  vector?: number[]
  chunkIndex: number
  totalChunks: number
  importedAt: string
}

/** 文档元信息（聚合查询结果） */
export interface DocumentInfo {
  [key: string]: unknown
  id: string
  fileName: string
  importedAt: string
  chunkCount: number
  filePath: string
}

/** 检索结果 */
export interface SearchResult {
  text: string
  score: number
  fileName: string
}

/** 知识库统计 */
export interface KBStats {
  documentCount: number
  totalChunks: number
  vectorDimension: number
  hasVectors: boolean
}

// ===== 常量 =====

const TABLE_NAME = 'chunks'
const DOCS_TABLE_NAME = 'documents'

// ===== Schema 构建（向量维度动态化，不再硬编码 2048） =====

/**
 * 构建 chunks 表的 Arrow Schema。
 *
 * @param dim 向量维度。> 0 时包含 FixedSizeList<Float32, dim> 向量列；
 *            为空/0（FTS-only 场景）时**不建向量列** —— 维度未知就不凭空猜，
 *            等真正生成向量（导入或重建）时再带正确维度建列。
 */
export function buildChunkSchema(dim?: number): ArrowSchema {
  const fields: Field[] = [
    new Field('id', new Utf8()),
    new Field('docId', new Utf8()),
    new Field('fileName', new Utf8()),
    new Field('chapterNumber', new Int32(), true),
    new Field('chapterTitle', new Utf8(), true),
    new Field('text', new Utf8()),
  ]
  if (dim && dim > 0) {
    fields.push(new Field('vector', new ArrowFixedSizeList(dim, new Field('item', new Float32())), true))
  }
  fields.push(
    new Field('chunkIndex', new Int32()),
    new Field('totalChunks', new Int32()),
    new Field('importedAt', new Utf8()),
  )
  return new ArrowSchema(fields)
}

/** 从已有 schema 读取向量列的真实维度；无向量列返回 0 */
export function getSchemaVectorDim(schema: ArrowSchema): number {
  const vf = schema.fields.find((f) => f.name === 'vector')
  if (!vf) return 0
  const t = vf.type as { listSize?: number }
  return typeof t.listSize === 'number' ? t.listSize : 0
}

/** chunks 表的非向量必备字段（用于旧表字段迁移判断，与向量列无关） */
const NON_VECTOR_FIELDS = [
  'id', 'docId', 'fileName', 'text', 'chunkIndex', 'totalChunks', 'importedAt', 'chapterNumber', 'chapterTitle',
]

/**
 * 把一行记录里的 Arrow Vector 对象转成可写入的数组（toArray() 返回 Float32Array，
 * LanceDB createTable 接受 typed array），避免 isValid 等元数据干扰 schema 校验。
 */
function cleanRow(r: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(r)) {
    if (k === 'vector' && v) {
      const vec = v as { toArray?: () => ArrayLike<number> }
      cleaned[k] = vec.toArray ? vec.toArray() : v
    } else {
      cleaned[k] = v
    }
  }
  return cleaned
}

// ===== 连接池（按项目路径缓存） =====

const connectionPool = new Map<string, lancedb.Connection>()

/** 获取 LanceDB 连接（惰性创建） */
export async function getConnection(projectPath: string): Promise<lancedb.Connection> {
  const dbPath = path.join(projectPath, '.vela', 'lancedb')
  
  const cached = connectionPool.get(dbPath)
  if (cached) return cached

  // 确保目录存在
  fs.mkdirSync(dbPath, { recursive: true })

  const db = await lancedb.connect(dbPath)
  connectionPool.set(dbPath, db)
  return db
}

/** 关闭指定项目的连接 */
export function closeConnection(projectPath: string): void {
  const dbPath = path.join(projectPath, '.vela', 'lancedb')
  connectionPool.delete(dbPath)
}


// ===== 核心操作 =====

/**
 * 写入文档块到 LanceDB
 * 支持带向量（混合模式）和不带向量（FTS-only 模式）
 */
export async function addChunks(
  projectPath: string,
  docId: string,
  fileName: string,
  chunks: string[],
  vectors?: number[][],
  filePath?: string,
  metadata?: { chapterNumber?: number; chapterTitle?: string },
): Promise<{ success: boolean; chunkCount: number; error?: string; dimension?: number }> {
  try {
    const db = await getConnection(projectPath)
    const now = new Date().toISOString()

    // 本批向量的实际维度（以第一条非空向量为准）；FTS-only 时为 0
    const dimFromVectors = vectors?.find((v) => Array.isArray(v) && v.length > 0)?.length ?? 0

    // 构建记录（仅在向量维度匹配时附带向量，避免脏数据）
    const records: ChunkRecord[] = chunks.map((text, i) => {
      const record: ChunkRecord = {
        id: randomUUID(),
        docId,
        fileName,
        text,
        chunkIndex: i,
        totalChunks: chunks.length,
        importedAt: now,
        chapterNumber: metadata?.chapterNumber,
        chapterTitle: metadata?.chapterTitle,
      }
      if (dimFromVectors > 0 && vectors?.[i] && vectors[i].length === dimFromVectors) {
        record.vector = vectors[i]
      }
      return record
    })

    const tableNames = await db.tableNames()

    if (!tableNames.includes(TABLE_NAME)) {
      // 首次创建：维度由本批向量决定（无向量则不建向量列）
      await db.createTable(TABLE_NAME, records, { schema: buildChunkSchema(dimFromVectors) })
    } else {
      const table = await db.openTable(TABLE_NAME)
      const existingSchema = await table.schema()
      const existingFieldNames = existingSchema.fields.map((f) => f.name)
      const existingDim = getSchemaVectorDim(existingSchema)
      const hasVectorCol = existingFieldNames.includes('vector')
      const hasAllNonVectorFields = NON_VECTOR_FIELDS.every((f) => existingFieldNames.includes(f))

      // 维度不一致保护：换嵌入模型后维度变了 —— 返回友好错误而非让 LanceDB 崩溃
      if (dimFromVectors > 0 && hasVectorCol && existingDim > 0 && existingDim !== dimFromVectors) {
        return {
          success: false,
          chunkCount: 0,
          error: `向量维度不一致：知识库现有索引为 ${existingDim} 维，当前嵌入模型输出 ${dimFromVectors} 维。请在知识库页点击「重建向量索引」后再导入。`,
        }
      }

      // 是否需要新增向量列（FTS-only 旧表首次写入带向量的数据）
      const needAddVectorCol = dimFromVectors > 0 && !hasVectorCol

      if (hasAllNonVectorFields && !needAddVectorCol) {
        await table.add(records)
      } else {
        // 需要重建表：补齐缺失的非向量字段，或为旧表新增向量列
        const allRows = (await table.query().toArray()).map((r: Record<string, unknown>) => cleanRow(r))
        const targetDim = dimFromVectors > 0 ? dimFromVectors : existingDim
        await db.dropTable(TABLE_NAME)
        await db.createTable(TABLE_NAME, [...allRows, ...records], { schema: buildChunkSchema(targetDim) })
      }
    }

    // 写入/更新 documents 表
    const docInfo: DocumentInfo = {
      id: docId,
      fileName,
      importedAt: now,
      chunkCount: chunks.length,
      filePath: filePath || '',
    }

    if (tableNames.includes(DOCS_TABLE_NAME)) {
      const docsTable = await db.openTable(DOCS_TABLE_NAME)
      // 先删除同名文档（幂等性），再添加新的
      try {
        await docsTable.delete(`fileName = '${fileName.replace(/'/g, "''")}'`)
      } catch { /* 表可能为空或无匹配 */ }
      await docsTable.add([docInfo])
    } else {
      await db.createTable(DOCS_TABLE_NAME, [docInfo])
    }

    // 尝试创建 FTS 索引（如果尚不存在）
    try {
      const chunksTable = await db.openTable(TABLE_NAME)
      await chunksTable.createIndex('text', {
        config: lancedb.Index.fts(),
      })
    } catch {
      // FTS 索引可能已存在，忽略错误
    }

    return { success: true, chunkCount: chunks.length, dimension: dimFromVectors || undefined }
  } catch (error) {
    console.error('[Vela VectorStore] 写入失败:', error)
    return { success: false, chunkCount: 0, error: String(error) }
  }
}

/**
 * 删除文档及其所有块
 */
export async function removeDocument(
  projectPath: string,
  docId: string,
): Promise<boolean> {
  try {
    const db = await getConnection(projectPath)
    const tableNames = await db.tableNames()

    if (tableNames.includes(TABLE_NAME)) {
      const table = await db.openTable(TABLE_NAME)
      await table.delete(`docId = '${docId}'`)
    }

    if (tableNames.includes(DOCS_TABLE_NAME)) {
      const docsTable = await db.openTable(DOCS_TABLE_NAME)
      await docsTable.delete(`id = '${docId}'`)
    }

    return true
  } catch (error) {
    console.error('[Vela VectorStore] 删除失败:', error)
    return false
  }
}

/**
 * 按 fileName 删除 chunks 表中的残留块，但保留指定 docId 的块。
 *
 * 用于「重新定稿」覆盖式导入：写入新 docId 成功后，清掉同名文件历史版本残留的所有 chunks，
 * 包括 documents 表已无对应行的「孤儿块」（removeDocument 只能按 docId 删，覆盖不到孤儿）。
 * fileName 做单引号转义（与 addChunks 的 documents 去重谓词一致），以处理含特殊字符的章节标题。
 */
export async function removeChunksByFileNameExcept(
  projectPath: string,
  fileName: string,
  keepDocId: string,
): Promise<boolean> {
  try {
    const db = await getConnection(projectPath)
    const tableNames = await db.tableNames()
    if (tableNames.includes(TABLE_NAME)) {
      const table = await db.openTable(TABLE_NAME)
      const fn = fileName.replace(/'/g, "''")
      const keep = keepDocId.replace(/'/g, "''")
      await table.delete(`fileName = '${fn}' AND docId != '${keep}'`)
    }
    return true
  } catch (error) {
    console.error('[Vela VectorStore] 按文件名清理残留块失败:', error)
    return false
  }
}

/**
 * 统一检索入口 — 自动选择 FTS / 混合模式
 *
 * @param queryText 搜索关键词/语句
 * @param queryVector 查询向量（可选，有值时启用混合检索）
 * @param topK 返回前 K 个结果
 */
export async function search(
  projectPath: string,
  queryText: string,
  queryVector?: number[],
  topK: number = 5,
): Promise<SearchResult[]> {
  return searchWithScope(projectPath, queryText, queryVector, topK)
}

/**
 * 支持章节范围限定的检索入口
 *
 * @param queryText 搜索关键词/语句
 * @param queryVector 查询向量（可选，有值时启用混合检索）
 * @param topK 返回前 K 个结果
 * @param chapterScope 可选，限定检索的章节范围 [fromChapter, toChapter]
 */
export async function searchWithScope(
  projectPath: string,
  queryText: string,
  queryVector?: number[],
  topK: number = 5,
  chapterScope?: [number, number],
): Promise<SearchResult[]> {
  try {
    const db = await getConnection(projectPath)
    const tableNames = await db.tableNames()
    if (!tableNames.includes(TABLE_NAME)) return []

    const table = await db.openTable(TABLE_NAME)

    // 构建范围过滤条件
    let scopeFilter: string | undefined
    if (chapterScope) {
      const [from, to] = chapterScope
      scopeFilter = `chapterNumber >= ${from} AND chapterNumber <= ${to}`
    }

    // 如果有查询向量，先尝试混合检索
    if (queryVector && queryVector.length > 0) {
      try {
        let query = table.search(queryVector).limit(topK)
        if (scopeFilter) {
          query = query.where(scopeFilter)
        }
        const results = await query.toArray()

        if (results.length > 0) {
          return results.map((r: { text: string; _distance?: number; fileName: string }) => ({
            text: r.text,
            score: r._distance != null ? 1 / (1 + r._distance) : 0.5,
            fileName: r.fileName,
          }))
        }
      } catch {
        // 向量检索失败，降级到 FTS
      }
    }

    // FTS 检索 (Tantivy 不支持中文分词，改为 DataFusion LIKE 模糊匹配)
    try {
      const escapedQuery = queryText.replace(/'/g, "''")
      // 将 "搜索" 转换为 "%搜%索%" 进行容错匹配
      const likePattern = `%${escapedQuery.split('').join('%')}%`

      let q = table.query().filter(`text LIKE '${likePattern}'`).limit(topK)
      if (scopeFilter) {
        q = q.where(scopeFilter)
      }
      const results = await q.toArray()

      return results.map((r: { text: string; fileName: string }) => ({
        text: r.text,
        score: 0.5, // 普通匹配无打分
        fileName: r.fileName,
      }))
    } catch (e) {
      console.warn('[Vela VectorStore] 纯文本检索失败:', e)
      return []
    }
  } catch (error) {
    console.error('[Vela VectorStore] 检索失败:', error)
    return []
  }
}

/**
 * 列出所有已导入文档
 */
export async function listDocuments(
  projectPath: string,
): Promise<DocumentInfo[]> {
  try {
    const db = await getConnection(projectPath)
    const tableNames = await db.tableNames()
    if (!tableNames.includes(DOCS_TABLE_NAME)) return []

    const docsTable = await db.openTable(DOCS_TABLE_NAME)
    const rows = await docsTable.query().toArray()
    return rows.map((r: { id: string; fileName: string; importedAt: string; chunkCount: number; filePath?: string }) => ({
      id: r.id,
      fileName: r.fileName,
      importedAt: r.importedAt,
      chunkCount: r.chunkCount,
      filePath: r.filePath || '',
    }))
  } catch {
    return []
  }
}

/**
 * 获取知识库统计信息
 */
export async function getStats(projectPath: string): Promise<KBStats> {
  try {
    const db = await getConnection(projectPath)
    const tableNames = await db.tableNames()

    if (!tableNames.includes(TABLE_NAME)) {
      return { documentCount: 0, totalChunks: 0, vectorDimension: 0, hasVectors: false }
    }

    const docs = tableNames.includes(DOCS_TABLE_NAME)
      ? await (await db.openTable(DOCS_TABLE_NAME)).countRows()
      : 0

    const table = await db.openTable(TABLE_NAME)
    const totalChunks = await table.countRows()

    // 检测向量列并读取真实维度（FixedSizeList.listSize，不再硬编码）
    let hasVectors = false
    let vectorDimension = 0
    try {
      const schema = await table.schema()
      vectorDimension = getSchemaVectorDim(schema)
      hasVectors = vectorDimension > 0
    } catch { /* 忽略 */ }

    return {
      documentCount: docs,
      totalChunks,
      vectorDimension,
      hasVectors,
    }
  } catch {
    return { documentCount: 0, totalChunks: 0, vectorDimension: 0, hasVectors: false }
  }
}

/**
 * 获取没有向量的文本块数量（用于回填检测）
 */
export async function getChunksWithoutVectors(
  projectPath: string,
): Promise<{ count: number }> {
  try {
    const db = await getConnection(projectPath)
    const tableNames = await db.tableNames()
    if (!tableNames.includes(TABLE_NAME)) return { count: 0 }

    const table = await db.openTable(TABLE_NAME)
    const schema = await table.schema()
    const hasVectorCol = schema.fields.some(f => f.name === 'vector')

    if (!hasVectorCol) {
      const total = await table.countRows()
      return { count: total }
    }

    // 有 vector 列的情况下，统计 vector 为 null 的记录
    const all = await table.query().select(['id', 'vector']).toArray()
    const missing = all.filter((r: { id: string; vector?: unknown }) => {
      if (!r.vector) return true
      const vec = r.vector as { length?: number; toArray?: () => unknown[] }
      if (typeof vec.toArray === 'function') {
        return vec.toArray().length === 0
      }
      return (vec.length ?? -1) === 0
    })
    return { count: missing.length }
  } catch (e) {
    console.error('[Vela KB] getChunksWithoutVectors error:', e)
    return { count: 0 }
  }
}

/**
 * 从旧 vectors.json 迁移数据到 LanceDB
 */
export async function migrateFromJSON(
  projectPath: string,
): Promise<{ success: boolean; migrated: number; error?: string }> {
  const jsonPath = path.join(projectPath, '.vela', 'vectors.json')

  if (!fs.existsSync(jsonPath)) {
    return { success: true, migrated: 0 }
  }

  // 提到 try 外层：任何失败路径（addChunks 失败 / rename 失败 / 其他异常）都在 catch 中统一回滚，
  // 保证不会留下「已写入数据 + 源 JSON 仍在」的组合，避免下次重试重复累加 chunks。
  const writtenDocIds: string[] = []

  try {
    console.log('[Vela VectorStore] 检测到旧 vectors.json，开始迁移...')
    const raw = fs.readFileSync(jsonPath, 'utf-8')
    const store = JSON.parse(raw) as {
      documents: Array<{ id: string; fileName: string; importedAt: string; chunkCount: number; filePath: string }>
      entries: Array<{ id: string; docId: string; text: string; vector: number[]; meta: { fileName: string; chunkIndex: number; totalChunks: number } }>
    }

    if (!store.entries || store.entries.length === 0) {
      // 空知识库，无需迁移
      fs.renameSync(jsonPath, jsonPath + '.migrated')
      return { success: true, migrated: 0 }
    }

    // 按文档分组写入
    const docMap = new Map<string, typeof store.entries>()
    for (const entry of store.entries) {
      const arr = docMap.get(entry.docId) || []
      arr.push(entry)
      docMap.set(entry.docId, arr)
    }

    let migrated = 0
    for (const [docId, entries] of docMap) {
      const docInfo = store.documents.find(d => d.id === docId)
      const fileName = docInfo?.fileName || entries[0]?.meta?.fileName || 'unknown'

      const chunks = entries.map(e => e.text)
      const vectors = entries.map(e => e.vector).filter(v => v && v.length > 0)

      // 写前登记：即便 addChunks 写了 chunks 后在 documents 阶段失败留残块，也能被 catch 回滚
      writtenDocIds.push(docId)
      const res = await addChunks(
        projectPath,
        docId,
        fileName,
        chunks,
        vectors.length === chunks.length ? vectors : undefined,
        docInfo?.filePath,
      )
      // 失败即抛出，交由外层 catch 统一回滚（含 rename 失败等所有路径）
      if (!res.success) {
        throw new Error(res.error || `迁移文档 ${fileName} 失败`)
      }
      migrated += entries.length
    }

    // 迁移完成，重命名旧文件（若此处失败也会落入 catch 回滚，保证不留半成品 + 源 JSON）
    fs.renameSync(jsonPath, jsonPath + '.migrated')
    console.log(`[Vela VectorStore] 迁移完成：${migrated} 个块已写入 LanceDB`)

    return { success: true, migrated }
  } catch (error) {
    // 回滚本轮所有已登记的 docId，使表回到迁移前状态；保留源 JSON（不 rename）供下次重试
    console.error('[Vela VectorStore] 迁移失败，回滚本轮写入并保留 vectors.json:', error)
    for (const id of writtenDocIds) {
      try { await removeDocument(projectPath, id) } catch { /* 回滚尽力而为 */ }
    }
    return { success: false, migrated: 0, error: String(error) }
  }
}

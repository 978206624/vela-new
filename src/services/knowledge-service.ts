/**
 * knowledge-service — 知识库数据访问服务
 *
 * 封装 KnowledgeOverview 和 KnowledgePanel 中的 IPC 调用，
 * 避免组件直接与 IPC 通信。
 */

import { ipc } from './ipc-client'

/** 已导入文档 */
export interface KBDocument {
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
export interface KBStatsData {
  documentCount: number
  totalChunks: number
  /** 已建向量索引的实际维度（0 = 无向量，纯 FTS） */
  vectorDimension: number
  /** 构建当前索引所用嵌入模型名（无则为当前配置模型名 / null） */
  embeddingModel: string | null
  /** 当前配置嵌入模型的期望维度（未知模型为 null） */
  expectedDimension: number | null
  /** 当前模型期望维度与已建索引维度不一致 → 建议重建 */
  dimensionMismatch: boolean
}

/** 加载文档列表 */
export async function listDocuments(): Promise<KBDocument[]> {
  return ipc.invoke('kb:list-documents')
}

/** 获取知识库统计 */
export async function getStats(): Promise<KBStatsData> {
  return ipc.invoke('kb:stats')
}

/** 同时加载文档列表和统计（常用组合） */
export async function loadKBData(): Promise<{ documents: KBDocument[]; stats: KBStatsData }> {
  const [documents, stats] = await Promise.all([
    ipc.invoke('kb:list-documents'),
    ipc.invoke('kb:stats'),
  ])
  return { documents, stats }
}

/** 获取缺失向量的文档块数量 */
export async function getVectorlessCount(): Promise<number> {
  const result = await ipc.invoke('kb:get-vectorless-count') as { count: number }
  return result.count
}

/** 执行检索（mode 默认语义，可强制关键词 FTS） */
export async function searchKB(query: string, topK: number, mode: 'semantic' | 'keyword' = 'semantic'): Promise<SearchResult[]> {
  return ipc.invoke('kb:search', query, topK, mode)
}

/** 重建向量索引（全量重嵌入 + 按当前模型维度重建表） */
export async function rebuildVectorIndex(): Promise<{ success: boolean; processed: number; failed: number; error?: string }> {
  return ipc.invoke('kb:rebuild-index') as Promise<{ success: boolean; processed: number; failed: number; error?: string }>
}

/** 弹系统文件选择框（多选 .txt/.md），返回所选路径；取消返回 null */
export async function selectImportFiles(): Promise<string[] | null> {
  return ipc.invoke('dialog:select-files')
}

/** 导入单个文件到知识库（embeddingFailed=true 表示配了嵌入模型却调用失败，已降级为关键词入库） */
export async function importDocument(filePath: string): Promise<{ success: boolean; docId?: string; chunkCount?: number; error?: string; embeddingFailed?: boolean }> {
  return ipc.invoke('kb:import-document', filePath)
}

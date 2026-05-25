/**
 * stats-service — LLM 调用统计数据访问服务
 *
 * 封装 BottomPanel ModelsView 中的 IPC 调用。
 */

import { ipc } from './ipc-client'

/** LLM 调用统计 */
export interface LLMStats {
  totalCalls: number
  totalTokens: number
  totalPromptTokens: number
  totalCompletionTokens: number
  /** 今日调用次数（设计屏 25 顶部汇总） */
  todayCalls: number
  /** 今日总 token */
  todayTokens: number
}

/**
 * 用途代码 → 中文标签（底部「模型调用」面板「用途」列展示，对应设计屏 25）。
 * purpose 既可能是模型路由枚举（draft/outline/review/embedding），
 * 也可能是命令传入的更精确标签（如「章节要点」），未知值原样回退。
 */
const PURPOSE_LABELS: Record<string, string> = {
  draft: '正文生成',
  outline: '大纲生成',
  review: '审稿',
  embedding: '嵌入',
}

export function purposeLabel(purpose: string): string {
  if (!purpose) return '生成'
  return PURPOSE_LABELS[purpose] ?? purpose
}

/** LLM 调用记录 */
export interface LLMCallRecord {
  id: number
  modelName: string
  purpose: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  durationMs: number
  success: boolean
  createdAt: string
}

/** 获取 LLM 调用统计 */
export async function getLLMStats(): Promise<LLMStats> {
  return ipc.invoke('db:get-llm-stats')
}

/** 获取最近 LLM 调用记录 */
export async function getLLMHistory(limit = 30): Promise<LLMCallRecord[]> {
  return (await ipc.invoke('db:get-llm-history', limit)) as unknown as LLMCallRecord[]
}

/** 同时加载统计和历史（常用组合） */
export async function loadLLMData(limit = 30): Promise<{ stats: LLMStats; history: LLMCallRecord[] }> {
  const [stats, history] = await Promise.all([
    getLLMStats(),
    getLLMHistory(limit),
  ])
  return { stats, history }
}

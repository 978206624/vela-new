import { getProjectDb } from '../database'

export class LLMHistoryRepository {
  /** 记录一次 LLM 调用 */
  static logCall(call: {
    modelId: string
    modelName: string
    purpose: string
    promptTokens: number
    completionTokens: number
    totalTokens: number
    durationMs: number
    success: boolean
    errorMessage?: string
  }): void {
    const db = getProjectDb()
    if (!db) return

    // created_at 显式写本地时间（表默认 datetime('now') 为 UTC，会令「今日」统计在跨时区时错位）
    db.prepare(`
      INSERT INTO llm_calls (model_id, model_name, purpose, prompt_tokens, completion_tokens, total_tokens, duration_ms, success, error_message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
    `).run(
      call.modelId, call.modelName, call.purpose,
      call.promptTokens, call.completionTokens, call.totalTokens,
      call.durationMs, call.success ? 1 : 0, call.errorMessage ?? ''
    )
  }

  /** 获取调用统计（含「今日」汇总，对应设计屏 25 顶部「今日 N 次调用 · X tokens」） */
  static getStats(): {
    totalCalls: number
    totalTokens: number
    totalPromptTokens: number
    totalCompletionTokens: number
    todayCalls: number
    todayTokens: number
  } {
    const empty = { totalCalls: 0, totalTokens: 0, totalPromptTokens: 0, totalCompletionTokens: 0, todayCalls: 0, todayTokens: 0 }
    const db = getProjectDb()
    if (!db) return empty

    const row = db.prepare(`
      SELECT
        COUNT(*) as totalCalls,
        COALESCE(SUM(total_tokens), 0) as totalTokens,
        COALESCE(SUM(prompt_tokens), 0) as totalPromptTokens,
        COALESCE(SUM(completion_tokens), 0) as totalCompletionTokens,
        COALESCE(SUM(CASE WHEN date(created_at) = date('now','localtime') THEN 1 ELSE 0 END), 0) as todayCalls,
        COALESCE(SUM(CASE WHEN date(created_at) = date('now','localtime') THEN total_tokens ELSE 0 END), 0) as todayTokens
      FROM llm_calls WHERE success = 1
    `).get() as typeof empty

    return row
  }

  /** 获取最近 LLM 调用记录 */
  static getHistory(limit: number = 50): unknown[] {
    const db = getProjectDb()
    if (!db) return []
    return db.prepare(`
      SELECT id, model_name as modelName, purpose,
        prompt_tokens as promptTokens, completion_tokens as completionTokens,
        total_tokens as totalTokens, duration_ms as durationMs,
        success, created_at as createdAt
      FROM llm_calls ORDER BY id DESC LIMIT ?
    `).all(limit)
  }
}

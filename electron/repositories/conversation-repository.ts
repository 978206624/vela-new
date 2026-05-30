import { getProjectDb } from '../database'

/**
 * ConversationRepository — Agent 对话持久化（agent_conversations 表）
 *
 * 设计：每个小说项目一个独立 .vela/vela.db，库本身即项目隔离边界，
 * 对话表存进项目库即天然「跟项目走」，无需 project_id 字段。
 *
 * messages 作为不透明 JSON blob 存读：其形状（AgentMessage[]）由 renderer 端
 * agent-store.ts 拥有，持久化层不依赖具体结构，仅 JSON.parse / JSON.stringify。
 * 因此这里 messages 类型为 unknown[]，渲染层读取后自行 cast 为 AgentMessage[]。
 */

/** 完整会话记录（含 messages） */
export interface ConversationRecord {
  id: string
  title: string
  /** JSON: AgentMessage[]（形状由 renderer 拥有，此处视为不透明数组） */
  messages: unknown[]
  mode: string
  modelId: string | null
  messageCount: number
  createdAt: number
  updatedAt: number
}

/** 会话元信息（列表懒加载用，不含 messages） */
export interface ConversationMeta {
  id: string
  title: string
  mode: string
  modelId: string | null
  messageCount: number
  createdAt: number
  updatedAt: number
}

export class ConversationRepository {
  /** 列出全部会话元信息（不取 messages，按 updated_at 倒序），供历史面板懒加载 */
  static listMeta(): ConversationMeta[] {
    const db = getProjectDb()
    if (!db) return []
    const rows = db.prepare(`
      SELECT id, title, mode, model_id as modelId,
        message_count as messageCount, created_at as createdAt, updated_at as updatedAt
      FROM agent_conversations
      ORDER BY updated_at DESC
    `).all() as ConversationMeta[]
    return rows
  }

  /** 按 id 取单个完整会话（含 messages，JSON.parse） */
  static get(id: string): ConversationRecord | null {
    const db = getProjectDb()
    if (!db) return null
    const row = db.prepare(`
      SELECT id, title, messages, mode, model_id as modelId,
        message_count as messageCount, created_at as createdAt, updated_at as updatedAt
      FROM agent_conversations WHERE id = ?
    `).get(id) as (Omit<ConversationRecord, 'messages'> & { messages: string }) | undefined
    if (!row) return null
    let messages: unknown[] = []
    try {
      const parsed = JSON.parse(row.messages)
      if (Array.isArray(parsed)) messages = parsed
    } catch {
      // 损坏的 JSON 兜底为空数组，不让单条坏记录拖垮整个加载
      messages = []
    }
    return { ...row, messages }
  }

  /**
   * 插入或更新会话（INSERT ... ON CONFLICT DO UPDATE）。
   * message_count 写入 messages.length；created_at 仅插入时写、更新时保留原值。
   */
  static upsert(conv: ConversationRecord): void {
    const db = getProjectDb()
    if (!db) return
    const messagesJson = JSON.stringify(conv.messages ?? [])
    const messageCount = Array.isArray(conv.messages) ? conv.messages.length : 0
    db.prepare(`
      INSERT INTO agent_conversations
        (id, title, messages, mode, model_id, message_count, created_at, updated_at)
      VALUES (@id, @title, @messages, @mode, @modelId, @messageCount, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        messages = excluded.messages,
        mode = excluded.mode,
        model_id = excluded.model_id,
        message_count = excluded.message_count,
        updated_at = excluded.updated_at
    `).run({
      id: conv.id,
      title: conv.title,
      messages: messagesJson,
      mode: conv.mode,
      modelId: conv.modelId,
      messageCount,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
    })
  }

  /** 删除单个会话 */
  static remove(id: string): void {
    const db = getProjectDb()
    if (!db) return
    db.prepare(`DELETE FROM agent_conversations WHERE id = ?`).run(id)
  }

  /** 清空当前项目库的全部会话 */
  static clear(): void {
    const db = getProjectDb()
    if (!db) return
    db.prepare(`DELETE FROM agent_conversations`).run()
  }
}

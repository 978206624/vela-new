/**
 * BlueprintRepository — 章节蓝图 (blueprints 表)
 *
 * 取代旧的 chapter-repository.ts，管理章节的规划元数据。
 */
import { getProjectDb } from '../database'

/** 蓝图行类型（DB 蛇形命名） */
export interface BlueprintRow {
    chapter_number: number
    title: string
    role: string
    purpose: string
    key_events: string
    characters: string
    suspense_hook: string
    user_guidance: string
    notes: string
    notes_updated_at: string
    target_words: number
    created_at: string
    updated_at: string
}

/** 前端使用的驼峰接口 */
export interface BlueprintData {
    chapterNumber: number
    title: string
    role: string
    purpose: string
    keyEvents: string
    characters: string[]
    suspenseHook: string
    userGuidance: string
    notes: string
    notesUpdatedAt: string
    /** 本章目标字数（Phase 18）。0 = 跟随全局每章字数；>0 = 钉住该章 */
    targetWords: number
}

function rowToData(row: BlueprintRow): BlueprintData {
    let chars: string[] = []
    try { chars = JSON.parse(row.characters) } catch { /* 容错 */ }
    return {
        chapterNumber: row.chapter_number,
        title: row.title,
        role: row.role,
        purpose: row.purpose,
        keyEvents: row.key_events,
        characters: chars,
        suspenseHook: row.suspense_hook,
        userGuidance: row.user_guidance,
        notes: row.notes,
        notesUpdatedAt: row.notes_updated_at,
        targetWords: row.target_words ?? 0,
    }
}

export class BlueprintRepository {
    /** 获取所有蓝图（按章节号排序） */
    static getAll(): BlueprintData[] {
        const db = getProjectDb()
        if (!db) return []

        const rows = db.prepare(
            'SELECT * FROM blueprints ORDER BY chapter_number ASC'
        ).all() as BlueprintRow[]

        return rows.map(rowToData)
    }

    /** 获取单个蓝图 */
    static getByChapter(chapterNumber: number): BlueprintData | null {
        const db = getProjectDb()
        if (!db) return null

        const row = db.prepare(
            'SELECT * FROM blueprints WHERE chapter_number = ?'
        ).get(chapterNumber) as BlueprintRow | undefined

        return row ? rowToData(row) : null
    }

    /** 获取蓝图总数 */
    static count(): number {
        const db = getProjectDb()
        if (!db) return 0

        const row = db.prepare(
            'SELECT COUNT(*) as cnt FROM blueprints'
        ).get() as { cnt: number }

        return row.cnt
    }

    /** 插入或更新蓝图 */
    static upsert(data: BlueprintData): void {
        const db = getProjectDb()
        if (!db) return

        db.prepare(`
      INSERT INTO blueprints (
        chapter_number, title, role, purpose, key_events, characters,
        suspense_hook, user_guidance, notes, notes_updated_at, target_words
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chapter_number) DO UPDATE SET
        title = excluded.title,
        role = excluded.role,
        purpose = excluded.purpose,
        key_events = excluded.key_events,
        characters = excluded.characters,
        suspense_hook = excluded.suspense_hook,
        user_guidance = excluded.user_guidance,
        notes = excluded.notes,
        notes_updated_at = excluded.notes_updated_at,
        target_words = excluded.target_words,
        updated_at = datetime('now')
    `).run(
            data.chapterNumber,
            data.title,
            data.role,
            data.purpose,
            data.keyEvents,
            JSON.stringify(data.characters),
            data.suspenseHook,
            data.userGuidance,
            data.notes,
            data.notesUpdatedAt,
            data.targetWords ?? 0,
        )
    }

    /** 批量插入/更新蓝图（事务） */
    static upsertMany(items: BlueprintData[]): void {
        const db = getProjectDb()
        if (!db) return

        const tx = db.transaction(() => {
            for (const item of items) {
                BlueprintRepository.upsert(item)
            }
        })
        tx()
    }

    /** 删除蓝图 */
    static delete(chapterNumber: number): void {
        const db = getProjectDb()
        if (!db) return

        db.prepare('DELETE FROM blueprints WHERE chapter_number = ?').run(chapterNumber)
    }

    /**
     * 批量删除章号闭区间内的蓝图（Phase 19：孤儿蓝图「清除并随新卷重新生成」策略）。
     *
     * **破坏性操作，事务内强制两道保护**：
     * 1. 参数必须是 ≥1 的整数且 start ≤ end —— 否则 `(1, 999999)` 这类错误调用会删光全部蓝图。
     * 2. 区间内不得存在已定稿章节 —— 定稿章的蓝图承载标题、notes（定稿后处理从正文提炼的
     *    章节要点，是续卷「接着事实续」的唯一数据源）与目标字数，删掉不可恢复。
     *
     * 跨项目 token 守卫只能防「删错项目」，防不了「在对的项目里删错范围」，故必须有本层校验。
     * 孤儿蓝图按定义位于「已定稿最大章号之后」，正常调用不会命中 finalized，不影响预期用途。
     *
     * @returns 实际删除条数，供 UI 如实回报「已清除 N 条」
     */
    static deleteRange(startChapter: number, endChapter: number): number {
        if (!Number.isInteger(startChapter) || startChapter < 1) {
            throw new Error(`起始章号非法：${startChapter}（须为 ≥1 的整数）`)
        }
        if (!Number.isInteger(endChapter) || endChapter < startChapter) {
            throw new Error(`章号区间非法：${startChapter}–${endChapter}（结束章须 ≥ 起始章）`)
        }

        const db = getProjectDb()
        if (!db) throw new Error('项目数据库未打开，无法删除章节蓝图')

        const tx = db.transaction(() => {
            const finalized = db.prepare(`
        SELECT COUNT(*) as cnt FROM drafts
        WHERE status = 'finalized' AND chapter_number BETWEEN ? AND ?
      `).get(startChapter, endChapter) as { cnt: number }

            if (finalized.cnt > 0) {
                throw new Error(
                    `第 ${startChapter}–${endChapter} 章中有 ${finalized.cnt} 章已定稿，不可删除其蓝图` +
                    `（定稿章蓝图的 notes 是续卷推演的数据源）`
                )
            }

            return db.prepare(
                'DELETE FROM blueprints WHERE chapter_number BETWEEN ? AND ?'
            ).run(startChapter, endChapter).changes
        })

        return tx() as number
    }

    /** 仅更新 notes 字段 */
    static updateNotes(chapterNumber: number, notes: string): void {
        const db = getProjectDb()
        if (!db) return

        db.prepare(`
      UPDATE blueprints
      SET notes = ?, notes_updated_at = datetime('now'), updated_at = datetime('now')
      WHERE chapter_number = ?
    `).run(notes, chapterNumber)
    }

    /** 仅更新 target_words 字段（Phase 18：章节目标字数，0=跟随全局每章字数）。
     *  返回是否命中行（false = 该章无蓝图、未写入），供 IPC 层如实上报，避免"假成功"。 */
    static updateTargetWords(chapterNumber: number, targetWords: number): boolean {
        const db = getProjectDb()
        if (!db) return false

        const info = db.prepare(`
      UPDATE blueprints
      SET target_words = ?, updated_at = datetime('now')
      WHERE chapter_number = ?
    `).run(targetWords, chapterNumber)
        return info.changes > 0
    }
}

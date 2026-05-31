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

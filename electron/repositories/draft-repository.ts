/**
 * DraftRepository — 草稿 (drafts 表 + contents 联动)
 *
 * 草稿是创作栈的主线。status='finalized' 代表定稿。
 * 正文统一存储在 contents 表中，drafts 只持有 content_id 外键。
 */
import { getProjectDb } from '../database'
import { ContentRepository } from './content-repository'

/** 草稿元数据（不含正文，适合列表查询） */
export interface DraftMeta {
    id: number
    chapterNumber: number
    version: number
    status: string
    source: string
    contentId: number
    wordCount: number
    createdAt: string
    updatedAt: string
}

/** 草稿完整数据（含正文） */
export interface DraftFull extends DraftMeta {
    content: string
}

/** DB 行 → DraftMeta */
function rowToMeta(row: Record<string, unknown>): DraftMeta {
    return {
        id: row.id as number,
        chapterNumber: row.chapter_number as number,
        version: row.version as number,
        status: row.status as string,
        source: row.source as string,
        contentId: row.content_id as number,
        wordCount: row.word_count as number,
        createdAt: row.created_at as string,
        updatedAt: row.updated_at as string,
    }
}

export class DraftRepository {
    /**
     * 创建草稿（先写 contents 再建 draft 记录）
     * 返回新建的 draft ID
     */
    static create(params: {
        chapterNumber: number
        version: number
        source: 'write' | 'rewrite'
        content: string
        wordCount: number
    }): number {
        const db = getProjectDb()
        if (!db) throw new Error('[DraftRepository] 数据库未连接')

        // 事务：先入内容池，再建元数据
        const tx = db.transaction(() => {
            const contentId = ContentRepository.create(params.content)
            const result = db.prepare(`
        INSERT INTO drafts (chapter_number, version, source, content_id, word_count)
        VALUES (?, ?, ?, ?, ?)
      `).run(
                params.chapterNumber,
                params.version,
                params.source,
                contentId,
                params.wordCount,
            )
            return Number(result.lastInsertRowid)
        })

        return tx()
    }

    /** 列出章节的所有草稿（不含正文，按版本升序） */
    static listByChapter(chapterNumber: number): DraftMeta[] {
        const db = getProjectDb()
        if (!db) return []

        const rows = db.prepare(`
      SELECT * FROM drafts WHERE chapter_number = ? ORDER BY version ASC
    `).all(chapterNumber) as Record<string, unknown>[]

        return rows.map(rowToMeta)
    }

    /** 获取草稿元数据 */
    static getMeta(id: number): DraftMeta | null {
        const db = getProjectDb()
        if (!db) return null

        const row = db.prepare(
            'SELECT * FROM drafts WHERE id = ?'
        ).get(id) as Record<string, unknown> | undefined

        return row ? rowToMeta(row) : null
    }

    /** 获取草稿完整数据（含正文） */
    static getFull(id: number): DraftFull | null {
        const meta = DraftRepository.getMeta(id)
        if (!meta) return null

        const body = ContentRepository.getBody(meta.contentId)
        return { ...meta, content: body ?? '' }
    }

    /** 获取章节最新版本的草稿 */
    static getLatestByChapter(chapterNumber: number): DraftMeta | null {
        const db = getProjectDb()
        if (!db) return null

        const row = db.prepare(`
      SELECT * FROM drafts
      WHERE chapter_number = ?
      ORDER BY version DESC LIMIT 1
    `).get(chapterNumber) as Record<string, unknown> | undefined

        return row ? rowToMeta(row) : null
    }

    /** 获取章节已定稿的草稿 */
    static getFinalizedByChapter(chapterNumber: number): DraftMeta | null {
        const db = getProjectDb()
        if (!db) return null

        const row = db.prepare(`
      SELECT * FROM drafts
      WHERE chapter_number = ? AND status = 'finalized'
      ORDER BY version DESC LIMIT 1
    `).get(chapterNumber) as Record<string, unknown> | undefined

        return row ? rowToMeta(row) : null
    }

    /**
     * 找出正文包含指定名字的章节号（用于「AI 补全人设」定位角色出场章节）。
     * 用 `instr(body, name) > 0` 精确子串匹配（不用 LIKE——名字可能含 `%`/`_` 通配符）。
     * - finalizedOnly=true：只查定稿正文（默认）。
     * - finalizedOnly=false：只查每章 latest draft 的正文（导入旧作未定稿时兜底，排除旧版/archived 误纳）。
     * name 为空直接返回 []（避免 instr(body,'') 命中所有正文）。
     */
    static findChaptersByName(name: string, finalizedOnly = true): number[] {
        const db = getProjectDb()
        if (!db) return []
        const trimmed = name.trim()
        if (!trimmed) return []

        const sql = finalizedOnly
            ? `SELECT DISTINCT d.chapter_number AS ch
               FROM drafts d JOIN contents c ON d.content_id = c.id
               WHERE d.status = 'finalized' AND instr(c.body, @name) > 0
               ORDER BY ch ASC`
            : `SELECT d.chapter_number AS ch
               FROM drafts d JOIN contents c ON d.content_id = c.id
               WHERE d.version = (
                 SELECT MAX(d2.version) FROM drafts d2 WHERE d2.chapter_number = d.chapter_number
               ) AND instr(c.body, @name) > 0
               ORDER BY ch ASC`

        const rows = db.prepare(sql).all({ name: trimmed }) as Array<{ ch: number }>
        return rows.map(r => r.ch)
    }

    /** 获取下一个可用版本号 */
    static getNextVersion(chapterNumber: number): number {
        const db = getProjectDb()
        if (!db) return 1

        const row = db.prepare(`
      SELECT MAX(version) as maxVer FROM drafts WHERE chapter_number = ?
    `).get(chapterNumber) as { maxVer: number | null }

        return (row.maxVer ?? 0) + 1
    }

    /** 获取最大的已定稿章节号，如果没有则返回 0 */
    static getMaxFinalizedChapter(): number {
        const db = getProjectDb()
        if (!db) return 0
        const row = db.prepare(`
            SELECT MAX(chapter_number) as maxChapter
            FROM drafts
            WHERE status = 'finalized'
        `).get() as { maxChapter: number | null }
        return row?.maxChapter ?? 0
    }

    /** 更新草稿状态 */
    static updateStatus(id: number, status: string, wordCount?: number): void {
        const db = getProjectDb()
        if (!db) return

        if (wordCount !== undefined) {
            db.prepare(`
        UPDATE drafts SET status = ?, word_count = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(status, wordCount, id)
        } else {
            db.prepare(`
        UPDATE drafts SET status = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(status, id)
        }
    }

    /**
     * 定稿互斥：将目标草稿设为 finalized，并把同章其它所有非 archived 草稿降级为 archived。
     * 章节号在事务内按主键 id 反查，不信任外部传入，杜绝误传章号导致错章被整章归档。
     * 单事务执行，保证每章至多一个 finalized，避免中途崩溃留下半截状态。
     */
    static finalizeExclusive(id: number, wordCount?: number): void {
        const db = getProjectDb()
        if (!db) return

        const tx = db.transaction(() => {
            // 0. 按主键反查目标稿所属章节（权威来源），避免归档作用域被外部误传的章号污染
            const target = db.prepare(
                'SELECT chapter_number FROM drafts WHERE id = ?'
            ).get(id) as { chapter_number: number } | undefined
            if (!target) return

            // 1. 目标稿 → finalized（带可选字数同步定稿期微调）
            if (wordCount !== undefined) {
                db.prepare(`
        UPDATE drafts SET status = 'finalized', word_count = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(wordCount, id)
            } else {
                db.prepare(`
        UPDATE drafts SET status = 'finalized', updated_at = datetime('now')
        WHERE id = ?
      `).run(id)
            }

            // 2. 同章其它未归档稿（draft/revised/reviewed/旧 finalized）→ archived
            db.prepare(`
        UPDATE drafts SET status = 'archived', updated_at = datetime('now')
        WHERE chapter_number = ? AND id <> ? AND status <> 'archived'
      `).run(target.chapter_number, id)
        })

        tx()
    }

    /** 更新草稿正文（同时更新 contents 表） */
    static updateContent(id: number, content: string, wordCount: number): void {
        const meta = DraftRepository.getMeta(id)
        if (!meta) return

        ContentRepository.updateBody(meta.contentId, content)

        const db = getProjectDb()
        if (!db) return

        db.prepare(`
      UPDATE drafts SET word_count = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(wordCount, id)
    }

    /**
     * 删除草稿（级联删除 revisions/reviews，并清理由此产生的孤儿 contents）。
     *
     * revisions/reviews 对 base_draft_id 是 ON DELETE CASCADE（删草稿自动删子行），
     * 但它们的 content_id 是 ON DELETE RESTRICT，子行被级联删除后其 content 不会自动消失。
     * 故必须在删除前收集整棵树（草稿自身 + 全部 revisions/reviews）持有的 content_id，
     * 删除后再回收已不被任何表引用的内容，避免孤儿正文/报告在 contents 表中堆积。
     */
    static delete(id: number): void {
        const db = getProjectDb()
        if (!db) return

        const meta = DraftRepository.getMeta(id)
        if (!meta) return

        const tx = db.transaction(() => {
            // 1. 删除前收集本草稿树持有的全部 content_id（CASCADE 删行后就查不到了）
            const contentIds = new Set<number>([meta.contentId])
            const revRows = db.prepare('SELECT content_id FROM revisions WHERE base_draft_id = ?').all(id) as { content_id: number }[]
            const reviewRows = db.prepare('SELECT content_id FROM reviews WHERE base_draft_id = ?').all(id) as { content_id: number }[]
            for (const r of revRows) contentIds.add(r.content_id)
            for (const r of reviewRows) contentIds.add(r.content_id)

            // 2. 删除草稿（revisions/reviews 行经 ON DELETE CASCADE 自动删除）
            db.prepare('DELETE FROM drafts WHERE id = ?').run(id)

            // 3. 回收孤儿内容：仅删除已不被 drafts/revisions/reviews 任何一行引用的 content。
            //    先查引用再删，既避开 RESTRICT 抛错，也防御性兼容 content 被多行复用的情况。
            for (const cid of contentIds) {
                const used =
                    db.prepare('SELECT 1 FROM drafts WHERE content_id = ? LIMIT 1').get(cid) ||
                    db.prepare('SELECT 1 FROM revisions WHERE content_id = ? LIMIT 1').get(cid) ||
                    db.prepare('SELECT 1 FROM reviews WHERE content_id = ? LIMIT 1').get(cid)
                if (!used) {
                    db.prepare('DELETE FROM contents WHERE id = ?').run(cid)
                }
            }
        })

        tx()
    }
}

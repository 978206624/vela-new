/**
 * VolumeRepository — 分卷 (volumes 表，Phase 19)
 *
 * 把情节大纲从「一次性闭环文本」下沉为「可无限追加的卷序列」。
 *
 * 关键约定：**空表 = 单卷模式**。老项目首次打开只是自动建出空表，
 * 不做任何数据迁移。但「空表」这个事实只有在**成功读到**时才成立——
 * 区分「真空表」与「没读到」是渲染层 `volume-service` 的 VolumeSnapshot 职责，
 * 本仓储只负责如实存取与**强制业务不变量**。
 *
 * ## 为什么不变量必须在这一层
 *
 * 「仅最后一卷可改边界」「已开写的卷不可删」若只做成渲染层 helper，
 * 任何 Agent 工具、后续工作流、漏调 helper 的 UI 都能绕过写出重叠卷或
 * 删掉有正文的卷。渲染层 helper 只用于提前禁用按钮，**最终授权在这里**。
 *
 * open_threads 列为 JSON blob（`OpenThread[]`），编解码与校验拆在 `./volume-threads`：
 * 读写共用该模块，但**语义刻意不同**——读侧宽容（截断超长、归一认不得的 urgency、
 * 丢弃救不回的条目，防一条脏记录拖垮打开项目），写侧严格（一律抛错拒绝，
 * 静默改数据比拒绝更糟）。防止脏数据在 Task 19.3 被拼进 prompt 时放大成
 * 错误章号与上下文体积失控。
 */
import { getProjectDb } from '../database'
import {
    parseOpenThreads,
    serializeOpenThreads,
    type OpenThread,
} from './volume-threads'
import { MAX_VOLUME_CHAPTERS } from '../../src/shared/volume-limits'

/** 卷状态：planned=未开始 / writing=写作中 / done=已完成 */
export type VolumeStatus = 'planned' | 'writing' | 'done'

// 伏笔类型 re-export：`ipc-channels.ts` 等按 volume-repository 引用它们，
// 拆分 volume-threads 后保持既有 import 路径不变
export type { ThreadUrgency, OpenThread } from './volume-threads'

/** 卷行类型（DB 蛇形命名） */
export interface VolumeRow {
    volume_number: number
    title: string
    start_chapter: number
    end_chapter: number
    premise: string
    synopsis: string
    opening_state: string
    closing_state: string
    /** JSON: OpenThread[] */
    open_threads: string
    status: string
    created_at: string
    updated_at: string
}

/** 前端使用的驼峰接口 */
export interface VolumeData {
    volumeNumber: number
    title: string
    /** 起始章号（含） */
    startChapter: number
    /** 结束章号（含） */
    endChapter: number
    /** 本卷主线目标 + 核心冲突 */
    premise: string
    /** 本卷大纲（按结构模式在卷内展开） */
    synopsis: string
    /** 开卷状态（= 上一卷 closingState） */
    openingState: string
    /** 收卷状态（AI 从本卷实际写作结果提炼） */
    closingState: string
    /** 未回收伏笔清单 */
    openThreads: OpenThread[]
    status: VolumeStatus
}

const VALID_STATUS: readonly string[] = ['planned', 'writing', 'done']

/** 库未打开时统一抛错，避免写方法静默 return void 被上层当成功 */
function requireDb() {
    const db = getProjectDb()
    if (!db) throw new Error('项目数据库未打开，无法执行分卷操作')
    return db
}

/** 读侧把库里的 status 收敛到合法枚举（防脏数据冒出幻影状态）；写侧不用它，写侧直接拒绝非法值 */
function coerceStatusForRead(raw: unknown): VolumeStatus {
    return typeof raw === 'string' && VALID_STATUS.includes(raw) ? (raw as VolumeStatus) : 'planned'
}

/** 写侧 status 校验：非法直接抛错，不静默重置为 planned */
function assertValidStatus(status: unknown, volumeNumber: number): VolumeStatus {
    if (typeof status !== 'string' || !VALID_STATUS.includes(status)) {
        throw new Error(`第 ${volumeNumber} 卷状态非法：${String(status)}（须为 planned / writing / done）`)
    }
    return status as VolumeStatus
}

/**
 * 卷序号与章号区间的基础校验（不依赖 db，故放在取库之前）。
 *
 * 这是**最后一道**：渲染层的输入解析、续卷工作流的入口校验都只护住各自那条链，
 * 而 `db:volume-upsert` 是公开通道，Agent 或将来的调用方可以直接打进来。
 *
 * ⚠️ 两处刻意的收紧（Task 19.4 会审）：
 * ① `isSafeInteger` 而非 `isInteger`——`Number.isInteger(1e21)` 为真，
 *    但 `1e21 + 1 === 1e21`，这种章号一旦落库，所有做章号加减的地方都会静默出错。
 * ② **区间长度**也要卡。「两端都是安全整数」不代表「区间可遍历」：
 *    `start=11, end=MAX_SAFE_INTEGER` 两端都合法，而任何按区间逐章处理的代码
 *    都会跑 9 千万亿次、把应用冻死。主要防线是让那些地方改成按实际记录遍历，
 *    但那要求每一处都记得这么写；这道上限是不依赖记性的兜底。
 */
function assertValidRange(data: VolumeData): void {
    if (!Number.isSafeInteger(data.volumeNumber) || data.volumeNumber < 1) {
        throw new Error(`卷序号非法：${data.volumeNumber}（须为 ≥1 的安全整数）`)
    }
    if (!Number.isSafeInteger(data.startChapter) || data.startChapter < 1) {
        throw new Error(`第 ${data.volumeNumber} 卷起始章号非法：${data.startChapter}（须为 ≥1 的安全整数）`)
    }
    if (!Number.isSafeInteger(data.endChapter) || data.endChapter < data.startChapter) {
        throw new Error(
            `第 ${data.volumeNumber} 卷章号区间非法：${data.startChapter}–${data.endChapter}（结束章须 ≥ 起始章，且为安全整数）`
        )
    }
    const span = data.endChapter - data.startChapter + 1
    if (span > MAX_VOLUME_CHAPTERS) {
        throw new Error(
            `第 ${data.volumeNumber} 卷章数 ${span} 超过上限 ${MAX_VOLUME_CHAPTERS}` +
            `（第 ${data.startChapter}–${data.endChapter} 章）。` +
            `这个量级的区间会让按章遍历的逻辑卡死，通常是误输入`
        )
    }
}

function rowToData(row: VolumeRow): VolumeData {
    return {
        volumeNumber: row.volume_number,
        title: row.title,
        startChapter: row.start_chapter,
        endChapter: row.end_chapter,
        premise: row.premise,
        synopsis: row.synopsis,
        openingState: row.opening_state,
        closingState: row.closing_state,
        openThreads: parseOpenThreads(row.open_threads),
        status: coerceStatusForRead(row.status),
    }
}

export class VolumeRepository {
    /** 获取全部卷（按卷序号升序）。空表即单卷模式，返回 [] */
    static getAll(): VolumeData[] {
        const db = getProjectDb()
        if (!db) return []
        const rows = db.prepare('SELECT * FROM volumes ORDER BY volume_number ASC').all() as VolumeRow[]
        return rows.map(rowToData)
    }

    /** 获取单卷 */
    static get(volumeNumber: number): VolumeData | null {
        const db = getProjectDb()
        if (!db) return null
        const row = db.prepare('SELECT * FROM volumes WHERE volume_number = ?')
            .get(volumeNumber) as VolumeRow | undefined
        return row ? rowToData(row) : null
    }

    /** 按章号取所属卷（章号落在 [start_chapter, end_chapter] 闭区间内） */
    static getByChapter(chapterNumber: number): VolumeData | null {
        const db = getProjectDb()
        if (!db) return null
        const row = db.prepare(`
      SELECT * FROM volumes
      WHERE start_chapter <= ? AND end_chapter >= ?
      ORDER BY volume_number ASC
      LIMIT 1
    `).get(chapterNumber, chapterNumber) as VolumeRow | undefined
        return row ? rowToData(row) : null
    }

    /**
     * 插入或更新卷 —— 在事务内强制全部业务不变量。
     *
     * 校验顺序：基础区间 → 区间不与其它卷重叠 → 改动既有卷边界时须为最后一卷。
     * 任何一条不满足即抛错，由 IPC handler 转成 `{success:false,error}`。
     */
    static upsert(data: VolumeData): void {
        assertValidRange(data)
        const status = assertValidStatus(data.status, data.volumeNumber)
        const threadsJson = serializeOpenThreads(data.openThreads, data.volumeNumber)

        const db = requireDb()

        const tx = db.transaction(() => {
            // 区间重叠校验：与除自身外的任何卷都不得有交集
            const overlap = db.prepare(`
        SELECT volume_number, start_chapter, end_chapter FROM volumes
        WHERE volume_number != ? AND start_chapter <= ? AND end_chapter >= ?
        LIMIT 1
      `).get(data.volumeNumber, data.endChapter, data.startChapter) as
                { volume_number: number; start_chapter: number; end_chapter: number } | undefined
            if (overlap) {
                throw new Error(
                    `第 ${data.volumeNumber} 卷区间 ${data.startChapter}–${data.endChapter} 与第 ${overlap.volume_number} 卷` +
                    `（${overlap.start_chapter}–${overlap.end_chapter}）重叠`
                )
            }

            // 改动既有卷的章号边界时，只允许最后一卷：
            // 改中间卷的边界会让夹在其中的章节失去归属（对齐「仅允许修改最新定稿章节」的线性约束）
            const existing = db.prepare(
                'SELECT start_chapter, end_chapter FROM volumes WHERE volume_number = ?'
            ).get(data.volumeNumber) as { start_chapter: number; end_chapter: number } | undefined

            if (existing && (existing.start_chapter !== data.startChapter || existing.end_chapter !== data.endChapter)) {
                const maxRow = db.prepare('SELECT MAX(volume_number) as maxNum FROM volumes')
                    .get() as { maxNum: number | null }
                if ((maxRow?.maxNum ?? 0) !== data.volumeNumber) {
                    throw new Error(
                        `只有最后一卷可以修改章号边界；第 ${data.volumeNumber} 卷不是最后一卷（当前最后一卷为第 ${maxRow?.maxNum} 卷）`
                    )
                }
            }

            db.prepare(`
        INSERT INTO volumes (
          volume_number, title, start_chapter, end_chapter,
          premise, synopsis, opening_state, closing_state, open_threads, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(volume_number) DO UPDATE SET
          title = excluded.title,
          start_chapter = excluded.start_chapter,
          end_chapter = excluded.end_chapter,
          premise = excluded.premise,
          synopsis = excluded.synopsis,
          opening_state = excluded.opening_state,
          closing_state = excluded.closing_state,
          open_threads = excluded.open_threads,
          status = excluded.status,
          updated_at = datetime('now')
      `).run(
                data.volumeNumber,
                data.title,
                data.startChapter,
                data.endChapter,
                data.premise,
                data.synopsis,
                data.openingState,
                data.closingState,
                threadsJson,
                status,
            )
        })
        tx()
    }

    /**
     * **原子**卷状态流转（供定稿后处理调用）。
     *
     * 为什么不能在渲染层「先 getByChapter 再 updateStatus」两步做：
     * 后处理流水线含多次 LLM 调用，两步之间隔着可观的时间窗口。
     * 用户在这期间把末卷从「止于第 10 章」延长到第 20 章，
     * 旧判断仍会把它写成 `done`——一个刚被延长的卷立刻显示"已完成"。
     * 故把「按章号定位卷 → 判定目标状态 → 条件更新」收进同一个事务，
     * 判定所依据的边界与写入是同一份快照。
     *
     * 返回 `null` 表示无需变更（零卷 / 本章无卷归属 / 已是目标状态）。
     */
    static advanceStatusByChapter(chapterNumber: number): { volumeNumber: number; title: string; status: VolumeStatus } | null {
        const db = requireDb()
        const tx = db.transaction(() => {
            const row = db.prepare(`
        SELECT * FROM volumes
        WHERE start_chapter <= ? AND end_chapter >= ?
        ORDER BY volume_number ASC LIMIT 1
      `).get(chapterNumber, chapterNumber) as VolumeRow | undefined
            if (!row) return null

            const vol = rowToData(row)
            // 先判末章：单章卷（start === end）两个条件同时成立，应落在 done。
            // 只认首章触发 writing——Spec §4.11 允许用户手动置回 planned 表示
            // 「本卷暂时搁置」，任意中间章都触发会推翻用户的显式意图。
            const next: VolumeStatus | null =
                chapterNumber === vol.endChapter ? 'done'
                    : (chapterNumber === vol.startChapter && vol.status === 'planned') ? 'writing'
                        : null
            if (!next || next === vol.status) return null

            db.prepare(`UPDATE volumes SET status = ?, updated_at = datetime('now') WHERE volume_number = ?`)
                .run(next, vol.volumeNumber)
            return { volumeNumber: vol.volumeNumber, title: vol.title, status: next }
        })
        return tx() as { volumeNumber: number; title: string; status: VolumeStatus } | null
    }

    /** 仅更新 status（供定稿后处理的卷状态自动流转）。返回是否命中行 */
    static updateStatus(volumeNumber: number, status: VolumeStatus): boolean {
        const validated = assertValidStatus(status, volumeNumber)
        const db = requireDb()
        const info = db.prepare(`
      UPDATE volumes SET status = ?, updated_at = datetime('now') WHERE volume_number = ?
    `).run(validated, volumeNumber)
        return info.changes > 0
    }

    /** 仅更新 open_threads（供续卷提炼与用户手工补录）。非法条目抛错，不静默丢弃 */
    static updateOpenThreads(volumeNumber: number, threads: OpenThread[]): boolean {
        const json = serializeOpenThreads(threads, volumeNumber)
        const db = requireDb()
        const info = db.prepare(`
      UPDATE volumes SET open_threads = ?, updated_at = datetime('now') WHERE volume_number = ?
    `).run(json, volumeNumber)
        return info.changes > 0
    }

    /**
     * 删除卷 —— 在事务内直接查 `drafts` 表强制「已开写不可删」。
     *
     * 不接受调用方传入的定稿章号清单：渲染层的 draft-store 只覆盖已有蓝图的章节，
     * 不是库中全部 finalized 草稿的权威来源，拿它当授权依据会漏判。
     */
    static remove(volumeNumber: number): boolean {
        const db = requireDb()
        const tx = db.transaction(() => {
            const vol = db.prepare(
                'SELECT start_chapter, end_chapter FROM volumes WHERE volume_number = ?'
            ).get(volumeNumber) as { start_chapter: number; end_chapter: number } | undefined
            if (!vol) return false

            const finalized = db.prepare(`
        SELECT COUNT(*) as cnt FROM drafts
        WHERE status = 'finalized' AND chapter_number BETWEEN ? AND ?
      `).get(vol.start_chapter, vol.end_chapter) as { cnt: number }

            if (finalized.cnt > 0) {
                throw new Error(
                    `第 ${volumeNumber} 卷已开写（第 ${vol.start_chapter}–${vol.end_chapter} 章中有 ${finalized.cnt} 章已定稿），不可删除`
                )
            }

            const info = db.prepare('DELETE FROM volumes WHERE volume_number = ?').run(volumeNumber)
            return info.changes > 0
        })
        return tx() as boolean
    }
}

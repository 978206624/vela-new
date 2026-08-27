/**
 * volume-threads — 未回收伏笔（open_threads）的编解码与校验（Phase 19）
 *
 * `volumes.open_threads` 是 JSON blob。这里集中它的类型、限额与读写校验，
 * 从 `volume-repository` 拆出：伏笔编解码是独立关注点，且规则较多
 * （读宽容 / 写严格两套语义），混在仓储里会让单文件超过 300 行上限。
 *
 * ## 为什么读写不能共用一个校验函数
 *
 * - **读侧必须宽容**：库里可能有历史脏数据，一条坏记录不该让整个项目打不开。
 *   故截断超长、认不得的 urgency 归 `mid`、丢弃救不回的条目。
 * - **写侧必须严格**：写入是用户或 AI 的明确动作。静默把 501 字截成 500 字、
 *   把 `urgency:'urgent'` 改成 `'mid'`，用户看到「保存成功」却丢了数据，
 *   比直接拒绝糟得多。故一律抛错。
 */

/** 未回收伏笔优先级 */
export type ThreadUrgency = 'high' | 'mid' | 'low'

/** 一条未回收伏笔 */
export interface OpenThread {
    /** 埋设章号，须为 ≥1 的整数 */
    chapter: number
    /** 伏笔内容 */
    thread: string
    /** 优先级：high 会进入正文写作的「本卷罗盘」 */
    urgency: ThreadUrgency
}

// 取自 shared，与渲染层预检**同一份**清单。各写一份迟早分叉，
// 而分叉的那份会让 UI 放行主进程要拒绝的值
const VALID_URGENCY: readonly string[] = THREAD_URGENCIES

// 限额常量已移到 src/shared/volume-limits.ts 供渲染层共用后再 re-export。
// 渲染层若直接**值导入**本文件，会把用到 Node `Buffer` 的代码打进渲染进程 bundle
// （主窗口 nodeIntegration: false，调用即 ReferenceError，且 tsc/eslint 都不报）。
// `electron/ → src/shared/` 是本项目的正向依赖，多个 controller 已如此引用 ipc-channels。
import { MAX_OPEN_THREADS, MAX_THREAD_LEN, MAX_OPEN_THREADS_BYTES, THREAD_URGENCIES, utf8Bytes } from '../../src/shared/volume-limits'
export { MAX_OPEN_THREADS, MAX_THREAD_LEN, MAX_OPEN_THREADS_BYTES }

/**
 * **读侧**单条规范化（宽容）：尽量抢救能用的数据，救不了就返回 null 由调用方丢弃。
 *
 * 自修复语义：被丢弃的脏条目会在下一次完整 `upsert` 时永久清除（写回的是过滤后的清单）。
 * volumes 是 Phase 19 新表，不存在需要保留的合法历史数据，故这是期望行为。
 * 注意 `updateOpenThreads` / `updateStatus` 不重写整行，仅改状态不会触发清理。
 */
export function normalizeThreadForRead(item: unknown): OpenThread | null {
    if (!item || typeof item !== 'object') return null
    const obj = item as Record<string, unknown>

    // chapter 必须是 ≥1 的整数：Number.isFinite 会放行负数/0/浮点，
    // 这些值流到 prompt 里会变成「第 -1 章埋的伏笔」这种错误引用
    const chapter = typeof obj.chapter === 'number' ? obj.chapter : Number(obj.chapter)
    if (!Number.isInteger(chapter) || chapter < 1) return null

    if (typeof obj.thread !== 'string') return null
    const thread = obj.thread.trim()
    if (!thread) return null

    const urgency = typeof obj.urgency === 'string' && VALID_URGENCY.includes(obj.urgency)
        ? (obj.urgency as ThreadUrgency)
        : 'mid'

    return { chapter, thread: thread.slice(0, MAX_THREAD_LEN), urgency }
}

/** **写侧**单条严格校验：任何不满足即抛错，**不静默截断、不静默改写** */
export function assertThreadForWrite(item: unknown, volumeNumber: number, index: number): OpenThread {
    const where = `第 ${volumeNumber} 卷第 ${index + 1} 条未回收伏笔`
    if (!item || typeof item !== 'object') throw new Error(`${where}格式非法：应为对象`)
    const obj = item as Record<string, unknown>

    // ⚠️ `isSafeInteger` 而非 `isInteger`：`Number.isInteger(1e21)` 为真，
    // 而这种章号一旦落库，所有做章号加减的地方都会静默出错。
    // 渲染层的 `validateOpenThreads` 已按此判据预检，主进程这道是最后一关——
    // `db:volume-upsert` / `db:volume-update-threads` 都是公开通道，
    // 渲染层护不住它们
    if (typeof obj.chapter !== 'number' || !Number.isSafeInteger(obj.chapter) || obj.chapter < 1) {
        throw new Error(`${where}章号非法：${String(obj.chapter)}（须为 ≥1 的安全整数）`)
    }
    if (typeof obj.thread !== 'string' || !obj.thread.trim()) {
        throw new Error(`${where}内容为空`)
    }
    const thread = obj.thread.trim()
    if (thread.length > MAX_THREAD_LEN) {
        throw new Error(`${where}超过 ${MAX_THREAD_LEN} 字上限（当前 ${thread.length} 字）`)
    }
    if (typeof obj.urgency !== 'string' || !VALID_URGENCY.includes(obj.urgency)) {
        throw new Error(`${where}优先级非法：${String(obj.urgency)}（须为 high / mid / low）`)
    }

    return { chapter: obj.chapter, thread, urgency: obj.urgency as ThreadUrgency }
}

/**
 * 读侧解析 open_threads JSON。
 * 超限**字节数**直接判定为脏数据返回 `[]`（不 parse，避免大 blob 卡住打开项目）；
 * 逐条走宽容规范化，非法条目丢弃而非整体报废。
 */
export function parseOpenThreads(raw: string): OpenThread[] {
    if (!raw) return []
    // 必须按 UTF-8 字节算：raw.length 是 UTF-16 code unit，中文下同样的
    // 256K「长度」实际可达 ~768KB，上限形同虚设。
    // 用共享的 utf8Bytes 而非 Buffer.byteLength：渲染层的预检（volume-closing.command）
    // 用同一函数度量，两侧判定必须逐字节一致，否则会出现「预检放行、写入被拒」
    if (utf8Bytes(raw) > MAX_OPEN_THREADS_BYTES) {
        console.warn(`[volume-threads] open_threads 超过 ${MAX_OPEN_THREADS_BYTES} 字节，按空清单处理`)
        return []
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        return []
    }
    if (!Array.isArray(parsed)) return []

    const result: OpenThread[] = []
    for (const item of parsed) {
        const t = normalizeThreadForRead(item)
        if (t) result.push(t)
        if (result.length >= MAX_OPEN_THREADS) break
    }
    return result
}

/** 写侧序列化：逐条严格校验，非法即抛错；序列化后按 UTF-8 字节复核上限 */
export function serializeOpenThreads(threads: OpenThread[] | undefined, volumeNumber: number): string {
    const list = threads ?? []
    if (!Array.isArray(list)) throw new Error(`第 ${volumeNumber} 卷未回收伏笔格式非法：应为数组`)
    if (list.length > MAX_OPEN_THREADS) {
        throw new Error(`第 ${volumeNumber} 卷未回收伏笔超过 ${MAX_OPEN_THREADS} 条上限（当前 ${list.length} 条）`)
    }
    const json = JSON.stringify(list.map((item, i) => assertThreadForWrite(item, volumeNumber, i)))
    const bytes = utf8Bytes(json)
    if (bytes > MAX_OPEN_THREADS_BYTES) {
        throw new Error(
            `第 ${volumeNumber} 卷未回收伏笔序列化后 ${bytes} 字节，超过 ${MAX_OPEN_THREADS_BYTES} 字节上限`
        )
    }
    return json
}

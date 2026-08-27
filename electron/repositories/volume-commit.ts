/**
 * volume-commit — 续卷的**单次事务性提交**（Phase 19 / Task 19.2b）
 *
 * ## 为什么必须是一个事务
 *
 * 续卷落库要同时改五处：上一卷收束、新卷、`project_core.total_chapters`、
 * `project_core.synopsis`、可选的孤儿蓝图删除。原计划在渲染层串联四个独立 IPC，
 * 会审否决——四连写非原子，中途失败会留下「卷已建但总章数未改」「大纲追加了但卷没建」
 * 这类半提交状态，且用户无回滚入口。
 *
 * 另一层原因：`updateProjectCore` 走的 `db:project-core-update` **没有 token 守卫**，
 * 而续卷跨越两次 LLM 调用（分钟级），用户中途切项目就会把这一步写进另一个库。
 * 复合 IPC 只在入口校验一次 token，事务内不再有跨项目窗口。
 *
 * ## 与仓储层的关系
 *
 * 本模块**不绕过仓储直接拼 SQL 改 volumes / blueprints**——`VolumeRepository.upsert`
 * 与 `BlueprintRepository.deleteRange` 各自在事务内强制业务不变量（区间不重叠、
 * 仅最后一卷可改边界、区间内不得有定稿章节）。better-sqlite3 的嵌套事务走 SAVEPOINT，
 * 在外层事务里调用它们是安全的，且保留了那些保护。
 * 只有 `project_core` 的两个标量列是本模块直接 UPDATE 的。
 */
import { createHash } from 'node:crypto'
import { getProjectDb } from '../database'
import { VolumeRepository, type VolumeData } from './volume-repository'
import type { OpenThread } from './volume-threads'
import { BlueprintRepository } from './blueprint-repository'

/** 孤儿蓝图处置策略。定义在主进程侧，渲染层 type-only 引用（跨边界只允许 import type） */
export type OrphanPolicy = 'clear' | 'keep' | 'extend'

/** 孤儿蓝图快照：用户在对话框里看到并确认的区间与条数 */
export interface OrphanSnapshot {
    startChapter: number
    endChapter: number
    count: number
    /** 区间内蓝图的内容指纹。只比条数挡不住「内容被改但数量不变」的情况 */
    fingerprint: string
}

/**
 * 孤儿蓝图的**复核凭据**（嵌在 FirstVolumeGuard 的 orphan 分支里）。
 * 三种策略都必须携带，不是只有 clear。
 *
 * 早期版本只在 `clear` 时传，于是另外两种策略完全跳过提交期复核：
 * - `extend`：首卷边界按探查时的蓝图末章定死，生成期间新增的蓝图落在首卷之外，
 *   新卷也够不着，最终成为不属于任何卷的幽灵章。
 * - `keep`：新卷大纲是照着探查时的蓝图内容推演的，用户中途改了某章 keyEvents，
 *   提交照常成功，落库的大纲与蓝图对不上。
 * 删除动作仍然只有 `clear` 会做——**复核与删除是两件事**。
 */
export interface OrphanGuard {
    policy: OrphanPolicy
    snapshot: OrphanSnapshot
}

/**
 * 惰性建卷的**提交凭据**——判别联合，孤儿分支与无孤儿分支**互斥且穷尽**。
 *
 * 为什么不能是「maxBlueprint > maxFinalized 时 orphan 才存在」的普通可选字段：
 * 那样「实际有孤儿却省略 orphan」的载荷照样通过类型检查，事务里就跳过了策略、
 * 指纹与覆盖范围三道复核。凭据必须**自证一致**：`kind: 'orphan'` 分支携带快照，
 * `kind: 'none'` 分支声明探查时确实无孤儿——事务内拿库里的边界事实逐一核对，
 * 声明对不上即拒绝。
 */
export type FirstVolumeGuard =
    | {
        /** 探查时无孤儿蓝图（maxBlueprint <= maxFinalized） */
        kind: 'none'
        maxFinalized: number
        maxBlueprint: number
    }
    | {
        /** 探查时有孤儿，附用户选定的策略与快照（三种策略都带，不只 clear） */
        kind: 'orphan'
        policy: OrphanPolicy
        snapshot: OrphanSnapshot
        maxFinalized: number
        maxBlueprint: number
    }

/**
 * 续卷提交载荷。**显式携带主进程事务所需的全部数据**，不依赖闭包或 workflow context
 * ——否则 19.2 与 19.4 会各猜各的形状（会审结论）。
 */
export interface CommitNextVolumePayload {
    /**
     * 惰性建卷时的首卷候选与其提交凭据；已有卷时为 undefined。
     *
     * 草案与凭据绑在同一个对象里，是为了让「有草案却没凭据」在类型上就构造不出来。
     * 载荷经 IPC 跨进程而来，运行时仍会再断言一次。
     */
    firstVolume?: { draft: VolumeData; guard: FirstVolumeGuard }
    /** 上一卷（含惰性建的首卷）的收卷提炼结果 */
    closingReport: {
        volumeNumber: number
        closingState: string
        openThreads: OpenThread[]
    }
    /** 新卷（用户可能在预览里编辑过） */
    newVolume: VolumeData
    /**
     * 要追加到全书情节大纲末尾的**新卷段落**（不是整份 synopsis）。
     *
     * 刻意只传增量：若由渲染层传整串，那是分钟前（两次 LLM 调用之前）的内存快照，
     * 用户在生成期间编辑并保存过情节大纲的话，提交时会被旧文本整串覆盖——
     * 静默丢掉用户的编辑，与「用复合 IPC 消除跨时间窗口写风险」的初衷自相矛盾。
     * 由主进程在事务内 `SELECT synopsis` 后拼接，天然无 lost update。
     */
    newVolumeSection: string
}

export interface CommitNextVolumeResult {
    success: boolean
    /** 事务后的新值，供渲染层同步内存中的 NovelConfig 别名 */
    totalChapters?: number
    synopsis?: string
    /**
     * 事务**追加之前**库里的 synopsis 原值。
     *
     * 渲染层判断「用户在生成期间有没有改过大纲」的唯一可靠基准。
     * 它不能靠自己前后各读一次内存 store 来判断——两次读都发生在 LLM 调用**之后**，
     * 用户在生成期间做的编辑对两次读都可见、结果相等，于是被判为「没改过」并整串覆盖。
     * 只有拿库里的原值和当前 store 比，才能看出 store 是否已经偏离。
     */
    previousSynopsis?: string
    /** 本次追加的新卷段落，供渲染层在 store 已偏离时自行追加 */
    appendedSection?: string
    error?: string
}

/** 统计某章号闭区间内实际存在的蓝图条数（不能用 end-start+1 推导，区间允许有缺口） */
function countBlueprintsInRange(
    db: NonNullable<ReturnType<typeof getProjectDb>>,
    startChapter: number,
    endChapter: number,
): number {
    const row = db.prepare(
        'SELECT COUNT(*) as cnt FROM blueprints WHERE chapter_number BETWEEN ? AND ?'
    ).get(startChapter, endChapter) as { cnt: number }
    return row.cnt
}

/**
 * 计算某章号区间内蓝图的**内容指纹**。
 *
 * 只比条数不够：用户在预览期间改了某条蓝图、或生成流程以相同主键替换了内容，
 * COUNT 不变、复核通过，提交就会把用户刚改的内容删掉。
 *
 * ⚠️ 必须 `SELECT *`，覆盖**所有会被删掉的列**。只取章号/标题/关键事件不够——
 * 用户改的可能是 `user_guidance`（他为这一章预设的写作指导）、`purpose`、`notes`，
 * 这些列不进指纹就检测不到。也**不能拿 `updated_at` 当内容代理**：它是秒级精度，
 * 同一秒内的两次修改时间戳相同，指纹照样不动。
 * 列顺序由表结构决定、在本进程内稳定，故 `JSON.stringify(rows)` 即可作为稳定序列化。
 */
function fingerprintBlueprintsInRange(
    db: NonNullable<ReturnType<typeof getProjectDb>>,
    startChapter: number,
    endChapter: number,
): string {
    const rows = db.prepare(
        'SELECT * FROM blueprints WHERE chapter_number BETWEEN ? AND ? ORDER BY chapter_number ASC'
    ).all(startChapter, endChapter)
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

/**
 * 在**同一个 SQLite transaction** 内完成续卷的全部落库。要么全成要么全不成。
 *
 * 顺序按 fail-fast 排：幂等断言 → 跨字段不变量 → 孤儿快照复核 → 删孤儿蓝图
 * → 首卷 → 收卷 → 新卷 → project_core。
 * 前四步**不依赖任何前序写入**（第四步本身是写，但不读前面的结果），
 * 故可自由前置，避免白做几次写再整体回滚。
 * 断言之间的先后也有讲究：重复提交会同时触发①②③，只有①的报错指向真实原因。
 */
export function commitNextVolume(payload: CommitNextVolumePayload): CommitNextVolumeResult {
    const db = getProjectDb()
    if (!db) return { success: false, error: '项目数据库未打开，无法提交续卷' }

    // 载荷是跨进程来的，类型上的「草案与凭据绑在一起」在运行时不作数。
    // 这条断言挡的是渲染层被改成只传草案（那样事务里就没有任何东西可复核）
    if (payload.firstVolume && !payload.firstVolume.guard) {
        return { success: false, error: '首卷提交凭据缺失，无法校验探查结果是否已过期' }
    }

    let newSynopsis = ''
    let previousSynopsis = ''
    const newTotalChapters = payload.newVolume.endChapter

    try {
        const tx = db.transaction(() => {
            // ① 幂等保护：新卷永远不该覆盖既有卷。
            //    upsert 是 ON CONFLICT DO UPDATE 且新卷边界与上次相同时不触发边界检查，
            //    重复提交（双击确认 / 超时重试）会静默覆盖并让大纲被追加两遍。
            //    ⚠️ 必须排在②③之前：重复提交时新卷已存在且已是最后一卷，
            //    ② 会先抛「上一卷已不是最后一卷」、③ 会先抛「蓝图发生了变化」，
            //    把用户引去查别处，而真实原因是重复提交。本断言是纯读，前置零成本。
            if (VolumeRepository.get(payload.newVolume.volumeNumber)) {
                throw new Error(
                    `第 ${payload.newVolume.volumeNumber} 卷已存在，可能是重复提交；请刷新后确认当前分卷状态`
                )
            }

            // ② 跨字段不变量：只断言「新卷号不存在」挡不住并发改动。
            //    payload 是两次 LLM 调用（分钟级）之前算出来的，用户在这期间可能改了
            //    上一卷边界、或从别处建了卷。旧 payload 仍能通过单点检查，
            //    落库后留下章号空洞（第 N 章无人认领）或卷号断档。
            const allVolumes = VolumeRepository.getAll()

            if (payload.firstVolume) {
                const { draft, guard } = payload.firstVolume
                // 惰性路径：发起时卷表为空，提交时必须仍为空。
                // 否则首卷区间会与他人建的卷重叠（upsert 会拒绝，
                // 但报的是底层区间冲突，不如这里说清「状态已变」）
                if (allVolumes.length > 0) {
                    throw new Error('分卷状态已变化（其它操作已创建卷），请重新预览后再提交')
                }

                // 复核探查时的两个边界事实。**没有孤儿也必须查**——
                // 「探查时没有孤儿」本身就是个会过期的结论：用户在生成期间新建了
                // 第 20 章蓝图，首卷 1–10 + 新卷 11–15 照样落库，第 20 章无卷归属，
                // 而载荷里若只在有孤儿时才带凭据，这里就一无所知、全程无人报错。
                const maxFinNow = (db.prepare(
                    `SELECT MAX(chapter_number) as m FROM drafts WHERE status = 'finalized'`
                ).get() as { m: number | null }).m ?? 0
                if (maxFinNow !== guard.maxFinalized) {
                    throw new Error(
                        `已定稿章节在你确认后发生了变化（确认时最大第 ${guard.maxFinalized} 章，` +
                        `现在第 ${maxFinNow} 章），首卷边界是照旧值算的，请重新预览后再提交`
                    )
                }
                const maxBpNow = (db.prepare(
                    'SELECT MAX(chapter_number) as m FROM blueprints'
                ).get() as { m: number | null }).m ?? 0
                if (maxBpNow !== guard.maxBlueprint) {
                    const detail = maxBpNow > guard.maxBlueprint
                        ? `新增到第 ${maxBpNow} 章，这些章将不属于任何卷`
                        : `已减少到第 ${maxBpNow} 章`
                    throw new Error(
                        `章节蓝图在你确认后发生了变化（确认时最大第 ${guard.maxBlueprint} 章，${detail}），` +
                        `请重新预览后再提交`
                    )
                }

                // 凭据的**自洽性**：库里 maxBlueprint > maxFinalized 就是存在孤儿，
                // 凭据必须走 orphan 分支；反之必须走 none 分支。
                // 不做这道检查，「实际有孤儿却只传 none 分支」的载荷就能跳过
                // 下面的策略、指纹与覆盖范围三道复核——类型挡不住跨进程来的载荷。
                const hasOrphanNow = guard.maxBlueprint > guard.maxFinalized
                if (hasOrphanNow && guard.kind !== 'orphan') {
                    throw new Error(
                        `探查时存在未写的旧蓝图（第 ${guard.maxFinalized + 1}–${guard.maxBlueprint} 章），` +
                        `但提交凭据里没有携带处置快照，无法复核，请重新预览后再提交`
                    )
                }
                if (!hasOrphanNow && guard.kind === 'orphan') {
                    throw new Error(
                        `凭据声称有孤儿蓝图，但当前边界事实与之矛盾，请重新预览后再提交`
                    )
                }
                // kind 本身也来自 IPC：伪造的 kind 值不能落进任何「默认放行」的分支
                //（上面的 hasOrphanNow 检查只认 === 'orphan'，伪造值会静默滑过两道分支）
                if (guard.kind !== 'none' && guard.kind !== 'orphan') {
                    throw new Error(`首卷提交凭据的 kind 非法：${String((guard as { kind: unknown }).kind)}`)
                }

                // 孤儿分支的策略枚举校验。policy 同样是跨进程来的字符串——
                // 若不显式验，'bogus' 会按「非 extend」通过 clear/keep 的边界推导，
                // 却既不触发 keep 的覆盖检查、也不执行 clear 的删除，
                // 静默留下新卷范围之外的无归属蓝图（round-06 #2）
                let policy: OrphanPolicy | undefined
                if (guard.kind === 'orphan') {
                    if (guard.policy !== 'clear' && guard.policy !== 'keep' && guard.policy !== 'extend') {
                        throw new Error(`孤儿处置策略非法：${String(guard.policy)}（须为 clear / keep / extend）`)
                    }
                    policy = guard.policy

                    // 快照区间必须严丝合缝地等于「定稿末章 + 1 .. 蓝图末章」。
                    // 区间是复核的对象，若允许渲染层随意指定，指纹比对就形同虚设——
                    // 报一个更窄的区间就能让区间外的改动逃过指纹检查。
                    // 只查区间形状，不查 count——条数失配由③复核，那里能报出
                    // 「确认时 N 条、现在 M 条」这种用户可行动的差异，
                    // 在这里先拦只会给一笼统的「不符」
                    if (
                        guard.snapshot.startChapter !== guard.maxFinalized + 1 ||
                        guard.snapshot.endChapter !== guard.maxBlueprint
                    ) {
                        throw new Error('孤儿快照与探查边界不符，请重新预览后再提交')
                    }
                }

                // 首卷的基础边界——**两种凭据分支都要查**（round-06 #1）：
                // 这些校验若只住在 orphan 分支里，kind:'none' 配上伪造的首卷 2–10
                // 照样提交成功，第 1 章从此没有卷归属；volumeNumber:2 还能造出
                // 从第 2 卷开始的断档序列。末章期望值仍按策略派生：
                // clear/keep 止于定稿末章，extend 吞到蓝图末章
                const expectedEnd = policy === 'extend' ? guard.maxBlueprint : guard.maxFinalized
                if (draft.startChapter !== 1 || draft.volumeNumber !== 1 || draft.endChapter !== expectedEnd) {
                    throw new Error(
                        `首卷应为第 1 卷、从第 1 章到第 ${expectedEnd} 章，` +
                        `实际为第 ${draft.volumeNumber} 卷、第 ${draft.startChapter}–${draft.endChapter} 章，请重新预览后再提交`
                    )
                }

                if (policy === 'keep') {
                    // keep 承诺「新卷大纲兼容旧蓝图」，前提是新卷覆盖整个孤儿区间；
                    // 用户可能在预览阶段把章数改小了——那会重新打开 round-02 #1 的洞，
                    // 故必须在事务层再拦一次，不能只依赖工作流发起时的预检
                    if (payload.newVolume.endChapter < guard.maxBlueprint) {
                        throw new Error(
                            `选择「保留旧蓝图」时本卷须覆盖到第 ${guard.maxBlueprint} 章（旧蓝图末章），` +
                            `当前只到第 ${payload.newVolume.endChapter} 章。请提高本卷章数，` +
                            `或改选「清除」/「扩展首卷边界」`
                        )
                    }
                }

                // 首卷与新卷必须首尾相接。upsert 只查区间**重叠**，不查**相邻**——
                // 首卷 1–20 配新卷 22–40 能全部通过校验，第 21 章从此不属于任何卷
                if (payload.newVolume.startChapter !== draft.endChapter + 1) {
                    const detail = draft.endChapter < payload.newVolume.startChapter - 1
                        ? `中间的第 ${draft.endChapter + 1}–${payload.newVolume.startChapter - 1} 章将无卷归属`
                        : `首卷已覆盖到第 ${draft.endChapter} 章，与新卷区间重叠`
                    throw new Error(
                        `首卷止于第 ${draft.endChapter} 章，新卷起于第 ${payload.newVolume.startChapter} 章：` +
                        `${detail}，请重新预览后再提交`
                    )
                }
                if (payload.newVolume.volumeNumber !== draft.volumeNumber + 1) {
                    throw new Error(
                        `新卷序号应为第 ${draft.volumeNumber + 1} 卷，` +
                        `实际为第 ${payload.newVolume.volumeNumber} 卷，请重新预览`
                    )
                }
            } else {
                // 常规路径：上一卷必须仍是当前最后一卷，且边界未被改动
                const last = allVolumes.reduce<VolumeData | null>(
                    (acc, v) => (!acc || v.volumeNumber > acc.volumeNumber ? v : acc), null)
                if (!last || last.volumeNumber !== payload.closingReport.volumeNumber) {
                    throw new Error('上一卷已不是最后一卷（可能已有其它续卷），请重新预览后再提交')
                }
                if (last.endChapter !== payload.newVolume.startChapter - 1) {
                    // 分开描述两种方向：偏小是空洞（中间章节无卷归属），偏大是重叠
                    //（上一卷已扩张到覆盖新卷起点）。笼统说「空洞」会把用户引向错误的排查方向
                    const detail = last.endChapter < payload.newVolume.startChapter - 1
                        ? `中间的第 ${last.endChapter + 1}–${payload.newVolume.startChapter - 1} 章将无卷归属`
                        : `上一卷已覆盖到第 ${last.endChapter} 章，与新卷区间重叠`
                    throw new Error(
                        `上一卷末章已变为第 ${last.endChapter} 章，与新卷起点第 ${payload.newVolume.startChapter} 章不衔接：` +
                        `${detail}，请重新预览后再提交`
                    )
                }
                if (payload.newVolume.volumeNumber !== last.volumeNumber + 1) {
                    throw new Error(
                        `新卷序号应为第 ${last.volumeNumber + 1} 卷，实际为第 ${payload.newVolume.volumeNumber} 卷，请重新预览`
                    )
                }
            }

            // ③ 孤儿快照复核 —— 不信任渲染层算出的区间、条数与内容。
            //    用户从看到对话框到点确认之间可能改了蓝图内容。
            //    ⚠️ 三种策略都复核：keep 的新卷大纲是照探查时的蓝图推演的，
            //    extend 的首卷边界是照探查时的蓝图末章定死的——它们同样经不起中途变更。
            //    （「区间外新增蓝图」不在这里查：②的 maxBlueprint 复核已经覆盖，
            //      且那条对「探查时本来就没有孤儿」的情形同样有效。）
            const orphanGuard = payload.firstVolume?.guard.kind === 'orphan'
                ? payload.firstVolume.guard
                : undefined
            if (orphanGuard) {
                const { startChapter, endChapter, count, fingerprint } = orphanGuard.snapshot
                const actual = countBlueprintsInRange(db, startChapter, endChapter)
                if (actual !== count) {
                    throw new Error(
                        `第 ${startChapter}–${endChapter} 章的蓝图在你确认后发生了变化` +
                        `（确认时 ${count} 条，现在 ${actual} 条），请重新预览后再提交`
                    )
                }
                if (fingerprintBlueprintsInRange(db, startChapter, endChapter) !== fingerprint) {
                    throw new Error(
                        `第 ${startChapter}–${endChapter} 章的蓝图内容在你确认后被修改过（条数未变），` +
                        `本次生成的新卷大纲是基于旧内容推演的，请重新预览后再提交`
                    )
                }
            }

            // ④ 孤儿蓝图删除 —— **仅 clear 策略**。复核（③）对三种策略都做，删除只对一种。
            //    走仓储以保留其 finalized 保护。提到写入之前是为了 fail fast——
            //    deleteRange 不依赖任何前序写入，而它的「区间内不得有定稿章节」保护
            //    比后面几步更容易触发，放在最后会白做四次写再整体回滚。
            if (orphanGuard?.policy === 'clear') {
                BlueprintRepository.deleteRange(
                    orphanGuard.snapshot.startChapter,
                    orphanGuard.snapshot.endChapter,
                )
            }

            // ⑤ 惰性建卷：首卷必须先于收卷写入，否则下一步 get 不到它
            if (payload.firstVolume) {
                VolumeRepository.upsert(payload.firstVolume.draft)
            }

            // ⑥ 上一卷收束状态与未回收伏笔
            const prev = VolumeRepository.get(payload.closingReport.volumeNumber)
            if (!prev) {
                throw new Error(`第 ${payload.closingReport.volumeNumber} 卷不存在，无法写入收卷状态`)
            }
            VolumeRepository.upsert({
                ...prev,
                closingState: payload.closingReport.closingState,
                openThreads: payload.closingReport.openThreads,
            })

            // ⑦ 新卷。
            //
            // `openingState` 与 `openThreads` **在事务内从 closingReport 派生**，
            // 不采纳载荷里的值。这两个字段是「上一卷收束结果结转到新卷」这条不变量的
            // 两个面，让它们各自独立地跨 IPC 传过来，就等于允许出现
            // 「上一卷登记了伏笔、新卷台账却是空的」这种载荷——提交会成功，
            // 而下一卷的罗盘从此丢掉那些伏笔，链条在无声中断掉。
            //
            // 渲染层的 buildCommitPayload 也做了同样的赋值，但那只是个 helper，
            // 约束不了 IPC 边界；持久化不变量必须在写入这一层强制。
            VolumeRepository.upsert({
                ...payload.newVolume,
                openingState: payload.closingReport.closingState,
                openThreads: payload.closingReport.openThreads,
            })

            // ⑧ project_core：库内读改写，避免用渲染层的陈旧快照整串覆盖。
            //    这是本模块唯一直接写的表——渲染层的 updateProjectCore 无法参与本事务，
            //    故由 IPC 返回新值、渲染层核对 token 后只同步内存别名（不再发持久化 IPC）。
            const coreRow = db.prepare(
                `SELECT synopsis FROM project_core WHERE id = 'main'`
            ).get() as { synopsis: string } | undefined
            if (!coreRow) throw new Error('project_core 主记录缺失，无法更新总章数与情节大纲')

            // 原大纲为空时不加分隔线，否则结果首行是一条孤立的 `---`
            //（零卷且从未生成过情节大纲的项目会走到这里）
            // previousSynopsis 记的是**未 trim 的原值**：渲染层要拿它和内存 store 做
            // 等值比较，trim 过的值会让「store 里只多个尾随换行」被误判为用户编辑过
            previousSynopsis = coreRow.synopsis ?? ''
            const prevSynopsis = previousSynopsis.trim()
            newSynopsis = prevSynopsis
                ? `${prevSynopsis}\n\n---\n\n${payload.newVolumeSection}`.trim()
                : payload.newVolumeSection.trim()
            const info = db.prepare(`
        UPDATE project_core
        SET total_chapters = ?, synopsis = ?, updated_at = datetime('now')
        WHERE id = 'main'
      `).run(newTotalChapters, newSynopsis)
            if (info.changes === 0) {
                throw new Error('project_core 更新未命中任何行，续卷已回滚')
            }
        })

        tx()
        return {
            success: true,
            totalChapters: newTotalChapters,
            synopsis: newSynopsis,
            previousSynopsis,
            appendedSection: payload.newVolumeSection,
        }
    } catch (err) {
        console.error('[volume-commit] 续卷提交失败，事务已回滚:', err)
        return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
}

/**
 * 惰性建卷的**只读探查**（无副作用）。
 *
 * 拆成「只读探查 → 纯函数构造候选 → 单次提交」三段，是因为用户可能在预览里点「取消」；
 * 若探查阶段就建首卷、删蓝图，取消后会留下无回滚入口的半状态。
 */
export interface FirstVolumeInspection {
    needsFirstVolume: boolean
    firstVolumeBase?: {
        startChapter: 1
        maxFinalized: number
        maxBlueprint: number
        synopsis: string
    }
    orphan?: OrphanSnapshot
}

export function inspectFirstVolume(): FirstVolumeInspection {
    const db = getProjectDb()
    if (!db) return { needsFirstVolume: false }

    // 已分卷 → 无需惰性建卷
    if (VolumeRepository.getAll().length > 0) return { needsFirstVolume: false }

    const maxFinRow = db.prepare(
        `SELECT MAX(chapter_number) as m FROM drafts WHERE status = 'finalized'`
    ).get() as { m: number | null }
    const maxFinalized = maxFinRow?.m ?? 0

    const maxBpRow = db.prepare(
        'SELECT MAX(chapter_number) as m FROM blueprints'
    ).get() as { m: number | null }
    const maxBlueprint = maxBpRow?.m ?? 0

    const coreRow = db.prepare(
        `SELECT synopsis FROM project_core WHERE id = 'main'`
    ).get() as { synopsis: string } | undefined

    const result: FirstVolumeInspection = {
        needsFirstVolume: true,
        firstVolumeBase: {
            startChapter: 1,
            maxFinalized,
            maxBlueprint,
            synopsis: coreRow?.synopsis ?? '',
        },
    }

    // 已定稿最大章号之后仍有蓝图 → 孤儿。
    // count 必须实际统计：目录生成允许 AI 一次返回超出本批的章节并按最大章号推进游标，
    // 区间内蓝图可以有缺口，按 end-start+1 算会虚报条数。
    if (maxBlueprint > maxFinalized) {
        const startChapter = maxFinalized + 1
        result.orphan = {
            startChapter,
            endChapter: maxBlueprint,
            count: countBlueprintsInRange(db, startChapter, maxBlueprint),
            fingerprint: fingerprintBlueprintsInRange(db, startChapter, maxBlueprint),
        }
    }

    return result
}

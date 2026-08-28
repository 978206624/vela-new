/**
 * volume-service — 分卷读取与「零卷回落」的唯一收口（Phase 19）
 *
 * ## 为什么生成关键路径只吃 VolumeSnapshot，不吃 VolumeData[]
 *
 * 分卷是可选形态：`volumes` 空表 = **单卷模式**，此时全书行为必须与分卷前
 * 一致（读 `project_core.synopsis` + `novelConfig.totalChapters`）。
 *
 * 但「空表」这个事实**只有在成功读到时才成立**。若函数签名收 `VolumeData[]`，
 * 那么「真空表」「尚未加载」「加载失败」「跨项目旧回包」全都长成 `[]`——
 * 任何一处漏检查加载状态，就会把**已闭环的全书 synopsis** 喂给 AI，
 * 正是本 Phase 要根治的原始缺陷。靠注释要求调用方自觉检查不叫收口。
 *
 * 因此生成关键路径（`isVolumeMode` / `getEffectiveTotalChapters` /
 * `getVolumeOutline`）**只接受 `VolumeSnapshot`**，未就绪时返回
 * `{ ready: false }` 让调用方 fail closed（提示重试），而不是静默回落。
 *
 * 纯展示用的 helper（当前卷 / 最后一卷 / 能否改边界 / 能否删）仍收数组：
 * 它们的失败模式是「按钮禁用、列表不显示」，是安全默认值，不会污染生成。
 */
import { ipc } from './ipc-client'
import type { NovelConfig } from '../shared/ipc-channels'
import type { VolumeData, VolumeStatus, OpenThread } from '../../electron/repositories/volume-repository'
import type { ProjectCoreData } from '../../electron/repositories/project-core-repository'

/** 卷状态的中文展示文案。
 *  刻意避开「连载中 / 已完结」这类在线平台话术——Vela 是本地优先的写作工具，
 *  不做社区与发布（Product-Spec §5 非目标范围）。 */
export const VOLUME_STATUS_LABELS: Record<VolumeStatus, string> = {
    planned: '未开始',
    writing: '写作中',
    done: '已完成',
}

/** 分卷加载快照。只有 `ready` 才携带 volumes——空数组此时才真正意味着单卷模式 */
export type VolumeSnapshot =
    | { status: 'ready'; volumes: VolumeData[] }
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'error' }

/** 生成关键路径的查询结果：未就绪时不给值，强制调用方 fail closed */
export type VolumeQuery<T> =
    | { ready: true; value: T }
    | { ready: false; reason: 'idle' | 'loading' | 'error' }

const notReady = <T>(snap: VolumeSnapshot): VolumeQuery<T> | null =>
    snap.status === 'ready' ? null : { ready: false, reason: snap.status }

/** 未就绪原因的中文提示，供 UI 直接展示 */
export function describeNotReady(reason: 'idle' | 'loading' | 'error'): string {
    switch (reason) {
        case 'idle': return '分卷数据尚未加载，请稍后重试'
        case 'loading': return '分卷数据正在加载，请稍后重试'
        case 'error': return '分卷数据读取失败，请重新打开项目后重试'
    }
}

/**
 * 从当前项目库加载全部卷。
 *
 * **失败时抛出，不吞异常。** 若在这里 catch 返回 `[]`，「读失败」与「未分卷」
 * 就不可区分，已分卷项目会被误判为单卷模式。调用方（volume-store）需自行
 * catch 并置为 error 快照。
 */
export async function loadVolumes(): Promise<VolumeData[]> {
    return await ipc.invoke('db:volume-get-all')
}

// ===== 生成关键路径：只吃 VolumeSnapshot，未就绪 fail closed =====

/** 是否处于分卷模式。未就绪时不猜——返回 not ready，由调用方决定重试或报错 */
export function isVolumeMode(snap: VolumeSnapshot): VolumeQuery<boolean> {
    const nr = notReady<boolean>(snap)
    if (nr) return nr
    return { ready: true, value: (snap as { volumes: VolumeData[] }).volumes.length > 0 }
}

/**
 * 全书有效总章数的**纯计算**部分（不含就绪判定）。
 *
 * - 分卷模式：各卷 `endChapter` 最大值（**卷表为准**）
 * - 单卷模式：回落 `fallbackTotal`（即 `novelConfig.totalChapters`）
 *
 * 抽出来是因为纯展示路径（分卷总览页的副信息）也要这条规则，而它拿到的
 * `volumes` 已经在 `status === 'ready'` 分支里了、不需要再走一遍 fail-closed。
 * 若让它自己 `reduce` 一遍，这条规则就有了第二份实现——分叉的那份迟早
 * 与卷表口径不一致。规则只写一次，就绪判定由下面的 `getEffectiveTotalChapters` 加。
 */
export function computeEffectiveTotalChapters(vols: VolumeData[], fallbackTotal: number): number {
    if (vols.length === 0) return fallbackTotal
    return vols.reduce((max, v) => Math.max(max, v.endChapter), 0)
}

/**
 * 全书有效总章数。
 * - 分卷模式：各卷 `endChapter` 最大值（**卷表为准**）
 * - 单卷模式：回落 `novelConfig.totalChapters`
 *
 * 续卷会把 `novelConfig.totalChapters` 同步扩展到新卷末章，二者理论一致；
 * 用户手改小说配置可能造成偏离，分卷模式下以卷表为准。
 */
export function getEffectiveTotalChapters(
    snap: VolumeSnapshot,
    novelConfig: NovelConfig,
): VolumeQuery<number> {
    const nr = notReady<number>(snap)
    if (nr) return nr
    const vols = (snap as { volumes: VolumeData[] }).volumes
    return { ready: true, value: computeEffectiveTotalChapters(vols, novelConfig.totalChapters) }
}

/**
 * 取生成时该喂给 AI 的「情节大纲」文本。
 * - **单卷模式（真零卷）**：回落全书 `core.synopsis` **原文**（不做 trim 等文本处理——
 *   该函数会被目录生成与正文写作共用，规范化留给各既有消费路径，不偷偷固化在回落层）
 * - **分卷模式**：当前卷的 `premise` + `synopsis`；章号落在所有卷区间之外
 *   （如首卷末章之后、尚未续卷的那几章）回落**最后一卷**，
 *   **任何有卷场景都不返回全书 synopsis** —— 那份已闭环，喂进去会诱导 AI 收尾。
 */
export function getVolumeOutline(
    snap: VolumeSnapshot,
    chapterNumber: number,
    core: Pick<ProjectCoreData, 'synopsis'> | null,
): VolumeQuery<string> {
    const nr = notReady<string>(snap)
    if (nr) return nr
    const vols = (snap as { volumes: VolumeData[] }).volumes

    // 单卷模式：行为与分卷前一致，返回原文
    if (vols.length === 0) return { ready: true, value: core?.synopsis ?? '' }

    // 分卷模式：命中卷优先，越界回落最后一卷（绝不回落全书 synopsis）
    const vol = getCurrentVolume(vols, chapterNumber) ?? getLastVolume(vols)
    if (!vol) return { ready: true, value: '' }

    return {
        ready: true,
        value: [
            vol.premise?.trim() && `【本卷主线】\n${vol.premise.trim()}`,
            vol.synopsis?.trim() && `【本卷大纲】\n${vol.synopsis.trim()}`,
        ].filter(Boolean).join('\n\n'),
    }
}

/**
 * 「本卷罗盘」的取数——目录生成（19.3a）与正文写作（19.3b）共用同一份口径。
 *
 * 与既有 `getVolumeOutline` 同属**生成关键路径**，故同样只吃 `VolumeSnapshot`：
 * 未就绪时 fail closed，绝不把「加载中」当成单卷模式。
 *
 * 返回**判别联合**而非「数据 + 可空」：四种状态各有不同的正确处理方式，
 * 用 `null` 或布尔标志表达会让调用方在其中两种之间做出错误分支
 * （尤其「真单卷模式」与「有卷但本章无归属」必须区分——前者是正常形态，
 *  后者是分卷边界有问题）。
 */
export type VolumeCompassResult =
    /** 真单卷模式（零卷）。所有卷相关注入整段跳过，老项目零感知 */
    | { kind: 'single' }
    /** 章号精确落在某卷闭区间内。罗盘完全可信 */
    | { kind: 'exact'; volume: VolumeCompassData }
    /**
     * 章号不属于任何卷，回落到**它之前**最近的那一卷（末卷之后、或卷间缺口）。
     * 主线与伏笔仍是最贴近的承接上下文，值得注入；但位置信息已失真，须略去。
     */
    | { kind: 'prior'; volume: VolumeCompassData }
    /**
     * 有卷，但本章位于首卷起点之前，**没有任何前序卷可回落**。
     * 此时不存在「最近一卷」，任何注入都是编造，调用方必须整段跳过。
     */
    | { kind: 'unassigned' }

export interface VolumeCompassData {
    volumeNumber: number
    title: string
    startChapter: number
    endChapter: number
    /** 本卷主线目标 + 核心冲突 */
    premise: string
    /** 开卷状态 = 上一卷收卷状态（续卷事务落库时写入本卷） */
    openingState: string
    /**
     * 需要在本卷回收的伏笔——**只读本卷台账**。
     *
     * 建卷时由续卷事务把上一卷的未回收清单结转进来（见 `buildCommitPayload`），
     * 此后本卷台账就是唯一权威：用户在卷详情里改它、下一次收卷提炼也读它。
     *
     * ⚠️ 不要改成「上一卷 + 本卷」合并。那样会同时制造两个错误：
     * 已在本卷回收、台账已清空的条目会被上一卷"复活"；而三卷之后，
     * 由于结转从未真正发生，链条会在 V2 处断掉。
     */
    openThreads: OpenThread[]
}

export function getVolumeCompass(
    snap: VolumeSnapshot,
    chapterNumber: number,
): VolumeQuery<VolumeCompassResult> {
    const nr = notReady<VolumeCompassResult>(snap)
    if (nr) return nr
    const vols = (snap as { volumes: VolumeData[] }).volumes
    if (vols.length === 0) return { ready: true, value: { kind: 'single' } }

    const toData = (v: VolumeData): VolumeCompassData => ({
        volumeNumber: v.volumeNumber,
        title: v.title,
        startChapter: v.startChapter,
        endChapter: v.endChapter,
        premise: v.premise ?? '',
        openingState: v.openingState ?? '',
        openThreads: v.openThreads,
    })

    const exact = getCurrentVolume(vols, chapterNumber)
    if (exact) return { ready: true, value: { kind: 'exact', volume: toData(exact) } }

    // ⚠️ 回落只能朝**过去**方向找，不能一律取最后一卷。
    // 卷区间允许存在缺口（仓储只禁止重叠，不保证连续），
    // 卷一 1–10、卷二 15–60 时写第 12 章若取「最后一卷」，
    // 拿到的是**未来**的卷二——正文会被提前注入还没写到的主线与伏笔，
    // 而文案还称它「最近一卷」，是双重错误。
    const prior = vols
        .filter(v => v.endChapter < chapterNumber)
        .reduce<VolumeData | null>((acc, v) => (!acc || v.endChapter > acc.endChapter ? v : acc), null)
    if (prior) return { ready: true, value: { kind: 'prior', volume: toData(prior) } }

    // 本章位于首卷起点之前，没有任何前序卷可回落。
    // 此时不存在「最近一卷」，硬给就是编造——交给调用方整段跳过
    return { ready: true, value: { kind: 'unassigned' } }
}

/**
 * 校验一个章号闭区间是否被现有卷**连续覆盖**。
 *
 * `value === null` 表示单卷模式——此时不存在卷边界，任何区间都合法。
 *
 * 为什么必须**前置**校验整个区间、而不是逐批到了才发现：
 * 目录生成是「跑一批、写一批」的。卷二止于 60 时请求 58–63，
 * 逐批检查会让 58–60 那一批先跑完 LLM 并把蓝图写进库，
 * 游标推到 61 才报错——工作流失败了，模型调用和落库的副作用却已经发生。
 */
export type RangeCoverage =
    | { covered: true }
    | { covered: false; message: string }

export function checkRangeCoverage(
    snap: VolumeSnapshot,
    startChapter: number,
    endChapter: number,
): VolumeQuery<RangeCoverage | null> {
    const nr = notReady<RangeCoverage | null>(snap)
    if (nr) return nr
    const vols = (snap as { volumes: VolumeData[] }).volumes
    if (vols.length === 0) return { ready: true, value: null }

    const sorted = [...vols].sort((a, b) => a.startChapter - b.startChapter)
    const first = sorted[0]
    const last = sorted[sorted.length - 1]

    if (startChapter < first.startChapter) {
        return {
            ready: true,
            value: { covered: false, message: `第 ${startChapter} 章在首卷起点（第 ${first.startChapter} 章）之前，不属于任何卷` },
        }
    }
    if (endChapter > last.endChapter) {
        return {
            ready: true,
            value: {
                covered: false,
                message:
                    `生成范围到第 ${endChapter} 章，已超出最后一卷「${last.title}」的末章（第 ${last.endChapter} 章）。` +
                    `请先「续写下一卷」建立卷区间，或把范围收回到第 ${last.endChapter} 章以内`,
            },
        }
    }
    // 卷间缺口：相邻两卷不首尾相接时，落在缺口里的章号同样无卷归属
    for (let i = 1; i < sorted.length; i++) {
        const gapStart = sorted[i - 1].endChapter + 1
        const gapEnd = sorted[i].startChapter - 1
        if (gapStart <= gapEnd && startChapter <= gapEnd && endChapter >= gapStart) {
            return {
                ready: true,
                value: { covered: false, message: `第 ${gapStart}–${gapEnd} 章不属于任何卷（卷区间存在缺口），请先修正分卷边界` },
            }
        }
    }
    return { ready: true, value: { covered: true } }
}

// ===== 展示用 helper：收数组即可，失败模式是安全默认值 =====

/**
 * 「有定稿」的判据。抽出来是因为侧栏卷卡片、分卷总览大卡两处都要用，
 * 各写一份迟早分叉（其中一份会漏掉 `finalized` 之外的状态判断）。
 */
const hasFinalized = (drafts: Array<{ status: string }> | undefined): boolean =>
    !!drafts?.some(d => d.status === 'finalized')

/**
 * 统计某章号闭区间内**已定稿**的章数。
 *
 * ⚠️ 遍历的是 draft-store 里**实际存在的章**，不是 `start..end` 这个区间。
 * `MAX_VOLUME_CHAPTERS` 只约束新写入，老库与外部导入的库里仍可能有超长卷；
 * 而本函数跑在侧栏与总览页这类**每次状态变更都要重算**的位置，
 * 按区间循环会让渲染直接冻住。
 *
 * ⚠️ 返回值是**展示用近似值**，不是权威定稿清单：`draft-store.loadAllDrafts`
 * 只扫「已有蓝图的章」，无蓝图却已定稿的章不在其中（与 `canDeleteVolume`
 * 的口径说明同源）。用于进度条无害，不可当授权依据。
 */
export function countFinalizedInRange(
    draftsByChapter: Record<number, Array<{ status: string }> | undefined>,
    startChapter: number,
    endChapter: number,
): number {
    let n = 0
    for (const [ch, drafts] of Object.entries(draftsByChapter)) {
        const c = Number(ch)
        if (c < startChapter || c > endChapter) continue
        if (hasFinalized(drafts)) n++
    }
    return n
}

/** 全书已定稿章数。口径与 `countFinalizedInRange` 同源（同样是展示用近似值） */
export function countFinalizedTotal(
    draftsByChapter: Record<number, Array<{ status: string }> | undefined>,
): number {
    let n = 0
    for (const drafts of Object.values(draftsByChapter)) {
        if (hasFinalized(drafts)) n++
    }
    return n
}

/**
 * 卷卡片的「主线摘要」取数：`premise` 优先，为空回落 `synopsis`。
 *
 * ⚠️ 不能只看 `premise`。惰性建卷的第一卷由 `buildFirstVolumeDraft()` 构造，
 * 它固定 `premise: ''`，而把**原有的全书大纲**放进 `synopsis`——只看 premise
 * 会让首卷在总览页永远显示「尚无摘要」，而它其实有大纲。
 *
 * 抽成纯函数是为了可测：留在组件里，这条回落只能靠人工建一个首卷来验。
 */
export function getVolumeSummary(v: Pick<VolumeData, 'premise' | 'synopsis'>): string {
    return v.premise?.trim() || v.synopsis?.trim() || ''
}

/**
 * 卷卡片的未回收伏笔计数展示值。返回 `null` 表示「该写成 —」。
 *
 * 规则，按优先级：
 * 1. **有伏笔就一定写出数字**。伏笔清单经 `db:volume-update-threads` 独立更新，
 *    与 `premise`/`synopsis` 毫无绑定——用户完全可以在一个还没写大纲的卷里
 *    先补录几条伏笔。此时把它显示成「—」是在**隐藏已经存在的确定数据**。
 * 2. 没有伏笔、但**有大纲** → 写 `0`。台账已经建起来了，「0」是权威且有意义的
 *    结论（本卷没有遗留伏笔），伪装成未知反而是退步。
 * 3. 没有伏笔、也**没有大纲** → `null`。这时台账还没建，谈「0 条」会被读成
 *    「已确认没有伏笔」（设计稿 27 第三张卡画的就是「—」）。
 */
export function describeOpenThreadCount(
    v: Pick<VolumeData, 'premise' | 'synopsis' | 'openThreads'>,
): number | null {
    const count = v.openThreads?.length ?? 0
    if (count > 0) return count
    return getVolumeSummary(v) ? 0 : null
}

/** 取某章所属的卷；未分卷或章号落在所有卷区间之外返回 null */
export function getCurrentVolume(vols: VolumeData[], chapterNumber: number): VolumeData | null {
    return vols.find(v => v.startChapter <= chapterNumber && v.endChapter >= chapterNumber) ?? null
}

/** 取最后一卷（卷序号最大）；无卷返回 null */
export function getLastVolume(vols: VolumeData[]): VolumeData | null {
    if (vols.length === 0) return null
    return vols.reduce((acc, v) => (v.volumeNumber > acc.volumeNumber ? v : acc), vols[0])
}

/**
 * 该卷的章号边界是否可编辑（**仅用于提前禁用输入框**）。
 * 最终授权在 `VolumeRepository.upsert` 的事务内（会核 MAX(volume_number) 与区间重叠），
 * 此处返回 true 不代表写入一定成功。
 */
export function canEditVolumeBoundary(vols: VolumeData[], volumeNumber: number): boolean {
    const last = getLastVolume(vols)
    return last !== null && last.volumeNumber === volumeNumber
}

/**
 * 该卷是否可删除（**仅用于提前禁用删除按钮**）。
 *
 * 最终授权在 `VolumeRepository.remove` 的事务内——它直接查 `drafts` 表的
 * finalized 记录。此处的 `finalizedChapters` 来自渲染层 draft-store，
 * **不是库中全部定稿的权威清单**（只覆盖已有蓝图的章节），可能漏判，
 * 故只能用于 UI 预判，不能当授权依据。
 */
export function canDeleteVolume(
    vols: VolumeData[],
    volumeNumber: number,
    finalizedChapters: number[],
): boolean {
    const vol = vols.find(v => v.volumeNumber === volumeNumber)
    if (!vol) return false
    return !finalizedChapters.some(ch => ch >= vol.startChapter && ch <= vol.endChapter)
}

/**
 * volume-regen-workflow — 重新生成**已存在的卷**的大纲（Phase 19 / Task 19.4 T3）
 *
 * 对照设计稿 `30-卷详情编辑器-生成中.png` 的四段步进器：
 * `读取上一卷收束状态` → `读取本卷已写 N 章要点` → `生成本卷大纲` → `等待确认写入`。
 *
 * ## 与 `createNextVolumeWorkflow`（续写下一卷）不是一回事
 *
 * | | 续写下一卷 | 重新生成本卷大纲 |
 * |---|---|---|
 * | 目标卷 | **新建**的下一卷 | **已存在**的本卷 |
 * | 上一卷收卷状态 | 现跑 LLM 提炼 | 直接读库里已落库的那份 |
 * | LLM 调用次数 | 2 次 | **1 次** |
 * | 章号区间 | 用户在向导里定 | **卷表既有边界，不可改** |
 * | 本卷主线 | AI 产出 | **输入约束，不动** |
 * | 产物落库 | 单次事务（建卷 + 改总章数 + 追加情节大纲） | **完全不落库**，交文本框由用户保存 |
 *
 * ## 全流程零副作用
 *
 * 四步没有任何一步写库。用户不点「保存」，这次生成在数据上不存在——
 * 唯一的痕迹是 `llm_calls` 里的一条统计，而那笔调用确实发生过、确实花了钱
 * （刻意不用续卷那套 `logPolicy:'defer'`，理由见 command 内注释）。
 *
 * ## token 纪律
 *
 * 与续卷同款：token **在工作流构造时、第一次 await 之前**捕获，钉进 `context.data`
 * 交给 `callLLM` 严格核对。本流程虽然不写库，token 仍不可省——它挡的是
 * 「A 项目的卷 + B 项目的世界观」这种混合 prompt，以及把 A 的调用统计记进 B 的库。
 */
import type { WorkflowDefinition } from '../../stores/workflow-store'
import { MAX_VOLUME_CHAPTERS } from '../../shared/volume-limits'
import { useProjectStore } from '../../stores/project-store'
import { getProjectToken } from '../../stores/volume-store'
import { ipc } from '../ipc-client'
import { useWorkflowStore } from '../../stores/workflow-store'
import { WORKFLOW_TOKEN_KEY } from './commands/base-command'
import { readVolumeWrittenFacts, type VolumeWrittenFacts } from '../prompts/volume-context'
import type { VolumeData } from '../../../electron/repositories/volume-repository'

/** 本工作流的类型标识。「停止生成」要靠它从 `activeRuns` 里找 runId（见文件尾说明） */
export const VOLUME_REGEN_WORKFLOW_TYPE = 'volume_synopsis' as const

export interface RegenerateVolumeParams {
    /** 目标卷序号 */
    volumeNumber: number
    /**
     * 发起时该卷章号边界的**冻结快照**。
     *
     * ⚠️ 必须是发起那一刻复制出来的**值**，不能是某个会随后台刷新更新的引用。
     * 传成「当前值」的话，下面那道复核就变成拿库里的值和它自己比，比对必过，
     * 整道防线白设（Task 19.4 T4 已经这样栽过一次）。
     *
     * 它要回答的问题是：用户点「重新生成」时看着的是第 101–160 章，
     * 到工作流真正读库时它还是不是这个区间。不一致就中止——按另一个区间
     * 生成出来的大纲会静默错位，而用户全程只会看到「生成完成」。
     */
    boundaryAtStart: { startChapter: number; endChapter: number }
    /** 故事模型 key（`novelConfig.plotStructure`），发起时捕获 */
    structure: string
    /**
     * 步进器第二段要显示的章数。取自卷详情头部已经在显示的那个「已写 N 章」，
     * 与设计稿 30 的「读取本卷已写 12 章要点」对齐。
     *
     * 它是**展示值**（`countFinalizedInRange` 的近似统计，见该函数注释），
     * 与本步实际读到的「有要点的章数」可能不等——后者由本步的 result 如实报出。
     */
    writtenChapters: number
    /** 流式打字机回调，透传给命令 */
    onPartial?: (text: string) => void
}

/** 工作流产物。经 `takeWorkflowResult(runId)` 取走 */
export interface RegenerateVolumeResult {
    volumeNumber: number
    /** AI 重新生成的卷大纲。**尚未落库** */
    synopsis: string
    /** 工作流发起时捕获的项目 token。落库前须原样比对 */
    capturedToken: number
}

/** 取走产物（取走即释放）。无产物返回 null */
export function takeRegenerateVolumeResult(runId: string): RegenerateVolumeResult | null {
    const r = useWorkflowStore.getState().takeWorkflowResult(runId)
    return (r as RegenerateVolumeResult | null) ?? null
}

/**
 * 校验一个卷的章号区间是否可用于生成。返回错误文案，`null` 表示通过。
 *
 * 抽成导出的纯函数是为了可测：留在 executor 里就只能靠造一整套 IPC 夹具来验。
 * 判据与 `createNextVolumeWorkflow` 里那道**同源**——老库与外部导入的库里
 * 仍可能有超长卷或反向区间（`MAX_VOLUME_CHAPTERS` 只约束新写入），
 * 而本流程会拿这个区间去读章节要点、算结构指导分段。
 */
export function validateVolumeRangeForRegen(volume: {
    title: string
    startChapter: number
    endChapter: number
}): string | null {
    // 上下界**都要验**。只拦「太长」会漏掉零长度与反向区间
    // （`start=2, end=1` → span 为 0，两个端点却都是安全整数）
    if (!Number.isSafeInteger(volume.startChapter) || !Number.isSafeInteger(volume.endChapter)) {
        return `「${volume.title}」的章号超出可精确表示的范围（第 ${volume.startChapter}–${volume.endChapter} 章），请先在卷详情里修正边界`
    }
    if (volume.startChapter < 1) {
        return `「${volume.title}」的起始章号为 ${volume.startChapter}，必须 ≥1，请先在卷详情里修正边界`
    }
    const span = volume.endChapter - volume.startChapter + 1
    if (span < 1 || span > MAX_VOLUME_CHAPTERS) {
        return `「${volume.title}」的章号区间异常：第 ${volume.startChapter}–${volume.endChapter} 章`
            + `（共 ${span} 章，合法范围 1–${MAX_VOLUME_CHAPTERS}）。请先在卷详情里修正边界`
    }
    return null
}

export function createRegenerateVolumeWorkflow(params: RegenerateVolumeParams): WorkflowDefinition {
    // ⚠️ 在任何 await 之前捕获 token（见文件头「token 纪律」）
    const capturedToken = getProjectToken()
    if (capturedToken === undefined) throw new Error('未打开项目，无法重新生成卷大纲')

    const { volumeNumber, boundaryAtStart, writtenChapters } = params

    return {
        type: VOLUME_REGEN_WORKFLOW_TYPE,
        title: '🔄 重新生成本卷大纲',
        steps: [
            {
                // 步进器第一段。上一卷的卷号在发起时是未知的（要读库才知道有没有上一卷），
                // 故名字里不写卷号，由本步的 result 如实报出具体读了谁的收束状态
                name: '读取上一卷收束状态',
                description: '取上一卷已落库的收卷状态作为本卷来路（不重新提炼）',
                executor: async (_step, context, callbacks) => {
                    const project = useProjectStore.getState().currentProject
                    if (!project) throw new Error('未打开项目')

                    // 把起点 token 钉进 context：callLLM 会以它为准核对，而不是现取当前 token
                    context.data[WORKFLOW_TOKEN_KEY] = capturedToken

                    const volumes = await ipc.invoke('db:volume-get-all')
                    const volume = volumes.find(v => v.volumeNumber === volumeNumber)
                    if (!volume) {
                        throw new Error(`第 ${volumeNumber} 卷已不存在（可能已被删除），本次生成中止`)
                    }

                    // ⚠️ 复核的两边必须来自**不同来源**：`boundaryAtStart` 是点击那一刻
                    // 从界面复制出来的值，`volume` 是刚从库里读回来的行。
                    // 若把 `boundaryAtStart` 传成一个会随后台刷新更新的引用，
                    // 这里就成了拿新值和新值比，永远相等
                    if (
                        volume.startChapter !== boundaryAtStart.startChapter
                        || volume.endChapter !== boundaryAtStart.endChapter
                    ) {
                        throw new Error(
                            `本卷章号区间已变更（你发起时是第 ${boundaryAtStart.startChapter}–${boundaryAtStart.endChapter} 章，`
                            + `现在是第 ${volume.startChapter}–${volume.endChapter} 章），本次生成中止。请重新发起`
                        )
                    }

                    const rangeError = validateVolumeRangeForRegen(volume)
                    if (rangeError) throw new Error(rangeError)

                    // 上一卷 = 卷序号小于本卷的那些里最大的一个。
                    // ⚠️ 不能写成 `volumeNumber - 1`：卷序号允许有缺口（中间卷被删过），
                    // 直接减一会找不到而被误判成「本卷是第一卷」，
                    // 于是真正的上一卷收束状态整段丢失，AI 从零开始接
                    const prev = volumes
                        .filter(v => v.volumeNumber < volumeNumber)
                        .reduce<VolumeData | null>(
                            (acc, v) => (!acc || v.volumeNumber > acc.volumeNumber ? v : acc), null)

                    context.data.volume = volume
                    context.data.prevClosingState = prev?.closingState ?? ''
                    /**
                     * ⚠️ 「没有上一卷」与「上一卷存在但没记录收卷状态」是**两件事**，
                     * 必须分开传给命令层。
                     *
                     * 都压成空串的话，命令层只能给出一句回退文案，而它写的是
                     * 「本卷是第一卷，没有上一卷」——对第五卷说这句话是**明确的错误事实**，
                     * 模型会据此从零起笔、丢掉四卷的积累（Codex round-02 major #4）。
                     */
                    context.data.prevVolumeTitle = prev?.title ?? ''
                    context.data.hasPrevVolume = prev !== null

                    if (!prev) {
                        callbacks.log('本卷之前没有其它卷，以全书故事前提为起点')
                        return '本卷是首卷，无上一卷收束状态'
                    }
                    if (!prev.closingState?.trim()) {
                        // 如实报出来，不假装读到了。上一卷没跑过收卷提炼（或用户清空了）
                        // 是常见状态，不该因此失败，但也不该让用户以为 AI 拿到了它
                        callbacks.log(`「${prev.title}」尚未记录收卷状态，本次生成不注入该段`)
                        return `「${prev.title}」无收卷状态记录`
                    }
                    callbacks.log(`已读取「${prev.title}」的收卷状态（${prev.closingState.trim().length} 字）`)
                    return `已读取「${prev.title}」收束状态`
                },
            },
            {
                name: `读取本卷已写 ${writtenChapters} 章要点`,
                description: '读本卷章号区间内各章的实际写作要点——已写章节是既成事实，不得被推翻',
                executor: async (_step, context, callbacks) => {
                    const volume = context.data.volume as VolumeData
                    if (!volume) throw new Error('目标卷数据缺失')

                    // ⚠️ 走**严格**版事实快照：读失败必须抛错、不能回落成「暂无要点」。
                    // 本卷可能已写十几章，Spec §4.11 的硬约束是「已写章节不得推翻」；
                    // 静默回落会让模型当整卷空白重排，用户拿到一份看起来正常、
                    // 实际与已发布正文冲突的大纲还能点保存
                    //（Codex round-03 major #3；宽容版留给续卷那条可降级的路径）
                    let facts: VolumeWrittenFacts
                    try {
                        facts = await readVolumeWrittenFacts(volume.startChapter, volume.endChapter)
                    } catch (e) {
                        throw new Error(
                            `读取本卷已写章节要点失败：${e}。`
                            + `已写章节是本次生成不可推翻的前提，读不到就不能生成——请重试`
                        )
                    }

                    // 事实**不完整**同样要拦在 LLM 之前（Codex round-04 major）。
                    // 定稿流程是「先写 finalized，再跑可能失败的 notes 后处理」，
                    // 于是「已定稿但 notes 为空」是实际可达的故障态：那几章的正文
                    // 读者已经看过，模型却看不到它们写了什么，会当空白重排
                    if (facts.finalizedWithoutNotes.length > 0) {
                        const list = facts.finalizedWithoutNotes.slice(0, 10).join('、')
                        const more = facts.finalizedWithoutNotes.length > 10
                            ? `等 ${facts.finalizedWithoutNotes.length} 章` : ''
                        throw new Error(
                            `第 ${list}${more} 章已定稿但没有章节要点。`
                            + `已写章节是本次生成不可推翻的前提，缺了要点，AI 会把它们当空白重排。`
                            + `请先对这些章重跑「定稿后处理」补上要点，再重新生成本卷大纲`
                        )
                    }

                    // 要点**属于上一版定稿**同样不能用（Codex round-05 major #2）。
                    // Phase 14 允许改已定稿章节，而 `finalizeExclusive` 不清 `blueprints.notes`；
                    // 新版后处理跑完之前，旧要点会冒充当前事实，AI 会按上一版的剧情续
                    if (facts.finalizedWithStaleNotes.length > 0) {
                        const list = facts.finalizedWithStaleNotes.slice(0, 10).join('、')
                        const more = facts.finalizedWithStaleNotes.length > 10
                            ? `等 ${facts.finalizedWithStaleNotes.length} 章` : ''
                        throw new Error(
                            `第 ${list}${more} 章的章节要点早于它最近一次定稿——那份要点描述的是上一版正文。`
                            + `按它生成的大纲会与现在的正文脱节。`
                            + `请等这些章的「定稿后处理」写出新要点后再重新生成本卷大纲`
                        )
                    }

                    context.data.writtenNotes = facts.text
                    // 结算前要拿它复核一次：本次生成跨一次分钟级 LLM 调用，
                    // 期间另一条定稿工作流完全可能更新 notes（Codex round-04 major）
                    context.data.writtenFactsDigest = facts.digest

                    callbacks.log(`已读取第 ${volume.startChapter}–${volume.endChapter} 章的实际要点（${facts.text.length} 字）`)
                    return `已读取本卷要点（${facts.text.length} 字）`
                },
            },
            {
                name: '生成本卷大纲',
                description: 'AI 在既定主线与已写章节之上重新推演本卷情节走向',
                executor: async (_step, context, callbacks) => {
                    const { RegenerateVolumeSynopsisCommand } = await import('./commands/volume-synopsis-regen.command')
                    const synopsis = await new RegenerateVolumeSynopsisCommand({
                        structure: params.structure,
                        onPartial: params.onPartial,
                    }).execute({ step: _step, context, callbacks })
                    context.data.synopsis = synopsis
                    return `已生成本卷大纲（${synopsis.length} 字）`
                },
            },
            {
                name: '等待确认写入',
                description: '生成结果落进卷详情的「本卷大纲」，由你点「保存」才写入数据库',
                executor: async (_step, context, callbacks) => {
                    // 本步不写库，但要做**最后一次事实复核**。
                    //
                    // 本次生成跨了一次分钟级 LLM 调用，而「重新生成本卷大纲」不阻塞别的
                    // 工作流——期间用户完全可以定稿一章，定稿后处理随即写入新的
                    // `chapter_notes`。那份刚生成的大纲是按**旧事实**推演的，
                    // 让它落进文本框、被用户点保存，就是在用过期事实推翻新写的正文
                    //（Codex round-04 major）。
                    //
                    // 复核也是 fail-closed：读不到就不能断言事实没变，一律中止。
                    const volume = context.data.volume as VolumeData
                    const before = context.data.writtenFactsDigest as string
                    let after: VolumeWrittenFacts
                    try {
                        after = await readVolumeWrittenFacts(volume.startChapter, volume.endChapter)
                    } catch (e) {
                        throw new Error(
                            `生成完成后复核本卷已写事实失败：${e}。`
                            + `无法确认这份大纲是否仍与已写章节一致，已作废——请重试`
                        )
                    }
                    if (after.digest !== before) {
                        throw new Error(
                            '生成期间本卷的章节要点发生了变化（可能刚定稿了新章节）。'
                            + '这份大纲是按变化前的事实推演的，已作废——请重新生成'
                        )
                    }
                    // ⚠️ **完整性也要复核一遍，不能只比 digest**。
                    //
                    // digest 只由「章号 + notes 原文」构成，而「某章刚变成 finalized、
                    // notes 仍是空的」这件事**不改变任何 notes**——digest 一模一样，
                    // 只比它就放行了。那一章的正文读者已经看过，模型却没见过
                    // （Codex round-05 major #1）。
                    //
                    // 判据与第 2 步同源，故意重复一次而不是抽成 helper：
                    // 两次调用点的语义不同（一次是「能不能开始」，一次是「产物还算不算数」），
                    // 各自的错误文案也不同，抽掉反而要传标志位回来区分
                    if (after.finalizedWithoutNotes.length > 0) {
                        const list = after.finalizedWithoutNotes.slice(0, 10).join('、')
                        const more = after.finalizedWithoutNotes.length > 10
                            ? `等 ${after.finalizedWithoutNotes.length} 章` : ''
                        throw new Error(
                            `生成期间第 ${list}${more} 章变成了已定稿但还没有章节要点。`
                            + `这份大纲没见过那几章写了什么，已作废——`
                            + `请等它们的「定稿后处理」写出要点后重新生成`
                        )
                    }
                    // 同理复核「要点属于上一版」：生成期间用户完全可以重新定稿某一章，
                    // 那一刻 notes 还是旧的，digest 也没变（notes 原文没动）
                    if (after.finalizedWithStaleNotes.length > 0) {
                        const list = after.finalizedWithStaleNotes.slice(0, 10).join('、')
                        const more = after.finalizedWithStaleNotes.length > 10
                            ? `等 ${after.finalizedWithStaleNotes.length} 章` : ''
                        throw new Error(
                            `生成期间第 ${list}${more} 章被重新定稿，其章节要点已不属于当前正文。`
                            + `这份大纲已作废——请等新要点写出后重新生成`
                        )
                    }

                    callbacks.log('已生成，结果已填入「本卷大纲」，点「保存」才会写入数据库')
                    return '待确认'
                },
            },
        ],
        onComplete: { mode: 'silent', message: '✅ 本卷大纲已重新生成，请确认后保存' },
        // 必须走本通道：context.data 在工作流完成时被销毁，而 startWorkflow
        // 在销毁之后才返回 runId（同 volume-workflow 的 collectResult 说明）
        collectResult: (context): RegenerateVolumeResult => ({
            volumeNumber,
            synopsis: context.data.synopsis as string,
            capturedToken,
        }),
    }
}

/**
 * 找出当前正在跑的「重新生成本卷大纲」运行 id。
 *
 * ⚠️ 存在的理由：`startWorkflow()` **完成之后**才返回 runId，
 * 而「停止生成」必须在它跑着的时候就能点。故只能反过来从 `activeRuns` 里按类型找。
 *
 * 本流程是 single-flight 的（由 `volume-regen-store` 的占位保证），
 * 故同一时刻至多一条，取第一条即可。
 */
export function findActiveRegenRunId(): string | null {
    return useWorkflowStore.getState().activeRuns
        .find(r => r.type === VOLUME_REGEN_WORKFLOW_TYPE)?.id ?? null
}

/**
 * volume-workflow — 续写下一卷（Phase 19 / Task 19.2b）
 *
 * ## 设计要点：前三步零副作用
 *
 * 工作流分四步，**只有第 4 步写库**。前三步（盘点 / 提炼收束 / 生成卷大纲）全部
 * 只在 `context.data` 里累积候选数据——因为用户可能在第 4 步的预览对话框里点「取消」。
 * 若探查阶段就建首卷、删孤儿蓝图，取消后会留下「蓝图已删 / 第一卷已建但续卷未提交」
 * 的半状态，且无回滚入口。
 *
 * ## 惰性建卷的三段契约
 *
 * `inspectFirstVolume()`（只读探查，主进程）→ `buildFirstVolumeDraft()`（纯函数构造）
 * → `commitNextVolume()`（单次事务提交）。契约显式定义，不靠隐式 context 传递，
 * 否则本模块与 19.4 的对话框会各猜各的 payload 形状。
 *
 * ## token 纪律
 *
 * 续卷跨越两次 LLM 调用（分钟级）。token **必须在工作流第一次 await 之前捕获**，
 * 再显式传给提交调用；在写入时才取会让 A 项目的延迟回调带着已切到 B 的 token
 * 通过校验，把整套结构数据写进另一个项目库。
 */
import { useWorkflowStore, type WorkflowDefinition } from '../../stores/workflow-store'
import { MAX_VOLUME_CHAPTERS } from '../../shared/volume-limits'
import { useProjectStore } from '../../stores/project-store'
import { getProjectToken, useVolumeStore } from '../../stores/volume-store'
import { ipc } from '../ipc-client'
import { globalEventBus } from '../../shared/event-bus'
import { getLastVolume } from '../volume-service'
import { DEFERRED_LLM_LOGS_KEY, WORKFLOW_TOKEN_KEY, type DeferredLLMLog } from './commands/base-command'
import { readCharacterStates, readVolumeChapterNotes } from '../prompts/volume-context'
import type { VolumeData } from '../../../electron/repositories/volume-repository'
import type {
    CommitNextVolumePayload,
    FirstVolumeGuard,
    FirstVolumeInspection,
    OrphanPolicy,
} from '../../../electron/repositories/volume-commit'

// 策略类型的**唯一定义**在主进程侧（提交事务要按它分支）。此处再导出一次，
// 让 UI 层继续从 volume-workflow 取，不必直接引 electron/ 路径
export type { OrphanPolicy }

export interface NextVolumeParams {
    /** 作者对本卷的意图；可留空，留空时由 AI 完全推演 */
    userIntent: string
    /** 故事模型 key，与 getPlotStructureGuide 的 case 对应 */
    structure: string
    /** 本卷章数 */
    chapterCount: number
    pacingGuidance?: string
    /** 惰性建卷时用户对孤儿蓝图的选择；无孤儿时为 undefined */
    orphanPolicy?: OrphanPolicy
}

/** AI 提炼出的上一卷收束结果 */
export interface ClosingReport {
    volumeNumber: number
    closingState: string
    openThreads: Array<{ chapter: number; thread: string; urgency: 'high' | 'mid' | 'low' }>
}

/** 步骤 3 产出、供预览对话框编辑的新卷草案 */
export interface DraftVolume {
    title: string
    premise: string
    synopsis: string
    suggestedChapterCount: number
}

/**
 * 由首卷探查结果 + 用户选定的策略，**纯函数**构造首卷候选。不写库。
 *
 * - `extend`：把孤儿蓝图那段一并归入首卷 → `endChapter = maxBlueprint`
 * - `clear` / `keep`：首卷止于已定稿最大章号 → `endChapter = maxFinalized`
 *   （`clear` 的删除动作交给第 4 步的事务，本函数不删）
 */
export function buildFirstVolumeDraft(
    base: NonNullable<FirstVolumeInspection['firstVolumeBase']>,
    policy: OrphanPolicy | undefined,
): VolumeData {
    return {
        volumeNumber: 1,
        title: '第一卷',
        startChapter: 1,
        // extend 取两者最大值：蓝图末章可能小于已定稿最大章号（用户删过蓝图 / 老项目导入），
        // 直接取 maxBlueprint 会让首卷止于已定稿之前，新卷区间与已写正文错位，
        // 而 VolumeRepository 的区间校验只查重叠与 end≥start，会放行不报错
        endChapter: policy === 'extend'
            ? Math.max(base.maxBlueprint, base.maxFinalized)
            : base.maxFinalized,
        premise: '',
        synopsis: base.synopsis,
        openingState: '',
        closingState: '',
        openThreads: [],
        status: 'done',
    }
}

/** 续卷工作流交给预览 UI 的产物。经 `takeWorkflowResult(runId)` 取走 */
export interface NextVolumeWorkflowResult {
    prevVolume: VolumeData
    /** 惰性建卷时的首卷草案 + 提交凭据；已有卷时为 undefined。两者必须成对 */
    firstVolume?: { draft: VolumeData; guard: FirstVolumeGuard }
    closingReport: ClosingReport
    draftVolume: DraftVolume
    /** 工作流发起时捕获的项目 token，提交时必须原样传回 */
    capturedToken: number
    /** 延迟未写的 llm_calls 统计，确认落库后 flush、取消则丢弃 */
    deferredLLMLogs: DeferredLLMLog[]
}

/** 从 workflow store 取走续卷产物（取走即释放）。无产物返回 null */
export function takeNextVolumeResult(runId: string): NextVolumeWorkflowResult | null {
    const r = useWorkflowStore.getState().takeWorkflowResult(runId)
    return (r as NextVolumeWorkflowResult | null) ?? null
}

/** 用户在预览里取消：丢弃产物，延迟统计随之作废（零副作用） */
export function discardNextVolumeResult(runId: string): void {
    useWorkflowStore.getState().discardWorkflowResult(runId)
}

export function createNextVolumeWorkflow(params: NextVolumeParams): WorkflowDefinition {
    // ⚠️ 在任何 await 之前捕获 token（见文件头「token 纪律」）
    const capturedToken = getProjectToken()
    // 无 token 说明根本没打开项目。若放行，主进程会走 expectedToken===undefined 分支
    // 返回 stale:true，UI 显示「项目已切换」——与真实原因不符，用户照提示重试也没用
    if (capturedToken === undefined) throw new Error('未打开项目，无法续卷')
    // 章数校验前置：非法值会先烧掉两次 LLM 调用，最后才在仓储层失败。
    // ⚠️ `isSafeInteger` 而非 `isInteger`——`Number.isInteger(1e21)` 为真，
    // 而 `1e21 + 1 === 1e21`，章号运算会静默丢精度。UI 那道只是第一道，
    // Agent 或将来的其它调用方绕不开这里
    if (!Number.isSafeInteger(params.chapterCount) || params.chapterCount < 1) {
        throw new Error(`本卷章数非法：${params.chapterCount}（须为 ≥1 的安全整数）`)
    }
    // 上限同样前置。仓储层那道是最后防线，但它在两次分钟级 LLM **之后**才执行——
    // 用户输 20000 会白等几分钟才被告知超限
    if (params.chapterCount > MAX_VOLUME_CHAPTERS) {
        throw new Error(`本卷章数 ${params.chapterCount} 超过上限 ${MAX_VOLUME_CHAPTERS}`)
    }

    return {
        type: 'volume',
        title: '📚 续写下一卷',
        steps: [
            {
                name: '盘点上一卷',
                description: '读取上一卷的实际写作要点、角色当前状态与已登记伏笔',
                executor: async (_step, context, callbacks) => {
                    const project = useProjectStore.getState().currentProject
                    if (!project) throw new Error('未打开项目')

                    // 把起点 token 钉进 context：后续两次 callLLM 与命令内的读取
                    // 都以它为准核对，而不是各自现取当前 token（见 WORKFLOW_TOKEN_KEY）
                    context.data[WORKFLOW_TOKEN_KEY] = capturedToken

                    const volumes = await ipc.invoke('db:volume-get-all')
                    let prevVolume = getLastVolume(volumes)
                    let firstVolume: { draft: VolumeData; guard: FirstVolumeGuard } | undefined

                    if (!prevVolume) {
                        // 零卷 → 惰性建卷（只探查，不写库）
                        callbacks.log('尚未分卷，正在探查首卷边界...')
                        const insp: FirstVolumeInspection = await ipc.invoke('db:volume-inspect-first')
                        if (!insp.needsFirstVolume || !insp.firstVolumeBase) {
                            throw new Error('首卷探查失败，请重试')
                        }
                        if (insp.firstVolumeBase.maxFinalized === 0) {
                            throw new Error('尚无定稿章节，先写完至少一章再续卷')
                        }
                        const draft = buildFirstVolumeDraft(insp.firstVolumeBase, params.orphanPolicy)
                        prevVolume = draft
                        // 发现孤儿却没选策略 → 直接终止。继续跑会形成「既不 clear、
                        // 也不注入 keep、也不 extend」的三不像状态：蓝图既没删、
                        // 新卷大纲也不知道它们存在，生成出来必然冲突。
                        if (insp.orphan && !params.orphanPolicy) {
                            throw new Error(
                                `第 ${insp.orphan.startChapter}–${insp.orphan.endChapter} 章存在 ${insp.orphan.count} 条未写的旧蓝图，` +
                                `请先在对话框中选择处置方式（清除 / 保留 / 扩展首卷边界）`
                            )
                        }
                        // 凭据**无条件构造**，且按判别联合分派——「探查时没有孤儿」
                        // 也是个要自证的结论（kind:'none'），生成期间新建的蓝图
                        // 只能靠事务里的 maxBlueprint 复核发现。孤儿存在时必须走
                        // kind:'orphan' 分支带上策略与快照（三种策略都要，不只 clear）。
                        const base = {
                            maxFinalized: insp.firstVolumeBase.maxFinalized,
                            maxBlueprint: insp.firstVolumeBase.maxBlueprint,
                        }
                        firstVolume = {
                            draft,
                            guard: (insp.orphan && params.orphanPolicy)
                                ? { kind: 'orphan', policy: params.orphanPolicy, snapshot: insp.orphan, ...base }
                                : { kind: 'none', ...base },
                        }

                        // keep 策略下新卷必须覆盖整个孤儿区间，否则 Spec §4.11「保留旧蓝图，
                        // 新卷大纲须兼容」根本无法兑现：区间外的蓝图既不注入 prompt
                        //（模型不知道它们存在、写出的大纲必然冲突），落库后又不属于任何卷。
                        // 必须在两次 LLM 调用**之前**拦下——事后才发现，成本已经烧掉了。
                        if (insp.orphan && params.orphanPolicy === 'keep') {
                            const newVolumeEnd = draft.endChapter + params.chapterCount
                            if (newVolumeEnd < insp.orphan.endChapter) {
                                throw new Error(
                                    `选择「保留旧蓝图」时，本卷需要覆盖到第 ${insp.orphan.endChapter} 章` +
                                    `（旧蓝图末章），当前设置只到第 ${newVolumeEnd} 章。` +
                                    `请把本卷章数从 ${params.chapterCount} 提高到至少 ` +
                                    `${insp.orphan.endChapter - draft.endChapter} 章，` +
                                    `或改选「清除」/「扩展首卷边界」`
                                )
                            }
                        }
                        callbacks.log(
                            `首卷候选：第 1–${draft.endChapter} 章` +
                            (insp.orphan ? `（孤儿蓝图 ${insp.orphan.count} 条，策略：${params.orphanPolicy ?? '未选'}）` : '')
                        )
                    }

                    // ⚠️ 这里要拦**两类**都在两次 LLM 调用之前，且它们是不同的问题：
                    //
                    // ① **章号越界**：末章不是安全整数 → 后续所有章号加减都会静默出错。
                    // ② **上一卷区间超长**：端点全都安全、派生末章也安全，但上一卷本身
                    //    跨了几千万亿章。老库里可能存在这种卷（区间上限是本 Task 才加的，
                    //    也可能来自外部导入）。工作流会拿它的区间去盘点要点、
                    //    最后还会把它 upsert 回去——upsert 那一步会被仓储层拒绝，
                    //    但那已经是两次分钟级 LLM 之后了。
                    //
                    // 反例（②，只验 ① 时会漏）：`start=1, end=MAX_SAFE_INTEGER-10001,
                    // chapterCount=1` —— 末章与派生末章都是安全整数，照样放行。
                    const derivedEnd = prevVolume.endChapter + params.chapterCount
                    if (!Number.isSafeInteger(prevVolume.endChapter) || !Number.isSafeInteger(derivedEnd)) {
                        throw new Error(
                            `新卷章号越界：上一卷止于第 ${prevVolume.endChapter} 章，` +
                            `再加 ${params.chapterCount} 章超出可精确表示的范围`
                        )
                    }
                    const prevSpan = prevVolume.endChapter - prevVolume.startChapter + 1
                    // 上下界**都要验**。只拦「太长」会漏掉零长度与反向区间
                    // （`start=2, end=1` → span 为 0，端点全是安全整数），
                    // 那种卷同样会跑完两次 LLM、最后在回写上一卷时才被仓储层拒绝
                    if (
                        !Number.isSafeInteger(prevVolume.startChapter)
                        || prevVolume.startChapter < 1
                        || prevSpan < 1
                        || prevSpan > MAX_VOLUME_CHAPTERS
                    ) {
                        throw new Error(
                            `「${prevVolume.title}」的章号区间异常：第 ${prevVolume.startChapter}–${prevVolume.endChapter} 章` +
                            `（共 ${prevSpan} 章，合法范围 1–${MAX_VOLUME_CHAPTERS}）。` +
                            `请先在卷详情里修正它的边界，再续下一卷`
                        )
                    }

                    callbacks.log(`读取「${prevVolume.title}」第 ${prevVolume.startChapter}–${prevVolume.endChapter} 章的实际要点...`)
                    const chapterNotes = await readVolumeChapterNotes(prevVolume.startChapter, prevVolume.endChapter)
                    const characterStates = await readCharacterStates()

                    context.data.prevVolume = prevVolume
                    context.data.firstVolume = firstVolume
                    context.data.closingInput = { chapterNotes, characterStates }

                    return `已盘点第 ${prevVolume.startChapter}–${prevVolume.endChapter} 章（${chapterNotes.length} 字要点）`
                },
            },
            {
                name: '提炼收卷状态与伏笔',
                description: 'AI 从实际写作结果提炼上一卷收束状态与未回收伏笔清单',
                executor: async (_step, context, callbacks) => {
                    const { ExtractClosingReportCommand } = await import('./commands/volume-closing.command')
                    const report = await new ExtractClosingReportCommand().execute({ step: _step, context, callbacks })
                    context.data.closingReport = report
                    return `收卷状态已提炼，未回收伏笔 ${report.openThreads.length} 条`
                },
            },
            {
                name: '生成本卷大纲',
                description: 'AI 基于上一卷收束结果推演下一卷主线与卷内大纲',
                executor: async (_step, context, callbacks) => {
                    const { GenerateVolumeSynopsisCommand } = await import('./commands/volume-synopsis.command')
                    const draft = await new GenerateVolumeSynopsisCommand(params).execute({ step: _step, context, callbacks })
                    context.data.draftVolume = draft
                    return `已生成「${draft.title}」大纲（${draft.synopsis.length} 字）`
                },
            },
            {
                name: '等待确认写入',
                description: '生成结果交由预览对话框确认，用户确认后才落库',
                executor: async (_step, context, callbacks) => {
                    // 本步不写库。把 token 与候选数据留给 UI，由 commitNextVolume 完成提交。
                    context.data.capturedToken = capturedToken
                    callbacks.log('已生成，等待你在预览中确认后写入')
                    return '待确认'
                },
            },
        ],
        onComplete: { mode: 'silent', message: '✅ 本卷大纲已生成，请在预览中确认' },
        // 把产物交给预览 UI。必须走本通道——context.data 在工作流完成时被销毁，
        // WORKFLOW_COMPLETE 只携带 { type }，startWorkflow 又在销毁之后才返回 runId
        collectResult: (context): NextVolumeWorkflowResult => ({
            prevVolume: context.data.prevVolume as VolumeData,
            firstVolume: context.data.firstVolume as NextVolumeWorkflowResult['firstVolume'],
            closingReport: context.data.closingReport as ClosingReport,
            draftVolume: context.data.draftVolume as DraftVolume,
            capturedToken,
            deferredLLMLogs: (context.data[DEFERRED_LLM_LOGS_KEY] as DeferredLLMLog[] | undefined) ?? [],
        }),
    }
}

/**
 * 提交续卷 —— 单次事务性 IPC。
 *
 * @param capturedToken 工作流发起时捕获的 token，**不可在此处现取**
 */
export async function commitNextVolume(
    payload: CommitNextVolumePayload,
    capturedToken: number | undefined,
    deferredLLMLogs: DeferredLLMLog[] = [],
): Promise<{ success: boolean; error?: string }> {
    try {
        const res = await ipc.invoke('db:volume-commit-next', payload, capturedToken)
        if (!res.success) {
            return { success: false, error: res.stale ? '项目已切换，本次续卷未写入' : res.error }
        }

        // 续卷在主进程事务里直接改了 project_core，revision 已 +1。
        // 必须同步回来：否则用户随后在小说配置里点保存，会带着续卷之前的版本号
        // 撞 CAS，看到的是"保存失败"而不是"续卷成功"。
        // 与下面的别名同步一样，先核对 token——这段跑在 await 之后，项目可能已切换。
        if (getProjectToken() === capturedToken && res.coreRevision !== undefined) {
            useProjectStore.setState({ coreRevision: res.coreRevision })
        }

        // 主进程已在事务内落库 project_core。渲染层这里只同步内存别名、不再发持久化 IPC——
        // 否则用户随后在小说配置编辑器点保存，saveProject 会用陈旧的 coreOutline
        // 把刚提交的卷大纲覆盖掉（vela-protocol.ts 注释所述的坑）。
        // 同步前再核对 token：这段代码跑在 await 之后，项目可能已切换。
        if (
            getProjectToken() === capturedToken &&
            res.totalChapters !== undefined &&
            res.synopsis !== undefined
        ) {
            const store = useProjectStore.getState()
            const storeNow = store.currentProject?.novelConfig.coreOutline ?? ''

            // 判据是「内存 store 是否仍等于**库内追加前的原值**」。
            //
            // ⚠️ 不能改用「提交前后各读一次 store」：两次读都发生在两次 LLM 调用**之后**，
            // 用户在生成期间做的编辑对两次读都可见、结果相等，会被判成「没改过」而整串覆盖，
            // 恰好漏掉唯一真正危险的那个窗口。
            if (storeNow === (res.previousSynopsis ?? '')) {
                // persisted:true —— 这两个值就是主进程事务刚写进库的，内存与库一致。
                // 登记成脏会让用户下一次保存把它们再发一遍，还把「有没有未保存改动」搅浑
                store.updateNovelConfig(
                    { totalChapters: res.totalChapters, coreOutline: res.synopsis },
                    { persisted: true })
            } else {
                // store 已偏离 → 用户有未保存的编辑。
                // 把新卷段落追加到**用户当前的文本**上，而不是丢弃任何一边：
                // 若只同步 totalChapters、让用户自己去保存，saveProject 会把这份
                // 不含新卷段的 coreOutline 整串写回库，反向抹掉刚提交的新卷——
                // 那正是这段代码要防的 lost update，只是换了个方向发生。
                const section = res.appendedSection ?? payload.newVolumeSection
                const merged = storeNow.trim()
                    ? `${storeNow.trim()}\n\n---\n\n${section}`.trim()
                    : section.trim()
                // 分开登记：`totalChapters` 已由事务持久化（persisted），
                // 而 merged 的 coreOutline 是内存里独有的合并结果、库里没有 → 必须是脏，
                // 否则用户不点保存它就永远回不去库里
                store.updateNovelConfig({ totalChapters: res.totalChapters }, { persisted: true })
                store.updateNovelConfig({ coreOutline: merged })
                console.warn('[volume-workflow] 情节大纲在生成期间被编辑过，已将新卷段落合并到你的版本')
                globalEventBus.emit('SYSTEM_NOTICE', {
                    level: 'warn',
                    message:
                        '新卷已写入。检测到你在生成期间修改过情节大纲，已把新卷段落追加到你的版本上——' +
                        '请到小说配置里保存一次，让它与数据库一致。',
                })
            }
        }

        // 提交发生在本渲染进程发起的 IPC 链路里，成功后直接刷新权威卷表。
        // 这里不走 EventBus：它只会增加一层异步间接调用，也无法让主进程与
        // 渲染进程共享同一个内存事件实例。切项目后则由新项目自己的打开流程加载。
        if (getProjectToken() === capturedToken) {
            await useVolumeStore.getState().loadAll()
        }

        // 延迟的 llm_calls 统计在此 flush：取消预览则永不执行，落实「取消 = 零副作用」。
        // 带 capturedToken 防止统计写进已切换的另一个项目库。
        //
        // 必须 await：fire-and-forget 会让本函数在统计真正落库前就返回，
        // 用户紧接着切项目或退出就丢了统计，且面板不会刷新。
        // 也刻意**不**放进主进程那个事务——统计是可有可无的附属数据，
        // 让它的写入失败去回滚已经确认的整卷内容，代价与收益完全不成比例。
        if (deferredLLMLogs.length > 0) {
            const flushed = await Promise.all(deferredLLMLogs.map(entry =>
                ipc.invoke('db:log-llm-call', { ...entry }, capturedToken)
                    .then(r => r?.success === true)
                    .catch(() => false)
            ))
            const ok = flushed.filter(Boolean).length
            if (ok > 0) globalEventBus.emit('LLM_CALL_LOGGED', { success: true })
            if (ok < deferredLLMLogs.length) {
                console.warn(`[volume-workflow] ${deferredLLMLogs.length - ok} 条模型调用统计写入失败（不影响已落库的新卷）`)
            }
        }

        return { success: true }
    } catch (err) {
        return { success: false, error: String(err) }
    }
}

/** 供预览对话框组装 payload：把草案与上下文拼成提交载荷 */
export function buildCommitPayload(
    ctx: {
        prevVolume: VolumeData
        firstVolume?: { draft: VolumeData; guard: FirstVolumeGuard }
        closingReport: ClosingReport
    },
    edited: DraftVolume,
    chapterCount: number,
): CommitNextVolumePayload {
    const startChapter = ctx.prevVolume.endChapter + 1
    const endChapter = startChapter + chapterCount - 1
    // 防御性复核：本函数是**导出**的，除续卷预览外将来可能有别的调用方。
    // 仓储层现在也验安全整数与区间上限（Task 19.4 收紧过），但那是**落库时**——
    // 而本函数的返回值会先被拿去拼 prompt、发给模型。让非法章号走到那一步，
    // 用户白等两次分钟级调用才在提交时被拒
    if (!Number.isSafeInteger(startChapter) || !Number.isSafeInteger(endChapter) || endChapter < startChapter) {
        throw new Error(`新卷章号非法：第 ${startChapter}–${endChapter} 章（越界或区间为空）`)
    }
    const newVolume: VolumeData = {
        volumeNumber: ctx.prevVolume.volumeNumber + 1,
        title: edited.title,
        startChapter,
        endChapter,
        premise: edited.premise,
        synopsis: edited.synopsis,
        openingState: ctx.closingReport.closingState,
        closingState: '',
        // 把上一卷的未回收伏笔**结转进新卷**，新卷台账自此成为唯一权威。
        //
        // 早先这里是 `[]`，靠读取时临时合并上一卷来兜——那是错的，且错两次：
        // ① **断链**：续 V3 时收卷提炼只读 V2 的台账，V2 若是空的，
        //    V1 留下、V2 未处理的伏笔就永久丢失（模板明令「要点没提到的一律视为不存在」）；
        // ② **复活**：V2 已确认回收并写成空清单后，重新生成 V2 目录时
        //    合并又会把 V1 的旧条目捞回来，AI 被要求回收一条已经回收过的伏笔。
        // 结转之后，「尚未继承」与「已全部回收」才在数据上可区分。
        // 上一卷保留自己那份历史快照不动，供回溯。
        openThreads: ctx.closingReport.openThreads,
        status: 'planned',
    }
    return {
        firstVolume: ctx.firstVolume,
        closingReport: ctx.closingReport,
        newVolume,
        // 只传新增段落。整份 synopsis 由主进程在事务内读改写——
        // 渲染层持有的是两次 LLM 调用之前的快照，整串回写会吞掉用户期间对大纲的编辑
        newVolumeSection: `## ${edited.title}\n\n${edited.premise}\n\n${edited.synopsis}`,
    }
}

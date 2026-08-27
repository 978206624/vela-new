/**
 * volume-flow — 「续写下一卷」的**发起**逻辑
 *
 * 与对话框组件分开成文件，有三个理由：
 * ① 侧栏、总览页等入口只想「发起流程」，不该为此依赖一整棵对话框组件树；
 * ② 组件文件混着导出普通函数会破坏 React Fast Refresh（eslint 会报）；
 * ③ 这里的分支判定（要不要弹孤儿处置、首卷边界取哪个值）是**可测的纯逻辑**，
 *    留在组件里就只能靠人工点。
 *
 * 对话框的挂载与后续阶段在 `components/dialogs/NextVolumeFlow.tsx`。
 *
 * ## 为什么这里不弹 toast
 *
 * 服务层报错一律走**返回值**，由调用方决定怎么呈现。两个原因：
 * - `toast` 要碰 `document`，把它写进服务层等于让这段逻辑只能在浏览器里跑；
 * - 更要紧的是**通知失败不该改变控制流**——Task 19.5 已经栽过一次
 *   （toast 的动态 import 抛错被外层 catch 吞掉，把 conflict 变成了 error）。
 *
 * ## 归属校验
 *
 * 每个 await 之后都要 `isCurrentFlow(actionToken, flowId, getProjectToken())`。
 * token 单独一道挡不住「同项目内重复发起」：两次点击的 token 相同，
 * 第一次的回包照样能覆盖第二次。
 *
 * 过期后是否 reset，取决于 `ownsFlowState`——见 `stale()` 上的说明。
 */
import { create } from 'zustand'
import { ipc } from './ipc-client'
import { getProjectToken } from '../stores/volume-store'
import { useVolumeFlowStore, nextFlowId, isCurrentFlow, ownsFlowState } from '../stores/volume-flow-store'
import { getLastVolume } from './volume-service'
import {
  buildCommitPayload,
  commitNextVolume,
  type NextVolumeWorkflowResult,
  type DraftVolume,
  type ClosingReport,
} from './workflows/volume-workflow'

/**
 * 本次流程的**发起 token 与实例号**。与 stage 分开存，是因为它们不参与渲染，
 * 且必须在 `startNextVolumeFlow()` 的第一行、任何 await 之前写入。
 */
const useFlowRun = create<{
  token: number | undefined
  flowId: number
  set: (token: number | undefined, flowId: number) => void
}>((set) => ({ token: undefined, flowId: 0, set: (token, flowId) => set({ token, flowId }) }))

/** 读取本次流程的发起 token。后续阶段（生成、提交）一律以它为准复核 */
export const getFlowToken = (): number | undefined => useFlowRun.getState().token
/** 读取本次流程的实例号 */
export const getFlowId = (): number => useFlowRun.getState().flowId

/**
 * 发起结果。**`ok:false` 不一定要报给用户**——`project-switched` 是用户
 * 自己切走的，弹个错反而莫名其妙；调用方按 reason 分派。
 */
export type StartFlowResult =
  | { ok: true; stage: 'wizard' | 'orphan' }
  | {
    ok: false
    reason: 'no-project' | 'busy' | 'project-switched' | 'no-finalized' | 'inspect-failed'
    message: string
  }

/**
 * 发起续卷流程。**入口第一行捕获 token 与实例号**，随后的探查都是 await。
 *
 * 成功时把流程推进到 `wizard` 或 `orphan`；失败时把流程收回 `idle` 并返回原因。
 */
export async function startNextVolumeFlow(): Promise<StartFlowResult> {
  const actionToken = getProjectToken()
  if (actionToken === undefined) {
    return { ok: false, reason: 'no-project', message: '未打开项目' }
  }

  const flow = useVolumeFlowStore
  // single-flight：已有流程在跑时拒绝再发起。
  // 不拦的话，第二次点击会把第一次的向导/预览顶掉，而第一次那条
  // 已经领到的工作流产物没人去 discard，库里留下孤儿统计
  if (flow.getState().stage !== 'idle') {
    return { ok: false, reason: 'busy', message: '已有续卷流程正在进行' }
  }

  const flowId = nextFlowId()
  useFlowRun.getState().set(actionToken, flowId)
  flow.setState({
    stage: 'inspecting',
    projectToken: actionToken,
    flowId,
    orphan: null,
    orphanPolicy: undefined,
    result: null,
  })

  /**
   * 过期任务的统一出口。**善后取决于 store 还归不归我**：
   * - 不归我了（用户又发起了一次 / 项目关闭已作废）→ 什么都别动
   * - 仍归我、只是项目切走了 → 必须 reset，否则 store 永久停在 `inspecting`，
   *   single-flight 会从此拒绝一切新流程
   */
  const stale = (): StartFlowResult => {
    if (ownsFlowState(actionToken, flowId)) flow.getState().reset()
    return { ok: false, reason: 'project-switched', message: '项目已切换，本次续卷已取消' }
  }

  try {
    const volumes = await ipc.invoke('db:volume-get-all')
    if (!isCurrentFlow(actionToken, flowId, getProjectToken())) return stale()

    const prev = getLastVolume(volumes)

    if (prev) {
      // 已有卷：直接进向导。孤儿蓝图只在惰性建卷（零卷）时才是个问题——
      // 已有卷的项目，末卷之后的蓝图属于「还没写到」，不是无主的
      flow.setState({
        stage: 'wizard',
        prevTitle: prev.title,
        prevEndChapter: prev.endChapter,
        prevChapterCount: prev.endChapter - prev.startChapter + 1,
      })
      return { ok: true, stage: 'wizard' }
    }

    // 零卷 → 惰性建卷，先探查首卷边界
    const insp = await ipc.invoke('db:volume-inspect-first')
    if (!isCurrentFlow(actionToken, flowId, getProjectToken())) return stale()

    if (!insp.needsFirstVolume || !insp.firstVolumeBase) {
      flow.getState().reset()
      return { ok: false, reason: 'inspect-failed', message: '首卷探查失败，请重试' }
    }

    const base = insp.firstVolumeBase
    if (base.maxFinalized === 0) {
      // 必须拦在这里：放进工作流要先烧两次分钟级 LLM 调用才失败
      flow.getState().reset()
      return { ok: false, reason: 'no-finalized', message: '尚无定稿章节，先写完至少一章再续卷' }
    }

    if (insp.orphan) {
      flow.setState({
        stage: 'orphan',
        orphan: { ...insp.orphan, maxFinalized: base.maxFinalized },
        // 首卷末章要等策略选定才最终确定（extend 会把边界推到蓝图末章），
        // 这里先按「已定稿最大章号」摆好，选完策略再由对话框回调修正
        prevTitle: '第一卷',
        prevEndChapter: base.maxFinalized,
        prevChapterCount: base.maxFinalized,
      })
      return { ok: true, stage: 'orphan' }
    }

    flow.setState({
      stage: 'wizard',
      prevTitle: '第一卷',
      prevEndChapter: base.maxFinalized,
      prevChapterCount: base.maxFinalized,
    })
    return { ok: true, stage: 'wizard' }
  } catch (e) {
    // 异常路径同样要先确认归属：不归我了就别动（会误杀新流程）；
    // 仍归我就得 reset，哪怕项目已经切走——留个 inspecting 在那儿谁都别想再发起
    if (!ownsFlowState(actionToken, flowId)) {
      // 归属已丢失（项目切了 / 用户又发起了一次）。这类「异常」的成因是用户
      // 自己的操作，报 `inspect-failed` 会让 VolumeGroup 在新界面上弹
      // 「续卷准备失败」——一句莫名其妙的错误。按 project-switched 静默处理
      return { ok: false, reason: 'project-switched', message: '项目已切换，本次续卷已取消' }
    }
    flow.getState().reset()
    // 归属仍在但项目已切走时，同样按 project-switched 静默
    if (getProjectToken() !== actionToken) {
      return { ok: false, reason: 'project-switched', message: '项目已切换，本次续卷已取消' }
    }
    return { ok: false, reason: 'inspect-failed', message: `续卷准备失败：${e}` }
  }
}

/**
 * 提交结果。`stale` 意味着**这条流程已经不归调用方管**——
 * 调用方什么都别做，包括不弹 toast：那条消息属于上一个项目/上一条流程。
 */
export type ConfirmFlowResult =
  | { ok: true; volumeNumber: number }
  | { ok: false; reason: 'stale' }
  | { ok: false; reason: 'failed'; message: string }

/**
 * 确认并写入新卷。
 *
 * 从组件里抽出来，理由同 `startNextVolumeFlow`：这段有**两处 await 后的归属判定**，
 * 留在组件里就只能靠人工点。
 *
 * ## 为什么提交阶段也要归属守卫
 *
 * 提交不是一次原子调用：事务返回后还要 flush 延迟统计、重拉卷表。
 * 期间 A 项目可能被关掉、B 项目打开并发起新流程——那时无条件 reset
 * 会把 B 刚起的流程无声关掉。主进程的 token 守卫挡的是**串库**，
 * 挡不住旧 React 回调改写模块级 store。
 */
export async function confirmNextVolume(args: {
  result: NextVolumeWorkflowResult
  chapterCount: number
  edited: DraftVolume
  /** 用户在预览里改过的收卷报告，不是 AI 那份原始产物 */
  editedReport: ClosingReport
}): Promise<ConfirmFlowResult> {
  const { result, chapterCount, edited, editedReport } = args
  // 归属键在**点击「确认并写入」的这一刻**捕获
  const actionToken = getFlowToken()
  const flowId = getFlowId()

  try {
    const payload = buildCommitPayload(
      // ⚠️ 用**用户编辑过**的收卷报告。它决定两件事：新卷的开卷状态、
      // 以及结转进新卷台账的伏笔清单——用户补录/删改的伏笔只有走这条路才进得去
      { prevVolume: result.prevVolume, firstVolume: result.firstVolume, closingReport: editedReport },
      edited,
      chapterCount,
    )
    // ⚠️ 用工作流**发起时**捕获的 token，不是现取的。工作流跑了几分钟，
    // 其间切出去再切回来，现取的 token 已经不是同一个了
    const res = await commitNextVolume(payload, result.capturedToken, result.deferredLLMLogs)

    // ⚠️ **不在这里重拉卷表**。`commitNextVolume` 返回之前就发了
    // `REFRESH_RESOURCE({resources:['volumes']})`，`ProjectService` 的监听会调
    // `useVolumeStore.loadAll()`。这里再拉一次是重复刷新——同一次续卷两趟 IPC，
    // 而且那条事件驱动的刷新**不受本流程归属判定管辖**，
    // 想靠这里的判定「阻止 stale 后重拉」是做不到的。
    // 事件那条自带 token 守卫（`loadAll` 内部有 token + 序号双重竞态守卫），
    // 串不到别的项目去。
    if (!ownsFlowState(actionToken, flowId)) return { ok: false, reason: 'stale' }
    if (!res.success) return { ok: false, reason: 'failed', message: res.error || '续卷写入失败' }

    useVolumeFlowStore.getState().reset()
    return { ok: true, volumeNumber: result.prevVolume.volumeNumber + 1 }
  } catch (e) {
    if (!ownsFlowState(actionToken, flowId)) return { ok: false, reason: 'stale' }
    return { ok: false, reason: 'failed', message: `续卷写入失败：${e}` }
  }
}


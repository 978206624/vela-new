/**
 * volume-flow-store — 「续写下一卷」向导的流程状态机
 *
 * ## 为什么要单独一个 store
 *
 * 这条流程横跨三个对话框（孤儿处置 → 参数向导 → 结果预览），中间还夹着一次
 * 分钟级的工作流。触发入口不止一处：侧栏「分卷」分组的 `+`、分卷总览页的
 * 「续写下一卷」按钮（Task 19.4 后续批次），未来还可能有 Agent 工具。
 * 把状态挂在某个组件里，就得靠 props 层层透传，且入口组件卸载会打断流程。
 *
 * ## 归属：projectToken + flowId
 *
 * ⚠️ **给组件加 `key={projectToken}` 挡不住串扰**——那只重建组件的本地 state，
 * 模块级 store 原封不动。A 项目停在 `preview` 时切到 B，B 一进来就读到 A 的
 * stage 与 result；更糟的是 A 那些还在飞的异步回包会无条件写状态，
 * 把 B 刚发起的流程关掉或覆盖掉。
 *
 * 所以每次发起都记下**两个归属键**：
 * - `projectToken`：这条流程属于哪个项目
 * - `flowId`：单调递增的实例号，区分同一项目内的前后两次发起
 *
 * 任何 await 之后要写状态的地方，都必须先判归属。注意**两种「过期」的善后相反**：
 * - `ownsFlowState` 为假（别人接管了）→ 什么都别动，动了就误杀新流程；
 * - 归属仍在、只是项目切走了 → **必须 reset**，否则 store 永久停在中间态，
 *   single-flight 会从此拒绝一切新流程。
 *
 * ## 状态机
 *
 * ```
 * idle ──start()──► inspecting ──有孤儿──► orphan ──选定策略──┐
 *                       │                                     │
 *                       └──无孤儿 / 已有卷────────────────────┤
 *                                                             ▼
 *                                                          wizard
 *                                                             │ 提交
 *                                                             ▼
 *                                                         generating
 *                                                             │ 工作流完成
 *                                                             ▼
 *                                                          preview
 *                                                             │ 确认写入
 *                                                             ▼
 *                                                           idle
 * ```
 *
 * 任何一步取消都回 `idle`，且 `preview` 阶段取消要**丢弃工作流产物**
 * （见 `discardNextVolumeResult`）——那是「取消 = 零副作用」承诺的一部分。
 */
import { create } from 'zustand'
import type { OrphanPolicy } from '../../electron/repositories/volume-commit'
import type { NextVolumeWorkflowResult } from '../services/workflows/volume-workflow'

/** 孤儿蓝图对话框要展示的区间与条数（来自 `db:volume-inspect-first`） */
export interface OrphanInfo {
  startChapter: number
  endChapter: number
  count: number
  /** 首卷若按「已定稿最大章号」定界，末章是第几章——文案要用 */
  maxFinalized: number
}

export type VolumeFlowStage =
  | 'idle'
  /** 正在查卷表 / 探查首卷边界（很快，一般看不到） */
  | 'inspecting'
  | 'orphan'
  | 'wizard'
  /** 工作流跑着，对话框全部关闭，进度由全局工作流面板展示 */
  | 'generating'
  | 'preview'

interface VolumeFlowState {
  stage: VolumeFlowStage
  /** 本次流程归属的项目 token。`null` = 无流程 */
  projectToken: number | null
  /** 本次流程的实例号，单调递增。区分同一项目内的前后两次发起 */
  flowId: number
  /** 上一卷末章；向导用它算新卷区间。零卷惰性建卷时是首卷草案的末章 */
  prevEndChapter: number
  /** 上一卷卷名，向导的承接说明要用；零卷时为「第一卷」 */
  prevTitle: string
  /** 上一卷章数，用作本卷章数的默认值 */
  prevChapterCount: number
  /** 仅零卷且探查到孤儿时有值 */
  orphan: OrphanInfo | null
  /** 用户在孤儿对话框里选的策略；无孤儿时保持 undefined */
  orphanPolicy: OrphanPolicy | undefined
  /** 工作流产物，`preview` 阶段有值 */
  result: NextVolumeWorkflowResult | null

  setStage: (stage: VolumeFlowStage) => void
  reset: () => void
}

const INITIAL = {
  stage: 'idle' as VolumeFlowStage,
  projectToken: null,
  flowId: 0,
  prevEndChapter: 0,
  prevTitle: '',
  prevChapterCount: 0,
  orphan: null,
  orphanPolicy: undefined,
  result: null,
}

export const useVolumeFlowStore = create<VolumeFlowState>((set) => ({
  ...INITIAL,
  setStage: (stage) => set({ stage }),
  // reset 把 flowId 一并归 0 是安全的：归属校验还要比 `projectToken`，
  // 而它此刻已是 null，任何过期回包都过不了。
  // **真正承重的是模块级发号器 `flowSeq` 从不回退**——它保证已用过的实例号
  // 不会被第二条流程领到（否则旧回包就能冒充新流程）。
  reset: () => set({ ...INITIAL }),
}))

/** 模块级实例号发号器 */
let flowSeq = 0

/** 领取一个新的流程实例号 */
export function nextFlowId(): number {
  return ++flowSeq
}

/**
 * store 里的流程**是不是这个任务的**（归属键完全一致）。
 *
 * ⚠️ 与「项目有没有切走」是**两件事**，必须分开判——早先合成一个判断，
 * 结果切项目时任务直接 return 而不 reset，store 永久停在 `inspecting`，
 * single-flight 从此拒绝一切新流程。
 *
 * 两者的善后完全相反：
 * - **不归我了**（别人接管）→ 什么都别动，动了就误杀新流程
 * - **仍归我、但项目切了** → 必须 reset，否则没人来收这个烂摊子
 */
export function ownsFlowState(projectToken: number | undefined, flowId: number): boolean {
  const s = useVolumeFlowStore.getState()
  return s.projectToken === projectToken && s.flowId === flowId
}

/**
 * 判断某个异步任务是否仍是「当前这条流程」——归属一致**且**项目没切走。
 * 用于「能不能继续往下走」的判定；要决定「该不该 reset」请用 `ownsFlowState`。
 */
export function isCurrentFlow(
  projectToken: number | undefined,
  flowId: number,
  currentProjectToken: number | undefined,
): boolean {
  return ownsFlowState(projectToken, flowId) && currentProjectToken === projectToken
}

/**
 * 项目关闭时作废当前流程。由 `onProjectClosed` 统一调用。
 *
 * 不这么做的话，A 的向导会原样出现在 B 的界面上——而里面的
 * 「承接第二卷（截至第 160 章）」说的是 A 的卷。
 */
export function invalidateVolumeFlow(): void {
  useVolumeFlowStore.setState({ ...INITIAL })
}

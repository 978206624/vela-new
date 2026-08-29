/**
 * volume-regen-store — 「重新生成本卷大纲」的运行状态（Phase 19 / Task 19.4 T3）
 *
 * ## 为什么必须是模块级 store，而不是 VolumeEditor 的组件 state
 *
 * `EditorArea` 只渲染**当前活动 Tab**，切走就卸载卷详情编辑器。而这次生成是
 * 分钟级的：用户完全可能「点了重新生成 → 切去看章节蓝图 → 过一会儿切回来」。
 * 状态若在组件里，切走的那一刻流式预览、停止按钮、以及**等着 `startWorkflow`
 * 返回的那个 await** 全都随实例一起消失；回包跑在旧实例的闭包里，
 * 它改不动当前挂载的那一个（Task 19.4 T2 已经为同一条道理把草稿收进
 * [volume-draft-store] 了）。
 *
 * ## 归属键：projectToken + volumeNumber + regenId
 *
 * - `projectToken`：A 项目的生成结果不能落进 B 项目的表单；
 * - `volumeNumber`：第 2 卷的结果不能落进第 3 卷的表单；
 * - `regenId`：单调递增的实例号。前两个都相同时，它区分**同一卷的前后两次生成**——
 *   没有它，第一次的延迟回包能冒充第二次的结果。
 *   发号器 `regenSeq` **从不回退**，`reset()` 也不动它。
 *
 * ## single-flight
 *
 * 同一时刻只允许一条重生成在跑（`begin()` 已有 run 时返回 `null`）。
 * 不是 per-volume 而是**全局**一条：两条并发跑着，「停止生成」就得先回答
 * 「停哪一条」，而设计稿 30 的头部只有一个按钮。
 *
 * ## 结果为什么留着不清
 *
 * `result` 由卷详情编辑器在渲染期采纳（把 synopsis 灌进文本框），而采纳发生在
 * **渲染阶段**——那里不能写 store。故采纳后不清空：组件自己记住「已采纳到哪个
 * regenId」，重新挂载时按当前 regenId 初始化游标，不会二次采纳。
 * 真正承载「未保存的编辑」的是 [volume-draft-store] 里的草稿，由服务层在
 * 生成成功时写入——本 store 的 `result` 只是一个「有新结果了」的信号。
 */
import { create } from 'zustand'

/** 一次正在进行的重生成 */
export interface VolumeRegenRun {
  projectToken: number
  volumeNumber: number
  /** 本次发起的实例号，单调递增 */
  regenId: number
  /** 已解转义的大纲正文，供打字机预览（不是原始 JSON 串） */
  partial: string
  /** 本次生成使用的模型显示名，头部副信息要显示（设计稿 30：「模型 claude-opus-5」） */
  modelName: string
}

/**
 * 一次已完成、**草稿已落地**、等待卷详情表单显示出来的结果。
 *
 * 生命周期：service 在成功时写草稿并 settle 一条 result → 卷详情组件挂载时
 * 把它灌进 Textarea（判据是「草稿里的 synopsis 与本条 result 相同」，
 * 不是「表单脏不脏」——后者在草稿已落地时恒为脏，拿它当门会永远进不来）
 * → 用户点「保存」成功、或关闭 Tab 放弃 → `discardResult` 清掉。
 *
 * 它**不承载内容**（内容在草稿里），只承载「这份大纲是 AI 刚生成的、还没保存」
 * 这个事实——头部副信息与第四段步进器都靠它。
 */
export interface VolumeRegenResult {
  regenId: number
  projectToken: number
  volumeNumber: number
  /** AI 重新生成的卷大纲，**尚未落库**。与草稿里那份逐字相同，用于组件比对 */
  synopsis: string
}

interface VolumeRegenState {
  run: VolumeRegenRun | null
  /**
   * 待显示的结果，按 `projectToken:volumeNumber` 归属**分槽存放**。
   *
   * ⚠️ 曾经是单个 `result` 槽，那是错的：`begin()` 已经不清别卷的结果了，
   * 但 `settle()` 仍会把整个槽换掉——第 2 卷生成完留着不保存，接着对第 1 卷
   * 生成并完成，第 2 卷那份就被顶掉了。完成态提示随之消失，
   * `discardVolumeRegenResultForTab` 也再定位不到它（Codex round-03 major #1）。
   *
   * 归属键必须带 token，与 [volume-draft-store] 的草稿键同款：
   * 只用卷序号的话，A 项目第 2 卷的结果会在打开 B 项目时冒出来。
   */
  results: Record<string, VolumeRegenResult>

  /**
   * 抢占并开始一次重生成。已有一条在跑时返回 `null`（single-flight）。
   * 返回本次的 `regenId`，后续所有写入都要带着它核对。
   *
   * ⚠️ **不**顺手清掉别卷的待显示结果：卷 A 的结果可能还挂在 store 里
   * （用户切去看别处、还没保存）。无脑清等于把那份稿子从内存里抹掉。
   * 结果按卷分槽存放，采纳与丢弃由 `adoptResult` / `discardResult` 显式做。
   *
   * Codex round-02 major #2 + round-03 major #1。
   */
  begin: (projectToken: number, volumeNumber: number, modelName: string) => number | null
  /**
   * 显式采纳某条待显示结果——**只清那一槽**，不做别的。
   *
   * ⚠️ 与 `discardResult` 行为完全相同，分成两个名字是为了让调用点自证意图
   * （保存成功 vs 放弃关闭）。合成一个 `clearResult` 会让「这条结果去哪了」
   * 在读代码时说不清。
   *
   * 按 **regenId** 定位而不是按卷号：regenId 唯一且不回退，
   * 用它才能保证「清掉的是我看到的那一条」，而不是同一卷刚生成的下一条。
   *
   * @returns `true` 表示确实清掉了一条；`false` 表示没有匹配的槽
   *          （过期回包 / 已被另一条路径清掉）。
   */
  adoptResult: (regenId: number) => boolean
  /** 丢弃某条待显示结果。典型场景：关闭 Tab 时用户选了「放弃修改」 */
  discardResult: (regenId: number) => boolean
  /** 写入流式预览片段。`regenId` 不匹配当前 run 时静默丢弃（过期回包） */
  setPartial: (regenId: number, partial: string) => void
  /**
   * 结束本次生成。`synopsis` 为 `null` 表示失败 / 被停止 —— 此时**不产生结果**，
   * 表单保持原样（Product-Spec §4.11：停止 = 零改动）。
   *
   * 成功时的 `synopsis` 必须与 service 刚写进草稿的那一份**逐字相同**：
   * 组件靠这个相等关系判断「草稿里那份大纲是不是本条结果」。
   *
   * 结果落进 `results[projectToken:volumeNumber]` 那一槽，**不影响别卷的槽**。
   *
   * `regenId` 不匹配当前 run 时整体丢弃：那是上一次生成的延迟回包，
   * 让它落地会把用户刚发起的这一次顶掉。
   */
  settle: (regenId: number, synopsis: string | null) => void
  /** 项目关闭 / 切换时清空。发号器不回退，故旧回包仍然进不来 */
  reset: () => void
}

/** 结果分槽的归属键。与 [volume-draft-store] 的 `draftKey` 同款 */
function resultKey(projectToken: number, volumeNumber: number): string {
  return `${projectToken}:${volumeNumber}`
}

/** 模块级实例号发号器。**从不回退**——`reset()` 也不动它 */
let regenSeq = 0

export const useVolumeRegenStore = create<VolumeRegenState>((set, get) => ({
  run: null,
  results: {},

  begin: (projectToken, volumeNumber, modelName) => {
    if (get().run !== null) return null
    const regenId = ++regenSeq
    // ⚠️ 不动 `results`：别卷的待显示结果还在那儿，无脑清等于把它从内存抹掉。
    // 同一卷若已有一条待显示结果，它会在下面 settle 时被本次替换——那是对的，
    // 用户刚为同一卷重新生成了一遍，旧的那份就是要被换掉的
    set({ run: { projectToken, volumeNumber, regenId, partial: '', modelName } })
    return regenId
  },

  adoptResult: (regenId) => {
    const entry = Object.entries(get().results).find(([, r]) => r.regenId === regenId)
    if (!entry) return false
    set(s => {
      const next = { ...s.results }
      delete next[entry[0]]
      return { results: next }
    })
    return true
  },

  discardResult: (regenId) => {
    // 与 adoptResult 同一实现：分开只为让调用点自证意图（见接口注释）
    return get().adoptResult(regenId)
  },

  setPartial: (regenId, partial) => {
    const run = get().run
    if (!run || run.regenId !== regenId) return
    set({ run: { ...run, partial } })
  },

  settle: (regenId, synopsis) => {
    const run = get().run
    if (!run || run.regenId !== regenId) return
    if (synopsis === null) {
      set({ run: null })
      return
    }
    // 只写**本卷那一槽**，别卷的待显示结果原封不动（round-03 major #1）
    const key = resultKey(run.projectToken, run.volumeNumber)
    set(s => ({
      run: null,
      results: {
        ...s.results,
        [key]: {
          regenId,
          projectToken: run.projectToken,
          volumeNumber: run.volumeNumber,
          synopsis,
        },
      },
    }))
  },

  reset: () => set({ run: null, results: {} }),
}))

/**
 * 取当前这一卷的重生成运行态；不是这一卷（或没有运行）返回 `null`。
 *
 * ⚠️ 不能写成 zustand selector 直接返回新对象——v5 的 selector 必须返回稳定引用，
 * 每次造新对象会导致无限重渲染。故本函数只做**过滤**，返回的是 store 里那个原对象。
 */
export function selectRegenRunFor(
  state: VolumeRegenState,
  projectToken: number | undefined,
  volumeNumber: number,
): VolumeRegenRun | null {
  const run = state.run
  if (!run) return null
  if (run.projectToken !== projectToken || run.volumeNumber !== volumeNumber) return null
  return run
}

/**
 * 同上，取本卷待显示的结果。
 *
 * 直接按键取那一槽——`results[key]` 是 store 里的原对象、引用稳定，
 * 满足 zustand v5「selector 不能返回新对象」的要求。
 */
export function selectRegenResultFor(
  state: VolumeRegenState,
  projectToken: number | undefined,
  volumeNumber: number,
): VolumeRegenResult | null {
  if (projectToken === undefined) return null
  return state.results[resultKey(projectToken, volumeNumber)] ?? null
}

/**
 * 关闭卷详情 Tab 时丢弃它的待显示结果。
 *
 * 与 `discardVolumeDraftForTab` 成对：草稿被「放弃修改并关闭」清掉后，
 * 若 result 还留着，重开 Tab 会让那份已被放弃的 AI 大纲**复活**——
 * 组件的判据是「草稿里的 synopsis 等于 result」，而重开时草稿已没了、
 * 判据不成立，于是它变成一个永远显示「已重新生成」却什么都没有的幽灵态。
 *
 * 由 `editor-store.closeTab` 统一调用（关闭路径有五条，各自记得清一遍迟早漏一条）。
 */
export function discardVolumeRegenResultForTab(tabId: string, projectToken: number | undefined): void {
  const m = /^volume:(\d+)$/.exec(tabId)
  if (!m) return
  if (projectToken === undefined) return
  const key = resultKey(projectToken, Number(m[1]))
  const r = useVolumeRegenStore.getState().results[key]
  if (!r) return
  useVolumeRegenStore.getState().discardResult(r.regenId)
}

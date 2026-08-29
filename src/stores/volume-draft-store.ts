/**
 * volume-draft-store — 卷详情编辑器的**共享编辑状态**（Phase 19 / Task 19.4）
 *
 * 这里存的四样东西都必须是共享的（按 `projectToken:volumeNumber` 归属），
 * 每一样都是被具体缺陷逼出来的：
 *
 * ① **草稿内容**。`EditorArea` 只渲染当前活动 Tab，切走就卸载组件。
 *    表单状态若只在本地 state 里，「写了半卷大纲 → 切去看一眼章节蓝图 → 切回来」
 *    编辑就没了，且没有任何提示。
 * ② **`touched`（本次改过哪些字段）**。保存只提交这些列——`status` 由末章定稿
 *    自动流转、`openThreads` 由续卷事务写入，而表单一变脏就拒绝同步后台刷新，
 *    「字段在界面上」不等于「用户看到的是最新值」。整表提交会静默撤销后台结果。
 * ③ **逐字段的编辑戳**。回包时要判「这个字段自发起保存以来有没有再被改过」。
 *    用整卷一个版本号是不够的：保存 `openThreads` 的途中改了 `synopsis`，
 *    整卷版本就变了，于是**已经成功落库的 `openThreads` 也得不到确认**、
 *    继续留在 `touched` 里；等后台把 `openThreads` 更新掉，用户再保存 `synopsis` 时
 *    那份旧值会跟着一起提交，把后台结果覆盖掉。
 * ④ **保存占用（single-flight）**。`saving` 若是组件本地 state，
 *    保存在途切走再切回会换出一个 `saving=false` 的新实例，保存按钮重新可用，
 *    同一份旧 patch 可以被提交两次；两次事务之间若有后台写入，第二次就会覆盖它。
 *
 * 共通的道理：**任何跨 await 的善后都不能绑在组件实例上**——
 * 回包跑在旧实例的闭包里，它改不动当前挂载的那个。
 *
 * ## 归属键
 *
 * key 是 `${projectToken}:${volumeNumber}`，**必须带 token**。
 * 只用卷序号的话，A 项目第 2 卷的草稿会在打开 B 项目时冒出来盖住 B 的第 2 卷。
 * `projectToken` 为 undefined（无项目）时一律不存：那时没有任何卷可编辑。
 *
 * ## 生命周期
 *
 * - 保存成功且所有 touched 字段都得到确认 → `acknowledgeSave` 内部清草稿
 * - 关闭 Tab（含「放弃修改并关闭」）→ `editor-store.closeTab` 统一 `clear()`
 * - 项目关闭 → `project-service.onProjectClosed()` 调 `reset()`
 */
import { create } from 'zustand'
import type { VolumeStatus, OpenThread, VolumeData } from '../../electron/repositories/volume-repository'

/** 卷详情里**用户可改**的字段。边界两端合成一项：重叠校验需要成对提交 */
export type VolumeDetailField =
  | 'title'
  | 'boundary'
  | 'premise'
  | 'synopsis'
  | 'openingState'
  | 'status'
  | 'openThreads'

/** 各字段最近一次被编辑时的戳。缺席表示本次编辑从没碰过它 */
export type FieldStamps = Partial<Record<VolumeDetailField, number>>

/** 一份未保存的卷详情草稿。章号存**原始输入字符串**，理由见 VolumeEditor 内注释 */
export interface VolumeDraft {
  title: string
  startRaw: string
  endRaw: string
  status: VolumeStatus
  premise: string
  synopsis: string
  openingState: string
  /** 带 UI 行身份的伏笔行 */
  threads: Array<OpenThread & { _id: string }>
  /** 各伏笔行章号输入框的原始文本，按行 id 存 */
  threadChapterInputs: Record<string, string>
  /** 下一个可用的行 id 序号 */
  nextThreadId: number
  /** 本次编辑实际触碰过的字段。只有这些列会被提交 */
  touched: VolumeDetailField[]
}

/** 保存占用。`id` 用于只让**发起它的那次**回包释放占用 */
interface SaveLease {
  id: number
}

interface VolumeDraftState {
  drafts: Record<string, VolumeDraft>
  /** 每卷的单调计数器，逐字段戳都取自它 */
  counters: Record<string, number>
  /** 每卷各字段最近一次编辑的戳 */
  stamps: Record<string, FieldStamps>
  /** 每卷的保存占用 */
  leases: Record<string, SaveLease>

  get: (projectToken: number | undefined, volumeNumber: number) => VolumeDraft | null
  set: (projectToken: number | undefined, volumeNumber: number, draft: VolumeDraft) => void
  clear: (projectToken: number | undefined, volumeNumber: number) => void

  /** 记一次字段编辑：计数器 +1 并把新值盖到该字段上 */
  markTouched: (projectToken: number | undefined, volumeNumber: number, field: VolumeDetailField) => void
  /**
   * 把 AI 重新生成的卷大纲落成一份草稿（Task 19.4 T3）。
   *
   * 以**卷行快照**为基线重建整份草稿，只把 `synopsis` 换成生成结果、
   * 只把 `synopsis` 记进 `touched`——于是用户点「保存」时的 patch 里只有大纲一列，
   * 卷名/边界/状态/伏笔一概不动（Product-Spec §4.11：产物只有卷大纲一项）。
   *
   * ## 为什么可以直接以卷行快照为基线、不必与既有草稿合并
   *
   * 发起重生成的前置条件是**表单必须干净**（见 `volume-regen.ts`），
   * 干净就意味着此刻没有草稿、表单显示的就是卷行。
   *
   * ⚠️ **已有草稿时拒绝采纳**——这是 Codex round-01 major finding：
   * 生成期间用户可能在另一处修改了其它字段（理论上已被表单锁定，但若
   * `disabled`/`readOnly` 因任何理由失效，组件仍能写草稿），无条件重建会
   * 静默吞掉那些编辑。故**只在该卷此刻无草稿时**才落库。
   *
   * @returns `true` 表示成功落地，`false` 表示拒绝（已存在草稿或无 token）
   *
   * ⚠️ 本方法**不管 Tab 脏标**。那是 `editor-store` 的事，由调用方一并处理；
   * 本 store 不引 editor-store，免得两个 store 互相依赖。
   */
  adoptGeneratedSynopsis: (
    projectToken: number | undefined,
    volume: VolumeData,
    synopsis: string,
  ) => boolean
  /** 取各字段当前的编辑戳快照（保存发起时定格） */
  getStamps: (projectToken: number | undefined, volumeNumber: number) => FieldStamps

  /**
   * 抢保存占用。已被占用返回 `null`，否则返回本次的租约 id。
   * 这是 single-flight 的唯一入口——组件实例可能换，占用不能跟着换。
   */
  beginSave: (projectToken: number | undefined, volumeNumber: number) => number | null
  /** 释放占用。只有 id 匹配的那次回包才释放得掉 */
  endSave: (projectToken: number | undefined, volumeNumber: number, leaseId: number) => void
  /** 当前是否有保存在途 */
  isSaving: (projectToken: number | undefined, volumeNumber: number) => boolean

  /**
   * 保存成功后逐字段确认。
   *
   * 只把「自 `stampsAtSave` 定格以来**没有再被改过**」的字段从 `touched` 里摘掉；
   * 保存期间又改过的字段继续留着，等下一次保存。全部摘完（`touched` 空了）
   * 才清掉整份草稿。
   *
   * @returns `true` 表示草稿已被清空（调用方据此把 Tab 脏标也清掉）
   */
  acknowledgeSave: (
    projectToken: number | undefined,
    volumeNumber: number,
    savedFields: readonly VolumeDetailField[],
    stampsAtSave: FieldStamps,
  ) => boolean

  reset: () => void
}

/** 归属键。token 缺失时返回 null——无项目时什么都不存 */
function draftKey(projectToken: number | undefined, volumeNumber: number): string | null {
  if (projectToken === undefined) return null
  return `${projectToken}:${volumeNumber}`
}

let leaseSeq = 0

export const useVolumeDraftStore = create<VolumeDraftState>((set, get) => ({
  drafts: {},
  counters: {},
  stamps: {},
  leases: {},

  get: (projectToken, volumeNumber) => {
    const key = draftKey(projectToken, volumeNumber)
    return key ? get().drafts[key] ?? null : null
  },

  set: (projectToken, volumeNumber, draft) => {
    const key = draftKey(projectToken, volumeNumber)
    if (!key) return
    set(s => ({ drafts: { ...s.drafts, [key]: draft } }))
  },

  clear: (projectToken, volumeNumber) => {
    const key = draftKey(projectToken, volumeNumber)
    if (!key) return
    set(s => {
      if (!(key in s.drafts)) return {}
      const next = { ...s.drafts }
      delete next[key]
      return { drafts: next }
    })
  },

  markTouched: (projectToken, volumeNumber, field) => {
    const key = draftKey(projectToken, volumeNumber)
    if (!key) return
    set(s => {
      const next = (s.counters[key] ?? 0) + 1
      return {
        counters: { ...s.counters, [key]: next },
        stamps: { ...s.stamps, [key]: { ...s.stamps[key], [field]: next } },
      }
    })
  },

  getStamps: (projectToken, volumeNumber) => {
    const key = draftKey(projectToken, volumeNumber)
    return key ? { ...(get().stamps[key] ?? {}) } : {}
  },

  adoptGeneratedSynopsis: (projectToken, volume, synopsis) => {
    const key = draftKey(projectToken, volume.volumeNumber)
    if (!key) return false
    // 已有草稿 → 拒绝：用户此刻在改别的字段，无条件重建会静默覆盖。
    // round-01 major 的兜底，理论上 UI 已锁定全部控件，但锁可以被绕开
    if (get().drafts[key] !== undefined) return false
    const threads = (volume.openThreads ?? []).map((t, i) => ({ ...t, _id: `t${i}` }))
    const draft: VolumeDraft = {
      title: volume.title,
      // 章号存**原始字符串**，与 VolumeEditor 的表单模型同款（理由见该组件注释）
      startRaw: String(volume.startChapter),
      endRaw: String(volume.endChapter),
      status: volume.status,
      premise: volume.premise ?? '',
      synopsis,
      openingState: volume.openingState ?? '',
      threads,
      threadChapterInputs: {},
      nextThreadId: threads.length,
      // 只有大纲被改过。这一项决定了保存时 patch 里有哪几列
      touched: ['synopsis'],
    }
    set(s => ({ drafts: { ...s.drafts, [key]: draft } }))
    // 打戳走 `markTouched` 而不是自己写：逐字段确认（`acknowledgeSave`）比对的
    // 就是这个戳，另起一套写法迟早与它分叉
    get().markTouched(projectToken, volume.volumeNumber, 'synopsis')
    return true
  },

  beginSave: (projectToken, volumeNumber) => {
    const key = draftKey(projectToken, volumeNumber)
    if (!key) return null
    if (get().leases[key]) return null
    const id = ++leaseSeq
    set(s => ({ leases: { ...s.leases, [key]: { id } } }))
    return id
  },

  endSave: (projectToken, volumeNumber, leaseId) => {
    const key = draftKey(projectToken, volumeNumber)
    if (!key) return
    set(s => {
      // 只有持有这次租约的回包才释放得掉。否则「A 释放了 B 的占用」会让
      // single-flight 形同虚设
      if (s.leases[key]?.id !== leaseId) return {}
      const next = { ...s.leases }
      delete next[key]
      return { leases: next }
    })
  },

  isSaving: (projectToken, volumeNumber) => {
    const key = draftKey(projectToken, volumeNumber)
    return key ? get().leases[key] !== undefined : false
  },

  acknowledgeSave: (projectToken, volumeNumber, savedFields, stampsAtSave) => {
    const key = draftKey(projectToken, volumeNumber)
    if (!key) return false
    const draft = get().drafts[key]
    if (!draft) return true   // 已经被别的路径清掉了（如关闭 Tab），视作干净

    const now = get().stamps[key] ?? {}
    // 「自发起保存以来没再被改过」= 当前戳与定格时相同
    const stillPending = draft.touched.filter(
      f => !(savedFields.includes(f) && now[f] === stampsAtSave[f]),
    )

    if (stillPending.length === 0) {
      set(s => {
        const next = { ...s.drafts }
        delete next[key]
        return { drafts: next }
      })
      return true
    }
    set(s => ({ drafts: { ...s.drafts, [key]: { ...draft, touched: stillPending } } }))
    return false
  },

  reset: () => set({ drafts: {}, counters: {}, stamps: {}, leases: {} }),
}))

/**
 * 关闭卷详情 Tab 时丢弃它的草稿。
 *
 * 由 `editor-store.closeTab` 统一调用——关闭路径有五条（单个关闭、⌘W、
 * 关闭其他、关闭右侧、关闭所有），各自记得清一遍迟早漏一条，
 * 而漏掉的那条会让「放弃修改并关闭」变成假的：内容还在，重开就复活。
 */
export function discardVolumeDraftForTab(tabId: string, projectToken: number | undefined): void {
  const m = /^volume:(\d+)$/.exec(tabId)
  if (!m) return
  useVolumeDraftStore.getState().clear(projectToken, Number(m[1]))
}

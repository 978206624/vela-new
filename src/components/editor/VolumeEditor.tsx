/**
 * VolumeEditor — 卷详情编辑器（设计稿 29）
 *
 * 左主区：卷名 / 起始章 / 结束章 / 状态 / 本卷主线 / 本卷大纲
 * 右轨 360px：开卷状态 + 未回收伏笔台账（可增删改）
 *
 * ## 为什么开卷状态也可编辑
 *
 * DEV-PLAN 原文写的是「开卷状态**只读**框」，但 Product-Spec §4.11 的界面条目
 * 明确要求卷详情的七项「**全部可手改**」，且开卷状态与伏笔清单同源——
 * 都是 AI 对上一卷的**判断**，而判断恰恰最容易错。它会经 `getVolumeCompass()`
 * 注入正文写作的「本卷罗盘」，错一句就一路错下去。故此处按 Spec 做成可编辑，
 * 与 `VolumePreviewDialog` 右栏同口径（那里也是「AI 对上一卷的判断必须能改」）。
 *
 * ## 未保存的编辑必须活过标签页切换
 *
 * `EditorArea` 只渲染**当前活动 Tab**，切走就卸载本组件。表单状态若只在本地
 * state 里，用户「写了半卷大纲 → 切去看一眼章节蓝图 → 切回来」就会发现编辑没了，
 * 且没有任何提示。故每次编辑都写一份草稿到 `volume-draft-store`
 * （按 `projectToken:volumeNumber` 归属），并把 Tab 标脏——后者还顺带让
 * 关闭 Tab / ⌘W / 批量关闭的既有未保存确认对本编辑器生效。
 *
 * 三样东西**只能有一份、且必须是共享的**：草稿内容、编辑版本号、
 * 「触碰过哪些字段」。它们都住在 `volume-draft-store`，组件只从中派生
 * `dirty` / `touched`。放本地会让「保存在途 → 切走 → 切回 → 回包」时，
 * 善后跑在已卸载的旧实例上，当前实例留着过期的 `touched`，
 * 下一次保存就把旧字段二次提交（见下面 `dirty` 处的注释）。
 *
 * ## 后台刷新不许覆盖未保存的编辑
 *
 * `volume-store.loadAll()` 会被 `REFRESH_RESOURCE` 事件驱动（续卷提交、定稿
 * 触发的卷状态流转都会发），而它每次都先把 status 打回 `loading`。
 * 故两道：① 顶层分支「有卷就渲染表单」优先于看 status，不让加载态卸载表单；
 * ② 表单内用「渲染期调整 state」在**不脏时**才同步库里的新值。
 *
 * ## token 纪律
 *
 * 保存与删除都在**动作入口、第一个 await 之前**捕获 token 并显式传给 store 方法；
 * await 回来后还要再核一次才动 UI。中途现取会拿到切换后那个项目的**合法** token，
 * 主进程守卫看不出异常。
 */
import { useState, useId, useMemo } from 'react'
import { Layers, Save, Trash2, Plus, RefreshCw } from 'lucide-react'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Label } from '../ui/Label'
import { Select } from '../ui/Select'
import { Textarea } from '../ui/Textarea'
import { toast } from '../ui/Toast'
import { confirm } from '../ui/Confirm'
import { useVolumeStore, getProjectToken } from '../../stores/volume-store'
import { useVolumeDraftStore, type VolumeDraft, type VolumeDetailField } from '../../stores/volume-draft-store'
import { useDraftStore } from '../../stores/draft-store'
import { useEditorStore } from '../../stores/editor-store'
import {
  VOLUME_STATUS_LABELS,
  buildVolumeSavePayload,
  canDeleteVolume,
  canEditVolumeBoundary,
  countFinalizedInRange,
  decideVolumeSnapshotSync,
} from '../../services/volume-service'
import { volumeTabId } from '../../services/volume-tabs'
import {
  MAX_OPEN_THREADS,
  parseChapterNumber,
  validateOpenThreads,
  validateVolumeRange,
} from '../../shared/volume-limits'
import type { VolumeData, VolumeStatus, OpenThread } from '../../../electron/repositories/volume-repository'

const STATUS_OPTIONS = (Object.keys(VOLUME_STATUS_LABELS) as VolumeStatus[])
  .map(v => ({ value: v, label: VOLUME_STATUS_LABELS[v] }))

const URGENCY_OPTIONS = [
  { value: 'high', label: '高' },
  { value: 'mid', label: '中' },
  { value: 'low', label: '低' },
]

/** 表单里的伏笔行。`_id` 是**行身份**，不落库 */
type ThreadRow = OpenThread & { _id: string }

interface Props {
  /** 来自 Tab 的卷序号。缺失说明 Tab 数据不完整（不该发生），如实报错而不是空白 */
  volumeNumber?: number
}

export default function VolumeEditor({ volumeNumber }: Props) {
  const volumes = useVolumeStore(s => s.volumes)
  const status = useVolumeStore(s => s.status)

  const volume = useMemo(
    () => (volumeNumber === undefined ? null : volumes.find(v => v.volumeNumber === volumeNumber) ?? null),
    [volumes, volumeNumber],
  )

  if (volumeNumber === undefined) {
    return <CenterNotice text="这个标签页缺少卷序号，无法定位到具体的卷。请从侧栏重新打开。" />
  }
  /**
   * ⚠️ 分支顺序是「**有卷就渲染表单**」优先，不是「先看 status」。
   *
   * `volume-store.loadAll()` 每次都先 `set({status:'loading'})`，而它会被
   * 续卷提交、定稿的卷状态流转、以及**本编辑器自己的保存**触发。
   * 若先判 `status !== 'ready'` 就整页替换成「加载中」，`VolumeForm` 会被卸载，
   * 用户没保存的编辑随之消失——而这恰恰是最容易发生的时刻。
   *
   * 保持挂载是安全的：`loadAll` 读失败时**保留旧 volumes**，只有项目关闭的
   * `reset()` 才清空，而那时 Tab 已经被 `onProjectClosed` 一并清掉了。
   *
   * 「这一卷已不存在」仍然只在 `status === 'ready'` 时才说得出口——
   * 未就绪时的空数组只代表「还没读到」，把它说成「已删除」是假消息。
   */
  if (volume) {
    // key：卷换了就整体重建表单，免得把 A 卷的未保存编辑带到 B 卷
    return <VolumeForm key={volume.volumeNumber} volume={volume} volumes={volumes} />
  }
  if (status !== 'ready') {
    return <CenterNotice text={status === 'error' ? '分卷数据读取失败，请重新打开项目后重试。' : '正在加载分卷数据…'} />
  }
  return <CenterNotice text={`第 ${volumeNumber} 卷已不存在（可能已被删除）。可以关闭这个标签页。`} />
}

function CenterNotice({ text }: { text: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3" style={{ color: 'var(--color-text-muted)' }}>
      <Layers size={36} style={{ opacity: 0.4 }} />
      <span className="text-sm">{text}</span>
    </div>
  )
}

function VolumeForm({ volume, volumes }: { volume: VolumeData; volumes: VolumeData[] }) {
  const uid = useId()
  const updateDetail = useVolumeStore(s => s.updateDetail)
  const removeOne = useVolumeStore(s => s.removeOne)

  /**
   * 已有的未保存草稿。初始化时**优先用它**——`EditorArea` 只渲染当前活动 Tab，
   * 切走再切回会让本组件卸载重建；只从 `volume` 初始化的话，用户的编辑就没了。
   *
   * ⚠️ 只在**首次挂载**读一次（`useState` 的惰性初值），之后草稿由本组件单向写出。
   * 每次渲染都读会把 store 当成真值源，与本地 state 打架。
   */
  const projectToken = getProjectToken()
  const restored = useState(() => useVolumeDraftStore.getState().get(projectToken, volume.volumeNumber))[0]

  const [title, setTitle] = useState(restored?.title ?? volume.title)
  const [status, setStatus] = useState<VolumeStatus>(restored?.status ?? volume.status)
  const [premise, setPremise] = useState(restored?.premise ?? volume.premise ?? '')
  const [synopsis, setSynopsis] = useState(restored?.synopsis ?? volume.synopsis ?? '')
  const [openingState, setOpeningState] = useState(restored?.openingState ?? volume.openingState ?? '')
  /**
   * 章号存**原始字符串**，不存数字。
   * 只存解析后的数字的话，用户敲到一半的 `1.` 会被解析成 NaN 再回填，
   * 把他正在敲的内容抹掉（与 `VolumePreviewDialog` 的伏笔章号同款）。
   */
  const [startRaw, setStartRaw] = useState(restored?.startRaw ?? String(volume.startChapter))
  const [endRaw, setEndRaw] = useState(restored?.endRaw ?? String(volume.endChapter))

  /**
   * 下一个可用的伏笔行 id。用**递增计数器**而非 `threads.length`——
   * 后者删完再加会撞号，而撞号会让 React 复用错误的行、把章号原始文本串到别的伏笔上。
   *
   * 存 state 而不是 ref：下面的「渲染期同步」要重置它，而渲染期读写 ref 是被禁止的
   * （React 的 refs 不参与渲染，渲染期改它会让组件不按预期更新）。
   */
  const [nextThreadId, setNextThreadId] = useState(
    restored?.nextThreadId ?? (volume.openThreads ?? []).length,
  )
  const [threads, setThreads] = useState<ThreadRow[]>(
    () => restored?.threads ?? (volume.openThreads ?? []).map((t, i) => ({ ...t, _id: `t${i}` })),
  )
  const [threadChapterInputs, setThreadChapterInputs] = useState<Record<string, string>>(
    restored?.threadChapterInputs ?? {},
  )


  /**
   * `dirty` 与 `touched` **不放组件本地 state**，直接从共享草稿 store 派生。
   *
   * 放本地会产生一个跨实例的竞态：保存在途时切走再切回会换一个新实例，
   * 而回包善后（清 dirty / 清 touched）跑在**旧实例**的闭包里——它能清掉
   * 共享草稿与 Tab 脏标，却清不动当前这个实例的 state。结果是
   * 「组件显示未保存、Tab 显示已保存、草稿已经没了」三者不一致；
   * 更糟的是当前实例仍握着旧的 `touched`，用户为了消掉那个「未保存」再点一次保存，
   * 就把已经保存过的旧 `openThreads` 二次提交，覆盖后台期间写入的新清单——
   * 正是本批次一直在堵的那类静默覆盖。
   *
   * 收口成「草稿在 = 脏」之后，谁清的草稿都一样：当前挂载的实例会随
   * store 订阅一起变干净，然后由下一次渲染 adopt 最新快照。
   */
  const draftStoreKey = projectToken === undefined ? null : `${projectToken}:${volume.volumeNumber}`
  const draft = useVolumeDraftStore(s => (draftStoreKey === null ? undefined : s.drafts[draftStoreKey]))
  const dirty = draft !== undefined
  const touched: VolumeDetailField[] = draft?.touched ?? []

  /**
   * 保存占用同样是**共享**的。做成组件本地 state 的话，保存在途切走再切回
   * 会换出一个 `saving=false` 的新实例、保存按钮重新可用，同一份旧 patch
   * 能被提交两次；两次事务之间若有后台写入，第二次就会覆盖它。
   */
  const saving = useVolumeDraftStore(s => (draftStoreKey === null ? false : s.leases[draftStoreKey] !== undefined))

  /**
   * 后台刷新：store 里的这一卷变了（续卷提交 / 定稿触发的状态流转 / 手动重载）
   * 就把表单同步过去——**但只在不脏时**。用户正在编辑时静默覆盖，
   * 等于把他刚打的字吃掉，且没有任何提示。
   *
   * ⚠️ 用的是 React 官方那套「渲染期调整 state」写法，**不是 effect**：
   * 在 effect 里同步 setState 会触发级联渲染（`react-hooks/set-state-in-effect`
   * 也会拦下）。渲染期 setState 由 React 就地重跑本组件、不提交中间结果，
   * 正是「props 变了就调整 state」的推荐解法。
   *
   * ⚠️ **脏的时候一个字都不动，尤其不推进 `syncedFrom`**（判据见
   * `decideVolumeSnapshotSync` 的 `'wait'` 分支）。
   *
   * 早先这里是「先无条件推进 `syncedFrom`，再判 dirty 决定要不要同步」，
   * 理由写的是「不推进会死循环」——**那个理由是错的**：条件不成立时这个分支
   * 什么 setter 都不调，不会触发重渲染，谈不上循环。
   *
   * 而那样写会造成一个**没有脏标记的旧表单**：
   * ① 用户改大纲 → 脏；② 后台写了新的 `openThreads` → 新快照到达，
   * `syncedFrom` 被推进但表单不更新（因为脏）；③ 用户保存 → patch 只带
   * `synopsis`，库里的新伏笔这次没被覆盖；④ dirty 清掉，但此时
   * `syncedFrom === volume`，**再也不会进同步分支**，界面上仍是旧伏笔且看着像已保存；
   * ⑤ 用户随手改一下那份旧伏笔 → `openThreads` 进了 touched → 整份旧清单落库，
   * 后台的新清单被覆盖，全程无感。
   *
   * 现在改成「脏就整块跳过」：保存成功清 dirty 后的那次渲染会把最新快照完整同步进来
   * （顺带让 trim 过的卷名、被剔掉的空伏笔行等归一化结果显示出来）。
   */
  const [syncedFrom, setSyncedFrom] = useState(volume)
  if (decideVolumeSnapshotSync(volume !== syncedFrom, dirty) === 'adopt') {
    setSyncedFrom(volume)
    setTitle(volume.title)
    setStatus(volume.status)
    setPremise(volume.premise ?? '')
    setSynopsis(volume.synopsis ?? '')
    setOpeningState(volume.openingState ?? '')
    setStartRaw(String(volume.startChapter))
    setEndRaw(String(volume.endChapter))
    setThreads((volume.openThreads ?? []).map((t, i) => ({ ...t, _id: `t${i}` })))
    setThreadChapterInputs({})
    setNextThreadId((volume.openThreads ?? []).length)
    // 不必清 touched：它由草稿派生，而能走到 adopt 就说明草稿已经没了
  }

  const written = useDraftStore(s => countFinalizedInRange(s.draftsByChapter, volume.startChapter, volume.endChapter))

  const boundaryEditable = canEditVolumeBoundary(volumes, volume.volumeNumber)
  // draft-store 只覆盖「已有蓝图的章」，故这是**预判**不是授权：
  // 最终由主进程事务直接查 drafts 表决定（见 VolumeRepository.remove）
  const finalizedChapters = useDraftStore(s => {
    const list: number[] = []
    for (const [ch, drafts] of Object.entries(s.draftsByChapter)) {
      if (drafts?.some(d => d.status === 'finalized')) list.push(Number(ch))
    }
    return list.join(',')
  })
  const deletable = canDeleteVolume(
    volumes,
    volume.volumeNumber,
    finalizedChapters ? finalizedChapters.split(',').map(Number) : [],
  )

  const startChapter = parseChapterNumber(startRaw)
  const endChapter = parseChapterNumber(endRaw)
  /**
   * 要落库的伏笔清单：**先剔空行，再校验**。
   *
   * 顺序反过来的话，用户点一下「补录伏笔」还没来得及填内容，
   * `validateOpenThreads` 就会报「第 N 条伏笔内容为空」并禁用整个保存按钮——
   * 而 patch 组装本来就会把空行剔掉，那条错误拦住的是一个根本不会落库的东西。
   */
  const persistedThreads = useMemo(() => threads.filter(t => t.thread.trim()), [threads])
  // 章号与伏笔各有一套判据，都走 shared 的纯函数——与仓储层同源
  const rangeError = validateVolumeRange(startChapter, endChapter)
  const threadError = validateOpenThreads(persistedThreads)
  // 不脏就没什么可存的：允许点会向主进程发一个空 patch，那边只能报错
  const canSave = dirty && !saving && !!title.trim() && !rangeError && !threadError

  /**
   * 标记「用户改过了」。做四件事：
   * ① 置脏，并把本次改动的字段记进 `touched`——保存只提交这些列
   *    （`status` / `openThreads` 后台也会写，整表提交会撤销用户没看过的新值）；
   * ② 递增**存在 store 里**的编辑版本号。放 store 而不是组件 ref：
   *    「保存在途 → 切走 → 切回（新实例，ref 从 0 重来）→ 继续输入 → 旧实例回包」时，
   *    旧实例会拿自己那份没动过的 ref 判定「保存期间没人改过」，
   *    把新实例刚写的草稿和 Tab 脏标一起清掉；
   * ③ 让 Tab 亮起未保存圆点——不这么做的话，关闭 Tab / ⌘W / 批量关闭的既有
   *    未保存确认对本编辑器**完全不生效**；
   * ④ 把当前表单快照写进草稿 store，好让切走再切回时还在。
   *
   * ⚠️ 快照取的是**本次改动后的值**，故各调用点必须先 setXxx 再 touch(...)，
   * 且要把新值显式传进来——直接读闭包里的 state 拿到的是**改动前**的值，
   * 草稿会永远慢一拍。
   */
  const touch = (field: VolumeDetailField, patch: Partial<VolumeDraft>) => {
    const nextTouched = touched.includes(field) ? touched : [...touched, field]
    // 逐字段打戳：回包时要能分辨「这个字段自发起保存以来有没有再被改过」。
    // 整卷一个版本号不够——保存 openThreads 的途中改了 synopsis，
    // 整卷版本就变了，于是**已经成功落库的 openThreads 也得不到确认**、
    // 继续留在 touched 里；等后台把 openThreads 更新掉，
    // 用户再保存 synopsis 时那份旧值会跟着提交，把后台结果覆盖
    useVolumeDraftStore.getState().markTouched(projectToken, volume.volumeNumber, field)
    useEditorStore.getState().setTabDirty(volumeTabId(volume.volumeNumber), true)
    useVolumeDraftStore.getState().set(projectToken, volume.volumeNumber, {
      title, startRaw, endRaw, status, premise, synopsis, openingState,
      threads, threadChapterInputs, nextThreadId,
      touched: nextTouched,
      ...patch,
    })
  }
  const patchThread = (id: string, patch: Partial<OpenThread>) => {
    const next = threads.map(t => (t._id === id ? { ...t, ...patch } : t))
    setThreads(next)
    touch('openThreads', { threads: next })
  }
  /** 删行时连同它的原始输入文本一起清掉，避免残留文本被下一个同 id 的行捡走 */
  const removeThread = (id: string) => {
    const nextThreads = threads.filter(t => t._id !== id)
    const nextInputs = { ...threadChapterInputs }
    delete nextInputs[id]
    setThreads(nextThreads)
    setThreadChapterInputs(nextInputs)
    touch('openThreads', { threads: nextThreads, threadChapterInputs: nextInputs })
  }

  const handleSave = async () => {
    // ⚠️ token 在**点击这一刻**捕获，随后 updateDetail 里是 await
    const actionToken = getProjectToken()
    const drafts = useVolumeDraftStore.getState()

    // single-flight 走**共享**租约，不是组件本地的 saving：
    // 保存在途切走再切回会换实例，本地 saving 从 false 重来，
    // 同一份旧 patch 就能被提交两次
    const leaseId = drafts.beginSave(actionToken, volume.volumeNumber)
    if (leaseId === null) return

    // 各字段的编辑戳在此定格，逐字段确认要用它
    const stampsAtSave = drafts.getStamps(actionToken, volume.volumeNumber)
    const savedFields = [...touched]
    // patch 组装走 volume-service 的纯函数：只带 `touched` 点名的列，
    // 且**永远不含 closingState**
    const payload = buildVolumeSavePayload(volume.volumeNumber, {
      title, startChapter, endChapter, premise, synopsis, openingState, status,
      openThreads: threads,
    }, savedFields)

    let res
    try {
      res = await updateDetail(payload, actionToken)
    } finally {
      // 无论成败都要还租约，否则一次异常就把这一卷永久锁成「保存中」
      useVolumeDraftStore.getState().endSave(actionToken, volume.volumeNumber, leaseId)
    }

    // ⚠️ await 之后先核归属再动 UI。写库那一面已由主进程 token 守卫挡住，
    // 但**旧回调改写当前界面**它挡不住：A 的保存回来时用户已在 B，
    // 这里会给 B 弹一句「第2卷已保存」、还顺手把 B 的同号 Tab 改名
    if (getProjectToken() !== actionToken) return
    if (!res.success) {
      // 保留 dirty，让用户能重试。清了 dirty 再报错，用户会以为改动已经落盘
      toast.error(res.error ?? '保存失败')
      return
    }
    // **逐字段**确认：只摘掉「自发起保存以来没再被改过」的那些。
    // 保存期间又改过的字段继续留在 touched 里等下一次保存；
    // 全部摘完才算干净，那时才清 Tab 脏标。
    // 只动**共享**状态——包括「保存在途切走再切回」换出来的那个新实例，
    // 它订阅的是同一份草稿
    const wentClean = useVolumeDraftStore.getState()
      .acknowledgeSave(actionToken, volume.volumeNumber, savedFields, stampsAtSave)
    if (wentClean) {
      useEditorStore.getState().setTabDirty(volumeTabId(volume.volumeNumber), false)
    }
    // 卷名可能改过，让标签页文案跟上。
    // ⚠️ 用 `renameTab` 而不是 `openVolumeDetail`：后者会 `openFile`，
    // 把用户在保存在途期间**刚关掉**的 Tab 重新创建出来，或抢走当前焦点
    if (payload.title !== undefined) {
      useEditorStore.getState().renameTab(
        volumeTabId(volume.volumeNumber),
        `第${volume.volumeNumber}卷 · ${payload.title || '未命名'}`,
      )
    }
    toast.success(`第${volume.volumeNumber}卷已保存`)
  }

  const handleDelete = async () => {
    /**
     * ⚠️ token 与卷号都在**进入本函数、第一个 await 之前**捕获。
     *
     * `confirm()` 是个长 await——要等用户点。确认框由独立的 React root 渲染，
     * 本编辑器卸载后它照样在等。若等确认回来才 `getProjectToken()`，
     * 拿到的是**新项目的合法 token**，而 `volume.volumeNumber` 还是旧闭包里那个：
     * 在 A 里点删第 2 卷、切到 B、再点确认 → 删掉的是 B 的第 2 卷，
     * 主进程守卫完全看不出异常（token 是对的）。
     *
     * 删除的语义起点必须是**点击那一刻**：确认框上写的卷名与章号区间都是 A 的。
     */
    const actionToken = getProjectToken()
    const targetVolume = volume.volumeNumber
    const ok = await confirm(
      `确认删除第 ${targetVolume} 卷「${volume.title || '未命名'}」？\n` +
      `第 ${volume.startChapter}–${volume.endChapter} 章将不再属于任何卷。此操作不可撤销。`,
      { title: '删除卷', confirmText: '删除', danger: true },
    )
    if (!ok) return
    // 确认期间切走了项目：这次确认授权的是上一个项目里的那一卷，作废
    if (getProjectToken() !== actionToken) return
    const res = await removeOne(targetVolume, actionToken)
    // 同 handleSave：await 之后先核归属再动 UI
    if (getProjectToken() !== actionToken) return
    if (!res.success) {
      toast.error(res.error ?? '删除失败')
      return
    }
    // 卷没了，它的草稿也不该留着——否则同号新卷（理论上不会有，但删完再续卷
    // 会重新用到这个号）打开时会捞到一份属于已删卷的编辑
    useVolumeDraftStore.getState().clear(actionToken, targetVolume)
    useEditorStore.getState().closeTab(volumeTabId(targetVolume))
    toast.success(`第${targetVolume}卷已删除`)
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* ===== 头部 ===== */}
      <div
        className="flex items-start justify-between gap-3 px-6 py-4 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--color-border)' }}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold truncate" style={{ color: 'var(--color-text)' }}>
              第{volume.volumeNumber}卷 · {volume.title || '未命名'}
            </h2>
            <span
              className="text-[0.68rem] px-1.5 py-0.5 rounded flex-shrink-0"
              style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text-secondary)' }}
            >
              {VOLUME_STATUS_LABELS[volume.status]}
            </span>
            {dirty && <span className="text-[0.7rem] flex-shrink-0" style={{ color: 'var(--color-accent)' }}>● 未保存</span>}
          </div>
          {/* 设计稿 29 的副信息还有一项「上次更新 X 小时前」。`volumes` 表里确实有
              `updated_at`（各写方法也都刷新了它，值可信），但它没有出现在
              `VolumeData` / IPC 契约里，渲染层拿不到——与其显示一个编造的时间，
              不如先不显示这一项。已登记待排期 */}
          <div className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
            第 {volume.startChapter}–{volume.endChapter} 章 · 已写 {written} 章 · 未回收伏笔 {threads.length}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void handleDelete()}
            disabled={!deletable}
            title={deletable ? '删除此卷' : '本卷已有定稿章节，不可删除'}
          >
            <Trash2 size={14} style={{ color: 'var(--color-text-muted)' }} />
          </Button>
          <Button onClick={() => void handleSave()} disabled={!canSave}>
            {saving ? <RefreshCw size={12} className="animate-spin" /> : <Save size={12} />}
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>

      {/* ===== 主体：左主区 + 右轨 360px ===== */}
      <div className="flex-1 grid grid-cols-[1fr_360px] gap-6 overflow-hidden px-6 py-4">
        {/* ---- 左主区 ---- */}
        <div className="min-w-0 overflow-y-auto pr-1 space-y-4">
          <div>
            <div className="text-xs font-semibold mb-2" style={{ color: 'var(--color-text)' }}>基本信息</div>
            <div className="grid grid-cols-[1fr_110px_110px_140px] gap-3">
              <div className="min-w-0">
                <Label htmlFor={`${uid}-title`}>卷名</Label>
                <Input
                  id={`${uid}-title`}
                  value={title}
                  onChange={e => { setTitle(e.target.value); touch('title', { title: e.target.value }) }}
                  placeholder="如：北境风雪"
                />
              </div>
              <div>
                <Label htmlFor={`${uid}-start`}>起始章</Label>
                <Input
                  id={`${uid}-start`}
                  type="number"
                  min={1}
                  value={startRaw}
                  disabled={!boundaryEditable}
                  onChange={e => { setStartRaw(e.target.value); touch('boundary', { startRaw: e.target.value }) }}
                />
              </div>
              <div>
                <Label htmlFor={`${uid}-end`}>结束章</Label>
                <Input
                  id={`${uid}-end`}
                  type="number"
                  min={1}
                  value={endRaw}
                  disabled={!boundaryEditable}
                  onChange={e => { setEndRaw(e.target.value); touch('boundary', { endRaw: e.target.value }) }}
                />
              </div>
              <div>
                <Label htmlFor={`${uid}-status`}>状态</Label>
                <Select
                  id={`${uid}-status`}
                  value={status}
                  onValueChange={v => { setStatus(v as VolumeStatus); touch('status', { status: v as VolumeStatus }) }}
                  options={STATUS_OPTIONS}
                />
              </div>
            </div>

            {!boundaryEditable && (
              <div className="text-xs mt-1.5" style={{ color: 'var(--color-text-muted)' }}>
                仅最后一卷可改边界——改中间卷的章号会让夹在其中的章节失去归属。
              </div>
            )}
            {rangeError && (
              <div role="alert" className="text-xs mt-1.5" style={{ color: 'var(--color-error, #ef4444)' }}>
                {rangeError}
              </div>
            )}
          </div>

          <div>
            <Label htmlFor={`${uid}-premise`}>
              本卷主线{' '}
              <span className="text-xs font-normal" style={{ color: 'var(--color-text-muted)' }}>
                目标 + 核心冲突，供目录生成与正文写作共同参照
              </span>
            </Label>
            <Textarea
              id={`${uid}-premise`}
              rows={4}
              value={premise}
              onChange={e => { setPremise(e.target.value); touch('premise', { premise: e.target.value }) }}
              placeholder="这一卷主角要达成什么、跟谁冲突"
            />
          </div>

          <div>
            <Label htmlFor={`${uid}-synopsis`}>
              本卷大纲{' '}
              <span className="text-xs font-normal" style={{ color: 'var(--color-text-muted)' }}>
                {volume.endChapter - volume.startChapter + 1} 章
              </span>
            </Label>
            <Textarea
              id={`${uid}-synopsis`}
              rows={16}
              value={synopsis}
              onChange={e => { setSynopsis(e.target.value); touch('synopsis', { synopsis: e.target.value }) }}
              placeholder="按结构模式在卷内展开的情节走向"
            />
          </div>
        </div>

        {/* ---- 右轨 360px ---- */}
        <div className="min-w-0 overflow-y-auto pr-1 space-y-4">
          <div>
            <Label htmlFor={`${uid}-opening`}>
              开卷状态{' '}
              <span className="text-xs font-normal" style={{ color: 'var(--color-text-muted)' }}>
                承接上一卷收束 · 可改
              </span>
            </Label>
            <Textarea
              id={`${uid}-opening`}
              rows={7}
              value={openingState}
              onChange={e => { setOpeningState(e.target.value); touch('openingState', { openingState: e.target.value }) }}
              placeholder="本卷开始时，主角与主要势力各处于什么状态"
            />
          </div>

          <div>
            <div className="flex items-center gap-2">
              <Label className="flex-1">
                未回收伏笔{' '}
                <span className="text-xs font-normal" style={{ color: 'var(--color-text-muted)' }}>
                  {threads.length} 条 · 可增删改
                </span>
              </Label>
              <button
                type="button"
                className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded hover:opacity-80 disabled:opacity-40"
                style={{ color: 'var(--color-accent)' }}
                disabled={threads.length >= MAX_OPEN_THREADS}
                onClick={() => {
                  const next: ThreadRow[] = [
                    ...threads,
                    { chapter: volume.startChapter, thread: '', urgency: 'mid', _id: `t${nextThreadId}` },
                  ]
                  setThreads(next)
                  setNextThreadId(nextThreadId + 1)
                  touch('openThreads', { threads: next, nextThreadId: nextThreadId + 1 })
                }}
              >
                <Plus size={12} /> 补录伏笔
              </button>
            </div>

            {threads.length === 0 ? (
              <div
                className="rounded-md p-3 text-xs leading-relaxed"
                style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text-muted)' }}
              >
                <div className="mb-1" style={{ color: 'var(--color-text)' }}>本卷台账里没有未回收伏笔</div>
                续卷时上一卷的未回收清单会结转到这里。若你记得还有伏笔没收，点上方「补录伏笔」加进来——
                不在台账里的伏笔不会注入目录生成，后续章节都不会再被提醒。
              </div>
            ) : (
              <div className="space-y-1.5">
                {threads.map((t, i) => (
                  <div key={t._id} className="rounded-md p-2 space-y-1.5" style={{ background: 'var(--color-bg-elevated)' }}>
                    <div className="flex items-center gap-1.5">
                      <label className="sr-only" htmlFor={`${uid}-th-ch-${t._id}`}>第 {i + 1} 条伏笔的埋设章号</label>
                      <Input
                        id={`${uid}-th-ch-${t._id}`}
                        type="number"
                        min={1}
                        className="w-[72px]"
                        value={threadChapterInputs[t._id] ?? String(t.chapter)}
                        onChange={e => {
                          // 存原始字符串 + 严格解析：`parseInt('1.5')===1`，
                          // 先转换再校验等于把用户输入静默改掉。
                          // 解析失败写 NaN，交给 validateOpenThreads 报错并挡住提交
                          const raw = e.target.value
                          const nextInputs = { ...threadChapterInputs, [t._id]: raw }
                          const nextThreads = threads.map(x =>
                            x._id === t._id ? { ...x, chapter: parseChapterNumber(raw) } : x)
                          setThreadChapterInputs(nextInputs)
                          setThreads(nextThreads)
                          // 章号这一处要**同时**把两份新值写进草稿：只写 threads 的话，
                          // 切走再回来输入框里的原始文本会丢，显示成解析后的数字
                          touch('openThreads', { threads: nextThreads, threadChapterInputs: nextInputs })
                        }}
                      />
                      <label className="sr-only" htmlFor={`${uid}-th-u-${t._id}`}>第 {i + 1} 条伏笔的优先级</label>
                      <Select
                        id={`${uid}-th-u-${t._id}`}
                        aria-label={`第 ${i + 1} 条伏笔的优先级`}
                        value={t.urgency}
                        onValueChange={v => patchThread(t._id, { urgency: v as OpenThread['urgency'] })}
                        options={URGENCY_OPTIONS}
                      />
                      <button
                        type="button"
                        className="ml-auto p-1 rounded hover:opacity-80"
                        style={{ color: 'var(--color-text-muted)' }}
                        title={`删除第 ${i + 1} 条伏笔`}
                        onClick={() => removeThread(t._id)}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                    <label className="sr-only" htmlFor={`${uid}-th-t-${t._id}`}>第 {i + 1} 条伏笔的内容</label>
                    <Textarea
                      id={`${uid}-th-t-${t._id}`}
                      rows={2}
                      value={t.thread}
                      onChange={e => patchThread(t._id, { thread: e.target.value })}
                      placeholder="这条线索是什么、还欠读者一个什么交代"
                    />
                  </div>
                ))}
              </div>
            )}

            {threadError && (
              <div role="alert" className="text-xs mt-1.5" style={{ color: 'var(--color-error, #ef4444)' }}>
                {threadError}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

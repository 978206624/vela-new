/**
 * 分卷状态管理（Phase 19）
 *
 * 数据来源：项目库 `volumes` 表（经 `db:volume-*` IPC）。
 *
 * 用单一 `status` 字段表达 idle / loading / ready / error，
 * 经 `getSnapshot()` 交给 `volume-service` 的生成关键路径——
 * **只有 ready 才携带 volumes**，`[]` 此时才真正意味着单卷模式。
 * 这样「尚未加载」「加载失败」都无法伪装成零卷去触发全书大纲回落。
 *
 * 事件订阅不在本模块做：统一由 `project-service.ts` 的 `REFRESH_RESOURCE`
 * handler 驱动（该处有 disposers 生命周期与重复初始化保护）。
 */
import { create } from 'zustand'
import { ipc } from '../services/ipc-client'
import { loadVolumes, type VolumeSnapshot } from '../services/volume-service'
import { useProjectStore } from './project-store'
import type { VolumeData, VolumeStatus, OpenThread, VolumeDetailPatch } from '../../electron/repositories/volume-repository'

/** 写操作的统一返回形状（stale = 因项目已切换被主进程丢弃） */
type WriteResult = { success: boolean; stale?: boolean; error?: string }

/**
 * 取当前项目 token，用于跨项目写守卫。
 *
 * 长流程（如 Task 19.2 续卷跨两次 LLM 调用）**必须在动作发起时**调用本函数
 * 捕获 token，再显式传给写方法；不能等到写入时才取——那样 A 项目的延迟回调
 * 会带上已切到 B 的 token 通过校验，把 A 的数据写进 B 库
 * （见 `stores/agent-store.ts` 同款注释与 commit 80283dd）。
 */
export const getProjectToken = (): number | undefined =>
  useProjectStore.getState().currentToken ?? undefined

/**
 * 把主进程的 stale 拒绝转成用户可读文案。
 * conversation 写入是 fire-and-forget、不看返回值；卷写入是用户显式动作
 * （在卷详情点「保存」），原样透传会让 UI 弹出没有原因的失败提示。
 */
const withStaleMessage = (res: WriteResult): WriteResult =>
  res.stale ? { ...res, error: res.error ?? '项目已切换，本次修改未保存' } : res

/**
 * 加载序号：每次 loadAll 与 reset 都递增。
 * 回包落状态前核对序号 + token，丢弃旧项目的在途响应，
 * 防「A 的请求在切到 B 之后 resolve，把 A 的卷覆盖进 B」。
 */
let loadSeq = 0

/**
 * 详情写入**直接合并进 store** 的行，连同「合并时最新的加载序号」。
 *
 * 为什么需要它：`updateDetail` 拿主进程带回的整行就地替换，而此刻可能有一次
 * `loadAll` 正在途中——它读库的时间点在本次写入**之前**，回包落地会把刚合并的
 * 新行盖回旧值，于是又变成「界面干净但数据过期」。
 *
 * ⚠️ 早先的做法是在合并时 `loadSeq++` 把在途请求作废。**那是错的**：
 * 那次请求已经把 `status` 设成 `loading`，被作废后它的回包直接 return，
 * **再没有任何路径把状态恢复回来**——store 会永久停在 `loading`，
 * 侧栏和总览页一直转骨架，`getSnapshot()` 恒为未就绪，
 * 目录生成会被 fail-closed 拒绝、正文也拿不到卷罗盘。
 * 而且它分不清「保存前发出的旧读取」和「续卷/定稿之后发起的**合法**新刷新」，
 * 会把后者携带的新卷与自动状态流转一起吞掉。
 *
 * 改用**行级叠加**：不动 `loadSeq`、不干预任何请求的生命周期，
 * 只在回包落地时把「发起于本次写入之前」的读取结果盖回新行。
 *
 * ⚠️ `atSeq` 必须取**发出写 IPC 之前**的 `loadSeq`，不能取回包到达时的。
 * 取回包时的值只能证明「这次读取发起于回包之前」，证明不了「发起于**写入之前**」——
 * 事务提交到回包抵达渲染层之间是有窗口的，期间发起的读取拿到的是**更新**的数据，
 * 却会因 `seq <= atSeq` 被误判成旧读取、被叠加盖回去。
 */
let mergedRows = new Map<number, { row: VolumeData; atSeq: number }>()

/**
 * 在途的详情写入计数，以及等待它们结束的读取。
 *
 * 光把 `atSeq` 提前还不够：写 IPC 已发出、事务尚未提交时发起的读取，
 * 序号大于 `atSeq`（叠加不保护它），读到的却可能仍是**写入前**的旧值——
 * 那样刚存下去的内容会被这次读取悄悄revert 回去，又变成「界面干净但数据过期」。
 *
 * 与其继续按序号猜先后，不如**把这段交叠消掉**：详情写入在途时，
 * 新发起的 `loadAll` 先等它结束再发 IPC。于是只剩两种确定的情形——
 * 读取发起于写入**之前**（序号 ≤ atSeq，由叠加盖回新行），
 * 或发起于写入**之后**（读到的本就是新值，叠加就地失效）。
 *
 * 代价只是一次刷新被推迟一个 IPC 往返（毫秒级）。
 * `updateDetail` 用 try/finally 保证计数一定回零，不会把读取永久挂起。
 *
 * ## 为什么是「一代一个闸门」而不是一个全局计数
 *
 * 计数若是模块级全局的，`reset()`（项目关闭/切换）就作废不掉它：
 * 等待中的 `loadAll` 被唤醒后仍在 `while (pending > 0)` 里，看到计数还大于 0
 * 会**立刻重新入队**，根本走不到 token 判定那一步。后果是
 * **A 项目一个没结算的写入，能把 B 项目打开时的首次加载一直挡住**——
 * 而 IPC 客户端没有超时，那就是永久卡死。
 *
 * 故把「计数 + 等待者」打包成一代闸门：`reset()` 换上全新的一代并放行旧的，
 * 旧写入的 `finally` 只结算它自己捕获的那一代，碰不到新一代；
 * 旧等待者醒来发现闸门已经换代，直接退出，不再重新入队。
 */
interface WriteGate {
  pending: number
  waiters: Array<() => void>
}

/** 当前这一代闸门。`reset()` 会整体换掉它 */
let writeGate: WriteGate = { pending: 0, waiters: [] }

/** 放行某一代闸门上所有等待中的读取 */
function releaseGate(gate: WriteGate): void {
  const waiters = gate.waiters
  gate.waiters = []
  for (const resolve of waiters) resolve()
}

interface VolumeState {
  /** 全部卷（按卷序号升序）。仅当 status==='ready' 时可信 */
  volumes: VolumeData[]
  /** 加载状态。ready 且 volumes 为空才是确定的单卷模式 */
  status: 'idle' | 'loading' | 'ready' | 'error'

  // ===== Selectors =====
  /** 交给 volume-service 生成关键路径的快照 */
  getSnapshot: () => VolumeSnapshot

  // ===== Actions =====
  /** 重置为初始状态（项目关闭时由 ProjectService 调用），同时作废在途请求 */
  reset: () => void
  /** 从库中重新加载全部卷。读失败保留旧数据并置 error，不静默清空 */
  loadAll: () => Promise<void>
  /** 写入/更新单卷（整行）。expectedToken 缺省取当前项目 token；长流程须显式传起点 token */
  upsertOne: (data: VolumeData, expectedToken?: number) => Promise<WriteResult>
  /**
   * 卷详情保存 —— **字段范围**更新，载荷不含 `closingState`。
   * 详情表单里没有那一栏，走整行 upsert 会用旧快照覆盖续卷并发写入的收束报告
   * （见 `VolumeRepository.updateDetail`）。
   */
  updateDetail: (patch: VolumeDetailPatch, expectedToken?: number) => Promise<WriteResult>
  /** 删除单卷。已开写不可删由主进程事务直接查 drafts 表强制，此处不做授权 */
  removeOne: (volumeNumber: number, expectedToken?: number) => Promise<WriteResult>
  /** 仅更新状态（供定稿后处理的自动流转与卷详情手动改） */
  setStatus: (volumeNumber: number, status: VolumeStatus, expectedToken?: number) => Promise<WriteResult>
  /** 仅更新未回收伏笔（供续卷提炼与用户手工补录） */
  setOpenThreads: (volumeNumber: number, threads: OpenThread[], expectedToken?: number) => Promise<WriteResult>
}

export const useVolumeStore = create<VolumeState>((set, get) => ({
  volumes: [],
  status: 'idle',

  getSnapshot: () => {
    const { status, volumes } = get()
    return status === 'ready' ? { status: 'ready', volumes } : { status }
  },

  reset: () => {
    loadSeq++   // 作废在途请求，防旧项目回包写进下一个项目
    mergedRows = new Map()   // 叠加也属于上一个项目，不能带过去
    // 换代 + 放行旧闸门：新一代的计数从 0 起，与上一个项目彻底隔离。
    // 旧等待者醒来会发现闸门已换代而直接退出（**不是**靠 token 判定——
    // 它们此刻还卡在 while 里，根本走不到取 token 那一步）；
    // 旧写入的 finally 只结算旧闸门，减不到新一代头上
    const staleGate = writeGate
    writeGate = { pending: 0, waiters: [] }
    releaseGate(staleGate)
    set({ volumes: [], status: 'idle' })
  },

  loadAll: async () => {
    // 无项目时不打 IPC：主进程 getProjectDb() 为 null 会返回 []，
    // 会把「无项目」误记成 ready 的单卷模式（与 draft-store 同款守卫）
    if (!useProjectStore.getState().currentProject) return

    // 有详情写入在途就先等它结束，把「读写交叠」这段不确定性直接消掉
    // （见 WriteGate 的注释）。序号必须在**等完之后**才取，
    // 否则被推迟的这次读取会拿到一个小于等于 atSeq 的序号，被当成旧读取
    const myGate = writeGate
    while (myGate.pending > 0) {
      await new Promise<void>(resolve => { myGate.waiters.push(resolve) })
      // 醒来先看闸门有没有换代：换了说明项目已 reset，本次读取属于**上一个项目**，
      // 直接退出。不这么判的话会重新入队，把新项目的加载一起堵死
      if (myGate !== writeGate) return
    }
    if (myGate !== writeGate) return

    const token = getProjectToken()
    const seq = ++loadSeq
    set({ status: 'loading' })

    try {
      const volumes = await loadVolumes()
      // 回包核对：序号被后续请求/reset 顶掉，或项目已切换 → 丢弃，不落状态
      if (seq !== loadSeq || getProjectToken() !== token) return
      // 行级叠加：把「本次读取开始之后才由详情写入合并进来的行」重新盖上去。
      // 本次读取发起于那些写入**之前**，携带的是它们的旧值。
      // 序号更大的读取（发起于写入之后）读到的本就是新值，叠加就地失效并清除。
      let next = volumes
      for (const [volumeNumber, m] of [...mergedRows]) {
        if (seq <= m.atSeq) {
          next = next.map(v => (v.volumeNumber === volumeNumber ? m.row : v))
        } else {
          mergedRows.delete(volumeNumber)
        }
      }
      set({ volumes: next, status: 'ready' })
    } catch (err) {
      if (seq !== loadSeq || getProjectToken() !== token) return
      // 保留旧 volumes：清空会让已分卷项目被误判为单卷模式
      console.error('[volume-store] 加载分卷失败，保留上次数据:', err)
      set({ status: 'error' })
    }
  },

  upsertOne: async (data, expectedToken) => {
    const token = expectedToken ?? getProjectToken()
    try {
      const res = await ipc.invoke('db:volume-upsert', data, token)
      if (res.success) await get().loadAll()
      return withStaleMessage(res)
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },

  updateDetail: async (patch, expectedToken) => {
    const token = expectedToken ?? getProjectToken()
    // ⚠️ 截止序号在**发出写 IPC 之前**定格：它要回答的是
    // 「这次读取是不是发起于本次写入之前」，回包时再取就晚了。
    //
    // 注：有了下面的写入闸门推迟之后，被推迟的读取要等写完才取序号，
    // 因此合并那一刻 `loadSeq` 恰好等于 `writeCutoff`，两者当前**等价**。
    // 保留它是第二道保险（万一将来去掉推迟，它仍能把窗口收窄）；
    // 也正因为等价，这一行**没有变异覆盖**——变异脚本里如实注明了原因。
    const writeCutoff = loadSeq
    // 捕获**当前这一代**闸门。项目切换后 reset 会换代，本次写入的结算
    // 只作用于自己这一代，不会去减新一代的计数
    const myGate = writeGate
    myGate.pending++
    try {
      const res = await ipc.invoke('db:volume-update-detail', patch, token)
      // ⚠️ 用主进程**带回来的那一行**直接合并，不再发一次 loadAll() 去刷新。
      //
      // 靠 loadAll 是不可靠的：它读失败会吞掉异常只置 error，
      // 被后续请求的序号顶掉时更是直接 return——两种情况下 store 里都还是旧行。
      // 而保存此时已判定成功、草稿被清空，于是界面上留下一个
      // **没有脏标记的旧表单**；用户接着编辑那份旧值再保存，
      // 就把后台期间写入的新值覆盖了。
      // `myGate === writeGate` 这一道挡的是「reset 已执行、但 currentToken
      // 还没换成新值」的窄窗口：那时 token 判定看不出异常，而这次合并属于上一个项目
      if (res.success && res.volume && getProjectToken() === token && myGate === writeGate) {
        const merged = res.volume
        // 登记行级叠加（**不动 loadSeq**，理由见 mergedRows 的注释）：
        // 在途的那次 loadAll 读库于本次写入之前，回包会带着旧值落地，
        // 靠这条叠加把新行重新盖回去
        mergedRows.set(merged.volumeNumber, { row: merged, atSeq: writeCutoff })
        set(s => ({
          volumes: s.volumes.map(v => (v.volumeNumber === merged.volumeNumber ? merged : v)),
        }))
      }
      return withStaleMessage(res)
    } catch (err) {
      return { success: false, error: String(err) }
    } finally {
      // 无论成败都要回零并放行等待中的读取，否则一次异常就让刷新永久挂起。
      // 只结算**自己那一代**：项目切换后这一代已被 reset 丢弃，
      // 减它不会影响新项目的闸门
      myGate.pending--
      if (myGate.pending === 0) releaseGate(myGate)
    }
  },

  removeOne: async (volumeNumber, expectedToken) => {
    const token = expectedToken ?? getProjectToken()
    try {
      const res = await ipc.invoke('db:volume-delete', volumeNumber, token)
      if (res.success) await get().loadAll()
      return withStaleMessage(res)
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },

  setStatus: async (volumeNumber, status, expectedToken) => {
    const token = expectedToken ?? getProjectToken()
    try {
      const res = await ipc.invoke('db:volume-update-status', volumeNumber, status, token)
      if (res.success) await get().loadAll()
      return withStaleMessage(res)
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },

  setOpenThreads: async (volumeNumber, threads, expectedToken) => {
    const token = expectedToken ?? getProjectToken()
    try {
      const res = await ipc.invoke('db:volume-update-threads', volumeNumber, threads, token)
      if (res.success) await get().loadAll()
      return withStaleMessage(res)
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}))

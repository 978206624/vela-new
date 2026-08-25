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
import type { VolumeData, VolumeStatus, OpenThread } from '../../electron/repositories/volume-repository'

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
  /** 写入/更新单卷。expectedToken 缺省取当前项目 token；长流程须显式传起点 token */
  upsertOne: (data: VolumeData, expectedToken?: number) => Promise<WriteResult>
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
    set({ volumes: [], status: 'idle' })
  },

  loadAll: async () => {
    // 无项目时不打 IPC：主进程 getProjectDb() 为 null 会返回 []，
    // 会把「无项目」误记成 ready 的单卷模式（与 draft-store 同款守卫）
    if (!useProjectStore.getState().currentProject) return

    const token = getProjectToken()
    const seq = ++loadSeq
    set({ status: 'loading' })

    try {
      const volumes = await loadVolumes()
      // 回包核对：序号被后续请求/reset 顶掉，或项目已切换 → 丢弃，不落状态
      if (seq !== loadSeq || getProjectToken() !== token) return
      set({ volumes, status: 'ready' })
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

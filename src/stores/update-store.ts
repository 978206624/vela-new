import { create } from 'zustand'
import { ipc } from '../services/ipc-client'

/**
 * 在线更新状态机（对应 Product-Spec §4.9）
 * - idle           初始/已忽略
 * - checking       正在检查
 * - available      检测到新版本（弹窗提示，等用户确认下载）
 * - downloading    下载中（带进度）
 * - downloaded     下载完成（等用户重启安装）
 * - not-available  已是最新（手动检查时给反馈）
 * - portable-manual 便携版：引导前往 Releases 手动下载
 * - error          检查/下载出错（仅手动触发时提示）
 */
export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not-available'
  | 'portable-manual'
  | 'error'

interface UpdateState {
  status: UpdateStatus
  /** 新版本号 */
  version: string
  /** GitHub Release 更新日志（Markdown） */
  releaseNotes: string
  /** 下载进度百分比 0-100 */
  percent: number
  /** 错误信息 */
  errorMessage: string
  /** 当前检查是否用户手动触发（决定设置页是否展示「已是最新」反馈） */
  manual: boolean
  /** 用户在下载中点了关闭：下载继续，但进度事件不再重新弹窗，仅下载完成时再提示 */
  dismissed: boolean
  /** 事件订阅是否已初始化 */
  initialized: boolean

  /** 订阅主进程 updater:* 事件（应在 App 启动时调用一次） */
  init: () => void
  /** 检查更新；manual=true 为用户手动触发 */
  checkForUpdate: (manual: boolean) => Promise<void>
  /** 开始下载更新 */
  startDownload: () => Promise<void>
  /** 退出并安装 */
  quitAndInstall: () => Promise<void>
  /** 便携版：打开 GitHub Releases */
  openReleases: () => Promise<void>
  /** 关闭提示，回到 idle（「以后再说」） */
  dismiss: () => void
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  status: 'idle',
  version: '',
  releaseNotes: '',
  percent: 0,
  errorMessage: '',
  manual: false,
  dismissed: false,
  initialized: false,

  init: () => {
    if (get().initialized || !ipc.isElectron) return
    set({ initialized: true })

    ipc.on('updater:checking', () => set({ status: 'checking', errorMessage: '' }))

    ipc.on('updater:available', (data) =>
      set({
        status: 'available',
        version: data.version,
        releaseNotes: data.releaseNotes,
        percent: 0,
        dismissed: false,
      }),
    )

    ipc.on('updater:not-available', (data) =>
      set({ status: 'not-available', version: data.version }),
    )

    ipc.on('updater:download-progress', (data) =>
      // 用户已关闭弹窗：下载在后台继续，仅静默更新百分比，不重新弹窗
      set((s) =>
        s.dismissed
          ? { percent: Math.round(data.percent) }
          : { status: 'downloading', percent: Math.round(data.percent) },
      ),
    )

    ipc.on('updater:downloaded', (data) =>
      // 下载完成始终提示重启安装（即便此前关闭过），故复位 dismissed
      set({ status: 'downloaded', version: data.version, percent: 100, dismissed: false }),
    )

    ipc.on('updater:error', (data) => {
      // 主进程仅在交互式（手动检查/下载）时推送 error，这里直接展示
      set({ status: 'error', errorMessage: data.message })
    })

    // 订阅就绪后再触发启动静默检查（manual=false）——保证事件不早于订阅而丢失。
    // 主进程对 dev/便携/非 Windows 会返回降级标记，由 checkForUpdate 静默处理。
    get().checkForUpdate(false)
  },

  checkForUpdate: async (manual) => {
    set({ manual, errorMessage: '', dismissed: false })
    if (manual) set({ status: 'checking' })
    const result = await ipc.invoke('updater:check', manual)
    if (result.portable) {
      // 便携版：仅手动检查时引导前往 Releases；静默启动不打扰（每次启动都弹会很烦）
      set({ status: manual ? 'portable-manual' : 'idle' })
    } else if (result.dev || result.unsupported) {
      // 开发模式 / 非 Windows 打包：无法自动更新。手动检查给「已是最新」反馈，静默则保持 idle
      set({ status: manual ? 'not-available' : 'idle' })
    }
    // 其余（triggered）等待 updater:* 事件驱动状态
  },

  startDownload: async () => {
    set({ status: 'downloading', percent: 0, dismissed: false })
    const result = await ipc.invoke('updater:start-download')
    if (!result.ok) {
      set({ status: 'error', errorMessage: result.error ?? '下载失败' })
    }
  },

  quitAndInstall: async () => {
    await ipc.invoke('updater:quit-and-install')
  },

  openReleases: async () => {
    await ipc.invoke('updater:open-releases')
  },

  dismiss: () => set({ status: 'idle', errorMessage: '', dismissed: true }),
}))

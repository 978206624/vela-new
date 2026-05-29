/**
 * Vela 在线更新模块 — 基于 electron-updater，更新源为 GitHub Releases
 *
 * 设计要点（对应 Product-Spec §4.9）：
 * - autoDownload 关闭：检测到新版只提示，用户确认后才下载。
 * - autoInstallOnAppQuit 关闭：下载完只提示，用户点「重启安装」才装。
 * - 仅打包后的 NSIS 安装版走自动更新；便携版（portable）检测到后引导手动下载。
 * - 启动静默检查失败不打扰用户；用户手动触发（manual）的失败才推送错误事件。
 */
import { app, shell } from 'electron'
// electron-updater 是 CommonJS，本项目源码为 ESM：必须默认导入再解构，
// 直接具名 `import { autoUpdater }` 在 ESM 下会抛 "Named export not found"。
import electronUpdater from 'electron-updater'
import type { UpdateInfo, ProgressInfo } from 'electron-updater'
import { getCurrentWindow } from './main'

const { autoUpdater } = electronUpdater

/** GitHub Releases 页面（便携版手动下载用） */
const RELEASES_URL = 'https://github.com/978206624/vela-new/releases'

/**
 * 标记当前更新动作是否「交互式」（用户手动检查 或 用户已发起下载）。
 * - 启动静默检查时为 false：出错只记日志，不弹窗。
 * - 手动检查 / 下载时为 true：出错推送 updater:error 让渲染层提示。
 *
 * 仅在「正在检查 / 正在下载」的窄窗口内为 true：到达任一终态事件
 * （available / not-available / downloaded / error）后立即复位为 false，
 * 避免手动检查一次后该标志长期残留、把后续非交互式 error 误判为需弹窗。
 */
let interactive = false

/** 是否便携版：electron-builder 的 portable target 运行时注入此环境变量 */
function isPortable(): boolean {
  return !!process.env.PORTABLE_EXECUTABLE_DIR
}

/** 是否支持自动更新：仅 Windows（NSIS 安装版）。mac/linux 打包不走自动更新（Spec §4.9「仅 NSIS」） */
function isAutoUpdateSupported(): boolean {
  return process.platform === 'win32'
}

/** 向渲染进程推送更新事件（防护已销毁的窗口/webContents） */
function send(channel: string, payload: unknown): void {
  const win = getCurrentWindow()
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(channel, payload)
}

/** GitHub Release 的 releaseNotes 可能是字符串或分段数组，统一成字符串 */
function normalizeReleaseNotes(notes: UpdateInfo['releaseNotes']): string {
  if (!notes) return ''
  if (typeof notes === 'string') return notes
  return notes.map((n) => n.note ?? '').filter(Boolean).join('\n\n')
}

/** 注册 autoUpdater 事件 → 转发为 updater:* IPC 事件 */
function wireEvents(): void {
  autoUpdater.on('checking-for-update', () => {
    send('updater:checking', null)
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    // 检查阶段结束（下载由用户点击后 start-download 重新置 interactive=true）
    interactive = false
    send('updater:available', {
      version: info.version,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
      releaseName: info.releaseName ?? info.version,
      releaseDate: info.releaseDate ?? '',
    })
  })

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    interactive = false
    send('updater:not-available', { version: info.version })
  })

  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    send('updater:download-progress', {
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
    })
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    interactive = false
    send('updater:downloaded', { version: info.version })
  })

  autoUpdater.on('error', (err: Error) => {
    const message = err?.message ?? String(err)
    const wasInteractive = interactive
    interactive = false
    if (wasInteractive) {
      send('updater:error', { message, manual: true })
    } else {
      // 启动静默检查失败：仅记录，不打扰用户（国内访问 GitHub 超时很常见）
      console.warn('[updater] 静默检查/更新失败:', message)
    }
  })
}

/**
 * 检查更新。
 * @param manual 是否用户手动触发（手动失败才弹错）
 */
async function checkForUpdates(manual: boolean): Promise<{ triggered: boolean; portable?: boolean; dev?: boolean; unsupported?: boolean }> {
  // 便携版无法原地替换自身，不走自动更新，引导手动下载
  if (isPortable()) return { triggered: false, portable: true }
  // 开发模式（未打包）下 electron-updater 会因缺少 app-update.yml 抛错，直接跳过
  if (!app.isPackaged) return { triggered: false, dev: true }
  // 仅 Windows NSIS 安装版支持自动更新；mac/linux 打包不触发（Spec §4.9）
  if (!isAutoUpdateSupported()) return { triggered: false, unsupported: true }

  interactive = manual
  try {
    await autoUpdater.checkForUpdates()
    return { triggered: true }
  } catch (err) {
    // checkForUpdates 内部抛错也会触发 'error' 事件；此处兜底，避免 unhandled rejection
    console.warn('[updater] checkForUpdates 异常:', err)
    return { triggered: true }
  }
}

/**
 * 初始化在线更新：注册事件与 IPC handlers。
 * 在 app.whenReady 后调用。
 *
 * 注意：启动静默检查由渲染层 update-store.init() 在订阅完事件后主动触发
 * （ipc.invoke('updater:check', false)），而非在此处自动 fire——避免主进程
 * 检查事件早于渲染层订阅导致 updater:available 竞态丢失。
 */
export function initAutoUpdater(ipcMain: Electron.IpcMain): void {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  wireEvents()

  ipcMain.handle('updater:check', (_e, manual?: boolean) => checkForUpdates(!!manual))

  ipcMain.handle('updater:start-download', async () => {
    interactive = true
    try {
      await autoUpdater.downloadUpdate()
      return { ok: true }
    } catch (err) {
      // downloadUpdate 拒绝但未必触发 'error' 事件，此处兜底复位 interactive，
      // 避免标志残留导致后续非交互式错误被误判为需弹窗
      interactive = false
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('updater:quit-and-install', () => {
    // isSilent=false 保留 NSIS 安装界面，isForceRunAfter=true 装完自动重启
    autoUpdater.quitAndInstall(false, true)
  })

  ipcMain.handle('updater:open-releases', () => {
    shell.openExternal(RELEASES_URL)
  })
}

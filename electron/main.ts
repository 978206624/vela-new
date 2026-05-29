import { app, BrowserWindow, ipcMain } from 'electron'
import { registerIPCHandlers } from './ipc-handlers'
import { registerMCPHandlers } from './mcp/mcp-ipc-bridge'
import { initAutoUpdater } from './updater'

import { fileURLToPath } from 'node:url'
import path from 'node:path'


const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 构建产物目录结构
process.env.APP_ROOT = path.join(__dirname, '..')

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

let win: BrowserWindow | null

export function getCurrentWindow() {
  return win
}

function createWindow() {
  const isMac = process.platform === 'darwin'

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'Vela — AI 小说创作 IDE',
    icon: path.join(process.env.APP_ROOT!, 'build', 'icon.png'),
    // macOS 使用原生隐藏式标题栏；Windows/Linux 用 frame:false 完全自定义
    frame: isMac ? true : false,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 12, y: 10 },
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      // 安全性设置
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  if (process.platform === 'darwin') {
    app.dock?.setIcon(path.join(process.env.APP_ROOT!, 'build', 'icon.png'))
  }

  // 隐藏默认菜单栏（Windows/Linux）
  win.setMenuBarVisibility(false)

  // 向渲染进程推送最大化状态变化 —— 自定义标题栏的最大化/还原图标据此同步，
  // 覆盖双击标题栏、拖到屏幕顶端、OS 快捷键等非按钮触发的状态变更
  const sendMaximizedState = () => {
    win?.webContents.send('window:maximized-changed', win.isMaximized())
  }
  win.on('maximize', sendMaximizedState)
  win.on('unmaximize', sendMaximizedState)

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

// macOS: 关闭所有窗口不退出
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

// macOS: 点击 dock 图标重新创建窗口
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.whenReady().then(() => {
  registerIPCHandlers()
  registerMCPHandlers()
  createWindow()
  // 在线更新：注册 IPC + 启动静默检查（需窗口已创建以接收更新事件）
  initAutoUpdater(ipcMain)
})

import { create } from 'zustand'
import { ipc } from '../services/ipc-client'
import type { ProjectData, NovelConfig, FileNode } from '../shared/ipc-channels'
import { alertError } from '../components/ui/AlertDialog'

/**
 * 从 currentProject 中提取纯净的 ProjectData 字段，
 * 防止 Zustand 状态中混入非序列化属性导致 Electron IPC structured clone 挂起。
 */
function toPlainProjectData(p: ProjectData): ProjectData {
  return {
    id: p.id,
    name: p.name,
    path: p.path,
    novelConfig: p.novelConfig ? { ...p.novelConfig } : p.novelConfig,
    characterStates: p.characterStates,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }
}

/** 给 Promise 包裹超时保护，防止 IPC 调用永远不返回 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[${label}] 超时 (${ms}ms)`))
    }, ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}
// 延迟导入 ProjectService，避免循环依赖
let _onProjectOpened: (() => Promise<void>) | null = null
let _onProjectClosed: ((closingToken?: number) => Promise<void>) | null = null
async function callProjectOpened() {
  if (!_onProjectOpened) {
    const { onProjectOpened } = await import('../services/project-service')
    _onProjectOpened = onProjectOpened
  }
  await _onProjectOpened()
}
async function callProjectClosed(closingToken?: number) {
  if (!_onProjectClosed) {
    const { onProjectClosed } = await import('../services/project-service')
    _onProjectClosed = onProjectClosed
  }
  await _onProjectClosed(closingToken)
}

interface ProjectState {
  /** 当前打开的项目 */
  currentProject: ProjectData | null
  /**
   * 主进程返回的 currentProject token，每次 project:open 单调递增。
   * 关闭项目时回传给主进程做 stale-write guard，避免"关 A → 立即开 A"
   * 的同路径竞态把刚开的项目误清成 null。
   */
  currentToken: number | null
  /** 项目文件树 */
  fileTree: FileNode[]
  /** 最近项目列表 */
  recentProjects: Array<{ name: string; path: string; updatedAt: string }>
  /** 是否正在加载 */
  loading: boolean

  // ===== Actions =====
  /** 新建项目 */
  createProject: (config: {
    name: string
    path: string
    genre: string
    targetAudience: string
  }) => Promise<boolean>
  /** 打开项目 */
  openProject: (projectPath: string) => Promise<boolean>
  /** 保存项目 */
  saveProject: () => Promise<boolean>
  /** 更新小说配置 */
  updateNovelConfig: (config: Partial<NovelConfig>) => void
  /** 刷新文件树 */
  refreshFileTree: () => Promise<void>
  /** 加载最近项目 */
  loadRecentProjects: () => Promise<void>
  /** 移除单个最近项目 */
  removeRecentProject: (projectPath: string) => Promise<void>
  /** 关闭项目（可 await：确保 Agent 取消收尾 + 内存重置在切库前完成） */
  closeProject: () => Promise<void>
  /** 更新角色状态（内存 + 持久化） */
  updateCharacterStates: (states: string) => Promise<void>
}

export const useProjectStore = create<ProjectState>()((set, get) => ({
  currentProject: null,
  currentToken: null,
  fileTree: [],
  recentProjects: [],
  loading: false,

  createProject: async (config) => {
    set({ loading: true })
    try {
      const result = await ipc.invoke('project:create', config)
      if (!result.success) {
        console.error('[Project] 创建失败:', result.error)
        alertError(result.error ?? '未知错误', { title: '创建项目失败' })
        return false
      }
      // 使用主进程返回的实际项目路径（跨平台安全，避免路径分隔符问题）
      const projectDir = result.projectPath ?? `${config.path}/${config.name}`
      return get().openProject(projectDir)
    } catch (e) {
      console.error('[Project] createProject 异常:', e)
      alertError(String(e), { title: '创建项目异常' })
      return false
    } finally {
      set({ loading: false })
    }
  },


  openProject: async (projectPath) => {
    // 多入口切项目（ActivityBar / HomeSidebarPanel 等）若不先关旧项目，会绕过生命周期：
    // 旧项目的 Agent 取消收尾不触发、内存对话不清空 → 串库/串台。
    // 顶部先 await 关闭当前项目，确保切库前收尾完成（后端 token guard 为第二层兜底）。
    if (get().currentProject) {
      await get().closeProject()
    }
    set({ loading: true })
    try {
      const result = await ipc.invoke('project:open', projectPath)
      if (result.success && result.project) {
        set({ currentProject: result.project, currentToken: result.currentToken ?? null })
        // 加载文件树
        await get().refreshFileTree()
        // 自动展开侧边栏并切换到项目结构视图
        const { useLayoutStore } = await import('./layout-store')
        useLayoutStore.setState({ sidebarOpen: true, sidebarView: 'project' })
        // 统一初始化 Layer 2 Store（角色卡、草稿等）
        await callProjectOpened()
        return true
      }
      console.error('[Project] 打开失败:', result.error)
      alertError(result.error ?? '未知错误', { title: '打开项目失败' })
      return false
    } catch (e) {
      console.error('[Project] IPC 通信异常:', e)
      try { await ipc.invoke('fs:write-file', '/tmp/vela_error.log', String(e)) } catch { /* ignore error writing to log */ }
      alertError(String(e), { title: '打开项目异常' })
      return false
    } finally {
      set({ loading: false })
    }
  },

  saveProject: async () => {
    const project = get().currentProject
    console.log('[project-store.saveProject] 开始保存，项目ID:', project?.id)
    if (!project) {
      console.log('[project-store.saveProject] 项目为空，跳过保存')
      return false
    }
    try {
      // 提取纯净数据，防止 structured clone 序列化异常属性
      const plainData = toPlainProjectData(project)
      console.log('[project-store.saveProject] 准备调用 IPC，数据大小:', JSON.stringify(plainData).length)
      const result = await withTimeout(
        ipc.invoke('project:save', plainData.id, plainData),
        15_000,
        'project:save',
      )
      console.log('[project-store.saveProject] IPC 调用完成，结果:', result)
      return result.success
    } catch (err) {
      console.error('[project-store.saveProject] 保存失败:', err)
      return false
    }
  },

  updateNovelConfig: (config) => {
    const project = get().currentProject
    if (!project) return
    set({
      currentProject: {
        ...project,
        novelConfig: { ...project.novelConfig, ...config },
      },
    })
  },

  refreshFileTree: async () => {
    const project = get().currentProject
    if (!project) return
    const tree = await ipc.invoke('fs:list-dir', project.path)
    set({ fileTree: tree })
  },

  loadRecentProjects: async () => {
    const list = await ipc.invoke('project:recent-list')
    set({ recentProjects: list })
  },

  removeRecentProject: async (projectPath: string) => {
    await ipc.invoke('project:recent-remove', projectPath)
    // 从本地状态移除
    set((s) => ({
      recentProjects: s.recentProjects.filter((p) => p.path !== projectPath),
    }))
  },

  closeProject: async () => {
    const closingPath = get().currentProject?.path ?? null
    const closingToken = get().currentToken ?? undefined
    // 统一清空 Layer 2 Store + 编辑器 Tab + Agent 取消收尾（用 closingToken 落进源项目库）。
    // await 确保收尾在「主进程切库」之前完成——openProject 顶部先 await closeProject 即靠此。
    await callProjectClosed(closingToken)
    set({ currentProject: null, currentToken: null, fileTree: [] })
    // 通知主进程清空"当前项目"，避免 KB 等 IPC 仍命中旧项目。
    // 带 path + token 双 guard：如果此调用晚于下一次 open 到达主进程，
    // token 已经递增（不再等于 closingToken），主进程跳过清空，避免误清。
    // 单 path 在 close A → reopen A 的同路径场景下挡不住，token 单调递增可以。
    void ipc.invoke('project:set-current', null, closingPath, closingToken)
  },

  updateCharacterStates: async (states) => {
    const project = get().currentProject
    if (!project) return
    const updated = { ...project, characterStates: states }
    set({ currentProject: updated })
    try {
      await withTimeout(
        ipc.invoke('project:save', project.id, toPlainProjectData(updated)),
        15_000,
        'project:save(characterStates)',
      )
    } catch (err) {
      console.error('[project-store.updateCharacterStates] 持久化失败:', err)
    }
    // 【迁移优化】: project:save 已经持久化到 project_core 表的 characterStates 字段，
    // 此处无需为了全局（-1）再进行一次 db:save-summary-snapshot 的冗余调用。
    // try {
    //   await ipc.invoke('db:save-summary-snapshot', -1, states)
    // } catch { /* SQLite 可能未初始化 */ }
  },
}))

import { create } from 'zustand'
import { ipc } from '../services/ipc-client'
import type { ProjectData, NovelConfig, FileNode, ProjectSavePatch } from '../shared/ipc-channels'
import { alertError } from '../components/ui/AlertDialog'

/**
 * 从 currentProject 中提取纯净的 ProjectData 字段，
 * 防止 Zustand 状态中混入非序列化属性导致 Electron IPC structured clone 挂起。
 */
function toPlainPatch(patch: ProjectSavePatch): ProjectSavePatch {
  // 逐层浅拷贝即可：补丁只有一层嵌套（novelConfig），且其值全是字符串/数字
  return {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.characterStates !== undefined ? { characterStates: patch.characterStates } : {}),
    ...(patch.novelConfig ? { novelConfig: { ...patch.novelConfig } } : {}),
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
  /**
   * `project_core` 的版本号。保存时原样带回主进程做 CAS。
   *
   * 任何**主进程侧**对 project_core 的写入都会让它 +1（续卷、`db:project-core-update`…），
   * 那些路径必须把新值同步回这里，否则下一次保存会拿着过期版本被判冲突。
   * `null` = 尚未打开项目 / 未知，此时保存一律拒绝（fail-closed）。
   */
  coreRevision: number | null
  /**
   * **尚未持久化**的 novelConfig 字段名集合（脏字段）。
   *
   * 放在 store 而不是编辑器组件的 ref 里，是因为改内存的路径不止编辑器一条：
   * AI 生成、Agent 工具、导入推演都直接调 `updateNovelConfig`。挂在组件上时，
   * 那些改动对「有没有未保存内容」完全不可见——编辑器会显示「没有改动，无需保存」，
   * 而那些内容确实还没落库。
   *
   * **归属由 `pendingConfigToken` 决定**，不靠「每条切项目路径都记得清空」。
   * 脏字段属于某个具体项目，带到下一个项目会把 A 的字段名当成 B 的未保存改动发出去；
   * 而切项目的入口不止一处（openProject / closeProject / 各种多入口切换），
   * 靠每处自觉清理，漏一处就是一个静默的串项目缺陷。
   * 读取一律用 `selectPendingConfigFields`，token 不符时视为空集。
   */
  pendingConfigFields: Set<keyof NovelConfig>
  /** `pendingConfigFields` 属于哪个项目；与 `currentToken` 不符即整份作废 */
  pendingConfigToken: number | null
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
  /**
   * 保存项目配置。
   *
   * **必须传 patch，且只放本次真正改动的字段**。
   * 参数不设默认值是刻意的——旧签名无参、内部发整份快照，
   * 于是「读于某次主进程写入之前的旧值」会随保存一起落地把新值覆盖回去。
   * 强制显式传入，让每个调用点都得说清自己改了什么。
   *
   * 返回**可区分**的结果，不是一个 boolean——四种结果的善后完全不同。
   * 详见 `SaveProjectResult` 的文档（那里写了「库里有没有」与「内存还在不在」
   * 这两条**正交**的区分）。一句话版本：
   * `conflict` 已重载 → 清脏标记；`error` 项目还开着、改动还在 → **保留**脏标记；
   * `project-switched` 原项目已被 `closeProject()` 连同脏集合清空 → 无从保留。
   *
   * `expectedToken`：调用方在**动作入口、任何 await 之前**捕获的项目 token。
   * 同样必填、同样不设默认值——工作流命令在 LLM 调用（分钟级）之后才写库，
   * 此刻现取会拿到用户切换后那个项目的**合法** token，主进程守卫原样放行，
   * 于是 A 的生成结果被写进 B。参数强制显式传入，让漏传在编译期就暴露。
   */
  saveProject: (patch: ProjectSavePatch, expectedToken: number | undefined) => Promise<SaveProjectResult>
  /**
   * 从库里重读 project_core，覆盖内存配置并对齐版本号。
   *
   * 返回**可区分**结果：调用方（`saveProject` 的 conflict 分支）必须知道
   * 重载到底有没有发生。静默 return 会让它照样回 `conflict`，
   * 而 `conflict` 的语义是「已重载、你的改动已作废」——
   * 于是调用方清掉脏标记，可内存里根本没换成新值。
   */
  reloadProjectCore: (expectedToken: number | undefined) => Promise<'reloaded' | 'project-switched' | 'error'>
  /** 更新小说配置 */
  /**
   * 改内存中的 novelConfig，并把涉及的字段登记为「未持久化」。
   * `opts.persisted` 表示这些值**来自数据库**（冲突重载 / 写库成功后的别名同步），
   * 此时应从脏字段里移除而非加入。
   */
  updateNovelConfig: (config: Partial<NovelConfig>, opts?: { persisted?: boolean }) => void
  /** 刷新文件树 */
  refreshFileTree: () => Promise<void>
  /** 加载最近项目 */
  loadRecentProjects: () => Promise<void>
  /** 移除单个最近项目 */
  removeRecentProject: (projectPath: string) => Promise<void>
  /** 关闭项目（可 await：确保 Agent 取消收尾 + 内存重置在切库前完成） */
  closeProject: () => Promise<void>
  /**
   * 更新角色状态（内存 + 持久化）。
   * `expectedToken` 必填、且在**改内存之前**核对——本函数目前无调用点，
   * 但签名先立好：让将来的调用方无法漏传（漏传就是 A 的角色状态写进 B）。
   */
  updateCharacterStates: (states: string, expectedToken: number | undefined) => Promise<void>
}

/**
 * `saveProject` 的结果。刻意做成可区分联合而不是 boolean——
 * 「保存没成功」有四种截然不同的成因，善后方式互不相同：
 *
 * - `success`：**确认**写入成功，`revision` 是新版本号
 * - `conflict`：版本冲突，主进程明确拒绝了写入。已重载最新配置到内存，
 *   **用户此前的改动已不存在**，调用方应清掉本地脏标记
 * - `project-switched`：项目已切换。**不代表一定没落库**——切换可能发生在
 *   主进程写入成功之后、回包到达之前。它表达的是「这次写入不属于当前项目，
 *   当前上下文不该据此更新任何状态」。
 *   ⚠️ 此时**原项目的内存配置与脏集合已经被 `closeProject()` 清空了**
 *   （切项目一律先 close 再 open）。所以这里不存在「保留脏标记」这回事——
 *   那份改动已经不在内存里，调用方的文案也不该说「改动仍保留在编辑器里」
 * - `error`：IPC 超时 / 主进程异常。**同样不代表一定没落库**——15 秒超时
 *   不会取消已经发出的 IPC，主进程那边可能正常写完了。
 *   与上一种不同：项目**还开着**，改动确实还在内存和界面里，
 *   脏集合也还在——调用方**必须保留**它，用户可以重存
 *
 * ⚠️ 两条正交的区分，别混为一谈：
 * ① **库里到底有没有**：只有 `success` 是「确认写入」、`conflict` 是「确认未写入」，
 *    另外两种**不确定**（超时不取消已发出的 IPC；切换可能发生在写入之后）。
 * ② **内存里那份改动还在不在**：`error` 时项目还开着、改动还在；
 *    `project-switched` 时原项目已被 `closeProject()` 清空、改动已不存在。
 *
 * 早先返回 boolean 时，调用方只能把所有 false 当成「已重载」，
 * 于是一次普通的 IPC 失败就会清掉脏标记、静默丢掉用户的编辑。
 */
export type SaveProjectResult =
  | { kind: 'success'; revision: number | undefined }
  | { kind: 'conflict' }
  | { kind: 'project-switched' }
  | { kind: 'error'; message: string }

/**
 * 读取当前项目的未保存字段。**一律用它，不要直接读 `pendingConfigFields`**——
 * 那份集合可能属于上一个项目，直接读会把 A 的字段名当成 B 的未保存改动。
 */
export const selectPendingConfigFields = (s: ProjectState): Set<keyof NovelConfig> =>
  s.pendingConfigToken === s.currentToken ? s.pendingConfigFields : EMPTY_FIELDS

/** 稳定的空集引用：每次新建会让 zustand 的浅比较判定为变化，导致无谓重渲染 */
const EMPTY_FIELDS: Set<keyof NovelConfig> = new Set()

export const useProjectStore = create<ProjectState>()((set, get) => ({
  currentProject: null,
  currentToken: null,
  coreRevision: null,
  pendingConfigFields: new Set(),
  pendingConfigToken: null,
  fileTree: [],
  recentProjects: [],
  loading: false,

  createProject: async (config) => {
    // 必须先关旧项目再 create：project:create 会 initProjectDatabase 切到新库但不改 token，
    // 若旧项目还开着，关旧项目时的 Agent 取消收尾落库会 guard 放行写进新库（串库）。
    // 先 await closeProject：此时旧库仍是当前库、token 仍是旧值，收尾落进旧库，且 db:close 后再 create。
    if (get().currentProject) await get().closeProject()
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
        set({
          currentProject: result.project,
          currentToken: result.currentToken ?? null,
          coreRevision: result.coreRevision ?? null,
          // 新项目从干净状态开始（token 派生已保证这一点，这里显式清一次是为了
          // 让内存不留无用引用，不是正确性所依赖的那一道）
          pendingConfigFields: new Set(),
          pendingConfigToken: null,
        })
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

  reloadProjectCore: async (expectedToken) => {
    const project = get().currentProject
    if (!project) return 'error'
    // 起点就要核对：调用方捕获 token 之后到这里之间可能已经切走
    if (expectedToken === undefined || get().currentToken !== expectedToken) return 'project-switched'
    const core = await ipc.invoke('db:project-core-get')
    // 重读期间用户可能又切走了：把 A 的配置盖进 B 比不重载更糟
    if (get().currentToken !== expectedToken) return 'project-switched'
    if (!core) return 'error'
    // 重载来的值与库完全一致 → 脏集合整体清空（**只有这里**能整体清空：
    // 内存里已经不存在任何未持久化的改动了）
    set({
      pendingConfigFields: new Set(),
      pendingConfigToken: expectedToken ?? null,
      currentProject: {
        ...get().currentProject!,
        name: core.projectName,
        characterStates: core.characterStates,
        novelConfig: {
          ...get().currentProject!.novelConfig,
          genre: core.genre,
          subGenre: core.subGenre,
          targetAudience: core.targetAudience,
          totalChapters: core.totalChapters,
          wordsPerChapter: core.wordsPerChapter,
          plotStructure: core.plotStructure as NovelConfig['plotStructure'],
          narrativePOV: core.narrativePov as NovelConfig['narrativePOV'],
          coreOutline: core.synopsis,
          worldSetting: core.worldbuilding,
          protagonistProfile: core.charactersArch,
          goldenFinger: core.goldenFinger,
          globalGuidance: core.globalGuidance,
          writingStyle: core.writingStyle,
          referenceWorks: core.referenceWorks,
        },
      },
      coreRevision: core.revision,
    })
    return 'reloaded'
  },

  saveProject: async (patch, expectedToken) => {
    const project = get().currentProject
    if (!project) return { kind: 'error', message: '未打开项目' }

    // 发请求之前先自查一次：调用方捕获 token 之后到这里之间可能已经切走了。
    // 不早退也能被主进程拦下，但那样会白跑一趟 IPC，且日志里看不出是哪一步失效的
    if (expectedToken === undefined || get().currentToken !== expectedToken) {
      console.warn('[project-store.saveProject] 项目已切换，放弃本次保存')
      return { kind: 'project-switched' }
    }

    const expectedRevision = get().coreRevision
    // fail-closed：版本未知就不写。放行等于把 CAS 关掉，
    // 而「未知」恰恰出现在项目刚切换、状态还没对齐的时刻——最该拦的时候。
    // 归类为 error 而非 conflict：什么都没重载，调用方的脏标记必须留着
    if (expectedRevision === null) {
      console.warn('[project-store.saveProject] coreRevision 未知，拒绝保存')
      return { kind: 'error', message: '项目版本号未知，保存已取消' }
    }

    // 回包应用到 store 之前还要再核对一次——IPC 是异步的，
    // A 的回包完全可能在用户切到 B 之后才到，那时把 A 的 revision 写进 B
    // 会让 B 的版本号错位：要么放行本该拒绝的写入，要么反复误报冲突
    const actionToken = expectedToken

    // 本次实际提交的**字段与值**。成功后按「值是否还等于提交时那份」逐字段清理。
    //
    // 只记字段名是不够的：用户可能在 IPC 等待期间把**同一个字段**从 v1 改成 v2。
    // 那时库里是 v1、内存是 v2，而字段名相同——按名字清理会把它从脏集合里删掉，
    // 于是 v2 永远不会被保存，界面还显示「没有改动」。
    const submitted = Object.entries(patch.novelConfig ?? {}) as Array<
      [keyof NovelConfig, NovelConfig[keyof NovelConfig]]
    >

    try {
      const result = await withTimeout(
        ipc.invoke('project:save', project.id, toPlainPatch(patch), expectedRevision, actionToken),
        15_000,
        'project:save',
      )
      // 回包的一切副作用都以「项目没变」为前提
      if (get().currentToken !== actionToken) {
        console.warn('[project-store.saveProject] 回包晚于项目切换，已丢弃')
        return { kind: 'project-switched' }
      }
      if (result.success) {
        const remaining = get().pendingConfigToken === actionToken
          ? new Set(get().pendingConfigFields)
          : new Set<keyof NovelConfig>()
        // 只清「值仍等于提交时那份」的字段。等待期间被改成别的值的，
        // 库里存的是旧值，必须继续留在脏集合里等下一次保存
        const nowConfig = get().currentProject?.novelConfig
        for (const [k, v] of submitted) {
          if (nowConfig && nowConfig[k] === v) remaining.delete(k)
        }
        set({
          ...(result.revision !== undefined ? { coreRevision: result.revision } : {}),
          pendingConfigFields: remaining,
          pendingConfigToken: actionToken ?? null,
        })
        return { kind: 'success', revision: result.revision }
      }
      if (result.stale) {
        // ⚠️ 必须按成因分派。上面那道回包 token 复核挡不住所有跨项目情形——
        // 「主进程已切库、渲染层状态更新还没跑到」时两侧 token 仍相等，
        // 拒绝来自主进程。把它当成版本冲突去重载，会把当前项目的配置
        // 无谓重读一遍，还清掉用户的脏标记
        if (result.staleReason === 'token') {
          return { kind: 'project-switched' }
        }
        // 版本冲突：库里有更新的内容，内存那份已经不能再拿去覆盖了。
        // **只有真的重载成功才能回 conflict** —— 那个种类的语义就是
        // 「已重载、你的改动已作废」，调用方据此清脏标记
        const reload = await get().reloadProjectCore(actionToken)
        if (reload === 'project-switched') return { kind: 'project-switched' }
        if (reload === 'error') {
          return { kind: 'error', message: '配置已被其它操作更新，但重新加载失败，请手动刷新' }
        }
        // 提示失败**不得改变结论**：重载已经发生，调用方必须收到 conflict
        // 才会正确清掉脏标记。早先 toast 的动态 import 抛错会被外层 catch 吞成
        // error，于是调用方以为「只是没存上」而保留了已经作废的脏标记
        try {
          const { toast } = await import('../components/ui/Toast')
          toast.warning('项目已被其它操作更新，已重新加载最新内容')
        } catch (e) {
          console.warn('[project-store.saveProject] 冲突提示未能显示:', e)
        }
        return { kind: 'conflict' }
      }
      console.error('[project-store.saveProject] 保存失败:', result.error)
      return { kind: 'error', message: result.error ?? '未知错误' }
    } catch (err) {
      console.error('[project-store.saveProject] 保存失败:', err)
      return { kind: 'error', message: String(err) }
    }
  },

  updateNovelConfig: (config, opts) => {
    const project = get().currentProject
    if (!project) return
    // 所有改内存的路径都在这里登记脏字段——编辑器、AI 生成、Agent 工具、导入推演。
    // `opts.persisted:true` 用于「值来自数据库」的场景（冲突重载、写库成功后的
    // 别名同步）：那些字段已经和库一致，登记成脏会让下一次保存把它们再发一遍
    // 脏集合按 token 归属：不属于当前项目的那份直接丢弃、从空集重来
    const token = get().currentToken
    const next = get().pendingConfigToken === token
      ? new Set(get().pendingConfigFields)
      : new Set<keyof NovelConfig>()
    if (opts?.persisted) {
      for (const k of Object.keys(config)) next.delete(k as keyof NovelConfig)
    } else {
      for (const k of Object.keys(config)) next.add(k as keyof NovelConfig)
    }
    set({
      currentProject: {
        ...project,
        novelConfig: { ...project.novelConfig, ...config },
      },
      pendingConfigFields: next,
      pendingConfigToken: token,
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
    // 连同脏集合一起清空：那些未保存的改动属于**正在关闭的这个项目**，
    // 留着会在下一个项目里被当成它的未保存改动发出去。
    // 代价是「关项目 = 丢弃未保存的配置改动」——这是有意的取舍，
    // 也是 `saveProject` 返回 project-switched 时文案不能说「改动仍保留」的原因
    set({ currentProject: null, currentToken: null, coreRevision: null, pendingConfigFields: new Set(), pendingConfigToken: null, fileTree: [] })
    // 通知主进程清空"当前项目"，避免 KB 等 IPC 仍命中旧项目。
    // 带 path + token 双 guard：如果此调用晚于下一次 open 到达主进程，
    // token 已经递增（不再等于 closingToken），主进程跳过清空，避免误清。
    // 单 path 在 close A → reopen A 的同路径场景下挡不住，token 单调递增可以。
    void ipc.invoke('project:set-current', null, closingPath, closingToken)
    // 关闭项目库：否则 projectDb 仍开着，无项目时 Agent 面板仍可发消息/清空，
    // 会写进上一个项目的对话表（串库）。收尾落库已在 callProjectClosed 内完成。
    try { await ipc.invoke('db:close') } catch { /* 关库失败不阻塞 */ }
  },

  updateCharacterStates: async (states, expectedToken) => {
    const project = get().currentProject
    if (!project) return
    // ⚠️ 改内存**之前**核对。本函数会被定稿后处理这类长流程调用，
    // 到这里时项目可能早已切走；先改内存再判断，等于把 A 的角色状态
    // 写进了 B 的编辑器——IPC 被拒也撤不回来
    if (expectedToken === undefined || get().currentToken !== expectedToken) {
      console.warn('[project-store.updateCharacterStates] 项目已切换，放弃本次更新')
      return
    }
    const updated = { ...project, characterStates: states }
    set({ currentProject: updated })
    try {
      // 只发 characterStates 这一个字段：它由定稿后处理写入，
      // 而此刻内存里的 novelConfig 可能是续卷之前的旧值，一并发出去就会覆盖新值
      const res = await get().saveProject({ characterStates: states }, expectedToken)
      if (res.kind !== 'success') {
        // conflict 是确认未写入；另两种只能说未能确认
        console.warn(res.kind === 'conflict'
          ? '[project-store.updateCharacterStates] 未写入：配置已被其它操作更新'
          : `[project-store.updateCharacterStates] 持久化未能确认：${res.kind}`)
      }
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

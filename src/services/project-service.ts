/**
 * ProjectService — 项目生命周期与跨 Store 协调的单例调度层
 *
 * 职责：
 * 1. 项目打开/关闭时统一初始化/清空 Layer 2 Store（character、draft）
 * 2. 监听 EventBus 事件，驱动 Store 数据刷新
 * 3. 同步 editor-store 中已打开 Tab 的内容（定稿后磁盘文件已变更的场景）
 *
 * 设计原则：
 * - 组件不再自行 useEffect 加载数据、不再监听 window 事件
 * - 所有跨 Store 联动都经过此 Service
 * - Store 只暴露纯数据 + 操作方法，不包含生命周期逻辑
 */

import { globalEventBus } from '../shared/event-bus'
import { useProjectStore } from '../stores/project-store'
import { useCharacterStore, coerceRole } from '../stores/character-store'
import { coerceChapterRole } from '../shared/chapter-roles'
import { useDraftStore } from '../stores/draft-store'
import { useAgentStore } from '../stores/agent-store'
import { ipc } from './ipc-client'

/** 存放解绑函数，用于 dispose 时清理 */
let disposers: Array<() => void> = []

/**
 * 初始化 ProjectService — 注册所有事件监听
 * 应在 App 挂载时调用一次
 */
export function initProjectService(): void {
  // 防止重复初始化
  if (disposers.length > 0) return

  // === 监听 EventBus 事件 ===

  // 工作流完成 → 刷新文件树 + 草稿（覆盖所有工作流类型）
  disposers.push(
    globalEventBus.on('WORKFLOW_COMPLETE', async (payload) => {
      console.log('[ProjectService] WORKFLOW_COMPLETE 事件触发:', payload.type)
      const project = useProjectStore.getState().currentProject
      if (!project) return

      // config_generation 类型只需要轻量刷新（避免不必要的文件扫描）
      if (payload.type === 'config_generation') {
        console.log('[ProjectService] config_generation 完成，跳过资源刷新')
        return
      }

      // 刷新文件树（所有工作流完成后都需要）
      console.log('[ProjectService] 开始刷新文件树...')
      await useProjectStore.getState().refreshFileTree()
      console.log('[ProjectService] 文件树刷新完成')

      // 根据工作流类型精准刷新
      if (payload.type === 'chapter_creation') {
        // 章节创作完成 → 刷新草稿 + 角色卡（定稿后处理会更新角色状态）
        console.log('[ProjectService] 刷新草稿和角色卡...')
        await Promise.all([
          useDraftStore.getState().loadAllDrafts(),
          useCharacterStore.getState().load(),
        ])
        console.log('[ProjectService] 草稿和角色卡刷新完成')
      } else if (payload.type === 'architecture_generation') {
        // 架构生成完成 → 角色卡可能被提取
        console.log('[ProjectService] 刷新角色卡...')
        await useCharacterStore.getState().load()
        console.log('[ProjectService] 角色卡刷新完成')
      }
    })
  )

  // 定稿完成 → 刷新草稿 + 角色 + 文件树 + 同步编辑器 Tab
  disposers.push(
    globalEventBus.on('FINALIZE_COMPLETE', async (payload) => {
      const project = useProjectStore.getState().currentProject
      if (!project) return

      await Promise.all([
        useDraftStore.getState().loadChapterDrafts(payload.chapterNumber),
        useCharacterStore.getState().load(),
        useProjectStore.getState().refreshFileTree(),
      ])

      // 同步编辑器中已打开的相关 Tab 内容（草稿文件可能已被定稿流程修改）
      syncEditorTabsForChapter(payload.chapterNumber)
    })
  )

  // 架构后处理完成 → 刷新角色卡
  disposers.push(
    globalEventBus.on('ARCH_POSTPROCESS_UPDATED', async () => {
      await useCharacterStore.getState().load()
    })
  )

  // 角色卡提取失败 → 也刷新角色卡（确保 UI 状态一致）
  disposers.push(
    globalEventBus.on('CHARACTER_EXTRACT_FAILED', async () => {
      await useCharacterStore.getState().load()
    })
  )

  // 资源刷新请求（由知识库等模块触发）
  disposers.push(
    globalEventBus.on('REFRESH_RESOURCE', async (payload) => {
      const resources = payload.resources
      if (resources.includes('all') || resources.includes('characterCards')) {
        await useCharacterStore.getState().load()
      }
      if (resources.includes('all') || resources.includes('drafts')) {
        await useDraftStore.getState().loadAllDrafts()
      }
      if (resources.includes('all') || resources.includes('fileTree')) {
        await useProjectStore.getState().refreshFileTree()
      }
    })
  )

  console.log('[ProjectService] 已初始化，事件监听已注册')
}

/**
 * 一次性归一历史脏数据：列表外角色 role → coerceRole → 4 枚举，逐个写回（只动 role 变了的）。
 * 幂等：合法 role 满足 `role === coerceRole(role)`，跳过；故重复打开项目不会反复写。
 * 单个失败跳过、不阻塞项目打开。
 */
async function normalizeCharacterRoles(): Promise<void> {
  const store = useCharacterStore.getState()
  const offList = store.characters.filter(c => c.role !== coerceRole(c.role))
  if (offList.length === 0) return
  let fixed = 0
  for (const c of offList) {
    const role = coerceRole(c.role)
    try {
      // upsert 用 c（含 currentState，rowToData 已带出）整卡写回、仅 role 变更；项目打开期无并发后处理，无 cs_* 竞态
      const res = await ipc.invoke('db:character-upsert', { ...c, role })
      // 该 IPC 写库失败时返回 {success:false} 而非抛错——必须检查，
      // 否则内存被改成合法值、库没改，下次打开幻影又回来（清洗形同未做）。
      if (!res.success) {
        console.warn(`[ProjectService] 角色定位归一失败：${c.name}`, res.error)
        continue
      }
      store.updateField(c.name, 'role', role)
      fixed++
    } catch {
      /* 单个失败跳过 */
    }
  }
  if (fixed > 0) console.log(`[ProjectService] 已归一 ${fixed}/${offList.length} 个列表外角色定位`)
}

/**
 * 一次性归一历史脏数据：列表外章节定位 role → coerceChapterRole → 7 项，逐个写回（只动 role 变了的）。
 * 与角色 role 同思路（消「章节定位」下拉幻影选项）。幂等：合法 role 满足 role === coerceChapterRole(role)，跳过。
 * 单个失败跳过、不阻塞项目打开。
 */
async function normalizeChapterRoles(): Promise<void> {
  const blueprints = await ipc.invoke('db:blueprint-get-all').catch(() => [])
  const offList = blueprints.filter((b) => b.role !== coerceChapterRole(b.role))
  if (offList.length === 0) return
  let fixed = 0
  for (const b of offList) {
    try {
      const res = await ipc.invoke('db:blueprint-upsert', { ...b, role: coerceChapterRole(b.role) })
      if (!res.success) {
        console.warn(`[ProjectService] 章节定位归一失败：第${b.chapterNumber}章`, res.error)
        continue
      }
      fixed++
    } catch {
      /* 单个失败跳过 */
    }
  }
  if (fixed > 0) console.log(`[ProjectService] 已归一 ${fixed}/${offList.length} 个列表外章节定位`)
}

/**
 * 项目打开后的初始化 — 并行加载所有 Layer 2 数据
 * 由 project-store.openProject 成功后调用
 */
export async function onProjectOpened(): Promise<void> {
  const project = useProjectStore.getState().currentProject
  if (!project) return

  // 并行加载角色卡、草稿列表、Agent 对话列表（此时项目库已 open，建表已完成）
  await Promise.all([
    useCharacterStore.getState().load(),
    useDraftStore.getState().loadAllDrafts(),
    useAgentStore.getState().loadConversations(),
  ])

  // 一次性归一历史脏数据：把列表外的角色 role（旧版定稿后处理存的中文如「配角」）
  // 经 coerceRole 归一为 4 枚举并写回，消除「定位」下拉幻影选项。幂等：已合法的跳过。
  await normalizeCharacterRoles()
  // 同思路归一章节定位 role（消下拉幻影选项），幂等、单个失败不阻塞
  await normalizeChapterRoles()

  // 广播项目已就绪事件
  globalEventBus.emit('PROJECT_CHANGED', { projectPath: project.path })

  console.log('[ProjectService] 项目数据加载完成:', project.path)
}

/**
 * 项目关闭时的清理 — 重置所有 Layer 2 Store
 * 由 project-store.closeProject 调用（可 await，确保切库前收尾完成）
 *
 * @param closingToken 关闭中项目的 token，传给 Agent 取消收尾，
 *   保证「源项目库已切走后到达的落库」被主进程 token guard 丢弃，不串库。
 */
export async function onProjectClosed(closingToken?: number): Promise<void> {
  // 先取消 Agent 在途生成并把收尾进度落进「源项目库」（用 closingToken），
  // 再清空内存对话，防上个项目对话串到下个项目。
  await useAgentStore.getState().cancelGenerationWithToken(closingToken)
  useAgentStore.getState().resetConversations()

  // 清空编辑器 Tab
  import('../stores/editor-store').then(m => {
    m.useEditorStore.getState().clearTabs()
  }).catch(() => { })

  // 重置 Layer 2 Store
  useCharacterStore.getState().reset()
  useDraftStore.getState().reset()

  console.log('[ProjectService] 项目已关闭，Layer 2 Store 已重置')
}

/**
 * 同步编辑器中某章节相关 Tab 的内容
 * 当定稿/修稿完成后，磁盘文件已变更，需要把最新内容同步到编辑器
 */
async function syncEditorTabsForChapter(chapterNumber: number): Promise<void> {
  try {
    const { useEditorStore } = await import('../stores/editor-store')
    const tabs = useEditorStore.getState().tabs

    // 找到与该章节相关的已打开 Tab（草稿文件路径包含 ch{N}）
    const chapterPattern = new RegExp(`/ch${chapterNumber}/`)
    const relatedTabs = tabs.filter(t => t.filePath && chapterPattern.test(t.filePath))

    for (const tab of relatedTabs) {
      if (!tab.filePath) continue
      let content = ''
      if (tab.filePath.startsWith('vela://')) {
        const { readDraftBody } = await import('../stores/draft-store')
        content = await readDraftBody(tab.filePath)
      } else {
        const result = await ipc.invoke('fs:read-file', tab.filePath)
        if (result.success) content = result.content
      }
      if (content) {
        useEditorStore.getState().syncTabContent(tab.id, content)
      }
    }
  } catch {
    // 编辑器模块可能未加载，忽略
  }
}

/**
 * 销毁 ProjectService — 清理所有事件监听
 * 通常在 App 卸载时调用
 */
export function disposeProjectService(): void {
  for (const dispose of disposers) {
    dispose()
  }
  disposers = []
  console.log('[ProjectService] 已销毁')
}

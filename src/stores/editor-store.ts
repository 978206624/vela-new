import { create } from 'zustand'
// 静态引入而非动态 import：动态 import 一旦抛错会被 .catch 吞掉，
// 「放弃修改并关闭」就会静默失效（Task 19.5 已经在 toast 上栽过同一个坑）。
// 两个模块都不反向依赖 editor-store，没有循环
import { discardVolumeDraftForTab } from './volume-draft-store'
import { discardVolumeRegenResultForTab } from './volume-regen-store'
import { getProjectToken } from './volume-store'

/** 编辑器 Tab 数据 */
export interface EditorTab {
  id: string
  name: string
  type: 'chapter' | 'outline' | 'character' | 'config' | 'diff' | 'chapter-card' | 'world-building' | 'arch-file' | 'version-history' | 'review-report' | 'volume-overview' | 'volume'
  filePath?: string
  content?: string
  /** diff 视图的原始内容 */
  originalContent?: string
  dirty?: boolean
  /** 固定 Tab，不可关闭 */
  pinned?: boolean
  /** 修稿文件路径（三栏合并用） */
  revisionPath?: string
  /** 审稿报告内容（供「根据意见修稿」使用） */
  reviewReport?: string
  /** 草稿所属章节号 */
  chapterNumber?: number
  /**
   * 卷详情 Tab 的卷序号（type='volume' 时必填）。
   *
   * 不从 tab id 里反解：id 是字符串拼出来的，解析失败会静默变成 NaN，
   * 而 NaN 一路传到 `volumes.find()` 只会「查不到这一卷」，
   * 表现成空白页而不是报错，排查时看不出是 id 格式变过。
   */
  volumeNumber?: number
  /** 草稿所在章节目录 */
  chapterDir?: string
  /** 审稿报告存放路径 */
  reportPath?: string
  /** 审稿报告对应的 review DB id（用于「已修」判定与修稿溯源；旧 tab 可能缺失） */
  reviewId?: number
}

interface EditorState {
  /** 打开的 Tab 列表 */
  tabs: EditorTab[]
  /** 当前活跃的 Tab ID */
  activeTabId: string | null

  // ===== Actions =====
  /** 打开文件（如果已打开则激活） */
  openFile: (tab: EditorTab) => void
  /** 关闭 Tab */
  closeTab: (tabId: string) => void
  /** 激活 Tab */
  setActiveTab: (tabId: string) => void
  /**
   * 更新 Tab 内容（标记 dirty）
   * 仅在「用户修改」时调用，会亮起未保存指示灯。
   */
  updateTabContent: (tabId: string, content: string) => void
  /**
   * 静默同步 Tab 内容（不标记 dirty，也不清除 dirty）
   * 用于「AI 生成完成后刷新」、「打开文件刷新」等非用户编辑场景。
   */
  syncTabContent: (tabId: string, content: string) => void
  /**
   * 标记 Tab 已保存（清除 dirty 标记）
   * 在保存成功后调用，使警示灯、Tab 圆点消失。
   */
  markTabSaved: (tabId: string) => void
  /**
   * 直接设置 Tab 的 dirty 标记（不碰 content）。
   *
   * `updateTabContent` 会顺带把 content 写掉，只适合「内容就在 tab 上」的编辑器。
   * 而卷详情这类**自己持有表单状态**的编辑器需要的只是「让 Tab 亮起未保存圆点」——
   * 不给这条通道的话，它们要么滥用 updateTabContent 写一份假 content，
   * 要么就享受不到关闭 Tab / ⌘W / 批量关闭时的未保存确认。
   */
  setTabDirty: (tabId: string, dirty: boolean) => void
  /**
   * 只改已存在 Tab 的标题，**不激活、不新建**。
   *
   * 保存成功后要让标签页文案跟上改过的卷名，但不能为此调 `openFile`——
   * 那会把用户在保存在途期间**刚关掉**的 Tab 重新创建出来，或把当前焦点抢走。
   * 找不到 Tab 时静默返回：那说明它已经被关了，本来就没有标题要改。
   */
  renameTab: (tabId: string, name: string) => void
  /** 清空所有 Tab */
  clearTabs: () => void
}

export const useEditorStore = create<EditorState>()((set, get) => ({
  tabs: [],
  activeTabId: null,

  openFile: (tab) => {
    // diff 类型每次内容不同，只按 id 精确匹配（不走 filePath 去重）
    // 其他类型（含 review-report）按 filePath + type 去重
    const idOnly = tab.type === 'diff'
    const existing = get().tabs.find((t) =>
      t.id === tab.id ||
      (!idOnly && tab.filePath !== undefined && t.filePath === tab.filePath && t.type === tab.type)
    )
    if (existing) {
      // diff / review-report 每次内容不同，强制更新内容后激活
      if (tab.type === 'diff' || tab.type === 'review-report') {
        set((s) => ({
          tabs: s.tabs.map((t) => t.id === existing.id ? { ...t, ...tab, id: tab.id } : t),
          activeTabId: tab.id,
        }))
      } else {
        // 其他类型 Tab：已打开，更新名称并直接激活
        set((s) => ({
          tabs: s.tabs.map((t) => t.id === existing.id ? { ...t, name: tab.name } : t),
          activeTabId: existing.id,
        }))
      }
    } else {
      // 新开 Tab
      set((s) => ({
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
      }))
    }
  },

  closeTab: (tabId) => {
    const { tabs, activeTabId } = get()
    // pinned Tab 不可关闭
    const target = tabs.find((t) => t.id === tabId)
    if (target?.pinned) return
    // 卷详情 Tab 关掉就丢弃它的未保存草稿。
    // 关闭路径有五条（单个 / ⌘W / 关闭其他 / 关闭右侧 / 关闭所有），
    // 全都汇到这里；各路径自己记得清一遍迟早漏一条，而漏掉的那条会让
    // 「放弃修改并关闭」变成假的——内容还在，重开就复活，且新 Tab 没有脏标记，
    // 下一次关闭连确认都不弹
    if (target?.type === 'volume') {
      discardVolumeDraftForTab(tabId, getProjectToken())
      // 待显示的 AI 生成结果同样要清。只清草稿的话，重开 Tab 时
      // 「草稿里的 synopsis 等于 result」这个判据不再成立，界面会卡在一个
      // 永远显示「已重新生成」但内容早已被放弃的幽灵态（Codex round-02 major #3）
      discardVolumeRegenResultForTab(tabId, getProjectToken())
    }
    const newTabs = tabs.filter((t) => t.id !== tabId)
    set({
      tabs: newTabs,
      activeTabId: activeTabId === tabId
        ? (newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null)
        : activeTabId,
    })
  },

  setActiveTab: (tabId) => {
    set({ activeTabId: tabId })
  },

  updateTabContent: (tabId, content) => {
    set((s) => ({
      tabs: s.tabs.map((t) => t.id === tabId ? { ...t, content, dirty: true } : t),
    }))
  },

  // 静默刷新内容（不改变 dirty 标记，用于 AI 生成后刷新、打开文件同步等场景）
  syncTabContent: (tabId, content) => {
    set((s) => ({
      tabs: s.tabs.map((t) => t.id === tabId ? { ...t, content } : t),
    }))
  },

  // 标记 Tab 已保存 —— 清除 dirty 标记，使标题栏警示灯和 Tab 圆点消失
  markTabSaved: (tabId) => {
    set((s) => ({
      tabs: s.tabs.map((t) => t.id === tabId ? { ...t, dirty: false } : t),
    }))
  },

  setTabDirty: (tabId, dirty) => {
    set((s) => ({
      tabs: s.tabs.map((t) => t.id === tabId ? { ...t, dirty } : t),
    }))
  },

  renameTab: (tabId, name) => {
    set((s) => ({
      tabs: s.tabs.map((t) => t.id === tabId ? { ...t, name } : t),
    }))
  },

  clearTabs: () => {
    set({ tabs: [], activeTabId: null })
  },
}))

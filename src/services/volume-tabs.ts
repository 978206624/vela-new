/**
 * volume-tabs — 分卷相关编辑区 Tab 的打开入口（Phase 19 / Task 19.4）
 *
 * 独立成模块，有两个理由：
 * ① **Tab id 与标题的构造只能有一份**。侧栏卷卡片、分卷总览大卡、卷详情内部跳转
 *    都要打开同一个 Tab；各处自己拼 `volume:${n}` 迟早分叉，而分叉的后果是
 *    同一卷开出两个标签页、其中一个还挂着已经改掉的旧卷名。
 * ② 放进 `SidebarShared.tsx` 会多两条 `react-refresh/only-export-components`
 *    警告（该文件同时导出组件与函数），且让「页面」反向依赖「侧栏」。
 */
import { useEditorStore } from '../stores/editor-store'
import { useVolumeDraftStore } from '../stores/volume-draft-store'
import { getProjectToken } from '../stores/volume-store'

/** 打开「分卷总览」页（设计稿 27/28 右侧主区） */
export function openVolumeOverview(): void {
  useEditorStore.getState().openFile({ id: 'volume-overview', name: '分卷总览', type: 'volume-overview' })
}

/**
 * 打开某一卷的**详情 Tab**（`type:'volume'`，对应设计稿 29）。
 *
 * 该 Tab 由 `EditorArea` 的 `type === 'volume'` 分支渲染 `VolumeEditor`。
 *
 * Tab id 只由卷序号决定、**不含卷名**：若把卷名编进 id，改名后同一卷会开出
 * 第二个 Tab，而旧 Tab 还挂着已不存在的名字。
 *
 * ⚠️ 本函数会 `openFile`——**打开或激活**该 Tab，不存在就新建。
 * 只想改标题时不要用它：`VolumeEditor` 保存成功后走的是
 * `editor-store.renameTab()`，因为用本函数会把用户在保存在途期间
 * 刚关掉的 Tab 复活，或把当前焦点抢走。
 *
 * ## 新建时要从草稿恢复 `dirty`
 *
 * 草稿（`volume-draft-store`）的寿命比 Tab 长：它只在保存成功、关闭 Tab、
 * 项目关闭时被清。于是存在这条路径——「重新生成本卷大纲」跑着的时候用户
 * 把 Tab 关了，生成完成时 `setTabDirty` 找不到目标（静默无效），
 * 而草稿照样写进去了；重开 Tab 若不恢复脏标，`EditorArea` 会把它当干净 Tab，
 * ⌘W **不弹确认直接关**，`closeTab` 顺手清掉草稿与结果——那份 AI 大纲
 * 就这么静默没了（Codex round-03 major #2）。
 *
 * 靠「用户下一次编辑时 `touch()` 补脏标」不够：他可能重开后一眼看完就关。
 */
export function openVolumeDetail(volumeNumber: number, title: string): void {
  const hasDraft = useVolumeDraftStore.getState().get(getProjectToken(), volumeNumber) !== null
  useEditorStore.getState().openFile({
    id: `volume:${volumeNumber}`,
    name: `第${volumeNumber}卷 · ${title || '未命名'}`,
    type: 'volume',
    volumeNumber,
    // 草稿在 = 有未保存改动。既有 Tab 被激活时 `openFile` 不会用这个值覆盖它，
    // 只有新建那一次生效——正是需要的语义
    dirty: hasDraft,
  })
}

/** 卷详情 Tab 的 id。供高亮判定等只需要 id 的场景复用，避免各处再拼一遍 */
export function volumeTabId(volumeNumber: number): string {
  return `volume:${volumeNumber}`
}

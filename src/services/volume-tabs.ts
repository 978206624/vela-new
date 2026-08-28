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

/** 打开「分卷总览」页（设计稿 27/28 右侧主区） */
export function openVolumeOverview(): void {
  useEditorStore.getState().openFile({ id: 'volume-overview', name: '分卷总览', type: 'volume-overview' })
}

/**
 * 打开某一卷的**详情 Tab**（`type:'volume'`，对应设计稿 29）。
 *
 * ⚠️ 本函数只建立路由。Tab 的渲染组件（`VolumeEditor`）由后续 Task 接入 `EditorArea`；
 * 在那之前打开的详情 Tab 主体是空的。
 *
 * Tab id 只由卷序号决定、**不含卷名**：若把卷名编进 id，改名后同一卷会开出
 * 第二个 Tab，而旧 Tab 还挂着已不存在的名字。`openFile` 对已存在的 Tab 会更新
 * `name`，所以改名后重新点击即可让标签页文案跟上。
 */
export function openVolumeDetail(volumeNumber: number, title: string): void {
  useEditorStore.getState().openFile({
    id: `volume:${volumeNumber}`,
    name: `第${volumeNumber}卷 · ${title || '未命名'}`,
    type: 'volume',
    volumeNumber,
  })
}

/** 卷详情 Tab 的 id。供高亮判定等只需要 id 的场景复用，避免各处再拼一遍 */
export function volumeTabId(volumeNumber: number): string {
  return `volume:${volumeNumber}`
}

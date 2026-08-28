/**
 * VolumeGroup — 侧栏「故事架构」下的分卷分组（设计稿 27 / 28 左侧）
 *
 * 三种形态：
 * - **加载中**：骨架条。不能拿「空数组」当零卷渲染——`volumes: []` 在
 *   `status !== 'ready'` 时只代表「还没读到」，那时显示「尚未分卷」是假消息。
 * - **零卷**：说明块（当前为单卷模式），不列任何卷。
 * - **有卷**：卷卡片列表（卷名 / 状态徽章 / 章号范围 / 已写 / 进度条）。
 *
 * 右上角 `+` 触发续卷向导；点击分组标题打开「分卷总览」页，
 * 点击卷卡片打开该卷的**详情 Tab**（`type:'volume'`）。
 * 详情 Tab 的渲染组件由后续 Task 接入，本组件只负责路由。
 */
import { useEffect } from 'react'
import { Plus, Layers } from 'lucide-react'
import { useVolumeStore } from '../../../stores/volume-store'
import { useProjectStore } from '../../../stores/project-store'
import { useDraftStore } from '../../../stores/draft-store'
import { useEditorStore } from '../../../stores/editor-store'
import { VOLUME_STATUS_LABELS, countFinalizedInRange } from '../../../services/volume-service'
import { startNextVolumeFlow, describeStartFlowResult } from '../../../services/volume-flow'
import { openVolumeOverview, openVolumeDetail, volumeTabId } from '../../../services/volume-tabs'
import { toast } from '../../ui/Toast'
import type { VolumeData, VolumeStatus } from '../../../../electron/repositories/volume-repository'

/** 状态徽章配色。与 Spec §4.11 的三态一一对应 */
const STATUS_COLOR: Record<VolumeStatus, string> = {
  planned: 'var(--color-text-muted)',
  writing: 'var(--color-accent)',
  done: 'var(--color-success)',
}

export default function VolumeGroup() {
  const volumes = useVolumeStore(s => s.volumes)
  const status = useVolumeStore(s => s.status)
  const loadAll = useVolumeStore(s => s.loadAll)
  // ⚠️ 分成两个订阅，且 effect **只依赖 path**。
  // 依赖整个 `currentProject` 对象的话，`updateNovelConfig` 每敲一个字符就
  // 造一个新对象，effect 随之重跑——用户在小说配置里打字，侧栏会不停重查卷表
  // 并反复闪回 loading 骨架。ProjectTree 已有代码正是用 path 规避同类问题。
  const projectPath = useProjectStore(s => s.currentProject?.path)
  const totalChapters = useProjectStore(s => s.currentProject?.novelConfig.totalChapters ?? 0)

  // 项目打开后拉一次。`loadAll` 内部有 token + 序号双重竞态守卫，
  // 重复调用是安全的
  useEffect(() => {
    if (projectPath) void loadAll()
  }, [projectPath, loadAll])

  /**
   * 发起续卷。提示分派走共享的纯函数 `describeStartFlowResult`——
   * 分卷总览页的 CTA 用的是同一份判据，其中 `project-switched` 刻意不弹：
   * 那是用户自己切走的，再弹一句「项目已切换」属于告诉他他刚做过的事
   */
  const handleStart = async () => {
    const msg = describeStartFlowResult(await startNextVolumeFlow())
    if (msg) toast.error(msg)
  }

  return (
    <div>
      {/* 外层只负责布局，**不带交互语义**：给它套 role="button" 会形成
          「按钮里包着按钮」，加号的 Enter/Space 还会冒泡到父行。
          「打开总览」与「续写下一卷」拆成两个同级原生 <button>，
          各自可 Tab 到、各自有焦点环 */}
      <div className="tree-item gap-1.5 select-none" style={{ paddingLeft: 10 }}>
        <button
          type="button"
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left cursor-pointer rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
          onClick={openVolumeOverview}
          title="打开分卷总览"
        >
          <Layers size={14} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
          <span className="text-sm font-medium min-w-0 truncate" style={{ color: 'var(--color-text)' }}>
            分卷
          </span>
        </button>
        <button
          type="button"
          className="flex-shrink-0 p-0.5 rounded hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
          title="续写下一卷"
          onClick={() => void handleStart()}
          style={{ color: 'var(--color-text-muted)' }}
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="px-2.5 pb-2">
        {status !== 'ready'
          ? <LoadingBlock status={status} />
          : volumes.length === 0
            ? <ZeroVolumeBlock totalChapters={totalChapters} />
            : volumes.map(v => <VolumeCard key={v.volumeNumber} volume={v} />)}
      </div>
    </div>
  )
}

/** 加载中 / 失败。**不复用零卷态**——那会把「没读到」说成「没有卷」 */
function LoadingBlock({ status }: { status: 'idle' | 'loading' | 'error' }) {
  if (status === 'error') {
    return (
      <div className="rounded-md p-2.5 text-xs leading-relaxed"
        style={{ border: '1px solid var(--color-border)', color: 'var(--color-error, #ef4444)' }}>
        分卷数据加载失败
      </div>
    )
  }
  return (
    <div className="rounded-md p-2.5" style={{ border: '1px solid var(--color-border)' }}>
      <div className="h-3 rounded animate-pulse mb-2" style={{ background: 'var(--color-bg-elevated)', width: '60%' }} />
      <div className="h-2.5 rounded animate-pulse" style={{ background: 'var(--color-bg-elevated)', width: '85%' }} />
    </div>
  )
}

/** 零卷态（设计稿 28）：说清「这不是缺功能，是当前就一卷」 */
function ZeroVolumeBlock({ totalChapters }: { totalChapters: number }) {
  return (
    <div
      className="rounded-md p-2.5 text-xs leading-relaxed"
      style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }}
    >
      <div className="mb-1" style={{ color: 'var(--color-text)' }}>尚未分卷</div>
      当前为单卷模式，全书 {totalChapters} 章共用同一份情节大纲。
    </div>
  )
}

function VolumeCard({ volume }: { volume: VolumeData }) {
  // 已写章数 = 该卷区间内有定稿的章数。取自 draft-store（定稿优先），
  // 不额外发 IPC——侧栏是高频渲染区。统计口径与分卷总览页共用
  // `countFinalizedInRange`（它按**实际存在的章**遍历，不按区间循环，
  // 理由见该函数注释）。
  //
  // ⚠️ 选择器必须返回**数字**：zustand v5 要求快照稳定，
  // 返回新数组会让 useSyncExternalStore 每次都判定「变了」而反复重渲染
  const writtenCount = useDraftStore(s => countFinalizedInRange(s.draftsByChapter, volume.startChapter, volume.endChapter))
  // 当前打开的卷详情高亮（设计稿 29 左侧选中态）
  const active = useEditorStore(s => s.activeTabId === volumeTabId(volume.volumeNumber))
  const total = volume.endChapter - volume.startChapter + 1
  // total 理论上恒 ≥1（仓储层校验 end≥start），除零保护是防御性的
  const pct = total > 0 ? Math.round((writtenCount / total) * 100) : 0

  return (
    <div
      role="button"
      tabIndex={0}
      className="rounded-md p-2.5 mb-1.5 cursor-pointer transition-colors"
      style={{
        border: `1px solid ${active ? 'var(--color-accent)' : 'var(--color-border)'}`,
        background: active ? 'var(--color-active)' : 'transparent',
      }}
      onClick={() => openVolumeDetail(volume.volumeNumber, volume.title)}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openVolumeDetail(volume.volumeNumber, volume.title)
        }
      }}
      title="打开卷详情"
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-sm flex-1 min-w-0 truncate" style={{ color: 'var(--color-text)' }} title={volume.title}>
          第{volume.volumeNumber}卷 · {volume.title}
        </span>
        <span
          className="text-[0.68rem] px-1.5 py-0.5 rounded flex-shrink-0"
          style={{ background: 'var(--color-bg-elevated)', color: STATUS_COLOR[volume.status] }}
        >
          {VOLUME_STATUS_LABELS[volume.status]}
        </span>
      </div>

      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-xs flex-1 min-w-0 truncate" style={{ color: 'var(--color-text-muted)' }}>
          第 {volume.startChapter}–{volume.endChapter} 章
        </span>
        <span className="text-xs flex-shrink-0 tabular-nums" style={{ color: 'var(--color-text-muted)' }}>
          {writtenCount} / {total}
        </span>
      </div>

      <div className="h-1 rounded-full overflow-hidden" style={{ background: 'var(--color-bg-elevated)' }}>
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, background: STATUS_COLOR[volume.status] }}
        />
      </div>
    </div>
  )
}

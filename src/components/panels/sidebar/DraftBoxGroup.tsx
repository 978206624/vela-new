/**
 * DraftBoxGroup — 草稿箱折叠组（含章节分组和单条草稿条目）
 */

import { useState, useEffect } from 'react'
import { ChevronRight, ChevronDown, CheckCircle2, Circle, FileText, FolderOpen, Copy, Trash2, FilePen, ArchiveRestore, Archive } from 'lucide-react'
import type { DraftMeta } from '../../../stores/draft-store'
import { useDraftStore, readDraftBody } from '../../../stores/draft-store'
import { useEditorStore } from '../../../stores/editor-store'
import { confirm } from '../../ui/Confirm'
import { toast } from '../../ui/Toast'
import { DRAFT_STATUS_LABEL, DRAFT_STATUS_COLOR } from '../../../shared/draft-status'
import { showSidebarMenu } from './SidebarShared'
import { ipc } from '../../../services/ipc-client'

// ===== 草稿箱折叠组 =====

export default function DraftBoxGroup({
  draftsByChapter,
}: {
  draftsByChapter: Record<number, DraftMeta[]>
}) {
  const [open, setOpen] = useState(true)

  // 所有章节号排序
  const chapterNums = Object.keys(draftsByChapter)
    .map(Number)
    .sort((a, b) => a - b)

  // 筛选出包含非保留（活跃）草稿的实际章节数
  const activeChapterCount = chapterNums.filter(n =>
    (draftsByChapter[n] || []).some(d => d.status !== 'archived')
  ).length

  return (
    <div>
      {/* 草稿箱标题行 */}
      <div
        className="tree-item gap-1.5 cursor-pointer select-none"
        style={{ paddingLeft: 10 }}
        onClick={() => setOpen(v => !v)}
        title="草稿箱：AI 生成后的章节草稿在此管理，定稿后进入正文章节"
      >
        {open
          ? <ChevronDown size={12} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
          : <ChevronRight size={12} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
        }
        <FilePen size={14} style={{ color: 'var(--color-text-muted)' }} />
        <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>草稿箱</span>
        {activeChapterCount > 0 && (
          <span className="ml-auto text-[0.7rem]" style={{ color: 'var(--color-text-muted)' }}>
            {activeChapterCount} 章
          </span>
        )}
      </div>

      {open && (
        <div>
          {chapterNums.length === 0 ? (
            <div
              className="text-xs py-1"
              style={{ paddingLeft: 34, color: 'var(--color-text-muted)' }}
            >
              暂无草稿（从章节蓝图点击「写作此章」创作）
            </div>
          ) : (
            chapterNums.map(chNum => (
              <DraftChapterGroup
                key={chNum}
                chapterNumber={chNum}
                drafts={draftsByChapter[chNum] || []}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

// ===== 单章草稿分组 =====

function DraftChapterGroup({
  chapterNumber,
  drafts,
}: {
  chapterNumber: number
  drafts: DraftMeta[]
}) {
  const [open, setOpen] = useState(true)

  // 将 archived 草稿折叠，只显示活跃草稿（非 archived）
  const activeDrafts = drafts.filter(d => d.status !== 'archived')
  const archivedDrafts = drafts.filter(d => d.status === 'archived')
  const [showArchived, setShowArchived] = useState(false)
  const [bpTitle, setBpTitle] = useState<string>('')

  useEffect(() => {
    let cancelled = false
    ipc.invoke('db:blueprint-get', chapterNumber).then(bp => {
      if (!cancelled && bp?.title) {
        setBpTitle(bp.title)
      }
    }).catch(() => { })
    return () => { cancelled = true }
  }, [chapterNumber])

  // 已定稿的草稿存在时，章节显示绿色标记
  const hasFinalized = drafts.some(d => d.status === 'finalized')
  // 真正生效的定稿 = 同章 finalized 中版本号最高者，与下游 getFinalizedByChapter（ORDER BY version DESC LIMIT 1）一致。
  // 互斥逻辑只管将来的定稿；旧数据若残留多个 finalized，这里保证仅一个被标为「生效中」。
  const effectiveFinalizedVersion = drafts.reduce<number | null>(
    (max, d) => (d.status === 'finalized' && (max === null || d.version > max) ? d.version : max),
    null,
  )
  const baseTitle = bpTitle || drafts[0]?.chapterTitle || ''
  const displayTitle = baseTitle.startsWith(`第${chapterNumber}章`) ? baseTitle : (baseTitle ? `第${chapterNumber}章 ${baseTitle}` : `第${chapterNumber}章`)

  return (
    <div>
      {/* 章节行 */}
      <div
        className="tree-item gap-1.5 cursor-pointer select-none"
        style={{ paddingLeft: 26 }}
        onClick={() => setOpen(v => !v)}
        title={displayTitle}
      >
        {open
          ? <ChevronDown size={10} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
          : <ChevronRight size={10} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
        }
        {hasFinalized
          ? <CheckCircle2 size={10} style={{ flexShrink: 0, color: 'var(--color-success)' }} />
          : <Circle size={6} style={{ flexShrink: 0, fill: 'transparent', stroke: 'var(--color-text-muted)' }} />
        }
        <span className="text-sm flex-1 truncate" style={{ color: 'var(--color-text-secondary)' }}>
          {displayTitle}
        </span>
        <span className="ml-auto text-[0.7rem] flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
          {activeDrafts.length} 稿
        </span>
      </div>

      {/* 草稿列表 */}
      {open && (
        <div>
          {activeDrafts.map(draft => (
            <DraftItem
              key={draft.filePath}
              draft={draft}
              chapterTitleText={displayTitle}
              isEffectiveFinalized={draft.status === 'finalized' && draft.version === effectiveFinalizedVersion}
            />
          ))}

          {/* 显示归档草稿的切换按钮 */}
          {archivedDrafts.length > 0 && (
            <div
              className="flex items-center gap-1 cursor-pointer select-none"
              style={{ paddingLeft: 54 }}
              onClick={() => setShowArchived(v => !v)}
            >
              <span className="text-[0.7rem]" style={{ color: 'var(--color-text-muted)', opacity: 0.6 }}>
                {showArchived ? '▲ 隐藏' : `▼ ${archivedDrafts.length} 个已归档`}
              </span>
            </div>
          )}
          {showArchived && archivedDrafts.map(draft => (
            <DraftItem
              key={draft.filePath}
              draft={draft}
              chapterTitleText={displayTitle}
              archived
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ===== 单条草稿条目 =====

function DraftItem({
  draft,
  chapterTitleText,
  archived = false,
  isEffectiveFinalized = false,
}: {
  draft: DraftMeta
  chapterTitleText: string
  archived?: boolean
  /** 是否为本章真正生效的定稿（同章最高版本 finalized）。仅此项标「生效中」并显示绿勾 */
  isEffectiveFinalized?: boolean
}) {
  /** 打开草稿到编辑器 */
  const openDraft = async () => {
    const content = await readDraftBody(draft.filePath)
    useEditorStore.getState().openFile({
      id: draft.filePath,
      name: `${chapterTitleText} v${draft.version}`,
      type: 'chapter',
      filePath: draft.filePath,
      content,
    })
  }

  /** 将草稿标记为归档（软删除） */
  const deleteDraft = async () => {
    if (isFinalized) return
    const ok = await confirm(
      `归档草稿 "${chapterTitleText} v${draft.version}" 后可在草稿管理列表中展开已归档列表查看。`,
      { title: '归档草稿', confirmText: '归档' }
    )
    if (!ok) return
    await useDraftStore.getState().markDraftStatus(draft.filePath, draft.chapterNumber, 'archived')
  }

  /** 取消归档：恢复为活跃草稿（draft 状态），重新出现在草稿列表 */
  const unarchiveDraft = async () => {
    await useDraftStore.getState().markDraftStatus(draft.filePath, draft.chapterNumber, 'draft')
  }

  /** 彻底删除：从数据库永久移除（级联删除修稿/审稿），不可恢复 */
  const deleteForever = async () => {
    const ok = await confirm(
      `彻底删除草稿 "${chapterTitleText} v${draft.version}"？此操作将从数据库永久移除该草稿及其全部修稿、审稿记录，无法恢复。`,
      { title: '彻底删除', confirmText: '永久删除', danger: true }
    )
    if (!ok) return
    // 先删除并检查结果：成功后才关闭对应 tab；失败则保留 tab 并提示，避免误关后数据仍在
    const res = await useDraftStore.getState().deleteDraftPermanently(draft.filePath, draft.chapterNumber)
    if (!res.success) {
      toast.error(`删除失败：${res.error || '未知错误'}`)
      return
    }
    // 删除成功后关闭该草稿可能打开着的标签，避免留下指向已删数据的死标签
    useEditorStore.getState().closeTab(draft.filePath)
  }

  const isFinalized = draft.status === 'finalized'

  return (
    <div
      className="relative flex items-center gap-1.5 cursor-pointer hover:bg-[var(--color-hover)]"
      style={{
        paddingLeft: 50,
        paddingRight: 8,
        paddingTop: 3,
        paddingBottom: 3,
        opacity: archived ? 0.45 : 1,
      }}
      onClick={openDraft}
      onContextMenu={e => showSidebarMenu([
        {
          key: 'open',
          label: '打开草稿',
          icon: <FolderOpen size={13} />,
          onClick: openDraft,
        },
        { key: 'div1', type: 'divider' as const },
        {
          key: 'copy-path',
          label: '复制文件路径',
          icon: <Copy size={13} />,
          onClick: () => navigator.clipboard.writeText(draft.filePath).catch(() => { }),
        },
        { key: 'div2', type: 'divider' as const },
        ...(archived
          ? [
              {
                key: 'unarchive',
                label: '取消归档',
                icon: <ArchiveRestore size={13} />,
                onClick: unarchiveDraft,
              },
              {
                key: 'delete-forever',
                label: '彻底删除',
                icon: <Trash2 size={13} />,
                danger: true,
                onClick: deleteForever,
              },
            ]
          : [
              {
                key: 'archive',
                label: '归档草稿',
                icon: <Archive size={13} />,
                disabled: isFinalized,
                onClick: deleteDraft,
              },
            ]),
      ], e)}
      title={`点击打开 — ${chapterTitleText} v${draft.version}（${DRAFT_STATUS_LABEL[draft.status] || draft.status}）`}
    >
      <FileText size={10} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
      <span className="text-xs flex-1 truncate" style={{ color: 'var(--color-text-secondary)' }}>
        草稿_v{draft.version}
      </span>
      {/* 状态标签（始终显示）。同章可能残留多个历史 finalized，仅版本号最高者为生效稿；
          生效稿标「已定稿 · 生效中」(绿)，非生效的旧定稿标「已定稿（旧版）」(灰) 以消除歧义 */}
      <span
        className="text-[0.7rem] flex-shrink-0"
        title={isFinalized && !isEffectiveFinalized ? '该章存在更新的定稿，此版本已作为历史定稿保留' : undefined}
        style={{
          color: isFinalized
            ? (isEffectiveFinalized ? 'var(--color-success)' : 'var(--color-text-muted)')
            : (DRAFT_STATUS_COLOR[draft.status] || 'var(--color-text-muted)'),
        }}
      >
        {isFinalized
          ? (isEffectiveFinalized ? '已定稿 · 生效中' : '已定稿（旧版）')
          : (DRAFT_STATUS_LABEL[draft.status] || draft.status)}
      </span>
      {/* 生效定稿图标（仅生效稿显示绿勾） */}
      {isEffectiveFinalized && (
        <CheckCircle2 size={10} style={{ color: 'var(--color-success)', flexShrink: 0 }} />
      )}
    </div>
  )
}

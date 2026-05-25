import { useState } from 'react'
import {
  Eye, ChevronRight, Sparkles, AlertTriangle,
  Layers, Compass, Type, Clock, Users, FileText, ClipboardList, ListTree, Database, PenLine,
  type LucideIcon,
} from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '../ui/Dialog'
import { Button } from '../ui/Button'
import type { ContextSegment, ContextZone } from '../../services/prompts/chapter-context'

interface Props {
  open: boolean
  chapterNumber: number
  segments: ContextSegment[]
  estimatedTokens: number
  tokenBudget: number
  onConfirm: () => void
  onCancel: () => void
}

/** 各分段对应图标（按 key 匹配，未知回退 FileText） */
const SEGMENT_ICONS: Record<string, LucideIcon> = {
  architecture: Layers,
  global_guidance: Compass,
  style_words: Type,
  global_summary: Clock,
  character_states: Users,
  previous_ending: FileText,
  chapter_info: ClipboardList,
  future_blueprints: ListTree,
  filtered_context: Database,
  user_guidance: PenLine,
}

const ZONE_LABEL: Record<ContextZone, string> = {
  stable: '缓存命中区（跨章稳定）',
  volatile: '缓存失效区（逐章变化）',
}

/**
 * 上下文预览 / Prompt 组装确认（设计屏 14）。
 * 写章草稿前展示实际拼装、将发送给模型的上下文分段 + token 估算，确认后才发送。
 * 数据来自 buildChapterContext，与实际发送同源——所览即所发。
 */
export default function ContextPreview({
  open, chapterNumber, segments, estimatedTokens, tokenBudget, onConfirm, onCancel,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggle = (key: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const overBudget = estimatedTokens > tokenBudget
  const pct = Math.min(100, Math.round((estimatedTokens / tokenBudget) * 100))

  const stable = segments.filter(s => s.zone === 'stable')
  const volatile = segments.filter(s => s.zone === 'volatile')

  const renderZone = (zone: ContextZone, list: ContextSegment[]) => {
    if (list.length === 0) return null
    return (
      <div className="space-y-1.5">
        <div className="text-[0.7rem] font-medium uppercase tracking-wider px-1" style={{ color: 'var(--color-text-muted)' }}>
          {ZONE_LABEL[zone]}
        </div>
        {list.map(seg => {
          const Icon = SEGMENT_ICONS[seg.key] ?? FileText
          const isOpen = expanded.has(seg.key)
          return (
            <div
              key={seg.key}
              className="rounded-lg border transition-colors"
              style={{ borderColor: 'var(--color-border)', backgroundColor: isOpen ? 'var(--color-hover)' : 'transparent' }}
            >
              <button
                onClick={() => toggle(seg.key)}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-[var(--color-hover)] rounded-lg transition-colors"
              >
                <Icon size={16} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm" style={{ color: 'var(--color-text)' }}>{seg.label}</div>
                  <div className="text-[0.7rem] truncate" style={{ color: 'var(--color-text-muted)' }}>{seg.description}</div>
                </div>
                <span className="text-xs font-mono whitespace-nowrap" style={{ color: 'var(--color-text-secondary)' }}>
                  ~{seg.tokens.toLocaleString()}
                </span>
                <ChevronRight
                  size={15}
                  style={{ color: 'var(--color-text-muted)', flexShrink: 0, transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.18s ease' }}
                />
              </button>
              {isOpen && (
                <div className="px-3 pb-3">
                  <pre
                    className="text-[0.7rem] leading-relaxed whitespace-pre-wrap break-words max-h-52 overflow-y-auto rounded-md p-2.5"
                    style={{ backgroundColor: 'var(--color-bg)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }}
                  >
                    {seg.content?.trim() || '（空）'}
                  </pre>
                </div>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel() }}>
      <DialogContent className="max-w-[600px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Eye size={16} style={{ color: 'var(--color-accent)' }} />
            本次发送给 AI 的上下文
          </DialogTitle>
          <DialogDescription>
            生成「第{chapterNumber}章」草稿前，预览实际拼装、将要发送给模型的上下文。本地优先——你确认后才发送。
          </DialogDescription>
        </DialogHeader>

        {/* Token 规模估算条 */}
        <div className="px-6 pt-4">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[0.7rem] uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
              上下文规模估算
            </span>
            <span className="text-xs font-mono" style={{ color: overBudget ? 'var(--color-warning)' : 'var(--color-text-secondary)' }}>
              约 {estimatedTokens.toLocaleString()} / {tokenBudget.toLocaleString()} tokens
            </span>
          </div>
          <div className="h-2 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--color-hover)' }}>
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${pct}%`,
                background: overBudget
                  ? 'var(--color-warning)'
                  : 'linear-gradient(90deg, #D97757, #E0A064)',
              }}
            />
          </div>
          {overBudget && (
            <div className="flex items-center gap-1.5 mt-1.5 text-[0.7rem]" style={{ color: 'var(--color-warning)' }}>
              <AlertTriangle size={12} />
              超出软预算，模型可能截断或精简——仍可发送，建议精简上下文。
            </div>
          )}
        </div>

        {/* 分段列表 */}
        <div className="px-6 py-4 space-y-4 max-h-[46vh] overflow-y-auto">
          {renderZone('stable', stable)}
          {renderZone('volatile', volatile)}
        </div>

        <DialogFooter>
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            仅在你确认后才发送
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onCancel}>取消</Button>
            <Button variant="ai" size="lg" onClick={onConfirm}>
              <Sparkles size={13} />
              确认并生成
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

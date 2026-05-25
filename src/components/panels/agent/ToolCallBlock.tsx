/**
 * ToolCallBlock — Tool 调用可视化区块
 *
 * 显示 Agent 调用的每个 Tool：
 * - 折叠的头部：Tool 名称 + 来源徽章 + 状态指示
 * - 展开的主体：参数 JSON + 执行结果
 *
 * 参考 Cursor/Antigravity 的 tool-use 可视化设计。
 */
import { useState } from 'react'
import {
  Wrench,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Loader2,
  AlertTriangle,
} from 'lucide-react'
import type { ToolCallInfo } from '../../../services/agent/agent-engine'

interface Props {
  toolCall: ToolCallInfo
}

/** 状态图标映射 */
function StatusIcon({ status }: { status: ToolCallInfo['status'] }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 size={13} className="tool-call-status completed" />
    case 'failed':
      return <XCircle size={13} className="tool-call-status failed" />
    case 'running':
      return <Loader2 size={13} className="tool-call-status running tool-spinner" />
    case 'waiting_confirm':
      return <AlertTriangle size={13} className="tool-call-status waiting_confirm tool-pulse" />
    case 'pending':
    default:
      return <Loader2 size={13} className="tool-call-status running" style={{ opacity: 0.3 }} />
  }
}

/** 状态文字 */
function statusLabel(status: ToolCallInfo['status']): string {
  switch (status) {
    case 'completed': return '完成'
    case 'failed': return '失败'
    case 'running': return '执行中'
    case 'waiting_confirm': return '待确认'
    case 'pending': return '等待中'
    default: return ''
  }
}

/** 把参数对象压成一行紧凑摘要：read_blueprint(3) / open_editor(第三章) / read_architecture() */
function summarizeArgs(args: Record<string, unknown>): string {
  const vals = Object.values(args).filter(v => v !== undefined && v !== null && v !== '')
  if (vals.length === 0) return ''
  return vals
    .map(v => {
      if (typeof v === 'string') return v.length > 18 ? v.slice(0, 18) + '…' : v
      if (typeof v === 'object') return '…'
      return String(v)
    })
    .join(', ')
}

/** 取结果（或错误）的首行作为折叠态摘要，截断到 ~40 字 */
function summarizeResult(result?: string, error?: string): string {
  const raw = (error || result || '').trim()
  if (!raw) return ''
  const firstLine = raw.split('\n').find(l => l.trim()) ?? ''
  return firstLine.length > 40 ? firstLine.slice(0, 40) + '…' : firstLine
}

export default function ToolCallBlock({ toolCall }: Props) {
  const [expanded, setExpanded] = useState(false)
  const { toolName, arguments: args, status, result, error, source } = toolCall

  const argsSummary = summarizeArgs(args)
  const resultSummary = summarizeResult(result, error)

  return (
    <div className="tool-call-block">
      {/* 折叠头部 */}
      <div className="tool-call-header" onClick={() => setExpanded(v => !v)}>
        <div className="tool-call-icon">
          <Wrench size={12} style={{ color: 'var(--color-text-muted)' }} />
        </div>

        <span className="tool-call-name">{toolName}<span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}>({argsSummary})</span></span>

        {/* 来源徽章 */}
        {source && (
          <span className={`tool-call-source-badge ${source}`}>
            {source === 'builtin' ? '内置' : source === 'mcp' ? 'MCP' : 'Skill'}
          </span>
        )}

        {/* 状态 */}
        <div className="tool-call-status" style={{ marginLeft: 'auto' }}>
          <StatusIcon status={status} />
          <span>{statusLabel(status)}</span>
        </div>

        {/* 展开箭头 */}
        <ChevronRight
          size={12}
          className={`tool-call-arrow ${expanded ? 'expanded' : ''}`}
        />
      </div>

      {/* 折叠态结果摘要副标题（对齐设计屏 15 的一行式结果提示） */}
      {!expanded && resultSummary && (
        <div className="tool-call-summary">{resultSummary}</div>
      )}

      {/* 展开区域 */}
      {expanded && (
        <div className="tool-call-body">
          {/* 参数 */}
          {Object.keys(args).length > 0 && (
            <div className="tool-call-params">
              {JSON.stringify(args, null, 2)}
            </div>
          )}

          {/* 结果 */}
          {result && (
            <div className="tool-call-result" style={{ position: 'relative' }}>
              {result}
              <button
                onClick={() => navigator.clipboard.writeText(result).catch(() => {})}
                className="absolute top-1 right-1 text-[0.65rem] px-1.5 py-0.5 rounded transition-opacity opacity-0 hover:opacity-100"
                style={{
                  backgroundColor: 'var(--color-hover)',
                  color: 'var(--color-text-secondary)',
                  border: '1px solid var(--color-border)',
                }}
                title="复制结果"
              >
                复制
              </button>
            </div>
          )}

          {/* 错误 */}
          {error && (
            <div className="tool-call-result" style={{ color: '#ef4444' }}>
              ❌ {error}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

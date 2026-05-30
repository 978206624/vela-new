import React from 'react'
import { fieldLabel, enumLabel } from './fieldLabels'

/**
 * JsonCard — 把 JSON 对象/数组渲染成「资料卡」（中文属性信息卡），替代裸 JSON。
 * 用于工具调用块结果区：md 走 Markdown 渲染，```json 块走本组件。
 *
 * 递归规则：
 * - 基本类型（string/number/bool/null）→ 按类型着色的值
 * - 对象 → 逐字段「中文标签 + 值」行；枚举值翻译成中文；嵌套对象/数组左缩进递归
 * - 数组 → 基本类型走紧凑行，对象/数组逐项递归
 */

// JSON 专用 text-grade 令牌（与 jsonHighlight 同源，各主题高对比，浅底也可读）
const LITERAL_COLOR = 'var(--json-literal)'  // true/false/null
const NUMBER_COLOR = 'var(--json-number)'    // 数字

function PrimitiveValue({ value }: { value: string | number | boolean | null }) {
  if (value === null) {
    return <span style={{ color: LITERAL_COLOR }}>null</span>
  }
  if (typeof value === 'boolean') {
    return <span style={{ color: LITERAL_COLOR }}>{String(value)}</span>
  }
  if (typeof value === 'number') {
    return <span style={{ color: NUMBER_COLOR }}>{value}</span>
  }
  // 字符串：空串给占位提示
  const s = String(value)
  return (
    <span style={{ color: 'var(--color-text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      {s === '' ? <span style={{ color: 'var(--color-text-muted)', fontStyle: 'italic' }}>（空）</span> : s}
    </span>
  )
}

function isPrimitive(v: unknown): v is string | number | boolean | null {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
}

/** 递归防护：限制嵌套深度与数组渲染条数，防止超深/超长 JSON 同步渲染卡死或栈溢出 */
const MAX_DEPTH = 6
const MAX_ARRAY_ITEMS = 50

function JsonValue({ value, depth = 0 }: { value: unknown; depth?: number }): React.ReactElement {
  if (isPrimitive(value)) {
    return <PrimitiveValue value={value} />
  }

  // 超过最大深度：降级为紧凑摘要，不再递归
  if (depth >= MAX_DEPTH) {
    return (
      <span style={{ color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
        {Array.isArray(value) ? `[…${value.length} 项]` : '{…}'}
      </span>
    )
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span style={{ color: 'var(--color-text-muted)', fontStyle: 'italic' }}>（空列表）</span>
    }
    const shown = value.slice(0, MAX_ARRAY_ITEMS)
    const rest = value.length - shown.length
    return (
      <div className="flex flex-col gap-1">
        {shown.map((item, i) =>
          isPrimitive(item) ? (
            <div key={i} className="flex gap-1.5">
              <span style={{ color: 'var(--color-text-muted)' }} className="flex-shrink-0">•</span>
              <PrimitiveValue value={item} />
            </div>
          ) : (
            <div
              key={i}
              className="pl-2"
              style={{ borderLeft: '2px solid var(--color-border)' }}
            >
              <JsonValue value={item} depth={depth + 1} />
            </div>
          )
        )}
        {rest > 0 && (
          <div style={{ color: 'var(--color-text-muted)', fontStyle: 'italic' }}>
            … 剩余 {rest} 项未显示
          </div>
        )}
      </div>
    )
  }

  // 对象
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) {
    return <span style={{ color: 'var(--color-text-muted)', fontStyle: 'italic' }}>（空）</span>
  }
  return (
    <div className="flex flex-col gap-1">
      {entries.map(([k, v]) => {
        const nested = !isPrimitive(v)
        // 枚举值翻译成中文（如 three_act → 三幕结构）
        const enumZh = enumLabel(k, v)
        return (
          <div key={k} className={nested ? 'flex flex-col gap-0.5' : 'flex gap-1.5 items-baseline'}>
            <span
              className="flex-shrink-0 font-medium"
              style={{ color: 'var(--json-key)', fontSize: '0.7rem' }}
            >
              {fieldLabel(k)}
            </span>
            <div className={nested ? 'pl-2' : 'min-w-0'} style={nested ? { borderLeft: '2px solid var(--color-border)' } : undefined}>
              {enumZh !== null
                ? <span style={{ color: 'var(--color-text)' }}>{enumZh}</span>
                : <JsonValue value={v} depth={depth + 1} />}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default function JsonCard({ data }: { data: unknown }) {
  return (
    <div
      className="my-2 px-3 py-2 rounded-lg text-xs leading-relaxed"
      style={{
        backgroundColor: 'var(--color-bg)',
        border: '1px solid var(--color-border)',
      }}
    >
      <JsonValue value={data} />
    </div>
  )
}

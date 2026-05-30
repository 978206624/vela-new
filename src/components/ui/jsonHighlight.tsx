import React from 'react'

/**
 * JSON 美化 + 轻量语法高亮（无第三方依赖）。
 * 用于对话区 CodeBlock 的 ```json 块、ToolCallBlock 的 JSON 结果展示。
 *
 * 配色：中性饱和度，亮/暗皮肤下均可读（不做 per-theme 覆盖，保持简单）。
 */

// JSON 专用 text-grade 令牌（各主题在 index.css 给 ≥4.5 对比的高对比文本色）。
// 不复用状态/强调色——那些是徽章/强调用途，作小字号语法文本对比度不足。
const COLOR = {
  key: 'var(--json-key)',
  string: 'var(--json-string)',
  number: 'var(--json-number)',
  literal: 'var(--json-literal)',
} as const

/**
 * 尝试把原始字符串解析为 JSON 并以 2 空格美化。
 * 解析失败返回 null（调用方降级为原样文本）。
 * 仅当内容以 { 或 [ 开头时才尝试，避免把普通文本误判。
 */
export function tryPrettyJson(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const first = trimmed[0]
  if (first !== '{' && first !== '[') return null
  try {
    const parsed = JSON.parse(trimmed)
    // 仅对象/数组才美化（基本类型没必要）
    if (typeof parsed !== 'object' || parsed === null) return null
    return JSON.stringify(parsed, null, 2)
  } catch {
    return null
  }
}

/**
 * 尝试把原始字符串解析为 JSON 对象/数组并返回解析值（供资料卡渲染）。
 * 仅当内容以 { 或 [ 开头、且解析结果为对象/数组时返回，否则 null。
 */
export function tryParseJsonObject(raw: string): unknown | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const first = trimmed[0]
  if (first !== '{' && first !== '[') return null
  try {
    const parsed = JSON.parse(trimmed)
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed
  } catch {
    return null
  }
}

/** 单次遍历已美化的 JSON 字符串，输出着色后的 React 片段（保留缩进/换行，置于 <pre> 内）。 */
export function highlightJson(formatted: string): React.ReactNode {
  const nodes: React.ReactNode[] = []
  // 字符串(可能是键)、true/false/null、数字
  const tokenRegex = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = tokenRegex.exec(formatted)) !== null) {
    if (m.index > last) nodes.push(formatted.slice(last, m.index))
    if (m[1] !== undefined) {
      // 字符串：后面紧跟冒号则为键，否则为字符串值
      const isKey = m[2] !== undefined
      nodes.push(
        <span key={k++} style={{ color: isKey ? COLOR.key : COLOR.string }}>{m[1]}</span>
      )
      if (isKey) nodes.push(m[2]) // 把 ": " 原样补回
    } else if (m[3] !== undefined) {
      nodes.push(<span key={k++} style={{ color: COLOR.literal }}>{m[3]}</span>)
    } else if (m[4] !== undefined) {
      nodes.push(<span key={k++} style={{ color: COLOR.number }}>{m[4]}</span>)
    }
    last = m.index + m[0].length
  }
  if (last < formatted.length) nodes.push(formatted.slice(last))
  return nodes
}

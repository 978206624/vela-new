/**
 * 角色关系网 — 以「当前角色」为中心的辐射式可视化（对齐设计屏 22）
 *
 * 中心节点 = 选中角色（橙环高亮），四周辐射出其关系网中的相关角色；
 * 连线按关系/角色着色并在中点标注关系标签。静态布局，主题化（熔炉暖色）。
 */
import { useMemo } from 'react'
import '../../styles/relationship-graph.css'

interface RelCharacter {
  name: string
  role: string
}

interface RelationshipGraphProps {
  /** 中心角色（当前选中） */
  center: { name: string; role: string; relationships: string }
  /** 全体角色（用于解析关系目标的角色定位以着色） */
  characters: RelCharacter[]
}

interface Spoke {
  name: string
  label: string
  color: string
}

/** 角色定位 → 主题色（取自设计屏 22 的关系网配色，均为熔炉主题变量） */
const ROLE_COLOR: Record<string, string> = {
  protagonist: 'var(--color-accent)',       // 陶土橙 #D97757
  antagonist: 'var(--color-error)',         // 危险红
  supporting: 'var(--color-info)',          // 蓝 #6A9BCC
  minor: 'var(--color-success)',            // 绿 #7F9461
}
const DEFAULT_COLOR = 'var(--color-text-muted)' // 灰 #6E685F

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 解析中心角色的关系 → 关系目标列表。
 *
 * 关键：真实 relationships 多为 AI 写的叙事散文（非结构化），按标点切碎再取首字当人名
 * 会切出「与」「认为」等垃圾节点。因此**以花名册其他角色名为锚**，在文本里匹配——
 * 谁被提及就连一条，提及该角色的子句作为关系描述；从根上杜绝非人名节点。
 * 同时兼容 JSON 数组结构化输入。
 */
function parseCenterRelationships(
  center: RelationshipGraphProps['center'],
  characters: RelCharacter[],
): Spoke[] {
  const colorFor = (role?: string) => ROLE_COLOR[role ?? ''] ?? DEFAULT_COLOR
  const spokes: Spoke[] = []
  const seen = new Set<string>()
  const raw = center.relationships ?? ''
  if (!raw.trim()) return spokes

  // 策略 1：JSON 数组 [{ name/target, relation/label }]
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      for (const rel of parsed) {
        const target = String(rel?.name ?? rel?.target ?? '').trim()
        if (!target || target === center.name || seen.has(target)) continue
        // 同样以花名册为锚：目标必须是已知角色，否则跳过（杜绝结构化数据里的非角色/已删目标变垃圾节点）
        const targetChar = characters.find(c => c.name === target)
        if (!targetChar) continue
        seen.add(target)
        spokes.push({ name: target, label: String(rel?.relation ?? rel?.label ?? '').trim(), color: colorFor(targetChar.role) })
      }
      return spokes
    }
  } catch { /* 非 JSON，走花名册锚定解析 */ }

  // 策略 2：花名册锚定——只把"文本中真正提及的其他角色"作为节点
  const others = characters
    .filter(c => c.name && c.name !== center.name)
    .sort((a, b) => b.name.length - a.name.length) // 长名优先，减少子串误配
  // 按句末/分隔标点拆子句
  const clauses = raw.split(/[，,；;。.！!？?\n]/).map(s => s.trim()).filter(Boolean)
  // 每个子句归属于"它包含的最长角色名"那个角色：others 已长→短排序，find 命中即最长。
  // 这样短名（张三）不会抢走含长名（张三丰）的子句作关系描述。
  const labelsByChar = new Map<string, string[]>()
  for (const cl of clauses) {
    const owner = others.find(o => cl.includes(o.name))
    if (!owner) continue
    // 结构化写法 "名字：关系" 去掉前缀名；散文则原样保留
    const text = cl.replace(new RegExp('^' + escapeRegExp(owner.name) + '\\s*[：:—-]\\s*'), '')
    const arr = labelsByChar.get(owner.name) ?? []
    arr.push(text)
    labelsByChar.set(owner.name, arr)
  }
  // 节点是否存在仍以 masked 校验：匹配到长名后遮盖其出现处，避免短名作为长名子串被误命中
  let masked = raw
  for (const other of others) {
    if (seen.has(other.name) || !masked.includes(other.name)) continue
    seen.add(other.name)
    masked = masked.split(other.name).join('　')
    spokes.push({ name: other.name, label: (labelsByChar.get(other.name) ?? []).join('；'), color: colorFor(other.role) })
  }
  return spokes
}

/** 取节点显示用单字（姓名首字） */
const firstChar = (name: string) => Array.from(name)[0] ?? '?'

/** 角色关系网辐射图 */
export default function RelationshipGraph({ center, characters }: RelationshipGraphProps) {
  const spokes = useMemo(() => parseCenterRelationships(center, characters), [center, characters])

  // 辐射定位（百分比坐标，0-100）。容器偏宽，用椭圆半径让节点落在四周。
  const cx = 50
  const cy = 50
  const rx = 36
  const ry = 20
  const positioned = spokes.slice(0, 8).map((s, i, arr) => {
    const angle = (-90 + (360 / arr.length) * (i + 0.5)) * (Math.PI / 180)
    return { ...s, x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) }
  })

  const centerColor = ROLE_COLOR[center.role] ?? 'var(--color-accent)'
  const centerName = center.name || '当前'
  // 长名自适应字号，避免溢出 64px 圆（再长则 CSS 省略号兜底）
  const centerFontSize = centerName.length <= 3 ? 14 : centerName.length <= 5 ? 12 : 11

  return (
    <div className="relationship-graph">
      {positioned.length === 0 ? (
        <div className="relationship-graph-empty">
          为「{center.name || '该角色'}」补充关系网后将在此可视化
        </div>
      ) : (
        <>
          {/* 连线层（SVG，非缩放描边保证 2px） */}
          <svg
            className="relationship-graph-edges"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden
          >
            {positioned.map((s, i) => (
              <line
                key={`edge-${i}`}
                x1={cx} y1={cy} x2={s.x} y2={s.y}
                stroke={s.color}
                strokeWidth={2}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                opacity={0.75}
              />
            ))}
          </svg>

          {/* 辐射角色节点：圆 → 姓名 → 关系（节点下方竖排，完整换行不截断） */}
          {positioned.map((s, i) => (
            <div
              key={`node-${i}`}
              className="relationship-graph-node-wrap"
              style={{ left: `${s.x}%`, top: `${s.y}%` }}
            >
              <div className="relationship-graph-node" style={{ borderColor: s.color }}>
                {firstChar(s.name)}
              </div>
              <div className="relationship-graph-node-labels">
                <div className="relationship-graph-node-name">{s.name}</div>
                {s.label ? (
                  <div className="relationship-graph-node-rel" style={{ color: s.color }}>{s.label}</div>
                ) : null}
              </div>
            </div>
          ))}

          {/* 中心节点（当前角色，橙环高亮） */}
          <div className="relationship-graph-node-wrap" style={{ left: `${cx}%`, top: `${cy}%` }}>
            <div
              className="relationship-graph-center"
              style={{ borderColor: centerColor, color: centerColor, fontSize: centerFontSize }}
              title={centerName}
            >
              {centerName}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

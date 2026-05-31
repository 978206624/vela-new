/**
 * 章节定位（role）的统一取值源 —— Phase 18。
 *
 * 「章节定位」是每章在全书中的叙事作用，合法取值固定为 7 项。
 * 蓝图编辑器下拉、创作弹窗下拉、卡片配色、生成/导入/打开项目的归一都引用本模块，
 * 杜绝跨组件术语不一致（如旧「开篇」vs「建置」）与列表外幻影选项。
 *
 * 与角色 role 的 coerceRole（character-store.ts）同思路：认得的近义/变体映射，认不得默认「发展」。
 */

/** 合法章节定位（7 项，单选） */
export const CHAPTER_ROLES = ['建置', '铺垫', '发展', '冲突', '高潮', '转折', '收尾'] as const

export type ChapterRole = (typeof CHAPTER_ROLES)[number]

/** 7 项定位的卡片配色（Tailwind class）。每项独立，不留无色默认。 */
export const CHAPTER_ROLE_COLORS: Record<string, string> = {
  建置: 'bg-blue-500/20 text-blue-400',
  铺垫: 'bg-cyan-500/20 text-cyan-400',
  发展: 'bg-slate-500/20 text-slate-400',
  冲突: 'bg-orange-500/20 text-orange-400',
  高潮: 'bg-red-500/20 text-red-400',
  转折: 'bg-purple-500/20 text-purple-400',
  收尾: 'bg-green-500/20 text-green-400',
}

/** 常见列表外值 → 7 项枚举（AI 生成/导入逆推可能吐这些） */
const CHAPTER_ROLE_SYNONYMS: Record<string, ChapterRole> = {
  起: '建置', 开篇: '建置', 序章: '建置', 开端: '建置', 开局: '建置', 引子: '建置',
  承: '发展', 推进: '发展', 展开: '发展', 进展: '发展',
  伏笔: '铺垫', 铺陈: '铺垫', 过渡: '铺垫', 蓄势: '铺垫', 蓄力: '铺垫',
  转: '转折', 反转: '转折', 转捩: '转折', 突变: '转折',
  合: '收尾', 结局: '收尾', 结尾: '收尾', 大结局: '收尾', 尾声: '收尾', 终章: '收尾', 结束: '收尾',
  矛盾: '冲突', 对抗: '冲突', 升级: '冲突', 爆发: '冲突',
}

/**
 * 把任意输入归一到 7 项合法定位。
 * 认得的枚举直接用；近义/变体经映射；认不得（含非字符串）一律默认「发展」。
 * 幂等：合法值满足 `role === coerceChapterRole(role)`。
 */
export function coerceChapterRole(raw: unknown): ChapterRole {
  if (typeof raw !== 'string') return '发展'
  const v = raw.trim()
  if ((CHAPTER_ROLES as readonly string[]).includes(v)) return v as ChapterRole
  return CHAPTER_ROLE_SYNONYMS[v] ?? '发展'
}

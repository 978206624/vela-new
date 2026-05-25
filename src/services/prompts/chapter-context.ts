import { useProjectStore } from '../../stores/project-store'
import { getPromptTemplate, buildSystemConstraints } from '../prompt-templates'
import { ChapterPromptBuilder } from './prompt-builder'
import { ipc } from '../ipc-client'
import { DIR_PROMPTS } from '../../shared/project-paths'
import type { ChapterInfo } from '../workflows/chapter-workflow'

/** 章节草稿 Token 软预算（中文约 1.5 字符/token，预留 ~4K 给输出） */
export const CHAPTER_TOKEN_BUDGET = 28000

export type ContextZone = 'stable' | 'volatile'

/** 上下文预览的一个分段（对应设计屏 14 的一行） */
export interface ContextSegment {
  /** 唯一标识（多为模板变量 key） */
  key: string
  /** 中文标题 */
  label: string
  /** 副标题描述 */
  description: string
  /** 缓存命中区(stable) / 缓存失效区(volatile) */
  zone: ContextZone
  /** 实际注入的内容（供展开查看，保证「预览==执行」） */
  content: string
  /** 该段 token 估算 */
  tokens: number
}

/** buildChapterContext 的产物：既供预览，也供执行（同一 builder 实例，确保所发即所览） */
export interface ChapterContextResult {
  /** 已注入全部变量、可直接 build() 发送的 Builder */
  builder: ChapterPromptBuilder
  /** 使用的模板 key（first_chapter_draft / next_chapter_draft） */
  templateKey: string
  /** 真实拼装出的分段（只含模板真正引用的占位符） */
  segments: ContextSegment[]
  /** 整体 prompt 的 token 估算（取自真实 build() 结果，含模板骨架与系统约束） */
  estimatedTokens: number
  /** Token 软预算 */
  tokenBudget: number
}

const estTokens = (s: string) => Math.ceil((s || '').length / 1.5)

/** 读取四段架构（前提 / 角色图谱 / 世界观 / 情节大纲） */
async function readArchitecture(): Promise<string> {
  const core = await ipc.invoke('db:project-core-get')
  const parts: string[] = []
  if (core?.premise) parts.push(core.premise.trim())
  if (core?.charactersArch) parts.push(core.charactersArch.trim())
  if (core?.worldbuilding) parts.push(core.worldbuilding.trim())
  if (core?.synopsis) parts.push(core.synopsis.trim())
  return parts.join('\n\n---\n\n')
}

/** 读取项目级提示词覆盖（.vela/prompts/*.md） */
async function readProjectPrompts(projectPath: string): Promise<string> {
  try {
    const files = await ipc.invoke('fs:list-dir', `${projectPath}/${DIR_PROMPTS}`)
    const mdFiles = files.filter((f: { isDir: boolean; name: string }) => !f.isDir && f.name.endsWith('.md'))
    if (mdFiles.length === 0) return ''
    const parts: string[] = []
    for (const f of mdFiles) {
      const result = await ipc.invoke('fs:read-file', f.path)
      if (result.success && result.content.trim()) {
        parts.push(`## 项目专属指导（${f.name.replace(/\.md$/, '')}）\n${result.content.trim()}`)
      }
    }
    return parts.join('\n\n')
  } catch { return '' }
}

/** 读取所有角色当前动态状态档案 */
async function readCharacterStates(): Promise<string> {
  try {
    const allChars = await ipc.invoke('db:character-get-all')
    const states: string[] = []
    for (const card of allChars) {
      if (card.name && card.currentState) {
        const cs = card.currentState
        states.push(
          `${card.name}（${card.role || '未知'}）| ` +
          `境界：${cs.powerLevel || '未知'} | ` +
          `位置：${cs.location || '未知'} | ` +
          `身体：${cs.physicalState || '正常'} | ` +
          `心理：${cs.mentalState || '正常'} | ` +
          `道具：${cs.keyItems || '无'} | ` +
          `最近：第${cs.updatedAtChapter || 0}章 ${cs.recentEvents || ''}`
        )
      }
    }
    return states.length > 0 ? `【角色状态档案】\n${states.join('\n')}` : '（暂无角色状态档案）'
  } catch { return '（角色状态档案读取失败）' }
}

/**
 * 从蓝图 JSON 的 notes 字段读取章节要点时间线。
 * 近 5 章完整收录；更早期仅保留标题行，控制总量 ≤ 3000 字。
 * 按序拼装保证前缀稳定，最大化 LLM 上下文缓存命中。
 */
async function readChapterNotesTimeline(currentChapter: number): Promise<string> {
  const FULL_WINDOW = 5
  const MAX_CHARS = 3000
  const lines: string[] = []

  for (let i = 1; i < currentChapter; i++) {
    try {
      const bp = await ipc.invoke('db:blueprint-get', i)
      if (!bp) continue
      const isRecent = i >= currentChapter - FULL_WINDOW
      if (isRecent && bp.notes?.trim()) {
        lines.push(`【第${i}章 ${bp.title || ''}】\n${bp.notes.trim()}`)
      } else {
        lines.push(`【第${i}章 ${bp.title || ''}】`)
      }
    } catch { /* 忽略单章读取失败 */ }
  }

  let result = lines.join('\n\n')
  if (result.length > MAX_CHARS) result = result.slice(-MAX_CHARS)
  return result || '（无章节要点）'
}

/**
 * 拼装某章草稿的完整上下文，按「稳定前缀 → 可变后缀」排列（命中 LLM 上下文缓存）。
 *
 * 返回的 `builder` 即用于实际发送，`segments` 即上下文预览的数据源 —— 两者同源，
 * 确保「预览 == 执行」。分段只纳入模板真正引用的占位符：例如后续章模板不注入
 * 四段架构，预览也不会显示该行（不伪造未发送的内容）。
 *
 * 与原 GenerateDraftCommand 内联逻辑完全一致，仅抽取为可复用、可预览的纯流程。
 */
export async function buildChapterContext(
  chapterInfo: ChapterInfo,
  log?: (msg: string) => void
): Promise<ChapterContextResult> {
  const project = useProjectStore.getState().currentProject
  if (!project) throw new Error('未打开项目')
  const say = log ?? (() => {})

  const architecture = await readArchitecture()
  const projectPrompts = await readProjectPrompts(project.path)
  const mergedGuidance = [project.novelConfig.globalGuidance || '', projectPrompts].filter(Boolean).join('\n\n')
  const characterState = await readCharacterStates()

  let futureBlueprintsStr = '（无后续蓝图）'
  try {
    const { loadDirectoryBlueprints } = await import('../workflows/directory-workflow')
    const allBlueprints = await loadDirectoryBlueprints()
    const futureBlueprintsArr = allBlueprints.filter(
      b => b.chapterNumber > chapterInfo.chapterNumber && b.chapterNumber <= chapterInfo.chapterNumber + 5
    )
    if (futureBlueprintsArr.length > 0) {
      futureBlueprintsStr = futureBlueprintsArr.map(b => `第${b.chapterNumber}章 ${b.title}：${b.keyEvents}`).join('\n')
    }
  } catch { /* 忽略 */ }

  const isFirstChapter = chapterInfo.chapterNumber === 1
  const templateKey = isFirstChapter ? 'first_chapter_draft' : 'next_chapter_draft'
  const template = getPromptTemplate(templateKey)
  if (!template) throw new Error(`未找到模板: ${templateKey}`)

  const writingStyle = project.novelConfig.writingStyle || ''
  const wordNumber = project.novelConfig.wordsPerChapter
  const userGuidance = chapterInfo.userGuidance?.trim() || '（无微操指导）'

  // ---- 缓存命中区（跨章稳定，前缀对齐）----
  const builder = new ChapterPromptBuilder(template)
    .withArchitecture(architecture)
    .withGlobalGuidance(mergedGuidance)
    .withWritingStyle(writingStyle)
    .withNovelConfig(project.novelConfig)
    .withWordNumber(wordNumber)
    .withChapterInfo(chapterInfo)
    .withFutureBlueprints(futureBlueprintsStr)
    .withUserGuidance(userGuidance)

  let chapterTimeline = ''
  let previousEnding = ''
  let filteredContext = ''

  if (!isFirstChapter) {
    chapterTimeline = await readChapterNotesTimeline(chapterInfo.chapterNumber)
    say(`  📋 已加载章节要点时间线（${chapterTimeline.length} 字）`)

    try {
      const prevNum = chapterInfo.chapterNumber - 1
      const meta = await ipc.invoke('db:draft-get-finalized', prevNum)
      if (meta) {
        const full = await ipc.invoke('db:draft-get-full', meta.id)
        if (full?.content) previousEnding = full.content.slice(-1000)
      }
    } catch { /* 忽略 */ }

    try {
      say('  🔍 检索知识库相关片段...')
      let searchQuery = `${chapterInfo.title} ${chapterInfo.keyEvents} ${chapterInfo.characters.join(' ')}`
      if (chapterInfo.knowledgeQueryHint?.trim()) {
        searchQuery += ` ${chapterInfo.knowledgeQueryHint.trim()}`
        say(`  📌 追加用户检索关键词：${chapterInfo.knowledgeQueryHint.trim()}`)
      }
      const results = await ipc.invoke('kb:search', searchQuery, 5)
      filteredContext = results.length > 0
        ? results.map((r: { fileName: string; score: number; text: string }, i: number) => `[${i + 1}] (${r.fileName}, 相关度 ${(r.score * 100).toFixed(0)}%)\n${r.text}`).join('\n\n')
        : '（知识库中无相关内容）'
    } catch {
      filteredContext = '（知识库检索不可用）'
    }

    builder
      // ---- 缓存命中区续（要点时间线按序追加，前缀对齐）----
      .withGlobalSummary(chapterTimeline)
      .withCharacterStates(characterState)
      // ---- 缓存失效区（逐章变化）----
      .withPreviousEnding(previousEnding || '（无前文）')
      .withFilteredContext(filteredContext)
      .withShortSummary('')
  }

  // 整体 token 估算取自真实 build()（含模板骨架 + 系统约束 + 反 AI 味注入）
  const estimatedTokens = estTokens(builder.build())

  // ===== 分段：只纳入模板真正引用的占位符，确保「预览 == 执行」 =====
  // systemSuffix 必须取「实际会被注入的内置约束」——finalizePrompt 强制从内置取，
  // 不看被覆盖模板的 systemSuffix。用 buildSystemConstraints(key,{}) 拿到原始占位符串
  // （空变量不替换，{{user_guidance}}/{{word_number}} 等保留），与执行端完全同源。
  const tmplText = `${template.content}\n${buildSystemConstraints(templateKey, {})}`
  const referenced = (k: string) => tmplText.includes(`{{${k}}}`)
  const seg = (
    key: string, label: string, description: string, zone: ContextZone, content: string
  ): ContextSegment | null =>
    referenced(key) ? { key, label, description, zone, content, tokens: estTokens(content) } : null

  const chapterInfoText = JSON.stringify(chapterInfo, null, 2)
  const styleAndWords = [writingStyle && `文风：${writingStyle}`, `目标字数：约 ${wordNumber} 字`]
    .filter(Boolean).join('\n')

  const candidates: Array<ContextSegment | null> = [
    // ---- 缓存命中区（跨章稳定）----
    seg('architecture', '四段架构', '世界观 / 角色定位 / 设定 / 主线', 'stable', architecture),
    seg('global_guidance', '全局指导 + 项目提示词', 'globalGuidance + .vela/prompts', 'stable', mergedGuidance),
    // 文风 / 字数：以 word_number 占位符判定是否纳入（写稿模板必含）
    referenced('word_number')
      ? { key: 'style_words', label: '文风 / 字数', description: '写作风格与目标字数约束', zone: 'stable', content: styleAndWords, tokens: estTokens(styleAndWords) }
      : null,
    seg('global_summary', '章节要点时间线', '前文蓝图 notes（裁剪 ≤3000 字）', 'stable', chapterTimeline),
    seg('character_states', '角色动态状态', '所有角色当前状态档案', 'stable', characterState),
    // ---- 缓存失效区（逐章变化）----
    seg('previous_ending', '上一章定稿末尾', '上一章结尾约 1000 字', 'volatile', isFirstChapter ? '' : (previousEnding || '（无前文）')),
    seg('chapter_info', '本章蓝图', `第${chapterInfo.chapterNumber}章 蓝图信息`, 'volatile', chapterInfoText),
    seg('future_blueprints', '后续 1-5 章蓝图', '防止剧情提前', 'volatile', futureBlueprintsStr),
    seg('filtered_context', '知识库召回', '语义检索 topK=5（标题 + 关键事件 + 角色）', 'volatile', filteredContext),
    seg('user_guidance', '本章微操指导', '作者本章特别要求（最高优先级）', 'volatile', userGuidance),
  ]

  const segments = candidates.filter((s): s is ContextSegment => s !== null)

  return { builder, templateKey, segments, estimatedTokens, tokenBudget: CHAPTER_TOKEN_BUDGET }
}

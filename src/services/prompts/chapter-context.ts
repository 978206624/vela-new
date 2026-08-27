import { useProjectStore } from '../../stores/project-store'
import { getPromptTemplate, buildSystemConstraints } from '../prompt-templates'
import { ChapterPromptBuilder } from './prompt-builder'
import { ipc } from '../ipc-client'
import { DIR_PROMPTS } from '../../shared/project-paths'
import type { ChapterInfo } from '../workflows/chapter-workflow'
import { useVolumeStore } from '../../stores/volume-store'
import { getVolumeCompass, describeNotReady, type VolumeCompassResult } from '../volume-service'

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
 * 把卷罗盘拆成**两段**返回，这是刻意的：
 *
 * - `stable`：卷名 + 主线 + high 伏笔。卷内跨章完全不变，放进前缀缓存区。
 * - `position`：「本章位置：X / Y 章」。**每章都变**，必须放到所有可缓存内容之后。
 *
 * ⚠️ 不要把两者合成一段塞在模板最前面。那样看似「罗盘是卷级的所以稳定」，
 * 实际因为其中含逐章变化的位置，prompt 会在开头几十字就分叉，
 * 后面的时间线、角色状态、全局指导全都共享不到前缀——比不放还糟。
 *
 * 只取 **high** 优先级的未回收伏笔：正文一章一章写，把整卷几十条铺进来
 * 会淹没本章任务，也把稳定前缀撑大。完整台账由目录生成那一侧消费。
 */
function formatVolumeCompass(
  result: VolumeCompassResult,
  chapterNumber: number,
): { stable: string; position: string } {
  // single = 真单卷模式（老项目零感知）；
  // unassigned = 本章在首卷之前、没有任何前序卷可回落，硬给就是编造
  if (result.kind === 'single' || result.kind === 'unassigned') return { stable: '', position: '' }

  const v = result.volume
  const lines: string[] = [`当前卷：${v.title}（第 ${v.startChapter}–${v.endChapter} 章）`]

  if (result.kind === 'prior') {
    lines.push('（本章尚未纳入任何卷，以上为**它之前**最近一卷的上下文，仅供承接参考）')
  }

  if (v.premise.trim()) {
    lines.push(`\n【本卷主线目标与核心冲突】\n${v.premise.trim()}`)
  }

  const high = v.openThreads.filter(t => t.urgency === 'high')
  if (high.length > 0) {
    lines.push(
      `\n【本卷必须回收的高优先级伏笔】\n` +
      high.map(t => `- [第${t.chapter}章埋设] ${t.thread}`).join('\n') +
      `\n（不必在本章强行回收；但本章若触及相关线索，不得写出与之矛盾的内容。）`
    )
  }

  // 位置只在精确命中时给。prior 时本章不属于该卷，硬算会得到
  // 「本卷第 51 / 40 章」这种自相矛盾的值，比不给更糟
  const position = result.kind === 'exact'
    ? `本章位置：${v.title} 第 ${chapterNumber - v.startChapter + 1} / ${v.endChapter - v.startChapter + 1} 章`
    : ''

  return { stable: lines.join('\n'), position }
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
  // 目标字数三级回退（Phase 18）：本次 carrier(>0) → 本章蓝图 target_words(>0) → 全局每章字数。
  // 覆盖弹窗、AI 对话写稿等所有入口——蓝图是生成时的权威单一数据源。
  let wordNumber = project.novelConfig.wordsPerChapter
  if (chapterInfo.wordsTarget && chapterInfo.wordsTarget > 0) {
    wordNumber = chapterInfo.wordsTarget
  } else {
    const bp = await ipc.invoke('db:blueprint-get', chapterInfo.chapterNumber).catch(() => null)
    if (bp && bp.targetWords > 0) wordNumber = bp.targetWords
  }
  const userGuidance = chapterInfo.userGuidance?.trim() || '（无微操指导）'

  // ---- 本卷罗盘 ----
  // 拆成 stable（卷名/主线/伏笔，卷内跨章不变）与 position（本章位置，逐章变），
  // 分别落在模板的缓存命中区与缓存失效区，详见 formatVolumeCompass 的注释。
  //
  // 未就绪时**不阻断写作**：正文生成不像目录生成那样会写坏分卷结构，
  // 少一段罗盘只是上下文变弱；为此中断用户的写稿不划算
  //（与目录侧的 fail closed 是有意的不同取舍）。
  //
  // ⚠️ 「是否真的会发送」由模板是否引用占位符决定——首章模板与用户自定义模板
  // 都可能不含它。日志与预览分段必须用同一个 referenced 判据，
  // 否则会出现「日志说已注入、实际没发」或「预览显示空卡片」这类预览≠执行。
  const tmplText = `${template.content}\n${buildSystemConstraints(templateKey, {})}`
  const referenced = (k: string) => tmplText.includes(`{{${k}}}`)

  const compassQ = getVolumeCompass(useVolumeStore.getState().getSnapshot(), chapterInfo.chapterNumber)
  const compassParts = compassQ.ready
    ? formatVolumeCompass(compassQ.value, chapterInfo.chapterNumber)
    : { stable: '', position: '' }
  const volumeCompass = referenced('volume_compass') ? compassParts.stable : ''
  const volumePosition = referenced('volume_position') ? compassParts.position : ''
  // describeNotReady 自带「分卷数据…」前缀，此处不能再加一遍
  if (!compassQ.ready) say(`  ⚠️ ${describeNotReady(compassQ.reason)}，本章不注入卷罗盘`)
  else if (volumeCompass) say(`  🧭 已注入本卷罗盘（${volumeCompass.length} 字）`)

  // ---- 缓存命中区（跨章稳定，前缀对齐）----
  const builder = new ChapterPromptBuilder(template)
    .withArchitecture(architecture)
    .withGlobalGuidance(mergedGuidance)
    .withVolumeCompass(volumeCompass)
    .withVolumePosition(volumePosition)
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
  // tmplText / referenced 已在上方「本卷罗盘」处定义——日志、注入与预览分段
  // 必须共用同一个判据，分两处各算一份迟早会漂移。
  // 其中 systemSuffix 取的是**内置**约束（finalizePrompt 强制从内置取，
  // 不看被覆盖模板的 systemSuffix），故与执行端完全同源。
  const seg = (
    key: string, label: string, description: string, zone: ContextZone, content: string
  ): ContextSegment | null => {
    // trim 与 substituteVariables 的替换口径一致：实际发送的值经过 trim，
    // 预览若展示未 trim 的原值，就成了「执行时不长这样」的内容，破坏「预览==执行」
    const v = (content ?? '').trim()
    return referenced(key) ? { key, label, description, zone, content: v, tokens: estTokens(v) } : null
  }

  const chapterInfoText = JSON.stringify(chapterInfo, null, 2)
  const styleAndWords = [writingStyle && `文风：${writingStyle}`, `目标字数：约 ${wordNumber} 字`]
    .filter(Boolean).join('\n')

  const candidates: Array<ContextSegment | null> = [
    // ---- 缓存命中区（跨章稳定）----
    seg('architecture', '四段架构', '世界观 / 角色定位 / 设定 / 主线', 'stable', architecture),
    seg('global_guidance', '全局指导 + 项目提示词', 'globalGuidance + .vela/prompts', 'stable', mergedGuidance),
    // 卷内跨章稳定，故归入缓存命中区；首章模板没有 {{volume_compass}} 占位符，
    // seg() 的 referenced() 过滤会自动让它不出现在预览里（不伪造未发送的内容）
    // ⚠️ 内容为空时**不建分段**：模板里罗盘用的是「（如有）」标题形态，
    // 值为空时 finalizePrompt 会把整段裁掉、实际根本不发送。
    // 若照常建一个空分段，预览会显示「本卷罗盘 ~0（空）」——既破坏「预览==执行」，
    // 也让单卷模式的老项目看见本不该出现的分卷卡片（零感知承诺）
    volumeCompass.trim()
      ? seg('volume_compass', '本卷罗盘', '本卷主线 + 高优先级未回收伏笔（卷内跨章稳定）', 'stable', volumeCompass)
      : null,
    // 文风 / 字数：以 word_number 占位符判定是否纳入（写稿模板必含）
    referenced('word_number')
      ? { key: 'style_words', label: '文风 / 字数', description: '写作风格与目标字数约束', zone: 'stable', content: styleAndWords, tokens: estTokens(styleAndWords) }
      : null,
    seg('global_summary', '章节要点时间线', '前文蓝图 notes（裁剪 ≤3000 字）', 'stable', chapterTimeline),
    seg('character_states', '角色动态状态', '所有角色当前状态档案', 'stable', characterState),
    // ---- 缓存失效区（逐章变化）----
    // 逐章变化，故归缓存失效区——它正是「罗盘不能整段放前缀」的原因
    volumePosition.trim()
      ? seg('volume_position', '本章在卷内的位置', '第 X / Y 章（逐章变化）', 'volatile', volumePosition)
      : null,
    seg('previous_ending', '上一章定稿末尾', '上一章结尾约 1000 字', 'volatile', isFirstChapter ? '' : (previousEnding || '（无前文）')),
    seg('chapter_info', '本章蓝图', `第${chapterInfo.chapterNumber}章 蓝图信息`, 'volatile', chapterInfoText),
    seg('future_blueprints', '后续 1-5 章蓝图', '防止剧情提前', 'volatile', futureBlueprintsStr),
    seg('filtered_context', '知识库召回', '语义检索 topK=5（标题 + 关键事件 + 角色）', 'volatile', filteredContext),
    seg('user_guidance', '本章微操指导', '作者本章特别要求（最高优先级）', 'volatile', userGuidance),
  ]

  const segments = candidates.filter((s): s is ContextSegment => s !== null)

  return { builder, templateKey, segments, estimatedTokens, tokenBudget: CHAPTER_TOKEN_BUDGET }
}

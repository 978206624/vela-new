import { BaseWorkflowCommand, type CommandExecuteParams } from './base-command'
import { BasePromptBuilder } from '../../prompts/prompt-builder'
import { getPromptTemplate } from '../../prompt-templates'
import { ipc } from '../../ipc-client'
import type { WorkflowContext, StepCallbacks } from '../../../stores/workflow-store'

/**
 * CompleteCharacterProfileCommand — AI 补全角色静态人设
 *
 * 从角色出场的定稿正文片段 + 架构人物群像，反向推断 7 个静态字段（不落库，交预览/批量确认）。
 * 出场章定位：正文 `instr` 精确命中（权威）∪ 蓝图 characters/notes（hint）∪ currentState.updatedAtChapter（兜底）；
 * 导入旧作（未定稿）降级用每章 latest draft。正文按 Head+Tail 截断（外貌/背景在首出场章、关系/弧光在近章）。
 */

export const PROFILE_FIELDS = ['appearance', 'personality', 'background', 'abilities', 'motivation', 'arc', 'relationships'] as const
export type ProfileField = typeof PROFILE_FIELDS[number]
export type CharacterProfile = Record<ProfileField, string>
export type ProfileEvidence = Record<string, Array<{ chapter: number; quote: string }>>
export interface InferProfileResult { profile: CharacterProfile; evidence: ProfileEvidence }

/** 出场片段总字符预算（中文约 1.5 字符/token，~16K token，预留输出余量） */
const MAX_EXCERPT_CHARS = 24000
const HEAD_CHAPTERS = 2  // 首次出场章（外貌/背景/初始动机集中处）
const TAIL_CHAPTERS = 4  // 最近出场章（关系/弧光演化）

/** no-op 回调：按钮即时触发、不在 workflow step 框架内时用 */
const NOOP_CALLBACKS: StepCallbacks = { log: () => {}, setProgress: () => {}, appendText: () => {} }

class ProfilePromptBuilder extends BasePromptBuilder {
  withCharacterName(v: string): this { this.variables.character_name = v; return this }
  withCharacterDynamics(v: string): this { this.variables.character_dynamics = v; return this }
  withExcerpts(v: string): this { this.variables.appearance_excerpts = v; return this }
}

function emptyProfile(): CharacterProfile {
  return { appearance: '', personality: '', background: '', abilities: '', motivation: '', arc: '', relationships: '' }
}

/** 取最早 head 章 + 最近 tail 章（去重、升序）；总数不超则全取 */
function headTail(chapters: number[], head: number, tail: number): number[] {
  if (chapters.length <= head + tail) return chapters
  const picked = new Set<number>([...chapters.slice(0, head), ...chapters.slice(-tail)])
  return [...picked].sort((a, b) => a - b)
}

/** 把 LLM 返回归一为 {profile(7字符串), evidence(仅预览)}，对脏输出严格防御不致命 */
function normalize(parsed: { profile?: Record<string, unknown>; evidence?: unknown }): InferProfileResult {
  const p = (parsed?.profile ?? {}) as Record<string, unknown>
  const profile = emptyProfile()
  for (const f of PROFILE_FIELDS) profile[f] = typeof p[f] === 'string' ? (p[f] as string) : ''

  // evidence 逐字段严格校验：只保留 {chapter:number, quote:string} 形态的数组项，
  // LLM 若把它写成字符串/对象/缺失，一律丢弃，避免预览侧 ev.map 崩溃（白屏）。
  const rawEv = (parsed?.evidence && typeof parsed.evidence === 'object' && !Array.isArray(parsed.evidence))
    ? (parsed.evidence as Record<string, unknown>)
    : {}
  const evidence: ProfileEvidence = {}
  for (const f of PROFILE_FIELDS) {
    const arr = rawEv[f]
    if (!Array.isArray(arr)) continue
    const items = arr.filter(
      (x): x is { chapter: number; quote: string } =>
        !!x && typeof x === 'object'
        && typeof (x as { chapter?: unknown }).chapter === 'number'
        && typeof (x as { quote?: unknown }).quote === 'string'
    )
    if (items.length > 0) evidence[f] = items
  }
  return { profile, evidence }
}

export class CompleteCharacterProfileCommand extends BaseWorkflowCommand<InferProfileResult> {
  /** 满足抽象契约：从 step.characterName 取角色名 */
  async execute(params: CommandExecuteParams): Promise<InferProfileResult> {
    const name = (params.step as { characterName?: string })?.characterName ?? ''
    return this.infer(name, { callbacks: params.callbacks, context: params.context })
  }

  /**
   * 推断单个角色人设（不落库）。opts.context 用于取消（context.cancelled 翻转即中断 LLM）。
   */
  async infer(
    characterName: string,
    opts?: { callbacks?: StepCallbacks; context?: WorkflowContext }
  ): Promise<InferProfileResult> {
    const name = characterName.trim()
    if (!name) return { profile: emptyProfile(), evidence: {} }
    const callbacks = opts?.callbacks ?? NOOP_CALLBACKS
    const context = opts?.context

    // 1. 定位出场章：正文 instr 精确命中（权威）；无定稿命中则导入旧作兜底（每章 latest draft）
    let chapters = await ipc.invoke('db:draft-find-chapters-by-name', name, true)
    if (chapters.length === 0) {
      chapters = await ipc.invoke('db:draft-find-chapters-by-name', name, false)
    }

    // 蓝图 characters/notes 含名（hint）+ currentState.updatedAtChapter（兜底候选）取并集
    const blueprints = await ipc.invoke('db:blueprint-get-all')
    const bpChapters = blueprints
      .filter(b => (Array.isArray(b.characters) && b.characters.includes(name)) || (b.notes?.includes(name)))
      .map(b => b.chapterNumber)
    const allChars = await ipc.invoke('db:character-get-all')
    const stateChapter = allChars.find(c => c.name === name)?.currentState?.updatedAtChapter ?? 0

    const chapterSet = new Set<number>([...chapters, ...bpChapters])
    if (stateChapter > 0) chapterSet.add(stateChapter)
    const allChapters = [...chapterSet].sort((a, b) => a - b)

    // 2. Head+Tail 选章 → 3. 读正文拼片段（每章独立预算，保证 tail 不被 head 挤掉）
    const picked = headTail(allChapters, HEAD_CHAPTERS, TAIL_CHAPTERS)
    const excerpts = await this.buildExcerpts(picked)

    // 4. 架构人物群像
    const core = await ipc.invoke('db:project-core-get')
    const dynamics = core?.charactersArch ?? ''

    // 5. prompt → LLM(json_object) → 解析归一
    const template = getPromptTemplate('infer_character_profile')
    if (!template) throw new Error('未找到 infer_character_profile 模板')
    const builder = new ProfilePromptBuilder(template)
      .withCharacterName(name)
      .withCharacterDynamics(dynamics || '（无架构人物群像）')
      .withExcerpts(excerpts || '（未找到该角色的出场正文片段，请仅依据人物群像归纳，无依据则全部留空）')

    const raw = await this.callLLMWithBuilder(
      builder, callbacks,
      { responseFormat: { type: 'json_object' }, purposeLabel: '补全人设', manageProgress: false },
      context
    )
    return normalize(this.parseJSON<{ profile?: Record<string, unknown>; evidence?: unknown }>(raw))
  }

  /**
   * 读取选定章节正文，逐章 finalized 优先、latest 兜底（不用全局开关——三源并集里
   * blueprint/state 来源章可能未定稿）；每章独立字符预算，保证 head 与 tail 都进得了
   * prompt（避免长 head 把预算吃光、tail 的关系/弧光丢失）。
   */
  private async buildExcerpts(chapters: number[]): Promise<string> {
    if (chapters.length === 0) return ''
    const perChapterCap = Math.max(1, Math.floor(MAX_EXCERPT_CHARS / chapters.length))
    const parts: string[] = []
    for (const ch of chapters) {
      const meta = (await ipc.invoke('db:draft-get-finalized', ch)) ?? (await ipc.invoke('db:draft-get-latest', ch))
      if (!meta) continue
      const full = await ipc.invoke('db:draft-get-full', meta.id)
      const body = full?.content?.trim()
      if (!body) continue
      const clip = body.length > perChapterCap ? body.slice(0, perChapterCap) + '\n…（本章节选）' : body
      parts.push(`【第 ${ch} 章】\n${clip}`)
    }
    return parts.join('\n\n---\n\n')
  }
}

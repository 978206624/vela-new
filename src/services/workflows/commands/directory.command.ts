import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { getPromptTemplate } from '../../prompt-templates'
import { DirectoryPromptBuilder } from '../../prompts/prompt-builder'
import { DirectoryWorkflowParams, ChapterBlueprint, parseTextBlueprints, saveAllBlueprints } from '../directory-workflow'
import { globalEventBus } from '../../../shared/event-bus'
import { coerceChapterRole } from '../../../shared/chapter-roles'

/**
 * 从流式 JSON（裸数组 [...] 或 {"blueprints":[...]}）中抽取「已闭合的顶层对象」字符串。
 * 用于边生成边解析：定位首个 `[`（蓝图数组），之后按花括号配对（忽略字符串内的括号）逐个抽出完整对象。
 *
 * 增量扫描：传入上次返回的 nextIndex 作为 fromIndex，仅从「最后一个完整对象之后」继续扫，
 * 避免每个 chunk 都从头重扫整串（O(n²)→O(n)）。fromIndex<=0 时先定位数组起始 `[`。
 */
function extractArrayObjects(text: string, fromIndex = 0): { objects: string[]; nextIndex: number } {
  let i = fromIndex
  if (i <= 0) {
    const arrStart = text.indexOf('[')
    if (arrStart < 0) return { objects: [], nextIndex: 0 }
    i = arrStart + 1
  }
  const objects: string[] = []
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  let nextIndex = i // 推进到最后一个完整对象之后；未完成对象会在下次有更多文本时从此处重扫
  for (; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '{') { if (depth === 0) start = i; depth++ }
    else if (c === '}') { depth--; if (depth === 0 && start >= 0) { objects.push(text.slice(start, i + 1)); start = -1; nextIndex = i + 1 } }
  }
  return { objects, nextIndex }
}

/** 把解析出的原始对象规范化为完整 ChapterBlueprint（与 parseTextBlueprints 同口径） */
function normalizeBlueprint(p: Record<string, unknown>): ChapterBlueprint {
  const chapterNumber = Number(p.chapterNumber ?? p.chapter_number ?? 0)
  return {
    chapterNumber,
    title: String(p.title || `第${chapterNumber}章`),
    role: coerceChapterRole(p.role),
    purpose: String(p.purpose || ''),
    keyEvents: String(p.keyEvents ?? p.key_events ?? ''),
    characters: Array.isArray(p.characters) ? p.characters as string[] : [],
    suspenseHook: String(p.suspenseHook ?? p.suspense_hook ?? ''),
    userGuidance: '',
    notes: '',
    notesUpdatedAt: '',
    targetWords: Number(p.targetWords) || 0,
  }
}

export class GenerateDirectoryCommand extends BaseWorkflowCommand<ChapterBlueprint[]> {
  constructor(private params: DirectoryWorkflowParams) {
    super()
  }

  async execute({ context, callbacks }: CommandExecuteParams): Promise<ChapterBlueprint[]> {
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error('未打开项目')

    const architecture = context.data.architecture as string
    const existingBlueprints = (context.data.existingBlueprints || []) as ChapterBlueprint[]

    const totalChapters = project.novelConfig.totalChapters
    const globalGuidance = project.novelConfig.globalGuidance || ''
    const genre = project.novelConfig.genre || ''

    let startChapter = 1
    let endChapter = totalChapters

    if (this.params.mode === 'append') {
      startChapter = this.params.startChapter || (existingBlueprints.length + 1)
      if (this.params.count && this.params.count > 0) {
        endChapter = startChapter + this.params.count - 1
      }
    } else if (this.params.count && this.params.count > 0) {
      endChapter = Math.min(this.params.count, totalChapters)
    }

    callbacks.log(`生成第 ${startChapter}–${endChapter} 章蓝图...`)

    // 从大纲用途实际解析的模型获取 maxTokens，动态计算每批次章节数（与下方 purpose:'outline' 调用一致）
    const llmStore = (await import('../../../stores/llm-store')).useLLMStore.getState()
    const outlineModelId = llmStore.getModelIdForPurpose('outline')
    const outlineModel = llmStore.models.find(m => m.id === outlineModelId)
    const modelMaxTokens = outlineModel?.maxTokens || 4096
    const outputBudget = Math.floor(modelMaxTokens * 0.6)  // 预留 40% 给 prompt + 思考
    const tokensPerChapter = 200
    const batchSize = Math.min(50, Math.max(5, Math.floor(outputBudget / tokensPerChapter)))

    const newBlueprints: ChapterBlueprint[] = []
    // 使用游标追踪生成进度，支持 AI 超额返回时智能跳过后续批次
    let cursor = startChapter
    const total = endChapter - startChapter + 1
    // 流式增量已保存的章节号（避免同一章在流中被重复保存）
    const savedChapters = new Set<number>()

    while (cursor <= endChapter) {
      if (context.cancelled) { callbacks.log('已取消'); break }

      const batchEnd = Math.min(cursor + batchSize - 1, endChapter)
      callbacks.log(`  正在生成第 ${cursor}–${batchEnd} 章...`)

      let prompt: string
      if (cursor === 1 && this.params.mode === 'full') {
        const template = getPromptTemplate('chapter_blueprint')
        if (!template) throw new Error('模板丢失')
        prompt = new DirectoryPromptBuilder(template)
          .withNovelArchitecture(architecture)
          .withNumberOfChapters(endChapter)
          .withGlobalGuidance(globalGuidance)
          .withGenre(genre)
          .withPacingGuidance((context.data.pacingGuidance as string) || '')
          .build()
      } else {
        const template = getPromptTemplate('chapter_blueprint_chunk')
        if (!template) throw new Error('模板丢失')

        const prevAll = [...existingBlueprints, ...newBlueprints]
        const chapterList = prevAll.slice(-100).map(c => `第${c.chapterNumber}章 ${c.title}：${c.keyEvents}`).join('\n')

        prompt = new DirectoryPromptBuilder(template)
          .withNovelArchitecture(architecture)
          .withChapterList(chapterList || '（首批生成）')
          .withNumberOfChapters(totalChapters)
          .withN(cursor)
          .withM(batchEnd)
          .withGlobalGuidance(globalGuidance)
          .withGenre(genre)
          .withPacingGuidance((context.data.pacingGuidance as string) || '')
          .build()
      }

      callbacks.setProgress(Math.round(((cursor - startChapter) / total) * 90))

      // 批次内流式增量入库：边生成边抽出"已闭合的单个蓝图对象"逐条保存 + 通知编辑器，
      // 让蓝图像草稿一样一条条动态出现（不必等整批 JSON 完成；与批次数无关，单批次也生效）。
      // 仅作"预览写入"，本批最终会被下方权威整批保存覆盖。
      const previewSaves: Promise<unknown>[] = []
      let scanOffset = 0 // 增量扫描偏移：仅从上次解析到的位置继续，避免每 chunk 从头重扫
      const onStreamChunk = (fullSoFar: string) => {
        if (context.cancelled) return
        const { objects, nextIndex } = extractArrayObjects(fullSoFar, scanOffset)
        scanOffset = nextIndex
        const fresh: ChapterBlueprint[] = []
        for (const objStr of objects) {
          let p: Record<string, unknown>
          try { p = JSON.parse(objStr) } catch { continue }
          const n = Number(p.chapterNumber ?? p.chapter_number)
          if (!Number.isInteger(n) || n < cursor || n > endChapter || savedChapters.has(n)) continue
          savedChapters.add(n)
          fresh.push(normalizeBlueprint(p))
        }
        if (fresh.length > 0) {
          previewSaves.push(
            saveAllBlueprints(fresh)
              .then(() => globalEventBus.emit('REFRESH_RESOURCE', { resources: ['blueprints'] }))
              .catch(() => { /* 预览写入失败由下方权威整批保存兜底 */ })
          )
        }
      }

      // systemRole 由模板定义，不再硬编码
      // manageProgress:false —— 由本命令自管整体进度（按批推进），避免 callLLM 每批把进度覆盖成 10/90 来回跳
      // 传 context —— 启用 callLLM 的取消轮询，取消时中断在途流（onStreamChunk 开头也判 cancelled）
      const systemRole = getPromptTemplate('chapter_blueprint')?.systemRole || '你是一位经验丰富的网文架构师。'
      let resultText = ''
      try {
        resultText = await this.callLLM(prompt, systemRole, callbacks, { responseFormat: { type: 'json_object' }, purpose: 'outline', manageProgress: false, onStreamChunk }, context)
      } finally {
        // 无论成功/失败/取消，都等本批已发出的"预览写入"落定：
        // 避免悬挂 promise，也避免其晚于下方权威保存返回而用空 userGuidance/notes 覆盖最终状态。
        await Promise.allSettled(previewSaves)
      }

      // ★ 关键修复：接受 AI 返回的从 cursor 到 endChapter 范围内的所有有效章节
      // AI 可能一次性返回超出本批次（batchEnd）的章节，全部保留，避免浪费和重复 LLM 请求
      const parsed = parseTextBlueprints(resultText, cursor, endChapter)
      newBlueprints.push(...parsed)

      // ==== 权威整批入库（确保最后落地）====
      if (parsed.length > 0) {
        await saveAllBlueprints(parsed)
        useProjectStore.getState().refreshFileTree()
        globalEventBus.emit('REFRESH_RESOURCE', { resources: ['blueprints'] })
      }

      // 计算本次实际生成到的最大章节号，推进游标到已生成的最后一章之后
      const actualMaxChapter = parsed.length > 0
        ? Math.max(...parsed.map(p => p.chapterNumber))
        : batchEnd
      callbacks.log(`  ✅ 第 ${cursor}–${actualMaxChapter} 章完成（${parsed.length} 章）并已保存入库`)
      // 推进整体进度到本批已完成位置（manageProgress:false 下由此处主导，单调递增不回跳）
      callbacks.setProgress(Math.round(((actualMaxChapter - startChapter + 1) / total) * 90))

      cursor = actualMaxChapter + 1
    }

    context.data.newBlueprints = newBlueprints
    context.data.existingBlueprints = existingBlueprints

    callbacks.log(`✅ 共生成 ${newBlueprints.length} 章蓝图`)
    return newBlueprints
  }
}

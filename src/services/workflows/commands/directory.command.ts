import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { useVolumeStore } from '../../../stores/volume-store'
import { getPromptTemplate } from '../../prompt-templates'
import { DirectoryPromptBuilder } from '../../prompts/prompt-builder'
import { DirectoryWorkflowParams, ChapterBlueprint, parseTextBlueprints, saveAllBlueprints } from '../directory-workflow'
import { globalEventBus } from '../../../shared/event-bus'
import { coerceChapterRole } from '../../../shared/chapter-roles'
import {
  getEffectiveTotalChapters, getVolumeCompass, getVolumeOutline, checkRangeCoverage, describeNotReady,
  type VolumeCompassData,
} from '../../volume-service'
import { formatOpenThreads } from '../../prompts/volume-context'

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

/** 把卷罗盘拼成 prompt 用的「本卷定位」文本。单卷模式传 null，返回空串 */
function formatVolumeContext(compass: VolumeCompassData | null): string {
  if (!compass) return ''
  return [
    `当前为「${compass.title}」（第 ${compass.startChapter}–${compass.endChapter} 章）`,
    compass.premise.trim() && `【本卷主线】\n${compass.premise.trim()}`,
    compass.openingState.trim() && `【上一卷收卷状态】\n${compass.openingState.trim()}`,
  ].filter(Boolean).join('\n\n')
}

export class GenerateDirectoryCommand extends BaseWorkflowCommand<ChapterBlueprint[]> {
  constructor(private params: DirectoryWorkflowParams) {
    super()
  }

  async execute({ context, callbacks }: CommandExecuteParams): Promise<ChapterBlueprint[]> {
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error('未打开项目')

    const architectureBase = (context.data.architectureBase as string) || ''
    const coreSynopsis = (context.data.coreSynopsis as string) || ''
    const existingBlueprints = (context.data.existingBlueprints || []) as ChapterBlueprint[]

    const globalGuidance = project.novelConfig.globalGuidance || ''
    const genre = project.novelConfig.genre || ''

    // ⚠️ 分卷快照只取一次并贯穿全程：目录生成跨多批次、可达数分钟，
    // 每批现取会让「生成中途用户续了一卷」导致前后两批按不同的卷边界推演。
    const snap = useVolumeStore.getState().getSnapshot()

    // 全书有效总章数以**卷表**为准（续卷会把 novelConfig.totalChapters 同步过去，
    // 但用户手改小说配置可能让二者偏离）。未就绪必须终止——
    // 把「加载中」当零卷会退回用全书 totalChapters + 已闭环 synopsis 的老路
    const totalQ = getEffectiveTotalChapters(snap, project.novelConfig)
    if (!totalQ.ready) throw new Error(`无法确定全书总章数：${describeNotReady(totalQ.reason)}`)
    const totalChapters = totalQ.value

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

    // 空区间必须显式报错，不能让 while 直接不进入。
    // 典型触发：末卷止于 60 时从第 61 章续写且不传 count —— endChapter 仍是 60，
    // 循环一次都不跑，工作流却以「已生成 0 章」**静默成功**，用户以为生成过了
    if (startChapter > endChapter) {
      throw new Error(
        `生成范围为空：起始第 ${startChapter} 章已超过结束第 ${endChapter} 章。` +
        `若要续写新章节，请先「续写下一卷」扩展卷区间，或显式指定生成章数`
      )
    }

    // 整个请求区间必须被现有卷连续覆盖——**在任何 LLM 调用与落库之前**校验。
    // 逐批到了才发现是不够的：请求 58–63 时，58–60 那批会先跑完模型并把蓝图写进库，
    // 游标推到 61 才报错，工作流虽然失败，副作用却已经产生
    const coverageQ = checkRangeCoverage(snap, startChapter, endChapter)
    if (!coverageQ.ready) throw new Error(`无法校验生成范围：${describeNotReady(coverageQ.reason)}`)
    if (coverageQ.value && !coverageQ.value.covered) {
      throw new Error(coverageQ.value.message)
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

      // 逐批按 cursor 重算所属卷：一次生成可能横跨两卷，卷边界一变，
      // 「全书规模」「本卷定位」「情节大纲」三样都得跟着换
      const compassQ = getVolumeCompass(snap, cursor)
      if (!compassQ.ready) throw new Error(`无法确定第 ${cursor} 章所属卷：${describeNotReady(compassQ.reason)}`)
      const compass = compassQ.value

      // 目录生成**只接受精确命中**：prior（回落前一卷）与 unassigned（首卷之前）
      // 都意味着 cursor 不属于任何卷，放行会让 prompt 同时出现
      // 「共 60 章」与「推演第 61–63 章」，还会写入无卷归属的蓝图。
      // 正常入口下走不到这里——整区间已由 checkRangeCoverage 前置校验过，
      // 本条是纵深防御（若将来有人放宽前置校验，它仍能兜住）。
      if (compass.kind === 'prior' || compass.kind === 'unassigned') {
        const tail = compass.kind === 'prior'
          ? `（最近一卷「${compass.volume.title}」止于第 ${compass.volume.endChapter} 章）`
          : '（本章在首卷起点之前）'
        throw new Error(
          `第 ${cursor} 章不属于任何卷${tail}。` +
          `请先「续写下一卷」建立卷区间，或把生成范围收回到已有卷内`
        )
      }

      // 单批**不得横跨卷界**：卷一 1–10 时从第 8 章生成 6 章，
      // 若不夹住就会得到 8–12 这一批——用卷一的大纲、声明「共 10 章」，
      // 却要求生成属于卷二的第 11–12 章，与本 Task 要消除的矛盾指令同源
      // 上面已排除 prior / unassigned，此处只剩 single（单卷模式）与 exact
      const vol = compass.kind === 'exact' ? compass.volume : null
      const volumeScopeEnd = vol ? Math.min(endChapter, vol.endChapter) : endChapter
      const batchEnd = Math.min(cursor + batchSize - 1, volumeScopeEnd)
      callbacks.log(`  正在生成第 ${cursor}–${batchEnd} 章...`)

      const outlineQ = getVolumeOutline(snap, cursor, { synopsis: coreSynopsis })
      if (!outlineQ.ready) throw new Error(`无法确定情节大纲：${describeNotReady(outlineQ.reason)}`)
      // 零卷时 outlineQ.value 就是（已过 50 字闸门的）全书 synopsis，
      // 拼出来与分卷前逐字节一致；有卷时它是本卷主线 + 卷内大纲，不含全书 synopsis
      const architecture = [architectureBase, outlineQ.value].filter(s => s.trim()).join('\n\n---\n\n')

      // 「全书规模」在分卷模式下报**本卷末章**：报全书总章数会与
      // 「请推演第 N–M 章」形成矛盾指令——AI 一边被告知全书 500 章、
      // 一边只写到第 60 章，收尾节奏必然错乱（Spec §4.11 要消除的正是这个）
      const scopeTotal = vol ? vol.endChapter : totalChapters
      const volumeContext = formatVolumeContext(vol)
      // 零卷必须传空串而非 formatOpenThreads 的「（无未回收伏笔）」占位文案——
      // 模板标题用的是「（如有）」形态，finalizePrompt 只在值为空时才裁掉整段，
      // 传占位文案会给单卷模式留一个无意义的空台账小节
      const openThreads = vol && vol.openThreads.length > 0
        ? formatOpenThreads(vol.openThreads)
        : ''

      let prompt: string
      // legacy 全量模板一次性要求生成 1..endChapter，且没有 volume_context / open_threads
      // 两个占位符。分卷项目走这条会拿着第一卷的 architecture 生成整本书，
      // 后续批次再也切不回第二卷——故它只对**真零卷**开放
      if (vol === null && cursor === 1 && this.params.mode === 'full') {
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
        // 优先取 notes（定稿后处理由 AI 从**正文**提炼的实际要点），
        // 回落 keyEvents（当初的计划）。接着事实续，不接着计划续——
        // 计划与写成的正文往往已经分叉，喂计划会让新章节接到一条不存在的剧情线上
        const chapterList = prevAll.slice(-100)
          .map(c => `第${c.chapterNumber}章 ${c.title}：${c.notes?.trim() || c.keyEvents}`)
          .join('\n')

        prompt = new DirectoryPromptBuilder(template)
          .withNovelArchitecture(architecture)
          .withChapterList(chapterList || '（首批生成）')
          .withNumberOfChapters(scopeTotal)
          .withN(cursor)
          .withM(batchEnd)
          .withGlobalGuidance(globalGuidance)
          .withGenre(genre)
          .withPacingGuidance((context.data.pacingGuidance as string) || '')
          .withVolumeContext(volumeContext)
          .withOpenThreads(openThreads)
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
          // 接受上界是 volumeScopeEnd 而非 endChapter：模型常一次超额返回，
          // 若放行跨卷章节，它们会带着**上一卷的上下文**直接落库，
          // 而 cursor 随后跳过这些章号，下一卷的大纲与伏笔台账永远参与不进来
          if (!Number.isInteger(n) || n < cursor || n > volumeScopeEnd || savedChapters.has(n)) continue
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
      // 同上：权威解析的接受上界同样夹到卷末章，否则超额返回的跨卷章节
      // 会绕过流式预存那道过滤、从这里落库
      const parsed = parseTextBlueprints(resultText, cursor, volumeScopeEnd)
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

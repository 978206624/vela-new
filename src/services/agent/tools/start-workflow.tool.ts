/**
 * start_workflow — 触发创作工作流（Phase 8：对话即写章）
 *
 * 不再只「切面板 + 提示手动启动」，而是真正构造 WorkflowDefinition 并调用
 * workflow-store.startWorkflow()，让对话 Agent 直接驱动确定性创作管线。
 * 写入型工具 requiresConfirmation:true —— 经 ConfirmCard 人工批准后才执行。
 */
import { buildAgentTool } from '../tool-registry'
import { ipc } from '../../ipc-client'
import { getProjectToken } from '../../../stores/volume-store'
import { useWorkflowStore, type WorkflowDefinition, type WorkflowType } from '../../../stores/workflow-store'
import { useLayoutStore } from '../../../stores/layout-store'
import {
  guardChapterWriting,
  guardDirectoryGeneration,
  guardArchitectureGeneration,
  guardCharacterRegeneration,
} from '../../workflow-guards'
import type { ChapterInfo } from '../../workflows/chapter-workflow'

/** workflow 枚举 → 中文名 + 运行实例类型（并发检测用） */
const WORKFLOW_META: Record<string, { label: string; runType: WorkflowType }> = {
  generate_draft: { label: '写稿', runType: 'chapter_creation' },
  review: { label: '审稿', runType: 'chapter_creation' },
  refine: { label: '修稿', runType: 'chapter_creation' },
  finalize: { label: '定稿', runType: 'chapter_creation' },
  generate_blueprint: { label: '生成蓝图', runType: 'directory' },
  generate_architecture: { label: '生成架构', runType: 'architecture_generation' },
}

const CHAPTER_WORKFLOWS = new Set(['generate_draft', 'review', 'refine', 'finalize'])

/** 取某章最新草稿（filePath + 正文 + 标题），供审稿/修稿/定稿使用 */
async function getLatestDraft(chapterNumber: number): Promise<{ draftPath: string; draftContent: string; chapterTitle: string } | null> {
  const meta = await ipc.invoke('db:draft-get-latest', chapterNumber)
  if (!meta) return null
  const full = await ipc.invoke('db:draft-get-full', meta.id)
  if (!full) return null
  const bp = await ipc.invoke('db:blueprint-get', chapterNumber)
  return {
    draftPath: `vela://draft/${meta.id}`,
    draftContent: full.content,
    chapterTitle: bp?.title || `第${chapterNumber}章`,
  }
}

/** 根据 workflow 类型构造 WorkflowDefinition；返回 null 时 reason 说明原因 */
async function buildDefinition(
  workflow: string,
  chapterNumber: number | undefined,
  blueprintRange?: { startChapter?: number; count?: number },
  /** execute 入口捕获的 token；目录工作流必须用它，而不是自己现取 */
  actionToken?: number,
): Promise<{ def: WorkflowDefinition } | { error: string }> {
  switch (workflow) {
    case 'generate_draft': {
      const guard = await guardChapterWriting(chapterNumber)
      if (!guard.ok) return { error: guard.message || '写稿前置条件未满足' }
      const bp = await ipc.invoke('db:blueprint-get', chapterNumber!)
      if (!bp) return { error: `第 ${chapterNumber} 章尚无蓝图，请先生成章节蓝图。` }
      const chapterInfo: ChapterInfo = {
        chapterNumber: chapterNumber!,
        title: bp.title || `第${chapterNumber}章`,
        role: bp.role,
        purpose: bp.purpose,
        characters: bp.characters ?? [],
        keyEvents: bp.keyEvents,
        suspenseHook: bp.suspenseHook || undefined,
        userGuidance: bp.userGuidance || undefined,
      }
      const { createChapterWorkflow } = await import('../../workflows/chapter-workflow')
      // 不传 prebuilt：命令自行拼装上下文（与 UI 预览同一拼装逻辑）
      return { def: createChapterWorkflow(chapterInfo) }
    }

    case 'review': {
      const d = await getLatestDraft(chapterNumber!)
      if (!d) return { error: `第 ${chapterNumber} 章尚无草稿可审，请先写稿。` }
      const { createReviewOnlyWorkflow } = await import('../../workflows/chapter-workflow')
      return { def: createReviewOnlyWorkflow({ chapterNumber: chapterNumber!, chapterTitle: d.chapterTitle, draftPath: d.draftPath, draftContent: d.draftContent }) }
    }

    case 'refine': {
      const d = await getLatestDraft(chapterNumber!)
      if (!d) return { error: `第 ${chapterNumber} 章尚无草稿可修，请先写稿。` }
      const { createRefineOnlyWorkflow } = await import('../../workflows/chapter-workflow')
      return { def: createRefineOnlyWorkflow({ chapterNumber: chapterNumber!, chapterTitle: d.chapterTitle, draftPath: d.draftPath, draftContent: d.draftContent }) }
    }

    case 'finalize': {
      const d = await getLatestDraft(chapterNumber!)
      if (!d) return { error: `第 ${chapterNumber} 章尚无草稿可定稿，请先写稿。` }
      const { createFinalizeWorkflow } = await import('../../workflows/chapter-workflow')
      // 显式传 execute 入口捕获的 token：查草稿、动态 import 都是 await，
      // 让 createFinalizeWorkflow 自己现取等于把捕获点推迟到这些延迟之后
      return { def: createFinalizeWorkflow({ chapterNumber: chapterNumber!, chapterTitle: d.chapterTitle, draftPath: d.draftPath, draftContent: d.draftContent }, actionToken) }
    }

    case 'generate_blueprint': {
      const guard = await guardDirectoryGeneration()
      if (!guard.ok) return { error: guard.message || '生成蓝图前置条件未满足' }
      // guard 放行但带警告（架构不完整）：Agent 无 UI 的二次确认机制，引导用户到「章节蓝图」界面
      // 由其决定是否带不完整架构继续，避免静默生成低质蓝图浪费 token
      if (guard.message) {
        return { error: `${guard.message}\n\n如确认在当前架构下继续，请在「章节蓝图」界面生成（可在那里二次确认）。` }
      }
      const { createDirectoryWorkflow } = await import('../../workflows/directory-workflow')
      const existing = await ipc.invoke('db:blueprint-get-all')

      // 无蓝图 → 全量生成（这是唯一允许 mode:'full' 的情形）。
      // 不传 count 时**不要硬塞默认值**：命令会用「有效总章数」当末端，
      // 那才是全书真实规模；塞个数字反而可能越过总章数生成
      if (existing.length === 0) {
        if (blueprintRange?.count !== undefined && !Number.isSafeInteger(blueprintRange.count)) {
          return { error: `生成章数非法：${blueprintRange.count}` }
        }
        // ⚠️ `mode:'full'` 的起点在命令里**写死为 1**，本分支根本没法把 startChapter 传下去。
        // 之前直接忽略它，于是 `start=50, count=10` 会被"成功受理"、实际生成第 1–10 章——
        // 用户拿到的范围和他要的完全不同，还白烧一次模型调用。
        // 不静默改写、也不假装支持：显式拒绝，并说明空项目只能从第 1 章开始。
        if (blueprintRange?.startChapter !== undefined && blueprintRange.startChapter !== 1) {
          return {
            error:
              `当前项目还没有任何章节蓝图，只能从第 1 章开始生成，` +
              `无法从第 ${blueprintRange.startChapter} 章起。\n` +
              `若要跳到第 ${blueprintRange.startChapter} 章，请先生成前面的章节蓝图。`,
          }
        }
        return { def: createDirectoryWorkflow({ mode: 'full', count: blueprintRange?.count }, actionToken) }
      }

      // 已有蓝图 → **只能追加**。全量覆盖是破坏性操作，而 Agent 没有 UI 那样的
      // 二次确认机制，故 mode:'full' 对 Agent 永久不可达；要重来只能去「章节蓝图」界面。
      //
      // 起始章缺省取「现有最大章号 + 1」而非 `existing.length + 1`：
      // 蓝图区间允许有缺口（目录生成接受 AI 超额返回并按最大章号推进游标），
      // 用条数推算会算出一个早已存在的章号，导致覆盖已有蓝图
      const maxChapter = existing.reduce((m, b) => Math.max(m, b.chapterNumber), 0)
      const startChapter = blueprintRange?.startChapter ?? maxChapter + 1
      if (startChapter <= maxChapter) {
        return {
          error:
            `第 ${startChapter} 章已有蓝图（当前已排到第 ${maxChapter} 章）。` +
            `Agent 只能向后追加，覆盖既有蓝图请在「章节蓝图」界面操作。`,
        }
      }
      // ⚠️ 溢出校验必须落在**解析后的起点**上，不能只查「两个参数都显式给了」的组合：
      // 省略 start、只传 count = MAX_SAFE_INTEGER 时，联合校验根本不会执行，
      // 而派生起点 + 这个 count 算出的末章早已不是安全整数。
      // 默认起点 `maxChapter + 1` 本身也要验（maxChapter 来自库，理论上可被写脏）。
      if (!Number.isSafeInteger(startChapter) || startChapter < 1) {
        return { error: `推导出的起始章号非法：${startChapter}` }
      }
      if (blueprintRange?.count !== undefined) {
        const end = startChapter + blueprintRange.count - 1
        if (!Number.isSafeInteger(end) || end < startChapter) {
          return { error: `生成范围非法：第 ${startChapter} 章起 ${blueprintRange.count} 章超出可表示范围` }
        }
      }
      // ⚠️ 缺省**不传 count**。硬塞 50 会算出 startChapter+49 的固定区间：
      // 已排到第 90 章、末卷止于 100 时会请求 91–140，被区间覆盖校验整体拒绝；
      // 零卷项目则可能越过全书总章数生成到 140。不传时命令用有效总章数收口。
      return {
        def: createDirectoryWorkflow({
          mode: 'append',
          startChapter,
          count: blueprintRange?.count,
        }, actionToken),
      }
    }

    case 'generate_architecture': {
      const guard = guardArchitectureGeneration()
      if (!guard.ok) return { error: guard.message || '生成架构前置条件未满足' }
      // 安全 1：已有蓝图时禁止重生成架构（含角色图谱步骤，会破坏角色卡/蓝图/章节状态链）
      const charGuard = await guardCharacterRegeneration()
      if (!charGuard.ok) return { error: charGuard.message || '已有章节蓝图，不可重新生成架构。' }
      // 安全 2：架构已生成时不允许 Agent 全量覆盖。哨兵只用 premise——
      // synopsis/worldbuilding/charactersArch 同时承载用户配置种子（coreOutline/worldSetting/protagonistProfile
      // 经 project-controller 映射），不能当"已生成"判据，否则会误拦"已配置未生成架构"的正常新项目。
      const core = await ipc.invoke('db:project-core-get')
      const hasContent = (t?: string | null) => !!t && t.length > 50 && !t.includes('> 待生成')
      if (core && hasContent(core.premise)) {
        return { error: '故事架构已生成。为避免误覆盖，重新生成请在「故事架构」向导中操作（可选择生成哪些步骤）。' }
      }
      const { createArchitectureWorkflow } = await import('../../workflows/architecture-workflow')
      return { def: createArchitectureWorkflow({}, actionToken) }
    }

    default:
      return { error: `未知工作流类型：${workflow}` }
  }
}

export const startWorkflowTool = buildAgentTool({
  name: 'start_workflow',
  description: '触发并真正启动 Vela 创作工作流（写稿/审稿/修稿/定稿/生成蓝图/生成架构）。启动后在 AI 输出面板流式执行多步骤创作流程。写稿/审稿/修稿/定稿需提供 chapter_number；生成蓝图可用 blueprint_start_chapter / blueprint_count 指定追加范围（缺省生成到有效末章；已有蓝图时只能向后追加，不能覆盖）。',
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      workflow: {
        type: 'string',
        description: '工作流类型',
        enum: ['generate_draft', 'review', 'refine', 'finalize', 'generate_blueprint', 'generate_architecture'],
      },
      chapter_number: {
        type: 'number',
        description: '章节号（写稿/审稿/修稿/定稿必填）',
      },
      blueprint_start_chapter: {
        type: 'number',
        description: '生成蓝图的起始章号（仅 generate_blueprint）。缺省从现有最大章号的下一章开始追加。只能向后追加，不能覆盖已有蓝图。',
      },
      blueprint_count: {
        type: 'number',
        description: '本次生成多少章蓝图（仅 generate_blueprint）。缺省不限，生成到当前卷/全书的有效末章为止。',
      },
    },
    required: ['workflow'],
  },
  requiresConfirmation: true,
  isReadOnly: false,
  execute: async (args) => {
    // ⚠️ 在**任何 await 之前**捕获。buildDefinition 里有多个异步守卫和
    // db:blueprint-get-all；若等到 createDirectoryWorkflow() 才捕获，
    // 「A 查到空蓝图 → 用户切到有蓝图的 B → 工作流捕获 B 的 token 启动 full」
    // 这条路径下主进程看到的是**合法的 B token**，守卫根本拦不住。
    const actionToken = getProjectToken()
    const workflow = args.workflow as string
    const chapterNumber = args.chapter_number as number | undefined
    // inputSchema 只是给模型看的提示，**执行链不按它校验**——
    // 0 / 负数会退化成「生成到末尾」，字符串 "2" 会把范围拼成上百章，
    // 1e309 会变成 Infinity 让循环无法终止。必须在这里逐个验成有限正整数
    const asPositiveInt = (v: unknown, label: string): number | undefined | { error: string } => {
      if (v === undefined || v === null) return undefined
      // 必须用 isSafeInteger：`Number.isInteger(1e308)` 是 true，
      // 而 1e308 + 1 === 1e308——目录生成的 `cursor = actualMax + 1` 会永远不前进，
      // 循环卡死并持续调用模型
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) {
        return { error: `${label} 必须是 ≥1 的安全整数，收到：${JSON.stringify(v)}` }
      }
      return v
    }
    const startArg = asPositiveInt(args.blueprint_start_chapter, 'blueprint_start_chapter')
    if (startArg && typeof startArg === 'object') {
      return { success: false, content: '', error: startArg.error }
    }
    const countArg = asPositiveInt(args.blueprint_count, 'blueprint_count')
    if (countArg && typeof countArg === 'object') {
      return { success: false, content: '', error: countArg.error }
    }
    const blueprintRange = {
      startChapter: startArg as number | undefined,
      count: countArg as number | undefined,
    }

    const meta = WORKFLOW_META[workflow]
    if (!meta) {
      return { success: false, content: '', error: `未知工作流类型：${workflow}` }
    }

    // 需要章节号的工作流必须提供合法的正整数 chapter_number
    if (CHAPTER_WORKFLOWS.has(workflow)) {
      if (!Number.isInteger(chapterNumber) || (chapterNumber as number) < 1) {
        return { success: false, content: '', error: `${meta.label}工作流需要指定有效的章节号（正整数）` }
      }
    }

    // 防并发：同类型工作流正在执行（快速失败）
    if (useWorkflowStore.getState().isTypeRunning(meta.runType)) {
      return { success: false, content: '', error: `已有「${meta.label}」类工作流正在执行，请等待完成后再试。` }
    }

    // 构造工作流定义（含前置校验 + 数据准备）
    const built = await buildDefinition(workflow, chapterNumber, blueprintRange, actionToken)
    // 异步准备期间可能已切项目：前置检查（「有没有蓝图」等）查的是 A，
    // 若此刻已在 B，那些结论全部作废，必须中止而不是拿着 A 的结论去写 B
    if (getProjectToken() !== actionToken) {
      return { success: false, content: '', error: '项目已切换，本次操作已取消（前置检查结果已失效）' }
    }
    if ('error' in built) {
      return { success: false, content: '', error: built.error }
    }

    // 数据准备期间可能有别处启动了同类型工作流，启动前再次拦截，避免竞态
    if (useWorkflowStore.getState().isTypeRunning(meta.runType)) {
      return { success: false, content: '', error: `已有「${meta.label}」类工作流正在执行，请等待完成后再试。` }
    }

    // 切到 AI 输出面板（startWorkflow 内部也会切，这里确保即时）
    useLayoutStore.getState().openRightPanel('ai-output')

    // 启动管线 —— 不 await：管线会跑完整个流程（可能数分钟），await 会撞工具 30s 超时。
    // fire-and-forget，与 UI 触发一致；执行进度/错误由 AI 输出面板与全局日志呈现。
    void useWorkflowStore.getState().startWorkflow(built.def)

    const chapterInfo = chapterNumber !== undefined ? `（第 ${chapterNumber} 章）` : ''
    return {
      success: true,
      content: `🚀 已启动「${meta.label}${chapterInfo}」工作流，正在 AI 输出面板流式执行。完成后我会基于结果继续协助。`,
      artifacts: [{ type: 'workflow_started', name: `${meta.label}${chapterInfo}` }],
    }
  },
})

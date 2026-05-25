/**
 * start_workflow — 触发创作工作流（Phase 8：对话即写章）
 *
 * 不再只「切面板 + 提示手动启动」，而是真正构造 WorkflowDefinition 并调用
 * workflow-store.startWorkflow()，让对话 Agent 直接驱动确定性创作管线。
 * 写入型工具 requiresConfirmation:true —— 经 ConfirmCard 人工批准后才执行。
 */
import { buildAgentTool } from '../tool-registry'
import { ipc } from '../../ipc-client'
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
      return { def: createFinalizeWorkflow({ chapterNumber: chapterNumber!, chapterTitle: d.chapterTitle, draftPath: d.draftPath, draftContent: d.draftContent }) }
    }

    case 'generate_blueprint': {
      const guard = await guardDirectoryGeneration()
      if (!guard.ok) return { error: guard.message || '生成蓝图前置条件未满足' }
      // guard 放行但带警告（架构不完整）：Agent 无 UI 的二次确认机制，引导用户到「章节蓝图」界面
      // 由其决定是否带不完整架构继续，避免静默生成低质蓝图浪费 token
      if (guard.message) {
        return { error: `${guard.message}\n\n如确认在当前架构下继续，请在「章节蓝图」界面生成（可在那里二次确认）。` }
      }
      // 安全：已有蓝图时不允许 Agent 全量覆盖（追加/覆盖选择属于「章节蓝图」界面）
      const existing = await ipc.invoke('db:blueprint-get-all')
      if (existing.length > 0) {
        return { error: `已存在 ${existing.length} 章蓝图。为避免误覆盖，重新生成或追加请在「章节蓝图」界面操作（可选追加范围/覆盖方式）。` }
      }
      const { createDirectoryWorkflow } = await import('../../workflows/directory-workflow')
      return { def: createDirectoryWorkflow({ mode: 'full' }) }
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
      return { def: createArchitectureWorkflow({}) }
    }

    default:
      return { error: `未知工作流类型：${workflow}` }
  }
}

export const startWorkflowTool = buildAgentTool({
  name: 'start_workflow',
  description: '触发并真正启动 Vela 创作工作流（写稿/审稿/修稿/定稿/生成蓝图/生成架构）。启动后在 AI 输出面板流式执行多步骤创作流程。写稿/审稿/修稿/定稿需提供 chapter_number。',
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
    },
    required: ['workflow'],
  },
  requiresConfirmation: true,
  isReadOnly: false,
  execute: async (args) => {
    const workflow = args.workflow as string
    const chapterNumber = args.chapter_number as number | undefined

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
    const built = await buildDefinition(workflow, chapterNumber)
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

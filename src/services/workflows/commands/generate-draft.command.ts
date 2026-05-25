import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { buildChapterContext, type ChapterContextResult } from '../../prompts/chapter-context'
import { ipc } from '../../ipc-client'
import type { ChapterInfo } from '../chapter-workflow'

export class GenerateDraftCommand extends BaseWorkflowCommand {

  /**
   * @param chapterInfo 本章信息
   * @param prebuilt    可选的预构建上下文（来自上下文预览确认）。提供时直接复用，
   *                    保证「用户预览到的 == 实际发送的」；缺省时由命令自行拼装，
   *                    使从蓝图/对话等其他入口触发也能独立工作。
   */
  constructor(
    private chapterInfo: ChapterInfo,
    private prebuilt?: ChapterContextResult
  ) {
    super()
  }

  async execute({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error('未打开项目')

    callbacks.log('拼装章节上下文 (强类型注入中)...')

    // 复用预览阶段已拼装好的上下文；无则即时拼装（与预览同一流程，单一数据源）
    const ctx = this.prebuilt ?? await buildChapterContext(this.chapterInfo, callbacks.log)

    if (ctx.estimatedTokens > ctx.tokenBudget) {
      callbacks.log(`⚠️ Prompt 预估 ${ctx.estimatedTokens} tokens，超出预算 ${ctx.tokenBudget}，请考虑精简上下文`)
    }

    callbacks.log('调用 AI 生成章节草稿...')

    // 透传 context：启用流式取消（轮询 context.cancelled），取消时不写入调用统计
    const draftText = await this.callLLMWithBuilder(ctx.builder, callbacks, { purpose: 'draft' }, context)
    const cleanDraftText = this.stripThinkingTags(draftText)

    // 落于数据库
    const nextVersion: number = await ipc.invoke('db:draft-next-version', this.chapterInfo.chapterNumber)
    const createResult = await ipc.invoke('db:draft-create', {
      chapterNumber: this.chapterInfo.chapterNumber,
      version: nextVersion,
      source: 'write',
      content: cleanDraftText,
      wordCount: cleanDraftText.length,
    })

    const pseudoPath = createResult.id ? `vela://draft/${createResult.id}` : `vela://draft/ch${this.chapterInfo.chapterNumber}/v${nextVersion}`

    context.data.draft = cleanDraftText
    context.data.draftContent = cleanDraftText
    context.data.draftPath = pseudoPath
    context.data.chapterNumber = this.chapterInfo.chapterNumber
    context.data.chapterInfo = this.chapterInfo
    context.data.shortSummary = ''

    useProjectStore.getState().refreshFileTree()
    try {
      const { useDraftStore } = await import('../../../stores/draft-store')
      await useDraftStore.getState().loadAllDrafts()
    } catch { /* 忽略 */ }

    try {
      const { useEditorStore } = await import('../../../stores/editor-store')
      useEditorStore.getState().openFile({
        id: pseudoPath,
        name: `第${this.chapterInfo.chapterNumber}章 ${this.chapterInfo.title} v${nextVersion}`,
        type: 'chapter',
        filePath: pseudoPath,
        content: cleanDraftText,
      })
    } catch { /* 忽略 */ }

    callbacks.log(`✅ 草稿已自动入库保存为版本 v${nextVersion}（${draftText.length} 字）`)
    return draftText
  }
}

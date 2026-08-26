/**
 * GenerateVolumeSynopsisCommand — 推演下一卷的主线与卷内大纲（Phase 19 步骤 ③）
 *
 * **本命令不落库**，产出交预览对话框编辑确认后，由步骤 ④ 的单次事务写入。
 *
 * 输入刻意**不含全书 synopsis**：那份描述的是一个已闭环的完整故事，
 * 喂进去会诱导 AI 收尾——正是本 Phase 要根治的原始缺陷。
 */
import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { getPromptTemplate } from '../../prompt-templates'
import { VolumeSynopsisPromptBuilder } from '../../prompts/volume-prompt-builder'
import { ipc } from '../../ipc-client'
import { getPlotStructureGuide } from '../architecture-workflow'
import { formatOpenThreads, readRetainedBlueprints } from '../../prompts/volume-context'
import type { ClosingReport, DraftVolume, NextVolumeParams } from '../volume-workflow'
import type { VolumeData } from '../../../../electron/repositories/volume-repository'

export class GenerateVolumeSynopsisCommand extends BaseWorkflowCommand<DraftVolume> {
    constructor(private params: NextVolumeParams) { super() }

    async execute({ context, callbacks }: CommandExecuteParams): Promise<DraftVolume> {
        const project = useProjectStore.getState().currentProject
        if (!project) throw new Error('未打开项目')

        const prevVolume = context.data.prevVolume as VolumeData
        const closingReport = context.data.closingReport as ClosingReport
        if (!prevVolume || !closingReport) throw new Error('上一卷收束数据缺失')

        const template = getPromptTemplate('volume_synopsis')
        if (!template) throw new Error('模板 volume_synopsis 丢失')

        // 读全书三大件之前先核对项目未切换：本命令是第二次 LLM 调用，
        // 距工作流发起已过去一次完整生成（分钟级），期间切项目会读到 B 的核心设定，
        // 拼出「A 的收卷报告 + B 的世界观」这种混合 prompt
        this.assertProjectUnchanged(context)
        const core = await ipc.invoke('db:project-core-get')
        if (!core) throw new Error('项目核心数据未初始化')

        const volumeStart = prevVolume.endChapter + 1
        const volumeEnd = volumeStart + this.params.chapterCount - 1

        // ⚠️ 必须传 scopeLabel 与 startChapter：
        // 不传 scopeLabel → 文案变成「全书共 60 章」，误导 AI 以为整本书只有这一卷长；
        // 不传 startChapter → 章号从第 1 章绝对起算，第 101–160 卷会生成「第1章~第15章」错位区间。
        const structureGuide = getPlotStructureGuide(this.params.structure, this.params.chapterCount, {
            scopeLabel: '本卷',
            startChapter: volumeStart,
        })

        // 空值契约：user_intent 为空必须传回退文案，不能传空串——
        // finalizePrompt 的空段落裁剪认不出【作者对本卷的意图】这个标题，
        // 空串会给 AI 留一个悬空的空小节标题，可能被误判为素材截断。
        const userIntent = this.params.userIntent?.trim() || '（作者未填写，完全由你推演）'

        // orphanPolicy === 'keep' 时，本卷区间内保留着旧蓝图。不注入的话这个选项
        // 对 AI 毫无影响，会写出与旧蓝图冲突的大纲（Spec §4.11 要求「新卷大纲须兼容」）。
        const retainedBlueprints = this.params.orphanPolicy === 'keep'
            ? await readRetainedBlueprints(volumeStart, volumeEnd)
            : ''

        const prompt = new VolumeSynopsisPromptBuilder(template)
            .withPremise(core.premise ?? '')
            .withWorldbuilding(core.worldbuilding ?? '')
            .withCharactersArch(core.charactersArch ?? '')
            .withPrevClosingState(closingReport.closingState)
            .withOpenThreads(formatOpenThreads(closingReport.openThreads))
            .withUserIntent(userIntent)
            .withStructureGuide(structureGuide)
            .withVolumeRange(volumeStart, volumeEnd, this.params.chapterCount)
            .withRetainedBlueprints(retainedBlueprints)
            .withPacingGuidance(this.params.pacingGuidance ?? '')
            .build()

        callbacks.log(`正在推演第 ${volumeStart}–${volumeEnd} 章的卷大纲...`)
        const raw = await this.callLLM(
            prompt,
            template.systemRole ?? '你是一位经验丰富的网文架构师。',
            callbacks,
            {
                responseFormat: { type: 'json_object' },
                purpose: 'outline',
                purposeLabel: '卷大纲推演',
                // 延迟写统计：用户在预览里点取消时不应残留 llm_calls（零副作用承诺）
                logPolicy: 'defer',
                // 流式回调驱动预览对话框的打字机光标（设计屏 30）。
                // 必须是 'every'：本次输出是**单个** JSON 对象，`}` 只在最末尾出现，
                // 默认的 object-close 模式会让整场生成一个回调都不发，预览全程空白
                streamChunkMode: 'every',
                // 累计的是**原始 JSON 串**，不是可直读的卷大纲。
                // 预览 UI（T9）负责从中做部分提取后渲染，此处不解析——
                // 半截 JSON 解析失败是常态，在这里 try/catch 只会静默丢帧
                onStreamChunk: (full) => { context.data.streamingRawJSON = full },
            },
            context,
        )

        const parsed = this.parseJSON<Record<string, unknown>>(raw)
        const title = typeof parsed.title === 'string' ? parsed.title.trim() : ''
        const premise = typeof parsed.premise === 'string' ? parsed.premise.trim() : ''
        const synopsis = typeof parsed.synopsis === 'string' ? parsed.synopsis.trim() : ''
        if (!title || !synopsis) throw new Error('模型未返回有效的卷名或卷大纲，请重试')

        const suggested = Number(parsed.suggestedChapterCount)
        return {
            title,
            premise,
            synopsis,
            suggestedChapterCount: Number.isInteger(suggested) && suggested > 0
                ? suggested
                : this.params.chapterCount,
        }
    }
}

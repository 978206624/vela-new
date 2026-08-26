/**
 * ExtractClosingReportCommand — 提炼上一卷的收卷状态与未回收伏笔（Phase 19 步骤 ②）
 *
 * **本命令不落库**。产出只存进 `context.data.closingReport`，与新卷一并由
 * 步骤 ④ 的单次事务写入——避免「上一卷已改但新卷没建」的半提交。
 *
 * JSON 解析失败直接抛错终止，不静默吞掉：用空收卷状态去生成下一卷，
 * 等于让 AI 在不知道上一卷结局的情况下瞎编，比失败更糟。
 */
import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { getPromptTemplate } from '../../prompt-templates'
import { VolumeClosingPromptBuilder } from '../../prompts/volume-prompt-builder'
import { formatOpenThreads } from '../../prompts/volume-context'
import { MAX_OPEN_THREADS, MAX_THREAD_LEN, MAX_OPEN_THREADS_BYTES, utf8Bytes } from '../../../shared/volume-limits'
import type { ClosingReport } from '../volume-workflow'
import type { VolumeData } from '../../../../electron/repositories/volume-repository'

const VALID_URGENCY = ['high', 'mid', 'low'] as const

export class ExtractClosingReportCommand extends BaseWorkflowCommand<ClosingReport> {
    async execute({ context, callbacks }: CommandExecuteParams): Promise<ClosingReport> {
        const prevVolume = context.data.prevVolume as VolumeData
        const closingInput = context.data.closingInput as { chapterNotes: string; characterStates: string }
        if (!prevVolume || !closingInput) throw new Error('上一卷盘点数据缺失')

        const template = getPromptTemplate('volume_closing_report')
        if (!template) throw new Error('模板 volume_closing_report 丢失')

        const prompt = new VolumeClosingPromptBuilder(template)
            .withVolumeTitle(prevVolume.title || `第${prevVolume.volumeNumber}卷`)
            .withChapterNotes(closingInput.chapterNotes)
            .withCharacterStates(closingInput.characterStates)
            .withPrevOpenThreads(formatOpenThreads(prevVolume.openThreads as ClosingReport['openThreads']))
            .build()

        callbacks.log('正在提炼收卷状态与未回收伏笔...')
        const raw = await this.callLLM(
            prompt,
            template.systemRole ?? '你是一位擅长梳理长篇小说线索的故事编辑。',
            callbacks,
            { responseFormat: { type: 'json_object' }, purpose: 'outline', purposeLabel: '卷收束提炼', logPolicy: 'defer' },
            context,
        )

        const parsed = this.parseJSON<Record<string, unknown>>(raw)
        const closingState = typeof parsed.closingState === 'string' ? parsed.closingState.trim() : ''
        if (!closingState) throw new Error('模型未返回有效的 closingState，请重试')

        // 逐条规范化。写侧 assertThreadForWrite 会对非法值直接抛错拒绝，
        // 而那发生在两次 LLM 调用之后的提交环节，用户无法自查——故在此先滤一遍。
        // ⚠️ 各类修正必须分别计数并如实上报：静默改数据比拒绝更糟。
        // 尤其 urgency 归一——模型若系统性输出中文「高/中/低」，全部会被悄悄改成 mid，
        // 高优先级伏笔在后续「本卷罗盘」里就此消失，且无人察觉。
        //
        // openThreads 不是数组时**必须抛错**，不能当空清单放过。
        // 字段缺失同样要抛：提交环节会把这份清单整个写回上一卷（⑥ 是覆盖式 upsert），
        // 模型漏写一个字段就会静默清空上一卷已登记的全部伏笔，
        // 而用户看到的是「提炼成功、0 条伏笔」，误以为上一卷真的没留线索。
        if (!Array.isArray(parsed.openThreads)) {
            throw new Error(
                `模型未返回 openThreads 数组（实为 ${parsed.openThreads === undefined ? '缺失' : typeof parsed.openThreads}），` +
                `无法确认未回收伏笔清单；若上一卷确无伏笔，模型应返回空数组 []。请重试`
            )
        }
        const rawThreads = parsed.openThreads
        const openThreads: ClosingReport['openThreads'] = []
        let dropped = 0
        let urgencyCoerced = 0
        let truncated = 0
        let chapterCoerced = 0
        for (const item of rawThreads) {
            if (!item || typeof item !== 'object') { dropped++; continue }
            const o = item as Record<string, unknown>
            // 写侧要求 chapter 必须是 number 类型，字符串 "12" 会被拒。这里做类型
            // 转换是有意的，但同样属于「悄悄改数据」，须与其它修正一样计入上报
            const chapterWasNumber = typeof o.chapter === 'number'
            const chapter = chapterWasNumber ? (o.chapter as number) : Number(o.chapter)
            const thread = typeof o.thread === 'string' ? o.thread.trim() : ''
            if (!Number.isInteger(chapter) || chapter < 1 || !thread) { dropped++; continue }
            if (!chapterWasNumber) chapterCoerced++
            const urgencyOk = typeof o.urgency === 'string' && (VALID_URGENCY as readonly string[]).includes(o.urgency)
            if (!urgencyOk) urgencyCoerced++
            if (thread.length > MAX_THREAD_LEN) truncated++
            openThreads.push({
                chapter,
                thread: thread.slice(0, MAX_THREAD_LEN),
                urgency: urgencyOk ? (o.urgency as 'high' | 'mid' | 'low') : 'mid',
            })
        }

        // 条数上限与写侧 MAX_OPEN_THREADS 对齐。不在此截断的话，
        // 超限只会在提交阶段被 serializeOpenThreads 抛错，两次 LLM 调用的成本全部作废。
        let overflow = 0
        if (openThreads.length > MAX_OPEN_THREADS) {
            overflow = openThreads.length - MAX_OPEN_THREADS
            openThreads.length = MAX_OPEN_THREADS
        }

        // 字节上限同理，且**只卡条数拦不住**：200 条 × 500 字中文 ≈ 300KB，
        // 已超 256KB 字节上限，条数检查全程放行，最后仍在提交时炸掉。
        // 渲染进程没有 Node Buffer（nodeIntegration: false），用 TextEncoder 量 UTF-8 字节；
        // 度量对象必须与写侧一致——是 JSON.stringify 后的串，不是各 thread 之和。
        let bytesDropped = 0
        while (openThreads.length > 0 && utf8Bytes(JSON.stringify(openThreads)) > MAX_OPEN_THREADS_BYTES) {
            openThreads.pop()
            bytesDropped++
        }

        const warns: string[] = []
        if (dropped > 0) warns.push(`${dropped} 条格式非法已丢弃`)
        if (chapterCoerced > 0) warns.push(`${chapterCoerced} 条章号为文本已转为数字`)
        if (urgencyCoerced > 0) warns.push(`${urgencyCoerced} 条优先级非法已归为「中」`)
        if (truncated > 0) warns.push(`${truncated} 条超 ${MAX_THREAD_LEN} 字已截断`)
        if (overflow > 0) warns.push(`超出 ${MAX_OPEN_THREADS} 条上限，已舍弃末尾 ${overflow} 条`)
        if (bytesDropped > 0) warns.push(`超出 ${Math.round(MAX_OPEN_THREADS_BYTES / 1024)}KB 存储上限，已舍弃末尾 ${bytesDropped} 条`)
        if (warns.length > 0) callbacks.log(`⚠️ 未回收伏笔：${warns.join('；')}`)

        return { volumeNumber: prevVolume.volumeNumber, closingState, openThreads }
    }
}

/**
 * RegenerateVolumeSynopsisCommand — 为**已存在的卷**重新推演卷内大纲（Task 19.4 T3）
 *
 * **本命令不落库**，产物交回卷详情编辑器的「本卷大纲」文本框，由用户点「保存」才写入
 * （Product-Spec §4.11「重新生成本卷大纲」第 4 步）。
 *
 * ## 与 `GenerateVolumeSynopsisCommand`（续卷第 3 步）的差别
 *
 * 不是同一件事的换皮，四处实质不同：
 * ① **本卷主线是输入**，不是产物。设计稿 30 把它标为「未改动」。
 * ② 多喂一份**本卷已写章节的实际要点**——重新生成往往发生在卷写到一半时，
 *    那些章已经落进正文、读者已经看过，新大纲只能重排它们**之后**的走向。
 * ③ 章号区间取自**卷表既有边界**，不由用户现填，故不需要章数校验那一整套
 *    （区间合法性由工作流第 1 步在读到卷之后统一验，见 volume-regen-workflow）。
 * ④ 产物**只有 synopsis 一项**，没有 title / premise / suggestedChapterCount。
 *
 * ## 只有一次 LLM 调用
 *
 * 上一卷的收卷状态直接读库里已落库的那份，**不重新提炼**：那是上一卷的既成结论，
 * 用户可能已经在卷详情里手工修订过，再跑一次 `volume_closing_report` 等于用一次
 * 模型调用去改写它。续卷时必须现提，是因为那时上一卷刚写完、收卷报告尚不存在。
 */
import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { getPromptTemplate } from '../../prompt-templates'
import { VolumeSynopsisRegenPromptBuilder } from '../../prompts/volume-prompt-builder'
import { ipc } from '../../ipc-client'
import { getPlotStructureGuide } from '../architecture-workflow'
import { formatOpenThreads } from '../../prompts/volume-context'
import { extractPartialJSONString } from '../../../shared/partial-json'
import type { VolumeData } from '../../../../electron/repositories/volume-repository'

export interface RegenCommandParams {
    /** 故事模型 key，与 `getPlotStructureGuide` 的 case 对应。工作流发起时从项目配置捕获 */
    structure: string
    /**
     * 流式打字机回调：收到的是**已解转义的大纲正文**，不是原始 JSON 串。
     *
     * 在这里就把 JSON 剥掉，而不是把原始串扔给 UI 让它自己解：解析规则只该有一份，
     * 而消费方是渲染组件——那里最不适合放解析逻辑（改不动、也测不到）。
     */
    onPartial?: (text: string) => void
}

export class RegenerateVolumeSynopsisCommand extends BaseWorkflowCommand<string> {
    constructor(private params: RegenCommandParams) { super() }

    async execute({ context, callbacks }: CommandExecuteParams): Promise<string> {
        const project = useProjectStore.getState().currentProject
        if (!project) throw new Error('未打开项目')

        const volume = context.data.volume as VolumeData
        if (!volume) throw new Error('目标卷数据缺失')
        const prevClosingState = context.data.prevClosingState as string
        const writtenNotes = context.data.writtenNotes as string
        if (typeof prevClosingState !== 'string' || typeof writtenNotes !== 'string') {
            throw new Error('本卷上下文采集缺失，请重试')
        }
        // 「没有上一卷」与「上一卷存在但没记收卷状态」的区分由工作流传下来。
        // 缺省按「有上一卷」处理：对第五卷误称首卷是明确的错误事实，
        // 而对首卷误称有上一卷只会让文案略啰嗦——两种误判的代价不对称
        const hasPrevVolume = context.data.hasPrevVolume !== false
        const prevVolumeTitle = (context.data.prevVolumeTitle as string | undefined)?.trim() || '上一卷'

        const template = getPromptTemplate('volume_synopsis_regen')
        if (!template) throw new Error('模板 volume_synopsis_regen 丢失')

        // 读全书三大件之前先核对项目未切换：本步之前已有两次 IPC 往返，
        // 期间切项目会读到 B 的核心设定，拼出「A 的卷 + B 的世界观」这种混合 prompt
        this.assertProjectUnchanged(context)
        const core = await ipc.invoke('db:project-core-get')
        if (!core) throw new Error('项目核心数据未初始化')

        const chapterCount = volume.endChapter - volume.startChapter + 1

        // ⚠️ 必须传 scopeLabel 与 startChapter，理由同续卷：
        // 不传 scopeLabel → 文案变成「全书共 60 章」；
        // 不传 startChapter → 章号从第 1 章绝对起算，第 101–160 卷会生成「第1章~第60章」错位区间
        const structureGuide = getPlotStructureGuide(this.params.structure, chapterCount, {
            scopeLabel: '本卷',
            startChapter: volume.startChapter,
        })

        // 空值契约：这三段的标题都不含「如有」、也不是 ★ 块，`finalizePrompt` 的空段落
        // 裁剪认不出它们。传空串会留下悬空的空小节标题，可能被模型误判为素材截断，
        // 故一律换成明确的回退文案（同 `GenerateVolumeSynopsisCommand` 的 user_intent）。
        //
        // ⚠️ 上一卷那一段有**三种**状态，回退文案各不相同。压成两种就会对第五卷
        // 说「本卷是第一卷」——一句明确的错误事实（Codex round-02 major #4）
        const prevClosing = prevClosingState.trim()
            ? prevClosingState.trim()
            : hasPrevVolume
                ? `（${prevVolumeTitle}尚未记录收卷状态。请以下面的【本卷开卷状态】作为衔接依据，不要假设本卷是全书开篇）`
                : '（本卷是第一卷，没有上一卷；请以全书故事前提为起点）'
        const openingState = volume.openingState?.trim() || '（未记录开卷状态）'
        const volumePremise = volume.premise?.trim() || '（作者尚未填写本卷主线，请依据全书设定与上一卷收束状态自行确定一条，并让大纲服务于它）'

        const prompt = new VolumeSynopsisRegenPromptBuilder(template)
            .withVolumeTitle(volume.title || `第${volume.volumeNumber}卷`)
            .withPremise(core.premise ?? '')
            .withWorldbuilding(core.worldbuilding ?? '')
            .withCharactersArch(core.charactersArch ?? '')
            .withPrevClosingState(prevClosing)
            .withOpeningState(openingState)
            .withVolumePremise(volumePremise)
            // 台账取**本卷**这一份，不是上一卷的。建卷时续卷事务已把上一卷的未回收清单
            // 结转进来，此后本卷台账就是唯一权威（见 `getVolumeCompass` 的同款说明）
            .withOpenThreads(formatOpenThreads(volume.openThreads))
            .withWrittenNotes(writtenNotes)
            .withStructureGuide(structureGuide)
            .withVolumeRange(volume.startChapter, volume.endChapter, chapterCount)

        callbacks.log(`正在重新推演第 ${volume.startChapter}–${volume.endChapter} 章的卷大纲...`)
        const raw = await this.callLLM(
            prompt.build(),
            // ⚠️ 走 builder 的 `getSystemRole()`，不是裸读 `template.systemRole`。
            // 后者可被用户的自定义模板 JSON 覆盖，而 `resolveSystemRole()` 对内置 key
            // 恒取内置角色——本模板已进 `EDITABLE_PROMPT_KEYS`，裸读等于把
            // 「系统角色不可被自定义覆盖」这条契约在这一个入口上开了个洞
            // （Codex round-03 minor）
            prompt.getSystemRole(),
            callbacks,
            {
                responseFormat: { type: 'json_object' },
                purpose: 'outline',
                purposeLabel: '卷大纲重生成',
                // 流式回调驱动卷详情大纲区的打字机光标（设计屏 30）。
                // 必须是 'every'：本次输出是**单个** JSON 对象，`}` 只在最末尾出现，
                // 默认的 object-close 模式会让整场生成一个回调都不发，大纲区全程空白
                streamChunkMode: 'every',
                onStreamChunk: (full) => {
                    // 半截 JSON 用 `JSON.parse` 必然抛错，故走部分提取。
                    // `null` = 模型还没写到 synopsis 这一字段，此时**不回调**——
                    // 回调一个空串会让 UI 先把「输出中」点亮再空等，看起来像卡住了
                    const partial = extractPartialJSONString(full, 'synopsis')
                    if (partial !== null) this.params.onPartial?.(partial)
                },
                // ⚠️ 刻意**不用** `logPolicy:'defer'`（续卷用的是 defer）。
                // 那是为了兑现「用户在预览里点取消 = 零副作用」，而本流程没有那个取消点：
                // 结果直接落进文本框，用户不点保存就什么都不会写库。
                // 模型调用本身是真实发生过、真实花了钱的，延迟到「用户点保存」才记，
                // 会让「生成完但决定不用」的那些调用在统计面板里永远消失。
                logPolicy: 'immediate',
            },
            context,
        )

        const parsed = this.parseJSON<Record<string, unknown>>(raw)
        const synopsis = typeof parsed.synopsis === 'string' ? parsed.synopsis.trim() : ''
        if (!synopsis) throw new Error('模型未返回有效的卷大纲，请重试')
        return synopsis
    }
}

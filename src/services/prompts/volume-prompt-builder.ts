/**
 * VolumePromptBuilder — 分卷相关模板的强类型 Prompt 建造者（Phase 19）
 *
 * 独立成文件而非并入 `prompt-builder.ts`：后者已 416 行、远超本项目 300 行单文件上限，
 * 继续堆只会加剧。基类仍复用 `BasePromptBuilder`（变量替换与系统约束追加同源）。
 *
 * 沿用该模块「拒绝 raw Record<string,string> 盲打模式」的约定：
 * 每个模板变量一个强类型 `withXxx()`，漏传会在编译期而非运行期暴露。
 */
import { BasePromptBuilder } from './prompt-builder'

/** `volume_closing_report` 专用 —— 提炼上一卷收卷状态与未回收伏笔 */
export class VolumeClosingPromptBuilder extends BasePromptBuilder {
    /** 上一卷卷名 */
    withVolumeTitle(title: string) {
        this.variables.volume_title = title
        return this
    }

    /** 该卷各章的实际写作要点（定稿后处理从正文提炼的 notes，非当初的写作计划） */
    withChapterNotes(notes: string) {
        this.variables.chapter_notes = notes
        return this
    }

    /** 全书角色当前状态档案 */
    withCharacterStates(states: string) {
        this.variables.character_states = states
        return this
    }

    /** 该卷开卷时继承的未回收伏笔（首卷为空） */
    withPrevOpenThreads(threads: string) {
        this.variables.prev_open_threads = threads
        return this
    }
}

/** `volume_synopsis` 专用 —— 推演下一卷主线与卷内大纲 */
export class VolumeSynopsisPromptBuilder extends BasePromptBuilder {
    /** 全书故事前提 */
    withPremise(premise: string) {
        this.variables.premise = premise
        return this
    }

    /** 全书世界观设定 */
    withWorldbuilding(worldbuilding: string) {
        this.variables.worldbuilding = worldbuilding
        return this
    }

    /** 全书人物群像网络。
     *  注意本 Builder **刻意不提供 withSynopsis** —— 全书情节大纲描述的是一个
     *  已闭环的完整故事，喂给续卷会诱导 AI 收尾，正是本 Phase 要根治的缺陷。 */
    withCharactersArch(charactersArch: string) {
        this.variables.characters_arch = charactersArch
        return this
    }

    /** 上一卷的收卷状态 —— 本卷的起点，必须承接 */
    withPrevClosingState(state: string) {
        this.variables.prev_closing_state = state
        return this
    }

    /** 结转到本卷的未回收伏笔清单 */
    withOpenThreads(threads: string) {
        this.variables.open_threads = threads
        return this
    }

    /** 作者对本卷的意图。
     *  ⚠️ 空值必须由调用方替换为回退文案，不可传空串——`finalizePrompt` 的空段落裁剪
     *  认不出「【作者对本卷的意图】」这个标题（不含「如有」也非 ★ 块），
     *  空串会给模型留一个悬空的空小节标题，可能被误判为素材截断。 */
    withUserIntent(intent: string) {
        this.variables.user_intent = intent
        return this
    }

    /** 本卷结构指导。
     *  ⚠️ 须由 `getPlotStructureGuide(structure, 本卷章数, { scopeLabel:'本卷', startChapter })`
     *  生成——不传 scopeLabel 会出现「全书共 60 章」的误导文案；
     *  不传 startChapter 会让章号从第 1 章绝对起算，产生错位区间。 */
    withStructureGuide(guide: string) {
        this.variables.structure_guide = guide
        return this
    }

    /** 本卷章号区间与章数 */
    withVolumeRange(startChapter: number, endChapter: number, chapterCount: number) {
        this.variables.volume_start = String(startChapter)
        this.variables.volume_end = String(endChapter)
        this.variables.chapter_count = String(chapterCount)
        return this
    }

    /** 节奏/风格指导（可选，留空时模板末尾的 ★ 块会被裁掉） */
    withPacingGuidance(guidance: string) {
        this.variables.pacing_guidance = guidance
        return this
    }

    /**
     * 本卷区间内已存在、用户选择保留（`orphanPolicy === 'keep'`）的旧章节蓝图。
     *
     * 不注入的话，「保留旧蓝图」这个选项对 AI 毫无影响——它会按自己的推演写出
     * 与那些蓝图冲突的卷大纲，用户拿到一个「保留了蓝图但大纲对不上」的卷
     * （Product-Spec §4.11 明写该策略「新卷大纲须兼容」）。
     * 非 keep 策略传空串，模板中含「（如有」的标题会被空段落裁剪去掉。
     */
    withRetainedBlueprints(text: string) {
        this.variables.retained_blueprints = text
        return this
    }
}

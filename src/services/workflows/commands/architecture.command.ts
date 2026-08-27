import { BaseWorkflowCommand, CommandExecuteParams, WORKFLOW_TOKEN_KEY } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { getProjectToken } from '../../../stores/volume-store'
import { getPromptTemplate } from '../../prompt-templates'
import { ArchitecturePromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'

import type { NovelConfig } from '../../../shared/ipc-channels'

// --- 基础工具库 ---

interface PartialArchData {
  premise_result?: string
  character_dynamics_result?: string
  character_state_result?: string
  world_building_result?: string
  synopsis_result?: string
}

async function loadPartialData(projectPath: string): Promise<PartialArchData> {
  const result = await ipc.invoke('fs:read-json', `${projectPath}/.vela/partial_arch.json`)
  if (result.success && result.data) return result.data as PartialArchData
  return {}
}

async function savePartialData(projectPath: string, data: PartialArchData): Promise<void> {
  await ipc.invoke('fs:write-json', `${projectPath}/.vela/partial_arch.json`, data)
}

function getNovelConfig(): { project: NonNullable<ReturnType<typeof useProjectStore.getState>['currentProject']>; config: NovelConfig } {
  const project = useProjectStore.getState().currentProject
  if (!project) throw new Error('未打开项目')
  return { project, config: project.novelConfig }
}

function stripThinkingTags(text: string): string {
  return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim()
}

async function writeArchToDb(
  key: 'premise' | 'charactersArch' | 'worldbuilding' | 'synopsis',
  content: string,
  /**
   * 调用方在 `execute` 入口、任何 await 之前捕获的项目 token。必填。
   * 架构四步走每一步都在一次分钟级 LLM 之后才写库——现取会拿到用户
   * 切换后那个项目的合法 token，A 的架构就写进了 B。
   */
  expectedToken: number | undefined,
): Promise<void> {
  const cleanContent = stripThinkingTags(content)
  // 经统一入口写库 + 同步 store 别名（synopsis→coreOutline 等），保持 store ⟷ DB 一致，
  // 否则小说配置编辑器仍显示旧种子，保存时会用陈旧值覆盖架构生成的扩展内容
  const { updateProjectCore } = await import('../../vela-protocol')
  const ok = await updateProjectCore({ [key]: cleanContent }, expectedToken)
  // DB 写入失败：不发"已生成"事件、抛错让工作流标记本步失败，避免误报
  if (!ok) throw new Error(`架构字段「${key}」写入数据库失败（可能是项目已切换）`)

  // 通知 UI 层实时刷新架构完成状态。
  // ⚠️ 这行 `await import` 本身也是一个可切走的窗口——事件是发给**当前**项目的 UI 的，
  // 切换后再发会让 B 的界面亮起「A 的架构已生成」
  const { globalEventBus } = await import('../../../shared/event-bus')
  if (getProjectToken() !== expectedToken) {
    console.warn('[writeArchToDb] 项目已切换，不再向新项目发送架构更新事件')
    return
  }
  globalEventBus.emit('ARCH_FILE_UPDATED', { fileName: `${key}.md` })
}

// --- 独立命令类 ---

export class GenerateConfigCommand extends BaseWorkflowCommand<string> {
  constructor(private idea: string, private totalChapters: number, private wordsPerChapter: number, private onGenerated: (config: Partial<NovelConfig>) => void, private genreHint?: string) {
    super()
  }

  async execute({ context, callbacks }: CommandExecuteParams): Promise<string> {
    // ⚠️ 优先取工作流构造时钉住的 token（`WORKFLOW_TOKEN_KEY`），**不现取**。
    // 工作流是排队执行的，各步之间又各隔一次分钟级 LLM——在 execute 入口现取
    // 拿到的已经是用户切换后那个项目的**合法** token，守卫看不出异常。
    // 回落 getProjectToken() 只是给「不经工作流、直接 new Command().execute()」
    // 的调用兜底（当前无此类调用点）。
    const actionToken = (context.data[WORKFLOW_TOKEN_KEY] as number | undefined) ?? getProjectToken()
    callbacks.log('正在调度配置专家 AI，准备解析您的脑洞...')

    const template = getPromptTemplate('generate_global_config')
    if (!template) throw new Error('未找到 generate_global_config 模板')

    // 用户在「问题表单」选定作品类型时，作为硬约束注入，收敛 AI 的类型判断
    const ideaWithGenre = this.genreHint?.trim()
      ? `${this.idea}\n\n【作者指定作品类型】${this.genreHint.trim()}（请严格沿用此类型，不要改判）`
      : this.idea

    const promptBuilder = new ArchitecturePromptBuilder(template)
      .withUserIdea(ideaWithGenre)
      .withNumberOfChapters(this.totalChapters)
      .withWordNumber(this.wordsPerChapter)

    const resultRaw = await this.callLLMWithBuilder(
      promptBuilder,
      callbacks,
      { responseFormat: { type: 'json_object' }, thinking: true },
      // 传 context：`callLLM` 的跨批次 token 守卫只认 context 里的 WORKFLOW_TOKEN_KEY，
      // 不传等于那道守卫没装（模型请求照发、结果照写、统计照记到切换后的项目）
      context,
    )

    callbacks.log('解析完成，正在应用到项目配置...')
    // ⚠️ try/catch **只包 JSON 解析那一步**。
    // 早先它一直包到保存结束，于是「项目已切换」「版本冲突」都会被改写成
    // 「AI 返回的内容无法解析为 JSON，请重试」——用户按提示重试一次，
    // 而问题根本不在模型返回上；反过来，真正的解析失败也会被这段掩盖。
    let parsed: Partial<NovelConfig>
    try {
      parsed = this.parseJSON<Partial<NovelConfig>>(resultRaw)
    } catch (e) {
      throw new Error('AI 返回的内容无法解析为 JSON，请重试或缩短输入。详细信息: ' + String(e))
    }

    {
      // 防御：LLM 常常将长文本字段错误地生成为对象或数组
      const stringifyField = (val: unknown) => {
        if (!val) return ''
        if (typeof val === 'string') return val
        if (Array.isArray(val)) return val.join('\n')
        if (typeof val === 'object') return JSON.stringify(val, null, 2)
        return String(val)
      }

      if (parsed.coreOutline !== undefined) parsed.coreOutline = stringifyField(parsed.coreOutline)
      if (parsed.worldSetting !== undefined) parsed.worldSetting = stringifyField(parsed.worldSetting)
      if (parsed.goldenFinger !== undefined) parsed.goldenFinger = stringifyField(parsed.goldenFinger)
      if (parsed.protagonistProfile !== undefined) parsed.protagonistProfile = stringifyField(parsed.protagonistProfile)
      if (parsed.globalGuidance !== undefined) parsed.globalGuidance = stringifyField(parsed.globalGuidance)
      if (parsed.referenceWorks !== undefined) parsed.referenceWorks = stringifyField(parsed.referenceWorks)
      if (parsed.writingStyle !== undefined) parsed.writingStyle = stringifyField(parsed.writingStyle)

      // 锁 brief：规模与（用户指定的）作品类型以问题表单为准，覆盖模型可能的幻觉值
      parsed.totalChapters = this.totalChapters
      parsed.wordsPerChapter = this.wordsPerChapter
      if (this.genreHint?.trim()) parsed.genre = this.genreHint.trim()

      // ⚠️ 改内存**之前**核对。`onGenerated` 会把生成结果写进当前项目的 store，
      // 而 saveProject 只能拒绝 IPC——它撤不回已经写进 B 内存的 A 的配置。
      // 这一步排在一次分钟级 LLM 之后，是最容易切走的窗口
      if (getProjectToken() !== actionToken) {
        callbacks.log('⚠️ 项目已切换，本次配置生成结果未应用')
        throw new Error('项目已切换，本次配置生成已中止')
      }

      this.onGenerated(parsed)
      // parsed 就是本步生成的字段集合，原样作为补丁——
      // 不要退回整份快照，那会把内存里其它未改动字段的旧值一起写回去
      const saved = await useProjectStore.getState().saveProject({ novelConfig: parsed }, actionToken)

      if (saved.kind === 'success') {
        callbacks.log('✅ AI 配置生成并保存成功，请检查各字段后点击「生成架构」')
      } else if (saved.kind === 'error') {
        // 内存里已有生成结果，但**是否落库无法确定**（超时不取消已发出的 IPC）。
        // 项目还开着、改动还在，提示用户核对后手动保存一次即可，不算整步失败
        callbacks.log(`⚠️ AI 配置已生成，但持久化未能确认：${saved.message}。请检查各字段后点击「立即保存」`)
      } else {
        // conflict / project-switched：内存里那份已经作废或不属于当前项目，
        // 让本步明确失败，不能装成「已生成，你去手动保存一下」
        throw new Error(saved.kind === 'conflict'
          ? '项目配置已被其它操作更新，本次生成结果已作废，请重新生成'
          : '项目已切换，本次配置生成已中止')
      }
    }
    callbacks.setProgress(100)
    return '生成的配置已成功应用！'
  }
}

export class GenerateCoreSeedCommand extends BaseWorkflowCommand<string> {
  async execute({ context, callbacks }: CommandExecuteParams): Promise<string> {
    // ⚠️ 优先取工作流构造时钉住的 token（`WORKFLOW_TOKEN_KEY`），**不现取**。
    // 工作流是排队执行的，各步之间又各隔一次分钟级 LLM——在 execute 入口现取
    // 拿到的已经是用户切换后那个项目的**合法** token，守卫看不出异常。
    // 回落 getProjectToken() 只是给「不经工作流、直接 new Command().execute()」
    // 的调用兜底（当前无此类调用点）。
    const actionToken = (context.data[WORKFLOW_TOKEN_KEY] as number | undefined) ?? getProjectToken()
    const { project, config } = getNovelConfig()
    callbacks.log('生成故事前提...')

    const template = getPromptTemplate('premise')
    if (!template) throw new Error('未找到 premise 模板')

    const promptBuilder = new ArchitecturePromptBuilder(template)
      .withGenre(config.genre)
      .withSubGenre(config.subGenre || config.genre)
      .withTopic(config.coreOutline || '（未填写）')
      .withTargetAudience(config.targetAudience)
      .withNumberOfChapters(config.totalChapters)
      .withWordNumber(config.wordsPerChapter)
      .withCoreSetting(config.worldSetting || '（未填写）')
      .withGoldenFinger(config.goldenFinger || '（未填写）')
      .withProtagonistProfile(config.protagonistProfile || '（未填写）')
      .withGlobalGuidance(config.globalGuidance || '（未填写）')
      .withStepGuidance(((context.data.stepGuidance as Record<string, string>) || {}).premise || '')
      .withReferenceWorks(config.referenceWorks || '')

    const result = await this.callLLMWithBuilder(promptBuilder, callbacks, undefined, context)
    if (!result.trim()) throw new Error('故事前提生成失败，AI 返回空内容')
    if (context.cancelled) throw new Error('工作流已取消')

    const content = `# 故事前提\n\n${result}\n`
    await writeArchToDb('premise', content, actionToken)

    const partial = (context.data.partial as PartialArchData) || await loadPartialData(project.path)
    partial.premise_result = result
    await savePartialData(project.path, partial)
    context.data.partial = partial

    callbacks.log(`✅ 故事前提已生成并写入数据库`)
    return result
  }
}

export class GenerateCharactersCommand extends BaseWorkflowCommand<string> {
  async execute({ context, callbacks }: CommandExecuteParams): Promise<string> {
    // ⚠️ 优先取工作流构造时钉住的 token（`WORKFLOW_TOKEN_KEY`），**不现取**。
    // 工作流是排队执行的，各步之间又各隔一次分钟级 LLM——在 execute 入口现取
    // 拿到的已经是用户切换后那个项目的**合法** token，守卫看不出异常。
    // 回落 getProjectToken() 只是给「不经工作流、直接 new Command().execute()」
    // 的调用兜底（当前无此类调用点）。
    const actionToken = (context.data[WORKFLOW_TOKEN_KEY] as number | undefined) ?? getProjectToken()
    const { project, config } = getNovelConfig()

    const core = await ipc.invoke('db:project-core-get')
    const premise_result = core?.premise || ''

    if (!premise_result || premise_result.includes('待生成') || premise_result.length < 50) {
      throw new Error('故事前提尚未生成或内容不完整，请返回勾选生成')
    }

    callbacks.log('生成角色图谱...')
    const template = getPromptTemplate('character_dynamics')
    if (!template) throw new Error('未找到 character_dynamics 模板')

    const promptBuilder = new ArchitecturePromptBuilder(template)
      .withCoreSeed(premise_result)
      .withGenre(config.genre)
      .withProtagonistProfile(config.protagonistProfile || '（未填写）')
      .withGoldenFinger(config.goldenFinger || '（未填写）')
      .withWorldBuilding(config.worldSetting || '（未填写）')
      .withNumberOfChapters(config.totalChapters)
      .withGlobalGuidance(config.globalGuidance || '（未填写）')
      .withStepGuidance(((context.data.stepGuidance as Record<string, string>) || {}).characters || '')
      .withReferenceWorks(config.referenceWorks || '')

    const result = await this.callLLMWithBuilder(promptBuilder, callbacks, undefined, context)
    if (!result.trim()) throw new Error('角色图谱生成失败')
    if (context.cancelled) throw new Error('工作流已取消')

    await writeArchToDb('charactersArch', `# 角色图谱\n\n${result}\n`, actionToken)

    callbacks.log('📇 正在启动角色卡自动提取流水线...')
    const { runArchCharacterExtract } = await import('../architecture-workflow')
    runArchCharacterExtract(project.path, result, config.genre)

    const partial = (context.data.partial as PartialArchData) || await loadPartialData(project.path)
    partial.character_dynamics_result = result
    await savePartialData(project.path, partial)
    context.data.partial = partial

    callbacks.log(`✅ 角色图谱已生成并写入数据库`)
    return result
  }
}

export class GenerateWorldBuildingCommand extends BaseWorkflowCommand<string> {
  async execute({ context, callbacks }: CommandExecuteParams): Promise<string> {
    // ⚠️ 优先取工作流构造时钉住的 token（`WORKFLOW_TOKEN_KEY`），**不现取**。
    // 工作流是排队执行的，各步之间又各隔一次分钟级 LLM——在 execute 入口现取
    // 拿到的已经是用户切换后那个项目的**合法** token，守卫看不出异常。
    // 回落 getProjectToken() 只是给「不经工作流、直接 new Command().execute()」
    // 的调用兜底（当前无此类调用点）。
    const actionToken = (context.data[WORKFLOW_TOKEN_KEY] as number | undefined) ?? getProjectToken()
    const { project, config } = getNovelConfig()

    const core = await ipc.invoke('db:project-core-get')
    const premise_result = core?.premise || ''

    if (!premise_result || premise_result.includes('待生成') || premise_result.length < 50) {
      throw new Error('故事前提尚未生成或内容不完整，请返回勾选生成')
    }

    callbacks.log('生成世界观...')
    const template = getPromptTemplate('world_building')
    if (!template) throw new Error('模板丢失')

    const promptBuilder = new ArchitecturePromptBuilder(template)
      .withCoreSeed(premise_result)
      .withGenre(config.genre)
      .withCoreSetting(config.worldSetting || '（未填写）')
      .withGoldenFinger(config.goldenFinger || '（未填写）')
      .withProtagonistProfile(config.protagonistProfile || '（未填写）')
      .withGlobalGuidance(config.globalGuidance || '（未填写）')
      .withStepGuidance(((context.data.stepGuidance as Record<string, string>) || {}).worldbuilding || '')

    const result = await this.callLLMWithBuilder(promptBuilder, callbacks, undefined, context)
    if (context.cancelled) throw new Error('工作流已取消')

    await writeArchToDb('worldbuilding', `# 世界观\n\n${result}\n`, actionToken)

    const partial = (context.data.partial as PartialArchData) || await loadPartialData(project.path)
    partial.world_building_result = result
    await savePartialData(project.path, partial)
    context.data.partial = partial

    callbacks.log(`✅ 世界观已生成并写入数据库`)
    return result
  }
}

export class GeneratePlotArchitectureCommand extends BaseWorkflowCommand<string> {
  constructor(private selectedSteps: string[]) {
    super()
  }

  async execute({ context, callbacks }: CommandExecuteParams): Promise<string> {
    // ⚠️ 优先取工作流构造时钉住的 token（`WORKFLOW_TOKEN_KEY`），**不现取**。
    // 工作流是排队执行的，各步之间又各隔一次分钟级 LLM——在 execute 入口现取
    // 拿到的已经是用户切换后那个项目的**合法** token，守卫看不出异常。
    // 回落 getProjectToken() 只是给「不经工作流、直接 new Command().execute()」
    // 的调用兜底（当前无此类调用点）。
    const actionToken = (context.data[WORKFLOW_TOKEN_KEY] as number | undefined) ?? getProjectToken()
    const { project, config } = getNovelConfig()

    const core = await ipc.invoke('db:project-core-get')
    const premise = core?.premise || ''
    const char_dyn = core?.charactersArch || ''
    const world_b = core?.worldbuilding || ''

    if (!premise || premise.includes('待生成')) throw new Error('故事前提未生成')
    if (!char_dyn || char_dyn.includes('待生成')) throw new Error('角色图谱未生成')
    if (!world_b || world_b.includes('待生成')) throw new Error('世界观未生成')

    callbacks.log('生成情节大纲...')
    const template = getPromptTemplate('synopsis')
    if (!template) throw new Error('模板丢失')

    const { getPlotStructureGuide, getNarrativePOVLabel } = await import('../architecture-workflow')
    const guide = getPlotStructureGuide(config.plotStructure || 'three_act', config.totalChapters)
    const pov = getNarrativePOVLabel(config.narrativePOV || 'third_limited')

    const promptBuilder = new ArchitecturePromptBuilder(template)
      .withCoreSeed(premise)
      .withCharacterDynamics(char_dyn)
      .withWorldBuilding(world_b)
      .withGenre(config.genre)
      .withNumberOfChapters(config.totalChapters)
      .withWordNumber(config.wordsPerChapter)
      .withPlotStructureGuide(guide)
      .withNarrativePov(pov)
      .withGlobalGuidance(config.globalGuidance || '（未填写）')
      .withStepGuidance(((context.data.stepGuidance as Record<string, string>) || {}).synopsis || '')

    const result = await this.callLLMWithBuilder(promptBuilder, callbacks, undefined, context)
    if (context.cancelled) throw new Error('工作流已取消')

    await writeArchToDb('synopsis', `# 情节大纲\n\n${result}\n`, actionToken)

    const partial = (context.data.partial as PartialArchData) || await loadPartialData(project.path)
    partial.synopsis_result = result
    context.data.partial = partial

    if (this.selectedSteps.includes('premise') && this.selectedSteps.includes('characters') &&
      this.selectedSteps.includes('worldbuilding') && this.selectedSteps.includes('synopsis')) {
      await ipc.invoke('fs:write-file', `${project.path}/.vela/partial_arch.json`, '{}')
    }

    callbacks.log(`✅ 情节大纲已生成并写入数据库`)
    return result
  }
}

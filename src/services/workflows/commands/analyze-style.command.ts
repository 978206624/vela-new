import { BaseWorkflowCommand, CommandExecuteParams, WORKFLOW_TOKEN_KEY } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { getProjectToken } from '../../../stores/volume-store'
import { getPromptTemplate } from '../../prompt-templates'
import { BasePromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'


/**
 * 文风分析命令
 * 从已写章节中采样正文，调用 AI 提炼作者文风特征，
 * 结果写入 NovelConfig.writingStyle 以锚定后续生成/修稿。
 */
export class AnalyzeWritingStyleCommand extends BaseWorkflowCommand<string> {
  async execute({ context, callbacks }: CommandExecuteParams): Promise<string> {
    // ⚠️ 优先取派发方钉住的 token，不在这里现取。
    // 本命令由定稿后处理流水线派发（每 5 章一次），而那条流水线本身就排在
    // 多次 LLM 调用之后——在这里现取会拿到用户切换后那个项目的**合法**值，
    // 主进程守卫看不出异常，A 的文风就写进了 B。
    const actionToken = (context.data[WORKFLOW_TOKEN_KEY] as number | undefined) ?? getProjectToken()

    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error('未打开项目')

    callbacks.log('📖 正在采样已有章节正文...')

    // 采样策略：取最近 5 章的正文（从数据库查询）
    const sampleTexts: string[] = []
    try {
      const maxChap = await ipc.invoke('db:draft-get-max-finalized-chapter')
      if (maxChap <= 0) {
        // 这是**合法状态**不是失败：还没有可采样的章节。
        // 与上面几处的区别在于「本该能做却没做成」vs「本来就无事可做」
        callbacks.log('ℹ️ 尚无已定稿章节，本次跳过文风分析')
        return ''
      }

      const startChap = Math.max(1, maxChap - 4)
      for (let c = maxChap; c >= startChap; c--) {
        const meta = await ipc.invoke('db:draft-get-finalized', c)
        if (meta) {
          const full = await ipc.invoke('db:draft-get-full', meta.id)
          if (full?.content?.trim()) {
            sampleTexts.push(full.content.trim().slice(0, 2000))
          }
        }
      }
      callbacks.log(`  已采样 ${sampleTexts.length} 章正文`)
    } catch (e) {
      // 抛错而非静默返回：本命令由后处理流水线调度，正常返回会被记成
      // 「该步成功」——既不重试，修复模式也不重跑，而这一步其实什么都没做成
      throw new Error(`提取定稿内容失败：${e}`)
    }

    if (sampleTexts.length === 0) {
      // 同上：定稿章节存在但正文全空，属于无事可做，不是执行失败
      callbacks.log('ℹ️ 采样到的正文为空，本次跳过文风分析')
      return ''
    }

    const template = getPromptTemplate('analyze_writing_style')
    if (!template) throw new Error('未找到文风分析模板')

    const sampleText = sampleTexts.join('\n\n---\n\n')
    const prompt = new BasePromptBuilder(template)
      // 使用 protected variables 需要通过子类或反射，这里使用 build 前手动设置
      ; (prompt as unknown as { variables: { sample_text: string } }).variables = { sample_text: sampleText }
    const finalPrompt = prompt.build()

    callbacks.log('🎨 调用 AI 分析文风特征...')
    const result = await this.callLLM(
      finalPrompt,
      template.systemRole || '你是一位资深的文学评论家和网文研究者。',
      callbacks,
      undefined,
      // 同上：不传 context 就没有跨项目守卫
      context,
    )

    const cleanResult = this.stripThinkingTags(result).trim()
    if (!cleanResult) {
      // 同上：模型给了空结果就是本步失败，不能记成成功
      throw new Error('文风分析返回空结果')
    }

    // 写内存之前先复核：updateNovelConfig 直接改的是**当前**项目的内存配置，
    // 切换后调用等于把 A 的文风写进 B 的编辑器。
    // ⚠️ 必须**抛错**而不是静默返回：正常返回会被 `runPostProcessPipeline`
    // 记成「该步成功」，于是既不重试、修复模式也不重跑。
    // 本步 critical:false，抛错只把它标为失败，不阻断整章定稿
    if (getProjectToken() !== actionToken) {
      throw new Error('项目已切换，本次文风分析结果未写入')
    }

    // 只发本步真正产出的字段。发整份快照的话，内存里其它字段的旧值
    // （如续卷刚改过的 coreOutline / totalChapters）会被一并写回去
    const { updateNovelConfig, saveProject } = useProjectStore.getState()
    updateNovelConfig({ writingStyle: cleanResult })
    const saved = await saveProject({ novelConfig: { writingStyle: cleanResult } }, actionToken)
    // 只认 success —— 唯一「确认写入」的结果。另外三种都得让本步失败，
    // 但**成因不能混说**：
    //   conflict          → 主进程明确拒绝，确认**没**写进去
    //   project-switched  → 不确定（切换可能发生在主进程写完之后）
    //   error             → 不确定（超时不取消已发出的 IPC）
    if (saved.kind !== 'success') {
      throw new Error(saved.kind === 'conflict'
        ? '文风特征未写入：配置已被其它操作更新'
        : `文风特征的持久化未能确认（${saved.kind}）`)
    }
    callbacks.log('✅ 文风特征已保存到小说配置')

    return cleanResult
  }
}

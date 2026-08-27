import type { WorkflowContext, StepCallbacks } from '../../../stores/workflow-store'
import { useLLMStore } from '../../../stores/llm-store'
import { getProjectToken } from '../../../stores/volume-store'
import { globalEventBus, EventPayloadMap } from '../../../shared/event-bus'
import { ipc } from '../../ipc-client'
import type { TokenUsage } from '../../../shared/ipc-channels'
import type { BasePromptBuilder } from '../../prompts/prompt-builder'

/** callLLM 选项：purpose 同时用于模型路由与统计；purposeLabel 可覆盖统计「用途」展示 */
interface CallLLMOptions {
  responseFormat?: { type: string }
  thinking?: boolean
  purpose?: 'outline' | 'draft' | 'review'
  /** 写入 llm_calls 的用途标签（缺省时回退 purpose 代码，再回退「生成」） */
  purposeLabel?: string
  /**
   * 是否由 callLLM 自行设置进度（默认 true：调用开始设 10、完成设 90）。
   * 多批次命令（如目录生成）需自管整体进度时传 false，避免每批被 10/90 覆盖导致进度条来回跳。
   */
  manageProgress?: boolean
  /**
   * 流式过程中每收到一段就回调"累计全文"，供调用方做增量解析（如目录边生成边逐条入库，实现动态出现）。
   * 注意：回调里不要 await；解析失败请自行吞掉，不影响主流程。
   */
  onStreamChunk?: (fullText: string) => void
  /**
   * `onStreamChunk` 的触发时机。默认 `'object-close'`（既有行为）。
   *
   * - `'object-close'`：仅当本段含 `}` 时触发。适合**增量入库**类消费方
   *   （目录生成逐条解析 JSON 对象），跳过不可能解析成功的片段以省扫描。
   * - `'every'`：每段都触发。**打字机预览必须用这个**——单个 JSON 对象里
   *   `}` 只出现在最末尾，用 object-close 会导致整场生成一个回调都不发，
   *   预览停在空白直到全部结束，"边生成边看"完全失效。
   */
  streamChunkMode?: 'object-close' | 'every'
  /**
   * llm_calls 统计的写入时机。默认 `'immediate'`（既有行为，调用完成即写）。
   *
   * `'defer'`：**不立即写库**，把统计条目暂存到 `context.data.__deferredLLMLogs`，
   * 由调用方在确认落库时统一 flush、取消时直接丢弃。
   *
   * 为什么需要：续卷工作流承诺「用户在预览里点取消 = 零副作用」，而 `logLLMCall`
   * 会经 `db:log-llm-call` 写项目库——取消后会残留孤儿统计；更严重的是该 handler
   * 无 token 守卫，两次 LLM 调用长达分钟级，期间切项目会把统计写进另一个项目库。
   *
   * ⚠️ 只作用于**成功**的调用。失败（onError）一律立即写：那不是用户取消，
   * 成本已实际发生，而工作流会就此中止、永远走不到 flush 点，延迟等于丢弃。
   */
  logPolicy?: 'immediate' | 'defer'
}

/** 延迟写入的 llm_calls 条目（logPolicy: 'defer' 时暂存于 context.data） */
export interface DeferredLLMLog {
  modelId: string
  modelName: string
  purpose: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  durationMs: number
  success: boolean
  errorMessage: string
}

/** context.data 中暂存延迟日志的固定键名 */
export const DEFERRED_LLM_LOGS_KEY = '__deferredLLMLogs'

/**
 * context.data 中「工作流起点 token」的固定键名。
 *
 * 工作流一旦写入本键，`callLLM` 就切换到**严格模式**：每次发模前核对当前项目 token，
 * 不一致直接抛错终止，且统计一律记在起点 token 名下。
 *
 * 为什么不能每次调用现取：跨多次 LLM 调用的长流程（续卷跨两次、分钟级），
 * 用户在第一次和第二次之间切了项目时，第二次会读到 B 的 `project_core`
 * 拼出「A 的收卷报告 + B 的世界设定」这种混合 prompt，失败统计也会合法写进 B 库。
 *
 * 不设本键的既有工作流行为完全不变（回退到调用时取当前 token）。
 */
export const WORKFLOW_TOKEN_KEY = '__workflowToken'

export interface CommandExecuteParams {
  step: unknown
  context: WorkflowContext
  callbacks: StepCallbacks
}

/**
 * 工作流执行环节的抽象基类 (Command Pattern)
 * 将原本混乱的 workflow 闭包拆分为可独立测试、状态解耦的命令单元。
 */
export abstract class BaseWorkflowCommand<TResult = string> {
  
  /** 抽象执行入口 */
  abstract execute(params: CommandExecuteParams): Promise<TResult>

  /** 获取 LLM 大模型连接代理（支持取消） */
  protected async callLLM(
    prompt: string,
    systemPrompt: string,
    callbacks: StepCallbacks,
    options?: CallLLMOptions,
    context?: WorkflowContext
  ): Promise<string> {
    const llmStore = useLLMStore.getState()
    // 按用途解析模型：指定 purpose 时取对应模型（为空回退 defaultModelId），否则直接用 defaultModelId
    const modelId = options?.purpose ? llmStore.getModelIdForPurpose(options.purpose) : llmStore.defaultModelId
    if (!modelId) throw new Error('未配置 AI 模型')

    // 统计上下文：模型显示名 + 用途标签 + 起始时刻（写入 llm_calls）
    const modelName = llmStore.models.find(m => m.id === modelId)?.name || modelId
    const purposeStat = options?.purposeLabel ?? options?.purpose ?? ''
    const startTime = Date.now()

    // ⚠️ token 必须在**任何 await 之前**取。llm_calls 的写入发生在流式结束之后
    // （可能是几分钟），那时 getProjectToken() 已是用户切过去的新项目，
    // 而 db:log-llm-call 对缺省 token 是放行的——结果把 A 项目的调用统计
    // 记进 B 项目的库。成功与失败两条路径都要带上它。
    //
    // 跨多次调用的长流程会把**起点 token** 放进 context（见 WORKFLOW_TOKEN_KEY）：
    // 此时不能现取，否则第二次调用会捕获切换后的新 token 并被判为合法。
    const workflowToken = context?.data[WORKFLOW_TOKEN_KEY] as number | undefined
    const capturedToken = workflowToken ?? getProjectToken()
    if (workflowToken !== undefined && getProjectToken() !== workflowToken) {
        throw new Error('项目已切换，工作流已终止（未发起本次模型调用）')
    }

    const manageProgress = options?.manageProgress !== false
    if (manageProgress) callbacks.setProgress(10)

    return new Promise((resolve, reject) => {
      let fullContent = ''
      let streamRequestId = ''

      // 取消监听：轮询 context.cancelled，主动中断 LLM 流
      let cancelCheckTimer: ReturnType<typeof setInterval> | null = null
      if (context) {
        cancelCheckTimer = setInterval(() => {
          if (context.cancelled && streamRequestId) {
            clearInterval(cancelCheckTimer!)
            cancelCheckTimer = null
            llmStore.cancelGeneration(streamRequestId).catch(() => {})
            reject(new Error('工作流已取消'))
          }
        }, 200)
      }

      const cleanup = () => {
        if (cancelCheckTimer) {
          clearInterval(cancelCheckTimer)
          cancelCheckTimer = null
        }
      }

      llmStore.generateStream(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ],
        {
          onChunk: (chunk) => {
            // 取消后不再追加输出
            if (context?.cancelled) return
            fullContent += chunk
            callbacks.appendText(chunk)
            // 增量钩子。默认仅在出现对象闭合括号时触发（减少无谓扫描，供目录增量入库用）；
            // 打字机预览须传 streamChunkMode: 'every'，否则单对象 JSON 全程零回调
            const shouldFire = options?.streamChunkMode === 'every' || chunk.includes('}')
            if (options?.onStreamChunk && shouldFire) {
              // ⚠️ 必须传**剥离 thinking 后**的文本，与 onDone 的 `cleaned` 同一规范。
              // 传原文会让增量消费方（目录生成的流式预览入库）解析到推理段里的
              // 临时 JSON——DeepSeek/Claude 的推理里出现「第 11 章草稿对象」是常态，
              // 它会先于正式答案落库，而正式答案随后被「已预览过就跳过」滤掉，
              // 数据库里永久留着推理时的临时版本。
              // `stripThinkingTags` 的正则带 `|$`，未闭合的 `<think>`（流到一半）也能截断。
              try { options.onStreamChunk(this.stripThinkingTags(fullContent)) } catch { /* 增量解析失败不影响主流程 */ }
            }
          },
          onDone: (text, usage) => {
            cleanup()
            // 取消后不 resolve，让 reject 生效（取消不计入调用统计）
            if (context?.cancelled) {
              reject(new Error('工作流已取消'))
              return
            }
            if (manageProgress) callbacks.setProgress(90)
            const raw = text || fullContent
            const cleaned = this.stripThinkingTags(raw)
            this.logLLMCall({
              modelId, modelName, purpose: purposeStat,
              systemPrompt, prompt, output: raw, usage,
              durationMs: Date.now() - startTime, success: true,
              logPolicy: options?.logPolicy, context, capturedToken,
            })
            resolve(cleaned)
          },
          onError: (err) => {
            cleanup()
            const msg = err || '流式生成失败'
            // 取消类错误不计入统计；真实失败记录一条 success=false
            if (!this.isCancellation(msg)) {
              this.logLLMCall({
                modelId, modelName, purpose: purposeStat,
                systemPrompt, prompt, output: fullContent, usage: undefined,
                durationMs: Date.now() - startTime, success: false, errorMessage: msg,
                // 刻意不传 logPolicy：失败一律立即写（见 CallLLMOptions.logPolicy 注释）。
                // 但必须带上起点 token，否则会把 A 的失败统计写进已切换的 B 库
                capturedToken,
              })
            }
            reject(new Error(msg))
          }
        },
        modelId,
        options
      ).then(reqId => {
        streamRequestId = reqId
        // 如果在 generateStream 返回前已经取消
        if (context?.cancelled) {
          llmStore.cancelGeneration(reqId).catch(() => {})
          cleanup()
          reject(new Error('工作流已取消'))
        }
      }).catch(err => {
        cleanup()
        reject(err)
      })
    })
  }

  /**
   * 使用 Builder 的 systemRole + prompt 一键调用 LLM
   * 角色定位由模板自带，command 不再需要硬编码 system message
   */
  protected async callLLMWithBuilder(
    builder: BasePromptBuilder,
    callbacks: StepCallbacks,
    options?: CallLLMOptions,
    context?: WorkflowContext
  ): Promise<string> {
    return this.callLLM(builder.build(), builder.getSystemRole(), callbacks, options, context)
  }

  /**
   * 若 context 里带了工作流起点 token，核对当前项目是否仍是同一个。
   *
   * 用在**发起读取之前**：`callLLM` 自己会核对，但那已经在读完 project_core 之后了，
   * 命令若先读了 B 的核心设定再被 callLLM 拦下，虽然没发出去，也白读一趟。
   */
  protected assertProjectUnchanged(context?: WorkflowContext): void {
    const workflowToken = context?.data[WORKFLOW_TOKEN_KEY] as number | undefined
    if (workflowToken !== undefined && getProjectToken() !== workflowToken) {
      throw new Error('项目已切换，工作流已终止')
    }
  }

  /** 取消类错误（用户主动中止），不计入调用统计 */
  private isCancellation(msg: string): boolean {
    return msg.includes('已取消') || msg.includes('取消')
  }

  /**
   * 写入一条 LLM 调用记录到 llm_calls（供底部「模型调用」面板展示）。
   * 优先用模型真实返回的 usage；端点未返回时按「中文 ~1.5 字符/token」兜底估算，
   * 避免面板出现满屏 0。记录失败静默吞掉，绝不影响主创作流程。
   */
  private logLLMCall(p: {
    modelId: string
    modelName: string
    purpose: string
    systemPrompt: string
    prompt: string
    output: string
    usage?: TokenUsage
    durationMs: number
    success: boolean
    errorMessage?: string
    /** 'defer' 时不写库，暂存到 context.data 供调用方在确认落库时 flush */
    logPolicy?: 'immediate' | 'defer'
    context?: WorkflowContext
    /** callLLM 发起时捕获的项目 token，防止延迟到达的统计写进已切换的另一个项目库 */
    capturedToken?: number
  }): void {
    // 兜底估算计入 system + user 两条消息（实际请求两者都发送）
    const promptTokens = p.usage?.promptTokens ?? Math.ceil((p.systemPrompt.length + p.prompt.length) / 1.5)
    const completionTokens = p.usage?.completionTokens ?? Math.ceil(p.output.length / 1.5)
    const totalTokens = p.usage?.totalTokens ?? (promptTokens + completionTokens)
    const entry: DeferredLLMLog = {
      modelId: p.modelId,
      modelName: p.modelName,
      purpose: p.purpose,
      promptTokens,
      completionTokens,
      totalTokens,
      durationMs: p.durationMs,
      success: p.success,
      errorMessage: p.errorMessage ?? '',
    }

    if (p.logPolicy === 'defer') {
      // 暂存不写库。context 缺失时宁可丢掉统计，也不退回立即写——
      // 退回会让「取消即零副作用」的承诺在无声中失效。
      if (!p.context) {
        console.warn('[BaseWorkflowCommand] logPolicy=defer 但未传 context，本条统计已丢弃')
        return
      }
      const bucket = (p.context.data[DEFERRED_LLM_LOGS_KEY] as DeferredLLMLog[] | undefined) ?? []
      bucket.push(entry)
      p.context.data[DEFERRED_LLM_LOGS_KEY] = bucket
      return
    }

    ipc.invoke('db:log-llm-call', { ...entry }, p.capturedToken)
      .then(() => globalEventBus.emit('LLM_CALL_LOGGED', { success: p.success }))
      .catch(() => { /* 统计写入失败不影响主流程 */ })
  }

  /**
   * 去除 DeepSeek 等模型的 <think> 标签，保证落盘纯净
   */
  protected stripThinkingTags(text: string): string {
    return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim()
  }

  /**
   * 全局容错 JSON 解析器
   * 自动剥离 Markdown ```json 代码块并处理尾随逗号等常见大模型幻觉
   */
  protected parseJSON<T>(text: string): T {
    try {
      // 1. 剥离 Markdown 块
      let cleanText = text.replace(/```json?\n?/gi, '').replace(/```\n?/gi, '').trim()
      // 2. 如果存在前序引导语，截取第一把括号到最后一把括号
      const firstBrace = cleanText.indexOf('{')
      const firstBracket = cleanText.indexOf('[')
      const lastBrace = cleanText.lastIndexOf('}')
      const lastBracket = cleanText.lastIndexOf(']')

      if (firstBrace !== -1 && lastBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
        cleanText = cleanText.substring(firstBrace, lastBrace + 1)
      } else if (firstBracket !== -1 && lastBracket !== -1) {
        cleanText = cleanText.substring(firstBracket, lastBracket + 1)
      }
      
      return JSON.parse(cleanText) as T
    } catch {
      throw new Error(`AI 返回的数据格式乱码，无法解析为有效层级结构。尝试解析内容末端: ${text.slice(-100)}`)
    }
  }

  /**
   * 解耦的事件驱动：通知 UI 层去更新资产树，而无需去 import Zustand Store
   */
  protected notifyRefresh(resources: EventPayloadMap['REFRESH_RESOURCE']['resources']) {
    globalEventBus.emit('REFRESH_RESOURCE', { resources })
  }
}


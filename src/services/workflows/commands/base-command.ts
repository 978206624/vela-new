import type { WorkflowContext, StepCallbacks } from '../../../stores/workflow-store'
import { useLLMStore } from '../../../stores/llm-store'
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
}

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
            // 增量解析钩子（如目录边生成边入库）。仅在出现对象闭合括号时触发，减少无谓扫描
            if (options?.onStreamChunk && chunk.includes('}')) {
              try { options.onStreamChunk(fullContent) } catch { /* 增量解析失败不影响主流程 */ }
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
  }): void {
    // 兜底估算计入 system + user 两条消息（实际请求两者都发送）
    const promptTokens = p.usage?.promptTokens ?? Math.ceil((p.systemPrompt.length + p.prompt.length) / 1.5)
    const completionTokens = p.usage?.completionTokens ?? Math.ceil(p.output.length / 1.5)
    const totalTokens = p.usage?.totalTokens ?? (promptTokens + completionTokens)
    ipc.invoke('db:log-llm-call', {
      modelId: p.modelId,
      modelName: p.modelName,
      purpose: p.purpose,
      promptTokens,
      completionTokens,
      totalTokens,
      durationMs: p.durationMs,
      success: p.success,
      errorMessage: p.errorMessage ?? '',
    })
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


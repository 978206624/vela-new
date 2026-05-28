import { ModelProfile, LLMChatMessage, LLMToolDef, LLMToolCall, ClaudeThinkingBlock } from '../../src/shared/ipc-channels'

export interface LLMGenerateOptions {
  temperature: number
  maxTokens: number
  responseFormat?: { type: string }
  thinking?: boolean
  /** 原生工具定义（提供则启用 function calling） */
  tools?: LLMToolDef[]
}

export interface LLMStreamOptions extends LLMGenerateOptions {
  signal: AbortSignal
  onChunk: (chunk: string) => void
  /**
   * 流结束：
   * - fullText：纯文本（已剥离 thinking 标签的可见 content）
   * - toolCalls：模型本轮发起的原生工具调用（已组装）
   * - thinkingBlocks：Anthropic 多轮回传所需的原始 thinking 块（仅 Claude 路径产出）
   */
  onDone: (
    fullText: string,
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number },
    toolCalls?: LLMToolCall[],
    thinkingBlocks?: ClaudeThinkingBlock[],
    reasoningContent?: string,
  ) => void
  onError: (error: string) => void
}

export interface LLMResponse {
  success: boolean
  content: string
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
  toolCalls?: LLMToolCall[]
  /** Anthropic thinking content blocks（仅 Claude 路径产出，供多轮回传保留 signature/redacted data） */
  thinkingBlocks?: ClaudeThinkingBlock[]
  /** DeepSeek/OpenAI 协议族 reasoning_content 原文（供 tool_calls 多轮回传） */
  reasoningContent?: string
  error?: string
}

export interface ILLMProvider {
  /** 非流式生成 */
  generate(
    model: ModelProfile,
    messages: LLMChatMessage[],
    opts: LLMGenerateOptions
  ): Promise<LLMResponse>

  /** 流式生成 */
  generateStream(
    model: ModelProfile,
    messages: LLMChatMessage[],
    opts: LLMStreamOptions
  ): Promise<void>

  /**
   * 拉取当前 baseUrl+apiKey 对应服务商的可用模型 ID 列表。
   * 由 SettingsModal 的「拉取可用」按钮触发；失败应抛出可读 Error，主进程统一归类。
   */
  listModels(model: ModelProfile): Promise<string[]>
}

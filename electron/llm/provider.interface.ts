import { ModelProfile, LLMChatMessage, LLMToolDef, LLMToolCall } from '../../src/shared/ipc-channels'

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
  /** 流结束：fullText 为纯文本，toolCalls 为模型本轮发起的原生工具调用（已组装） */
  onDone: (
    fullText: string,
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number },
    toolCalls?: LLMToolCall[],
  ) => void
  onError: (error: string) => void
}

export interface LLMResponse {
  success: boolean
  content: string
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
  toolCalls?: LLMToolCall[]
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
}

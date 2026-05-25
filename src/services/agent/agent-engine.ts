/**
 * Agent 核心引擎 — ReAct（Reasoning + Acting）循环
 *
 * 这是 Agent 的大脑，负责：
 * 1. 将用户消息、系统提示、历史组装为 LLM 输入（工具能力经模型原生 function calling 通道传递）
 * 2. 真流式接收模型文本（逐字回调 onTextChunk）
 * 3. 消费模型返回的原生 tool_calls，执行 Tool 并把结果以 tool 角色消息回灌下一轮
 * 4. 循环直到模型不再发起工具调用或达到安全上限
 *
 * Phase 7 重写：弃手搓 <tool_call> XML 正则，改用模型原生结构化 tool-calling + 真流式。
 */

import { toolRegistry, type ToolResult, type ToolArtifact } from './tool-registry'
import type { LLMChatMessage, LLMToolCall, LLMToolDef, TokenUsage } from '../../shared/ipc-channels'

// ===== 常量 =====

/** ReAct 循环安全上限（防止工具调用死循环；模型通常会自行终止，远不到此值） */
const MAX_TOOL_ROUNDS = 16

/** Tool 执行超时（毫秒） */
const TOOL_TIMEOUT_MS = 30_000

/** Tool 返回内容最大长度（字符） */
const TOOL_RESULT_MAX_CHARS = 3000

// ===== 类型 =====

/** Tool 调用信息（UI 渲染用） */
export interface ToolCallInfo {
  id: string
  toolName: string
  arguments: Record<string, unknown>
  status: 'pending' | 'running' | 'completed' | 'failed' | 'waiting_confirm'
  result?: string
  error?: string
  /** Tool 来源标记 */
  source?: string
}

/** Agent Engine 回调 */
export interface AgentEngineCallbacks {
  /** 流式文本片段（真流式，逐字到达） */
  onTextChunk: (chunk: string) => void
  /** Tool 调用开始 */
  onToolCallStart: (toolCall: ToolCallInfo) => void
  /** Tool 调用完成 */
  onToolCallComplete: (toolCall: ToolCallInfo) => void
  /** Tool 需要用户确认 */
  onToolCallConfirmRequired: (toolCall: ToolCallInfo) => Promise<boolean>
  /** 全部完成 */
  onDone: (fullText: string, toolCalls: ToolCallInfo[], artifacts: ToolArtifact[]) => void
  /** 错误 */
  onError: (error: string) => void
}

/** LLM 消息格式（统一基准；含原生 tool-calling 回合所需字段） */
export type LLMMessage = LLMChatMessage

/** 单轮 LLM 生成结果 */
export interface AgentLLMResult {
  /** 模型本轮输出的纯文本（已去 think 标签） */
  text: string
  /** 模型本轮发起的原生工具调用（空数组表示无调用） */
  toolCalls: LLMToolCall[]
  /** token 用量（供上层写 llm_calls） */
  usage?: TokenUsage
}

/**
 * LLM 流式生成函数签名（由 agent-store 提供实际实现）。
 * 文本经 onTextChunk 实时回调；返回值携带组装后的 tool_calls 与 usage。
 */
export type LLMGenerateFn = (
  messages: LLMMessage[],
  modelId: string,
  tools: LLMToolDef[],
  onTextChunk: (chunk: string) => void,
) => Promise<AgentLLMResult>

// ===== 核心引擎 =====

/**
 * 执行 Agent ReAct 循环
 *
 * 每轮：真流式调 LLM（文本逐字回调）→ 拿到原生 tool_calls →
 * 无调用则结束；有调用则执行（写入型先确认）→ 结果以 tool 角色消息回灌 → 下一轮。
 */
export async function runAgentLoop(
  systemPrompt: string,
  historyMessages: LLMMessage[],
  userMessage: string,
  modelId: string,
  generateFn: LLMGenerateFn,
  callbacks: AgentEngineCallbacks,
  abortSignal?: AbortSignal,
): Promise<void> {
  const allToolCalls: ToolCallInfo[] = []
  const allArtifacts: ToolArtifact[] = []

  // 构建消息列表
  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    ...historyMessages,
    { role: 'user', content: userMessage },
  ]

  // 原生工具定义（经 API 通道传递，模型自行决定是否调用）
  const tools = toolRegistry.getToolDefinitions()

  let rounds = 0
  let fullAssistantText = ''

  /** 累加每轮的纯文本，轮次之间用空行分隔 */
  const appendRoundText = (text: string) => {
    const t = text.trim()
    if (!t) return
    fullAssistantText += (fullAssistantText ? '\n\n' : '') + t
  }

  // 取消时不调 onDone：store 的 cancelGeneration 已把「已显示的流式内容 + 停止文案」落定，
  // 引擎再 onDone 会用旧的 fullAssistantText 覆盖用户已看到的本轮流式回复（清空成只剩停止文案）。
  // 因此 abort 路径一律静默 return，取消 UI 完全交给 cancelGeneration。
  const aborted = () => abortSignal?.aborted === true

  while (rounds < MAX_TOOL_ROUNDS) {
    if (aborted()) return

    rounds++

    // 真流式调用 LLM：文本经 onTextChunk 实时吐给 UI
    let result: AgentLLMResult
    try {
      result = await generateFn(messages, modelId, tools, callbacks.onTextChunk)
    } catch (error) {
      // 取消（用户中止）静默退出，由 cancelGeneration 负责 UI
      if (aborted()) return
      callbacks.onError(`LLM 调用失败：${String(error)}`)
      return
    }

    if (aborted()) return

    appendRoundText(result.text)

    // 无工具调用 → 模型自主结束
    if (result.toolCalls.length === 0) {
      callbacks.onDone(fullAssistantText, allToolCalls, allArtifacts)
      return
    }

    // 将模型本轮回复（含原生 tool_calls）加入历史
    messages.push({
      role: 'assistant',
      content: result.text,
      tool_calls: result.toolCalls,
    })

    // 依次执行每个 tool_call，结果以 tool 角色消息回灌（每个调用都必须有对应回应）
    for (const tc of result.toolCalls) {
      // 取消后立即退出：避免对后续工具再发起永不兑现的确认 Promise（cancelGeneration 已清空待确认表）
      if (aborted()) return

      const args = parseToolArguments(tc.arguments)
      const toolCallInfo: ToolCallInfo = {
        id: tc.id,
        toolName: tc.name,
        arguments: args,
        status: 'pending',
      }
      allToolCalls.push(toolCallInfo)

      const tool = toolRegistry.get(tc.name)
      if (!tool) {
        toolCallInfo.status = 'failed'
        toolCallInfo.error = `未知工具：${tc.name}`
        callbacks.onToolCallComplete(toolCallInfo)
        messages.push(makeToolMessage(tc, `未知工具：${tc.name}。可用工具：${toolRegistry.listAll().map(t => t.name).join(', ')}`))
        continue
      }

      toolCallInfo.source = tool.source

      // 写入型工具需用户确认
      if (tool.requiresConfirmation) {
        toolCallInfo.status = 'waiting_confirm'
        callbacks.onToolCallStart(toolCallInfo)

        const confirmed = await callbacks.onToolCallConfirmRequired(toolCallInfo)
        if (aborted()) return
        if (!confirmed) {
          toolCallInfo.status = 'failed'
          toolCallInfo.error = '用户拒绝执行'
          callbacks.onToolCallComplete(toolCallInfo)
          messages.push(makeToolMessage(tc, '用户拒绝了此操作'))
          continue
        }
      }

      // 执行 Tool
      toolCallInfo.status = 'running'
      callbacks.onToolCallStart(toolCallInfo)

      try {
        const execResult = await executeToolWithTimeout(tool.execute, args, TOOL_TIMEOUT_MS)
        const truncatedContent = truncateResult(execResult.content, TOOL_RESULT_MAX_CHARS)

        toolCallInfo.status = execResult.success ? 'completed' : 'failed'
        toolCallInfo.result = truncatedContent
        if (execResult.error) toolCallInfo.error = execResult.error
        if (execResult.artifacts) allArtifacts.push(...execResult.artifacts)

        callbacks.onToolCallComplete(toolCallInfo)

        messages.push(makeToolMessage(
          tc,
          execResult.success ? truncatedContent : `错误：${execResult.error ?? truncatedContent}`,
        ))
      } catch (error) {
        toolCallInfo.status = 'failed'
        toolCallInfo.error = `执行异常：${String(error)}`
        callbacks.onToolCallComplete(toolCallInfo)
        messages.push(makeToolMessage(tc, `执行异常：${String(error)}`))
      }
    }
  }

  // 达到安全上限
  fullAssistantText += '\n\n⚠️ 已达到最大工具调用次数限制，自动停止。'
  callbacks.onDone(fullAssistantText, allToolCalls, allArtifacts)
}

// ===== 工具函数 =====

/** 构造一条 tool 角色结果消息（tool_call_id 供 OpenAI 匹配，name 供 Gemini 匹配） */
function makeToolMessage(tc: LLMToolCall, content: string): LLMMessage {
  return { role: 'tool', tool_call_id: tc.id, name: tc.name, content }
}

/** 解析原生 tool_call 的 JSON 字符串参数，失败回退空对象 */
function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    console.warn('[AgentEngine] tool_call 参数 JSON 解析失败:', raw)
    return {}
  }
}

/** 带超时的 Tool 执行 */
async function executeToolWithTimeout(
  executeFn: (args: Record<string, unknown>) => Promise<ToolResult>,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<ToolResult> {
  return Promise.race([
    executeFn(args),
    new Promise<ToolResult>((_, reject) =>
      setTimeout(() => reject(new Error(`工具执行超时（${timeoutMs / 1000}s）`)), timeoutMs)
    ),
  ])
}

/** 截断过长的 Tool 结果 */
function truncateResult(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  return content.slice(0, maxChars) + `\n\n…（内容已截断，完整内容共 ${content.length} 字符。可使用 read_file 工具获取完整文件内容）`
}

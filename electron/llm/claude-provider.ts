/**
 * Anthropic Messages API provider（Claude 4.x 系列）。
 *
 * 与 OpenAI Chat Completions 的关键差异：
 * - Auth：`x-api-key` + `anthropic-version` 头，不是 Bearer
 * - system：顶层字段，不在 messages 数组里
 * - max_tokens：必填
 * - messages：每条 content 既可以是 string 也可以是 content blocks 数组（text/tool_use/tool_result/thinking/redacted_thinking）
 * - 响应：`content[]` 是块数组，需要拼 text 块；usage 字段是 input_tokens / output_tokens
 * - 流式：SSE event 名只有 message_start/content_block_start/content_block_delta/content_block_stop/message_delta/message_stop/ping/error；delta 子类型在 content_block_delta 的 JSON 里：text_delta / thinking_delta / signature_delta / input_json_delta
 *
 * Extended thinking 按模型能力矩阵分支（按官方 models/all-models 当前清单）：
 * - Opus 4.8 / Opus 4.7 → 仅 adaptive（manual enabled 会被拒）
 * - Sonnet 4.6 / Opus 4.6 → adaptive + manual 都支持，优先 adaptive
 * - Sonnet 4.5 / Haiku 4.5 / Opus 4.5 / Opus 4.1 → 仅 manual extended（需带 budget_tokens）
 *
 * 多轮回传约束：assistant 历史既有 tool_use 又有 thinking 时，必须把 thinking 块（含 signature）
 * 和 redacted_thinking 块原样回传，否则 API 400。本 provider 通过 LLMChatMessage.thinkingBlocks
 * 在 assistant 消息上携带这些块，wire 时重建 content 数组。
 */

import { ILLMProvider, LLMGenerateOptions, LLMResponse, LLMStreamOptions } from './provider.interface'
import { ModelProfile, LLMChatMessage, LLMToolDef, LLMToolCall, ClaudeThinkingBlock } from '../../src/shared/ipc-channels'

const ANTHROPIC_VERSION = '2023-06-01'

/** Anthropic content block union（请求/响应的最小覆盖集；其它如 image/document 暂不实现） */
type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | ClaudeThinkingBlock

/** Anthropic wire message：assistant 上有 tools/thinking 时 content 必须是 blocks 数组 */
interface AnthropicWireMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

export class ClaudeProvider implements ILLMProvider {
  /**
   * 归一化 baseUrl + 拼端点路径。
   * 兼容用户填法：
   * - `https://api.anthropic.com` → 加 `/v1/<endpoint>`
   * - `https://api.anthropic.com/v1` → 加 `/<endpoint>`
   * - `https://api.anthropic.com/v1/messages` → 退到 `/v1`，再拼 `/<endpoint>`
   * - 任意末尾斜杠剥掉
   */
  private buildUrl(baseUrl: string, endpoint: 'messages' | 'models'): string {
    let base = baseUrl.replace(/\/+$/, '')
    // 已是完整 /v1/messages 或 /v1/models —— 退到 /v1
    if (/\/v1\/(messages|models)$/.test(base)) {
      base = base.replace(/\/(messages|models)$/, '')
    }
    // 已含 /v1 后缀 → 直接拼端点
    if (/\/v1$/.test(base)) return `${base}/${endpoint}`
    // 裸 host → 补 /v1
    return `${base}/v1/${endpoint}`
  }

  /**
   * 按所选模型能力 + 调用方 thinking 意图，生成 Anthropic thinking 请求字段。
   * 返回 undefined 表示不发 thinking 字段。
   */
  private resolveThinkingConfig(
    modelName: string,
    thinkingRequested: boolean | undefined,
    maxTokens: number,
  ): Record<string, unknown> | undefined {
    if (!thinkingRequested) return undefined

    // Opus 4.8 / Opus 4.7 仅支持 adaptive（manual enabled 会被拒）
    if (modelName.startsWith('claude-opus-4-8') || modelName.startsWith('claude-opus-4-7')) {
      return { type: 'adaptive', display: 'summarized' }
    }

    // 同时支持 adaptive 与 manual（官方推荐 adaptive）
    // Anthropic 官方 adaptive 矩阵：Mythos Preview / Opus 4.8 / Opus 4.7 / Opus 4.6 / Sonnet 4.6 才支持
    // 其中 Opus 4.8 / 4.7 是仅 adaptive（上面已单独分支），下面这条是同时 adaptive + manual 的型号
    // Sonnet 4.5 / Opus 4.5 / Opus 4.1 / Haiku 4.5 等只支持 manual budget_tokens
    if (
      modelName.startsWith('claude-sonnet-4-6') ||
      modelName.startsWith('claude-opus-4-6')
    ) {
      return { type: 'adaptive', display: 'summarized' }
    }

    // 仅支持 manual extended：sonnet-4-5 / haiku-4-5 / opus-4-5 / opus-4-1 等
    const budget = Math.max(1024, Math.min(Math.floor(maxTokens / 2), 16384))
    if (maxTokens <= budget) {
      throw new Error(
        `Claude thinking 模式需要 max_tokens > budget_tokens；默认 budget=${budget}，当前 max_tokens=${maxTokens}，请把 max_tokens 调到 ≥ ${budget + 1}`,
      )
    }
    return { type: 'enabled', budget_tokens: budget }
  }

  /**
   * 把 vela 标准 LLMChatMessage[] 转换成 Anthropic wire messages + 顶层 system。
   * 关键规则：
   * - system 摘到顶层（多条 system 拼接）
   * - 连续 role:'tool' 消息合并成一个 user 消息，tool_result 块排在最前
   * - assistant 带 tool_calls / thinkingBlocks → 重建 content 数组：[thinking..., text, tool_use...]
   */
  private toWireMessages(messages: LLMChatMessage[]): {
    system?: string
    messages: AnthropicWireMessage[]
  } {
    let systemText = ''
    const wire: AnthropicWireMessage[] = []
    // 连续 tool 消息聚合缓冲：遇到非 tool 消息时 flush 成一个 user 消息
    let pendingToolResults: AnthropicContentBlock[] = []

    const flushToolResults = () => {
      if (pendingToolResults.length === 0) return
      wire.push({ role: 'user', content: pendingToolResults })
      pendingToolResults = []
    }

    for (const m of messages) {
      if (m.role === 'system') {
        systemText += (systemText ? '\n\n' : '') + m.content
        continue
      }

      if (m.role === 'tool') {
        // 多个 tool 结果聚合到一个 user 消息：Anthropic 要求 tool_result 紧跟 assistant tool_use
        pendingToolResults.push({
          type: 'tool_result',
          tool_use_id: m.tool_call_id ?? '',
          content: m.content ?? '',
        })
        continue
      }

      // 遇到 user/assistant → 先 flush 之前累积的 tool_results
      flushToolResults()

      if (m.role === 'user') {
        wire.push({ role: 'user', content: m.content })
        continue
      }

      // assistant：可能携带 tool_calls 和/或 thinkingBlocks，content 需要重建为数组
      const blocks: AnthropicContentBlock[] = []
      // thinking blocks 必须排在最前（Anthropic 多轮硬约束）
      if (m.thinkingBlocks && m.thinkingBlocks.length > 0) {
        for (const tb of m.thinkingBlocks) blocks.push(tb)
      }
      if (m.content) blocks.push({ type: 'text', text: m.content })
      if (m.tool_calls && m.tool_calls.length > 0) {
        for (const tc of m.tool_calls) {
          let input: Record<string, unknown> = {}
          try {
            input = tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {}
          } catch {
            // arguments 不是合法 JSON 时退化为字符串包装
            input = { raw: tc.arguments }
          }
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input })
        }
      }

      if (blocks.length === 0) {
        // 极端情况：assistant 既无 text 也无 tool_calls，回填空字符串避免空数组
        wire.push({ role: 'assistant', content: '' })
      } else if (blocks.length === 1 && blocks[0].type === 'text') {
        // 单 text 块简化为字符串
        wire.push({ role: 'assistant', content: blocks[0].text })
      } else {
        wire.push({ role: 'assistant', content: blocks })
      }
    }

    // 收尾：消息末尾如果还挂着未 flush 的 tool_results（不应该出现但防御性处理）
    flushToolResults()

    return { system: systemText || undefined, messages: wire }
  }

  /** 把 LLMToolDef[] 转 Anthropic tools 数组：`{ name, description, input_schema }`（注意是 input_schema 不是 parameters） */
  private toWireTools(tools?: LLMToolDef[]): Array<Record<string, unknown>> | undefined {
    if (!tools || tools.length === 0) return undefined
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }))
  }

  /** 错误响应体压成可读单行（同 embedding.ts 的风格） */
  private summarizeError(status: number, body: string): string {
    const trimmed = body.trim()
    if (!trimmed) return `Claude API ${status}：无响应内容`
    let detail = trimmed
    try {
      const j = JSON.parse(trimmed) as { error?: { message?: string; type?: string } }
      if (j.error?.message) detail = j.error.message
    } catch { /* 非 JSON 按原文 */ }
    if (/<html|<!doctype|<head|<body|cloudflare/i.test(detail)) {
      return `Claude API ${status}：端点返回网页而非 JSON（鉴权失败或代理拦截）`
    }
    const oneLine = detail.replace(/\s+/g, ' ').trim()
    return `Claude API ${status}：${oneLine.length > 240 ? oneLine.slice(0, 240) + '…' : oneLine}`
  }

  // ============================== 非流式 ==============================

  async generate(model: ModelProfile, messages: LLMChatMessage[], opts: LLMGenerateOptions): Promise<LLMResponse> {
    try {
      const { system, messages: wireMessages } = this.toWireMessages(messages)
      const maxTokens = opts.maxTokens ?? model.maxTokens

      const body: Record<string, unknown> = {
        model: model.modelName,
        max_tokens: maxTokens,
        messages: wireMessages,
      }
      if (system) body.system = system

      // Anthropic 思考模式不接受 temperature/top_p（会被忽略或拒绝）；非思考路径才传
      const thinkingConfig = this.resolveThinkingConfig(model.modelName, opts.thinking, maxTokens)
      if (thinkingConfig) {
        body.thinking = thinkingConfig
      } else {
        body.temperature = opts.temperature ?? model.temperature
      }

      const wireTools = this.toWireTools(opts.tools)
      if (wireTools) body.tools = wireTools

      const url = this.buildUrl(model.baseUrl, 'messages')
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': model.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const text = await res.text()
        return { success: false, content: '', error: this.summarizeError(res.status, text) }
      }

      const data = await res.json() as {
        content: AnthropicContentBlock[]
        usage?: { input_tokens?: number; output_tokens?: number }
      }

      // 提取 text 拼接成可见内容；thinking 块保留到 thinkingBlocks（不影响 content）
      let textOut = ''
      const toolCalls: LLMToolCall[] = []
      const thinkingBlocks: ClaudeThinkingBlock[] = []
      let thinkText = ''
      for (const blk of data.content ?? []) {
        if (blk.type === 'text') {
          textOut += blk.text
        } else if (blk.type === 'tool_use') {
          toolCalls.push({ id: blk.id, name: blk.name, arguments: JSON.stringify(blk.input ?? {}) })
        } else if (blk.type === 'thinking') {
          thinkText += blk.thinking
          thinkingBlocks.push(blk)
        } else if (blk.type === 'redacted_thinking') {
          thinkingBlocks.push(blk)
        }
      }
      // 用 <think> 标签包装思考内容拼到 content 前面（UI 已有解析逻辑）
      const finalContent = thinkText ? `<think>\n${thinkText}\n</think>\n\n${textOut}` : textOut

      return {
        success: true,
        content: finalContent,
        usage: data.usage
          ? {
              promptTokens: data.usage.input_tokens ?? 0,
              completionTokens: data.usage.output_tokens ?? 0,
              totalTokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
            }
          : undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        thinkingBlocks: thinkingBlocks.length > 0 ? thinkingBlocks : undefined,
      }
    } catch (error) {
      return { success: false, content: '', error: String(error) }
    }
  }

  // ============================== 流式 ==============================

  async generateStream(model: ModelProfile, messages: LLMChatMessage[], opts: LLMStreamOptions): Promise<void> {
    try {
      const { system, messages: wireMessages } = this.toWireMessages(messages)
      const maxTokens = opts.maxTokens ?? model.maxTokens

      const body: Record<string, unknown> = {
        model: model.modelName,
        max_tokens: maxTokens,
        messages: wireMessages,
        stream: true,
      }
      if (system) body.system = system

      const thinkingConfig = this.resolveThinkingConfig(model.modelName, opts.thinking, maxTokens)
      if (thinkingConfig) {
        body.thinking = thinkingConfig
      } else {
        body.temperature = opts.temperature ?? model.temperature
      }

      const wireTools = this.toWireTools(opts.tools)
      if (wireTools) body.tools = wireTools

      const url = this.buildUrl(model.baseUrl, 'messages')
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': model.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      })

      if (!res.ok) {
        const text = await res.text()
        opts.onError(this.summarizeError(res.status, text))
        return
      }
      const reader = res.body?.getReader()
      if (!reader) {
        opts.onError('无法读取响应流')
        return
      }

      const decoder = new TextDecoder()
      let fullText = ''
      let isThinkingOpen = false   // 是否当前流处于 <think> 段（用于控制何时输出闭合标签）
      let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined
      // Anthropic 在 HTTP 200 的流中也可能发 event:error（如 overloaded_error）；捕获后置标记，
      // 流结束时不再 onDone，避免把 API 失败误报为成功
      let streamError: string | undefined

      // 按 block index 累积各类 content_block 的状态
      const textBlocks = new Map<number, string>()
      const thinkBlocks = new Map<number, { text: string; signature: string }>()
      const redactedBlocks = new Map<number, string>()
      const toolBlocks = new Map<number, { id: string; name: string; jsonAcc: string }>()

      const consumeSseLine = (line: string) => {
        // Anthropic SSE 同时给 `event: <name>` 和 `data: <json>`，本实现忽略 event 名，按 data.type 判断
        if (!line.startsWith('data:')) return
        const json = line.slice(line.indexOf(':') + 1).trim()
        if (!json) return
        try {
          const ev = JSON.parse(json) as Record<string, unknown>
          const evType = ev.type as string | undefined

          // 块开始：记录 index 对应的块类型
          if (evType === 'content_block_start') {
            const idx = ev.index as number
            const block = ev.content_block as { type: string; id?: string; name?: string }
            if (block.type === 'text') {
              textBlocks.set(idx, '')
            } else if (block.type === 'thinking') {
              thinkBlocks.set(idx, { text: '', signature: '' })
              // 开启 <think> 包装到 fullText（仅一次）
              if (!isThinkingOpen) {
                isThinkingOpen = true
                const open = '<think>\n'
                fullText += open
                opts.onChunk(open)
              }
            } else if (block.type === 'redacted_thinking') {
              redactedBlocks.set(idx, (block as { data?: string }).data ?? '')
            } else if (block.type === 'tool_use') {
              toolBlocks.set(idx, { id: block.id ?? '', name: block.name ?? '', jsonAcc: '' })
            }
            return
          }

          // 块增量：按 delta.type 分发
          if (evType === 'content_block_delta') {
            const idx = ev.index as number
            const delta = ev.delta as { type: string; text?: string; thinking?: string; signature?: string; partial_json?: string }
            if (delta.type === 'text_delta' && typeof delta.text === 'string') {
              // 文本增量：若之前在 thinking 段，要先闭合
              if (isThinkingOpen) {
                isThinkingOpen = false
                const close = '\n</think>\n\n'
                fullText += close
                opts.onChunk(close)
              }
              textBlocks.set(idx, (textBlocks.get(idx) ?? '') + delta.text)
              fullText += delta.text
              opts.onChunk(delta.text)
            } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
              const acc = thinkBlocks.get(idx) ?? { text: '', signature: '' }
              acc.text += delta.thinking
              thinkBlocks.set(idx, acc)
              fullText += delta.thinking
              opts.onChunk(delta.thinking)
            } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
              const acc = thinkBlocks.get(idx) ?? { text: '', signature: '' }
              acc.signature += delta.signature
              thinkBlocks.set(idx, acc)
            } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
              const acc = toolBlocks.get(idx)
              if (acc) acc.jsonAcc += delta.partial_json
            }
            return
          }

          // 块结束：thinking 块在结束时如果没有更多 text 紧接，则在所有事件处理完后统一闭合
          if (evType === 'content_block_stop') {
            return
          }

          // 消息层面 delta：含 stop_reason / usage（usage.output_tokens 累计）
          if (evType === 'message_delta') {
            const u = ev.usage as { input_tokens?: number; output_tokens?: number } | undefined
            if (u) {
              usage = {
                promptTokens: u.input_tokens ?? usage?.promptTokens ?? 0,
                completionTokens: u.output_tokens ?? usage?.completionTokens ?? 0,
                totalTokens: (u.input_tokens ?? usage?.promptTokens ?? 0) + (u.output_tokens ?? usage?.completionTokens ?? 0),
              }
            }
            return
          }

          // message_start 可能也带 usage（input_tokens 在这一步给）
          if (evType === 'message_start') {
            const msg = ev.message as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined
            if (msg?.usage) {
              usage = {
                promptTokens: msg.usage.input_tokens ?? 0,
                completionTokens: msg.usage.output_tokens ?? 0,
                totalTokens: (msg.usage.input_tokens ?? 0) + (msg.usage.output_tokens ?? 0),
              }
            }
            return
          }

          // 流内错误事件（HTTP 200 + event:error）：标记后让上层 onError，不进 onDone
          if (evType === 'error') {
            const err = ev.error as { type?: string; message?: string } | undefined
            const typeLabel = err?.type ? `${err.type}: ` : ''
            streamError = `${typeLabel}${err?.message ?? '未知流式错误'}`
            return
          }
          // ping / message_stop 忽略
        } catch {
          // 半包或异常 JSON，吞掉（行缓冲会兜下次）
        }
      }

      // 行缓冲（SSE 行可能跨包）
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const raw of lines) consumeSseLine(raw.trim())
      }
      if (buffer.trim()) consumeSseLine(buffer.trim())

      // 收尾：thinking 段还开着就闭合
      if (isThinkingOpen) {
        const close = '\n</think>\n\n'
        fullText += close
        opts.onChunk(close)
      }

      // 组装本轮工具调用
      const toolCalls: LLMToolCall[] = [...toolBlocks.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => ({ id: v.id || `call_${v.name}`, name: v.name, arguments: v.jsonAcc || '{}' }))
        .filter((tc) => tc.name)

      // 组装本轮 thinkingBlocks（按 index 升序，保留 thinking + redacted_thinking）
      const thinkingBlocks: ClaudeThinkingBlock[] = []
      const allIdx = new Set<number>([...thinkBlocks.keys(), ...redactedBlocks.keys()])
      const sortedIdx = [...allIdx].sort((a, b) => a - b)
      for (const idx of sortedIdx) {
        const tb = thinkBlocks.get(idx)
        if (tb) {
          thinkingBlocks.push({ type: 'thinking', thinking: tb.text, signature: tb.signature })
          continue
        }
        const rd = redactedBlocks.get(idx)
        if (rd !== undefined) {
          thinkingBlocks.push({ type: 'redacted_thinking', data: rd })
        }
      }

      // 流内 error 事件优先：API 实际失败时不调 onDone，避免上层把失败当成功落库
      if (streamError) {
        opts.onError(`Claude 流式错误：${streamError}`)
        return
      }

      // 调用方拿到的 fullText 剥掉 <think> 段（上层惯例：可见内容不含思考）
      const cleanText = fullText.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim()

      opts.onDone(
        cleanText,
        usage,
        toolCalls.length > 0 ? toolCalls : undefined,
        thinkingBlocks.length > 0 ? thinkingBlocks : undefined,
      )
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        opts.onError('已取消生成')
      } else {
        opts.onError(String(error))
      }
    }
  }

  // ============================== 拉取模型清单 ==============================

  async listModels(model: ModelProfile): Promise<string[]> {
    // Anthropic /v1/models 默认 limit=20 + has_more 分页；要循环拉全
    const baseModelsUrl = this.buildUrl(model.baseUrl, 'models')
    const all: string[] = []
    let after: string | undefined
    const seenIds = new Set<string>()
    // 安全上限：防止异常循环（实际型号清单远不到这）
    for (let page = 0; page < 20; page++) {
      const url = new URL(baseModelsUrl)
      url.searchParams.set('limit', '1000')
      if (after) url.searchParams.set('after_id', after)
      const res = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'x-api-key': model.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) {
        const body = await res.text()
        throw new Error(this.summarizeError(res.status, body))
      }
      const data = await res.json() as { data?: Array<{ id?: string }>; has_more?: boolean; last_id?: string }
      const ids = (data.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
      for (const id of ids) {
        if (!seenIds.has(id)) {
          seenIds.add(id)
          all.push(id)
        }
      }
      if (!data.has_more || !data.last_id) break
      after = data.last_id
    }
    return all
  }
}

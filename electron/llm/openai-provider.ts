import { ILLMProvider, LLMGenerateOptions, LLMResponse, LLMStreamOptions } from './provider.interface'
import { ModelProfile, LLMChatMessage, LLMToolDef, LLMToolCall } from '../../src/shared/ipc-channels'

export class OpenAIProvider implements ILLMProvider {
  private buildUrl(baseUrl: string): string {
    const base = baseUrl.replace(/\/+$/, '')
    // 已是完整 chat/completions 路径 → 原样使用
    if (base.endsWith('/chat/completions')) return base
    // 以 /v1/chat 结尾 → 补 /completions
    if (base.endsWith('/v1/chat')) return `${base}/completions`
    // 以 /v1 结尾（OpenAI 兼容端点最常见写法，如 DeepSeek/Ollama/各类代理）→ 补 /chat/completions
    if (base.endsWith('/v1')) return `${base}/chat/completions`
    // 裸 host → 补全完整路径
    return `${base}/v1/chat/completions`
  }

  /** 统一消息 → OpenAI 线格式（assistant.tool_calls / tool role 回灌） */
  private toWireMessages(messages: LLMChatMessage[]): Array<Record<string, unknown>> {
    return messages.map((m) => {
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        return {
          role: 'assistant',
          // 有 tool_calls 时 content 可为空，按协议传 null
          content: m.content || null,
          tool_calls: m.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          })),
        }
      }
      if (m.role === 'tool') {
        return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content }
      }
      return { role: m.role, content: m.content }
    })
  }

  /** 工具定义 → OpenAI tools 数组 */
  private toWireTools(tools?: LLMToolDef[]): Array<Record<string, unknown>> | undefined {
    if (!tools || tools.length === 0) return undefined
    return tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }

  async generate(model: ModelProfile, messages: LLMChatMessage[], opts: LLMGenerateOptions): Promise<LLMResponse> {
    const url = this.buildUrl(model.baseUrl)

    const body: Record<string, unknown> = {
      model: model.modelName,
      messages: this.toWireMessages(messages),
      max_tokens: opts.maxTokens ?? model.maxTokens,
      stream: false,
    }

    // 思考模式下 temperature/top_p 等参数不生效（DeepSeek 会静默忽略），仅在非思考模式下传递
    if (opts.thinking) {
      // thinking 参数直接放在请求体顶层（非 extra_body，那是 OpenAI SDK 层概念）
      body.thinking = { type: 'enabled' }
    } else {
      body.temperature = opts.temperature ?? model.temperature
    }

    if (opts.responseFormat) body.response_format = opts.responseFormat
    const wireTools = this.toWireTools(opts.tools)
    if (wireTools) {
      body.tools = wireTools
      body.tool_choice = 'auto'
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${model.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      return { success: false, content: '', error: `API 调用失败 (${res.status}): ${text}` }
    }

    const data = await res.json() as {
      choices: Array<{ message: {
        content: string
        reasoning_content?: string
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
      } }>
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
    }

    let finalContent = data.choices?.[0]?.message?.content ?? ''
    finalContent = finalContent.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim()

    const rawToolCalls = data.choices?.[0]?.message?.tool_calls
    const toolCalls: LLMToolCall[] | undefined = rawToolCalls && rawToolCalls.length > 0
      ? rawToolCalls.map((tc) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments ?? '' }))
      : undefined

    return {
      success: true,
      content: finalContent,
      toolCalls,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      } : undefined,
    }
  }

  async generateStream(model: ModelProfile, messages: LLMChatMessage[], opts: LLMStreamOptions): Promise<void> {
    try {
      const url = this.buildUrl(model.baseUrl)

      const body: Record<string, unknown> = {
        model: model.modelName,
        messages: this.toWireMessages(messages),
        max_tokens: opts.maxTokens ?? model.maxTokens,
        stream: true,
        // 请求在流末尾追加一个 usage 块（OpenAI/DeepSeek/智谱等兼容端点支持；
        // 不支持的端点会忽略该字段，usage 保持 undefined 由上层兜底估算）
        stream_options: { include_usage: true },
      }

      // 思考模式下 temperature/top_p 等参数不生效（DeepSeek 会静默忽略），仅在非思考模式下传递
      if (opts.thinking) {
        body.thinking = { type: 'enabled' }
      } else {
        body.temperature = opts.temperature ?? model.temperature
      }

      if (opts.responseFormat) body.response_format = opts.responseFormat
      const wireTools = this.toWireTools(opts.tools)
      if (wireTools) {
        body.tools = wireTools
        body.tool_choice = 'auto'
      }

      const doFetch = () => fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${model.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      })

      let res = await doFetch()
      // 某些严格校验 body 的端点（部分 Ollama/自建网关）不认 stream_options。
      // 仅当 400 错误确实指向该字段时才剔除并重试一次，避免对上下文超限/非法模型等
      // 普通 400 多发一次注定失败的请求（usage 此时回退估算）。
      if (!res.ok && res.status === 400 && 'stream_options' in body) {
        const errText = await res.text()
        if (/stream_options|include_usage|unknown|unsupported|not support/i.test(errText)) {
          delete body.stream_options
          res = await doFetch()
        } else {
          opts.onError(`API 调用失败 (${res.status}): ${errText}`)
          return
        }
      }

      if (!res.ok) {
        const text = await res.text()
        opts.onError(`API 调用失败 (${res.status}): ${text}`)
        return
      }

      const reader = res.body?.getReader()
      if (!reader) {
        opts.onError('无法读取响应流')
        return
      }

      const decoder = new TextDecoder()
      let fullText = ''
      let isThinking = false
      let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined
      // 原生工具调用按 index 累加：id/name 在首块到达，arguments 跨块拼接成 JSON 字符串
      const toolCallAcc = new Map<number, { id: string; name: string; arguments: string }>()

      // 解析单条 SSE data 行（闭包共享 fullText/isThinking/usage/toolCallAcc）
      const consumeLine = (line: string) => {
        if (!line.startsWith('data:')) return
        const json = line.slice(line.indexOf(':') + 1).trim()
        if (!json || json === '[DONE]') return
        try {
          const parsed = JSON.parse(json) as {
            choices?: Array<{ delta?: {
              content?: string
              reasoning_content?: string
              tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>
            } }>
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
          }
          // include_usage 模式下，末尾会出现一个 choices 为空、仅含 usage 的块
          if (parsed.usage) {
            usage = {
              promptTokens: parsed.usage.prompt_tokens ?? 0,
              completionTokens: parsed.usage.completion_tokens ?? 0,
              totalTokens: parsed.usage.total_tokens ?? 0,
            }
          }
          const delta = parsed.choices?.[0]?.delta

          // 累加原生工具调用 deltas
          if (delta?.tool_calls) {
            for (const tcDelta of delta.tool_calls) {
              const idx = tcDelta.index ?? 0
              const acc = toolCallAcc.get(idx) ?? { id: '', name: '', arguments: '' }
              if (tcDelta.id) acc.id = tcDelta.id
              if (tcDelta.function?.name) acc.name = tcDelta.function.name
              if (tcDelta.function?.arguments) acc.arguments += tcDelta.function.arguments
              toolCallAcc.set(idx, acc)
            }
          }

          let emitChunk = ''

          // 思维链内容
          if (delta?.reasoning_content) {
            if (!isThinking) {
              isThinking = true
              emitChunk += '<think>\n'
            }
            emitChunk += delta.reasoning_content
          }

          // 正文内容
          if (delta?.content !== undefined && delta?.content !== null) {
            if (isThinking) {
              isThinking = false
              emitChunk += '\n</think>\n\n'
            }
            if (delta?.content) emitChunk += delta.content
          }

          if (emitChunk) {
            fullText += emitChunk
            opts.onChunk(emitChunk)
          }
        } catch {
          // ignore（半包已由 buffer 兜住，此处仅防御异常 JSON）
        }
      }

      // 行缓冲：SSE data 行可能跨 read 拆包，必须合并后按完整行解析，
      // 否则末尾仅一行的 usage 块极易被拆断而丢失（Phase 5 用量统计依赖它）
      let buffer = ''
      const hasMore = true
      while (hasMore) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const rawLines = buffer.split('\n')
        buffer = rawLines.pop() ?? ''   // 末尾可能是半行，留到下次合并
        for (const raw of rawLines) consumeLine(raw.trim())
      }
      // 流结束时缓冲区可能残留最后一整行（无尾随换行）
      if (buffer.trim()) consumeLine(buffer.trim())

      if (isThinking) {
        const closeTag = '\n</think>\n\n'
        fullText += closeTag
        opts.onChunk(closeTag)
      }

      // 组装本轮工具调用（按 index 升序；过滤无名残块）
      const toolCalls: LLMToolCall[] = [...toolCallAcc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => ({ id: v.id || `call_${v.name}`, name: v.name, arguments: v.arguments }))
        .filter((tc) => tc.name)

      opts.onDone(
        fullText.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim(),
        usage,
        toolCalls.length > 0 ? toolCalls : undefined,
      )
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        opts.onError('已取消生成')
      } else {
        opts.onError(String(error))
      }
    }
  }
}

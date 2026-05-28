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

  /**
   * 统一消息 → OpenAI 线格式（assistant.tool_calls / tool role 回灌）。
   *
   * DeepSeek thinking 多轮约束：thinking 模式下带 tool_calls 的 assistant 历史消息必须回传
   * reasoning_content，否则 API 400。处理：
   * - assistant 有 reasoningContent（DeepSeek 上一轮返回的）→ 原样回传
   * - DeepSeek + thinking enabled + 有 tool_calls 但 reasoningContent 缺失 → 用占位 'tool call' 兜底
   *   （cc-switch 同款策略，已实测 DeepSeek v4 接受）
   * 非 thinking / 非 DeepSeek 路径不加 reasoning_content，避免污染其它端点。
   */
  private toWireMessages(messages: LLMChatMessage[], model: ModelProfile, opts: LLMGenerateOptions): Array<Record<string, unknown>> {
    // reasoning_content 仅对思考协议族（DeepSeek/BigModel）回传，避免污染 OpenAI/本地逆向等严格端点
    // （切模型后历史里残留的 reasoningContent 不应发给不支持该字段的端点）。
    const reasoningProto = this.usesReasoningProtocol(model)
    // DeepSeek v4 服务端默认 thinking 开，仅 opts.thinking===false（显式关）时才不需要 reasoning_content。
    // Agent 路径不传 thinking（undefined），仍受默认 thinking 约束，故用 !== false 判定。占位仅 DeepSeek 需要。
    const deepseekThinkingActive = model.provider === 'deepseek' && opts.thinking !== false
    return messages.map((m) => {
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        const wire: Record<string, unknown> = {
          role: 'assistant',
          // 有 tool_calls 时 content 可为空，按协议传 null
          content: m.content || null,
          tool_calls: m.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          })),
        }
        if (m.reasoningContent && reasoningProto) {
          wire.reasoning_content = m.reasoningContent
        } else if (deepseekThinkingActive) {
          // DeepSeek thinking + tool_calls 但缺真实 reasoning_content → 占位兜底，避免 400
          wire.reasoning_content = 'tool call'
        }
        return wire
      }
      if (m.role === 'tool') {
        return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content }
      }
      // 普通 assistant 文本消息：仅思考协议族且带 reasoningContent 时回传
      if (m.role === 'assistant' && m.reasoningContent && reasoningProto) {
        return { role: m.role, content: m.content, reasoning_content: m.reasoningContent }
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

  /**
   * 该 provider 是否使用 DeepSeek 式「思考协议」——用 `thinking: {type}` 字段控制思考，
   * 并以 assistant.reasoning_content 承载思考内容（带 tool_calls 多轮需原样回传）。
   * 目前 DeepSeek 与智谱 BigModel 走这套；OpenAI / Ollama / custom / 本地逆向端点不保证支持，
   * 给它们发 thinking / reasoning_content 字段可能被严格端点拒绝，故需 guard。
   */
  private usesReasoningProtocol(model: ModelProfile): boolean {
    return model.provider === 'deepseek' || model.provider === 'bigmodel'
  }

  /**
   * 写入 thinking 相关请求字段（generate / generateStream 共用），三态语义：
   * - true  → `thinking: { type: 'enabled' }`。
   * - false → `thinking: { type: 'disabled' }` 显式关闭。DeepSeek v4/reasoner 服务端默认 thinking 开，
   *           仅"不传字段"无法关；显式 disabled 可让带 tool_calls 的 Agent 多轮绕过
   *           "reasoning_content 必须回传"的硬约束（经 DeepSeek API 实测确认）。
   * - undefined → 不发 thinking 字段，沿用端点默认。
   *
   * temperature 仅在非 enabled 分支传（思考模式下 DeepSeek 会忽略 temperature）。
   */
  private applyThinking(body: Record<string, unknown>, model: ModelProfile, opts: LLMGenerateOptions): void {
    if (opts.thinking === true) {
      body.thinking = { type: 'enabled' }
    } else if (opts.thinking === false) {
      // 只对思考协议族（DeepSeek/BigModel）显式发 disabled；其它端点不认 thinking 字段，
      // 发未知字段可能被严格端点拒绝，故不发，回到普通关闭行为。
      if (this.usesReasoningProtocol(model)) {
        body.thinking = { type: 'disabled' }
      }
      body.temperature = opts.temperature ?? model.temperature
    } else {
      body.temperature = opts.temperature ?? model.temperature
    }
  }

  async generate(model: ModelProfile, messages: LLMChatMessage[], opts: LLMGenerateOptions): Promise<LLMResponse> {
    const url = this.buildUrl(model.baseUrl)

    const body: Record<string, unknown> = {
      model: model.modelName,
      messages: this.toWireMessages(messages, model, opts),
      max_tokens: opts.maxTokens ?? model.maxTokens,
      stream: false,
    }

    this.applyThinking(body, model, opts)

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

    // 保留 reasoning_content 原文：DeepSeek thinking + tool_calls 多轮回传必须带它（否则 400）
    const reasoningContent = data.choices?.[0]?.message?.reasoning_content || undefined

    const rawToolCalls = data.choices?.[0]?.message?.tool_calls
    const toolCalls: LLMToolCall[] | undefined = rawToolCalls && rawToolCalls.length > 0
      ? rawToolCalls.map((tc) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments ?? '' }))
      : undefined

    return {
      success: true,
      content: finalContent,
      toolCalls,
      reasoningContent,
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
        messages: this.toWireMessages(messages, model, opts),
        max_tokens: opts.maxTokens ?? model.maxTokens,
        stream: true,
        // 请求在流末尾追加一个 usage 块（OpenAI/DeepSeek/智谱等兼容端点支持；
        // 不支持的端点会忽略该字段，usage 保持 undefined 由上层兜底估算）
        stream_options: { include_usage: true },
      }

      this.applyThinking(body, model, opts)

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
      // reasoning_content 原文累积（不含 <think> 包装）：DeepSeek tool_calls 多轮回传需要原始字符串
      let reasoningAcc = ''
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
            reasoningAcc += delta.reasoning_content   // 累积原文供多轮回传
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
        undefined,                         // thinkingBlocks：OpenAI 协议无（Claude 专用）
        reasoningAcc || undefined,         // reasoningContent：DeepSeek 多轮回传用
      )
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        opts.onError('已取消生成')
      } else {
        opts.onError(String(error))
      }
    }
  }

  /**
   * 归一化 baseUrl → list-models URL（独立于 chat completions buildUrl，避免被追加 /chat/completions）。
   *
   * **Provider-aware**：DeepSeek 官方 list-models 端点是裸 `/models`（不带 /v1），
   * 跟 OpenAI 的 `/v1/models` 不同。所以裸 host 兜底分支按 provider 字段决定补 `/v1/models` 还是 `/models`。
   *
   * 兼容用户填法：
   * - 已是完整 `/models` 路径 → 原样使用
   * - 含 `/chat/completions` 完整路径 → 退两级再按版本规则拼
   * - 含 `/v1/chat` → 退一级到 `/v1`，补 `/models`
   * - 已含明确版本路径结尾（`/v\d+` 或 `/api/paas/v\d+`）→ 直接补 `/models`
   * - 裸 host：DeepSeek 补 `/models`，其它 OpenAI 兼容补 `/v1/models`
   */
  private buildModelsListUrl(model: ModelProfile): string {
    let base = model.baseUrl.replace(/\/+$/, '')
    // 短路：已填完整 /models 路径，原样返回
    if (base.endsWith('/models')) return base
    if (base.endsWith('/chat/completions')) base = base.slice(0, -'/chat/completions'.length)
    if (base.endsWith('/chat')) base = base.slice(0, -'/chat'.length)
    // 明确版本路径结尾（/v\d+ 或 /api/paas/v\d+）→ 直接拼 /models
    // 不再用宽松的"版本+任意单段"匹配，避免误伤 /v2/something 这类业务路径
    if (/\/v\d+$/.test(base) || /\/api\/paas\/v\d+$/.test(base)) {
      return `${base}/models`
    }
    // 裸 host fallback：DeepSeek 官方端点是 /models（不带 /v1）
    if (model.provider === 'deepseek') return `${base}/models`
    return `${base}/v1/models`
  }

  async listModels(model: ModelProfile): Promise<string[]> {
    // Ollama 协议路径不一样（/api/tags 而非 /models）；用户决策本次不实现，给友好提示
    if (model.provider === 'ollama') {
      throw new Error('Ollama 暂不支持自动拉取模型清单，请使用预设或手动输入型号名')
    }

    const url = this.buildModelsListUrl(model)
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(model.apiKey ? { Authorization: `Bearer ${model.apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(this.summarizeListModelsError(res.status, body))
    }
    const data = await res.json() as { data?: Array<{ id?: string }> }
    return (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
  }

  /** 错误响应压成单行（与 embedding.ts summarizeErrorBody 同风格） */
  private summarizeListModelsError(status: number, body: string): string {
    const trimmed = body.trim()
    if (!trimmed) return `拉取模型清单失败 (${status})：无响应内容`
    let detail = trimmed
    try {
      const j = JSON.parse(trimmed) as { error?: { message?: string } | string; message?: string }
      const picked = (typeof j.error === 'object' ? j.error?.message : j.error) ?? j.message
      if (typeof picked === 'string' && picked.trim()) detail = picked.trim()
    } catch { /* 非 JSON 按原文 */ }
    if (/<html|<!doctype|<head|<body|cloudflare|just a moment|enable javascript/i.test(detail)) {
      return `拉取模型清单失败 (${status})：端点返回网页而非 JSON（鉴权失败/被拦截，或该端点不支持列出模型）`
    }
    const oneLine = detail.replace(/\s+/g, ' ').trim()
    return `拉取模型清单失败 (${status})：${oneLine.length > 240 ? oneLine.slice(0, 240) + '…' : oneLine}`
  }
}

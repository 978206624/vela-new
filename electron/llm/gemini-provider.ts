import { ILLMProvider, LLMGenerateOptions, LLMResponse, LLMStreamOptions } from './provider.interface'
import { ModelProfile, LLMChatMessage, LLMToolDef, LLMToolCall } from '../../src/shared/ipc-channels'

/** Gemini content part：文本 / 模型发起的 functionCall / 回灌的 functionResponse。
 *  thoughtSignature 是 part 上与 functionCall 平级的字段（思考模型回合签名）。 */
type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; id?: string; args: Record<string, unknown> }; thoughtSignature?: string }
  | { functionResponse: { name: string; id?: string; response: Record<string, unknown> } }

export class GeminiProvider implements ILLMProvider {
  /** 统一消息 → Gemini contents（assistant.tool_calls→model functionCall；tool→user functionResponse） */
  private toGeminiContents(messages: LLMChatMessage[]) {
    let systemInstruction: string | undefined
    const contents: Array<{ role: string; parts: GeminiPart[] }> = []

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction = msg.content
        continue
      }

      // 工具结果回灌：role user + functionResponse（按 name/id 匹配上一轮的 functionCall）
      if (msg.role === 'tool') {
        contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name: msg.name ?? '',
              ...(msg.tool_call_id ? { id: msg.tool_call_id } : {}),
              response: { result: msg.content },
            },
          }],
        })
        continue
      }

      // 助手发起工具调用：role model，可含文本 + functionCall parts
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const parts: GeminiPart[] = []
        if (msg.content) parts.push({ text: msg.content })
        for (const tc of msg.tool_calls) {
          let args: Record<string, unknown> = {}
          try { args = tc.arguments ? JSON.parse(tc.arguments) : {} } catch { args = {} }
          // 思考模型续轮要求把原始 thoughtSignature 随原 functionCall part 原样回传
          parts.push({
            functionCall: { name: tc.name, ...(tc.id ? { id: tc.id } : {}), args },
            ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
          })
        }
        contents.push({ role: 'model', parts })
        continue
      }

      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      })
    }
    return { contents, systemInstruction }
  }

  /** 工具定义 → Gemini tools（functionDeclarations） */
  private toGeminiTools(tools?: LLMToolDef[]): Array<{ functionDeclarations: LLMToolDef[] }> | undefined {
    if (!tools || tools.length === 0) return undefined
    return [{ functionDeclarations: tools }]
  }

  /**
   * 归一化 baseUrl → API root（剥尾斜杠 + 剥已含 /v1beta 或 /v1beta/models 后缀）。
   * generate / generateStream / listModels 三处共用，避免用户填 /v1beta 时重复拼接。
   */
  private buildRoot(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, '').replace(/\/v1beta(\/models)?$/, '')
  }

  async generate(model: ModelProfile, messages: LLMChatMessage[], opts: LLMGenerateOptions): Promise<LLMResponse> {
    const root = this.buildRoot(model.baseUrl)
    const url = `${root}/v1beta/models/${model.modelName}:generateContent`

    const { contents, systemInstruction } = this.toGeminiContents(messages)

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        temperature: opts.temperature ?? model.temperature,
        maxOutputTokens: opts.maxTokens ?? model.maxTokens,
      },
    }
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] }
    }
    const geminiTools = this.toGeminiTools(opts.tools)
    if (geminiTools) body.tools = geminiTools

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': model.apiKey,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      return { success: false, content: '', error: `Gemini API 调用失败 (${res.status}): ${text}` }
    }

    const data = await res.json() as {
      candidates?: Array<{ content?: { parts?: Array<{
        text?: string
        functionCall?: { name: string; id?: string; args?: Record<string, unknown> }
        thoughtSignature?: string
      }> } }>
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
    }

    const parts = data.candidates?.[0]?.content?.parts ?? []
    let text = ''
    const toolCalls: LLMToolCall[] = []
    for (const part of parts) {
      if (part.text) text += part.text
      if (part.functionCall) {
        toolCalls.push({
          id: part.functionCall.id || `call_${part.functionCall.name}_${toolCalls.length}`,
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
          ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
        })
      }
    }
    const usage = data.usageMetadata ? {
      promptTokens: data.usageMetadata.promptTokenCount ?? 0,
      completionTokens: data.usageMetadata.candidatesTokenCount ?? 0,
      totalTokens: data.usageMetadata.totalTokenCount ?? 0,
    } : undefined

    return { success: true, content: text, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, usage }
  }

  async generateStream(model: ModelProfile, messages: LLMChatMessage[], opts: LLMStreamOptions): Promise<void> {
    try {
      const root = this.buildRoot(model.baseUrl)
      const url = `${root}/v1beta/models/${model.modelName}:streamGenerateContent?alt=sse`

      const { contents, systemInstruction } = this.toGeminiContents(messages)

      const body: Record<string, unknown> = {
        contents,
        generationConfig: {
          temperature: opts.temperature ?? model.temperature,
          maxOutputTokens: opts.maxTokens ?? model.maxTokens,
        },
      }
      if (systemInstruction) {
        body.systemInstruction = { parts: [{ text: systemInstruction }] }
      }
      const geminiTools = this.toGeminiTools(opts.tools)
      if (geminiTools) body.tools = geminiTools

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': model.apiKey,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      })

      if (!res.ok) {
        const text = await res.text()
        opts.onError(`Gemini API 调用失败 (${res.status}): ${text}`)
        return
      }

      const reader = res.body?.getReader()
      if (!reader) {
        opts.onError('无法读取 Gemini 响应流')
        return
      }

      const decoder = new TextDecoder()
      let fullText = ''
      let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined
      const toolCalls: LLMToolCall[] = []

      // 解析单条完整 SSE data 行（functionCall 可能整块出现，文本可能跨块拆分）
      const consumeLine = (line: string) => {
        if (!line.startsWith('data:')) return
        const json = line.slice(line.indexOf(':') + 1).trim()
        if (!json || json === '[DONE]') return
        try {
          const parsed = JSON.parse(json) as {
            candidates?: Array<{ content?: { parts?: Array<{
              text?: string
              functionCall?: { name: string; id?: string; args?: Record<string, unknown> }
              thoughtSignature?: string
            }> } }>
            usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
          }
          const parts = parsed.candidates?.[0]?.content?.parts ?? []
          for (const part of parts) {
            if (part.text) {
              fullText += part.text
              opts.onChunk(part.text)
            }
            if (part.functionCall) {
              toolCalls.push({
                id: part.functionCall.id || `call_${part.functionCall.name}_${toolCalls.length}`,
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args ?? {}),
                ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
              })
            }
          }
          if (parsed.usageMetadata) {
            usage = {
              promptTokens: parsed.usageMetadata.promptTokenCount ?? 0,
              completionTokens: parsed.usageMetadata.candidatesTokenCount ?? 0,
              totalTokens: parsed.usageMetadata.totalTokenCount ?? 0,
            }
          }
        } catch {
          // ignore（半包已由 buffer 兜住，此处仅防御异常 JSON）
        }
      }

      // 行缓冲：SSE data 行可能跨 read 拆包，合并后按完整行解析，避免 functionCall/usage 块被拆断丢失
      let buffer = ''
      const hasMore = true
      while (hasMore) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const rawLines = buffer.split('\n')
        buffer = rawLines.pop() ?? ''
        for (const raw of rawLines) consumeLine(raw.trim())
      }
      if (buffer.trim()) consumeLine(buffer.trim())

      opts.onDone(fullText, usage, toolCalls.length > 0 ? toolCalls : undefined)
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        opts.onError('已取消生成')
      } else {
        opts.onError(String(error))
      }
    }
  }

  /**
   * 拉取 Gemini 可用模型清单。
   * 端点：`GET {baseUrl}/v1beta/models?key=<apiKey>`
   * 双层过滤策略（应对代理网关可能不返回 supportedGenerationMethods 字段）：
   *   1. 优先按 `supportedGenerationMethods.includes('generateContent')` 过滤
   *   2. 字段缺失时退到名字硬过滤：剥掉 embed/imagen/veo 等明显非生成模型
   * 名字格式归一化：剥掉 `models/` 前缀。
   */
  async listModels(model: ModelProfile): Promise<string[]> {
    // 复用 buildRoot 跟 generate/generateStream 保持归一化一致
    const root = this.buildRoot(model.baseUrl)
    const namePassesHardFilter = (name: string): boolean => {
      const low = name.toLowerCase()
      return !low.includes('embed') && !low.includes('imagen') && !low.includes('veo')
    }

    const all: Array<{ name?: string; supportedGenerationMethods?: string[] }> = []
    let pageToken: string | undefined
    // 官方 models.list 分页：默认 pageSize=50，最大 1000；nextPageToken 翻页
    // 安全循环上限 20 页 × 1000 = 2 万型号，远超实际任何代理网关返回
    for (let page = 0; page < 20; page++) {
      const url = new URL(`${root}/v1beta/models`)
      url.searchParams.set('key', model.apiKey)
      url.searchParams.set('pageSize', '1000')
      if (pageToken) url.searchParams.set('pageToken', pageToken)

      const res = await fetch(url.toString(), {
        method: 'GET',
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) {
        const body = await res.text()
        throw new Error(this.summarizeGeminiListError(res.status, body))
      }

      const data = await res.json() as {
        models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>
        nextPageToken?: string
      }
      for (const m of data.models ?? []) all.push(m)
      if (!data.nextPageToken) break
      pageToken = data.nextPageToken
    }

    const filtered = all.filter((m) => {
      if (!m.name) return false
      // 字段存在 → 严格按 generateContent 过滤
      if (Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.length > 0) {
        return m.supportedGenerationMethods.includes('generateContent')
      }
      // 字段缺失（代理可能漏）→ 名字硬过滤兜底
      return namePassesHardFilter(m.name)
    })

    return filtered
      .map((m) => m.name!)
      .map((n) => (n.startsWith('models/') ? n.slice('models/'.length) : n))
      .filter((id) => id.length > 0)
  }

  private summarizeGeminiListError(status: number, body: string): string {
    const trimmed = body.trim()
    if (!trimmed) return `Gemini API ${status}：无响应内容`
    let detail = trimmed
    try {
      const j = JSON.parse(trimmed) as { error?: { message?: string } }
      if (j.error?.message) detail = j.error.message
    } catch { /* 非 JSON 按原文 */ }
    if (/<html|<!doctype|<head|<body|cloudflare/i.test(detail)) {
      return `Gemini API ${status}：端点返回网页而非 JSON（鉴权失败或代理拦截）`
    }
    const oneLine = detail.replace(/\s+/g, ' ').trim()
    return `Gemini API ${status}：${oneLine.length > 240 ? oneLine.slice(0, 240) + '…' : oneLine}`
  }
}

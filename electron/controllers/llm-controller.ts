import { ipcMain, BrowserWindow } from 'electron'
import { readJsonFile, writeJsonFile, MODELS_CONFIG_PATH, GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG } from '../utils/config-utils'
import { ModelProfile, GlobalConfig, LLMRequest } from '../../src/shared/ipc-channels'
import { LLMFactory } from '../llm/llm-factory'

const activeStreams = new Map<string, AbortController>()

function loadModelConfigs(): ModelProfile[] {
  return readJsonFile<ModelProfile[]>(MODELS_CONFIG_PATH, [])
}

function saveModelConfigs(models: ModelProfile[]) {
  writeJsonFile(MODELS_CONFIG_PATH, models)
}

function getModelConfig(modelId: string): ModelProfile | null {
  const models = loadModelConfigs()
  return models.find((m) => m.id === modelId) ?? null
}

/**
 * 按模型 thinkingMode 裁决最终是否开启 thinking——thinking 是"模型能力"而非用户偏好，
 * 不暴露成运行时 UI 开关。三档语义：
 * - 'always'：覆盖调用方代码，强制开（推理模型如 deepseek-reasoner / o-series）
 * - 'never'：覆盖调用方代码，强制关（普通 chat 模型如 deepseek-chat）
 * - 'optional' / 未设置：跟随调用方传入的 thinking（保持现有行为，向后兼容）
 */
function resolveThinking(model: ModelProfile, requested?: boolean): boolean | undefined {
  switch (model.thinkingMode) {
    case 'always': return true
    case 'never': return false
    default: return requested
  }
}

function applyProxyConfig() {
  try {
    const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
    if (config.proxy?.enabled && config.proxy.host) {
      const proxyUrl = config.proxy.type === 'socks5'
        ? `socks5://${config.proxy.host}:${config.proxy.port}`
        : `http://${config.proxy.host}:${config.proxy.port}`
      process.env.HTTP_PROXY = proxyUrl
      process.env.HTTPS_PROXY = proxyUrl
      process.env.http_proxy = proxyUrl
      process.env.https_proxy = proxyUrl
    } else {
      delete process.env.HTTP_PROXY
      delete process.env.HTTPS_PROXY
      delete process.env.http_proxy
      delete process.env.https_proxy
    }
  } catch { /* 忽略 */ }
}

export function registerLLMController() {
  ipcMain.handle('llm:generate', async (_event, request: LLMRequest) => {
    try {
      applyProxyConfig()
      const model = getModelConfig(request.modelId)
      if (!model) return { success: false, content: '', error: '未找到模型配置' }

      const provider = LLMFactory.getProvider(model)
      return await provider.generate(model, request.messages, {
        temperature: request.temperature ?? model.temperature,
        maxTokens: request.maxTokens ?? model.maxTokens,
        responseFormat: request.responseFormat,
        thinking: resolveThinking(model, request.thinking),
        tools: request.tools,
      })
    } catch (error) {
      return { success: false, content: '', error: String(error) }
    }
  })

  ipcMain.handle('llm:generate-stream', async (event, requestId: string, request: LLMRequest) => {
    applyProxyConfig()
    const model = getModelConfig(request.modelId)
    if (!model) return { requestId, started: false }

    const abortController = new AbortController()
    activeStreams.set(requestId, abortController)
    const win = BrowserWindow.fromWebContents(event.sender)

    const provider = LLMFactory.getProvider(model)

    // We do not await this globally since it's streaming independently
    provider.generateStream(model, request.messages, {
      temperature: request.temperature ?? model.temperature,
      maxTokens: request.maxTokens ?? model.maxTokens,
      responseFormat: request.responseFormat,
      thinking: resolveThinking(model, request.thinking),
      tools: request.tools,
      signal: abortController.signal,
      onChunk: (chunk: string) => win?.webContents.send('llm:stream-chunk', { requestId, chunk }),
      onDone: (fullText, usage, toolCalls, thinkingBlocks, reasoningContent) => {
        win?.webContents.send('llm:stream-done', { requestId, fullText, usage, toolCalls, thinkingBlocks, reasoningContent })
        activeStreams.delete(requestId)
      },
      onError: (error: string) => {
        win?.webContents.send('llm:stream-error', { requestId, error })
        activeStreams.delete(requestId)
      },
    })

    return { requestId, started: true }
  })

  ipcMain.handle('llm:cancel', async (_event, requestId: string) => {
    const controller = activeStreams.get(requestId)
    if (controller) {
      controller.abort()
      activeStreams.delete(requestId)
      return { success: true }
    }
    return { success: false }
  })

  ipcMain.handle('llm:list-models', async () => loadModelConfigs())

  ipcMain.handle('llm:save-model', async (_event, model: ModelProfile) => {
    try {
      const models = loadModelConfigs()
      const idx = models.findIndex((m) => m.id === model.id)
      if (idx >= 0) models[idx] = model
      else models.push(model)
      saveModelConfigs(models)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('llm:delete-model', async (_event, modelId: string) => {
    try {
      const models = loadModelConfigs().filter((m) => m.id !== modelId)
      saveModelConfigs(models)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('llm:set-default-model', async (_event, modelId: string | null) => {
    try {
      const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
      config.defaultModelId = modelId
      writeJsonFile(GLOBAL_CONFIG_PATH, config)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('llm:get-default-model', async () => {
    const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
    return config.defaultModelId
  })

  ipcMain.handle('llm:set-default-embedding-model', async (_event, modelId: string | null) => {
    try {
      const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
      config.defaultEmbeddingModelId = modelId
      writeJsonFile(GLOBAL_CONFIG_PATH, config)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('llm:get-default-embedding-model', async () => {
    const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
    return config.defaultEmbeddingModelId ?? null
  })

  ipcMain.handle('llm:test-connection', async (_event, model: ModelProfile) => {
    try {
      applyProxyConfig()
      
      const messages: LLMRequest['messages'] = [{ role: 'user', content: 'Say "hello" and nothing else.' }]
      const provider = LLMFactory.getProvider(model)
      
      let result = { success: true, error: undefined as undefined | string }
      if (model.purposes?.includes('embedding')) {
        // Anthropic 没有 embedding 模型，拒绝把 claude 走嵌入路径
        if (model.protocol !== 'openai' && model.protocol !== 'gemini') {
          return { success: false, error: 'Anthropic Claude 协议不支持嵌入模型，请改用 OpenAI / Gemini 兼容端点' }
        }
        const { generateEmbeddings } = await import('../embedding')
        await generateEmbeddings(['hello'], model.protocol, model)
      } else {
        const res = await provider.generate(model, messages, {
          temperature: 0.7,
          maxTokens: 10,
        })
        result = { success: res.success, error: res.error }
      }
      
      return { success: result.success, error: result.error }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  /**
   * 按 baseUrl+apiKey 拉取该服务商可用模型 ID 清单。
   * 跟 llm:test-connection 同范式：前端传 ModelProfile 草稿（不要求落库），主进程
   * applyProxyConfig 后按 protocol 分发到 provider.listModels；异常归类为 readable 字符串。
   */
  ipcMain.handle('llm:fetch-available-models', async (_event, model: ModelProfile) => {
    try {
      applyProxyConfig()
      const provider = LLMFactory.getProvider(model)
      const models = await provider.listModels(model)
      return { success: true, models }
    } catch (error) {
      return { success: false, models: [], error: error instanceof Error ? error.message : String(error) }
    }
  })
}

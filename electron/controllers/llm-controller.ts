import { app, ipcMain, BrowserWindow, powerSaveBlocker } from 'electron'
import { readJsonFile, writeJsonFile, MODELS_CONFIG_PATH, GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG } from '../utils/config-utils'
import { ModelProfile, GlobalConfig, LLMRequest } from '../../src/shared/ipc-channels'
import { LLMFactory } from '../llm/llm-factory'

// 每条在途流的记录：controller 用于中断，finalize 由 generate-stream 闭包注入，
// 是唯一的收尾权威——onDone / onError / promise 兜底 / 窗口销毁 / 主动取消 / 退出 六入口都走它，
// 单次幂等，保证 activeStreams 删除与 powerSaveBlocker 释放不被任何路径绕过。
interface ActiveStream {
  controller: AbortController
  finalize: (notify?: () => void) => void
  // 主动取消：中断 + 收尾，并向渲染端补发 stream-error('已取消生成')。
  // 必须发这条事件——渲染端 llm-store 仅在 stream-done/stream-error 里解绑监听、settle 业务 Promise，
  // 静默收尾会让前端监听器泄漏、workflow/Agent 的 generateStream Promise 永不兑现。
  cancel: () => void
}
const activeStreams = new Map<string, ActiveStream>()

// 生成期间阻止系统挂起（休眠/息屏）。长章节生成可能持续数分钟，
// 若 OS 把进程挂起，主进程的流式请求也会停。只要有活跃流就持有 blocker，全部结束即释放。
let powerSaveBlockerId: number | null = null
function refreshPowerSaveBlocker() {
  if (activeStreams.size > 0) {
    if (powerSaveBlockerId === null || !powerSaveBlocker.isStarted(powerSaveBlockerId)) {
      powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension')
    }
  } else if (powerSaveBlockerId !== null) {
    if (powerSaveBlocker.isStarted(powerSaveBlockerId)) powerSaveBlocker.stop(powerSaveBlockerId)
    powerSaveBlockerId = null
  }
}

// 向渲染进程发送：窗口或 webContents 可能在流结束前已销毁，send 会抛错并阻断调用方后续清理，
// 这里统一判活并吞掉异常（含判活与发送之间窗口被销毁的竞态），保证收尾逻辑始终能执行。
function safeSend(win: BrowserWindow | null, channel: string, payload: unknown) {
  try {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  } catch { /* 销毁竞态，忽略 */ }
}

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
    const win = BrowserWindow.fromWebContents(event.sender)

    // 单次收尾：onDone / onError / promise 兜底 / 窗口销毁 / 主动取消 / 退出 都可能触发。
    // settled 门闩保证只发一次终止消息、只解绑一次监听、只清理一次资源；
    // notify 放进 try/finally——即便发送逻辑抛错，activeStreams 删除与 blocker 释放也必然执行。
    let settled = false
    const finalize = (notify?: () => void) => {
      if (settled) return
      settled = true
      event.sender.off('destroyed', onSenderDestroyed)
      try {
        notify?.()
      } finally {
        activeStreams.delete(requestId)
        refreshPowerSaveBlocker()
      }
    }
    // 窗口/渲染进程销毁后流已无消费者：中断主进程请求并收尾，避免 blocker 永久悬挂。
    function onSenderDestroyed() {
      abortController.abort()
      finalize()
    }
    event.sender.once('destroyed', onSenderDestroyed)

    // 主动取消：中断后补发 stream-error('已取消生成')，复用渲染端既有的 stream-error cleanup 路径。
    // （字符串与各 provider 的 AbortError 文案一致，前端 isCancellation 据此识别为取消而非真失败。）
    const cancel = () => {
      abortController.abort()
      finalize(() => safeSend(win, 'llm:stream-error', { requestId, error: '已取消生成' }))
    }

    activeStreams.set(requestId, { controller: abortController, finalize, cancel })
    refreshPowerSaveBlocker()

    const provider = LLMFactory.getProvider(model)

    // 不 await：流式独立推进。但补 .catch 兜底——一旦 provider 直接 reject 或回调自身抛错，
    // 仍能收尾，不把资源释放完全托付给 onDone/onError 回调契约。
    void provider.generateStream(model, request.messages, {
      temperature: request.temperature ?? model.temperature,
      maxTokens: request.maxTokens ?? model.maxTokens,
      responseFormat: request.responseFormat,
      thinking: resolveThinking(model, request.thinking),
      tools: request.tools,
      signal: abortController.signal,
      onChunk: (chunk: string) => safeSend(win, 'llm:stream-chunk', { requestId, chunk }),
      onDone: (fullText, usage, toolCalls, thinkingBlocks, reasoningContent) => {
        finalize(() => safeSend(win, 'llm:stream-done', { requestId, fullText, usage, toolCalls, thinkingBlocks, reasoningContent }))
      },
      onError: (error: string) => {
        finalize(() => safeSend(win, 'llm:stream-error', { requestId, error }))
      },
    }).catch((err) => {
      finalize(() => safeSend(win, 'llm:stream-error', { requestId, error: String(err) }))
    })

    return { requestId, started: true }
  })

  ipcMain.handle('llm:cancel', async (_event, requestId: string) => {
    const stream = activeStreams.get(requestId)
    if (stream) {
      // 走闭包 cancel：中断 + 收尾 + 补发 stream-error('已取消生成')，不依赖 provider 的取消回调一定到达
      // （防御 provider 吞掉 abort），同时驱动渲染端 cleanup 与 Promise settle。
      stream.cancel()
      return { success: true }
    }
    return { success: false }
  })

  // 应用退出时统一收尾：中断所有在途流并经各自 finalize 释放资源（解绑监听 + 删除 + 释放 blocker）。
  // 先快照再遍历，避免 finalize 在迭代中删除 Map 条目。
  app.on('before-quit', () => {
    for (const stream of [...activeStreams.values()]) {
      stream.controller.abort()
      stream.finalize()
    }
    refreshPowerSaveBlocker()
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

import { create } from 'zustand'
import { ipc } from '../services/ipc-client'
import type { ModelProfile, LLMResponse, TokenUsage, LLMPurpose, GlobalConfig, LLMChatMessage, LLMToolDef, LLMToolCall } from '../shared/ipc-channels'

/** 流式生成的回调 */
interface StreamCallbacks {
  onChunk?: (chunk: string) => void
  onDone?: (fullText: string, usage?: TokenUsage, toolCalls?: LLMToolCall[]) => void
  onError?: (error: string) => void
}

/** 生成选项（responseFormat/thinking + 原生工具定义） */
interface GenerateOptions {
  responseFormat?: { type: string }
  thinking?: boolean
  /** 原生工具定义（提供则启用 function calling，仅流式 Agent 路径使用） */
  tools?: LLMToolDef[]
}

interface LLMState {
  /** 已配置的模型列表 */
  models: ModelProfile[]
  /** 当前默认生成模型 ID */
  defaultModelId: string | null
  /** 当前默认向量模型 ID */
  defaultEmbeddingModelId: string | null
  /** 按用途分配的生成模型 ID（为空回退 defaultModelId） */
  outlineModelId: string | null
  draftModelId: string | null
  reviewModelId: string | null
  /** 正在进行的活跃请求 */
  activeRequests: Map<string, { status: 'running' | 'done' | 'error'; text: string }>
  /** 是否已加载模型配置 */
  loaded: boolean

  // ===== Actions =====
  /** 初始化（加载模型列表 + 默认模型 ID） */
  init: () => Promise<void>
  /** 加载模型列表 */
  loadModels: () => Promise<void>
  /** 保存模型 */
  saveModel: (model: ModelProfile) => Promise<boolean>
  /** 删除模型 */
  deleteModel: (modelId: string) => Promise<boolean>
  /** 设置默认生成模型（持久化到 ~/.vela/config.json） */
  setDefaultModel: (modelId: string) => void
  /** 设置默认向量模型（持久化到 ~/.vela/config.json） */
  setDefaultEmbeddingModel: (modelId: string | null) => void
  /** 按用途解析实际模型 ID（为空回退 defaultModelId / defaultEmbeddingModelId） */
  getModelIdForPurpose: (purpose: LLMPurpose) => string | null
  /** 设置某生成用途的模型（持久化到 config.json；embedding 用 setDefaultEmbeddingModel） */
  setPurposeModel: (purpose: 'outline' | 'draft' | 'review', modelId: string | null) => void
  /** 非流式生成 */
  generate: (
    messages: LLMChatMessage[],
    modelId?: string,
    options?: GenerateOptions
  ) => Promise<LLMResponse>
  /** 流式生成 */
  generateStream: (
    messages: LLMChatMessage[],
    callbacks: StreamCallbacks,
    modelId?: string,
    options?: GenerateOptions
  ) => Promise<string>
  /** 取消生成 */
  cancelGeneration: (requestId: string) => Promise<void>
  /** 测试模型连接 */
  testConnection: (model: ModelProfile) => Promise<{ success: boolean; error?: string }>
}

export const useLLMStore = create<LLMState>()((set, get) => ({
  models: [],
  defaultModelId: null,
  defaultEmbeddingModelId: null,
  outlineModelId: null,
  draftModelId: null,
  reviewModelId: null,
  activeRequests: new Map(),
  loaded: false,

  init: async () => {
    if (get().loaded) return
    // 从 ~/.vela/ 加载模型列表和默认模型 ID
    await get().loadModels()
    if (ipc.isElectron) {
      const [defaultId, defaultEmbeddingId, config] = await Promise.all([
        ipc.invoke('llm:get-default-model'),
        ipc.invoke('llm:get-default-embedding-model'),
        ipc.invoke('config:get'),
      ])
      set({
        defaultModelId: defaultId,
        defaultEmbeddingModelId: defaultEmbeddingId,
        outlineModelId: config.outlineModelId ?? null,
        draftModelId: config.draftModelId ?? null,
        reviewModelId: config.reviewModelId ?? null,
        loaded: true,
      })
    } else {
      set({ loaded: true })
    }
  },

  loadModels: async () => {
    if (!ipc.isElectron) return
    const models = await ipc.invoke('llm:list-models')
    set({ models, loaded: true })
  },

  saveModel: async (model) => {
    const result = await ipc.invoke('llm:save-model', model)
    if (result.success) {
      await get().loadModels()
    }
    return result.success
  },

  deleteModel: async (modelId) => {
    const result = await ipc.invoke('llm:delete-model', modelId)
    if (result.success) {
      await get().loadModels()
      // 如果删除的是默认生成模型，清空默认
      if (get().defaultModelId === modelId) {
        set({ defaultModelId: null })
        ipc.invoke('llm:set-default-model', null)
      }
      // 如果删除的是默认向量模型，清空默认
      if (get().defaultEmbeddingModelId === modelId) {
        set({ defaultEmbeddingModelId: null })
        ipc.invoke('llm:set-default-embedding-model', null)
      }
      // 清理「按用途分配」中指向被删模型的悬空 ID，避免后续工作流取到不存在的模型
      const s = get()
      const purposePatch: Partial<GlobalConfig> = {}
      if (s.outlineModelId === modelId) purposePatch.outlineModelId = null
      if (s.draftModelId === modelId) purposePatch.draftModelId = null
      if (s.reviewModelId === modelId) purposePatch.reviewModelId = null
      if (Object.keys(purposePatch).length > 0) {
        set(purposePatch as Partial<LLMState>)
        ipc.invoke('config:set', purposePatch)
      }
    }
    return result.success
  },

  setDefaultModel: (modelId) => {
    set({ defaultModelId: modelId })
    ipc.invoke('llm:set-default-model', modelId)
  },

  setDefaultEmbeddingModel: (modelId) => {
    set({ defaultEmbeddingModelId: modelId })
    ipc.invoke('llm:set-default-embedding-model', modelId)
  },

  getModelIdForPurpose: (purpose) => {
    const s = get()
    switch (purpose) {
      case 'outline': return s.outlineModelId ?? s.defaultModelId
      case 'draft': return s.draftModelId ?? s.defaultModelId
      case 'review': return s.reviewModelId ?? s.defaultModelId
      case 'embedding': return s.defaultEmbeddingModelId ?? s.defaultModelId
      default: return s.defaultModelId
    }
  },

  setPurposeModel: (purpose, modelId) => {
    const patch: Partial<GlobalConfig> =
      purpose === 'outline' ? { outlineModelId: modelId }
      : purpose === 'draft' ? { draftModelId: modelId }
      : { reviewModelId: modelId }
    set(patch as Partial<LLMState>)
    ipc.invoke('config:set', patch)
  },

  generate: async (messages, modelId, options) => {
    const mid = modelId ?? get().defaultModelId
    if (!mid) return { success: false, content: '', error: '未配置默认模型' }
    return ipc.invoke('llm:generate', {
      modelId: mid,
      messages,
      responseFormat: options?.responseFormat as { type: 'json_object' | 'text' } | undefined,
      thinking: options?.thinking,
      tools: options?.tools,
    })
  },

  generateStream: async (messages, callbacks, modelId, options) => {
    const mid = modelId ?? get().defaultModelId
    if (!mid) {
      callbacks.onError?.('未配置默认模型')
      return ''
    }

    const requestId = crypto.randomUUID()

    // 注册流式事件监听
    const unsubChunk = ipc.on('llm:stream-chunk', (data) => {
      if (data.requestId === requestId) {
        callbacks.onChunk?.(data.chunk)
      }
    })

    const unsubDone = ipc.on('llm:stream-done', (data) => {
      if (data.requestId === requestId) {
        callbacks.onDone?.(data.fullText, data.usage, data.toolCalls)
        cleanup()
      }
    })

    const unsubError = ipc.on('llm:stream-error', (data) => {
      if (data.requestId === requestId) {
        callbacks.onError?.(data.error)
        cleanup()
      }
    })

    const cleanup = () => {
      unsubChunk()
      unsubDone()
      unsubError()
      const reqs = new Map(get().activeRequests)
      reqs.delete(requestId)
      set({ activeRequests: reqs })
    }

    // 标记活跃请求
    const reqs = new Map(get().activeRequests)
    reqs.set(requestId, { status: 'running', text: '' })
    set({ activeRequests: reqs })

    // 发起流式请求
    const startRes = await ipc.invoke('llm:generate-stream', requestId, {
      modelId: mid,
      messages,
      stream: true,
      responseFormat: options?.responseFormat as { type: 'json_object' | 'text' } | undefined,
      thinking: options?.thinking,
      tools: options?.tools,
    })

    // 主进程未能启动流（如模型配置不存在）：此时不会有任何 stream 事件，
    // 若不处理则上层 Promise 永久挂起。主动 cleanup 并报错。
    if (!startRes?.started) {
      cleanup()
      callbacks.onError?.('未找到模型配置或无法启动流式生成')
    }

    return requestId
  },

  cancelGeneration: async (requestId) => {
    await ipc.invoke('llm:cancel', requestId)
  },

  testConnection: async (model) => {
    return ipc.invoke('llm:test-connection', model)
  },
}))

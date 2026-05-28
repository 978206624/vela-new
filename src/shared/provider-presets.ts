/**
 * 服务商预设配置 — 共享类型定义
 *
 * **当前架构**：`BUILTIN_PRESETS` 是编译期常量，由 SettingsModal 直接 import 使用，
 * **未做持久化**（不读写 `~/.vela/provider-presets.json`）。App 升级即同步生效。
 * 历史注释曾误称"持久化在 ~/.vela/provider-presets.json"，实际未实现，本次澄清。
 */

/** 单个模型的预设 — name + 该模型的输出 token 上限 */
export interface ModelPreset {
  name: string
  maxTokens: number
}

/** 单个服务商的预设配置 */
export interface ProviderPreset {
  /** 服务商唯一标识（内置值如 openai/deepseek，用户可自定义如 my-proxy） */
  provider: string
  /** 界面显示名称，缺省时使用 provider ID */
  displayName?: string
  /** 默认 API 地址 */
  baseUrl: string
  /** 默认调用协议：openai 兼容 或 gemini 原生 */
  protocol: string
  /** 支持的生成模型列表（含各自的 maxTokens） */
  models: ModelPreset[]
  /** 支持的向量模型列表（embedding 模型不需要 maxTokens） */
  embeddingModels: string[]
}

/** 内置默认预设（SettingsModal 直接读取的编译期常量，无持久化） */
export const BUILTIN_PRESETS: ProviderPreset[] = [
  {
    provider: 'openai',
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com',
    protocol: 'openai',
    // 用户指定最新两代为预设主推；gpt-5.5 / gpt-5.4 均可在官方 API 模型文档验证。
    // 其它型号（o-系列、4o 系列、4.1 等）一律通过「拉取可用模型」动态获取或手动输入。
    models: [
      { name: 'gpt-5.5', maxTokens: 131072 },
      { name: 'gpt-5.4', maxTokens: 131072 },
    ],
    embeddingModels: ['text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-ada-002'],
  },
  {
    provider: 'deepseek',
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    protocol: 'openai',
    // V4 系列为官方现行型号；旧名 deepseek-chat / deepseek-reasoner 仍兼容，
    // 但官方公告将废弃（分别等价于 deepseek-v4-flash 非 thinking / thinking 模式），
    // 预设里不再列出，避免新建配置时选到将被弃用的型号。
    models: [
      { name: 'deepseek-v4-pro', maxTokens: 65536 },
      { name: 'deepseek-v4-flash', maxTokens: 65536 },
    ],
    embeddingModels: [],
  },
  {
    /** 智谱 BigModel — OpenAI 兼容协议，API 路径为 /v4 */
    provider: 'bigmodel',
    displayName: 'BigModel（智谱）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    protocol: 'openai',
    // 实测官方 docs.bigmodel.cn/cn/guide/start/model-overview production-ready 文本生成模型清单
    // maxTokens 按官方 Max Output 列（128K = 131072；96K = 98304；16K = 16384；4K = 4096）
    models: [
      { name: 'glm-5.1', maxTokens: 131072 },
      { name: 'glm-5', maxTokens: 131072 },
      { name: 'glm-5-turbo', maxTokens: 131072 },
      { name: 'glm-4.7', maxTokens: 131072 },
      { name: 'glm-4.7-flashx', maxTokens: 131072 },
      { name: 'glm-4.7-flash', maxTokens: 131072 },
      { name: 'glm-4.6', maxTokens: 131072 },
      { name: 'glm-4.5-airx', maxTokens: 98304 },
      { name: 'glm-4.5-air', maxTokens: 98304 },
      { name: 'glm-4.5-flash', maxTokens: 98304 },
    ],
    embeddingModels: ['embedding-3', 'embedding-2'],
  },
  {
    provider: 'gemini',
    displayName: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    protocol: 'gemini',
    // 实测 ai.google.dev/gemini-api/docs/models 文本生成模型清单（过滤 image/video/audio/embedding）
    models: [
      { name: 'gemini-3.1-pro-preview', maxTokens: 65536 },
      { name: 'gemini-3.5-flash', maxTokens: 65536 },
      { name: 'gemini-3-flash-preview', maxTokens: 65536 },
      { name: 'gemini-3.1-flash-lite', maxTokens: 65536 },
      { name: 'gemini-2.5-pro', maxTokens: 65536 },
      { name: 'gemini-2.5-flash', maxTokens: 65536 },
      { name: 'gemini-2.5-flash-lite', maxTokens: 65536 },
    ],
    embeddingModels: ['gemini-embedding-001', 'text-embedding-004'],
  },
  {
    /** Anthropic Claude — Messages API 协议（独立于 OpenAI Chat Completions） */
    provider: 'claude',
    displayName: 'Claude（Anthropic）',
    baseUrl: 'https://api.anthropic.com',
    protocol: 'anthropic',
    // 当前推荐模型（剔除 deprecated）；legacy（Opus 4.7/4.6 / Sonnet 4.5 / Opus 4.5 / Opus 4.1）通过「拉取可用模型」获取
    // maxTokens 取官方 Max Output（128K = 131072；64K = 65536）
    models: [
      { name: 'claude-opus-4-8', maxTokens: 131072 },
      { name: 'claude-sonnet-4-6', maxTokens: 65536 },
      { name: 'claude-haiku-4-5', maxTokens: 65536 },
    ],
    embeddingModels: [],
  },
  {
    provider: 'ollama',
    displayName: 'Ollama（本地）',
    baseUrl: 'http://localhost:11434',
    protocol: 'openai',
    models: [
      { name: 'llama3.3', maxTokens: 4096 },
      { name: 'llama3.2', maxTokens: 4096 },
      { name: 'qwen2.5', maxTokens: 8192 },
      { name: 'qwen2.5-coder', maxTokens: 8192 },
      { name: 'mistral', maxTokens: 4096 },
      { name: 'phi4', maxTokens: 4096 },
      { name: 'gemma3', maxTokens: 8192 },
    ],
    embeddingModels: ['nomic-embed-text', 'mxbai-embed-large', 'bge-m3'],
  },
  {
    provider: 'custom',
    displayName: '自定义',
    baseUrl: '',
    protocol: 'openai',
    models: [],
    embeddingModels: [],
  },
]

/**
 * Vela IPC 频道定义 — 渲染进程与主进程的类型安全通信契约
 * 所有 IPC 调用都通过此文件定义频道名和参数/返回值类型
 */

// ===== 全局配置 =====
export interface ConfigChannels {
  'config:get': {
    args: []
    return: GlobalConfig
  }
  'config:set': {
    args: [config: Partial<GlobalConfig>]
    return: { success: boolean; error?: string }
  }
  'config:get-vela-home': {
    args: []
    return: string
  }
}

/** LLM 调用用途：大纲/正文/审稿走生成模型，嵌入走向量模型 */
export type LLMPurpose = 'outline' | 'draft' | 'review' | 'embedding'

export interface GlobalConfig {
  theme: string
  defaultModelId: string | null
  defaultEmbeddingModelId?: string | null
  /** 按用途分配的生成模型（为空则回退 defaultModelId） */
  outlineModelId?: string | null
  draftModelId?: string | null
  reviewModelId?: string | null
  editorFontSize: number
  editorFontFamily: string
  autoSaveInterval: number
  proxy?: {
    enabled: boolean
    type: 'http' | 'socks5'
    host: string
    port: number
  }
}

// ===== 项目管理 =====
export interface ProjectChannels {
  'project:create': {
    args: [config: { name: string; path: string; genre: string; targetAudience: string }]
    return: { success: boolean; projectId: string; projectPath?: string; error?: string }
  }
  'project:open': {
    args: [projectPath: string]
    return: { success: boolean; project: ProjectData | null; error?: string; currentToken?: number }
  }
  'project:save': {
    args: [projectId: string, data: Partial<ProjectData>]
    return: { success: boolean; error?: string }
  }
  'project:update-config': {
    args: [projectId: string, data: Partial<ProjectData>]
    return: { success: boolean; error?: string }
  }
  'project:recent-list': {
    args: []
    return: Array<{ name: string; path: string; updatedAt: string }>
  }
  'project:recent-remove': {
    args: [projectPath: string]
    return: { success: boolean; error?: string }
  }
  /**
   * 同步前端"当前打开项目"到主进程。
   * 前端 openProject 成功 / closeProject 时调用，让 KB 等 IPC 知道操作的是哪个项目。
   * 传 null 表示无项目打开。
   *
   * expectedCurrent / expectedToken: stale-write guard 的双 key。两者都提供时，
   * 主进程仅在 currentProjectPath === expectedCurrent **且** currentProjectToken === expectedToken
   * 时才写入；不匹配视为 stale 跳过。仅靠 path 无法挡住"close A → reopen A"的竞态，
   * token 单调递增可以彻底排除。
   */
  'project:set-current': {
    args: [projectPath: string | null, expectedCurrent?: string | null, expectedToken?: number]
    return: { success: boolean; skipped?: boolean; token?: number }
  }
  'dialog:select-folder': {
    args: []
    return: string | null
  }
}

// ===== 文件系统 =====
export interface FileChannels {
  'fs:read-file': {
    args: [filePath: string]
    return: { success: boolean; content: string; error?: string }
  }
  'fs:write-file': {
    args: [filePath: string, content: string]
    return: { success: boolean; error?: string }
  }
  'fs:list-dir': {
    args: [dirPath: string]
    return: FileNode[]
  }
  'fs:mkdir': {
    args: [dirPath: string]
    return: { success: boolean; error?: string }
  }
  'fs:check-exists': {
    args: [filePath: string]
    return: boolean
  }
  'fs:read-json': {
    args: [filePath: string]
    return: { success: boolean; data: unknown; error?: string }
  }
  'fs:write-json': {
    args: [filePath: string, data: unknown]
    return: { success: boolean; error?: string }
  }
}

// ===== LLM 调用 =====
export interface LLMChannels {
  'llm:generate': {
    args: [request: LLMRequest]
    return: LLMResponse
  }
  'llm:generate-stream': {
    args: [requestId: string, request: LLMRequest]
    return: { requestId: string; started: boolean }
  }
  'llm:cancel': {
    args: [requestId: string]
    return: { success: boolean }
  }
  'llm:list-models': {
    args: []
    return: ModelProfile[]
  }
  'llm:save-model': {
    args: [model: ModelProfile]
    return: { success: boolean }
  }
  'llm:delete-model': {
    args: [modelId: string]
    return: { success: boolean }
  }
  'llm:set-default-model': {
    args: [modelId: string | null]
    return: { success: boolean; error?: string }
  }
  'llm:get-default-model': {
    args: []
    return: string | null
  }
  'llm:set-default-embedding-model': {
    args: [modelId: string | null]
    return: { success: boolean; error?: string }
  }
  'llm:get-default-embedding-model': {
    args: []
    return: string | null
  }
  'llm:test-connection': {
    args: [model: ModelProfile]
    return: { success: boolean; error?: string }
  }
  /**
   * 按 baseUrl+apiKey 向服务商拉取当前可用模型 ID 列表。
   * 复用 test-connection 范式：前端传 ModelProfile 草稿（可不入库），主进程按 protocol 分发到 provider.listModels。
   */
  'llm:fetch-available-models': {
    args: [model: ModelProfile]
    return: { success: boolean; models: string[]; error?: string }
  }
}

export interface LLMStreamEvents {
  'llm:stream-chunk': { requestId: string; chunk: string }
  'llm:stream-done': { requestId: string; fullText: string; usage?: TokenUsage; toolCalls?: LLMToolCall[]; thinkingBlocks?: ClaudeThinkingBlock[]; reasoningContent?: string }
  'llm:stream-error': { requestId: string; error: string }
}

// ===== 公共数据类型 =====
export interface ProjectData {
  id: string
  name: string
  path: string
  novelConfig: NovelConfig
  characterStates: string
  createdAt: string
  updatedAt: string
}

export interface NovelConfig {
  genre: string
  subGenre: string
  targetAudience: string
  totalChapters: number
  wordsPerChapter: number
  plotStructure: 'three_act' | 'heros_journey' | 'save_the_cat' | 'kishotenketsu' | 'multi_thread' | 'freeform'
  narrativePOV: 'third_limited' | 'first_person' | 'third_omniscient' | 'multi_pov'
  coreOutline: string
  worldSetting: string
  goldenFinger: string
  protagonistProfile: string
  globalGuidance: string
  writingStyle?: string
  referenceWorks?: string
}

export interface FileNode {
  name: string
  path: string
  isDir: boolean
  children?: FileNode[]
}

/** 模型原生工具调用（OpenAI 形态为统一基准；Gemini 由 provider 双向翻译） */
export interface LLMToolCall {
  /** 调用 ID（OpenAI 原生返回；Gemini 无 id，由 provider 合成以供引擎记账） */
  id: string
  /** 工具名 */
  name: string
  /** 参数（JSON 字符串；Gemini 的对象 args 由 provider stringify 归一为此形态） */
  arguments: string
  /**
   * Gemini 思考模型的 thought signature：手工维护 history 时须随原 functionCall part 原样回传，
   * 否则续轮函数调用可能失败。OpenAI 协议不使用此字段。
   */
  thoughtSignature?: string
}

/** 传给模型的原生工具定义（function calling） */
export interface LLMToolDef {
  name: string
  description: string
  /** 参数的 JSON Schema（对象类型） */
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

/**
 * Anthropic Messages API 的思考内容块（含 redacted）。
 * 当 assistant 历史里既有 tool_use 又有 thinking 时，Anthropic 要求多轮回传时
 * 原样保留这些块（含 signature 加密签名 / redacted data），否则 API 拒收。
 * Vela 仅在 ClaudeProvider 上读写本字段；OpenAIProvider / GeminiProvider 不读不写。
 */
export type ClaudeThinkingBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }

/** LLM 对话消息（统一基准格式，跨 IPC 传递；含原生 tool-calling 回合所需字段） */
export interface LLMChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** assistant 消息携带的原生工具调用（驱动 ReAct 回合） */
  tool_calls?: LLMToolCall[]
  /** tool 结果消息：对应的调用 ID（OpenAI 协议按 id 回灌） */
  tool_call_id?: string
  /** tool 结果消息：工具名（Gemini functionResponse 按名匹配） */
  name?: string
  /**
   * Anthropic 多轮回传所需的 thinking content blocks 原始序列。
   * 仅 ClaudeProvider 在 assistant 历史消息上读写；OpenAI/Gemini 忽略。
   */
  thinkingBlocks?: ClaudeThinkingBlock[]
  /**
   * DeepSeek / OpenAI 协议族思考模型返回的 reasoning_content 原文（纯字符串）。
   * DeepSeek thinking 模式下，带 tool_calls 的 assistant 历史多轮回传时必须原样带回，
   * 否则 API 400（"reasoning_content must be passed back"）。仅 OpenAIProvider 读写。
   */
  reasoningContent?: string
}

export interface LLMRequest {
  modelId: string
  messages: LLMChatMessage[]
  temperature?: number
  maxTokens?: number
  stream?: boolean
  responseFormat?: { type: 'json_object' | 'text' }
  thinking?: boolean
  /** 原生工具定义（提供则启用 function calling；不提供则纯文本生成） */
  tools?: LLMToolDef[]
}

export interface LLMResponse {
  success: boolean
  content: string
  usage?: TokenUsage
  /** 非流式生成时模型发起的原生工具调用（与 provider 接口对齐，避免契约分叉） */
  toolCalls?: LLMToolCall[]
  /** Anthropic thinking content blocks（仅 Claude 路径产出，供多轮回传保留 signature/redacted data） */
  thinkingBlocks?: ClaudeThinkingBlock[]
  /** DeepSeek/OpenAI 协议族 reasoning_content 原文（供 tool_calls 多轮回传） */
  reasoningContent?: string
  error?: string
}

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface ModelProfile {
  id: string
  name: string
  provider: 'openai' | 'gemini' | 'deepseek' | 'ollama' | 'bigmodel' | 'claude' | 'custom'
  protocol: 'openai' | 'gemini' | 'anthropic'
  modelName: string
  apiKey: string
  baseUrl: string
  temperature: number
  maxTokens: number
  purposes: Array<'generation' | 'refinement' | 'summary' | 'embedding'>
  /**
   * 思考模式策略——模型层面决定是否启用 reasoning/thinking。
   * - 'always'：所有调用强制开 thinking（如 deepseek-reasoner、o-series 等推理模型）
   * - 'optional'（默认/未设置）：跟随调用方代码的 opts.thinking（如架构推演命令写死 thinking:true）
   * - 'never'：所有调用强制关 thinking，覆盖代码层的请求（如 deepseek-chat 这种不支持/不应该开的）
   *
   * 不做成运行时 UI 开关——thinking 是模型能力而非用户偏好。
   */
  thinkingMode?: 'always' | 'optional' | 'never'
}

// ===== 引入 DB 类型 =====
import type { ProjectCoreData } from '../../electron/repositories/project-core-repository'
import type { BlueprintData } from '../../electron/repositories/blueprint-repository'
import type { CharacterData, CharacterStateData } from '../../electron/repositories/character-repository'
import type { DraftMeta, DraftFull } from '../../electron/repositories/draft-repository'
import type { RevisionMeta, RevisionFull } from '../../electron/repositories/revision-repository'
import type { ReviewMeta, ReviewFull } from '../../electron/repositories/review-repository'
import type { PostProcessRunData, PostProcessStepData } from '../../electron/repositories/post-process-repository'

// ===== 数据库操作 =====
export interface DatabaseChannels {
  'db:close': { args: []; return: { success: boolean } }

  // 1. project_core
  'db:project-core-get': { args: []; return: ProjectCoreData | null }
  'db:project-core-update': { args: [data: Partial<ProjectCoreData>]; return: { success: boolean; error?: string } }

  // 2. blueprints
  'db:blueprint-get-all': { args: []; return: BlueprintData[] }
  'db:blueprint-get': { args: [chapterNumber: number]; return: BlueprintData | null }
  'db:blueprint-upsert': { args: [data: BlueprintData]; return: { success: boolean; error?: string } }
  'db:blueprint-upsert-many': { args: [items: BlueprintData[]]; return: { success: boolean; error?: string } }
  'db:blueprint-update-notes': { args: [chapterNumber: number, notes: string]; return: { success: boolean; error?: string } }

  // 3. characters
  'db:character-get-all': { args: []; return: CharacterData[] }
  'db:character-upsert': { args: [data: CharacterData]; return: { success: boolean; error?: string } }
  'db:character-save-all': { args: [items: CharacterData[]]; return: { success: boolean; error?: string } }
  'db:character-delete': { args: [name: string]; return: { success: boolean; error?: string } }
  'db:character-update-state': { args: [name: string, state: CharacterStateData]; return: { success: boolean; error?: string } }

  // 4. drafts
  'db:draft-create': { args: [params: { chapterNumber: number; version: number; source: 'write' | 'rewrite'; content: string; wordCount: number }]; return: { success: boolean; id?: number; error?: string } }
  'db:draft-list': { args: [chapterNumber: number]; return: DraftMeta[] }
  'db:draft-get-meta': { args: [id: number]; return: DraftMeta | null }
  'db:draft-get-full': { args: [id: number]; return: DraftFull | null }
  'db:draft-get-latest': { args: [chapterNumber: number]; return: DraftMeta | null }
  'db:draft-get-finalized': { args: [chapterNumber: number]; return: DraftMeta | null }
  'db:draft-get-max-finalized-chapter': { args: []; return: number }
  'db:draft-next-version': { args: [chapterNumber: number]; return: number }
  'db:draft-update-status': { args: [id: number, status: string, wordCount?: number]; return: { success: boolean; error?: string } }
  'db:draft-finalize-exclusive': { args: [id: number, wordCount?: number]; return: { success: boolean; error?: string } }
  'db:draft-update-content': { args: [id: number, content: string, wordCount: number]; return: { success: boolean; error?: string } }
  'db:draft-delete': { args: [id: number]; return: { success: boolean; error?: string } }

  // 5. revisions
  'db:revision-create': { args: [params: { baseDraftId: number; revisionIndex: number; revisionType: 'refine' | 'review-fix'; userPrompt?: string; reviewSourceId?: number; content: string; wordCount: number }]; return: { success: boolean; id?: number; error?: string } }
  'db:revision-list': { args: [baseDraftId: number]; return: RevisionMeta[] }
  'db:revision-get-pending': { args: [baseDraftId: number]; return: RevisionMeta[] }
  'db:revision-get-full': { args: [id: number]; return: RevisionFull | null }
  'db:revision-next-index': { args: [baseDraftId: number]; return: number }
  'db:revision-mark-merged': { args: [id: number, mergedToDraftId: number]; return: { success: boolean; error?: string } }
  'db:revision-mark-discarded': { args: [id: number]; return: { success: boolean; error?: string } }

  // 6. reviews
  'db:review-create': { args: [params: { baseDraftId: number; reviewIndex: number; content: string }]; return: { success: boolean; id?: number; error?: string } }
  'db:review-list': { args: [baseDraftId: number]; return: ReviewMeta[] }
  'db:review-get-latest': { args: [baseDraftId: number]; return: ReviewFull | null }
  'db:review-get-full': { args: [id: number]; return: ReviewFull | null }
  'db:review-next-index': { args: [baseDraftId: number]; return: number }

  // 7. post_process
  'db:post-process-create-run': { args: [params: { triggerSourceType: string; triggerSourceId: string; sourceLabel: string; steps: Array<{ key: string; label: string; critical: boolean }> }]; return: { success: boolean; id?: string; error?: string } }
  'db:post-process-get-latest-run': { args: [sourceType: string, sourceId: string]; return: PostProcessRunData | null }
  'db:post-process-get-steps': { args: [runId: string]; return: PostProcessStepData[] }
  'db:post-process-mark-step-ok': { args: [runId: string, stepKey: string]; return: { success: boolean; error?: string } }
  'db:post-process-mark-step-failed': { args: [runId: string, stepKey: string, errorMsg: string]; return: { success: boolean; error?: string } }
  'db:post-process-is-all-passed': { args: [sourceType: string, sourceId: string]; return: boolean }

  // 沿用旧表
  'db:log-llm-call': { args: [call: Record<string, unknown>]; return: { success: boolean } }
  'db:get-llm-stats': { args: []; return: { totalCalls: number; totalTokens: number; totalPromptTokens: number; totalCompletionTokens: number; todayCalls: number; todayTokens: number } }
  'db:get-llm-history': { args: [limit?: number]; return: unknown[] }
  'db:save-summary-snapshot': { args: [chapterNumber: number, characterStates: string]; return: { success: boolean } }
  'db:get-latest-summary': { args: []; return: { characterStates: string; chapterNumber: number } | null }
}

// ===== 知识库频道 =====
export interface KnowledgeBaseChannels {
  'kb:import-document': { args: [filePath: string]; return: { success: boolean; docId?: string; chunkCount?: number; error?: string; embeddingFailed?: boolean; embeddingError?: string } }
  'kb:import-folder': { args: [folderPath: string]; return: { success: boolean; importedCount: number; failedFiles: string[]; error?: string; embeddingFailedCount?: number; firstEmbeddingError?: string } }
  'kb:import-text': { args: [text: string, fileName: string, projectPath: string]; return: { success: boolean; docId?: string; chunkCount?: number; error?: string; embeddingFailed?: boolean; embeddingError?: string } }
  'kb:search': { args: [query: string, topK?: number, mode?: 'semantic' | 'keyword']; return: Array<{ text: string; score: number; fileName: string }> }
  'kb:search-with-scope': { args: [query: string, fromChapter: number, toChapter: number, topK?: number]; return: Array<{ text: string; score: number; fileName: string }> }
  'kb:list-documents': { args: []; return: Array<{ id: string; fileName: string; importedAt: string; chunkCount: number; filePath: string }> }
  'kb:remove-document': { args: [docId: string]; return: { success: boolean } }
  'kb:stats': { args: []; return: { documentCount: number; totalChunks: number; vectorDimension: number; embeddingModel: string | null; expectedDimension: number | null; dimensionMismatch: boolean } }
  'dialog:select-files': { args: []; return: string[] | null }
  'dialog:select-import-folder': { args: []; return: string | null }
  'kb:get-vectorless-count': { args: []; return: { count: number } }
  'kb:rebuild-index': { args: []; return: { success: boolean; processed: number; failed: number; error?: string } }
}

// ===== 导入小说 =====
export interface ImportChannels {
  'dialog:select-novel-files': { args: []; return: string[] | null }
  'import:split-chapters': {
    args: [filePaths: string[], options?: { separator?: string }]
    return: {
      success: boolean
      chapters: Array<{ number: number; title: string; content: string; wordCount: number }>
      totalWords: number
      error?: string
    }
  }
}

// ===== MCP =====
export interface MCPChannels {
  'mcp:load-config': { args: [configPath?: string]; return: { success: boolean; configs: unknown[]; error?: string } }
  'mcp:connect': { args: [config: Record<string, unknown>]; return: { success: boolean; error?: string } }
  'mcp:disconnect': { args: [serverId: string]; return: { success: boolean; error?: string } }
  'mcp:disconnect-all': { args: []; return: { success: boolean; error?: string } }
  'mcp:list-tools': { args: []; return: unknown[] }
  'mcp:list-resources': { args: []; return: unknown[] }
  'mcp:call-tool': { args: [serverId: string, toolName: string, args: Record<string, unknown>]; return: { success: boolean; content: string; error?: string } }
  'mcp:get-servers-status': { args: []; return: unknown[] }
  'mcp:get-config-path': { args: []; return: string }
}

// ===== 窗口控制（自定义标题栏用） =====
export interface WindowChannels {
  'window:minimize': { args: []; return: void }
  'window:maximize': { args: []; return: void }
  'window:close': { args: []; return: void }
  'window:is-maximized': { args: []; return: boolean }
}

// ===== 系统级 =====
export interface SystemChannels {
  'system:reveal-in-explorer': { args: [filePath: string]; return: void }
}

// ===== 在线更新（electron-updater，主进程 invoke） =====
export interface UpdaterChannels {
  /** 检查更新；manual=true 为用户手动触发（失败才弹错），false/省略为启动静默检查。
   * 实际的「有新版/已最新」结果通过 updater:* 事件推送，此处只返回触发态。 */
  'updater:check': {
    args: [manual?: boolean]
    return: { triggered: boolean; portable?: boolean; dev?: boolean; unsupported?: boolean }
  }
  /** 开始下载已检测到的更新（autoDownload 已关闭，由用户确认后调用） */
  'updater:start-download': { args: []; return: { ok: boolean; error?: string } }
  /** 退出并安装已下载的更新 */
  'updater:quit-and-install': { args: []; return: void }
  /** 在系统浏览器打开 GitHub Releases 页（便携版手动下载用） */
  'updater:open-releases': { args: []; return: void }
}

// ===== 窗口状态事件（主进程 → 渲染进程） =====
export interface WindowEvents {
  /** 窗口最大化状态变化，payload 为是否已最大化 */
  'window:maximized-changed': boolean
}

// ===== 在线更新事件（主进程 → 渲染进程） =====
export interface UpdaterEvents {
  /** 开始检查更新 */
  'updater:checking': null
  /** 检测到新版本（携带版本号与 GitHub Release 更新日志） */
  'updater:available': { version: string; releaseNotes: string; releaseName: string; releaseDate: string }
  /** 已是最新版本 */
  'updater:not-available': { version: string }
  /** 下载进度 */
  'updater:download-progress': { percent: number; transferred: number; total: number; bytesPerSecond: number }
  /** 更新已下载完成，可重启安装 */
  'updater:downloaded': { version: string }
  /** 检查/下载出错；manual=true 表示用户手动触发（渲染层据此决定是否弹错） */
  'updater:error': { message: string; manual: boolean }
}

// ===== 合并所有频道 =====
export type AllInvokeChannels = ConfigChannels & ProjectChannels & FileChannels & LLMChannels & DatabaseChannels & KnowledgeBaseChannels & ImportChannels & MCPChannels & WindowChannels & SystemChannels & UpdaterChannels
export type AllEventChannels = LLMStreamEvents & WindowEvents & UpdaterEvents

/** 提取 invoke 频道名 */
export type InvokeChannel = keyof AllInvokeChannels

/** 提取 event 频道名 */
export type EventChannel = keyof AllEventChannels

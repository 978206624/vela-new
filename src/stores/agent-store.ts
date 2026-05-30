import { create } from 'zustand'
import { useLLMStore } from './llm-store'
import { buildAgentSystemPrompt } from '../services/agent/context-builder'
import { runAgentLoop, type ToolCallInfo, type LLMMessage, type LLMGenerateFn, type AgentLLMResult } from '../services/agent/agent-engine'
import { registerBuiltinTools } from '../services/agent/tools'
import { skillRegistry } from '../services/agent/skill-registry'
import { parseSlashCommand, parseMentions, mentionsToToolCalls } from '../services/agent/intent-router'
import { toolRegistry } from '../services/agent/tool-registry'
import type { ToolArtifact } from '../services/agent/tool-registry'
import { ipc } from '../services/ipc-client'
import { globalEventBus } from '../shared/event-bus'
import type { TokenUsage, ClaudeThinkingBlock, ConversationRecord } from '../shared/ipc-channels'
import { useProjectStore } from './project-store'

// ===== 类型定义 =====

/** 对话模式：Planning（深度推理）/ Fast（快速执行） */
export type AgentMode = 'planning' | 'fast'

/** 单条消息 */
export interface AgentMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
  /** 是否正在流式生成中 */
  streaming?: boolean
  /** Tool 调用信息（Agent 回复时） */
  toolCalls?: ToolCallInfo[]
  /** 产物列表（Agent 创建/修改的文件、触发的工作流等） */
  artifacts?: ToolArtifact[]
  /**
   * Anthropic 多轮回传所需的原始 thinking content blocks（仅 Claude assistant 消息有值）。
   * 下一轮启用 tools + thinking 时由 ClaudeProvider 重建到 content 数组前部，
   * 满足 Anthropic 多轮硬约束（必须回传含 signature 的 thinking 块）。
   */
  thinkingBlocks?: ClaudeThinkingBlock[]
  /**
   * DeepSeek/OpenAI 协议族 reasoning_content 原文（仅 DeepSeek assistant 消息有值）。
   * 下一轮 tool_calls 多轮 wire 时由 OpenAIProvider 回传，满足 DeepSeek thinking 硬约束。
   */
  reasoningContent?: string
}

/** 单个会话 */
export interface AgentConversation {
  id: string
  /** 会话标题（取自第一条用户消息前 20 个字符） */
  title: string
  messages: AgentMessage[]
  createdAt: number
  updatedAt: number
  /** 当前会话使用的模式 */
  mode: AgentMode
  /** 当前会话使用的模型 ID（null 表示使用默认） */
  modelId: string | null
  /**
   * messages 是否已从库加载。
   * 列表懒加载（listMeta）只填 meta，messages=[] 且 messagesLoaded=false（空壳）；
   * selectConversation 拉取后置 true。新建会话天然已加载（true）。
   * 防御点：sendMessage 对 messagesLoaded===false 的活跃会话先 get(id) 加载，
   * 避免空壳被新消息 upsert 覆盖库内旧 messages。
   */
  messagesLoaded: boolean
  /** message 数量缓存（懒加载下用于 UI 空状态判定/计数，不依赖 messages.length） */
  messageCount: number
}

// ===== Store 状态接口 =====

interface AgentState {
  /** 所有会话列表（最新的排在前面） */
  conversations: AgentConversation[]
  /** 当前活跃会话 ID */
  activeConversationId: string | null
  /** 是否显示历史面板 */
  showHistory: boolean
  /** 全局默认模式 */
  defaultMode: AgentMode
  /** 当前是否正在生成（用于 UI 状态） */
  generating: boolean
  /** 当前流式请求 ID（用于取消） */
  activeRequestId: string | null
  /** Tool 系统是否已初始化 */
  toolsInitialized: boolean

  // ===== 计算属性（Getters） =====
  /** 获取当前活跃会话 */
  getActiveConversation: () => AgentConversation | null

  // ===== Actions =====
  /** 初始化 Tool 系统 */
  initializeTools: () => void
  /** 新建会话并激活 */
  createConversation: () => AgentConversation
  /** 激活指定会话（异步：懒加载 messages 后原子更新，含竞态保护） */
  selectConversation: (id: string) => Promise<void>
  /** 删除指定会话 */
  deleteConversation: (id: string) => void
  /** 清空所有会话 */
  clearAll: () => void
  /**
   * 确保指定会话的 messages 已从库加载（懒加载空壳防御的统一入口）。
   * 返回是否可安全继续操作该会话：
   * - 已加载 / 加载成功 / 确属空会话 → true
   * - 本应有历史（messageCount>0）却 get 返回 null 或抛错 → false（调用方必须中止，绝不覆盖库内历史）
   */
  ensureConversationLoaded: (id: string) => Promise<boolean>
  /** 从当前项目库加载会话列表（仅 meta，懒加载）——项目打开时调用 */
  loadConversations: () => Promise<void>
  /** 仅清空内存中的会话（不删库）——项目关闭时调用，防跨项目串台 */
  resetConversations: () => void
  /** 切换历史面板 */
  toggleHistory: () => void
  /** 设置历史面板可见性 */
  setShowHistory: (show: boolean) => void
  /** 设置当前会话模式 */
  setMode: (mode: AgentMode) => void
  /** 设置当前会话使用的模型 */
  setModelId: (modelId: string | null) => void
  /** 发送消息（触发 Agent ReAct 循环） */
  sendMessage: (content: string) => Promise<void>
  /**
   * 取消当前生成（public 无参包装：入口即时捕获 current token 后委托内部带 token 版）。
   * 保持无参签名以兼容 AgentInputBox / 现有调用点，勿改成必填参数。
   */
  cancelGeneration: () => Promise<void>
  /**
   * 取消当前生成（内部实现，接收显式 token）。
   * 项目关闭收尾时由 project-service 用 closingToken 调用，保证收尾落库写进源项目库。
   */
  cancelGenerationWithToken: (expectedToken?: number) => Promise<void>
  /** 响应 Tool 确认（用于 ConfirmCard） */
  resolveToolConfirmation: (toolCallId: string, confirmed: boolean) => void
}

// ===== 工具函数 =====

/** 生成唯一 ID */
const genId = () => crypto.randomUUID()

/** 从消息内容生成会话标题 */
const generateTitle = (content: string): string => {
  const cleaned = content.replace(/\s+/g, ' ').trim()
  return cleaned.length > 24 ? cleaned.slice(0, 24) + '…' : cleaned
}

/** 生成 /help 命令的帮助文本 */
const generateHelpText = (): string => {
  const toolCount = toolRegistry.listAll().length
  const skillCount = skillRegistry.listAll().length
  const lines: string[] = [
    '## Vela AI 助手 — 帮助',
    '',
    '### 可用命令',
    '- `/clear` — 清空当前对话',
    '- `/new` — 开始新对话',
    '- `/help` — 显示此帮助信息',
    '- `/status` — 查看项目状态',
    '',
    '### @ 提及',
    '输入 `@` 可引用项目上下文：故事架构、角色卡、蓝图、知识库等。',
    '',
    '### 可用工具',
    '当前已加载 **' + toolCount + '** 个工具、**' + skillCount + '** 个 Skill。',
    '',
    '### Skill 命令',
  ]
  for (const s of skillRegistry.listAll()) {
    lines.push('- `/' + s.metadata.name + '` — ' + s.metadata.description)
  }
  lines.push('', '有任何创作问题，直接问我即可！')
  return lines.join('\n')
}

// ===== Tool 确认回调管理 =====
/** 存储待确认的 Tool 回调 */
const pendingConfirmations = new Map<string, {
  resolve: (confirmed: boolean) => void
}>()

/** 当前活跃的 AbortController（用于取消 ReAct 循环） */
let activeAbortController: AbortController | null = null

/** 当前在途流式请求 ID（每轮 LLM 调用一个，用于真正中断 in-flight 流） */
let activeStreamRequestId: string | null = null

/**
 * selectConversation 单调递增序号：快速连点不同历史会话时，
 * 仅最后一次选择的异步结果允许落状态，丢弃先发起但后返回的旧选择（防串内容）。
 */
let selectSeq = 0

/** 判定取消类错误（用户主动中止），不计入调用统计 */
const isCancellation = (msg: string): boolean => msg.includes('已取消') || msg.includes('取消')

/**
 * 写入一条 Agent LLM 调用记录到 llm_calls（供底部「模型调用」面板展示）。
 * 优先用模型返回的 usage；缺失时按「中文 ~1.5 字符/token」兜底估算。失败静默吞掉。
 * 参照 base-command.logLLMCall 的统计口径，purpose 固定为「对话」。
 */
function logAgentLLMCall(p: {
  modelId: string
  modelName: string
  usage?: TokenUsage
  /** 输入侧字符数（system + 历史 + 工具结果），用于 usage 缺失时兜底估算 */
  inputChars: number
  output: string
  durationMs: number
  success: boolean
  errorMessage?: string
}): void {
  const promptTokens = p.usage?.promptTokens ?? Math.ceil(p.inputChars / 1.5)
  const completionTokens = p.usage?.completionTokens ?? Math.ceil(p.output.length / 1.5)
  const totalTokens = p.usage?.totalTokens ?? (promptTokens + completionTokens)
  ipc.invoke('db:log-llm-call', {
    modelId: p.modelId,
    modelName: p.modelName,
    purpose: '对话',
    promptTokens,
    completionTokens,
    totalTokens,
    durationMs: p.durationMs,
    success: p.success,
    errorMessage: p.errorMessage ?? '',
  })
    .then(() => globalEventBus.emit('LLM_CALL_LOGGED', { success: p.success }))
    .catch(() => { /* 统计写入失败不影响主流程 */ })
}

// ===== 持久化辅助 =====

/**
 * 读取「当前项目 token」。token 用作主进程 stale-write guard：
 * 调用方必须在「动作产生时」捕获并显式传递，绝不能在异步写 IPC 时现读 live token
 * （否则 A 的延迟回调会带上已切到 B 的 token 通过校验、把 A 的对话写进 B 库）。
 */
const getProjectToken = (): number | undefined =>
  useProjectStore.getState().currentToken ?? undefined

/** 把内存会话映射为持久化记录（messages 作为不透明数组直接序列化） */
const toRecord = (conv: AgentConversation): ConversationRecord => ({
  id: conv.id,
  title: conv.title,
  messages: conv.messages,
  mode: conv.mode,
  modelId: conv.modelId,
  messageCount: conv.messages.length,
  createdAt: conv.createdAt,
  updatedAt: conv.updatedAt,
})

/**
 * 落库单个会话（消息边界调用，禁止逐字流式调用），返回写入完成的 Promise。
 * - 空会话（无消息）跳过：避免满库空壳
 * - expectedToken 由调用方在动作产生时捕获并显式传入
 * - 写失败静默吞掉，不影响主流程
 */
const persistConversationAsync = (conv: AgentConversation | undefined, expectedToken?: number): Promise<void> => {
  if (!conv || conv.messages.length === 0) return Promise.resolve()
  return ipc.invoke('db:conversation-upsert', toRecord(conv), expectedToken)
    .then(() => { /* ok */ })
    .catch(() => { /* 持久化失败不影响主流程 */ })
}

/** 落库单个会话（fire-and-forget 版，普通消息边界用） */
const persistConversation = (conv: AgentConversation | undefined, expectedToken?: number): void => {
  void persistConversationAsync(conv, expectedToken)
}

/**
 * 重开后清洗「僵尸态」：应用关闭时未收尾的流式消息 / 卡在确认或运行中的工具调用。
 * 切回历史会话续聊不应再触发死按钮或永远「生成中」。
 */
const cleanseZombieState = (messages: AgentMessage[]): AgentMessage[] =>
  messages.map(m => {
    let next = m
    if (m.streaming) {
      next = { ...next, streaming: false, content: (next.content || '') + '\n\n_(应用已关闭，生成中断)_' }
    }
    if (m.toolCalls?.some(tc => tc.status === 'waiting_confirm' || tc.status === 'running')) {
      next = {
        ...next,
        toolCalls: next.toolCalls!.map(tc =>
          tc.status === 'waiting_confirm' || tc.status === 'running'
            ? { ...tc, status: 'failed' as const, error: '操作已因应用重启而失效' }
            : tc
        ),
      }
    }
    return next
  })

// ===== Zustand Store =====

export const useAgentStore = create<AgentState>()((set, get) => ({
  conversations: [],
  activeConversationId: null,
  showHistory: false,
  defaultMode: 'planning',
  generating: false,
  activeRequestId: null,
  toolsInitialized: false,

  getActiveConversation: () => {
    const { conversations, activeConversationId } = get()
    return conversations.find(c => c.id === activeConversationId) ?? null
  },

  initializeTools: () => {
    if (get().toolsInitialized) return
    registerBuiltinTools()
    // 加载 Skill（内置 + 用户 + 项目级）
    skillRegistry.loadAll().catch(e => console.warn('[Agent] Skill 加载失败:', e))
    set({ toolsInitialized: true })
  },

  createConversation: () => {
    // 确保 Tool 已初始化
    get().initializeTools()

    // 作废在途 selectConversation：新建会立刻激活新会话，旧 select 晚返回不得把 active 改回去
    ++selectSeq

    const llmStore = useLLMStore.getState()
    const newConv: AgentConversation = {
      id: genId(),
      title: '新对话',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mode: get().defaultMode,
      modelId: llmStore.defaultModelId,
      messagesLoaded: true,   // 新建会话内存即真相，无需懒加载
      messageCount: 0,
    }
    set(state => ({
      conversations: [newConv, ...state.conversations],
      activeConversationId: newConv.id,
      showHistory: false,
    }))
    return newConv
  },

  selectConversation: async (id) => {
    // 入口第一行就递增 seq，让本次选择成为「最新选择」——无论走已加载快路径还是异步慢路径，
    // 都作废先前在途的旧选择（否则先点未加载 A、再点已加载 B，A 的 get 返回会把 active 改回 A → Codex BLOCKER）。
    const seq = ++selectSeq
    const conv = get().conversations.find(c => c.id === id)
    // 已加载（新建会话或之前已拉取）→ 直接激活，无需查库
    if (conv?.messagesLoaded) {
      set({ activeConversationId: id, showHistory: false })
      return
    }

    // 懒加载空壳：先 await 拉 messages，再「单次原子 set」同时落 activeConversationId + messages，
    // 绝不先激活空壳（否则加载返回前用户发消息，旧 DB 结果会覆盖新消息）。
    try {
      const record = await ipc.invoke('db:conversation-get', id)
      // 竞态保护：期间又发起了新的选择 → 丢弃本次结果（防快速连点串内容）
      if (seq !== selectSeq) return
      if (!record) {
        // 与 ensureConversationLoaded 口径一致：本应有历史却读不到 → 不激活空壳，保留可重试；
        // 仅确属空会话（messageCount===0）才标记已加载并激活。
        if ((conv?.messageCount ?? 0) > 0) {
          console.warn('[Agent] 选择会话失败：库内读不到历史，保留可重试')
          return
        }
        set(state => ({
          activeConversationId: id,
          showHistory: false,
          conversations: state.conversations.map(c =>
            c.id === id && !c.messagesLoaded ? { ...c, messagesLoaded: true } : c
          ),
        }))
        return
      }
      const messages = cleanseZombieState(record.messages as AgentMessage[])
      set(state => ({
        activeConversationId: id,
        showHistory: false,
        conversations: state.conversations.map(c => {
          if (c.id !== id) return c
          // 非覆盖：若期间已被 sendMessage/ensure 加载并追加新消息，不用旧 DB 结果覆盖
          if (c.messagesLoaded) return c
          return { ...c, messages, messagesLoaded: true, messageCount: messages.length }
        }),
      }))
    } catch (e) {
      if (seq !== selectSeq) return
      // 加载失败不激活空壳（避免显示空内容），保留可重试
      console.warn('[Agent] 加载会话失败:', e)
    }
  },

  ensureConversationLoaded: async (id) => {
    const conv = get().conversations.find(c => c.id === id)
    if (!conv) return false
    if (conv.messagesLoaded) return true
    try {
      const record = await ipc.invoke('db:conversation-get', id)
      if (record) {
        const messages = cleanseZombieState(record.messages as AgentMessage[])
        set(state => ({
          conversations: state.conversations.map(c =>
            c.id === id && !c.messagesLoaded   // 非覆盖：已被并发加载则不重置
              ? { ...c, messages, messagesLoaded: true, messageCount: messages.length }
              : c
          ),
        }))
        return true
      }
      // get 返回 null：本应有历史却读不到 → 中止（绝不按空会话覆盖库内历史）
      if (conv.messageCount > 0) return false
      set(state => ({
        conversations: state.conversations.map(c =>
          c.id === id ? { ...c, messagesLoaded: true } : c
        ),
      }))
      return true
    } catch (e) {
      console.warn('[Agent] 加载会话失败:', e)
      if (conv.messageCount > 0) return false
      set(state => ({
        conversations: state.conversations.map(c =>
          c.id === id ? { ...c, messagesLoaded: true } : c
        ),
      }))
      return true
    }
  },

  deleteConversation: (id) => {
    // 作废在途 select：删除会改 activeConversationId，旧 select 晚返回不得指向已删/过期 id
    ++selectSeq
    set(state => {
      const filtered = state.conversations.filter(c => c.id !== id)
      // 如果删除的是当前会话，激活下一条或 null
      const nextId = state.activeConversationId === id
        ? (filtered[0]?.id ?? null)
        : state.activeConversationId
      return { conversations: filtered, activeConversationId: nextId }
    })
    // 同步删库（token 在动作入口捕获）
    ipc.invoke('db:conversation-delete', id, getProjectToken()).catch(() => { /* 删库失败不影响内存状态 */ })
  },

  clearAll: () => {
    // 作废在途 select：清空后旧 select 晚返回不得把 active 指向已清掉的会话
    ++selectSeq
    set({ conversations: [], activeConversationId: null })
    ipc.invoke('db:conversation-clear', getProjectToken()).catch(() => { /* 清库失败不影响内存状态 */ })
  },

  loadConversations: async () => {
    // 作废任何在途的 selectConversation（切项目时旧项目的 get 可能晚返回，不得落到新列表）
    ++selectSeq
    try {
      const metas = await ipc.invoke('db:conversation-list-meta')
      // meta 空壳：messages 未加载，messagesLoaded=false；点开某会话时再 get(id)
      const conversations: AgentConversation[] = metas.map(m => ({
        id: m.id,
        title: m.title,
        messages: [],
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        mode: (m.mode as AgentMode) ?? 'planning',
        modelId: m.modelId,
        messagesLoaded: false,
        messageCount: m.messageCount,
      }))
      // active=null：不指向空壳（避免 sendMessage 误判首条消息覆盖库内 messages）
      set({ conversations, activeConversationId: null })
    } catch (e) {
      console.warn('[Agent] 加载会话列表失败:', e)
      set({ conversations: [], activeConversationId: null })
    }
  },

  resetConversations: () => {
    // 作废在途 selectConversation，防旧项目的 get 晚返回污染已清空的状态
    ++selectSeq
    // 仅清内存，不删库（项目关闭时调用，防上个项目对话串到下个项目）
    set({ conversations: [], activeConversationId: null, showHistory: false })
  },

  toggleHistory: () => {
    set(state => ({ showHistory: !state.showHistory }))
  },

  setShowHistory: (show) => {
    set({ showHistory: show })
  },

  setMode: (mode) => {
    const conv = get().getActiveConversation()
    if (!conv) {
      set({ defaultMode: mode })
      return
    }
    const token = getProjectToken()   // 动作入口捕获 token
    set(state => ({
      defaultMode: mode,
      conversations: state.conversations.map(c =>
        c.id === conv.id ? { ...c, mode, updatedAt: Date.now() } : c
      ),
    }))
    persistConversation(get().conversations.find(c => c.id === conv.id), token)
  },

  setModelId: (modelId) => {
    const conv = get().getActiveConversation()
    if (!conv) return
    const token = getProjectToken()   // 动作入口捕获 token
    set(state => ({
      conversations: state.conversations.map(c =>
        c.id === conv.id ? { ...c, modelId, updatedAt: Date.now() } : c
      ),
    }))
    persistConversation(get().conversations.find(c => c.id === conv.id), token)
  },

  sendMessage: async (content) => {
    if (!content.trim() || get().generating) return

    // 确保 Tool 已初始化
    get().initializeTools()

    // ===== P0-4: / 命令拦截 =====
    const trimmedContent = content.trim()
    if (trimmedContent.startsWith('/')) {
      const { command, args } = parseSlashCommand(trimmedContent)
      if (command) {
        switch (command.name) {
          case 'clear': {
            const activeConv = get().getActiveConversation()
            if (activeConv) {
              // 已持久化会话（曾有消息）被清空 → 删库记录，否则重开会「死灰复燃」；
              // 新建未发消息的空壳会话本就没落库，跳过即可。
              const wasPersisted = activeConv.messages.length > 0 || activeConv.messageCount > 0
              const token = getProjectToken()
              set(state => ({
                conversations: state.conversations.map(c =>
                  c.id === activeConv.id ? { ...c, messages: [], messageCount: 0 } : c
                ),
              }))
              if (wasPersisted) {
                ipc.invoke('db:conversation-delete', activeConv.id, token).catch(() => { /* 删库失败不影响内存 */ })
              }
            }
            return
          }
          case 'new':
            get().createConversation()
            return
          case 'help': {
            // 构造帮助信息作为系统消息
            const helpConv = get().getActiveConversation() ?? get().createConversation()
            // 空壳防御：若 active 是懒加载 meta 空壳，必须先拉回库内历史再追加，
            // 否则会把库内历史覆盖成只剩 help 一条（Codex BLOCKER 3）。加载失败则中止。
            const helpOk = await get().ensureConversationLoaded(helpConv.id)
            if (!helpOk) {
              console.error('[Agent] /help 中止：会话历史加载失败，避免覆盖库内历史')
              return
            }
            const token = getProjectToken()
            const helpMsg: AgentMessage = {
              id: genId(), role: 'assistant', content: generateHelpText(), createdAt: Date.now(),
            }
            set(state => ({
              conversations: state.conversations.map(c =>
                c.id === helpConv.id ? { ...c, messages: [...c.messages, helpMsg], messageCount: c.messages.length + 1, updatedAt: Date.now() } : c
              ),
            }))
            persistConversation(get().conversations.find(c => c.id === helpConv.id), token)
            return
          }
          case 'status': {
            // /status → 直接将 read_project_state 的结果展示
            // 不拦截，作为普通消息让 Agent 处理（它会调用 read_project_state）
            break
          }
          default:
            // Skill 命令：把 Skill 内容注入到用户消息中
            if (command.source === 'skill' && command.skill) {
              let skillContent = command.skill.content
              if (args) {
                skillContent = skillContent.replace(/\$\{args\}/g, args).replace(/\$1/g, args)
              }
              // 改写 content：用户意图 + Skill 指令拼接
              content = `[用户使用了 Skill: ${command.skill.metadata.displayName ?? command.name}]\n\n用户输入: ${args || '(无额外参数)'}\n\n---\n\n${skillContent}`
            }
            break
        }
      }
    }

    // 确保有活跃会话（无则创建）
    let conv = get().getActiveConversation()
    if (!conv) {
      conv = get().createConversation()
    }
    const convId = conv.id

    // 动作起始即捕获源项目 token：本轮所有落库都用它，绝不在异步回调里现读 live token
    const convToken = getProjectToken()

    // 空壳防御：活跃会话若是懒加载未拉取的空壳（messagesLoaded=false），
    // 先把库内 messages 拉回来，否则下面按 messages.length===0 误判为首条消息，
    // 新消息 upsert 会覆盖库内旧 messages（丢历史）。
    // 加载失败且本应有历史（messageCount>0）→ 中止发送，绝不覆盖（Codex MAJOR）。
    if (!conv.messagesLoaded) {
      const loadedOk = await get().ensureConversationLoaded(convId)
      if (!loadedOk) {
        console.error('[Agent] 中止发送：会话历史加载失败，避免覆盖库内历史')
        return
      }
      conv = get().conversations.find(c => c.id === convId)!
    }

    // 构建用户消息
    const userMsg: AgentMessage = {
      id: genId(),
      role: 'user',
      content: content.trim(),
      createdAt: Date.now(),
    }

    // 构建占位助手消息（ReAct 循环中实时更新）
    const assistantMsg: AgentMessage = {
      id: genId(),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      streaming: true,
      toolCalls: [],
      artifacts: [],
    }

    // 更新会话标题（取第一条用户消息）
    const isFirstMsg = conv.messages.length === 0
    const newTitle = isFirstMsg ? generateTitle(content) : conv.title

    // 把用户消息 + 空助手消息写入会话
    set(state => ({
      generating: true,
      conversations: state.conversations.map(c =>
        c.id === convId
          ? {
              ...c,
              title: newTitle,
              messages: [...c.messages, userMsg, assistantMsg],
              messageCount: c.messages.length + 2,
              updatedAt: Date.now(),
            }
          : c
      ),
    }))

    // 用户消息 + 标题落库（消息边界）：即便后续生成因崩溃中断，用户的提问也已持久化。
    // 流式占位助手消息此刻 streaming=true，若崩溃重开由 cleanseZombieState 收尾。
    persistConversation(get().conversations.find(c => c.id === convId), convToken)

    // 辅助函数：更新助手消息
    const updateAssistantMsg = (updater: (msg: AgentMessage) => AgentMessage) => {
      set(state => ({
        conversations: state.conversations.map(c =>
          c.id === convId
            ? {
                ...c,
                messages: c.messages.map(m =>
                  m.id === assistantMsg.id ? updater(m) : m
                ),
              }
            : c
        ),
      }))
    }

    try {
      const llmStore = useLLMStore.getState()
      const currentConv = get().conversations.find(c => c.id === convId)!
      const modelId = currentConv.modelId ?? llmStore.defaultModelId ?? undefined

      if (!modelId) {
        updateAssistantMsg(m => ({
          ...m, content: '⚠️ 请先在设置中配置 AI 模型。', streaming: false,
        }))
        set({ generating: false })
        persistConversation(get().conversations.find(c => c.id === convId), convToken)
        return
      }

      // 构建系统提示词（包含项目上下文 + Tool 列表）
      const systemPrompt = buildAgentSystemPrompt(currentConv.mode)

      // ===== P1-5: @ 提及预取 =====
      let enrichedUserMessage = content.trim()
      const mentions = parseMentions(enrichedUserMessage)
      if (mentions.length > 0) {
        const prefetchCalls = mentionsToToolCalls(mentions)
        const prefetchResults: string[] = []
        for (const call of prefetchCalls) {
          const tool = toolRegistry.get(call.toolName)
          if (tool) {
            try {
              const result = await tool.execute(call.args)
              if (result.success && result.content) {
                prefetchResults.push(`[预加载上下文 @${call.toolName}]\n${result.content}`)
              }
            } catch {
              // 预取失败不阻塞主流程
            }
          }
        }
        if (prefetchResults.length > 0) {
          enrichedUserMessage = `${enrichedUserMessage}\n\n---\n以下是用户 @ 引用的上下文数据（已自动获取）：\n\n${prefetchResults.join('\n\n---\n\n')}`
        }
      }

      // 构造历史消息（取最近 16 条非流式消息）
      // 保留 thinkingBlocks 字段：Claude 多轮回传 tools+thinking 时必须把 assistant 之前的
      // thinking blocks 原样回传（含 signature）；其它 provider 路径上忽略此字段。
      const historyMessages: LLMMessage[] = currentConv.messages
        .filter(m => !m.streaming && m.role !== 'system')
        .slice(-16)
        .map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
          ...(m.thinkingBlocks ? { thinkingBlocks: m.thinkingBlocks } : {}),
          ...(m.reasoningContent ? { reasoningContent: m.reasoningContent } : {}),
        }))

      // 模型显示名（写 llm_calls 统计用）
      const modelName = llmStore.models.find(m => m.id === modelId)?.name || modelId

      // AbortController 用于取消（P1-7: 提升到模块级变量以便 cancelGeneration 访问）
      const abortController = new AbortController()
      activeAbortController = abortController
      set({ activeRequestId: assistantMsg.id })

      // LLM 真流式生成函数：文本逐字回调 onTextChunk，返回组装后的原生 tool_calls + usage，
      // 并按轮写入 llm_calls（消费 stream-done 的 usage，缺失则兜底估算）
      const generateFn: LLMGenerateFn = (msgs, mid, tools, onTextChunk) => {
        return new Promise<AgentLLMResult>((resolve, reject) => {
          const startTime = Date.now()
          const inputChars = msgs.reduce((s, m) => s + (m.content?.length ?? 0), 0)
          let acc = ''
          llmStore.generateStream(
            msgs,
            {
              onChunk: (chunk) => { acc += chunk; onTextChunk(chunk) },
              onDone: (fullText, usage, toolCalls, thinkingBlocks, reasoningContent) => {
                activeStreamRequestId = null
                logAgentLLMCall({
                  modelId: mid, modelName, usage, inputChars,
                  output: fullText || acc, durationMs: Date.now() - startTime, success: true,
                })
                // thinkingBlocks 仅 Claude 路径、reasoningContent 仅 DeepSeek 路径产出；其它为 undefined
                resolve({ text: fullText, toolCalls: toolCalls ?? [], usage, thinkingBlocks, reasoningContent })
              },
              onError: (err) => {
                activeStreamRequestId = null
                if (!isCancellation(err)) {
                  logAgentLLMCall({
                    modelId: mid, modelName, usage: undefined, inputChars,
                    output: acc, durationMs: Date.now() - startTime, success: false, errorMessage: err,
                  })
                }
                reject(new Error(err))
              },
            },
            mid,
            { tools },
          ).then((reqId) => {
            activeStreamRequestId = reqId
            // 若在 reqId 返回前用户已取消，立即中断这条在途流
            if (abortController.signal.aborted) {
              llmStore.cancelGeneration(reqId).catch(() => {})
            }
          }).catch(reject)
        })
      }

      // 启动 ReAct 循环（使用预取增强后的用户消息）
      await runAgentLoop(
        systemPrompt,
        historyMessages,
        enrichedUserMessage,
        modelId,
        generateFn,
        {
          onTextChunk: (chunk) => {
            // 原生 tool-calling 下文本流不含 XML 标签，直接实时追加（逐字效果）
            if (!chunk) return
            updateAssistantMsg(m => ({
              ...m,
              content: m.content + chunk,
            }))
          },
          onToolCallStart: (toolCall) => {
            // 按 id upsert：确认型工具会先 waiting_confirm 再 running，两次 start 同一 id
            // 必须就地更新而非重复 append，否则 UI 出现两个相同工具块
            updateAssistantMsg(m => {
              const existing = m.toolCalls ?? []
              const idx = existing.findIndex(tc => tc.id === toolCall.id)
              const next = idx >= 0
                ? existing.map(tc => (tc.id === toolCall.id ? toolCall : tc))
                : [...existing, toolCall]
              return { ...m, toolCalls: next }
            })
          },
          onToolCallComplete: (toolCall) => {
            updateAssistantMsg(m => ({
              ...m,
              toolCalls: (m.toolCalls ?? []).map(tc =>
                tc.id === toolCall.id ? toolCall : tc
              ),
            }))
          },
          onToolCallConfirmRequired: (toolCall) => {
            // 更新 UI 显示确认状态
            updateAssistantMsg(m => ({
              ...m,
              toolCalls: (m.toolCalls ?? []).map(tc =>
                tc.id === toolCall.id ? { ...tc, status: 'waiting_confirm' as const } : tc
              ),
            }))
            // 工具确认是一个消息边界（等待用户、可能长时间挂起）→ 落库当前累积进度
            persistConversation(get().conversations.find(c => c.id === convId), convToken)

            // 返回 Promise，等待用户通过 resolveToolConfirmation 响应
            return new Promise<boolean>((resolve) => {
              pendingConfirmations.set(toolCall.id, { resolve })
            })
          },
          onDone: (fullText, toolCalls, artifacts) => {
            // 原生 tool-calling 下无需 XML 清洗，直接落最终文本
            updateAssistantMsg(m => ({
              ...m,
              content: fullText.trim(),
              streaming: false,
              toolCalls,
              artifacts: artifacts.length > 0 ? artifacts : undefined,
            }))
            set(state => ({
              generating: false,
              activeRequestId: null,
              conversations: state.conversations.map(c =>
                c.id === convId
                  ? { ...c, updatedAt: Date.now(), messageCount: c.messages.length }
                  : c
              ),
            }))
            // 助手消息定稿 → 落库（消息边界，含 thinkingBlocks 原样保真供多轮回传）
            persistConversation(get().conversations.find(c => c.id === convId), convToken)
          },
          onError: (error) => {
            updateAssistantMsg(m => ({
              ...m,
              content: `❌ 生成失败：${error}`,
              streaming: false,
            }))
            set({ generating: false, activeRequestId: null })
            persistConversation(get().conversations.find(c => c.id === convId), convToken)
          },
        },
        abortController.signal,
      )
    } catch (error) {
      updateAssistantMsg(m => ({
        ...m,
        content: `❌ 发生异常：${String(error)}`,
        streaming: false,
      }))
      set({ generating: false, activeRequestId: null })
      persistConversation(get().conversations.find(c => c.id === convId), convToken)
    }
  },

  cancelGeneration: async () => {
    // public 无参包装：入口即时捕获 current token，委托内部带 token 版
    await get().cancelGenerationWithToken(getProjectToken())
  },

  cancelGenerationWithToken: async (expectedToken) => {
    // P1-7: 触发 AbortSignal，使 ReAct 循环在轮次边界停止
    if (activeAbortController) {
      activeAbortController.abort()
      activeAbortController = null
    }

    // 中断当前在途的流式请求（按真实 stream requestId，而非消息 id）
    if (activeStreamRequestId) {
      await useLLMStore.getState().cancelGeneration(activeStreamRequestId)
      activeStreamRequestId = null
    }

    // P1-8: 清理所有等待确认的 Promise，防止内存泄漏
    for (const [, pending] of pendingConfirmations) {
      pending.resolve(false) // 取消时默认拒绝
    }
    pendingConfirmations.clear()

    // 记录被中断的活跃会话，便于收尾后落库
    const activeId = get().activeConversationId

    // 找到正在 streaming 的消息，关闭其状态
    set(state => ({
      generating: false,
      activeRequestId: null,
      conversations: state.conversations.map(c => ({
        ...c,
        messages: c.messages.map(m =>
          m.streaming ? { ...m, streaming: false, content: m.content + '\n\n_（已停止生成）_' } : m
        ),
      })),
    }))

    // 取消收尾也是消息边界 → 用显式 token 落库（项目关闭时为 closingToken，写进源项目库）。
    // await 写完再返回：项目关闭路径靠此保证收尾在「主进程切库」前落地，不被 token guard 误丢。
    if (activeId) {
      await persistConversationAsync(get().conversations.find(c => c.id === activeId), expectedToken)
    }
  },

  resolveToolConfirmation: (toolCallId, confirmed) => {
    const pending = pendingConfirmations.get(toolCallId)
    if (pending) {
      pending.resolve(confirmed)
      pendingConfirmations.delete(toolCallId)
    }
  },
}))

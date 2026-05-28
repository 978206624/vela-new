import { useState, useEffect, useRef } from 'react'
import {
  X, Plus, Trash2, Check, Save, Globe, Cpu, Database,
  Type, Settings2, Zap, Eye, EyeOff, ChevronDown, MessageSquare,
  Info,
} from 'lucide-react'
import PromptSettings from './PromptSettings'
import { useLLMStore } from '../../stores/llm-store'
import { useThemeStore, FONT_OPTIONS, type FontId } from '../../stores/theme-store'
import type { ModelProfile } from '../../shared/ipc-channels'
import type { ProviderPreset } from '../../shared/provider-presets'
import { BUILTIN_PRESETS } from '../../shared/provider-presets'
import { randomUUID } from '../../utils/id'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Label } from '../ui/Label'
import { Select } from '../ui/Select'
import { cn } from '../../lib/utils'
import { ipc } from '../../services/ipc-client'
import { Switch } from '../ui/Switch'

/** 模型按用途分配下拉的「默认」哨兵（Radix Select 不接受空字符串 value） */
const MODEL_PURPOSE_DEFAULT = '__default__'

// ==================== 分类定义 ====================

type SettingsSection = 'llm' | 'embedding' | 'proxy' | 'editor' | 'prompts' | 'about'

interface SectionItem {
  id: SettingsSection
  label: string
  icon: React.ReactNode
  description: string
}

const SECTIONS: SectionItem[] = [
  { id: 'llm', label: 'AI 生成模型', icon: <Cpu size={16} />, description: '配置用于文章生成、改写、摘要的语言模型' },
  { id: 'embedding', label: '向量模型', icon: <Database size={16} />, description: '配置用于知识库检索的 Embedding 模型' },
  { id: 'proxy', label: '网络代理', icon: <Globe size={16} />, description: '配置 HTTP / SOCKS5 代理，用于访问受限 API' },
  { id: 'editor', label: '编辑器', icon: <Type size={16} />, description: '字体大小、自动保存等编辑器偏好设置' },
  { id: 'prompts', label: '提示词模板', icon: <MessageSquare size={16} />, description: '自定义 AI 创作各环节使用的提示词模板' },
  { id: 'about', label: '关于', icon: <Info size={16} />, description: '版本、上游归属与开源协议' },
]

// ==================== 主组件 ====================

interface SettingsModalProps {
  open: boolean
  onClose: () => void
}

/** 全屏设置弹窗 */
export default function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [section, setSection] = useState<SettingsSection>('llm')

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="relative flex w-[880px] h-[600px] rounded-2xl overflow-hidden shadow-2xl"
        style={{
          backgroundColor: 'var(--color-editor-bg)',
          border: '1px solid var(--color-border)',
        }}
      >
        {/* 左侧导航 */}
        <aside
          className="flex flex-col w-52 flex-shrink-0 py-5 gap-1"
          style={{
            backgroundColor: 'var(--color-sidebar)',
            borderRight: '1px solid var(--color-border)',
          }}
        >
          {/* 标题 */}
          <div className="flex items-center gap-2 px-4 mb-4">
            <Settings2 size={16} style={{ color: 'var(--color-accent)' }} />
            <span className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
              设置
            </span>
          </div>

          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={cn(
                'flex items-center gap-2.5 mx-2 px-3 py-2.5 rounded-lg text-left text-sm transition-colors',
                section === s.id
                  ? 'bg-[var(--color-accent)] text-white'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-hover)] hover:text-[var(--color-text)]',
              )}
            >
              {s.icon}
              {s.label}
            </button>
          ))}
        </aside>

        {/* 右侧内容区 */}
        <main className="flex-1 flex flex-col overflow-hidden">
          {/* 区域标题栏 */}
          <div
            className="flex items-center justify-between px-6 py-4 flex-shrink-0"
            style={{ borderBottom: '1px solid var(--color-border)' }}
          >
            <div>
              <h2 className="text-base font-semibold" style={{ color: 'var(--color-text)' }}>
                {SECTIONS.find((s) => s.id === section)?.label}
              </h2>
              <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                {SECTIONS.find((s) => s.id === section)?.description}
              </p>
            </div>
            <button
              onClick={onClose}
              className="flex items-center justify-center w-7 h-7 rounded-lg transition-colors hover:bg-[var(--color-hover)]"
              style={{ color: 'var(--color-text-muted)' }}
            >
              <X size={16} />
            </button>
          </div>

          {/* 区域内容 */}
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {section === 'llm' && <LLMSection purposes={['generation', 'refinement', 'summary']} purposeLabel="生成模型" />}
            {section === 'llm' && <PurposeAssignment />}
            {section === 'embedding' && <LLMSection purposes={['embedding']} purposeLabel="向量模型" />}
            {section === 'proxy' && <ProxySection />}
            {section === 'editor' && <EditorSection />}
            {section === 'prompts' && <PromptSettings />}
            {section === 'about' && <AboutSection />}
          </div>
        </main>
      </div>
    </div>
  )
}

// ==================== LLM & Embedding 通用区 ====================

function LLMSection({
  purposes,
  purposeLabel,
}: {
  purposes: ModelProfile['purposes']
  purposeLabel: string
}) {
  const models = useLLMStore(s => s.models)
  const defaultModelId = useLLMStore(s => s.defaultModelId)
  const defaultEmbeddingModelId = useLLMStore(s => s.defaultEmbeddingModelId)
  const loaded = useLLMStore(s => s.loaded)
  const loadModels = useLLMStore(s => s.loadModels)
  const saveModel = useLLMStore(s => s.saveModel)
  const deleteModel = useLLMStore(s => s.deleteModel)
  const setDefaultModel = useLLMStore(s => s.setDefaultModel)
  const setDefaultEmbeddingModel = useLLMStore(s => s.setDefaultEmbeddingModel)
  const [editingModel, setEditingModel] = useState<ModelProfile | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!loaded) loadModels()
  }, [loaded, loadModels])

  // 预设直接使用内置常量，无需 IPC 加载
  const presets = BUILTIN_PRESETS

  // 按用途过滤
  const filtered = models.filter((m) =>
    m.purposes?.some((p) => purposes.includes(p as ModelProfile['purposes'][number]))
  )

  /** 创建新模型，使用预设中 openai 的默认属性 */
  const handleAdd = () => {
    const isEmbedding = purposes.includes('embedding')
    const openaiPreset = presets.find((p) => p.provider === 'openai') ?? presets[0]
    setEditingModel({
      id: randomUUID(),
      name: '',
      provider: 'openai',
      protocol: (openaiPreset?.protocol ?? 'openai') as 'openai' | 'gemini' | 'anthropic',
      modelName: isEmbedding
        ? (openaiPreset?.embeddingModels[0] ?? 'text-embedding-3-small')
        : (openaiPreset?.models[0]?.name ?? 'gpt-4o'),
      apiKey: '',
      baseUrl: openaiPreset?.baseUrl ?? 'https://api.openai.com',
      temperature: 0.7,
      maxTokens: openaiPreset?.models[0]?.maxTokens ?? 4096,
      purposes: [...purposes],
    })
  }

  const isEmbeddingSection = purposes.includes('embedding')

  /** 保存模型；若是该分类第一个则自动设为默认 */
  const handleSave = async () => {
    if (!editingModel) return
    setSaving(true)
    await saveModel(editingModel)
    // 新增模型后，如果该分类还没有默认则自动设为默认
    const countBefore = filtered.length
    if (countBefore === 0) {
      if (isEmbeddingSection) {
        setDefaultEmbeddingModel(editingModel.id)
      } else {
        setDefaultModel(editingModel.id)
      }
    }
    setEditingModel(null)
    setSaving(false)
  }


  return (
    <div className="space-y-4">
      {/* 模型编辑表单 */}
      {editingModel && (
        <ModelForm
          model={editingModel}
          onChange={setEditingModel}
          onSave={handleSave}
          onCancel={() => setEditingModel(null)}
          saving={saving}
          purposeOptions={purposes}
          presets={presets}
        />
      )}

      {/* 模型列表 */}
      {!editingModel && (
        <>
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
              已配置 {filtered.length} 个{purposeLabel}
            </span>
            <Button size="sm" onClick={handleAdd}>
              <Plus size={13} />
              添加{purposeLabel}
            </Button>
          </div>

          {filtered.length === 0 ? (
            <div
              className="flex flex-col items-center justify-center py-16 gap-3 rounded-xl"
              style={{ border: '1.5px dashed var(--color-border)' }}
            >
              <Zap size={28} style={{ color: 'var(--color-text-muted)', opacity: 0.5 }} />
              <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
                暂无{purposeLabel}配置
              </span>
              <Button size="sm" variant="outline" onClick={handleAdd}>
                <Plus size={13} />
                添加第一个{purposeLabel}
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map((model) => (
                <ModelCard
                  key={model.id}
                  model={model}
                  isDefault={isEmbeddingSection
                    ? defaultEmbeddingModelId === model.id
                    : defaultModelId === model.id}
                  onSetDefault={() => isEmbeddingSection
                    ? setDefaultEmbeddingModel(model.id)
                    : setDefaultModel(model.id)}
                  onEdit={() => setEditingModel({ ...model })}
                  onDelete={() => deleteModel(model.id)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** 模型卡片 */
function ModelCard({
  model, isDefault, onSetDefault, onEdit, onDelete,
}: {
  model: ModelProfile
  isDefault: boolean
  onSetDefault: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 px-4 py-3 rounded-xl group transition-colors',
        isDefault
          ? 'border border-[var(--color-accent)]'
          : 'border border-[var(--color-border)] hover:border-[var(--color-accent)]',
      )}
      style={{ backgroundColor: isDefault ? 'color-mix(in srgb, var(--color-accent) 5%, var(--color-panel))' : 'var(--color-panel)' }}
    >
      {/* 图标 */}
      <div
        className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 text-lg"
        style={{ backgroundColor: 'var(--color-hover)' }}
      >
        {providerEmoji(model.provider)}
      </div>

      {/* 信息 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate" style={{ color: 'var(--color-text)' }}>
            {model.name || model.modelName}
          </span>
          {isDefault && (
            <span className="text-[0.7rem] px-1.5 py-0.5 rounded-full bg-[var(--color-accent)] text-white flex-shrink-0">
              默认
            </span>
          )}
        </div>
        <p className="text-xs truncate mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
          {model.provider} · {model.modelName} · {model.baseUrl}
        </p>
      </div>

      {/* 操作按钮（hover 显示） */}
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {!isDefault && (
          <button
            onClick={onSetDefault}
            title="设为默认"
            className="flex items-center justify-center w-7 h-7 rounded-lg transition-colors hover:bg-[var(--color-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          >
            <Check size={14} />
          </button>
        )}
        <button
          onClick={onEdit}
          title="编辑"
          className="flex items-center justify-center w-7 h-7 rounded-lg transition-colors hover:bg-[var(--color-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          <Settings2 size={14} />
        </button>
        <button
          onClick={onDelete}
          title="删除"
          className="flex items-center justify-center w-7 h-7 rounded-lg transition-colors hover:bg-red-500/10 text-[var(--color-text-muted)] hover:text-red-400"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  )
}

// ==================== 模型编辑表单 ====================


/** 模型编辑表单 */
function ModelForm({
  model, onChange, onSave, onCancel, saving, presets,
}: {
  model: ModelProfile
  onChange: (m: ModelProfile) => void
  onSave: () => void
  onCancel: () => void
  saving: boolean
  purposeOptions: ModelProfile['purposes']
  /** 服务商预设（来自 BUILTIN_PRESETS 常量） */
  presets: ProviderPreset[]
}) {
  const [showKey, setShowKey] = useState(false)
  // 标记"模型标识"是否使用自定义输入模式
  const [customModelName, setCustomModelName] = useState(false)

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean, error?: string } | null>(null)
  const testConnection = useLLMStore(s => s.testConnection)
  const fetchAvailableModels = useLLMStore(s => s.fetchAvailableModels)

  // 「按 API Key 拉取可用模型」局部 state：拉取结果只活在当前编辑卡片，不持久化
  const [fetchedModels, setFetchedModels] = useState<import('../../shared/provider-presets').ModelPreset[] | null>(null)
  const [fetching, setFetching] = useState(false)
  // 持有正在进行的 testResult 自动消失 timer；新 setResult 前先清掉旧 timer，避免老定时器把新结果清掉
  const resultTimerRef = useRef<number | null>(null)

  const isEmbedding = model.purposes?.includes('embedding')
  // 将预设数组转换为以 provider 为键的 Map 方便查找
  const presetMap = new Map(presets.map((p) => [p.provider, p]))
  const preset = presetMap.get(model.provider)
  // 模型下拉源：优先用拉取结果，没拉过/拉取失败回退到内置预设
  const builtinPresetModels: import('../../shared/provider-presets').ModelPreset[] = isEmbedding
    ? (preset?.embeddingModels ?? []).map((name) => ({ name, maxTokens: 0 }))
    : (preset?.models ?? [])
  const presetModels = fetchedModels ?? builtinPresetModels

  /** 更新单个字段；改 baseUrl/apiKey/protocol 时拉取结果作废（端点已变，旧列表不再可信） */
  const up = <K extends keyof ModelProfile>(key: K, val: ModelProfile[K]) => {
    if (key === 'baseUrl' || key === 'apiKey' || key === 'protocol') {
      setFetchedModels(null)
      setTestResult(null)
    }
    onChange({ ...model, [key]: val })
  }

  /**
   * 切换服务商：从持久化预设中自动填充 baseUrl / protocol
   * 并将模型名重置为该服务商的第一个预设模型
   */
  const handleProviderChange = (provider: ModelProfile['provider']) => {
    const p = presetMap.get(provider)
    const firstModel = isEmbedding ? null : (p?.models[0] ?? null)
    const defaultModelName = isEmbedding
      ? (p?.embeddingModels[0] ?? '')
      : (firstModel?.name ?? '')
    setCustomModelName(false)
    // 切服务商 → 拉取状态作废（应 Gemini R1 防脏数据残留：旧 provider 拉到的模型名不该在新 provider 下显示）
    setFetchedModels(null)
    setTestResult(null)
    onChange({
      ...model,
      provider,
      protocol: (p?.protocol ?? 'openai') as 'openai' | 'gemini' | 'anthropic',
      baseUrl: p?.baseUrl ?? '',
      modelName: defaultModelName,
      maxTokens: firstModel?.maxTokens ?? 4096,
    })
  }

  /** 拉取该 baseUrl+apiKey 上可用的模型清单，覆盖下拉源（不持久化） */
  const handleFetchModels = async () => {
    setFetching(true)
    setTestResult(null)
    // 清掉可能残留的旧 timeout（避免老定时器把新结果清掉）
    if (resultTimerRef.current !== null) {
      clearTimeout(resultTimerRef.current)
      resultTimerRef.current = null
    }
    try {
      const result = await fetchAvailableModels(model)
      if (result.success && result.models.length > 0) {
        const list = result.models.map((id) => ({ name: id, maxTokens: model.maxTokens || 4096 }))
        setFetchedModels(list)
        // 拉取后若当前 modelName 不在新列表里，让自定义输入框可见（保留旧值，避免被隐藏到下拉的 __custom__ 项后丢失视觉反馈）
        const currentInList = list.some((m) => m.name === model.modelName)
        setCustomModelName(!currentInList)
        // 拉取成功用专用文案，跟"测试连接"区分（应 Gemini #1）
        setTestResult({ success: true, error: `模型列表拉取成功（${list.length} 个）` })
        resultTimerRef.current = window.setTimeout(() => {
          setTestResult(null)
          resultTimerRef.current = null
        }, 2500)
      } else {
        const errMsg = result.error || (result.models.length === 0 ? '该端点没有返回任何模型' : '拉取失败')
        setTestResult({ success: false, error: errMsg })
      }
    } catch (e) {
      setTestResult({ success: false, error: String(e) })
    }
    setFetching(false)
  }

  /** 选择预设模型或切换到自定义输入 */
  const handleModelSelect = (val: string) => {
    if (val === '__custom__') {
      setCustomModelName(true)
      up('modelName', '')
    } else {
      setCustomModelName(false)
      // 找到对应的 ModelPreset，同时更新 modelName 和 maxTokens
      const matched = presetModels.find((m) => m.name === val)
      onChange({
        ...model,
        modelName: val,
        maxTokens: matched?.maxTokens ?? model.maxTokens,
      })
    }
  }


  // 当前模型名是否在预设列表里（决定下拉框显示）
  const isPresetValue = presetModels.some((m) => m.name === model.modelName)
  const selectValue = customModelName || (!isPresetValue && presetModels.length > 0)
    ? '__custom__'
    : model.modelName

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    if (resultTimerRef.current !== null) {
      clearTimeout(resultTimerRef.current)
      resultTimerRef.current = null
    }
    const result = await testConnection(model)
    setTestResult(result)
    setTesting(false)
    resultTimerRef.current = window.setTimeout(() => {
      setTestResult(null)
      resultTimerRef.current = null
    }, 3000)
  }

  return (
    <div
      className="rounded-xl p-5 space-y-4"
      style={{ border: '1.5px solid var(--color-accent)', backgroundColor: 'var(--color-panel)' }}
    >
      <h3 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
        {model.name ? `编辑：${model.name}` : '新建模型配置'}
      </h3>

      {/* 显示名称 */}
      <div>
        <Label>显示名称</Label>
        <Input
          value={model.name}
          onChange={(e) => up('name', e.target.value)}
          placeholder="如：DeepSeek 主力 / GPT-4o 备用"
          disabled={fetching}
        />
      </div>

      {/* 服务商 + 协议 */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>服务商</Label>
          <Select
            value={model.provider}
            onValueChange={(v) => handleProviderChange(v as ModelProfile['provider'])}
            disabled={fetching}
            options={[
              { value: 'openai', label: 'OpenAI' },
              { value: 'claude', label: 'Claude（Anthropic）' },
              { value: 'deepseek', label: 'DeepSeek' },
              { value: 'gemini', label: 'Google Gemini' },
              { value: 'ollama', label: 'Ollama（本地）' },
              { value: 'bigmodel', label: 'BigModel（智谱）' },
              { value: 'custom', label: '自定义' },
            ]}
          />
        </div>
        <div>
          <Label>调用协议</Label>
          <Select
            value={model.protocol}
            onValueChange={(v) => up('protocol', v as 'openai' | 'gemini' | 'anthropic')}
            disabled={fetching}
            options={[
              { value: 'openai', label: 'OpenAI' },
              { value: 'gemini', label: 'Gemini' },
              { value: 'anthropic', label: 'Anthropic' },
            ]}
          />
        </div>
      </div>

      {/* 模型标识：有预设时显示下拉，否则纯输入 */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <Label className="mb-0">模型标识</Label>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleFetchModels}
              disabled={fetching || !model.baseUrl || (!model.apiKey && model.provider !== 'ollama')}
              className="text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ color: 'var(--color-accent)' }}
              title="按 baseUrl + API Key 拉取该服务商可用模型列表"
            >
              {fetching ? '⏳ 拉取中...' : '🔄 拉取可用'}
            </button>
            {presetModels.length > 0 && (
              <button
                type="button"
                disabled={fetching}
                onClick={() => {
                  if (customModelName) {
                    // 切回预设列表
                    const first = presetModels[0]
                    setCustomModelName(false)
                    onChange({ ...model, modelName: first.name, maxTokens: first.maxTokens ?? model.maxTokens })
                  } else {
                    // 切换到自定义输入
                    setCustomModelName(true)
                    up('modelName', '')
                  }
                }}
                className="text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ color: 'var(--color-accent)' }}
              >
                {customModelName ? '← 从列表选择' : '手动输入 →'}
              </button>
            )}
          </div>
        </div>

        {/* 有预设模型 且 未切到手动输入 → 显示下拉 */}
        {presetModels.length > 0 && !customModelName ? (
          <Select
            value={selectValue}
            onValueChange={(v) => handleModelSelect(v)}
            disabled={fetching}
            options={[
              ...presetModels.map((m) => ({ value: m.name, label: m.name })),
              { value: '__custom__', label: '── 手动输入 ──' },
            ]}
          />
        ) : (
          <div>
            <Input
              value={model.modelName}
              onChange={(e) => up('modelName', e.target.value)}
              placeholder={isEmbedding ? 'text-embedding-3-small' : 'gpt-4o'}
              autoFocus={customModelName}
              disabled={fetching}
            />
          </div>
        )}
      </div>

      {/* API 地址 */}
      <div>
        <Label>API 地址</Label>
        <Input
          value={model.baseUrl}
          onChange={(e) => up('baseUrl', e.target.value)}
          placeholder="https://api.openai.com"
          disabled={fetching}
        />
        {model.provider !== 'custom' && (
          <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
            已自动填入 {model.provider} 官方地址，如使用中转地址可手动修改
          </p>
        )}
      </div>

      {/* API Key */}
      <div>
        <Label>API Key</Label>
        <div className="relative">
          <Input
            type={showKey ? 'text' : 'password'}
            value={model.apiKey}
            onChange={(e) => up('apiKey', e.target.value)}
            placeholder={model.provider === 'ollama' ? '本地部署可留空' : 'sk-...'}
            className="pr-9"
            disabled={fetching}
          />
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      </div>

      {/* 温度 / Token（仅生成模型） */}
      {!isEmbedding && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>温度 (Temperature)</Label>
            <Input
              type="number" min={0} max={2} step={0.1}
              value={model.temperature}
              onChange={(e) => up('temperature', (e.target.value === '' ? '' : parseFloat(e.target.value)) as number)}
              onBlur={() => {
                const v = Number(model.temperature);
                if (isNaN(v)) up('temperature', 0.7)
              }}
              disabled={fetching}
            />
          </div>
          <div>
            <Label>最大 Tokens</Label>
            <Input
              type="number"
              value={model.maxTokens}
              onChange={(e) => up('maxTokens', (e.target.value === '' ? '' : parseInt(e.target.value)) as number)}
              onBlur={() => {
                const v = Number(model.maxTokens);
                if (!v || v < 1) up('maxTokens', 4096)
              }}
              disabled={fetching}
            />
          </div>
        </div>
      )}

      {/* 思考模式（仅生成模型）——按模型能力配置，不做成运行时开关 */}
      {!isEmbedding && (
        <div>
          <Label>思考模式</Label>
          <Select
            value={model.thinkingMode ?? 'optional'}
            onValueChange={(v) => up('thinkingMode', v as 'always' | 'optional' | 'never')}
            disabled={fetching}
            options={[
              { value: 'optional', label: '默认（跟随代码请求）' },
              { value: 'always', label: '始终开启（推理模型）' },
              { value: 'never', label: '始终关闭（普通 chat 模型）' },
            ]}
          />
          <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
            推理模型（如 deepseek-reasoner、o 系列）选「始终开启」；
            普通 chat 模型（如 deepseek-chat）若不支持 thinking 参数选「始终关闭」覆盖代码请求。
          </p>
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button
          variant="outline"
          onClick={handleTest}
          disabled={testing || fetching || !model.baseUrl || (!model.apiKey && model.provider !== 'ollama')}
        >
          <Zap size={13} />
          {testing ? '测试中...' : '测试连接'}
        </Button>
        <Button
          className="flex-1"
          onClick={onSave}
          disabled={saving || fetching || !model.name || (!model.apiKey && model.provider !== 'ollama')}
        >
          <Save size={13} />
          {saving ? '保存中...' : '保存配置'}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={fetching}>取消</Button>
      </div>
      {testResult && (
        <div className={`text-xs p-2 rounded ${testResult.success ? 'bg-green-500/10 text-green-500 border border-green-500/20' : 'bg-red-500/10 text-red-500 border border-red-500/20'} break-all`}>
          {testResult.success
            // 拉取成功时 error 字段被复用为消息内容（如"模型列表拉取成功（12 个）"）；
            // 测试连接成功时 error 为空，回退到默认"连接成功"
            ? `✅ ${testResult.error || '连接成功！'}`
            : `❌ 失败: ${testResult.error}`}
        </div>
      )}
    </div>
  )
}


// ==================== 按用途分配模型（设计屏 24） ====================

/** 大纲/正文/审稿/嵌入 各指定一个模型；未设置则回退默认模型 */
function PurposeAssignment() {
  const models = useLLMStore((s) => s.models)
  const defaultModelId = useLLMStore((s) => s.defaultModelId)
  const outlineModelId = useLLMStore((s) => s.outlineModelId)
  const draftModelId = useLLMStore((s) => s.draftModelId)
  const reviewModelId = useLLMStore((s) => s.reviewModelId)
  const defaultEmbeddingModelId = useLLMStore((s) => s.defaultEmbeddingModelId)
  const setPurposeModel = useLLMStore((s) => s.setPurposeModel)
  const setDefaultEmbeddingModel = useLLMStore((s) => s.setDefaultEmbeddingModel)

  // 生成类（大纲/正文/审稿可选）与嵌入类模型分别过滤，避免下拉混入不相关模型
  const genModels = models.filter((m) => !m.purposes || m.purposes.some((p) => p !== 'embedding'))
  const embModels = models.filter((m) => m.purposes?.includes('embedding'))

  const defaultName = models.find((m) => m.id === defaultModelId)?.name
  const genHint = defaultName ? `默认（${defaultName}）` : '默认（跟随默认模型）'

  const rows: Array<{ label: string; desc: string; value: string | null; opts: ModelProfile[]; hint: string; onChange: (id: string | null) => void }> = [
    { label: '大纲模型', desc: '生成章节蓝图与大纲', value: outlineModelId, opts: genModels, hint: genHint, onChange: (id) => setPurposeModel('outline', id) },
    { label: '正文模型', desc: '流式生成章节正文', value: draftModelId, opts: genModels, hint: genHint, onChange: (id) => setPurposeModel('draft', id) },
    { label: '审稿模型', desc: '生成审稿报告与诊断', value: reviewModelId, opts: genModels, hint: genHint, onChange: (id) => setPurposeModel('review', id) },
    { label: '嵌入模型', desc: '知识库语义检索', value: defaultEmbeddingModelId ?? null, opts: embModels, hint: '默认（跟随向量模型设置）', onChange: (id) => setDefaultEmbeddingModel(id) },
  ]

  return (
    <div
      className="mt-6 p-4 rounded-xl"
      style={{ backgroundColor: 'var(--color-sidebar)', border: '1px solid var(--color-border)' }}
    >
      <div className="text-sm font-semibold mb-1" style={{ color: 'var(--color-text)' }}>按用途分配模型</div>
      <div className="text-xs mb-4" style={{ color: 'var(--color-text-muted)' }}>为不同创作环节指定模型，未设置则回退默认模型</div>
      <div className="space-y-3">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm" style={{ color: 'var(--color-text)' }}>{row.label}</div>
              <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{row.desc}</div>
            </div>
            <Select
              className="w-52 flex-shrink-0"
              value={row.value ?? MODEL_PURPOSE_DEFAULT}
              onValueChange={(v) => row.onChange(v === MODEL_PURPOSE_DEFAULT ? null : v)}
              options={[
                { value: MODEL_PURPOSE_DEFAULT, label: row.hint },
                ...row.opts.map((m) => ({ value: m.id, label: m.name || m.modelName })),
              ]}
            />
          </div>
        ))}
      </div>
      {models.length === 0 && (
        <div className="text-xs mt-3" style={{ color: 'var(--color-text-muted)' }}>请先在上方添加模型，再按用途分配。</div>
      )}
    </div>
  )
}

// ==================== 代理设置 ====================

function ProxySection() {
  const [proxy, setProxy] = useState<{
    enabled: boolean; type: 'http' | 'socks5'; host: string; port: number
  }>({ enabled: false, type: 'http', host: '', port: 7890 })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    ipc.invoke('config:get').then((cfg) => {
      if (cfg?.proxy) {
        setProxy({
          enabled: cfg.proxy.enabled ?? false, // 明确默认关闭
          type: cfg.proxy.type ?? 'http',
          host: cfg.proxy.host ?? '',
          port: cfg.proxy.port ?? 7890,
        })
      }
    }).catch(() => { })
  }, [])

  const handleSave = async () => {
    setSaving(true)
    await ipc.invoke('config:set', { proxy }).catch(() => { })
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="max-w-[480px] space-y-5">
      {/* 启用开关 */}
      <div
        className="flex items-center justify-between p-4 rounded-xl"
        style={{ border: '1px solid var(--color-border)', backgroundColor: 'var(--color-panel)' }}
      >
        <div>
          <p className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>启用代理</p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
            所有 AI API 请求将通过代理发送
          </p>
        </div>
        <Switch
          checked={proxy.enabled}
          onCheckedChange={(checked) => setProxy({ ...proxy, enabled: checked })}
          aria-label="启用代理"
        />
      </div>

      {/* 代理详情 */}
      {proxy.enabled && (
        <div
          className="space-y-3 p-4 rounded-xl"
          style={{ border: '1px solid var(--color-border)', backgroundColor: 'var(--color-panel)' }}
        >
          <div>
            <Label>代理类型</Label>
            <Select
              value={proxy.type}
              onValueChange={(v) => setProxy({ ...proxy, type: v as 'http' | 'socks5' })}
              options={[
                { value: 'http', label: 'HTTP' },
                { value: 'socks5', label: 'SOCKS5' },
              ]}
            />
          </div>
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <div>
              <Label>主机地址</Label>
              <Input
                value={proxy.host}
                onChange={(e) => setProxy({ ...proxy, host: e.target.value })}
                placeholder="127.0.0.1"
              />
            </div>
            <div>
              <Label>端口</Label>
              <Input
                type="number"
                value={proxy.port}
                onChange={(e) => setProxy({ ...proxy, port: (e.target.value === '' ? '' : parseInt(e.target.value)) as number })}
                onBlur={() => {
                  const v = Number(proxy.port);
                  if (!v) setProxy({ ...proxy, port: 7890 })
                }}
              />
            </div>
          </div>
        </div>
      )}

      <Button onClick={handleSave} disabled={saving}>
        {saved ? <Check size={13} /> : <Save size={13} />}
        {saved ? '已保存' : saving ? '保存中...' : '保存代理配置'}
      </Button>
    </div>
  )
}

// ==================== 编辑器设置 ====================

/** 字体下拉菜单（界面字体 + 写作字体共用） */
function FontSelect({
  value,
  onChange,
}: {
  value: FontId
  onChange: (id: FontId) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = FONT_OPTIONS.find((o) => o.id === value) ?? FONT_OPTIONS[0]

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div ref={ref} className="relative">
      {/* 触发按鈕 */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full px-3 h-9 rounded-lg transition-colors text-left"
        style={{
          border: '1px solid var(--color-border)',
          backgroundColor: open ? 'var(--color-hover)' : 'var(--color-panel)',
          color: 'var(--color-text)',
        }}
      >
        {/* 当前字体预览 */}
        <span
          className="flex-1 text-sm truncate"
          style={{ fontFamily: current.family }}
        >
          {current.label}
        </span>
        <span className="text-xs flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
          {current.preview}
        </span>
        <ChevronDown
          size={13}
          className="flex-shrink-0 transition-transform"
          style={{
            color: 'var(--color-text-muted)',
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        />
      </button>

      {/* 下拉选项列表 */}
      {open && (
        <div
          className="absolute left-0 right-0 top-[calc(100%+4px)] z-50 rounded-xl overflow-hidden"
          style={{
            border: '1px solid var(--color-border)',
            backgroundColor: 'var(--color-panel)',
            boxShadow: 'var(--shadow-lg)',
          }}
        >
          {FONT_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              onClick={() => { onChange(opt.id); setOpen(false) }}
              className="w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors hover:bg-[var(--color-hover)]"
              style={{
                backgroundColor: value === opt.id
                  ? 'color-mix(in srgb, var(--color-accent) 8%, transparent)'
                  : 'transparent',
              }}
            >
              {/* 选中标记 */}
              <span
                className="w-3.5 h-3.5 rounded-full flex-shrink-0 flex items-center justify-center"
                style={{
                  backgroundColor: value === opt.id ? 'var(--color-accent)' : 'transparent',
                  border: value === opt.id ? 'none' : '1.5px solid var(--color-border)',
                }}
              >
                {value === opt.id && (
                  <span className="w-1.5 h-1.5 rounded-full bg-white" />
                )}
              </span>

              {/* 字体名 + 描述 */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium" style={{ color: 'var(--color-text)', fontFamily: opt.family }}>
                    {opt.label}
                  </span>
                  <span className="text-[0.65rem]" style={{ color: 'var(--color-text-muted)' }}>
                    {opt.labelEn}
                  </span>
                </div>
                <p className="text-[0.65rem] truncate mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                  {opt.desc}
                </p>
              </div>

              {/* 预览文字 */}
              <span
                className="text-sm flex-shrink-0"
                style={{ fontFamily: opt.family, color: 'var(--color-text-secondary)' }}
              >
                {opt.preview}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function EditorSection() {
  const { writingFont, setWritingFont, uiFont, setUiFont } = useThemeStore()

  return (
    <div className="max-w-md space-y-5">
      {/* 界面字体 */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold" style={{ color: 'var(--color-text)' }}>界面字体</p>
            <p className="text-[0.68rem] mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
              左侧栏、菜单、对话框等 UI 区域
            </p>
          </div>
        </div>
        <FontSelect value={uiFont} onChange={setUiFont} />
      </div>

      {/* 写作字体 */}
      <div className="space-y-1.5">
        <div>
          <p className="text-xs font-semibold" style={{ color: 'var(--color-text)' }}>写作字体</p>
          <p className="text-[0.68rem] mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
            草稿、终稿、架构文档等正文区域
          </p>
        </div>
        <FontSelect value={writingFont} onChange={setWritingFont} />
      </div>

      {/* 说明 */}
      <div
        className="flex items-start gap-2 px-3 py-2.5 rounded-lg text-xs"
        style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-text-muted)' }}
      >
        <span className="flex-shrink-0 mt-0.5" style={{ color: 'var(--color-text-muted)' }}>提示</span>
        <span>所有字体已内置在应用中，无需网络连接，切换后立即生效。</span>
      </div>
    </div>
  )
}

// ==================== 关于区 ====================

function AboutSection() {
  return (
    <div className="space-y-6 max-w-[600px] p-2">
      <div className="flex flex-col items-center justify-center py-8 rounded-xl space-y-2" style={{ backgroundColor: 'var(--color-sidebar)', border: '1px solid var(--color-border)' }}>
        <h1 className="text-2xl font-bold brand-gradient tracking-wider">Vela IDE</h1>
        <p className="text-sm opacity-80" style={{ color: 'var(--color-text)' }}>v{__APP_VERSION__}</p>
        <p className="text-xs mt-2" style={{ color: 'var(--color-text-muted)' }}>GPL-3.0 二次开发版，基于上游 Vela</p>
      </div>

      <div className="space-y-4 pt-2">
        <h3 className="text-sm font-semibold pb-2" style={{ borderBottom: '1px solid var(--color-border)', color: 'var(--color-text)' }}>上游归属</h3>
        <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
          本项目基于上游 heider-x/vela 的 GPL-3.0 开源项目修改，保留上游来源、原作者署名和许可证说明。
        </p>
      </div>

      <div className="space-y-4 pt-4">
        <h3 className="text-sm font-semibold pb-2" style={{ borderBottom: '1px solid var(--color-border)', color: 'var(--color-text)' }}>开源协议</h3>
        <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
          本二次开发分支继续遵循 GPL-3.0 协议，不提供个人联系方式、微信群、赞助二维码或额外闭源商用授权。
        </p>
      </div>
    </div>
  )
}

// ==================== 工具函数 ====================

function providerEmoji(provider: string) {
  const map: Record<string, string> = {
    openai: '🤖', claude: '🎭', deepseek: '🐬', gemini: '✨', ollama: '🦙', bigmodel: '🧠', custom: '⚙️',
  }
  return map[provider] ?? '🔧'
}

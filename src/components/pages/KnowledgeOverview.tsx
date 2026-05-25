import { useState, useEffect, useCallback } from 'react'
import {
  Database, BookOpen, FileText,
  Search, RefreshCw, Layers, Hash, Cpu, AlertTriangle, CheckCircle2, Upload,
} from 'lucide-react'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { EmptyState } from '../ui/EmptyState'
import { useProjectStore } from '../../stores/project-store'
import { cn } from '../../lib/utils'
import { toast } from '../ui/Toast'
import { globalEventBus } from '../../shared/event-bus'
import {
  loadKBData, getVectorlessCount, searchKB, rebuildVectorIndex,
  selectImportFiles, importDocument,
  type KBDocument, type SearchResult, type KBStatsData,
} from '../../services/knowledge-service'

type SearchMode = 'semantic' | 'keyword'

const EMPTY_STATS: KBStatsData = {
  documentCount: 0, totalChunks: 0, vectorDimension: 0,
  embeddingModel: null, expectedDimension: null, dimensionMismatch: false,
}

/**
 * 知识库概览页面 — LanceDB 向量数据库的管理中心
 * 当侧栏视图为"知识库"时，作为中间编辑区的固定内容展示。
 */
export default function KnowledgeOverview() {
  const [documents, setDocuments] = useState<KBDocument[]>([])
  const [stats, setStats] = useState<KBStatsData>(EMPTY_STATS)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [topK, setTopK] = useState(10)
  const [searchMode, setSearchMode] = useState<SearchMode>('semantic')
  const [vectorlessCount, setVectorlessCount] = useState(0)
  const [rebuilding, setRebuilding] = useState(false)
  const [importing, setImporting] = useState(false)

  const currentProject = useProjectStore(s => s.currentProject)

  const loadData = useCallback(async () => {
    if (!currentProject) return
    try {
      const { documents: docs, stats: s } = await loadKBData()
      setDocuments(docs)
      setStats(s)
    } catch { /* 忽略 */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.path])

  const checkVectorless = useCallback(async () => {
    if (!currentProject) return
    try {
      setVectorlessCount(await getVectorlessCount())
    } catch { /* 忽略 */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.path])

  useEffect(() => {
    loadData()
    checkVectorless()
  }, [loadData, checkVectorless])

  useEffect(() => { checkVectorless() }, [checkVectorless, documents])

  // 通过 EventBus 监听资源刷新和定稿完成事件
  useEffect(() => {
    const unsub1 = globalEventBus.on('REFRESH_RESOURCE', (payload: { resources: string[] }) => {
      if (payload.resources.includes('all') || payload.resources.includes('fileTree')) {
        loadData()
        checkVectorless()
      }
    })
    const unsub2 = globalEventBus.on('FINALIZE_COMPLETE', () => {
      loadData()
      checkVectorless()
    })
    return () => { unsub1(); unsub2() }
  }, [loadData, checkVectorless])

  const hasVectors = stats.vectorDimension > 0

  if (!currentProject) {
    return (
      <div className="h-full flex flex-col overflow-hidden bg-[var(--color-bg)]">
        <div
          className="flex items-center justify-between gap-2 px-3 h-9 flex-shrink-0"
          style={{
            borderBottom: '1px solid var(--color-border)',
            backgroundColor: 'var(--color-editor-bg)',
          }}
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-xs font-medium truncate text-[var(--color-text-secondary)]">
              知识库
            </span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto relative">
          <EmptyState icon={<BookOpen size={36} />} message="请先打开项目" opacity={0.4} />
        </div>
      </div>
    )
  }

  /** 执行检索（按当前模式：语义 / 关键词） */
  const handleSearch = async (mode: SearchMode = searchMode) => {
    if (!searchQuery.trim()) return
    setSearching(true)
    try {
      const results = await searchKB(searchQuery, topK, mode)
      setSearchResults(results)
    } catch { /* 忽略 */ }
    setSearching(false)
  }

  /** 切换检索模式（若已有查询则即时重查） */
  const handleModeChange = (mode: SearchMode) => {
    if (mode === searchMode) return
    setSearchMode(mode)
    if (searchQuery.trim() && searchResults.length > 0) {
      handleSearch(mode)
    }
  }

  /** 手动导入资料（多选 .txt/.md，逐个入库） */
  const handleImport = async () => {
    if (importing) return // 防重入
    // 先置 importing：选择框打开期间按钮即禁用；选择/导入全程纳入 try/finally
    setImporting(true)
    let didImport = false // 仅真正导入过才刷新（取消时不刷新）
    try {
      const files = await selectImportFiles()
      if (!files || files.length === 0) return // 取消：finally 复位 importing，不刷新
      didImport = true
      let imported = 0
      let failed = 0
      let embeddingFailed = 0 // 入库成功但嵌入调用失败（降级为关键词）的文件数
      let firstError: string | undefined
      for (const filePath of files) {
        const r = await importDocument(filePath)
        if (r.success) {
          imported++
          if (r.embeddingFailed) embeddingFailed++
        } else {
          failed++
          if (!firstError && r.error) firstError = r.error
        }
      }
      if (imported > 0) {
        toast.success(`已导入 ${imported} 个文件${failed > 0 ? `，${failed} 个失败` : ''}`)
        // 入库成功但嵌入失败 → 明确告知已降级为关键词模式，引导检查嵌入模型配置
        if (embeddingFailed > 0) {
          toast.warning(`其中 ${embeddingFailed} 个文件语义向量生成失败，已按关键词模式入库。请检查「嵌入」用途的模型配置后点「重建向量索引」。`)
        }
      } else {
        // 全失败（常见：换嵌入模型后维度不一致）→ 提示重建
        toast.error(firstError || '导入失败')
      }
    } catch (e) {
      toast.error('导入失败: ' + String(e))
    } finally {
      setImporting(false)
      if (didImport) {
        // 入库会改动文档/向量，刷新统计与列表
        globalEventBus.emit('REFRESH_RESOURCE', { resources: ['all'] })
        loadData()
        checkVectorless()
      }
    }
  }

  /** 重建向量索引（全量重嵌入 + 按当前模型维度重建表） */
  const handleRebuild = async () => {
    // 二次确认：重建会对全部文本块重新调用嵌入 API，按量消耗 token
    const ok = window.confirm(
      `将对全部 ${stats.totalChunks} 个文本块用当前嵌入模型重新生成向量并重建索引。\n` +
      `文本量较大时会消耗较多嵌入 API 额度（token），且无法中途撤销。\n\n确定继续？`
    )
    if (!ok) return
    setRebuilding(true)
    try {
      const result = await rebuildVectorIndex()
      if (result.success) {
        toast.success(`向量索引重建完成：已处理 ${result.processed} 块${result.failed > 0 ? `，${result.failed} 块未生成` : ''}`)
      } else {
        toast.error(result.error || '向量索引重建失败')
      }
    } catch (e) {
      toast.error('向量索引重建失败: ' + String(e))
    } finally {
      setRebuilding(false)
      globalEventBus.emit('REFRESH_RESOURCE', { resources: ['all'] })
    }
  }

  return (
    <div className="h-full overflow-y-auto" style={{ backgroundColor: 'var(--color-editor-bg)' }}>
      <div className="max-w-4xl mx-auto px-8 py-6">

        {/* ===== 标题 ===== */}
        <div className="flex items-center gap-3 mb-6">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: 'linear-gradient(135deg, var(--color-accent), var(--color-accent-hover))' }}
          >
            <Database size={20} className="text-white" />
          </div>
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-[var(--color-text)]">知识库</h2>
            <p className="text-xs text-[var(--color-text-muted)]">
              已导入 {stats.documentCount} 份资料 · 基于 LanceDB 的本地向量库，定稿后自动入库，为 AI 写作提供检索上下文
            </p>
          </div>
          {/* 导入资料（设计屏 23 右上角）：多选 .txt/.md 手动入库 */}
          <Button
            variant="outline"
            className="text-xs ml-auto flex-shrink-0"
            onClick={handleImport}
            disabled={importing}
            title="选择 .txt / .md 文件导入知识库"
          >
            {importing
              ? <><RefreshCw size={13} className="animate-spin mr-1.5" />导入中...</>
              : <><Upload size={13} className="mr-1.5" />导入资料</>}
          </Button>
        </div>

        {/* ===== 检索区域 ===== */}
        <div
          className="rounded-xl border border-[var(--color-border)] mb-6 overflow-hidden"
          style={{ backgroundColor: 'var(--color-sidebar)' }}
        >
          <div className="px-4 py-3">
            <div className="flex items-center gap-2">
              <Input
                className="flex-1 h-9"
                placeholder="输入查询内容，如：主角的能力体系、世界观核心设定..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              />
              <div className="flex items-center gap-1 flex-shrink-0">
                <span className="text-[0.7rem] text-[var(--color-text-muted)]">Top</span>
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={topK}
                  onChange={(e) => setTopK(Math.max(1, Math.min(50, Number(e.target.value) || 10)))}
                  className="w-12 h-7 text-xs rounded px-1.5 text-center"
                />
              </div>
              <Button variant="ai" onClick={() => handleSearch()} disabled={searching}>
                {searching ? <RefreshCw size={13} className="animate-spin" /> : <Search size={13} />}
                检索
              </Button>
            </div>

            {/* 检索模式切换 */}
            <div className="flex items-center gap-2 mt-3">
              <ModeTabs mode={searchMode} onChange={handleModeChange} semanticEnabled={hasVectors} />
              <span className="text-[0.7rem] text-[var(--color-text-muted)] ml-auto">
                {searchMode === 'keyword'
                  ? '字符级模糊匹配（LIKE），无需嵌入模型'
                  : hasVectors ? '向量近邻召回，失败时回退关键词' : '未建向量索引，将回退关键词匹配'}
              </span>
            </div>
          </div>

          {/* 检索结果 */}
          {searchResults.length > 0 && (
            <div className="border-t border-[var(--color-border)]">
              <div className="px-4 py-2 flex items-center justify-between">
                <span className="text-xs font-medium text-[var(--color-text-muted)]">
                  找到 {searchResults.length} 段相关内容
                </span>
                <button
                  className="text-[0.7rem] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
                  onClick={() => setSearchResults([])}
                >
                  清除
                </button>
              </div>
              <div className="max-h-[360px] overflow-y-auto">
                {searchResults.map((r, i) => (
                  <div
                    key={i}
                    className="px-4 py-3 border-t border-[var(--color-border)] hover:bg-[var(--color-hover)] transition-colors"
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs text-[var(--color-text-muted)] flex items-center gap-1.5">
                        <FileText size={10} />
                        {r.fileName}
                      </span>
                      <span className={cn(
                        'text-[0.7rem] px-1.5 py-0.5 rounded font-mono',
                        r.score > 0.8 ? 'bg-green-500/20 text-green-400' :
                        r.score > 0.6 ? 'bg-yellow-500/20 text-yellow-400' :
                        'bg-[var(--color-hover)] text-[var(--color-text-muted)]'
                      )}>
                        {r.score === 0.5 ? '关键词匹配' : `相关 ${(r.score * 100).toFixed(0)}%`}
                      </span>
                    </div>
                    <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed whitespace-pre-wrap">
                      {r.text}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ===== 索引维护 ===== */}
        <div
          className="rounded-xl border border-[var(--color-border)] overflow-hidden"
          style={{ backgroundColor: 'var(--color-sidebar)' }}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
            <span className="text-sm font-semibold text-[var(--color-text)] flex items-center gap-2">
              <Database size={14} className="text-[var(--color-accent)]" />
              索引维护
            </span>
            <Button
              variant="outline"
              className="text-xs"
              onClick={handleRebuild}
              disabled={rebuilding}
              title="对全部文本块用当前嵌入模型重新生成向量并按其维度重建索引"
            >
              {rebuilding
                ? <><RefreshCw size={12} className="animate-spin mr-1.5" />重建中...</>
                : <><RefreshCw size={12} className="mr-1.5" />重建向量索引</>}
            </Button>
          </div>

          {/* 索引统计 */}
          <div className="grid grid-cols-4 gap-px bg-[var(--color-border)]">
            <MaintStat icon={<FileText size={13} />} label="已索引文档" value={stats.documentCount} />
            <MaintStat icon={<Layers size={13} />} label="文本块" value={stats.totalChunks.toLocaleString()} />
            <MaintStat icon={<Hash size={13} />} label="向量维度" value={hasVectors ? stats.vectorDimension : '—'} accent={hasVectors} />
            <MaintStat icon={<Cpu size={13} />} label="嵌入模型" value={stats.embeddingModel ?? '未配置'} />
          </div>

          {/* 检索模式 + 状态提示 */}
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-[var(--color-border)]">
            <div className="flex items-center gap-2">
              <span className="text-[0.7rem] text-[var(--color-text-muted)]">检索模式</span>
              <ModeTabs mode={searchMode} onChange={handleModeChange} semanticEnabled={hasVectors} compact />
            </div>
            <StatusHint
              mismatch={stats.dimensionMismatch}
              expectedDimension={stats.expectedDimension}
              vectorDimension={stats.vectorDimension}
              vectorlessCount={vectorlessCount}
              hasVectors={hasVectors}
            />
          </div>
        </div>

      </div>
    </div>
  )
}

/** 检索模式分段切换（语义 / 关键词） */
function ModeTabs({ mode, onChange, semanticEnabled, compact }: {
  mode: SearchMode
  onChange: (m: SearchMode) => void
  semanticEnabled: boolean
  compact?: boolean
}) {
  const tabs: Array<{ key: SearchMode; label: string }> = [
    { key: 'semantic', label: '语义检索' },
    { key: 'keyword', label: '关键词' },
  ]
  return (
    <div className="inline-flex rounded-lg p-0.5 bg-[var(--color-hover)]">
      {tabs.map((t) => {
        const active = mode === t.key
        const disabled = t.key === 'semantic' && !semanticEnabled
        return (
          <button
            key={t.key}
            onClick={() => !disabled && onChange(t.key)}
            disabled={disabled}
            title={disabled ? '未建向量索引，请先重建' : undefined}
            className={cn(
              'rounded-md font-medium transition-colors',
              compact ? 'text-[0.7rem] px-2 py-0.5' : 'text-xs px-2.5 py-1',
              active
                ? 'bg-[var(--color-accent)] text-white shadow-sm'
                : disabled
                  ? 'text-[var(--color-text-muted)] opacity-40 cursor-not-allowed'
                  : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text)]'
            )}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

/** 索引维护卡片内的单项统计 */
function MaintStat({ icon, label, value, accent }: {
  icon: React.ReactNode
  label: string
  value: number | string
  accent?: boolean
}) {
  return (
    <div className="px-4 py-3" style={{ backgroundColor: 'var(--color-sidebar)' }}>
      <div className="flex items-center gap-1.5 mb-1.5 text-[var(--color-text-muted)]">
        {icon}
        <span className="text-[0.7rem]">{label}</span>
      </div>
      <div className={cn(
        'text-base font-bold truncate',
        accent ? 'text-[var(--color-accent)]' : 'text-[var(--color-text)]'
      )} title={String(value)}>
        {value}
      </div>
    </div>
  )
}

/** 索引健康度提示：维度不一致 > 缺向量 > 完整 > 未索引 */
function StatusHint({ mismatch, expectedDimension, vectorDimension, vectorlessCount, hasVectors }: {
  mismatch: boolean
  expectedDimension: number | null
  vectorDimension: number
  vectorlessCount: number
  hasVectors: boolean
}) {
  if (mismatch) {
    return (
      <span className="text-[0.7rem] text-amber-400 flex items-center gap-1.5 text-right">
        <AlertTriangle size={12} className="flex-shrink-0" />
        当前模型期望 {expectedDimension} 维，索引为 {vectorDimension} 维，请重建
      </span>
    )
  }
  if (vectorlessCount > 0) {
    return (
      <span className="text-[0.7rem] text-amber-400 flex items-center gap-1.5 text-right">
        <AlertTriangle size={12} className="flex-shrink-0" />
        {vectorlessCount} 个文本块缺少向量，建议重建
      </span>
    )
  }
  if (hasVectors) {
    return (
      <span className="text-[0.7rem] text-emerald-400 flex items-center gap-1.5">
        <CheckCircle2 size={12} className="flex-shrink-0" />
        向量索引完整
      </span>
    )
  }
  return (
    <span className="text-[0.7rem] text-[var(--color-text-muted)] text-right">
      未建向量索引 · 配置嵌入模型后点「重建向量索引」启用语义检索
    </span>
  )
}

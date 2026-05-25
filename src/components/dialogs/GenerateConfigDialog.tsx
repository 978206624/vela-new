import { useState, useRef, useEffect } from 'react'
import { Sparkles, Info } from 'lucide-react'
import { useLLMStore } from '../../stores/llm-store'
import { useWorkflowStore } from '../../stores/workflow-store'

import { useProjectStore } from '../../stores/project-store'
import { createConfigGenerationWorkflow } from '../../services/workflows/architecture-workflow'
import { confirm } from '../ui/Confirm'
import { toast } from '../ui/Toast'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Label } from '../ui/Label'
import { Textarea } from '../ui/Textarea'
import { Select } from '../ui/Select'
import type { NovelConfig } from '../../shared/ipc-channels'

interface Props {
  isOpen: boolean
  onClose: () => void
  /** 生成完成后回调（传入 AI 生成的配置） */
  onGenerated: (config: Partial<NovelConfig>) => void
}

/** 作品类型（generate_global_config 的 genre 枚举，留空则交给 AI 判断） */
const GENRE_OPTIONS = ['玄幻', '仙侠', '都市', '科幻', '历史', '悬疑', '游戏', '军事', '奇幻', '武侠', '现实', '其他']

/** Radix Select 不接受空字符串 value，用哨兵代表「留空让 AI 判断」 */
const GENRE_AUTO = '__auto__'

/** 目标篇幅档位 → 总章数。把开放的章数输入收敛为结构化选择（设计屏 04） */
const LENGTH_TIERS: { label: string; chapters: number }[] = [
  { label: '短篇（约 30 章）', chapters: 30 },
  { label: '中篇（约 80 章）', chapters: 80 },
  { label: '长篇（200+ 章）', chapters: 200 },
  { label: '超长篇（500+ 章）', chapters: 500 },
]

/** AI 一键配置作品 — 问题表单锁 brief：创意 + 作品类型 + 目标篇幅，结构化确认后生成 */
export default function GenerateConfigDialog({ isOpen, onClose, onGenerated }: Props) {
  const defaultModelId = useLLMStore(s => s.defaultModelId)
  // ✅ 用 getState() 获取 action，不订阅 workflow store 的 globalLogs 高频更新
  const addLog = useWorkflowStore.getState().addLog
  const startWorkflow = useWorkflowStore.getState().startWorkflow
  const currentProject = useProjectStore(s => s.currentProject)
  const updateNovelConfig = useProjectStore(s => s.updateNovelConfig)

  const [idea, setIdea] = useState('')
  const [genre, setGenre] = useState('')
  const [targetLength, setTargetLength] = useState<number>(LENGTH_TIERS[2].chapters)

  // 控制当外部 Confirm 弹窗显示时，阻止本 Dialog 因为"点击外部"而意外关闭
  const [confirming, setConfirming] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const isSubmittingRef = useRef(false)

  // 每次打开时：保留当前项目已设的精确总章数与作品类型（不塌缩/不静默丢弃），清空一次性输入
  useEffect(() => {
    if (!isOpen) return
    setTargetLength(currentProject?.novelConfig.totalChapters ?? 200)
    setGenre(currentProject?.novelConfig.genre ?? '')
    setIdea('')
  }, [isOpen, currentProject?.novelConfig.totalChapters, currentProject?.novelConfig.genre])

  const handleGenerate = async () => {
    if (!idea.trim() || isSubmittingRef.current) return
    if (!defaultModelId) {
      addLog('error', '⚠️ 请先在设置中配置 AI 模型')
      return
    }

    const chapters = targetLength || 200
    const words = currentProject?.novelConfig.wordsPerChapter || 3000

    isSubmittingRef.current = true
    setIsSubmitting(true)
    try {
      // 检测已填写的核心字段，提示用户确认覆盖
      const cfg = currentProject?.novelConfig
      const filledFields: string[] = []
      if (cfg?.coreOutline?.trim()) filledFields.push('核心大纲')
      if (cfg?.worldSetting?.trim()) filledFields.push('世界观设定')
      if (cfg?.goldenFinger?.trim()) filledFields.push('金手指体系')
      if (cfg?.protagonistProfile?.trim()) filledFields.push('主角人设')
      if (cfg?.globalGuidance?.trim()) filledFields.push('全局写作要求')
      if (cfg?.subGenre?.trim()) filledFields.push('细分类型')

      if (filledFields.length > 0) {
        setConfirming(true)
        const fieldList = filledFields.map(f => `• ${f}`).join('\n')
        const ok = await confirm(
          `以下字段已有内容，继续生成将覆盖：\n\n${fieldList}\n\n确定要重新生成吗？`,
          { title: '配置已存在', confirmText: '继续覆盖', cancelText: '取消' }
        )
        setConfirming(false)
        if (!ok) return
      }

      // 同步篇幅档位到项目配置（单一数据源，配置编辑器一并更新）
      updateNovelConfig({ totalChapters: chapters })

      // 覆盖确认通过后，立即关闭弹窗
      onClose()
      toast.info('✨ 正在根据脑洞生成小说配置...')
      addLog('info', `🤖 正在根据创作脑洞生成小说配置（规模：${chapters} 章 / ${words} 字/章${genre ? ` · ${genre}` : ''}）...`)

      // 后台执行 LLM 调用（由 WorkflowEngine 接管并显示全局状态面板）
      startWorkflow(
        createConfigGenerationWorkflow({
          idea,
          totalChapters: chapters,
          wordsPerChapter: words,
          onGenerated,
          genreHint: genre || undefined,
        })
      )
    } finally {
      isSubmittingRef.current = false
      setIsSubmitting(false)
    }
  }

  const handleOpenChange = (open: boolean) => {
    // 确认弹框期间不允许关闭
    if (!open && !confirming) onClose()
  }

  // 每次打开时预填当前项目的核心大纲作为占位提示
  const defaultIdea = currentProject?.novelConfig.coreOutline || ''

  // 目标篇幅档位：当前总章数若是精确值（不命中任一档位），保留「沿用当前 N 章」选项并默认选中，
  // 避免一键配置把用户在小说配置里精调过的章数静默改成最近档位
  const currentTotal = currentProject?.novelConfig.totalChapters ?? 200
  const lengthOptions = LENGTH_TIERS.some(t => t.chapters === currentTotal)
    ? LENGTH_TIERS
    : [{ label: `沿用当前：${currentTotal} 章`, chapters: currentTotal }, ...LENGTH_TIERS]

  // 作品类型：默认反映项目已设的 genre（避免一键配置静默让 AI 重判覆盖）；
  // 当前 genre 不在内置列表里（如屏08 选了更细分的类型）时前置为可选项
  const currentGenre = currentProject?.novelConfig.genre ?? ''
  const genreOptions = currentGenre && !GENRE_OPTIONS.includes(currentGenre)
    ? [currentGenre, ...GENRE_OPTIONS]
    : GENRE_OPTIONS

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-[520px]"
        onInteractOutside={e => {
          // 当全局 Confirm 弹窗弹出时，点击 Confirm （由于渲染在 Body）
          // 会被 Radix 误认为是 Interact Outside。因此此时屏蔽关闭事件
          if (confirming) e.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles size={16} className="text-[var(--color-accent)]" />
            AI 一键配置作品
          </DialogTitle>
          <DialogDescription>
            用一句话描述创意，AI 帮你生成完整作品配置；生成后每一项都可手动修改。
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 py-4 space-y-4">
          {/* 你的创意 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <Label>你的创意</Label>
            <Textarea
              autoFocus
              rows={4}
              placeholder={defaultIdea || '示例：一个能听见“声音”的监察局实习生，在异变笼罩的都市里追查父母失踪的真相，逐步卷入三方势力的暗战。'}
              value={idea}
              onChange={e => setIdea(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleGenerate()
              }}
            />
          </div>

          {/* 作品类型（可留空让 AI 判断） */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <Label>作品类型 <span className="text-[0.7rem] opacity-50">（可留空让 AI 判断）</span></Label>
            <Select
              value={genre || GENRE_AUTO}
              onValueChange={v => setGenre(v === GENRE_AUTO ? '' : v)}
              options={[
                { value: GENRE_AUTO, label: '（留空，让 AI 判断）' },
                ...genreOptions.map(g => ({ value: g, label: g })),
              ]}
            />
          </div>

          {/* 目标篇幅 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <Label>目标篇幅</Label>
            <Select
              value={String(targetLength)}
              onValueChange={v => setTargetLength(parseInt(v, 10))}
              options={lengthOptions.map(t => ({ value: String(t.chapters), label: t.label }))}
            />
          </div>

          {/* 生成范围说明 */}
          <div
            className="flex items-start gap-2 px-3 py-2.5 rounded-lg text-xs"
            style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-text-muted)' }}
          >
            <Info size={13} className="flex-shrink-0 mt-0.5" />
            <span>AI 将生成：作品类型 · 目标受众 · 故事模型 · 核心大纲 · 金手指设定 · 主角人设 · 文风方向。</span>
          </div>
        </div>

        <DialogFooter className="sm:justify-between items-center">
          <span className="text-xs text-[var(--color-text-muted)] mt-2 sm:mt-0">
            生成后自动填入配置表单 · ⌘↵ 快捷确认
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose}>取消</Button>
            <Button
              variant="ai"
              size="lg"
              onClick={handleGenerate}
              disabled={!idea.trim() || isSubmitting}
            >
              <><Sparkles size={13} /> AI 生成配置</>
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

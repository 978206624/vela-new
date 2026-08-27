/**
 * NextVolumeDialog — 「续写下一卷」参数向导（设计稿 31）
 *
 * 收集四项：本卷意图（可空）、结构模式、本卷章数、节奏/风格指导（可空）。
 * 提交后由调用方启动续卷工作流。
 *
 * ## 关于「本卷章数」的预填值
 *
 * 预填**上一卷的章数**（零卷惰性建卷时取已定稿章数），并如实标注来源，
 * 不冒充 AI 建议。AI 的章数意见在下一屏（结果预览）里呈现。
 *
 * 为什么不是 AI 建议：`DraftVolume.suggestedChapterCount` 是续卷工作流
 * **第 3 步的产物**，而章数是第 3 步的**输入**——向导打开时不存在任何 AI 意见。
 * 要做到「AI 建议并预填」得在向导前加一次 LLM 预调用，每次开向导都多一次
 * 模型调用与等待，收益不抵成本。
 * Spec §4.11 与 §6.5 第 3 步已按此修订（2026-08-28）。
 */
import { useId, useState } from 'react'
import { Layers, CornerDownRight, Sparkles } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle,
} from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Label } from '../ui/Label'
import { Select } from '../ui/Select'
import { Textarea } from '../ui/Textarea'
import { parseChapterCount, MAX_VOLUME_CHAPTERS } from '../../shared/volume-limits'
import type { NextVolumeParams } from '../../services/workflows/volume-workflow'

/** 与 `getPlotStructureGuide` 的 case 一一对应，顺序同小说配置里的下拉 */
const STRUCTURE_OPTIONS = [
  { value: 'three_act', label: '三幕结构' },
  { value: 'heros_journey', label: '英雄之旅' },
  { value: 'save_the_cat', label: '节拍表' },
  { value: 'kishotenketsu', label: '起承转合' },
  { value: 'multi_thread', label: '多线叙事' },
  { value: 'freeform', label: '自由结构' },
]

interface Props {
  open: boolean
  /** 承接的上一卷卷名（零卷惰性建卷时是「第一卷」） */
  prevTitle: string
  /** 上一卷末章——新卷从它的下一章开始 */
  prevEndChapter: number
  /** 上一卷章数，作为本卷章数的默认值；为 0 时回退到 50 */
  prevChapterCount: number
  /** 项目默认结构模式，作为下拉的初值 */
  defaultStructure: string
  onCancel: () => void
  onSubmit: (params: Omit<NextVolumeParams, 'orphanPolicy'>) => void
}

export default function NextVolumeDialog({
  open, prevTitle, prevEndChapter, prevChapterCount, defaultStructure, onCancel, onSubmit,
}: Props) {
  const uid = useId()
  const fallbackCount = prevChapterCount > 0 ? prevChapterCount : 50
  const [userIntent, setUserIntent] = useState('')
  const [structure, setStructure] = useState(defaultStructure || 'three_act')
  // ⚠️ 存**原始字符串**，不在 onChange 里就转成 number。
  // `Number.parseInt('1e21', 10) === 1`、`Number.parseInt('1.5', 10) === 1`——
  // 先转换再校验，等于把非法输入静默改成合法值提交，用户输 1e21 会按 1 章生成。
  // 校验必须作用在用户真正敲进去的那串字符上
  const [chapterCountInput, setChapterCountInput] = useState<string>(String(fallbackCount))
  const [pacingGuidance, setPacingGuidance] = useState('')

  // 解析走共享纯函数（见 `parseChapterCount` 的说明：为什么不能用 parseInt）
  const count = parseChapterCount(chapterCountInput)
  const startChapter = prevEndChapter + 1
  const endChapter = prevEndChapter + count
  // 章数非法时禁用提交而不是提交后报错：工作流入口那道校验会抛错，
  // 但那时对话框已经关了，用户只能在工作流面板看到一行红字。
  //
  // ⚠️ 必须 `isSafeInteger` 而不是 `isInteger`：`Number.isInteger(1e21)` 为真，
  // 但 `1e21 + 1 === 1e21`——章号运算会静默丢精度，而且这一切发生在
  // 两次分钟级 LLM 调用**之后**才暴露。**末章**也要验：起点安全不代表相加安全。
  const countValid = Number.isSafeInteger(count) && Number.isSafeInteger(endChapter)

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onCancel() }}>
      <DialogContent className="max-w-[600px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers size={16} style={{ color: 'var(--color-accent)' }} />
            续写下一卷
          </DialogTitle>
        </DialogHeader>

        <div className="px-1 py-2 space-y-4">
          {/* 承接说明：讲清楚 AI 读的是「实际写成的」而不是「当初计划的」 */}
          <div
            className="flex gap-2 rounded-md p-3 text-sm leading-relaxed"
            style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text-muted)' }}
          >
            <CornerDownRight size={15} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--color-accent)' }} />
            <span>
              将承接「{prevTitle}」（截至第 {prevEndChapter} 章）。
              AI 会读取该卷各章的<strong style={{ color: 'var(--color-text)' }}>实际写作要点</strong>、
              角色当前状态与未回收伏笔作为推演依据，而不是照着原大纲往下编。
            </span>
          </div>

          <div>
            <Label htmlFor={`${uid}-intent`}>本卷意图 <span className="text-xs font-normal" style={{ color: 'var(--color-text-muted)' }}>告诉 AI 这一卷你想写什么，留空则完全由 AI 推演</span></Label>
            <Textarea
              id={`${uid}-intent`}
              rows={3}
              value={userIntent}
              onChange={(e) => setUserIntent(e.target.value)}
              placeholder="例：这一卷让主角南下入京，把上一卷查到的线索捅到朝堂上；引入新的对立势力。"
            />
          </div>

          <div className="grid grid-cols-[1fr_180px] gap-3">
            <div>
              {/* Select 内部是 Radix Trigger（button），htmlFor 要配 id 才关联得上。
                  两者都给：可见 label 走 htmlFor，读屏器兜底走 aria-label */}
              <Label htmlFor={`${uid}-structure`}>结构模式</Label>
              <Select
                id={`${uid}-structure`}
                aria-label="结构模式"
                value={structure}
                onValueChange={setStructure}
                options={STRUCTURE_OPTIONS}
              />
            </div>
            <div>
              <Label htmlFor={`${uid}-count`}>本卷章数</Label>
              <Input
                id={`${uid}-count`}
                type="number"
                min={1}
                aria-describedby={`${uid}-count-hint`}
                aria-invalid={!countValid}
                value={chapterCountInput}
                onChange={(e) => setChapterCountInput(e.target.value)}
              />
            </div>
          </div>

          {/* 预填来源如实标注，不冒充 AI 建议（见文件头说明） */}
          <div
            id={`${uid}-count-hint`}
            role={countValid ? undefined : 'alert'}
            aria-live="polite"
            className="flex items-center gap-1.5 text-xs"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <Sparkles size={12} style={{ color: 'var(--color-accent)' }} />
            {prevChapterCount > 0
              ? `默认取上一卷的 ${prevChapterCount} 章，可改`
              : '默认 50 章，可改'}
            {countValid && (
              <>
                <span>·</span>
                <span>对应第 {startChapter}–{endChapter} 章</span>
                <span>·</span>
                <span>全书总章数将自动调整为 {endChapter}</span>
              </>
            )}
            {!countValid && (
              <span style={{ color: 'var(--color-error, #ef4444)' }}>
                · 章数须为 1–{MAX_VOLUME_CHAPTERS} 的整数，且末章不得越界
              </span>
            )}
          </div>

          <div>
            <Label htmlFor={`${uid}-pacing`}>节奏 / 风格指导 <span className="text-xs font-normal" style={{ color: 'var(--color-text-muted)' }}>可选</span></Label>
            <Textarea
              id={`${uid}-pacing`}
              rows={2}
              value={pacingGuidance}
              onChange={(e) => setPacingGuidance(e.target.value)}
              placeholder="例：前 10 章快节奏赶路遇袭，中段放缓做权谋博弈，最后 12 章拉高潮。"
            />
          </div>
        </div>

        <DialogFooter className="items-center">
          <span className="text-xs mr-auto" style={{ color: 'var(--color-text-muted)' }}>
            生成后可逐字修改，确认无误才写入
          </span>
          <Button variant="outline" onClick={onCancel}>取消</Button>
          <Button
            disabled={!countValid}
            onClick={() => onSubmit({
              userIntent: userIntent.trim(),
              structure,
              chapterCount: count,
              pacingGuidance: pacingGuidance.trim() || undefined,
            })}
          >
            <Sparkles size={14} className="mr-1" />
            生成本卷大纲
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

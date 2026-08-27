/**
 * OrphanBlueprintDialog — 惰性建卷时的孤儿蓝图处置（设计稿 34）
 *
 * 「孤儿蓝图」= 已定稿最大章号**之后**仍存在的章节蓝图。它们是按分卷前那份
 * 已闭环的大纲排定的，若直接归入新卷，会与即将生成的新主线冲突。
 *
 * 本对话框**不写任何库**：只把用户选定的策略交给调用方，由续卷工作流随
 * `CommitNextVolumePayload` 一并提交，在主进程的单次事务里执行。
 * 这是「用户在预览里点取消 = 零副作用」承诺的一部分——若这里就删蓝图，
 * 用户在后面的预览对话框点取消时，删掉的东西已经回不来了。
 */
import { useState } from 'react'
import { AlertTriangle, Info, ArrowRight } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle,
} from '../ui/Dialog'
import { Button } from '../ui/Button'
import type { OrphanPolicy } from '../../../electron/repositories/volume-commit'
import type { OrphanInfo } from '../../stores/volume-flow-store'

interface Props {
  open: boolean
  orphan: OrphanInfo
  onCancel: () => void
  onConfirm: (policy: OrphanPolicy) => void
}

export default function OrphanBlueprintDialog({ open, orphan, onCancel, onConfirm }: Props) {
  const [policy, setPolicy] = useState<OrphanPolicy>('clear')

  // 三个选项的文案都用**实际区间与条数**，不用模板占位。
  // ⚠️ 条数用 `orphan.count`（区间内实际存在的蓝图条数），不是 end-start+1——
  // 蓝图区间允许有缺口，用区间长度会多报，用户按一个虚高的数字做决定
  const options: Array<{ value: OrphanPolicy; label: string; desc: string; recommended?: boolean }> = [
    {
      value: 'clear',
      label: '清除并随新卷重新生成',
      recommended: true,
      desc: `删掉第 ${orphan.startChapter}–${orphan.endChapter} 章这 ${orphan.count} 条蓝图，`
        + '让它们随新卷大纲一并重新推演。它们是按旧主线排定的，与新卷大概率对不上。',
    },
    {
      value: 'keep',
      label: '保留旧蓝图',
      desc: `第 ${orphan.startChapter}–${orphan.endChapter} 章原样不动，新卷大纲会被要求兼容这 ${orphan.count} 章已排定的情节。`
        + '新卷的推演空间会被压缩。',
    },
    {
      value: 'extend',
      label: `把第一卷边界改到第 ${orphan.endChapter} 章`,
      desc: `这 ${orphan.count} 章归入第一卷，新卷从第 ${orphan.endChapter + 1} 章开始。`
        + '适合你认可这批蓝图、只是还没写到。',
    },
  ]

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onCancel() }}>
      <DialogContent className="max-w-[620px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle size={16} style={{ color: 'var(--color-warning, #eab308)' }} />
            检测到未写的旧蓝图
          </DialogTitle>
        </DialogHeader>

        <div className="px-1 py-2 space-y-4">
          {/* 说明条：解释这批蓝图是怎么来的、为什么要处置 */}
          <div
            className="flex gap-2 rounded-md p-3 text-sm leading-relaxed"
            style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text-muted)' }}
          >
            <Info size={15} className="flex-shrink-0 mt-0.5" />
            <span>
              第一卷按「已定稿最大章号」定为第 1–{orphan.maxFinalized} 章，
              但第 {orphan.startChapter}–{orphan.endChapter} 章已存在 {orphan.count} 条章节蓝图。
              这批蓝图按第一卷的原大纲排定，若直接归入新卷，会与即将生成的新主线冲突。
            </span>
          </div>

          <div className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
            这 {orphan.count} 条蓝图怎么处理？
          </div>

          <div className="space-y-2">
            {options.map(opt => {
              const selected = policy === opt.value
              return (
                <label
                  key={opt.value}
                  className="flex gap-3 rounded-md p-3 cursor-pointer transition-colors"
                  style={{
                    border: `1px solid ${selected ? 'var(--color-accent)' : 'var(--color-border)'}`,
                    background: selected ? 'var(--color-bg-elevated)' : 'transparent',
                  }}
                >
                  <input
                    type="radio"
                    name="orphan-policy"
                    className="mt-1 flex-shrink-0"
                    checked={selected}
                    onChange={() => setPolicy(opt.value)}
                    style={{ accentColor: 'var(--color-accent)' }}
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
                        {opt.label}
                      </span>
                      {opt.recommended && (
                        <span
                          className="text-[0.68rem] px-1.5 py-0.5 rounded"
                          style={{ background: 'var(--color-accent-soft, rgba(230,126,74,0.15))', color: 'var(--color-accent)' }}
                        >
                          推荐
                        </span>
                      )}
                    </span>
                    <span
                      className="block text-xs mt-1 leading-relaxed"
                      style={{ color: 'var(--color-text-muted)' }}
                    >
                      {opt.desc}
                    </span>
                  </span>
                </label>
              )
            })}
          </div>
        </div>

        <DialogFooter className="items-center">
          <span className="text-xs mr-auto" style={{ color: 'var(--color-text-muted)' }}>
            没有未定稿蓝图时，这一步不会出现
          </span>
          <Button variant="outline" onClick={onCancel}>取消</Button>
          <Button onClick={() => onConfirm(policy)}>
            <ArrowRight size={14} className="mr-1" />
            继续续卷
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

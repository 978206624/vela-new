import { useState } from 'react'
import { Download, FileText, Files, Type } from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { useVolumeStore, getProjectToken } from '../../stores/volume-store'
import { exportNovel, type ExportFormat, type ExportScope } from '../../services/export-service'
import { ipc } from '../../services/ipc-client'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '../ui/Dialog'
import { Button } from '../ui/Button'
import { cn } from '../../lib/utils'

interface Props {
  isOpen: boolean
  onClose: () => void
}

/** 导出对话框 — 使用 shadcn/ui */
export default function ExportDialog({ isOpen, onClose }: Props) {
  const currentProject = useProjectStore(s => s.currentProject)
  // 只在**已分卷**时才出现范围选择。单卷模式（含全部存量项目）看不到任何卷相关 UI，
  // 与 Spec §4.11「老项目零感知」一致
  const volumes = useVolumeStore(s => s.volumes)
  const [format, setFormat] = useState<ExportFormat>('merged-md')
  const [scope, setScope] = useState<ExportScope>('book')
  const [volumeNumber, setVolumeNumber] = useState<number | undefined>(undefined)
  const [includeOutline, setIncludeOutline] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [result, setResult] = useState<{ success: boolean; path?: string; error?: string } | null>(null)

  // 派生「当前项目下真正有效」的范围，而不是直接用 state。
  //
  // 挂载处已用 `key={项目token}` 保证换项目即重挂、state 回初值；这里是第二道：
  // 卷可能在**同一个项目内**被删除（卷列表删卷后卷号集合就变了），
  // 那种情况不会重挂，仍可能残留一个已不存在的卷号
  const effectiveScope: ExportScope = volumes.length > 0 ? scope : 'book'
  const effectiveVolumeNumber = effectiveScope === 'volume'
    ? (volumes.some(v => v.volumeNumber === volumeNumber) ? volumeNumber : volumes[0]?.volumeNumber)
    : undefined

  const handleExport = async () => {
    if (!currentProject) return
    // ⚠️ 在选目录对话框（一个可能开着很久的 await）之前捕获。
    // key 重挂只能重置 UI state，取消不了已经在跑的这个 Promise
    const actionToken = getProjectToken()
    const dir = await ipc.invoke('dialog:select-folder')
    if (!dir) return

    setExporting(true)
    setResult(null)
    const res = await exportNovel({
      format, outputDir: dir, includeOutline,
      scope: effectiveScope,
      volumeNumber: effectiveVolumeNumber,
      expectedToken: actionToken,
    })
    setResult(res)
    setExporting(false)
  }

  const FORMAT_OPTIONS: Array<{ value: ExportFormat; label: string; desc: string; icon: React.ReactNode }> = [
    { value: 'merged-md', label: '合并 Markdown', desc: '全书合并为单个 .md 文件', icon: <FileText size={18} /> },
    { value: 'split-md', label: '分章 Markdown', desc: '每章一个独立 .md 文件', icon: <Files size={18} /> },
    { value: 'txt', label: '纯文本 TXT', desc: '去除格式标记的纯文本', icon: <Type size={18} /> },
  ]

  return (
    <Dialog open={isOpen} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download size={16} className="text-[var(--color-accent)]" />
            导出项目
          </DialogTitle>
          <DialogDescription>选择导出格式和目标目录</DialogDescription>
        </DialogHeader>

        <div className="px-5 py-4 space-y-3">
          {/* 格式选择 */}
          <div className="space-y-2">
            {FORMAT_OPTIONS.map((opt) => (
              <div
                key={opt.value}
                onClick={() => setFormat(opt.value)}
                className={cn(
                  'flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-colors border',
                  format === opt.value
                    ? 'bg-[var(--color-active)] border-[var(--color-accent)]'
                    : 'bg-[var(--color-panel)] border-[var(--color-border)] hover:bg-[var(--color-hover)]'
                )}
              >
                <div className={cn(
                  'transition-colors',
                  format === opt.value ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-secondary)]'
                )}>
                  {opt.icon}
                </div>
                <div>
                  <div className="text-xs font-medium text-[var(--color-text)]">{opt.label}</div>
                  <div className="text-xs text-[var(--color-text-muted)]">{opt.desc}</div>
                </div>
              </div>
            ))}
          </div>

          {/* 导出范围（仅已分卷时出现） */}
          {volumes.length > 0 && (
            <div className="space-y-2 pt-1">
              <div className="text-xs font-medium text-[var(--color-text-secondary)]">导出范围</div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setScope('book')}
                  className={cn(
                    'flex-1 px-3 py-2 rounded-lg text-xs border transition-colors',
                    effectiveScope === 'book'
                      ? 'bg-[var(--color-active)] border-[var(--color-accent)] text-[var(--color-text)]'
                      : 'bg-[var(--color-panel)] border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-hover)]'
                  )}
                >
                  全书
                </button>
                <button
                  type="button"
                  onClick={() => setScope('volume')}
                  className={cn(
                    'flex-1 px-3 py-2 rounded-lg text-xs border transition-colors',
                    effectiveScope === 'volume'
                      ? 'bg-[var(--color-active)] border-[var(--color-accent)] text-[var(--color-text)]'
                      : 'bg-[var(--color-panel)] border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-hover)]'
                  )}
                >
                  按卷
                </button>
              </div>
              {effectiveScope === 'volume' && (
                <select
                  value={effectiveVolumeNumber ?? ''}
                  onChange={(e) => setVolumeNumber(Number(e.target.value))}
                  className="w-full px-3 py-2 rounded-lg text-xs bg-[var(--color-panel)] border border-[var(--color-border)] text-[var(--color-text)]"
                >
                  {volumes.map(v => (
                    <option key={v.volumeNumber} value={v.volumeNumber}>
                      第{v.volumeNumber}卷 · {v.title}（第 {v.startChapter}–{v.endChapter} 章）
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {/* 选项。**只在 merged-md 下显示**——服务层的 includeOutline 目前只在
              该分支实现（分卷前就如此，已登记待排期）。三种格式都摆出复选框，
              等于对 split-md / txt 承诺一件不会发生的事 */}
          {format === 'merged-md' && (
            <label className="flex items-center gap-2 text-xs cursor-pointer text-[var(--color-text-secondary)]">
              <input type="checkbox" checked={includeOutline} onChange={(e) => setIncludeOutline(e.target.checked)} />
              {effectiveScope === 'volume' ? '包含本卷主线与卷大纲' : '包含故事大纲'}
            </label>
          )}

          {/* 结果 */}
          {result && (
            <div className={cn(
              'p-3 rounded-lg text-xs',
              result.success ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'
            )}>
              {result.success ? `✅ 已导出到: ${result.path}` : `❌ ${result.error}`}
            </div>
          )}
        </div>

        <DialogFooter className="justify-end">
          <Button variant="default" onClick={handleExport} disabled={exporting}>
            <Download size={13} />
            {exporting ? '导出中...' : '选择目录并导出'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

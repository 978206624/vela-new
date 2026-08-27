/**
 * VolumePreviewDialog — 续卷生成结果的预览与确认（设计稿 32 / 33）
 *
 * 双栏：左边是新卷三件（卷名 / 本卷主线 / 本卷大纲），
 * 右边是上一卷的收卷状态与结转伏笔。
 *
 * ## 五类 AI 产出**全部可编辑**
 *
 * Spec §6.5 第 5 步要求：卷名、本卷主线、本卷大纲、上卷收卷状态、结转伏笔，
 * 五类都要能改。前三类是新卷内容，后两类是 AI 对上一卷的**判断**——
 * 而判断恰恰最容易错：漏判一条伏笔，它就永远不会进新卷台账，
 * 「伏笔必须回收」那条约束在后续几十章里都拿它没办法。
 * 所以右栏也得是可编辑的，不能只让人看。
 *
 * ## 为什么必须先预览再落库
 *
 * 「确认并写入」触发的是一次不可逆的事务：新建卷、全书总章数调整、
 * 卷大纲追加到情节大纲。AI 产出直接落库的话，用户只能事后手工回退这三处。
 * 与 §4.2「AI 补全人设」同口径——**AI 写的东西，落库前必须过目**。
 *
 * ## 取消 = 零副作用
 *
 * 关闭对话框会 `discardNextVolumeResult(runId)`，连同工作流延迟未写的
 * `llm_calls` 统计一并丢弃。这是工作流用 `logPolicy:'defer'` 换来的性质，
 * 本组件必须把它兑现——直接关掉而不 discard，库里会留下孤儿统计。
 *
 * ## 高度
 *
 * 伏笔合法条数上限是 200。不给视口高度约束的话，条目一多，
 * 固定定位的弹窗会顶出屏幕，底部「确认并写入」按钮点不到。
 * 故：整体 `max-height: 88vh`，头尾固定，中间双栏各自滚动。
 */
import { useId, useRef, useState } from 'react'
import { Sparkles, Info, Plus, Trash2 } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle,
} from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Label } from '../ui/Label'
import { Select } from '../ui/Select'
import { Textarea } from '../ui/Textarea'
import { MAX_OPEN_THREADS, validateOpenThreads, parseChapterNumber } from '../../shared/volume-limits'
import type { NextVolumeWorkflowResult, DraftVolume, ClosingReport } from '../../services/workflows/volume-workflow'

type Thread = ClosingReport['openThreads'][number]

const URGENCY_OPTIONS = [
  { value: 'high', label: '高' },
  { value: 'mid', label: '中' },
  { value: 'low', label: '低' },
]

interface Props {
  open: boolean
  result: NextVolumeWorkflowResult
  /** 用户在向导里定的章数——决定新卷区间，预览里只展示不可改 */
  chapterCount: number
  submitting: boolean
  onCancel: () => void
  onRegenerate: () => void
  /** 五类编辑结果一并回传：新卷三件 + 用户修订过的上一卷收束判断 */
  onConfirm: (edited: DraftVolume, closingReport: ClosingReport) => void
}

export default function VolumePreviewDialog({
  open, result, chapterCount, submitting, onCancel, onRegenerate, onConfirm,
}: Props) {
  const { prevVolume, closingReport, draftVolume } = result
  const uid = useId()

  const [title, setTitle] = useState(draftVolume.title)
  const [premise, setPremise] = useState(draftVolume.premise)
  const [synopsis, setSynopsis] = useState(draftVolume.synopsis)
  const [closingState, setClosingState] = useState(closingReport.closingState)
  /**
   * 伏笔行。带一个**稳定 id**，不用数组下标当身份。
   *
   * ⚠️ 下标是会漂移的：删掉第 2 条之后，原来的第 3 条就变成第 2 条。
   * 章号的「原始输入文本」若按下标存，删除后残留的文本会**串到另一条伏笔上**——
   * 界面显示的章号和实际要落库的 `chapter` 对不上，而校验读的是后者，
   * 用户看到一个数字、存进去另一个。
   */
  const [threads, setThreads] = useState<Array<Thread & { _id: string }>>(
    () => (closingReport.openThreads ?? []).map((t, i) => ({ ...t, _id: `t${i}` })),
  )
  /** 下一个可用的行 id。用递增计数器而非 `threads.length`——后者删完再加会撞号 */
  const nextIdRef = useRef((closingReport.openThreads ?? []).length)
  /**
   * 章号输入框的**原始字符串**，按稳定 id 存。
   * 不能只存解析后的数字：用户敲到一半的 '1.' 会被解析成 NaN，
   * 若回填数字就会把他正在敲的内容抹掉
   */
  const [chapterInputs, setChapterInputs] = useState<Record<string, string>>({})

  const volumeNumber = prevVolume.volumeNumber + 1
  const startChapter = prevVolume.endChapter + 1
  const endChapter = startChapter + chapterCount - 1

  const patchThread = (id: string, patch: Partial<Thread>) =>
    setThreads(list => list.map(t => (t._id === id ? { ...t, ...patch } : t)))

  /** 删除一行：连同它的原始输入文本一起清掉，避免残留文本被下一个同 id 的行捡走 */
  const removeThread = (id: string) => {
    setThreads(list => list.filter(t => t._id !== id))
    setChapterInputs(m => {
      const next = { ...m }
      delete next[id]
      return next
    })
  }

  // 提交前校验走**共享的纯函数**，不在组件里自己写一套——
  // 卷详情编辑器也要补录伏笔，两处判据分叉的话，分叉的那份会放行
  // 主进程要拒绝的内容。这里挡住的是「写到一半才被拒绝」：
  // 那时用户看到的是一条底层报错，而不是「第 3 条伏笔太长了」
  const threadError = validateOpenThreads(threads)
  const canSubmit = !submitting && !!title.trim() && !threadError

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !submitting) onCancel() }}>
      {/* 头尾固定、中间滚动：伏笔可达 200 条，不约束高度会把按钮顶出屏幕 */}
      <DialogContent className="max-w-[900px] flex flex-col" style={{ maxHeight: '88vh' }}>
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles size={16} style={{ color: 'var(--color-accent)' }} />
            第{volumeNumber}卷大纲 · 生成结果预览
            <span
              className="text-[0.68rem] px-1.5 py-0.5 rounded font-normal"
              style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text-muted)' }}
            >
              全部可编辑
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-[1fr_320px] gap-5 px-1 py-2 flex-1 min-h-0 overflow-hidden">
          {/* ===== 左栏：新卷三件 ===== */}
          <div className="space-y-4 min-w-0 overflow-y-auto pr-1">
            <div>
              <Label htmlFor={`${uid}-title`}>
                卷名 <span className="text-xs font-normal" style={{ color: 'var(--color-text-muted)' }}>AI 拟定 · 可改</span>
              </Label>
              <Input id={`${uid}-title`} value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>

            <div>
              <Label htmlFor={`${uid}-premise`}>
                本卷主线 <span className="text-xs font-normal" style={{ color: 'var(--color-text-muted)' }}>目标 + 核心冲突</span>
              </Label>
              <Textarea id={`${uid}-premise`} rows={4} value={premise} onChange={(e) => setPremise(e.target.value)} />
            </div>

            <div>
              <Label htmlFor={`${uid}-synopsis`}>
                本卷大纲{' '}
                <span className="text-xs font-normal" style={{ color: 'var(--color-text-muted)' }}>
                  {chapterCount} 章 · 第 {startChapter}–{endChapter} 章
                  {/* AI 对章数另有意见时如实呈现。不自动改用户定的值——
                      章数决定了已经生成出来的这份大纲的展开尺度，改了就对不上 */}
                  {draftVolume.suggestedChapterCount > 0
                    && draftVolume.suggestedChapterCount !== chapterCount
                    && ` · AI 认为 ${draftVolume.suggestedChapterCount} 章更合适（本次仍按 ${chapterCount} 章生成）`}
                </span>
              </Label>
              <Textarea id={`${uid}-synopsis`} rows={14} value={synopsis} onChange={(e) => setSynopsis(e.target.value)} />
            </div>
          </div>

          {/* ===== 右栏：上一卷收束（同样可编辑）===== */}
          <div className="space-y-4 min-w-0 overflow-y-auto pr-1">
            <div>
              <Label htmlFor={`${uid}-closing`}>
                {prevVolume.title}收束状态{' '}
                <span className="text-xs font-normal" style={{ color: 'var(--color-text-muted)' }}>AI 提炼 · 可改</span>
              </Label>
              <Textarea
                id={`${uid}-closing`}
                rows={6}
                value={closingState}
                onChange={(e) => setClosingState(e.target.value)}
                placeholder="这一卷结束时，主角与主要势力各处于什么状态"
              />
            </div>

            <div>
              <div className="flex items-center gap-2">
                <Label className="flex-1">
                  结转的未回收伏笔{' '}
                  <span className="text-xs font-normal" style={{ color: 'var(--color-text-muted)' }}>
                    {threads.length} 条 · 可增删改
                  </span>
                </Label>
                <button
                  type="button"
                  className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded hover:opacity-80"
                  style={{ color: 'var(--color-accent)' }}
                  disabled={threads.length >= MAX_OPEN_THREADS}
                  onClick={() => setThreads(l => [
                    ...l,
                    { chapter: prevVolume.startChapter, thread: '', urgency: 'mid', _id: `t${nextIdRef.current++}` },
                  ])}
                >
                  <Plus size={12} /> 补录
                </button>
              </div>

              {threads.length === 0 ? (
                /* 空态（设计稿 33）：明确说清「没有」不是「漏了」，
                   否则用户会以为 AI 分析失败 */
                <div
                  className="rounded-md p-3 text-xs leading-relaxed"
                  style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-text-muted)' }}
                >
                  <div className="mb-1" style={{ color: 'var(--color-text)' }}>
                    {prevVolume.title}没有留下未回收的伏笔
                  </div>
                  该卷埋设的线索都在卷内闭环了。若你记得还有伏笔没收，点上方「补录」加进来——
                  漏掉的伏笔不会进新卷台账，后续几十章都不会再被提醒。
                </div>
              ) : (
                <div className="space-y-1.5">
                  {threads.map((t, i) => (
                    <div
                      key={t._id}
                      className="rounded-md p-2 space-y-1.5"
                      style={{ background: 'var(--color-bg-elevated)' }}
                    >
                      <div className="flex items-center gap-1.5">
                        <label className="sr-only" htmlFor={`${uid}-th-ch-${t._id}`}>第 {i + 1} 条伏笔的埋设章号</label>
                        <Input
                          id={`${uid}-th-ch-${t._id}`}
                          type="number"
                          min={1}
                          className="w-[72px]"
                          value={chapterInputs[t._id] ?? String(t.chapter)}
                          onChange={(e) => {
                            // 存原始字符串 + 严格解析，理由同「本卷章数」：
                            // `parseInt('1.5')===1`，先转换再校验等于把用户输入静默改掉。
                            // 解析失败时写 NaN，交给 validateOpenThreads 报错并挡住提交
                            const raw = e.target.value
                            setChapterInputs(m => ({ ...m, [t._id]: raw }))
                            patchThread(t._id, { chapter: parseChapterNumber(raw) })
                          }}
                        />
                        <label className="sr-only" htmlFor={`${uid}-th-u-${t._id}`}>第 {i + 1} 条伏笔的优先级</label>
                        <Select
                          id={`${uid}-th-u-${t._id}`}
                          aria-label={`第 ${i + 1} 条伏笔的优先级`}
                          value={t.urgency}
                          onValueChange={(v) => patchThread(t._id, { urgency: v as Thread['urgency'] })}
                          options={URGENCY_OPTIONS}
                        />
                        <button
                          type="button"
                          className="ml-auto p-1 rounded hover:opacity-80"
                          style={{ color: 'var(--color-text-muted)' }}
                          title={`删除第 ${i + 1} 条伏笔`}
                          onClick={() => removeThread(t._id)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                      <label className="sr-only" htmlFor={`${uid}-th-t-${t._id}`}>第 {i + 1} 条伏笔的内容</label>
                      <Textarea
                        id={`${uid}-th-t-${t._id}`}
                        rows={2}
                        value={t.thread}
                        onChange={(e) => patchThread(t._id, { thread: e.target.value })}
                        placeholder="这条线索是什么、还欠读者一个什么交代"
                      />
                    </div>
                  ))}
                  <div className="text-xs leading-relaxed pt-1" style={{ color: 'var(--color-text-muted)' }}>
                    这些会写入第{volumeNumber}卷的「未回收伏笔」台账，并注入本卷的目录生成，
                    让「伏笔必须回收」这条约束有据可依。
                  </div>
                </div>
              )}

              {threadError && (
                <div
                  role="alert"
                  className="text-xs mt-1.5"
                  style={{ color: 'var(--color-error, #ef4444)' }}
                >
                  {threadError}
                </div>
              )}
            </div>
          </div>
        </div>

        <DialogFooter className="items-center flex-shrink-0">
          <span className="flex items-center gap-1.5 text-xs mr-auto" style={{ color: 'var(--color-text-muted)' }}>
            <Info size={12} />
            确认后写入：新建第{volumeNumber}卷 · 全书总章数调整为 {endChapter} · 追加到情节大纲
          </span>
          <Button variant="outline" disabled={submitting} onClick={onRegenerate}>重新生成</Button>
          <Button
            disabled={!canSubmit}
            onClick={() => onConfirm(
              {
                title: title.trim(),
                premise,
                synopsis,
                suggestedChapterCount: draftVolume.suggestedChapterCount,
              },
              {
                volumeNumber: closingReport.volumeNumber,
                closingState,
                // 补录时可能留下空行，提交前剔掉——空条目在台账里是纯噪声
                // 显式挑字段而非解构弃元：`_id` 是纯 UI 的行身份，不该进落库载荷。
                // 用 `({_id, ...rest}) => rest` 也行，但那个被弃的绑定会触发
                // no-unused-vars；显式列举顺带让「到底存哪几个字段」一眼可见
                openThreads: threads
                  .filter(t => t.thread.trim())
                  .map(t => ({ chapter: t.chapter, thread: t.thread, urgency: t.urgency })),
              },
            )}
          >
            {submitting ? '写入中…' : '✓ 确认并写入'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

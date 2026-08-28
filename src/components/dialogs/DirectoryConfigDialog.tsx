import { useRef, useState } from 'react'
import { FileText } from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { useVolumeStore } from '../../stores/volume-store'
import { getLastVolume, computeEffectiveTotalChapters } from '../../services/volume-service'
import { MAX_DIRECTORY_CHAPTERS, validateDirectoryRange } from '../../shared/volume-limits'
import { useWorkflowStore } from '../../stores/workflow-store'
import { toast } from '../ui/Toast'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Label } from '../ui/Label'
import { Textarea } from '../ui/Textarea'
import type { DirectoryWorkflowParams } from '../../services/workflows/directory-workflow'

interface Props {
  isOpen: boolean
  onClose: () => void
  /** 已有蓝图**条数**。只用于展示与「有没有数据」判断，**不可**拿来推追加起点 */
  existingCount: number
  /**
   * 已有蓝图的**最大章号**（无蓝图时为 0）。追加起点一律由它 +1 推导。
   *
   * ⚠️ 不能用 `existingCount + 1`：蓝图章号**允许有缺口**（用户删过中间几章、
   * 或按卷分段生成）。库里只有第 1、3 章时条数是 2，`2 + 1 = 3` 正好落在
   * 已有的第 3 章上——生成结果会 upsert 覆盖它。Agent 侧的
   * `start-workflow.tool.ts` 早就按最大章号推，UI 这条路一直是分叉的。
   */
  existingMaxChapter: number
  /**
   * 返回 true 表示工作流确实发起了；false 时对话框不关闭、也不提示「已提交」。
   *
   * `basedOnMaxChapter` 是**打开本对话框那一刻**的蓝图最大章号，也就是自定义范围
   * 默认值所依据的快照。父回调必须在真正发起前拿库里的最新值复核它——
   * 对话框开着的这段时间里，后台刷新或 Agent 工作流都可能把蓝图写进去，
   * 而默认范围不会跟着变（跟着变会把用户正在输入的值改掉），
   * 于是「51–100」这种默认值会覆盖期间新生成的第 51–60 章。
   */
  onConfirm: (
    params: DirectoryWorkflowParams,
    basedOnMaxChapter: number,
  ) => boolean | Promise<boolean>
}

/** 蓝图生成配置弹框 — 选择生成范围和模式 */
export default function DirectoryConfigDialog({ isOpen, onClose, existingCount, existingMaxChapter, onConfirm }: Props) {
  const currentProject = useProjectStore(s => s.currentProject)

  /**
   * 范围选择。`volume` = 当前卷（分卷模式专有，零卷项目不显示该 chip）。
   *
   * ⚠️ 存的是「用户**显式选过**的那个」，`null` 表示还没选过、由下面派生默认值。
   *
   * 不能直接 `useState(currentVolume ? 'volume' : 'front')`：卷表可能在对话框
   * 挂载时还是 loading（那时 `currentVolume` 为 null），随后才 ready——
   * 一次性初值会把默认永久钉在 `front` 上。派生则每次渲染都重算，
   * 卷表读到之后自动切到「当前卷」，而用户一旦点过任何 chip / 单选就固定他的选择。
   */
  const [rangeModeChoice, setRangeModeChoice] = useState<'front' | 'range' | 'full' | 'volume' | null>(null)
  // 覆盖/追加模式选择 (仅当 existingCount > 0 时有效)
  const [overwriteMode, setOverwriteMode] = useState<'append' | 'full'>('append')

  const [frontN, setFrontN] = useState<number | ''>(50)
  /**
   * ⚠️ 这两个默认值只在**首次挂载**时读 `existingMaxChapter`，
   * 所以本组件必须由调用方**条件挂载**（关闭即卸载）。
   *
   * 若常驻不卸载：生成完第 1–50 章后 prop 更新成 50，而这两个 state 仍停在
   * 「1–50」——用户重新打开、选「自定义」、什么都不改直接确认，
   * 命令就收到显式的 `startChapter:1, count:50`，把刚生成的第 1–50 章全部覆盖掉。
   *
   * 也刻意**不**用 effect 跟着 prop 走：那会在用户正在输入自定义范围时
   * 把他填的值改掉。条件挂载既保证每次打开都是最新默认值，又不打扰输入中的用户。
   */
  /**
   * **冻结**打开这一刻的最大章号。默认范围与交回父级复核的快照都用它。
   *
   * ⚠️ 不能直接用 `existingMaxChapter` prop：对话框挂载期间父组件会后台刷新，
   * prop 跟着变，而 `rangeStart/rangeEnd` 不会（跟着变会改掉用户正在输入的值）。
   * 提交时若把**当前 prop** 交回去复核，父级读库拿到的正是同一个新值、比对通过，
   * 而真正要生成的还是那段按旧值算出来的旧范围——复核形同虚设，
   * 上一轮就是这么写的，等于白做。
   *
   * 组件由调用方条件挂载（关闭即卸载），所以每次重新打开都会重新冻结。
   */
  const openedMaxChapter = useRef(existingMaxChapter).current

  const [rangeStart, setRangeStart] = useState<number | ''>(openedMaxChapter + 1)
  const [rangeEnd, setRangeEnd] = useState<number | ''>(openedMaxChapter + 50)
  // 节奏指导
  const [pacingGuidance, setPacingGuidance] = useState('')

  const isBatchRunning = useWorkflowStore(s => s.isTypeRunning('directory'))

  /**
   * 提交中锁。**ref 同步生效**，state 只负责禁用按钮。
   *
   * 改成 await onConfirm 之后，对话框在前置校验（含要等用户点的确认框）期间
   * 保持打开——快速双击「开始生成」会让两次处理都看到 `isBatchRunning === false`，
   * 各自 await 完再各自 `startWorkflow`，最终跑起两条目录工作流：
   * 重复烧模型调用，还会互相 upsert 抢同一批章。
   * 只用 state 挡不住，两次点击落在同一渲染周期里读到的都是旧值。
   */
  const submittingRef = useRef(false)
  const [submitting, setSubmitting] = useState(false)

  /**
   * 统一的关闭入口。**提交期间一律拒绝**。
   *
   * 不拦的话：点了「开始生成」、guard 还在等 → 用户点「取消」→ 组件被条件挂载卸载，
   * 但已经跑起来的 `runConfirm` **不会因此取消**，guard 一返回照样发起工作流；
   * 而它随后调的 `onClose()` 还会把用户刚重新打开的那个新弹窗一起关掉。
   * 父级的并发终检只能防「两条工作流同时跑」，恢复不了「用户已经明确取消」这个语义。
   */
  const requestClose = () => {
    if (submittingRef.current) return
    onClose()
  }

  /**
   * 「当前卷」取**最后一卷**，不是「第 existingCount+1 章所属的卷」。
   *
   * `existingCount` 是蓝图**条数**，不是最大章号——蓝图区间允许有缺口，
   * 拿条数 +1 去定位卷会在有缺口时指到错误的卷（同一个坑在 Agent 续写目录
   * 那边也踩过：必须按「现有最大章号 + 1」而不是「条数 + 1」）。
   * 而续卷刚建好的新卷正是要生成蓝图的那一卷，取末卷既无歧义又符合实际用法。
   *
   * 卷表未就绪时不显示该 chip：`volumes: []` 在 status !== 'ready' 时
   * 只代表「还没读到」，据此说「这个项目没分卷」是假消息。
   */
  const volumeStatus = useVolumeStore(s => s.status)
  const volumes = useVolumeStore(s => s.volumes)
  const currentVolume = volumeStatus === 'ready' ? getLastVolume(volumes) : null

  /**
   * 有卷时**默认锁定当前卷**（Product-Spec §6.5「范围默认锁定为本卷」，
   * 设计稿 09 里「当前卷」也是默认激活的那枚 chip）。
   *
   * 不这么做的后果不是「少个便利」：第二卷是 101–160 时，默认落在
   * 「批量连续生成 50 章」上，用户什么都不改直接提交就只生成 101–150、漏掉 151–160；
   * 当前卷不足 50 章时还会越过卷末，先提示「已提交」再在工作流里因卷覆盖不足而失败。
   */
  const rangeMode = rangeModeChoice ?? (currentVolume ? 'volume' : 'front')
  const setRangeMode = setRangeModeChoice

  if (!currentProject) return null
  /**
   * 界面文案与校验都用**有效总章数**（卷表为准），不用 novelConfig 的原始值。
   * 两者偏离时（用户手改过小说配置的总章数），界面写「全书共 50 章」
   * 而实际按卷表的 100 章提交，等于界面在承诺一件不成立的事。
   */
  const total = volumeStatus === 'ready'
    ? computeEffectiveTotalChapters(volumes, currentProject.novelConfig.totalChapters)
    : currentProject.novelConfig.totalChapters

  const handleConfirm = async () => {
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    try {
      await runConfirm()
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const runConfirm = async () => {
    // 防重复：同类型工作流正在运行
    if (isBatchRunning) {
      toast.warning('已有蓝图生成任务正在执行，请等待完成后再试')
      return
    }

    // ⚠️ 卷表未就绪一律不提交。命令层拿有效总章数时对同一状态是 **fail closed**
    //（`无法确定全书总章数`），这里若回落 novelConfig.totalChapters 去校验，
    // 就会给用户一个假的「已提交」，然后在工作流里失败。所有范围模式都受此约束——
    // 命令层无论哪种模式都要先读有效总章数
    if (volumeStatus !== 'ready') {
      toast.warning('分卷数据还没读到，请稍候再试')
      return
    }

    let params: DirectoryWorkflowParams

    if (rangeMode === 'volume') {
      // 卷区间由卷表决定，不读表单里的 rangeStart/rangeEnd——
      // 那两个框在本模式下是只读回显，用它们等于多一条可能失配的来源
      if (!currentVolume) {
        toast.warning('当前没有可用的卷，请改选其它范围')
        return
      }
      const volCount = currentVolume.endChapter - currentVolume.startChapter + 1
      // 这一支同样要校验：`MAX_VOLUME_CHAPTERS` 只约束**新写入**，
      // 老库与外部导入的库里仍可能有超长卷。不校验的话，对话框会先说「已提交」，
      // 到命令层才失败——而 Spec 要求即时报错、不提交
      const volErr = validateDirectoryRange(currentVolume.startChapter, volCount)
      if (volErr) { toast.warning(volErr); return }
      params = {
        mode: 'append',
        startChapter: currentVolume.startChapter,
        count: volCount,
      }
    } else if (rangeMode === 'full') {
      // 「全书」不显式传 count，命令层会用有效总章数当末章。校验也得按**那个推导**来，
      // 否则这条分支就绕过了上限——用户点「全书」照样能提交一个上万章的区间，
      // 一路到命令层才失败，而 Spec 要求的是「即时报错、不提交」
      const isAppend = overwriteMode !== 'full'
      // ⚠️ 追加起点用**最大章号** +1，不是条数 +1（见 Props.existingMaxChapter）
      const start = isAppend ? openedMaxChapter + 1 : 1
      const err = validateDirectoryRange(start, total - start + 1)
      if (err) { toast.warning(err); return }
      // append 时**显式传 startChapter**：不传的话命令层会按它自己重读的库内条数
      // 再推一次起点，与这里校验用的本地条数可能分叉（用户确认「从第 12 章起」、
      // 实际从第 11 章起）。发起前已挡住脏状态，此处的 existingCount 即库内条数
      params = isAppend
        ? { mode: 'append', startChapter: start, count: 0 }
        : { mode: 'full', count: 0 }
    } else if (rangeMode === 'front') {
      // ⚠️ 校验**原始输入**，不再用 `|| 50` 兜底。
      // 兜底等于把非法值悄悄改成合法值再提交：用户输入 0 会变成「生成 50 章」，
      // 而 Spec 要求的是「超出即时报错、不提交」。空输入与显式 0 分开处理。
      const count = frontN === '' ? Number.NaN : Number(frontN)
      if (!Number.isFinite(count)) { toast.warning('请填写要生成的章数'); return }
      const isAppend = existingCount > 0 && overwriteMode === 'append'
      const start = isAppend ? openedMaxChapter + 1 : 1
      const err = validateDirectoryRange(start, count)
      if (err) { toast.warning(err); return }
      params = isAppend
        ? { mode: 'append', startChapter: start, count }
        : { mode: 'full', count }
    } else {
      // 同理：不再 `|| 1` 也不再 `Math.max(start, end)`——
      // 后者会把「终点小于起点」这种明确的输入错误改写成「只生成一章」
      const start = rangeStart === '' ? Number.NaN : Number(rangeStart)
      const end = rangeEnd === '' ? Number.NaN : Number(rangeEnd)
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        toast.warning('请填写完整的起止章号'); return
      }
      if (end < start) {
        toast.warning(`结束章（第 ${end} 章）不能小于起始章（第 ${start} 章）`); return
      }
      const err = validateDirectoryRange(start, end - start + 1)
      if (err) { toast.warning(err); return }
      params = { mode: 'append', startChapter: start, count: end - start + 1 }
    }

    // ⚠️ 按**实际是否发起**决定关不关、提不提示。
    // 原先无条件 onClose + 「已提交」，于是父回调因「有未保存改动」或前置校验
    // 拒绝发起时，用户照样看到一句「正在生成」——一件根本没发生的事
    const started = await onConfirm(
      { ...params, pacingGuidance: pacingGuidance.trim() || undefined },
      openedMaxChapter,
    )
    if (!started) return
    onClose()
    toast.info('✨ 已提交：正在生成章节蓝图...')
  }

  return (
    <Dialog open={isOpen} onOpenChange={(v) => { if (!v) requestClose() }}>
      <DialogContent className="max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText size={16} className="text-[var(--color-accent)]" />
            生成章节蓝图
          </DialogTitle>
          <DialogDescription>
            {existingCount > 0
              ? `当前已存在 ${existingCount} 章蓝图，选择下一步操作：`
              : `项目共 ${total} 章，请选择生成范围：`}
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 py-4 space-y-4">
          <div>
            <Label className="text-xs font-semibold mb-2 block" style={{ color: 'var(--color-text)' }}>
              生成数量 / 范围
            </Label>
            {/* 范围快捷 chips（设计稿 09）。
                「全书 / 自定义」始终在；**只有「当前卷」**在零卷时不出现——
                零卷项目没有卷可选，而把整行一起藏掉会连带删掉另外两个快捷入口 */}
            <div className="flex items-center gap-2 mt-2 mb-3">
              <RangeChip
                active={rangeMode === 'full'}
                onClick={() => setRangeMode('full')}
                label="全书"
              />
              {currentVolume && (
                <RangeChip
                  active={rangeMode === 'volume'}
                  onClick={() => setRangeMode('volume')}
                  label={`当前卷 · 第 ${currentVolume.startChapter}–${currentVolume.endChapter} 章`}
                />
              )}
              <RangeChip
                active={rangeMode === 'range'}
                onClick={() => setRangeMode('range')}
                label="自定义"
              />
            </div>

            {rangeMode === 'volume' && currentVolume && (
              <div
                className="rounded-md px-3 py-2 text-xs mb-3"
                style={{ background: 'var(--color-panel)', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
              >
                将为「第{currentVolume.volumeNumber}卷 · {currentVolume.title || '未命名'}」生成
                第 {currentVolume.startChapter}–{currentVolume.endChapter} 章的蓝图，
                章号范围由卷表锁定、不可手改。
              </div>
            )}

            <div className="space-y-3 mt-2">
              <RadioOption
                checked={rangeMode === 'front'}
                onChange={() => setRangeMode('front')}
                label={
                  <span className="flex items-center gap-2">
                    批量连续生成
                    <Input
                      type="number"
                      value={frontN}
                      onChange={e => setFrontN(e.target.value === '' ? '' : Number(e.target.value))}
                      /* ⚠️ 刻意**没有** onBlur 修复：
                         既不用 `Math.min(total, v)` 钳制（分卷后 total 随续卷扩展，
                         拿它当上限既无意义又会误伤），也不把 0 / 负数悄悄改成 50——
                         静默改写会让提交前的校验永远看不到用户真正输入的值，
                         Spec 要求的「即时报错、不提交」就成了空话。非法值保留在框里，
                         由提交时的校验给出明确原因 */
                      className="w-16 h-6 text-xs px-2 py-0"
                      preserveEmptyOnBlur
                      max={MAX_DIRECTORY_CHAPTERS}
                      title={`单次最多 ${MAX_DIRECTORY_CHAPTERS} 章`}
                      onClick={e => e.stopPropagation()}
                    />
                    章
                  </span>
                }
              />
              <RadioOption
                checked={rangeMode === 'range'}
                onChange={() => setRangeMode('range')}
                label={
                  <span className="flex items-center gap-2">
                    指定生成：第
                    <Input
                      type="number"
                      value={rangeStart}
                      preserveEmptyOnBlur
                      onChange={e => setRangeStart(e.target.value === '' ? '' : Number(e.target.value))}
                      /* 同上：不静默修复。原先还会把「起点大于已有蓝图数 +1」改写成
                         existingCount+1——那是在替用户决定生成范围，且改完不告诉他 */
                      className="w-16 h-6 text-xs px-2 py-0"
                      onClick={e => e.stopPropagation()}
                    />
                    到 第
                    <Input
                      type="number"
                      value={rangeEnd}
                      preserveEmptyOnBlur
                      onChange={e => setRangeEnd(e.target.value === '' ? '' : Number(e.target.value))}
                      /* 同上：不静默修复。原先会把「终点小于起点」改写成「只生成一章」 */
                      className="w-16 h-6 text-xs px-2 py-0"
                      onClick={e => e.stopPropagation()}
                    />
                    章
                  </span>
                }
              />
              <RadioOption
                checked={rangeMode === 'full'}
                onChange={() => setRangeMode('full')}
                label={`全量生成（共 ${total} 章）`}
              />
              {/* 与上方 chip 是同一个 rangeMode，两处只是入口不同：
                  chips 是快捷行，单选组是完整清单。零卷时本项与 chip 一起不出现 */}
              {currentVolume && (
                <RadioOption
                  checked={rangeMode === 'volume'}
                  onChange={() => setRangeMode('volume')}
                  label={`当前卷 · 第 ${currentVolume.startChapter}–${currentVolume.endChapter} 章（共 ${currentVolume.endChapter - currentVolume.startChapter + 1} 章）`}
                />
              )}
            </div>
          </div>

          {existingCount > 0 && (
            <div
              className="rounded-lg p-3 space-y-2 mt-4"
              style={{ backgroundColor: 'var(--color-panel)', border: '1px solid var(--color-border)' }}
            >
              <p className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
                针对已有数据的处理方式：
              </p>
              <div className="space-y-3 mt-2">
                <RadioOption
                  checked={overwriteMode === 'append'}
                  onChange={() => setOverwriteMode('append')}
                  label={`追加模式：保留现有蓝图，从第 ${openedMaxChapter + 1} 章起往后生成`}
                />
                <RadioOption
                  checked={overwriteMode === 'full'}
                  onChange={() => setOverwriteMode('full')}
                  label={`覆盖模式：无视现有蓝图，从第 1 章起强制覆盖生成`}
                />
              </div>
            </div>
          )}

          {/* 节奏/风格指导（可选） */}
          <div>
            <Label className="text-xs font-semibold mb-2 block" style={{ color: 'var(--color-text)' }}>
              节奏/风格指导（可选）
            </Label>
            <Textarea
              value={pacingGuidance}
              onChange={e => setPacingGuidance(e.target.value)}
              placeholder={'如："前30章快节奏，每章安排一个爽点。中期适当铺设伏笔和角色成长。"'}
              rows={2}
              className="text-xs"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={requestClose} disabled={submitting}>取消</Button>
          <Button variant="default" onClick={() => void handleConfirm()} disabled={submitting}>
            <FileText size={13} />
            {submitting ? '提交中…' : '开始生成'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 范围快捷 chip（设计稿 09 的「全书 / 当前卷 / 自定义」那一行） */
function RangeChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs px-2.5 py-1 rounded-full transition-colors"
      style={{
        border: `1px solid ${active ? 'var(--color-accent)' : 'var(--color-border)'}`,
        color: active ? 'var(--color-accent)' : 'var(--color-text-secondary)',
        background: active ? 'rgba(var(--color-accent-rgb), 0.10)' : 'transparent',
      }}
    >
      {label}
    </button>
  )
}

/** 单选按钮选项 */
function RadioOption({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: () => void
  label: React.ReactNode
}) {
  return (
    <label
      className="flex items-center gap-2 text-xs cursor-pointer select-none"
      style={{ color: 'var(--color-text-secondary)' }}
      onClick={onChange}
    >
      <div
        className="w-3.5 h-3.5 rounded-full border flex items-center justify-center flex-shrink-0"
        style={{
          borderColor: checked ? 'var(--color-accent)' : 'var(--color-border)',
          backgroundColor: checked ? 'var(--color-accent)' : 'transparent',
        }}
      >
        {checked && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
      </div>
      {label}
    </label>
  )
}

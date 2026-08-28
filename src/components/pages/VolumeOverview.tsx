/**
 * VolumeOverview — 编辑区「分卷总览」页（设计稿 27 / 28 的右侧主区）
 *
 * 三种形态，与侧栏 `VolumeGroup` 一一对应：
 * - **未就绪**：骨架 / 失败提示。**不能拿空数组当零卷渲染**——`volumes: []` 在
 *   `status !== 'ready'` 时只代表「还没读到」，那时铺一整屏「尚未分卷」是假消息。
 * - **零卷**：居中空状态 + 「续写下一卷」CTA + 惰性建卷说明。
 * - **有卷**：各卷横向大卡。
 *
 * ## 与侧栏的分工
 *
 * 侧栏那份是**导航**（窄、只给卷名/进度）；这一页是**总览**（宽、给主线摘要与
 * 未回收伏笔数）。两处都要发起续卷，故提示分派共用
 * `describeStartFlowResult()`——判据只有一份，不会出现「侧栏不弹、这里弹」。
 *
 * ## 已写章数是展示用近似值
 *
 * 取自 `draft-store`（不额外发 IPC），而它只扫「已有蓝图的章」。
 * 用在进度条上无害；**不可**拿它当「能不能删这一卷」的授权依据
 * （那道在主进程事务里直接查 `drafts` 表）。
 */
import { useEffect, useState } from 'react'
import { Layers } from 'lucide-react'
import { Button } from '../ui/Button'
import { toast } from '../ui/Toast'
import { useVolumeStore, getProjectToken } from '../../stores/volume-store'
import { useProjectStore } from '../../stores/project-store'
import { useDraftStore } from '../../stores/draft-store'
import { ipc } from '../../services/ipc-client'
import {
  VOLUME_STATUS_LABELS,
  computeEffectiveTotalChapters,
  countFinalizedInRange,
  countFinalizedTotal,
  describeOpenThreadCount,
  getVolumeSummary,
} from '../../services/volume-service'
import { startNextVolumeFlow, describeStartFlowResult } from '../../services/volume-flow'
import { openVolumeDetail } from '../../services/volume-tabs'
import type { VolumeData, VolumeStatus } from '../../../electron/repositories/volume-repository'

/** 状态徽章配色。与侧栏 `VolumeGroup` 同一套，改一处必须改两处 */
const STATUS_COLOR: Record<VolumeStatus, string> = {
  planned: 'var(--color-text-muted)',
  writing: 'var(--color-accent)',
  done: 'var(--color-success)',
}

export default function VolumeOverview() {
  const volumes = useVolumeStore(s => s.volumes)
  const status = useVolumeStore(s => s.status)
  const projectName = useProjectStore(s => s.currentProject?.name ?? '')
  const totalChapters = useProjectStore(s => s.currentProject?.novelConfig.totalChapters ?? 0)
  // 选择器返回数字（不是新数组）：zustand v5 的快照必须稳定，
  // 返回新引用会让 useSyncExternalStore 判定「每次都变了」而反复重渲染
  const writtenTotal = useDraftStore(s => countFinalizedTotal(s.draftsByChapter))

  const [starting, setStarting] = useState(false)

  /**
   * 发起续卷。提示分派走共享的纯函数——其中 `project-switched` **刻意不弹**：
   * 那是用户自己切走的。
   */
  const handleStart = async () => {
    setStarting(true)
    try {
      const msg = describeStartFlowResult(await startNextVolumeFlow())
      if (msg) toast.error(msg)
    } finally {
      setStarting(false)
    }
  }

  // 有卷时全书总章数以**卷表**为准。规则走 volume-service 的纯函数，
  // 不在这里自己 reduce 一遍——那会让「卷表为准」有第二份实现
  const effectiveTotal = computeEffectiveTotalChapters(volumes, totalChapters)

  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ backgroundColor: 'var(--color-editor-bg)' }}>
      {/* ===== 头部 ===== */}
      <div
        className="flex items-start justify-between gap-3 px-6 py-4 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--color-border)' }}
      >
        <div className="min-w-0">
          <h2 className="text-base font-semibold" style={{ color: 'var(--color-text)' }}>分卷总览</h2>
          <div className="text-xs mt-1 truncate" style={{ color: 'var(--color-text-muted)' }}>
            {/* error 必须与 loading 分开说。两者都写「加载中」的话，
                主体已经在报「读取失败」，副标题还在说正在加载，页面自相矛盾 */}
            {status === 'error'
              ? `${projectName} · 分卷数据读取失败`
              : status !== 'ready'
                ? `${projectName} · 分卷数据加载中…`
                : volumes.length === 0
                  ? `${projectName} · 单卷模式 · 共 ${effectiveTotal} 章 · 已写 ${writtenTotal} 章`
                  : `${projectName} · 共 ${volumes.length} 卷 · ${effectiveTotal} 章 · 已写 ${writtenTotal} 章`}
          </div>
        </div>
        {/* 有卷时才在头部放 CTA：零卷态的 CTA 在空状态正中，头部再放一个是重复 */}
        {status === 'ready' && volumes.length > 0 && (
          <Button variant="ai" onClick={() => void handleStart()} disabled={starting} className="flex-shrink-0">
            <Layers size={13} />
            续写下一卷
          </Button>
        )}
      </div>

      {/* ===== 主体 ===== */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {status !== 'ready'
          ? <NotReadyBlock status={status} />
          : volumes.length === 0
            ? <ZeroVolumeState onStart={() => void handleStart()} starting={starting} />
            : (
              <div className="space-y-3">
                {volumes.map(v => <VolumeBigCard key={v.volumeNumber} volume={v} />)}
              </div>
            )}
      </div>
    </div>
  )
}

/** 加载中 / 失败。**不复用零卷态**——那会把「没读到」说成「没有卷」 */
function NotReadyBlock({ status }: { status: 'idle' | 'loading' | 'error' }) {
  if (status === 'error') {
    return (
      <div
        role="alert"
        className="rounded-lg p-4 text-sm"
        style={{ border: '1px solid var(--color-border)', color: 'var(--color-error, #ef4444)' }}
      >
        分卷数据读取失败，请重新打开项目后重试。
      </div>
    )
  }
  return (
    <div className="space-y-3">
      {[0, 1].map(i => (
        <div key={i} className="rounded-lg p-4" style={{ border: '1px solid var(--color-border)' }}>
          <div className="h-4 rounded animate-pulse mb-3" style={{ background: 'var(--color-bg-elevated)', width: '30%' }} />
          <div className="h-3 rounded animate-pulse" style={{ background: 'var(--color-bg-elevated)', width: '70%' }} />
        </div>
      ))}
    </div>
  )
}

/** 零卷态（设计稿 28 右侧）：说清「这不是缺功能，是当前就一卷」 */
function ZeroVolumeState({ onStart, starting }: { onStart: () => void; starting: boolean }) {
  /**
   * 惰性建卷会把「已定稿最大章号」当作第一卷末章（见 `buildFirstVolumeDraft`）。
   *
   * ⚠️ 用的是**最大章号**，不是「已写章数」——两者在有缺口时不相等
   * （只定稿了第 1、3 章时，前者 3、后者 2）。这行文案要预告用户即将发生的
   * 落库结果，取错就是说谎。故直接问权威来源 `db:draft-get-max-finalized-chapter`，
   * 不拿 draft-store 那份「只覆盖有蓝图的章」的近似值凑合。
   *
   * ⚠️ 三态而非「数字 + 0 兜底」：读失败时真实状态是**未知**，不是零。
   * 把 catch 写成 `setMaxFinalized(0)` 会让一次 IPC 异常显示成
   * 「还没有定稿章节」——一句可能完全不成立的断言，而用户会照它去动手。
   */
  const [maxFinalized, setMaxFinalized] = useState<
    { kind: 'loading' } | { kind: 'ready'; value: number } | { kind: 'error' }
  >({ kind: 'loading' })
  const projectPath = useProjectStore(s => s.currentProject?.path)

  useEffect(() => {
    if (!projectPath) return
    // token 在**发起前**捕获，回包落状态前复核：这一步是 await，
    // 期间切项目的话，B 的界面上会显示 A 的章号。
    // `alive` 管的是另一件事（组件已卸载 / effect 被新的一次顶掉），
    // 两道各挡各的，都不多余
    const token = getProjectToken()
    let alive = true
    // 刻意**不**在这里同步 setState 重置回 loading：
    // ① 初始值本来就是 loading；② 项目切换时 `useVolumeStore.reset()` 会把
    //    status 打回 idle，本组件随之卸载重建，不存在「带着上个项目的数字继续挂着」。
    // 而 effect 内同步 setState 会触发级联渲染（react-hooks/set-state-in-effect）
    void ipc.invoke('db:draft-get-max-finalized-chapter')
      .then(n => { if (alive && getProjectToken() === token) setMaxFinalized({ kind: 'ready', value: n ?? 0 }) })
      .catch(() => { if (alive && getProjectToken() === token) setMaxFinalized({ kind: 'error' }) })
    return () => { alive = false }
  }, [projectPath])

  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-8 py-10">
      <Layers size={40} style={{ color: 'var(--color-text-muted)', opacity: 0.5 }} />
      <div className="text-base font-semibold mt-4" style={{ color: 'var(--color-text)' }}>尚未分卷</div>
      <p
        className="text-sm leading-relaxed mt-3 max-w-[560px]"
        style={{ color: 'var(--color-text-secondary)' }}
      >
        这本书目前用一份情节大纲贯穿全书。当大纲已经写到收尾、还想继续往后写时，
        可以续写新的一卷——AI 会读取上一卷的实际写作结果（章节要点、角色状态、未回收伏笔），
        推演出承接得上的新主线。
      </p>
      <Button variant="ai" className="mt-6" onClick={onStart} disabled={starting}>
        <Layers size={13} />
        续写下一卷
      </Button>
      <div className="text-xs mt-4 min-h-[1rem]" style={{ color: 'var(--color-text-muted)' }}>
        {maxFinalized.kind === 'loading'
          // 未知时不写任何具体章号，免得先说错再改口
          ? ''
          : maxFinalized.kind === 'error'
            ? '读取已定稿进度失败，续卷时会以库中实际的定稿最大章号为准。'
            : maxFinalized.value > 0
              ? `首次续卷时，Vela 会自动把已写的第 1–${maxFinalized.value} 章登记为「第一卷」，无需手动准备。`
              : '还没有定稿章节。先写完至少一章，才能续写下一卷。'}
      </div>
    </div>
  )
}

/** 单卷大卡（设计稿 27 右侧）。点击打开该卷的详情 Tab */
function VolumeBigCard({ volume }: { volume: VolumeData }) {
  // 每张卡自己订阅，且选择器返回数字：理由同页面顶部那条注释
  const written = useDraftStore(s => countFinalizedInRange(s.draftsByChapter, volume.startChapter, volume.endChapter))
  const total = volume.endChapter - volume.startChapter + 1
  // total 理论上恒 ≥1（仓储层校验 end≥start），除零保护是防御性的
  const pct = total > 0 ? Math.round((written / total) * 100) : 0
  const threadCount = describeOpenThreadCount(volume)

  /**
   * 摘要与伏笔计数的取数规则都在 `volume-service` 的纯函数里（可测、可变异检验）：
   * - `getVolumeSummary`：premise 优先、回落 synopsis——惰性首卷的 premise 恒为空，
   *   只看它会让首卷永远显示「尚无摘要」，而它其实有大纲。
   * - `describeOpenThreadCount`：**有伏笔就写实际条数**（伏笔经
   *   `db:volume-update-threads` 独立更新，与摘要毫无绑定，用户可以在还没写大纲的卷里
   *   先补录几条）；无伏笔但有大纲写 `0`（台账已建，这是权威结论）；
   *   无伏笔且无大纲才写「—」（台账还没建，说「0 条」会被读成「已确认没有伏笔」）。
   *
   * ⚠️ 两者都空时的兜底文案**不许**写「点击续写下一卷会推演本卷主线」。
   * 「续写下一卷」以最后一卷为上一卷、创建**后一卷**，永远不会修改这张卡对应的卷——
   * 那句话是在承诺一件按钮做不到的事。
   */
  const summary = getVolumeSummary(volume)

  return (
    <div
      role="button"
      tabIndex={0}
      className="rounded-lg px-5 py-4 cursor-pointer transition-colors hover:bg-[var(--color-hover)]"
      style={{ border: '1px solid var(--color-border)' }}
      onClick={() => openVolumeDetail(volume.volumeNumber, volume.title)}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openVolumeDetail(volume.volumeNumber, volume.title)
        }
      }}
      title="打开卷详情"
    >
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold truncate" style={{ color: 'var(--color-text)' }}>
              第{volume.volumeNumber}卷 · {volume.title || '未命名'}
            </span>
            <span
              className="text-[0.68rem] px-1.5 py-0.5 rounded flex-shrink-0"
              style={{ background: 'var(--color-bg-elevated)', color: STATUS_COLOR[volume.status] }}
            >
              {VOLUME_STATUS_LABELS[volume.status]}
            </span>
          </div>

          <p
            className="text-xs leading-relaxed mt-2 line-clamp-2"
            style={{ color: summary ? 'var(--color-text-secondary)' : 'var(--color-text-muted)' }}
          >
            {summary || '（本卷尚无主线摘要。可在卷详情里手写，或等 AI 生成本卷大纲。）'}
          </p>

          <div className="flex items-center gap-4 text-xs mt-2.5" style={{ color: 'var(--color-text-muted)' }}>
            <span className="tabular-nums">第 {volume.startChapter}–{volume.endChapter} 章</span>
            <span className="tabular-nums">已写 {written} 章</span>
            <span className="tabular-nums">{threadCount === null ? '—' : `未回收伏笔 ${threadCount}`}</span>
          </div>
        </div>

        <div className="flex-shrink-0 w-[160px] pt-0.5">
          <div className="text-xl font-semibold text-right tabular-nums" style={{ color: STATUS_COLOR[volume.status] }}>
            {pct}%
          </div>
          <div className="h-1 rounded-full overflow-hidden mt-2" style={{ background: 'var(--color-bg-elevated)' }}>
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${pct}%`, background: STATUS_COLOR[volume.status] }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

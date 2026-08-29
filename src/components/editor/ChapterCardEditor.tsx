import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  Save, BookOpen, RefreshCw, Plus, Trash2,
  Sparkles, PenLine, Layers
} from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { useLayoutStore } from '../../stores/layout-store'
import { useDraftStore } from '../../stores/draft-store'
import { ipc } from '../../services/ipc-client'
import {
  loadDirectoryBlueprints,
  saveChapterBlueprint,
  saveAllBlueprints,
  createDirectoryWorkflow,
  normalizeTargetWords,
  type ChapterBlueprint,
  type DirectoryWorkflowParams,
} from '../../services/workflows/directory-workflow'
import { guardDirectoryGeneration } from '../../services/workflow-guards'
import { getProjectToken, useVolumeStore } from '../../stores/volume-store'
import { VOLUME_STATUS_LABELS, groupChaptersByVolume } from '../../services/volume-service'
import DirectoryConfigDialog from '../dialogs/DirectoryConfigDialog'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Textarea } from '../ui/Textarea'
import { Label } from '../ui/Label'
import { Select } from '../ui/Select'
import { cn } from '../../lib/utils'
import { toast } from '../ui/Toast'
import { confirm } from '../ui/Confirm'
import { globalEventBus } from '../../shared/event-bus'
import { CHAPTER_ROLES, CHAPTER_ROLE_COLORS, coerceChapterRole } from '../../shared/chapter-roles'

// 章节定位常量（7 项口径 + 配色）已迁至 src/shared/chapter-roles.ts，统一引用

interface ChapterCardEditorProps {
  /** 从某卷子菜单打开时锁定该卷；未设置时维持全书视图 */
  volumeNumber?: number
  /** 范围外章节的异常数据视图 */
  chapterScope?: 'unassigned'
}

/** 章节蓝图编辑器 — 读写 directory.json */
export default function ChapterCardEditor({ volumeNumber, chapterScope }: ChapterCardEditorProps) {
  const currentProject = useProjectStore(s => s.currentProject)
  // 实际已写字数来源：订阅各章草稿元数据（草稿增删/定稿时变化，非流式高频，重渲染可接受）
  const draftsByChapter = useDraftStore(s => s.draftsByChapter)
  // ✅ action 用 getState() 获取，不订阅 workflow store 高频更新
  const startWorkflow = useWorkflowStore.getState().startWorkflow
  const addLog = useWorkflowStore.getState().addLog
  // 仅订阅「目录工作流是否在跑」这个布尔（仅启停时翻转 → 仅翻转时重渲染，不受步进高频更新影响）
  const isGenerating = useWorkflowStore(s => s.isTypeRunning('directory'))
  const [blueprints, setBlueprints] = useState<ChapterBlueprint[]>([])
  const [selectedIdx, setSelectedIdx] = useState<number>(0)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [dirty, setDirty] = useState(false)
  // dirty 的 ref 镜像：供 loadBlueprints（useCallback，不依赖 dirty）读取最新值，避免后台刷新覆盖用户未保存编辑
  const dirtyRef = useRef(false)
  useEffect(() => { dirtyRef.current = dirty }, [dirty])
  // blueprints 的 ref 镜像：后台刷新要拿「刷新前那一份」把选中章号找回来，
  // 而 loadBlueprints 是 useCallback、不依赖 blueprints（依赖了会每次重建、触发重载循环）
  const blueprintsRef = useRef<ChapterBlueprint[]>([])
  /**
   * 本地编辑版本号。**同步**递增，与 `dirtyRef` 的区别是它不滞后。
   *
   * `dirtyRef` 靠 `useEffect` 镜像 `dirty`，慢一拍；而后台刷新的危险窗口恰恰在
   * `await` 期间：刷新开始时不脏 → IPC 还没回来时用户改了标题 → 回包落地，
   * 用数据库旧值把刚打的字盖掉。`dirty` 此时甚至还是 true，界面显示「未保存」，
   * 内容却已经没了。故在**每一处本地编辑**同步 +1，回包前比对。
   */
  const editRevRef = useRef(0)
  /** 统一的「用户改了」入口：置脏 + 同步递增版本号 */
  const markDirty = () => { editRevRef.current += 1; setDirty(true) }
  // 下一个可写的章节号
  const [nextWriteChapter, setNextWriteChapter] = useState<number | null>(null)

  // 蓝图生成弹窗（替代原 inline 批量面板）
  const [showBlueprintDialog, setShowBlueprintDialog] = useState(false)

  const loadBlueprints = useCallback(async (opts?: { background?: boolean }) => {
    if (!currentProject) return
    // 后台模式（生成期间增量刷新）：不切全屏 loading、不重置选中、不清 dirty，避免闪烁/选中跳回/丢未保存编辑
    const background = opts?.background === true
    // 用户有未保存编辑时，后台刷新直接跳过——绝不用数据库数据覆盖正在编辑的表单内容
    if (background && dirtyRef.current) return
    // 版本号在**发起读取之前**定格，回包落地前比对（见 editRevRef 的注释）
    const revAtStart = editRevRef.current
    if (!background) setLoading(true)
    try {
      const data = await loadDirectoryBlueprints()
      // ⚠️ await 之后必须再判一次：读取期间用户完全可能动了表单，
      // 而 `dirtyRef` 滞后一拍、这里靠不住。发生过编辑就整个丢弃这次后台响应
      if (background && (dirtyRef.current || editRevRef.current !== revAtStart)) return
      // role 加载兜底（Phase 18）：列表外值经 coerceChapterRole 归一，显示与手动保存都只写规范值
      const normalized = data.map(b => ({ ...b, role: coerceChapterRole(b.role) }))
      // 后台刷新时用**章号**找回选中项，不能留着旧下标。
      // 蓝图按章号排序，后台新生成一章若插在选中项**之前**，
      // 同一个下标就指到了另一章——用户眼前的表单静默换了个人，毫无提示
      setSelectedIdx(prevIdx => {
        if (!background) return normalized.length > 0 ? 0 : 0
        const prevChapter = blueprintsRef.current[prevIdx]?.chapterNumber
        if (prevChapter === undefined) return Math.min(prevIdx, Math.max(0, normalized.length - 1))
        const found = normalized.findIndex(b => b.chapterNumber === prevChapter)
        // 选中的那一章被删了 → 退回相邻位置，别把选中态跳回第一章
        return found >= 0 ? found : Math.min(prevIdx, Math.max(0, normalized.length - 1))
      })
      setBlueprints(normalized)
      // 获取下一个待写章节号
      const maxFinalized = await ipc.invoke('db:draft-get-max-finalized-chapter')
      setNextWriteChapter(maxFinalized !== null ? maxFinalized + 1 : 1)
    } catch {
      addLog('error', '读取章节蓝图失败')
    }
    if (!background) {
      setLoading(false)
      setDirty(false)
    }
  }, [currentProject, addLog])

  useEffect(() => {
    let mounted = true
    Promise.resolve().then(() => { if (mounted) loadBlueprints() })
    return () => { mounted = false }
  }, [loadBlueprints])

  // 监听工作流完成事件，如果蓝图生成完毕则自动刷新。
  //
  // ⚠️ 必须走 `background: true`。前台刷新会**绕过 dirtyRef 保护**、把选中重置到第 1 项、
  // 并在末尾 setDirty(false)：用户在流式生成期间点开某一章改了两笔还没保存，
  // 最后一批一完成，库里的旧值就把他的编辑盖掉、未保存标记也一并消失。
  // 生成期间的增量刷新本来就是后台的，完成事件没理由是前台的。
  // 手动点「重新加载」仍保留前台语义（那是用户明确要求丢弃本地状态）。
  useEffect(() => {
    return globalEventBus.on('WORKFLOW_COMPLETE', (payload) => {
      if (payload.type === 'directory') {
        loadBlueprints({ background: true })
      }
    })
  }, [loadBlueprints])

  // 蓝图生成过程中按批/逐条增量重载（directory.command 流式入库后 emit），实现动态出现。
  // 走后台刷新：不闪全屏 loading、不把选中跳回第 1 章、不清未保存编辑
  useEffect(() => {
    return globalEventBus.on('REFRESH_RESOURCE', (p) => {
      if (p.resources.includes('blueprints') || p.resources.includes('all')) {
        loadBlueprints({ background: true })
      }
    })
  }, [loadBlueprints])

  useEffect(() => { blueprintsRef.current = blueprints }, [blueprints])

  /**
   * 蓝图按卷分组（改造屏 11）。**零卷时不分组**，维持原样渲染。
   *
   * 列表项带上它在 `blueprints` 里的原下标：选中态用的是下标，
   * 分组后若按组内序号重新编号，点第二卷的第一章会选中第一卷的第一章。
   *
   * 卷表未就绪时按不分组处理：`volumes: []` 在 status !== 'ready' 时
   * 只代表「还没读到」，此刻硬分组会先闪一次「全部未归卷」。
   */
  const volumeStatus = useVolumeStore(s => s.status)
  const volumes = useVolumeStore(s => s.volumes)
  const targetVolume = volumeNumber === undefined
    ? null
    : volumes.find(v => v.volumeNumber === volumeNumber) ?? null
  const scoped = volumeNumber !== undefined || chapterScope === 'unassigned'
  const volumeGroups = useMemo(() => {
    const indexed = blueprints.map((bp, idx) => ({ bp, idx, chapterNumber: bp.chapterNumber }))
    if (volumeNumber !== undefined) {
      const volume = volumes.find(v => v.volumeNumber === volumeNumber) ?? null
      let items = volume === null
        ? []
        : indexed.filter(item => item.chapterNumber >= volume.startChapter && item.chapterNumber <= volume.endChapter)
      const editing = dirty ? indexed[selectedIdx] : undefined
      if (editing && !items.some(item => item.idx === editing.idx)) {
        items = [...items, editing].sort((a, b) => a.chapterNumber - b.chapterNumber)
      }
      return [{ volume, items }]
    }
    if (chapterScope === 'unassigned') {
      let items = volumeStatus !== 'ready'
        ? []
        : indexed.filter(item => !volumes.some(
            v => item.chapterNumber >= v.startChapter && item.chapterNumber <= v.endChapter,
          ))
      const editing = dirty ? indexed[selectedIdx] : undefined
      if (editing && !items.some(item => item.idx === editing.idx)) {
        items = [...items, editing].sort((a, b) => a.chapterNumber - b.chapterNumber)
      }
      return [{ volume: null, items }]
    }
    if (volumeStatus !== 'ready' || volumes.length === 0) {
      return [{ volume: null, items: indexed }]
    }
    return groupChaptersByVolume(indexed, volumes)
  }, [blueprints, chapterScope, dirty, selectedIdx, volumeNumber, volumes, volumeStatus])
  const visibleIndexes = useMemo(
    () => volumeGroups.flatMap(group => group.items.map(item => item.idx)),
    [volumeGroups],
  )
  const effectiveSelectedIdx = visibleIndexes.includes(selectedIdx)
    ? selectedIdx
    : (visibleIndexes[0] ?? -1)
  const selected = effectiveSelectedIdx >= 0 ? blueprints[effectiveSelectedIdx] ?? null : null
  /** 只有一组且无卷 = 未分卷，渲染时不插分组头 */
  const grouped = scoped || volumeGroups.length > 1 || volumeGroups[0]?.volume !== null
  const visibleBlueprintCount = visibleIndexes.length
  const editorTitle = targetVolume
    ? `第${targetVolume.volumeNumber}卷 · 章节蓝图`
    : volumeNumber !== undefined
      ? `第${volumeNumber}卷 · 章节蓝图`
    : chapterScope === 'unassigned'
      ? '未归卷章节 · 蓝图'
      : '章节蓝图'
  const scopedNextWriteChapter = nextWriteChapter !== null
    && chapterScope !== 'unassigned'
    && (volumeNumber === undefined
      || (targetVolume !== null
        && nextWriteChapter >= targetVolume.startChapter
        && nextWriteChapter <= targetVolume.endChapter))
    ? nextWriteChapter
    : null

  // 每章实际已写字数：定稿优先、否则最新草稿（version 降序首条）的 word_count。useMemo 限制重复计算。
  const actualWordsByChapter = useMemo(() => {
    const m: Record<number, number> = {}
    for (const [ch, list] of Object.entries(draftsByChapter)) {
      const fin = list.find(d => d.status === 'finalized')
      m[Number(ch)] = (fin ?? list[0])?.wordCount ?? 0
    }
    return m
  }, [draftsByChapter])

  /** 更新选中章节蓝图的字段 */
  const updateField = <K extends keyof ChapterBlueprint>(key: K, value: ChapterBlueprint[K]) => {
    if (selectedIdx !== effectiveSelectedIdx) setSelectedIdx(effectiveSelectedIdx)
    setBlueprints(prev =>
      prev.map((b, i) => (i === effectiveSelectedIdx ? { ...b, [key]: value } : b))
    )
    markDirty()
  }

  /** 保存当前章节蓝图 */
  const handleSaveOne = async () => {
    if (!currentProject || !selected) return
    setSaving(true)
    // 跟随全局语义：目标字数经 normalizeTargetWords（=全局或空 → 0），与弹窗写回口径一致
    const toSave = { ...selected, targetWords: normalizeTargetWords(selected.targetWords, currentProject.novelConfig.wordsPerChapter) }
    await saveChapterBlueprint(toSave)
    // 同步本地状态为归一后的值，避免"输入全局值保存后仍显示正数(像钉住)"与 0=跟随全局 UI 不一致
    setBlueprints(prev => prev.map((b, i) => (i === effectiveSelectedIdx ? toSave : b)))
    setSaving(false)
    setDirty(false)
    addLog('info', `✅ 第 ${selected.chapterNumber} 章蓝图已保存`)
  }

  /** 全量保存（每章写入独立 JSON 文件） */
  const handleSaveAll = async () => {
    if (!currentProject) return
    setSaving(true)
    const toSaveAll = blueprints.map(b => ({ ...b, targetWords: normalizeTargetWords(b.targetWords, currentProject.novelConfig.wordsPerChapter) }))
    const res = await saveAllBlueprints(toSaveAll)
    // 必须检查返回值：写库失败时若照常清 dirty 并报「已保存」，
    // 用户会以为改动落了盘，实际关掉编辑器就全丢了
    if (!res.success) {
      setSaving(false)
      addLog('error', `❌ 保存蓝图失败：${res.error ?? '未知错误'}`)
      return   // 保留 dirty，让用户能重试
    }
    setBlueprints(toSaveAll)  // 同步归一后的值（理由同 handleSaveOne）
    setSaving(false)
    setDirty(false)
    addLog('info', `✅ 已保存全部 ${blueprints.length} 章蓝图`)
  }

  /** 新建空章节 */
  const handleAddChapter = () => {
    if (chapterScope === 'unassigned') return
    if (volumeNumber !== undefined && targetVolume === null) {
      toast.warning('这卷已不存在，请从侧栏重新打开章节蓝图')
      return
    }
    let newChapterNumber: number
    if (targetVolume) {
      const occupied = new Set(blueprints.map(b => b.chapterNumber))
      let firstMissing: number | null = null
      for (let chapter = targetVolume.startChapter; chapter <= targetVolume.endChapter; chapter += 1) {
        if (!occupied.has(chapter)) {
          firstMissing = chapter
          break
        }
      }
      if (firstMissing === null) {
        toast.warning('本卷章号范围内已没有可新增的章节')
        return
      }
      newChapterNumber = firstMissing
    } else {
      newChapterNumber = blueprints.reduce((m, b) => Math.max(m, b.chapterNumber), 0) + 1
    }
    const newBlueprint: ChapterBlueprint = {
      chapterNumber: newChapterNumber,
      title: '',
      role: '发展',
      purpose: '',
      keyEvents: '',
      characters: [],
      suspenseHook: '',
      userGuidance: '',
      notes: '',
      notesUpdatedAt: '',
      targetWords: 0,
    }
    const nextBlueprints = [...blueprints, newBlueprint].sort((a, b) => a.chapterNumber - b.chapterNumber)
    setBlueprints(nextBlueprints)
    setSelectedIdx(nextBlueprints.findIndex(b => b.chapterNumber === newChapterNumber))
    markDirty()
  }

  /** 删除选中章节 */
  const handleDeleteChapter = async () => {
    if (!selected) return
    const ok = await confirm(`确认删除第 ${selected.chapterNumber} 章蓝图？\n此操作不可撤销。`, {
      title: '删除章节蓝图',
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    const newList = blueprints.filter((_, i) => i !== effectiveSelectedIdx)
    setBlueprints(newList)
    setSelectedIdx(Math.max(0, effectiveSelectedIdx - 1))
    markDirty()
  }

  /** 触发蓝图批量生成（来自 DirectoryConfigDialog 的确认回调） */
  const handleBatchGenerate = async (
    params: DirectoryWorkflowParams,
    basedOnMaxChapter: number,
  ): Promise<boolean> => {
    if (!currentProject) return false

    // ⚠️ 有未保存编辑时不许发起生成。
    // 对话框按**本地**蓝图推「从第几章追加」，而命令层会重新读库再推一次——
    // 本地多出一条没保存的蓝图，两者就分叉：用户在对话框上确认的是
    // 「从第 12 章起」，实际生成的是「从第 11 章起」，之后保存本地那一章
    // 还会盖掉刚生成的结果。
    if (dirty) {
      toast.warning('有未保存的蓝图改动，请先保存或重新加载，再发起生成')
      return false
    }
    // 编辑版本在**动作入口**定格。下面的 guard 与 confirm 都是长 await
    //（确认框要等用户点），期间用户完全可以回去改蓝图；只在入口查一次挡不住那段窗口
    const revAtStart = editRevRef.current

    // ⚠️ 在**任何 await 之前**捕获。下面的 guard 与 confirm 都是长 await
    //（确认框要等用户点），期间完全可能切项目；等到 createDirectoryWorkflow()
    // 里才捕获，会拿到切换后项目的**合法 token**，主进程守卫识别不出来
    const actionToken = getProjectToken()

    // 前置校验：故事架构是否就绪
    const guard = await guardDirectoryGeneration()
    if (!guard.ok) {
      // 校验失败：阻断并提示
      addLog('error', `⚠️ 前置条件未满足：${guard.message}`)
      toast.warning(`无法出发：${guard.message}`)
      return false
    }
    if (guard.message) {
      // 有警告但允许继续：弹出确认
      const yes = await confirm(`${guard.message}

是否仍要继续生成？`, {
        title: '前置条件警告',
        confirmText: '继续生成',
      })
      if (!yes) return false
    }

    // 蓝图快照复核：对话框开着的这段时间里，后台刷新或 Agent 工作流都可能把新蓝图
    // 写进库，而对话框的自定义范围默认值**不会**跟着变（跟着变会把用户正在输入的值
    // 改掉）。于是「从第 51 章起生成 50 章」这种按旧快照算出来的默认范围，
    // 会覆盖期间新生成的第 51–60 章。拿**库里**的最新最大章号跟对话框
    // 打开那一刻冻结的快照比，变了就拒绝发起。
    //
    // ⚠️ 这里**直接打 IPC**，不用 `loadDirectoryBlueprints()`：那个 helper 内部
    // 吞掉所有读取异常并返回 `[]`，外层 catch 根本接不到——零蓝图项目（快照为 0）
    // 遇到读库失败时会算出 `latestMax = 0`、比对通过、照常发起，
    // 「无法核对就不生成」这条 fail-closed 就成了空话。
    let latestMax: number
    try {
      const latest = await ipc.invoke('db:blueprint-get-all')
      latestMax = latest.reduce((m, b) => Math.max(m, b.chapterNumber), 0)
    } catch {
      toast.error('无法核对章节蓝图的最新状态，本次生成已取消')
      return false
    }
    if (latestMax !== basedOnMaxChapter) {
      toast.warning(`章节蓝图在配置期间发生了变化（最大章号 ${basedOnMaxChapter} → ${latestMax}），请关闭后重新打开配置`)
      return false
    }

    // ⚠️ token 与编辑版本的复核放在**最后一次 await 之后**。
    // 放在快照读库之前的话，读库那几十毫秒里切了项目，异步函数并不会因为
    // 组件卸载而取消——两个项目的最大章号恰好相同时比对还会通过，
    // 于是在 B 项目里起一条带着 A 的 token 的工作流、还提示「已提交」。
    // 下游的 token 守卫能挡住模型调用与写库，但挡不住 B 里多出一条注定失败的工作流。
    if (getProjectToken() !== actionToken) {
      addLog('error', '⚠️ 项目已切换，本次生成已取消')
      toast.warning('项目已切换，前置检查结果已失效，请重新发起生成。')
      return false
    }
    // 用户可能在 guard/确认那段等待里新建或改了蓝图——那时 params 里的追加起点
    // 是按等待**之前**的蓝图算的，生成结果会与本地未保存内容冲突，
    // 之后保存本地那一章还会盖掉刚生成的
    if (editRevRef.current !== revAtStart || dirtyRef.current) {
      toast.warning('蓝图在确认期间被改过，请先保存或重新加载，再重新发起生成')
      return false
    }

    // 并发终检：guard 与确认框都是长 await，期间别的入口（或另一次点击）
    // 可能已经把目录工作流跑起来了。workflow-store 允许并发、startWorkflow
    // 自己不去重，不查这一下就会有两条工作流重复烧模型并抢着 upsert 同一批章
    if (useWorkflowStore.getState().isTypeRunning('directory')) {
      toast.warning('已有蓝图生成任务正在执行，请等待完成后再试')
      return false
    }
    startWorkflow(createDirectoryWorkflow(params, actionToken))
    addLog('info', '🚀 已启动章节蓝图生成')
    return true
  }

  /**
   * 写作此章 — 将当前蓝图信息注入创作弹窗
   * 支持指定章节（默认为当前选中章）
   */
  const handleWriteChapter = (bp: ChapterBlueprint) => {
    // 通过 layout-store openChapterCreation 传递预填参数，替代 window.dispatchEvent
    useLayoutStore.getState().openChapterCreation({
      chapterNumber: bp.chapterNumber,
      title: bp.title,
      role: bp.role,
      purpose: bp.purpose,
      keyEvents: bp.keyEvents,
      characters: bp.characters.join('、'),
      userGuidance: bp.userGuidance || '',
      // 带上蓝图有效目标字数（弹窗预填，蓝图单一数据源）
      wordsTarget: bp.targetWords > 0 ? bp.targetWords : (currentProject?.novelConfig.wordsPerChapter || 3000),
    })
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full gap-2" style={{ color: 'var(--color-text-muted)' }}>
        <RefreshCw size={16} className="animate-spin" /> 加载章节蓝图...
      </div>
    )
  }

  if (!currentProject) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 opacity-40">
        <BookOpen size={36} />
        <span className="text-sm">请先打开项目</span>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* 顶部工具栏 */}
      <div
        className="flex items-center justify-between gap-2 px-3 h-10 flex-shrink-0 border-b"
        style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-sidebar)' }}
      >
        <div className="flex items-center gap-1.5">
          <BookOpen size={13} style={{ color: 'var(--color-text-muted)' }} />
          <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
            {editorTitle}
            {visibleBlueprintCount > 0 && (
              <span style={{ color: 'var(--color-text-muted)' }} className="ml-1 font-normal">
                ({visibleBlueprintCount} 章)
              </span>
            )}
          </span>
          {dirty && <span className="text-[0.7rem]" style={{ color: 'var(--color-accent)' }}>● 未保存</span>}
        </div>
        <div className="flex items-center gap-1">
          {/* 写作入口 — 仅下一章可写时显示 */}
          {scopedNextWriteChapter !== null && (
            <Button
              variant="ai"
              size="sm"
              onClick={() => {
                const bp = blueprints.find(b => b.chapterNumber === scopedNextWriteChapter)
                if (bp) handleWriteChapter(bp)
              }}
            >
              <PenLine size={12} />
              写作第{scopedNextWriteChapter}章
            </Button>
          )}
          {/* AI 生成蓝图 → 弹出 DirectoryConfigDialog；生成中显示 loading 并禁用 */}
          {chapterScope !== 'unassigned' && (volumeNumber === undefined || targetVolume !== null) && (
            <Button
              variant="ai"
              size="sm"
              onClick={() => setShowBlueprintDialog(true)}
              disabled={isGenerating}
              title={isGenerating ? '正在生成章节蓝图...' : 'AI 生成章节蓝图（选择范围和模式）'}
            >
              {isGenerating ? <RefreshCw size={12} className="animate-spin" /> : <Sparkles size={12} />}
              {isGenerating ? '生成中...' : 'AI 生成蓝图'}
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={() => loadBlueprints()} title="重新加载" disabled={loading}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </Button>
          {chapterScope !== 'unassigned' && (volumeNumber === undefined || targetVolume !== null) && (
            <Button variant="ghost" size="icon" onClick={handleAddChapter} title="新建章节">
              <Plus size={14} />
            </Button>
          )}
          {dirty && (
            <Button variant="outline" size="sm" onClick={handleSaveAll} disabled={saving}>
              <Save size={12} /> {saving ? '保存中...' : '保存全部'}
            </Button>
          )}
        </div>
      </div>

      {/* 蓝图生成配置弹窗 */}
      {/* ⚠️ **条件挂载**：关闭即卸载。对话框的自定义范围默认值只在挂载时读
          existingMaxChapter，常驻不卸载会让它停在上一次的旧值——
          用户重开后不改直接确认，就会用陈旧起点覆盖刚生成的蓝图 */}
      {showBlueprintDialog && <DirectoryConfigDialog
        isOpen={showBlueprintDialog}
        onClose={() => setShowBlueprintDialog(false)}
        existingCount={blueprints.length}
        existingMaxChapter={blueprints.reduce((m, b) => Math.max(m, b.chapterNumber), 0)}
        volumeNumber={volumeNumber}
        onConfirm={handleBatchGenerate}
      />}

      {/* 主区域：左侧列表 + 右侧编辑 */}
      <div className="flex-1 flex overflow-hidden">
        {/* 左侧章节列表 */}
        <div
          className="flex flex-col flex-shrink-0 w-[200px] border-r overflow-hidden"
          style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-sidebar)' }}
        >
          {/* ⚠️ 只有「**零卷**且无蓝图」才走全局空态。
              分了卷但一条蓝图都还没生成时，仍要把各卷的分组头渲染出来——
              那些组头在说「这一卷还没生成蓝图」，一并藏掉等于把分卷这件事也藏了 */}
          {visibleBlueprintCount === 0 && !grouped ? (
            <div className="flex flex-col items-center justify-center flex-1 gap-3 opacity-40 p-4">
              <BookOpen size={28} />
              <span className="text-xs text-center">暂无蓝图，点击「AI 生成」开始</span>
            </div>
          ) : (
          <div className="flex-1 overflow-y-auto p-1">
            {volumeGroups.map(g => (
              <div key={g.volume ? `v${g.volume.volumeNumber}` : "unassigned"}>
                {/* 分卷分组头（改造屏 11）。零卷时整段不渲染，维持原样 */}
                {grouped && (
                  <div className="flex items-center gap-1.5 px-1.5 pt-2 pb-1">
                    <Layers size={11} style={{ color: "var(--color-text-muted)", flexShrink: 0 }} />
                    <span className="text-[0.68rem] truncate" style={{ color: "var(--color-text)" }}>
                      {g.volume
                        ? `第${g.volume.volumeNumber}卷 · ${g.volume.title || "未命名"}`
                        : "未归卷"}
                    </span>
                    <span className="text-[0.65rem] flex-shrink-0 tabular-nums" style={{ color: "var(--color-text-muted)" }}>
                      {g.volume ? `第 ${g.volume.startChapter}–${g.volume.endChapter} 章` : `${g.items.length} 章`}
                    </span>
                    {g.volume && (
                      <span
                        className="text-[0.62rem] px-1 py-0.5 rounded flex-shrink-0"
                        style={{ background: "var(--color-bg-elevated)", color: "var(--color-text-muted)" }}
                      >
                        {VOLUME_STATUS_LABELS[g.volume.status]}
                      </span>
                    )}
                    {/* 延伸分隔线 */}
                    <div className="flex-1 h-px" style={{ background: "var(--color-border)" }} />
                  </div>
                )}
                {/* 空卷也保留分组头：它在说「这一卷还没生成蓝图」 */}
                {grouped && g.items.length === 0 && (
                  <div className="px-2.5 py-1.5 text-[0.68rem]" style={{ color: 'var(--color-text-muted)' }}>
                    {chapterScope === 'unassigned' ? '没有未归卷的章节蓝图' : '本卷还没有章节蓝图'}
                  </div>
                )}
                {g.items.map(({ bp, idx }) => (
                <div
                  key={bp.chapterNumber}
                  className={cn(
                    'group relative px-2.5 py-2 rounded-md text-xs cursor-pointer mb-0.5 transition-colors',
                    effectiveSelectedIdx === idx
                      ? 'bg-[var(--color-active)] text-[var(--color-text)]'
                      : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-hover)]'
                  )}
                  onClick={() => setSelectedIdx(idx)}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[0.7rem] opacity-40 flex-shrink-0">
                      {bp.chapterNumber}
                    </span>
                    <span className="font-medium truncate flex-1">{bp.title || '未命名'}</span>
                  </div>
                  <div className="flex items-center gap-1 mt-0.5">
                    <span className={cn(
                      'text-[0.7rem] px-1 py-0.5 rounded',
                      CHAPTER_ROLE_COLORS[bp.role] || 'bg-[var(--color-hover)] text-[var(--color-text-muted)]'
                    )}>
                      {bp.role}
                    </span>
                    <span
                      className="text-[0.7rem] px-1 py-0.5 rounded font-mono"
                      style={{ color: 'var(--color-text-muted)' }}
                      title="已写 / 目标字数"
                    >
                      {actualWordsByChapter[bp.chapterNumber] ?? 0}/{bp.targetWords > 0 ? bp.targetWords : currentProject.novelConfig.wordsPerChapter}
                    </span>
                    {bp.userGuidance && (
                      <span
                        className="text-[0.7rem] px-1 py-0.5 rounded"
                        style={{ backgroundColor: 'rgba(var(--color-accent-rgb), 0.15)', color: 'var(--color-accent)' }}
                        title="已有作者微操指导"
                      >
                        有指导
                      </span>
                    )}
                    {bp.notes && (
                      <span
                        className="text-[0.7rem] px-1 py-0.5 rounded"
                        style={{ backgroundColor: 'rgba(34,197,94,0.15)', color: 'rgb(34,197,94)' }}
                        title="已生成章节要点"
                      >
                        有要点
                      </span>
                    )}
                  </div>
                </div>
                ))}
              </div>
            ))}
          </div>
          )}
        </div>

        {/* 右侧编辑区 */}
        <div className="flex-1 overflow-y-auto">
          {selected ? (
            <div className="max-w-2xl mx-auto px-5 py-4">
              {/* 编辑区头部 */}
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold" style={{ color: 'var(--color-text)' }}>
                  第 {selected.chapterNumber} 章：{selected.title || '未命名'}
                </h3>
                <div className="flex items-center gap-1.5">
                  {/* 仅下一章允许写作 */}
                  {nextWriteChapter !== null && selected.chapterNumber === nextWriteChapter && (
                    <Button
                      variant="ai"
                      size="sm"
                      onClick={() => handleWriteChapter(selected)}
                      title="以当前蓝图信息生成草稿"
                    >
                      <PenLine size={12} /> 写作此章
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" onClick={handleDeleteChapter} title="删除此章">
                    <Trash2 size={13} style={{ color: 'var(--color-text-muted)' }} />
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleSaveOne} disabled={saving}>
                    <Save size={12} /> {saving ? '保存中...' : '保存'}
                  </Button>
                </div>
              </div>

              <div className="space-y-3">
                {/* 基本信息 */}
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label>章节号</Label>
                    <Input
                      type="number"
                      value={selected.chapterNumber}
                      onChange={e => updateField('chapterNumber', (e.target.value === '' ? '' : parseInt(e.target.value)) as number)}
                      onBlur={() => {
                        const v = Number(selected.chapterNumber);
                        if (!v || v < 1) updateField('chapterNumber', 1)
                      }}
                    />
                  </div>
                  <div className="col-span-2">
                    <Label>章节标题</Label>
                    <Input
                      value={selected.title}
                      onChange={e => updateField('title', e.target.value)}
                      placeholder="引人入胜的章节标题"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>章节定位</Label>
                    <Select
                      value={selected.role}
                      onValueChange={v => updateField('role', v)}
                      options={CHAPTER_ROLES.map(r => ({ value: r, label: r }))}
                    />
                  </div>
                  <div>
                    <Label>出场关键人（逗号分隔）</Label>
                    <Input
                      value={selected.characters.join('、')}
                      onChange={e => updateField('characters', e.target.value.split(/[,，、\s]+/).filter(Boolean))}
                      placeholder="如：主角、反派A"
                    />
                  </div>
                </div>

                {/* 字数：目标（可编辑，0=跟随全局）+ 实际已写（只读） */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>目标字数 <span className="text-[0.7rem] opacity-50">（留空 = 跟随全局）</span></Label>
                    <Input
                      type="number"
                      value={selected.targetWords || ''}
                      placeholder={`跟随全局 (${currentProject.novelConfig.wordsPerChapter})`}
                      onChange={e => updateField('targetWords', e.target.value === '' ? 0 : (parseInt(e.target.value) || 0))}
                      min={0}
                      step={500}
                    />
                  </div>
                  <div>
                    <Label>实际已写 / 目标</Label>
                    <div
                      className="flex h-9 items-center rounded-md border px-3 text-sm font-mono"
                      style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-panel)', color: 'var(--color-text-muted)' }}
                    >
                      {actualWordsByChapter[selected.chapterNumber] ?? 0} / {selected.targetWords > 0 ? selected.targetWords : currentProject.novelConfig.wordsPerChapter} 字
                    </div>
                  </div>
                </div>

                <div>
                  <Label>主角小目标（本章最想解决的事）</Label>
                  <Textarea
                    value={selected.purpose}
                    onChange={e => updateField('purpose', e.target.value)}
                    placeholder="本章主角最迫切要解决的一件事..."
                    rows={2}
                  />
                </div>

                <div>
                  <Label>实质冲突与转折</Label>
                  <Textarea
                    value={selected.keyEvents}
                    onChange={e => updateField('keyEvents', e.target.value)}
                    placeholder="主角做了什么，遭遇了什么反转，金手指怎么用的..."
                    rows={4}
                  />
                </div>

                <div>
                  <Label>末尾悬念钩子</Label>
                  <Textarea
                    value={selected.suspenseHook}
                    onChange={e => updateField('suspenseHook', e.target.value)}
                    placeholder="一句话说明结尾留了什么悬念..."
                    rows={2}
                  />
                </div>

                {/* 作者微操指导 — 特别标注，写稿时注入为最高优先级 */}
                <div
                  className="p-3 rounded-lg border"
                  style={{
                    borderColor: 'var(--color-accent)',
                    backgroundColor: 'rgba(var(--color-accent-rgb), 0.06)',
                  }}
                >
                  <Label className="flex items-center gap-1.5">
                    <span>作者微操指导</span>
                    <span
                      className="text-[0.7rem] font-normal"
                      style={{ color: 'var(--color-text-muted)' }}
                    >
                      （写稿时会作为最高优先级注入 AI — 可覆盖蓝图）
                    </span>
                  </Label>
                  <Textarea
                    value={selected.userGuidance}
                    onChange={e => updateField('userGuidance', e.target.value)}
                    placeholder="我想在这章加入一个意外的背叛...&#10;让反派在这章露出破绽...&#10;（不填则完全按蓝图走）"
                    rows={3}
                    style={{ marginTop: 6 }}
                  />
                </div>
                {/* 章节要点（定稿后自动生成，也可手动编辑） */}
                <div
                  className="p-3 rounded-lg border"
                  style={{
                    borderColor: 'var(--color-border)',
                    backgroundColor: 'rgba(34,197,94,0.04)',
                  }}
                >
                  <Label className="flex items-center gap-1.5">
                    <span>章节要点</span>
                    <span
                      className="text-[0.7rem] font-normal"
                      style={{ color: 'var(--color-text-muted)' }}
                    >
                      {selected.notesUpdatedAt
                        ? `（定稿后自动生成 — ${new Date(selected.notesUpdatedAt).toLocaleDateString('zh-CN')}）`
                        : '（定稿后自动生成，也可手动填写）'
                      }
                    </span>
                  </Label>
                  <Textarea
                    value={selected.notes || ''}
                    onChange={e => updateField('notes', e.target.value)}
                    placeholder="定稿后 AI 会自动填充本章要点（事件进展/角色变化/伏笔埋点）…＊也可以提前手动输入给 AI 作参考"
                    rows={4}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-3 opacity-30">
              <BookOpen size={36} />
              <span className="text-sm">在左侧选择一章开始编辑</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

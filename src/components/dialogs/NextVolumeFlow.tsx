/**
 * NextVolumeFlow — 「续写下一卷」全流程编排器
 *
 * 全局挂载一次（见 `App.tsx`）。任何入口只需
 * `useVolumeFlowStore.getState()` 配合 `startNextVolumeFlow()` 即可发起。
 *
 * 串起：孤儿处置 → 参数向导 → 工作流（分钟级）→ 结果预览 → 事务提交。
 *
 * ## token 纪律
 *
 * 整条流程横跨两次 LLM 调用，用户随时可能切项目。规矩与 Phase 19 其余部分一致：
 * **在动作入口捕获一次，之后逐层显式传递、每个 await 之后复核**，
 * 绝不在中途现取——那时拿到的是切换后那个项目的**合法** token，守卫看不出异常。
 *
 * 提交用的 token 更特殊：必须用**工作流发起时**捕获的那个
 * （`result.capturedToken`），而不是提交时现取的。工作流跑了几分钟，
 * 其间切过项目再切回来，token 也已经变了。
 */
import { useState } from 'react'
import { toast } from '../ui/Toast'
import { useProjectStore } from '../../stores/project-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { getProjectToken } from '../../stores/volume-store'
import { useVolumeFlowStore, isCurrentFlow } from '../../stores/volume-flow-store'
import { confirmNextVolume, getFlowToken, getFlowId } from '../../services/volume-flow'
import {
  createNextVolumeWorkflow,
  takeNextVolumeResult,
  discardNextVolumeResult,
  type NextVolumeParams,
  type DraftVolume,
  type ClosingReport,
} from '../../services/workflows/volume-workflow'
import type { OrphanPolicy } from '../../../electron/repositories/volume-commit'
import OrphanBlueprintDialog from './OrphanBlueprintDialog'
import NextVolumeDialog from './NextVolumeDialog'
import VolumePreviewDialog from './VolumePreviewDialog'

export default function NextVolumeFlow() {
  const stage = useVolumeFlowStore(s => s.stage)
  const orphan = useVolumeFlowStore(s => s.orphan)
  const prevTitle = useVolumeFlowStore(s => s.prevTitle)
  const prevEndChapter = useVolumeFlowStore(s => s.prevEndChapter)
  const prevChapterCount = useVolumeFlowStore(s => s.prevChapterCount)
  const result = useVolumeFlowStore(s => s.result)
  const defaultStructure = useProjectStore(s => s.currentProject?.novelConfig.plotStructure ?? 'three_act')

  /** 预览阶段要用到向导里定的章数（新卷区间由它决定） */
  const [chapterCount, setChapterCount] = useState(0)
  /** 工作流 runId，取消时用它丢弃产物 */
  const [runId, setRunId] = useState<string | null>(null)
  /** 上一次的向导参数，「重新生成」时原样再跑一遍 */
  const [lastParams, setLastParams] = useState<NextVolumeParams | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const reset = () => {
    useVolumeFlowStore.getState().reset()
    setRunId(null)
    setLastParams(null)
    setChapterCount(0)
    setSubmitting(false)
  }

  /** 取消预览：必须丢弃产物，否则库里会留下工作流延迟未写的孤儿统计 */
  const discardAndReset = () => {
    if (runId) discardNextVolumeResult(runId)
    reset()
  }

  const runWorkflow = async (params: NextVolumeParams) => {
    const actionToken = getFlowToken()
    const flowId = getFlowId()
    if (actionToken === undefined || !isCurrentFlow(actionToken, flowId, getProjectToken())) {
      toast.error('项目已切换，本次续卷已取消')
      reset()
      return
    }

    setLastParams(params)
    setChapterCount(params.chapterCount)
    useVolumeFlowStore.getState().setStage('generating')

    let id: string
    try {
      // 工作流构造时会自己再捕获一次 token 并写进 context——
      // 这里的复核是为了不白跑一趟分钟级的生成
      id = await useWorkflowStore.getState().startWorkflow(createNextVolumeWorkflow(params))
    } catch (e) {
      if (isCurrentFlow(actionToken, flowId, getProjectToken())) {
        toast.error(`续卷生成失败：${e}`)
        reset()
      }
      return
    }

    const r = takeNextVolumeResult(id)
    // ⚠️ 归属校验放在**取产物之后**：无论这条流程还算不算数，
    // 它领到的产物都得由它自己清理，不能留在 store 里等下一条流程撞见
    const stillMine = isCurrentFlow(actionToken, flowId, getProjectToken())

    if (!r) {
      // 工作流失败/被取消时没有产物。失败详情已在工作流面板里，
      // 这里不再弹一遍错，只把流程收干净——但只在还归自己管时收，
      // 否则会把用户刚发起的新流程一起 reset 掉
      if (stillMine) reset()
      return
    }
    if (!stillMine) {
      // 生成期间切走 / 用户又发起了一次：这份产物属于上一条流程，丢弃。
      // **不 reset**：现在的 store 可能正服务着另一条流程
      discardNextVolumeResult(id)
      return
    }

    setRunId(id)
    useVolumeFlowStore.setState({ stage: 'preview', result: r })
  }

  const handleConfirm = async (edited: DraftVolume, editedReport: ClosingReport) => {
    if (!result) return
    setSubmitting(true)
    // 提交与两处归属判定都在服务层（可测）；组件只管本地态与提示
    const res = await confirmNextVolume({ result, chapterCount, edited, editedReport })
    if (!res.ok && res.reason === 'stale') {
      // 这条流程已不归本组件管：不弹提示、也不动本地态，
      // 免得把用户刚发起的新流程搅乱
      return
    }
    if (!res.ok) {
      toast.error(res.message)
      setSubmitting(false)
      return
    }
    toast.success(`已写入第${res.volumeNumber}卷`)
    // store 已由服务层 reset，这里只清组件本地那几个
    setRunId(null)
    setLastParams(null)
    setChapterCount(0)
    setSubmitting(false)
  }

  return (
    <>
      {stage === 'orphan' && orphan && (
        <OrphanBlueprintDialog
          open
          orphan={orphan}
          onCancel={reset}
          onConfirm={(policy: OrphanPolicy) => {
            // extend 会把首卷边界推到蓝图末章，新卷起点随之后移。
            // 这里同步 prevEndChapter，向导展示的区间才对得上实际生成范围
            const nextEnd = policy === 'extend'
              ? Math.max(orphan.endChapter, orphan.maxFinalized)
              : orphan.maxFinalized
            useVolumeFlowStore.setState({
              stage: 'wizard',
              orphanPolicy: policy,
              prevEndChapter: nextEnd,
              prevChapterCount: nextEnd,
            })
          }}
        />
      )}

      {stage === 'wizard' && (
        <NextVolumeDialog
          open
          prevTitle={prevTitle}
          prevEndChapter={prevEndChapter}
          prevChapterCount={prevChapterCount}
          defaultStructure={defaultStructure}
          onCancel={reset}
          onSubmit={(p) => runWorkflow({ ...p, orphanPolicy: useVolumeFlowStore.getState().orphanPolicy })}
        />
      )}

      {stage === 'preview' && result && (
        <VolumePreviewDialog
          open
          result={result}
          chapterCount={chapterCount}
          submitting={submitting}
          onCancel={discardAndReset}
          onRegenerate={() => {
            if (!lastParams) return
            // 先丢弃这一份，再用同样的参数重跑。不丢的话产物会留在 store 里
            if (runId) discardNextVolumeResult(runId)
            setRunId(null)
            useVolumeFlowStore.setState({ result: null })
            void runWorkflow(lastParams)
          }}
          onConfirm={handleConfirm}
        />
      )}
    </>
  )
}

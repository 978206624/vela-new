/**
 * volume-regen — 「重新生成本卷大纲」的发起、结算与停止（Phase 19 / Task 19.4 T3）
 *
 * 与对话框/编辑器组件分开成文件，理由同 `volume-flow.ts`：
 * ① 这里的判定（能不能发起、结果该不该采纳）是**可测的逻辑**，留在组件里只能靠人工点；
 * ② 整条流程横跨一次分钟级 LLM 调用，而卷详情编辑器会随 Tab 切换卸载——
 *    善后**不能绑在组件实例上**，回包跑在旧实例的闭包里，改不动当前挂载的那个。
 *
 * ## 服务层不弹 toast
 *
 * 失败一律走返回值，由调用方分派。理由见 `volume-flow.ts` 文件头：
 * `toast` 要碰 `document`（这段就只能在浏览器里跑），且通知失败不该改变控制流。
 *
 * ## 为什么发起前要求表单干净
 *
 * 本次生成的依据——本卷主线、章号区间、伏笔台账——全部取自**数据库**。
 * 表单里若有未保存的编辑：
 * - 生成依据与用户眼前看到的不是同一份（他改了主线，AI 却按旧主线推演）；
 * - 结果落进「本卷大纲」文本框，还会**覆盖掉**他正在写的那份大纲。
 *
 * 合并规则解决不了这个问题：无论倒向哪一边都会静默丢掉另一边。
 * 拒绝发起、让用户先保存或放弃，是唯一说得清的做法（已写进 Product-Spec §4.11）。
 */
import { useProjectStore } from '../stores/project-store'
import { useLLMStore } from '../stores/llm-store'
import { useWorkflowStore } from '../stores/workflow-store'
import { useEditorStore } from '../stores/editor-store'
import { useVolumeStore, getProjectToken } from '../stores/volume-store'
import { useVolumeDraftStore } from '../stores/volume-draft-store'
import { useVolumeRegenStore } from '../stores/volume-regen-store'
import { volumeTabId } from './volume-tabs'
import {
  createRegenerateVolumeWorkflow,
  takeRegenerateVolumeResult,
  findActiveRegenRunId,
  validateVolumeRangeForRegen,
} from './workflows/volume-regen-workflow'
import type { VolumeData } from '../../electron/repositories/volume-repository'

/**
 * 发起失败的原因。**单独导出**是为了让消费方能对它做穷尽性约束——
 * 将来往联合里加一个新 reason 而忘了在 UI 里归类时，那份 Record 会缺项、tsc 直接报错
 * （同 `StartFlowFailReason` 的用法）。
 */
export type RegenFailReason =
  /** 没打开项目 */
  | 'no-project'
  /** 已有一条重生成在跑（single-flight） */
  | 'busy'
  /** 表单有未保存的改动 */
  | 'dirty'
  /** 卷的章号区间本身不合法（老库 / 外部导入），先去修边界 */
  | 'bad-range'
  /** 没配模型 */
  | 'no-model'
  /** 工作流跑失败（含用户点了「停止生成」）。详情在工作流面板 */
  | 'failed'
  /**
   * 这一趟已经不归调用方管（项目切走 / 用户又发起了一次）。
   * **调用方什么都别做，包括不弹提示**——那条消息属于上一个项目/上一次生成。
   */
  | 'stale'

export type RegenOutcome =
  | { ok: true; volumeNumber: number; charCount: number }
  | { ok: false; reason: RegenFailReason; message: string }

/**
 * 发起结果 → 用户可见提示。返回 `null` 表示**刻意不提示**。
 *
 * 判据留在这里而不是让入口自己写 if：将来分卷总览页等处也可能挂同一个入口，
 * 两处各写一份迟早分叉——而分叉的那份会在用户**自己**切走项目后弹一句
 * 「项目已切换」，等于告诉他他刚做过的事。
 */
export function describeRegenOutcome(res: RegenOutcome): string | null {
  if (res.ok) return null
  if (res.reason === 'stale') return null
  return res.message
}

/**
 * 发起一次「重新生成本卷大纲」，并在完成后把结果落进卷详情草稿。
 *
 * **全程不写业务库**：结果只进 `volume-draft-store`（未保存的草稿），
 * 由用户在卷详情点「保存」才真正落库。
 *
 * @param volume 目标卷（发起那一刻的行）。函数内会立刻把它的章号边界复制成
 *               **值快照**交给工作流复核，不持有这个引用
 * @param writtenChapters 步进器第二段要显示的「已写 N 章」，取自卷详情头部已在显示的那个值
 */
export async function startVolumeSynopsisRegen(
  volume: VolumeData,
  writtenChapters: number,
): Promise<RegenOutcome> {
  // ⚠️ 归属键在**入口第一行、任何 await 之前**捕获
  const actionToken = getProjectToken()
  if (actionToken === undefined) {
    return { ok: false, reason: 'no-project', message: '未打开项目' }
  }

  const project = useProjectStore.getState().currentProject
  if (!project) {
    return { ok: false, reason: 'no-project', message: '未打开项目' }
  }

  // 表单有未保存改动 → 拒绝（理由见文件头）
  if (useVolumeDraftStore.getState().get(actionToken, volume.volumeNumber) !== null) {
    return {
      ok: false,
      reason: 'dirty',
      message: '本卷有未保存的改动。重新生成会以数据库里的内容为依据，并覆盖「本卷大纲」——请先保存，或关闭标签页放弃改动',
    }
  }

  // 区间预检：与工作流第 1 步那道同源，放在这里是为了**不白起一趟工作流**。
  // 工作流里那道仍不能省——它验的是刚从库里读回来的行，本处验的是界面上这一行
  const rangeError = validateVolumeRangeForRegen(volume)
  if (rangeError) return { ok: false, reason: 'bad-range', message: rangeError }

  // 模型显示名：设计稿 30 的头部副信息要写「模型 claude-opus-5」。
  // 取数口径与 `base-command.callLLM` 一致（按 purpose 路由，为空回退默认模型），
  // 否则副信息显示的模型会和实际调用的那个不是一个
  const llm = useLLMStore.getState()
  const modelId = llm.getModelIdForPurpose('outline') || llm.defaultModelId
  if (!modelId) {
    return { ok: false, reason: 'no-model', message: '未配置 AI 模型，请先到设置里配置' }
  }
  const modelName = llm.models.find(m => m.id === modelId)?.name || modelId

  const regenId = useVolumeRegenStore.getState().begin(actionToken, volume.volumeNumber, modelName)
  if (regenId === null) {
    return { ok: false, reason: 'busy', message: '已有一卷正在重新生成大纲，请等它结束或先点「停止生成」' }
  }

  /** 本次是否仍是「当前这一次」：项目没切走，且 store 里跑着的还是我这一条 */
  const stillMine = () =>
    getProjectToken() === actionToken
    && useVolumeRegenStore.getState().run?.regenId === regenId

  /** 结算失败/中止：只有还归自己管时才动 store（否则会误杀用户刚发起的下一次） */
  const settleFailed = () => {
    if (useVolumeRegenStore.getState().run?.regenId === regenId) {
      useVolumeRegenStore.getState().settle(regenId, null)
    }
  }

  let runId: string
  try {
    runId = await useWorkflowStore.getState().startWorkflow(createRegenerateVolumeWorkflow({
      volumeNumber: volume.volumeNumber,
      // ⚠️ **值快照**，不是 `volume` 这个引用。传引用的话，工作流里那道
      // 「发起时的区间 vs 库里的区间」复核就成了拿同一个对象和自己比，必过
      boundaryAtStart: { startChapter: volume.startChapter, endChapter: volume.endChapter },
      structure: project.novelConfig.plotStructure || 'three_act',
      writtenChapters,
      // 流式片段带 regenId 写回：过期回包（上一次生成的）会被 store 丢弃
      onPartial: (text) => useVolumeRegenStore.getState().setPartial(regenId, text),
    }))
  } catch (e) {
    // ⚠️ 先 **保存归属判定**，再 settleFailed：
    // settleFailed 把 run 置 null 之后，`stillMine()` 看到的 store 已经是空的、
    // 永远返回 false，把同项目的真实异常误判成 stale 并静默吞掉错误
    // （Codex round-01 minor）。
    const mine = stillMine()
    settleFailed()
    if (!mine) return { ok: false, reason: 'stale', message: '' }
    return { ok: false, reason: 'failed', message: `重新生成失败：${e}` }
  }

  // ⚠️ 先取产物再判归属：无论这一趟还算不算数，它领到的产物都得由它自己取走，
  // 不能留在 workflow-store 里等下一次撞见（同 NextVolumeFlow 的做法）
  const result = takeRegenerateVolumeResult(runId)
  const mine = stillMine()

  if (!result) {
    // 工作流失败或被「停止生成」取消时没有产物。失败详情已在工作流面板里，
    // 这里只把状态收干净
    settleFailed()
    if (!mine) return { ok: false, reason: 'stale', message: '' }
    return { ok: false, reason: 'failed', message: '本次生成未完成，本卷大纲未改动' }
  }

  if (!mine) {
    // 生成期间切走了项目 / 用户又发起了一次：这份产物属于上一趟，丢弃。
    // **不动 store**——现在它可能正服务着另一次生成
    settleFailed()
    return { ok: false, reason: 'stale', message: '' }
  }

  // 落草稿的基线取**当前**卷行，不是发起时那一行：非 synopsis 的几列要与库一致，
  // 否则用户切走再切回时表单会显示一份过期的卷名/伏笔。
  // 工作流第 1 步已复核过章号边界没变，这里只补一道「卷还在不在」
  const current = useVolumeStore.getState().volumes.find(v => v.volumeNumber === result.volumeNumber)
  if (!current) {
    settleFailed()
    return { ok: false, reason: 'failed', message: `第 ${result.volumeNumber} 卷已不存在，生成结果已丢弃` }
  }

  // ⚠️ **先写草稿，成功了才 settle**。
  //
  // 顺序不能反：组件判断「草稿里那份大纲是不是本条 result」靠的是两者逐字相等，
  // 先 settle 会出现「result 已就位、草稿还没写」的一帧，那一帧里判据不成立、
  // 界面显示的是旧大纲，而完成态文案已经亮起——用户会以为新稿已在眼前。
  //
  // `adoptGeneratedSynopsis` 在**该卷已有草稿**时返回 false（生成期间用户改了
  // 别的字段；UI 已锁定全部控件，这是兜底）。此时**不 settle**：
  // 宁可让这一份 AI 稿子作废，也不静默覆盖用户手写的东西。
  const adopted = useVolumeDraftStore.getState().adoptGeneratedSynopsis(
    actionToken, current, result.synopsis)
  if (!adopted) {
    settleFailed()
    return {
      ok: false,
      reason: 'failed',
      message: '生成期间本卷出现了未保存的改动，这份 AI 大纲已作废（没有覆盖你的编辑）。请保存或放弃改动后重新生成',
    }
  }

  // Tab 上的未保存圆点：不点亮的话，关闭 Tab / ⌘W / 批量关闭的既有未保存确认
  // 对这份 AI 生成的内容**完全不生效**，用户随手关掉就没了。
  //
  // ⚠️ 生成期间用户可能把这个 Tab 关掉了——那时 `setTabDirty` 找不到目标、
  // 静默无效。这不构成丢稿风险：草稿是权威，而 `openVolumeDetail()` 新建 Tab 时
  // 会按「该卷有没有草稿」初始化 `dirty`（见那里的注释），于是重开后即使用户
  // 一个字都不改，⌘W 也照样弹未保存确认。
  useEditorStore.getState().setTabDirty(volumeTabId(result.volumeNumber), true)
  useVolumeRegenStore.getState().settle(regenId, result.synopsis)

  return { ok: true, volumeNumber: result.volumeNumber, charCount: result.synopsis.length }
}

/**
 * 停止当前正在跑的重生成。
 *
 * `cancelWorkflow` 会把 `context.cancelled` 置真，`base-command.callLLM` 每 200ms
 * 轮询它并**主动中断在途的模型流**——不是只把界面标成已取消而让调用继续烧。
 *
 * 停止后不产生任何结果：已生成的片段随 `settle(null)` 一起丢弃，
 * 文本框恢复原内容（Product-Spec §4.11「停止 = 零改动」）。
 * 刻意不把半截大纲留在文本框里——用户点停止就是不想要这一份，
 * 留半篇只会让「原内容还在不在」变得说不清。
 *
 * @returns 是否确实停掉了一条（没有在跑的返回 false）
 */
export function stopVolumeSynopsisRegen(): boolean {
  const runId = findActiveRegenRunId()
  if (!runId) return false
  useWorkflowStore.getState().cancelWorkflow(runId)
  // 不在这里 settle：`startVolumeSynopsisRegen` 里那个 await 会随之返回，
  // 由它统一收尾。两处都 settle 的话，谁先跑到就由竞态决定，没有意义
  return true
}

/**
 * 项目关闭 / 切换时作废当前重生成。由 `onProjectClosed` 统一调用。
 *
 * 先取消工作流再清 store：只清 store 的话，模型调用会继续跑到底、
 * 把 A 项目的调用烧完（`llm_calls` 那一面有 token 守卫，不会串库，但钱照花）。
 */
export function invalidateVolumeRegen(): void {
  const runId = findActiveRegenRunId()
  if (runId) useWorkflowStore.getState().cancelWorkflow(runId)
  useVolumeRegenStore.getState().reset()
}

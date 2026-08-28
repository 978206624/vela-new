import { ipcMain } from 'electron'
import { closeProjectDatabase } from '../database'
import { getCurrentProjectToken } from '../utils/current-project'
import { applyProjectCoreUpdate } from '../services/project-save'

// 导入所有 Repository
import { ProjectCoreRepository, type ProjectCorePatch } from '../repositories/project-core-repository'
import { BlueprintRepository, BlueprintData } from '../repositories/blueprint-repository'
import { CharacterRepository, CharacterData, CharacterStateData } from '../repositories/character-repository'
import { DraftRepository } from '../repositories/draft-repository'
import { RevisionRepository } from '../repositories/revision-repository'
import { ReviewRepository } from '../repositories/review-repository'
import { PostProcessRepository } from '../repositories/post-process-repository'
import { VolumeRepository, VolumeData, VolumeStatus, OpenThread, type VolumeDetailPatch } from '../repositories/volume-repository'
import { commitNextVolume, inspectFirstVolume, type CommitNextVolumePayload } from '../repositories/volume-commit'

// 沿用的旧表
import { LLMHistoryRepository } from '../repositories/llm-repository'
import { SummaryRepository } from '../repositories/summary-repository'
import { ConversationRepository, ConversationRecord } from '../repositories/conversation-repository'

export function registerDatabaseController() {
  ipcMain.handle('db:close', async () => {
    closeProjectDatabase()
    return { success: true }
  })

  // ============================================================
  // 1. project_core — 项目主台账
  // ============================================================
  ipcMain.handle('db:project-core-get', async () => {
    return ProjectCoreRepository.get()
  })

  ipcMain.handle('db:project-core-update', async (_event, data: ProjectCorePatch, expectedToken: number | undefined) => {
    try {
      // 同 project:save —— 判定与写入走共用实现，harness 调的是同一份
      return applyProjectCoreUpdate({
        patch: data, expectedToken, currentToken: getCurrentProjectToken(),
      })
    } catch (err) {
      console.error('[db:project-core-update] 失败:', err)
      return { success: false, error: String(err) }
    }
  })

  // ============================================================
  // 2. blueprints — 章节蓝图
  // ============================================================
  ipcMain.handle('db:blueprint-get-all', async () => {
    return BlueprintRepository.getAll()
  })

  ipcMain.handle('db:blueprint-get', async (_event, chapterNumber: number) => {
    return BlueprintRepository.getByChapter(chapterNumber)
  })

  ipcMain.handle('db:blueprint-upsert', async (_event, data: BlueprintData, expectedToken?: number) => {
    // 与 upsert-many 同口径：缺省放行（兼容既有短流程），长流程必须显式传。
    // 类型里声明了 expectedToken 而 handler 不实现，等于给调用方一个**假的**安全承诺
    if (expectedToken !== undefined && getCurrentProjectToken() !== expectedToken) {
      return { success: false, stale: true }
    }
    try {
      BlueprintRepository.upsert(data)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:blueprint-upsert-many', async (_event, items: BlueprintData[], expectedToken?: number) => {
    // 目录生成是长流程（多批次、可达数分钟）且**不随项目关闭而取消**。
    // 用户在生成期间切到另一个项目时，在途批次会带着 A 的蓝图写进 B 的库、
    // 覆盖 B 的同章蓝图。token 不符即拒写是唯一能兜住这条路径的地方——
    // 渲染层的前置检查（「已有蓝图就不生成」）查的是发起时的项目，管不了之后切走。
    //
    // 兼容既有调用点：缺省 token 仍放行（与 db:log-llm-call 同口径），
    // 长流程写入方必须显式传。
    if (expectedToken !== undefined && getCurrentProjectToken() !== expectedToken) {
      return { success: false, stale: true }
    }
    try {
      BlueprintRepository.upsertMany(items)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:blueprint-update-notes', async (_event, chapterNumber: number, notes: string) => {
    try {
      BlueprintRepository.updateNotes(chapterNumber, notes)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:blueprint-update-target-words', async (_event, chapterNumber: number, targetWords: number) => {
    try {
      const ok = BlueprintRepository.updateTargetWords(chapterNumber, targetWords)
      if (!ok) return { success: false, error: `第 ${chapterNumber} 章尚无蓝图，无法写入目标字数（请先在「章节蓝图」生成本章）` }
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:blueprint-delete-range', async (_event, startChapter: number, endChapter: number, expectedToken?: number) => {
    // 破坏性写入 + 由续卷长流程（跨 LLM 调用）触发 → 必须比对项目 token，
    // 防「在 A 项目发起续卷、中途切到 B」把 B 的蓝图删掉（同 commit 80283dd 的串库修复）
    if (expectedToken === undefined || getCurrentProjectToken() !== expectedToken) {
      return { success: false, deleted: 0, stale: true }
    }
    try {
      const deleted = BlueprintRepository.deleteRange(startChapter, endChapter)
      return { success: true, deleted }
    } catch (err) {
      console.error('[db:blueprint-delete-range] 失败:', err)
      return { success: false, deleted: 0, error: String(err) }
    }
  })

  // ============================================================
  // 3. characters — 角色卡
  // ============================================================
  ipcMain.handle('db:character-get-all', async () => {
    return CharacterRepository.getAll()
  })

  ipcMain.handle('db:character-upsert', async (_event, data: CharacterData) => {
    try {
      CharacterRepository.upsert(data)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:character-save-all', async (_event, items: CharacterData[]) => {
    try {
      CharacterRepository.saveAll(items)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:character-delete', async (_event, name: string) => {
    try {
      CharacterRepository.delete(name)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:character-update-state', async (_event, name: string, state: CharacterStateData) => {
    try {
      CharacterRepository.updateState(name, state)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // 仅填充为空的静态人设字段（AI 补全人设），返回实际填入字段供前端 merge
  ipcMain.handle('db:character-fill-empty-profile', async (_event, name: string, patch: Partial<CharacterData>) => {
    try {
      const { applied } = CharacterRepository.fillEmptyStaticProfileFields(name, patch)
      return { success: true, applied }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ============================================================
  // 4. drafts — 草稿
  // ============================================================
  ipcMain.handle('db:draft-create', async (_event, params: {
    chapterNumber: number
    version: number
    source: 'write' | 'rewrite'
    content: string
    wordCount: number
  }) => {
    try {
      const id = DraftRepository.create(params)
      return { success: true, id }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:draft-list', async (_event, chapterNumber: number) => {
    return DraftRepository.listByChapter(chapterNumber)
  })

  ipcMain.handle('db:draft-get-meta', async (_event, id: number) => {
    return DraftRepository.getMeta(id)
  })

  ipcMain.handle('db:draft-get-full', async (_event, id: number) => {
    return DraftRepository.getFull(id)
  })

  ipcMain.handle('db:draft-get-latest', async (_event, chapterNumber: number) => {
    return DraftRepository.getLatestByChapter(chapterNumber)
  })

  ipcMain.handle('db:draft-get-finalized', async (_event, chapterNumber: number) => {
    return DraftRepository.getFinalizedByChapter(chapterNumber)
  })

  ipcMain.handle('db:draft-find-chapters-by-name', async (_event, name: string, finalizedOnly?: boolean) => {
    return DraftRepository.findChaptersByName(name, finalizedOnly !== false)
  })

  ipcMain.handle('db:draft-get-max-finalized-chapter', async () => {
    return DraftRepository.getMaxFinalizedChapter()
  })
  ipcMain.handle('db:draft-next-version', async (_event, chapterNumber: number) => {
    return DraftRepository.getNextVersion(chapterNumber)
  })

  ipcMain.handle('db:draft-update-status', async (_event, id: number, status: string, wordCount?: number) => {
    try {
      // 服务端状态机守卫：
      // - 定稿必须经 db:draft-finalize-exclusive（维护"每章至多一个生效定稿"互斥），
      //   禁止本通道直接把任意草稿置为 finalized。
      // - finalized 是冻结终态，禁止本通道修改其状态（避免 finalized→archived 后再彻底删除等越权链路）。
      if (status === 'finalized') {
        return { success: false, error: '定稿必须通过定稿流程，不能直接置为 finalized' }
      }
      const meta = DraftRepository.getMeta(id)
      if (!meta) return { success: false, error: '草稿不存在' }
      if (meta.status === 'finalized') {
        return { success: false, error: '已定稿的草稿状态已冻结，不可变更' }
      }
      DraftRepository.updateStatus(id, status, wordCount)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:draft-finalize-exclusive', async (_event, id: number, wordCount?: number) => {
    try {
      // 定稿不变量守卫（唯一物理收口，覆盖 UI/Agent/版本历史/直接调用本通道的 helper）：
      // 禁止回溯定稿「中间历史章」——会破坏后续章节的角色状态/知识库/剧情要点线性演化链。
      // 规则：仅当已有定稿(maxFinalized>0)且目标章号 < 当前最新定稿章号时拦截；
      // 放行最新章重定稿(==)、正常推进(=max+1)、跳章(>max)。
      const meta = DraftRepository.getMeta(id)
      if (!meta) return { success: false, error: '草稿不存在' }
      const maxFinalized = DraftRepository.getMaxFinalizedChapter()
      if (maxFinalized > 0 && meta.chapterNumber < maxFinalized) {
        return {
          success: false,
          error: `禁止回溯定稿第 ${meta.chapterNumber} 章：当前最新定稿为第 ${maxFinalized} 章，回溯重定稿会破坏后续章节的角色状态/知识库/剧情要点线性演化链。如需修改更早章节，请先逐章退回。`,
        }
      }
      DraftRepository.finalizeExclusive(id, wordCount)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:draft-update-content', async (_event, id: number, content: string, wordCount: number) => {
    try {
      // 服务端守卫：已定稿/已归档的草稿不可写入（定稿即冻结）。
      // 防止前端只读 UI 被绕过（如 Ctrl+S 或直接 IPC 调用）。
      const meta = DraftRepository.getMeta(id)
      if (!meta) return { success: false, error: '草稿不存在' }
      if (meta.status === 'finalized' || meta.status === 'archived') {
        return { success: false, error: `已${meta.status === 'finalized' ? '定稿' : '归档'}的草稿不可修改` }
      }
      DraftRepository.updateContent(id, content, wordCount)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:draft-delete', async (_event, id: number) => {
    try {
      // 服务端守卫：彻底删除仅允许作用于已归档草稿，避免误删/越权删活跃稿或定稿。
      const meta = DraftRepository.getMeta(id)
      if (!meta) return { success: false, error: '草稿不存在' }
      if (meta.status !== 'archived') {
        return { success: false, error: '只能彻底删除已归档的草稿' }
      }
      DraftRepository.delete(id)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ============================================================
  // 5. revisions — 修稿
  // ============================================================
ipcMain.handle('db:revision-create', async (_event, params: {
    baseDraftId: number
    revisionIndex: number
    revisionType: 'refine' | 'review-fix'
    userPrompt?: string
    reviewSourceId?: number
    content: string
    wordCount: number
  }) => {
    try {
      const id = RevisionRepository.create(params)
      return { success: true, id }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:revision-list', async (_event, baseDraftId: number) => {
    return RevisionRepository.listByDraft(baseDraftId)
  })

  ipcMain.handle('db:revision-get-pending', async (_event, baseDraftId: number) => {
    return RevisionRepository.getPending(baseDraftId)
  })

  ipcMain.handle('db:revision-get-full', async (_event, id: number) => {
    return RevisionRepository.getFull(id)
  })

  ipcMain.handle('db:revision-next-index', async (_event, baseDraftId: number) => {
    return RevisionRepository.getNextIndex(baseDraftId)
  })

  ipcMain.handle('db:revision-mark-merged', async (_event, id: number, mergedToDraftId: number) => {
    try {
      RevisionRepository.markMerged(id, mergedToDraftId)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:revision-mark-discarded', async (_event, id: number) => {
    try {
      RevisionRepository.markDiscarded(id)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ============================================================
  // 6. reviews — 审稿
  // ============================================================
  ipcMain.handle('db:review-create', async (_event, params: {
    baseDraftId: number
    reviewIndex: number
    content: string
  }) => {
    try {
      const id = ReviewRepository.create(params)
      return { success: true, id }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:review-list', async (_event, baseDraftId: number) => {
    return ReviewRepository.listByDraft(baseDraftId)
  })

  ipcMain.handle('db:review-get-latest', async (_event, baseDraftId: number) => {
    return ReviewRepository.getLatestByDraft(baseDraftId)
  })

  ipcMain.handle('db:review-get-full', async (_event, id: number) => {
    return ReviewRepository.getFull(id)
  })

  ipcMain.handle('db:review-next-index', async (_event, baseDraftId: number) => {
    return ReviewRepository.getNextIndex(baseDraftId)
  })

  // ============================================================
  // 7. post_process — 后处理跑批
  // ============================================================
  ipcMain.handle('db:post-process-create-run', async (_event, params: {
    triggerSourceType: string
    triggerSourceId: string
    sourceLabel: string
    steps: Array<{ key: string; label: string; critical: boolean }>
  }) => {
    try {
      const id = PostProcessRepository.createRun(params)
      return { success: true, id }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:post-process-get-latest-run', async (_event, sourceType: string, sourceId: string) => {
    return PostProcessRepository.getLatestRun(sourceType, sourceId)
  })

  ipcMain.handle('db:post-process-get-steps', async (_event, runId: string) => {
    return PostProcessRepository.getSteps(runId)
  })

  ipcMain.handle('db:post-process-mark-step-ok', async (_event, runId: string, stepKey: string) => {
    try {
      PostProcessRepository.markStepOk(runId, stepKey)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:post-process-mark-step-failed', async (_event, runId: string, stepKey: string, errorMsg: string) => {
    try {
      PostProcessRepository.markStepFailed(runId, stepKey, errorMsg)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:post-process-is-all-passed', async (_event, sourceType: string, sourceId: string) => {
    return PostProcessRepository.isAllCriticalPassed(sourceType, sourceId)
  })

  // ============================================================
  // 沿用旧表
  // ============================================================
  // expectedToken 为**可选**：既有调用方一律不传、行为不变（向后兼容）；
  // 延迟写入的统计（续卷工作流的 logPolicy:'defer'）必须传起点 token——
  // 那两次 LLM 调用长达分钟级，期间切项目会把统计写进另一个项目库。
  ipcMain.handle('db:log-llm-call', async (_event, call, expectedToken?: number) => {
    if (expectedToken !== undefined && getCurrentProjectToken() !== expectedToken) {
      return { success: false, stale: true }
    }
    try {
      LLMHistoryRepository.logCall(call)
      return { success: true }
    } catch (error) {
      console.error('[db:log-llm-call] Error:', error)
      return { success: false }
    }
  })

  ipcMain.handle('db:get-llm-stats', async () => {
    return LLMHistoryRepository.getStats()
  })

  ipcMain.handle('db:get-llm-history', async (_event, limit?: number) => {
    return LLMHistoryRepository.getHistory(limit ?? 50)
  })

  ipcMain.handle('db:save-summary-snapshot', async (_event, chapterNumber: number, characterStates: string) => {
    SummaryRepository.saveSnapshot(chapterNumber, characterStates)
    return { success: true }
  })

  ipcMain.handle('db:get-latest-summary', async () => {
    return SummaryRepository.getLatestSnapshot()
  })

  // ============================================================
  // Agent 对话持久化（agent_conversations）
  //
  // 写操作（upsert/delete/clear）带 expectedToken：复用 project:set-current 的
  // stale-write guard 范式。token 由「动作产生时」前端捕获并显式传入（绝非写 IPC
  // 时现读 live），主进程比对 getCurrentProjectToken()，不匹配则静默丢弃，
  // 防止 A 的延迟落库（如 onDone 回调）在已切到项目 B 后把 A 的对话写进 B 库。
  // ============================================================
  ipcMain.handle('db:conversation-list-meta', async () => {
    return ConversationRepository.listMeta()
  })

  ipcMain.handle('db:conversation-get', async (_event, id: string) => {
    return ConversationRepository.get(id)
  })

  ipcMain.handle('db:conversation-upsert', async (_event, conv: ConversationRecord, expectedToken?: number) => {
    // 写操作必须带 token：undefined（无项目）也拒绝，防止关项目后 projectDb 仍开着时写进残留库
    if (expectedToken === undefined || getCurrentProjectToken() !== expectedToken) {
      return { success: false, stale: true }
    }
    try {
      ConversationRepository.upsert(conv)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:conversation-delete', async (_event, id: string, expectedToken?: number) => {
    if (expectedToken === undefined || getCurrentProjectToken() !== expectedToken) {
      return { success: false, stale: true }
    }
    try {
      ConversationRepository.remove(id)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:conversation-clear', async (_event, expectedToken?: number) => {
    if (expectedToken === undefined || getCurrentProjectToken() !== expectedToken) {
      return { success: false, stale: true }
    }
    try {
      ConversationRepository.clear()
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ============================================================
  // 10. volumes — 分卷（Phase 19）
  // 空表 = 单卷模式。读侧一律返回空数组 / null，由渲染层 volume-service 统一回落，
  // 本层不做回落判断（避免回落逻辑在主进程与渲染层各写一份而分叉）。
  // ============================================================
  ipcMain.handle('db:volume-get-all', async () => {
    return VolumeRepository.getAll()
  })

  ipcMain.handle('db:volume-get', async (_event, volumeNumber: number) => {
    return VolumeRepository.get(volumeNumber)
  })

  ipcMain.handle('db:volume-get-by-chapter', async (_event, chapterNumber: number) => {
    return VolumeRepository.getByChapter(chapterNumber)
  })

  // 写侧一律带 expectedToken 跨项目守卫：Task 19.2 的 commitNextVolume 跨越两次 LLM 调用
  // （收卷提炼 + 卷大纲流式生成，分钟级）后才落库，且是「新卷 + 扩总章数 + 追加全书大纲」四连写。
  // 用户在生成中切项目会把整套结构数据写进另一个项目库，破坏性高于 conversation 串库。
  // token 须由调用方在**动作发起时**捕获（见 agent-store.ts:236 注释），不可在写入时再取。
  ipcMain.handle('db:volume-upsert', async (_event, data: VolumeData, expectedToken?: number) => {
    if (expectedToken === undefined || getCurrentProjectToken() !== expectedToken) {
      return { success: false, stale: true }
    }
    try {
      VolumeRepository.upsert(data)
      return { success: true }
    } catch (err) {
      console.error('[db:volume-upsert] 失败:', err)
      return { success: false, error: String(err) }
    }
  })

  /**
   * 卷详情保存 —— **字段范围**更新，载荷不含 `closingState`。
   * 走整行 upsert 会让详情里看不见的收卷状态被渲染层旧快照覆盖
   * （见 `VolumeRepository.updateDetail` 的说明）。
   */
  ipcMain.handle('db:volume-update-detail', async (_event, patch: VolumeDetailPatch, expectedToken?: number) => {
    if (expectedToken === undefined || getCurrentProjectToken() !== expectedToken) {
      return { success: false, stale: true }
    }
    try {
      const volume = VolumeRepository.updateDetail(patch)
      if (!volume) return { success: false, error: `第 ${patch.volumeNumber} 卷不存在，无法保存` }
      // 带回整行：渲染层据此直接合并进 store，不依赖另一次可能失败的全量刷新
      return { success: true, volume }
    } catch (err) {
      console.error('[db:volume-update-detail] 失败:', err)
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:volume-advance-status', async (_event, chapterNumber: number, expectedToken?: number) => {
    // 与其它卷写通道同口径：缺省 token 直接判 stale。
    // 定稿后处理是长流程，必须显式带上起点 token
    if (expectedToken === undefined || getCurrentProjectToken() !== expectedToken) {
      return { success: false, stale: true }
    }
    try {
      return { success: true, changed: VolumeRepository.advanceStatusByChapter(chapterNumber) }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:volume-update-status', async (_event, volumeNumber: number, status: VolumeStatus, expectedToken?: number) => {
    if (expectedToken === undefined || getCurrentProjectToken() !== expectedToken) {
      return { success: false, stale: true }
    }
    try {
      const ok = VolumeRepository.updateStatus(volumeNumber, status)
      if (!ok) return { success: false, error: `第 ${volumeNumber} 卷不存在，无法更新状态` }
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:volume-update-threads', async (_event, volumeNumber: number, threads: OpenThread[], expectedToken?: number) => {
    if (expectedToken === undefined || getCurrentProjectToken() !== expectedToken) {
      return { success: false, stale: true }
    }
    try {
      const ok = VolumeRepository.updateOpenThreads(volumeNumber, threads)
      if (!ok) return { success: false, error: `第 ${volumeNumber} 卷不存在，无法更新未回收伏笔` }
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:volume-delete', async (_event, volumeNumber: number, expectedToken?: number) => {
    if (expectedToken === undefined || getCurrentProjectToken() !== expectedToken) {
      return { success: false, stale: true }
    }
    try {
      const ok = VolumeRepository.remove(volumeNumber)
      if (!ok) return { success: false, error: `第 ${volumeNumber} 卷不存在` }
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:volume-inspect-first', async () => {
    return inspectFirstVolume()
  })

  // 续卷的单次事务性提交：五项（首卷 / 收卷 / 新卷 / project_core / 孤儿蓝图）
  // 要么全成要么全不成。token 在此校验一次，事务内不再有跨项目窗口。
  ipcMain.handle('db:volume-commit-next', async (_event, payload: CommitNextVolumePayload, expectedToken?: number) => {
    if (expectedToken === undefined || getCurrentProjectToken() !== expectedToken) {
      return { success: false, stale: true }
    }
    try {
      return commitNextVolume(payload)
    } catch (err) {
      console.error('[db:volume-commit-next] 失败:', err)
      return { success: false, error: String(err) }
    }
  })
}

import { ipcMain } from 'electron'
import { closeProjectDatabase } from '../database'
import { getCurrentProjectToken } from '../utils/current-project'

// 导入所有 Repository
import { ProjectCoreRepository, ProjectCoreData } from '../repositories/project-core-repository'
import { BlueprintRepository, BlueprintData } from '../repositories/blueprint-repository'
import { CharacterRepository, CharacterData, CharacterStateData } from '../repositories/character-repository'
import { DraftRepository } from '../repositories/draft-repository'
import { RevisionRepository } from '../repositories/revision-repository'
import { ReviewRepository } from '../repositories/review-repository'
import { PostProcessRepository } from '../repositories/post-process-repository'

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

  ipcMain.handle('db:project-core-update', async (_event, data: Partial<ProjectCoreData>) => {
    try {
      ProjectCoreRepository.update(data)
      return { success: true }
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

  ipcMain.handle('db:blueprint-upsert', async (_event, data: BlueprintData) => {
    try {
      BlueprintRepository.upsert(data)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('db:blueprint-upsert-many', async (_event, items: BlueprintData[]) => {
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
  ipcMain.handle('db:log-llm-call', async (_event, call) => {
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
    if (expectedToken !== undefined && getCurrentProjectToken() !== expectedToken) {
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
    if (expectedToken !== undefined && getCurrentProjectToken() !== expectedToken) {
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
    if (expectedToken !== undefined && getCurrentProjectToken() !== expectedToken) {
      return { success: false, stale: true }
    }
    try {
      ConversationRepository.clear()
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
}

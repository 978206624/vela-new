/**
 * 项目配置写入的**纯逻辑**（守卫 + CAS + 字段映射）。
 *
 * 从 `project-controller` / `db-controller` 的 ipcMain handler 里抽出来，
 * 是为了让 harness 能调**同一份**实现，而不是各自维护一份垫片。
 *
 * 这不是洁癖：本 Task 的会审里已经两次出现「垫片与真实 handler 不一致，
 * 于是用例测的是垫片的行为」——一次是 `project:save` 漏了版本号 fail-closed，
 * 一次是 `db:project-core-update` 漏了 token 守卫。垫片会说谎，共用实现不会。
 *
 * `currentToken` 由调用方注入（主进程传 `getCurrentProjectToken()`，
 * harness 传自己那份），本模块不直接读全局状态。
 */
import { ProjectCoreRepository, type ProjectCorePatch } from '../repositories/project-core-repository'
import type { NovelConfig, ProjectSavePatch } from '../../src/shared/ipc-channels'

export interface ProjectSaveOutcome {
  success: boolean
  error?: string
  stale?: boolean
  staleReason?: 'revision' | 'token'
  revision?: number
}

/** NovelConfig（前端别名）→ project_core 列名 */
export function novelConfigToCorePatch(nc: Partial<NovelConfig>): ProjectCorePatch {
  const patch: ProjectCorePatch = {}
  if (nc.genre !== undefined) patch.genre = nc.genre
  if (nc.subGenre !== undefined) patch.subGenre = nc.subGenre
  if (nc.targetAudience !== undefined) patch.targetAudience = nc.targetAudience
  if (nc.totalChapters !== undefined) patch.totalChapters = nc.totalChapters
  if (nc.wordsPerChapter !== undefined) patch.wordsPerChapter = nc.wordsPerChapter
  if (nc.plotStructure !== undefined) patch.plotStructure = nc.plotStructure
  if (nc.narrativePOV !== undefined) patch.narrativePov = nc.narrativePOV
  if (nc.goldenFinger !== undefined) patch.goldenFinger = nc.goldenFinger
  if (nc.globalGuidance !== undefined) patch.globalGuidance = nc.globalGuidance
  if (nc.writingStyle !== undefined) patch.writingStyle = nc.writingStyle
  if (nc.referenceWorks !== undefined) patch.referenceWorks = nc.referenceWorks
  if (nc.coreOutline !== undefined) patch.synopsis = nc.coreOutline
  if (nc.worldSetting !== undefined) patch.worldbuilding = nc.worldSetting
  if (nc.protagonistProfile !== undefined) patch.charactersArch = nc.protagonistProfile
  return patch
}

/**
 * `project:save` 的全部判定与写入。
 *
 * 拒绝的两种成因用 `staleReason` 区分——渲染层据此决定善后完全不同：
 * `'revision'` 要重载（库里有更新内容），`'token'` 什么都不该动（那次写入属于上一个项目）。
 */
export function applyProjectSave(args: {
  patch: ProjectSavePatch
  expectedRevision: number
  expectedToken: number | undefined
  currentToken: number | undefined
}): ProjectSaveOutcome {
  const { patch, expectedRevision, expectedToken, currentToken } = args

  // ① 跨项目守卫。undefined 一律拒绝（fail-closed）：
  //    调用方漏传时静默放行，等于这道守卫不存在
  if (expectedToken === undefined || expectedToken !== currentToken) {
    return { success: false, stale: true, staleReason: 'token', error: '项目已切换，本次保存已取消' }
  }

  // ② 版本号同样 fail-closed。
  //    漏传时 `expectedRevision` 是 undefined，而仓储把 undefined 解读为
  //    「不做 CAS」——那是给主进程内部初始化路径留的口子。
  //    从 IPC 进来的调用绝不能走那条分支：漏传等于把 CAS 静默关掉。
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return {
      success: false, stale: true, staleReason: 'revision',
      error: `保存请求缺少有效的版本号（收到 ${String(expectedRevision)}），已拒绝`,
    }
  }

  // ③ 三类字段合并成**一次** update：分三次会各自 +1 版本号，
  //    第二次就撞上自己刚涨的 revision，永远存不进去
  const corePatch: ProjectCorePatch = {
    ...(patch.novelConfig ? novelConfigToCorePatch(patch.novelConfig) : {}),
    ...(patch.name !== undefined ? { projectName: patch.name } : {}),
    ...(patch.characterStates !== undefined ? { characterStates: patch.characterStates } : {}),
  }

  const res = ProjectCoreRepository.update(corePatch, expectedRevision)
  if (!res.ok) {
    return {
      success: false, stale: true, staleReason: 'revision',
      revision: res.revision ?? undefined,
      error: '项目配置已被其它操作更新，本次保存已取消',
    }
  }
  return { success: true, revision: res.revision }
}

/**
 * `db:project-core-update` 的判定与写入。
 *
 * 本通道是「窄补丁」形态（每次只写调用方明确指定的几列），本身不易发生
 * lost update，故不做 CAS。但它照样让 revision +1，所以必须把新值回给渲染层。
 */
export function applyProjectCoreUpdate(args: {
  patch: ProjectCorePatch
  expectedToken: number | undefined
  currentToken: number | undefined
}): { success: boolean; error?: string; stale?: boolean; revision?: number } {
  const { patch, expectedToken, currentToken } = args
  // fail-closed：漏传等于这道守卫不存在，而调用方全是「LLM 之后才写库」的长流程
  if (expectedToken === undefined || expectedToken !== currentToken) {
    return { success: false, stale: true, error: '项目已切换，本次配置写入已取消' }
  }
  const res = ProjectCoreRepository.update(patch)
  return res.ok
    ? { success: true, revision: res.revision }
    : { success: false, error: '项目配置未打开或更新未命中' }
}

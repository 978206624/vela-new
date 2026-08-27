import { ipcMain, dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { readJsonFile, writeJsonFile, RECENT_PROJECTS_PATH } from '../utils/config-utils'
import { getCurrentProjectPath, getCurrentProjectToken, setCurrentProjectPath } from '../utils/current-project'
import { ProjectData, type ProjectSavePatch } from '../../src/shared/ipc-channels'
import { DIR_VELA_INTERNAL, DIR_PROMPTS } from '../../src/shared/project-paths'
import { initProjectDatabase } from '../database'
import { applyProjectSave } from '../services/project-save'
import { ProjectCoreRepository } from '../repositories/project-core-repository'

interface RecentProject {
  name: string
  path: string
  updatedAt: string
}

function loadRecentProjects(): RecentProject[] {
  return readJsonFile<RecentProject[]>(RECENT_PROJECTS_PATH, [])
}

function removeRecentProject(projectPath: string) {
  const list = loadRecentProjects()
  const filtered = list.filter((p) => p.path !== projectPath)
  writeJsonFile(RECENT_PROJECTS_PATH, filtered)
}

function addRecentProject(project: RecentProject) {
  const list = loadRecentProjects()
  const filtered = list.filter((p) => p.path !== project.path)
  filtered.unshift(project)
  const trimmed = filtered.slice(0, 20)
  writeJsonFile(RECENT_PROJECTS_PATH, trimmed)
}

export function registerProjectController() {
  // 创建新项目
  ipcMain.handle('project:create', async (_event, config: {
    name: string; path: string; genre: string; targetAudience: string
  }) => {
    try {
      const projectId = randomUUID()
      const projectDir = path.join(config.path, config.name)

      // 仅创建必要的系统目录
      fs.mkdirSync(path.join(projectDir, DIR_VELA_INTERNAL), { recursive: true })
      fs.mkdirSync(path.join(projectDir, DIR_PROMPTS), { recursive: true })

      // 初始化 DB 底座
      initProjectDatabase(projectDir)

      // 初始化 project_core 记录
      ProjectCoreRepository.init(config.name)
      ProjectCoreRepository.update({
        genre: config.genre,
        targetAudience: config.targetAudience,
      })

      // 补充缺失在 DB 初始化时生成所需的数据
      const projectData: ProjectData = {
        id: projectId,
        name: config.name,
        path: projectDir,
        novelConfig: {
          genre: config.genre,
          subGenre: '',
          targetAudience: config.targetAudience,
          totalChapters: 100,
          wordsPerChapter: 3000,
          plotStructure: 'three_act',
          narrativePOV: 'third_limited',
          coreOutline: '',
          worldSetting: '',
          goldenFinger: '',
          protagonistProfile: '',
          globalGuidance: '',
        },
        characterStates: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      // 添加到最近项目列表
      addRecentProject({ name: config.name, path: projectDir, updatedAt: projectData.updatedAt })

      return { success: true, projectId, projectPath: projectDir }
    } catch (error) {
      return { success: false, projectId: '', error: String(error) }
    }
  })

  // 打开现有项目
  ipcMain.handle('project:open', async (_event, projectPath: string) => {
    try {
      if (!fs.existsSync(projectPath)) {
        return { success: false, project: null, error: '目录不存在' }
      }

      // TODO: 这里可以加入一个检测旧版项目的逻辑（如果有 旧的 01_novel_config.json 等），提示不支持旧格式。
      // 因为新架构不兼容旧项目，这里我们只要初始化 DB 即可
      initProjectDatabase(projectPath)

      // 从 DB 读取配置
      const coreData = ProjectCoreRepository.get()
      if (!coreData) {
        // 如果是从空目录新建并打开，尝试初始化
        const folderName = path.basename(projectPath)
        ProjectCoreRepository.init(folderName)
      }

      // 组装返回给前端的数据结构
      const updatedCoreData = ProjectCoreRepository.get()!
      // 直接用这一行里的 revision：再调一次 getRevision() 是第二次 SELECT，
      // 两次读之间若有写入落地，返回的 project 数据与版本号就对不上了
      const coreRevision = updatedCoreData.revision
      const projectData: ProjectData = {
        id: 'main',
        name: updatedCoreData.projectName,
        path: projectPath,
        novelConfig: {
          genre: updatedCoreData.genre,
          subGenre: updatedCoreData.subGenre,
          targetAudience: updatedCoreData.targetAudience,
          totalChapters: updatedCoreData.totalChapters,
          wordsPerChapter: updatedCoreData.wordsPerChapter,
          plotStructure: updatedCoreData.plotStructure as 'three_act' | 'heros_journey' | 'save_the_cat' | 'kishotenketsu' | 'multi_thread' | 'freeform',
          narrativePOV: updatedCoreData.narrativePov as 'third_limited' | 'first_person' | 'third_omniscient' | 'multi_pov',
          coreOutline: updatedCoreData.synopsis,      // 旧字段映射
          worldSetting: updatedCoreData.worldbuilding, // 旧字段映射
          goldenFinger: updatedCoreData.goldenFinger,
          protagonistProfile: updatedCoreData.charactersArch, // 旧字段映射
          globalGuidance: updatedCoreData.globalGuidance,
          writingStyle: updatedCoreData.writingStyle,
          referenceWorks: updatedCoreData.referenceWorks,
        },
        characterStates: updatedCoreData.characterStates,
        createdAt: new Date().toISOString(), // db 中实际上有，但这里先 mock 一下时间避免前端报错
        updatedAt: new Date().toISOString(),
      }

      addRecentProject({ name: projectData.name, path: projectPath, updatedAt: projectData.updatedAt })

      // 同步"当前项目"到主进程，供 KB 等 IPC 使用；recent[0] 不再作为真相来源
      const { token } = setCurrentProjectPath(projectPath)

      return { success: true, project: projectData, currentToken: token, coreRevision }
    } catch (error) {
      return { success: false, project: null, error: String(error) }
    }
  })

  // 同步前端"当前打开项目"路径；传 null 表示关闭项目。
  // expectedCurrent + expectedToken 用作 stale-write guard：fire-and-forget 的清空
  // 动作如果晚于下一次 project:open 到达主进程，会把刚切换的项目清成 null。
  // 仅 path 不够——close A → reopen A 时 path 仍匹配会误清；token 单调递增彻底排除竞态。
  ipcMain.handle('project:set-current', async (_event, projectPath: string | null, expectedCurrent?: string | null, expectedToken?: number) => {
    if (expectedToken !== undefined && getCurrentProjectToken() !== expectedToken) {
      return { success: true, skipped: true }
    }
    if (expectedCurrent !== undefined && getCurrentProjectPath() !== expectedCurrent) {
      return { success: true, skipped: true }
    }
    const { token } = setCurrentProjectPath(projectPath)
    return { success: true, token }
  })

  // 保存项目配置。
  //
  // 入参是**补丁**不是整份快照，且带 revision 做 CAS：
  // 渲染层的配置快照可能读于某次主进程写入之前（续卷会直接改 synopsis/total_chapters），
  // 整份落地就会把新值覆盖回旧值。这是 Phase 19 的上线阻塞项。
  ipcMain.handle('project:save', async (
    _event,
    _projectId: string,
    patch: ProjectSavePatch,
    expectedRevision: number,
    expectedToken: number | undefined,
  ) => {
    try {
      // 判定与写入全在 `applyProjectSave` 里，本 handler 只负责注入
      // 「当前项目 token」并处理最近项目列表这类 IPC 层的副作用。
      // 抽出去是为了让 harness 调**同一份**实现——垫片会说谎，共用实现不会
      const outcome = applyProjectSave({
        patch, expectedRevision, expectedToken,
        currentToken: getCurrentProjectToken(),
      })
      if (!outcome.success) return outcome

      // ⚠️ 最近项目列表的写入失败**不得**影响本次保存的结论。
      // 配置已经落库了；让一个「最近打开」列表的 IO 错误把结果翻成 error，
      // 会让调用方以为配置没保存进去，从而保留脏标记、诱导用户重存一次
      const projectPath = getCurrentProjectPath()
      if (projectPath) {
        try {
          addRecentProject({
            name: patch.name ?? ProjectCoreRepository.get()?.projectName ?? 'Unknown',
            path: projectPath,
            updatedAt: new Date().toISOString(),
          })
        } catch (e) {
          console.warn('[project:save] 更新最近项目列表失败（不影响本次保存）:', e)
        }
      }
      return outcome
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('project:recent-list', async () => {
    return loadRecentProjects()
  })

  ipcMain.handle('project:recent-remove', async (_event, projectPath: string) => {
    try {
      removeRecentProject(projectPath)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('dialog:select-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择项目保存位置',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}

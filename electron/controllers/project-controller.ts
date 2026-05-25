import { ipcMain, dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { readJsonFile, writeJsonFile, RECENT_PROJECTS_PATH } from '../utils/config-utils'
import { ProjectData, type NovelConfig } from '../../src/shared/ipc-channels'
import { DIR_VELA_INTERNAL, DIR_PROMPTS } from '../../src/shared/project-paths'
import { initProjectDatabase } from '../database'
import { ProjectCoreRepository, type ProjectCoreData } from '../repositories/project-core-repository'

interface RecentProject {
  name: string
  path: string
  updatedAt: string
}

/**
 * 把前端 NovelConfig 映射为 project_core 更新 patch。
 * 只包含调用方实际提供的字段（避免 Partial 调用把未传字段清空为空串）。
 * 含旧字段反向映射（核心大纲/世界观/主角人设 → synopsis/worldbuilding/charactersArch），
 * 与 project:open 的读取映射对称——否则这三项保存后不落库，重开即丢。
 */
function novelConfigToCorePatch(nc: Partial<NovelConfig>): Partial<ProjectCoreData> {
  const patch: Partial<ProjectCoreData> = {}
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

      return { success: true, project: projectData }
    } catch (error) {
      return { success: false, project: null, error: String(error) }
    }
  })

  // 保存/更新项目配置
  // 注意：这个接口前端可能还传了很多 novelConfig 中的字段，我们需要 mapping 给 DB。
  ipcMain.handle('project:save', async (_event, _projectId: string, data: Partial<ProjectData>) => {
    try {
      if (!data.path) return { success: false, error: '缺少项目路径' }

      if (data.novelConfig) {
        ProjectCoreRepository.update(novelConfigToCorePatch(data.novelConfig))
      }

      if (data.name) {
        ProjectCoreRepository.update({ projectName: data.name })
      }

      if (data.characterStates !== undefined) {
        ProjectCoreRepository.update({ characterStates: data.characterStates })
      }

      addRecentProject({
        name: data.name ?? 'Unknown',
        path: data.path,
        updatedAt: new Date().toISOString(),
      })

      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // project:update-config 同理
  ipcMain.handle('project:update-config', async (_event, _projectId: string, data: Partial<ProjectData>) => {
    try {
      if (data.novelConfig) {
        ProjectCoreRepository.update(novelConfigToCorePatch(data.novelConfig))
      }
      return { success: true }
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

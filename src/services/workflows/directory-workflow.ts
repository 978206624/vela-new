import type { WorkflowDefinition } from '../../stores/workflow-store'
import { useProjectStore } from '../../stores/project-store'
import { getProjectToken } from '../../stores/volume-store'
import { WORKFLOW_TOKEN_KEY } from './commands/base-command'
import { ipc } from '../ipc-client'
import type { BlueprintData } from '../../../electron/repositories/blueprint-repository'
import { stripThinkingTags } from './workflow-utils'
import { coerceChapterRole } from '../../shared/chapter-roles'

// ==========================================
// 1. 结构与类型导出 (保留对外的向后兼容)
// ==========================================

export type ChapterBlueprint = BlueprintData

const EMPTY_BLUEPRINT: ChapterBlueprint = {
  chapterNumber: 0,
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

export interface DirectoryWorkflowParams {
  mode: 'full' | 'append'
  startChapter?: number
  count?: number
  /** 节奏/风格指导（可选） */
  pacingGuidance?: string
}

// ==========================================
// 2. 蓝图文件访问与工具函数
// ==========================================

export function parseTextBlueprints(content: string, startNum: number, endNum: number): ChapterBlueprint[] {
  let result: ChapterBlueprint[] = []

  try {
    const cleanContent = stripThinkingTags(content)
    const jsonStr = cleanContent.replace(/```json?\n?/g, '').replace(/```\n?/g, '').trim()
    const startIndex = jsonStr.indexOf('{')
    const endIndex = jsonStr.lastIndexOf('}')

    if (startIndex !== -1 && endIndex !== -1) {
      const arrayStr = jsonStr.substring(startIndex, endIndex + 1)
      let parsed = JSON.parse(arrayStr)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.blueprints) {
        parsed = parsed.blueprints
      }
      if (Array.isArray(parsed)) {
        result = parsed
          .filter((p: Record<string, unknown>) => {
            const n = Number(p.chapterNumber || p.chapter_number)
            return n >= startNum && n <= endNum
          })
          .map((p: Record<string, unknown>) => ({
            ...EMPTY_BLUEPRINT,
            chapterNumber: Number(p.chapterNumber || p.chapter_number || 0),
            title: String(p.title || `第${p.chapterNumber}章`),
            role: coerceChapterRole(p.role),
            purpose: String(p.purpose || ''),
            keyEvents: String(p.keyEvents || p.key_events || ''),
            characters: Array.isArray(p.characters) ? p.characters : [],
            suspenseHook: String(p.suspenseHook || p.suspense_hook || ''),
            userGuidance: '',
          }))
      }
    }
  } catch {
    console.error('Failed to parse blueprint JSON', content)
  }

  const distinctMap = new Map<number, ChapterBlueprint>()
  for (const item of result) {
    if (!distinctMap.has(item.chapterNumber)) distinctMap.set(item.chapterNumber, item)
  }

  return Array.from(distinctMap.values()).sort((a, b) => a.chapterNumber - b.chapterNumber)
}

export async function loadDirectoryBlueprints(): Promise<ChapterBlueprint[]> {
  try {
    const blueprints = await ipc.invoke('db:blueprint-get-all')
    return blueprints.sort((a, b) => a.chapterNumber - b.chapterNumber)
  } catch {
    return []
  }
}

export async function saveChapterBlueprint(blueprint: ChapterBlueprint): Promise<void> {
  await ipc.invoke('db:blueprint-upsert', blueprint)
}

/**
 * 批量落库章节蓝图。
 *
 * `expectedToken` **必须由长流程显式传入**：目录生成跨多批次、可达数分钟，
 * 且工作流不随项目关闭而取消。用户中途切项目时，在途批次会把 A 的蓝图
 * 写进 B 的库并覆盖同章内容——主进程靠这个 token 拒写。
 * 返回值必须检查（`stale` 表示项目已切换），静默忽略等于守卫白加。
 */
export async function saveAllBlueprints(
  blueprints: ChapterBlueprint[],
  expectedToken?: number,
): Promise<{ success: boolean; stale?: boolean; error?: string }> {
  return await ipc.invoke('db:blueprint-upsert-many', blueprints, expectedToken)
}

/**
 * 归一目标字数写入值（Phase 18，"跟随全局"语义）。
 * 仅当用户显式设成「与当前全局不同的正数」才写正数钉住该章；
 * 接受全局预填值或留空（input<=0 或 ===global）一律存 0 = 跟随全局。
 */
export function normalizeTargetWords(input: number, global: number): number {
  return input > 0 && input !== global ? input : 0
}

export async function getBlueprintCount(): Promise<number> {
  try {
    const blueprints = await ipc.invoke('db:blueprint-get-all')
    return blueprints.length
  } catch {
    return 0
  }
}

// ==========================================
// 3. 工作流定义映射工厂 (Command 调度层)
// ==========================================

export function createDirectoryWorkflow(
  params: DirectoryWorkflowParams = { mode: 'full' },
  /**
   * 由调用方在**更早的时刻**捕获的 token。
   *
   * **两条入口都必须传**：
   * - Agent 路径的前置检查（有没有蓝图、架构齐不齐）是一串异步 IPC；
   * - UI 路径（`ChapterCardEditor.handleBatchGenerate`）有 guard 与 confirm 两个长 await，
   *   确认框还要等用户点。
   *
   * 若等到这里才捕获，「A 通过前置检查 → 切到 B → 在 B 上启动」
   * 会捕获到**合法的 B token**，主进程守卫拦不住。
   * 缺省仍在此捕获，只是为了兼容尚未改造的调用点，不代表那样是安全的。
   */
  capturedTokenOverride?: number,
): WorkflowDefinition {
  const capturedToken = capturedTokenOverride ?? getProjectToken()
  return {
    type: 'directory',
    title: params.mode === 'append' ? `📋 续写章节蓝图${params.startChapter ? `（从第 ${params.startChapter} 章）` : ''}` : '📋 生成章节蓝图（全量）',
    steps: [
      {
        name: '读取架构',
        description: `从 SQLite 加载项目架构信息`,
        executor: async (_step, context, callbacks) => {
          const project = useProjectStore.getState().currentProject
          if (!project) throw new Error('未打开项目')

          callbacks.log('读取项目架构信息...')
          const core = await ipc.invoke('db:project-core-get')
          if (!core) throw new Error('项目核心数据未初始化')

          // 「短于 50 字视为未生成」是既有闸门，逐项沿用
          const gated = (s: string | undefined) => (s && s.length > 50) ? s : ''
          const premise = gated(core.premise)
          const charactersArch = gated(core.charactersArch)
          const worldbuilding = gated(core.worldbuilding)
          const synopsis = gated(core.synopsis)

          if (!premise && !charactersArch && !worldbuilding && !synopsis) {
            throw new Error('项目主要架构均未生成')
          }

          // 三大件（故事前提 / 角色图谱 / 世界观）是**全书唯一**的，任何卷都照原样喂。
          // 情节大纲则不同：分卷模式下必须换成「当前卷」的主线与卷内大纲，
          // 全书 synopsis 描述的是一个已闭环的完整故事，喂进去会诱导 AI 收尾
          // （Spec §4.11 的原始缺陷）。但「当前卷」取决于本批次生成到第几章，
          // 只有 Command 里的 cursor 知道，故这里只把两半分开存，由 Command 逐批合成。
          //
          // ⚠️ 必须逐项判空后再拼，不能对过滤后的数组做 slice(0,3)——
          // 三大件里任意一项没过闸门时，slice 会把 synopsis 一起带进「三大件」。
          context.data.architectureBase = [premise, charactersArch, worldbuilding]
            .filter(Boolean).join('\n\n---\n\n')
          // 零卷回落时 Command 直接用它，保证单卷模式拼出的 architecture 与分卷前逐字节一致
          context.data.coreSynopsis = synopsis
          // 注入节奏指导到 context，供 Command 读取
          if (params.pacingGuidance) context.data.pacingGuidance = params.pacingGuidance
          // 起点 token 交给 Command：它逐批写库，每批都要带。
          // ⚠️ 同时写 WORKFLOW_TOKEN_KEY——`BaseWorkflowCommand.callLLM` 的
          // 「发模前核对项目未切换」只认这个键，只写 capturedToken 等于那道守卫不生效
          context.data.capturedToken = capturedToken
          context.data[WORKFLOW_TOKEN_KEY] = capturedToken
          if (params.mode === 'append') {
            const existing = await loadDirectoryBlueprints()
            context.data.existingBlueprints = existing
            callbacks.log(`已加载 ${existing.length} 章已有蓝图`)
          }
          return `架构加载完成（${[premise, charactersArch, worldbuilding, synopsis].filter(Boolean).length} 段）`
        },
      },
      {
        name: '生成蓝图',
        description: '基于架构文件生成全书章节蓝图',
        executor: async (_step, context, callbacks) => {
          const { GenerateDirectoryCommand } = await import('./commands/directory.command')
          const cmd = new GenerateDirectoryCommand(params)
          const blueprints = await cmd.execute({ step: _step, context, callbacks })
          // 返回可读摘要字符串（step.result 必须是 string，否则 AIOutputPanel 渲染会崩溃）
          return `已生成 ${blueprints.length} 章蓝图`
        },
      },
      {
        name: '保存蓝图',
        description: `将章节蓝图批量写入 SQLite 数据库`,
        executor: async (_step, context, callbacks) => {
          const project = useProjectStore.getState().currentProject
          if (!project) throw new Error('未打开项目')

          const newBlueprints = context.data.newBlueprints as ChapterBlueprint[]

          // **两种模式都不再做最终保存**：Command 已在每批结束时权威落库并刷新资源，
          // 而且那一步只补写"未成功预览写入"的章节，刻意避开正被用户编辑的那些。
          //
          // 这里再把累计的 newBlueprints 整体 upsert 一遍，就会用**陈旧副本**盖掉
          // 用户在生成期间做的编辑——蓝图一落库就出现在编辑器里、当场可改，
          // 窗口从「第一批出现」一直开到「最后一批结束」，不是理论风险。
          // full 模式同样如此：它只是起点写死为 1，落库路径与 append 完全一致。
          callbacks.log(`已生成 ${newBlueprints.length} 章（逐批落库，无需重复保存）`)
          useProjectStore.getState().refreshFileTree()
          return '已保存蓝图'
        },
      },
    ],
    onComplete: {
      mode: 'silent',
      message: params.mode === 'append' ? '✅ 续写蓝图生成完成' : '✅ 全书章节蓝图已生成完成！',
    },
  }
}

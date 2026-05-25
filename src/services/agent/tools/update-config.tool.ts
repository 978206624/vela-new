/**
 * update_config — 更新小说配置
 */
import { buildAgentTool } from '../tool-registry'
import { ipc } from '../../ipc-client'
import { useProjectStore } from '../../../stores/project-store'

export const updateConfigTool = buildAgentTool({
  name: 'update_config',
  description: '更新小说项目的配置信息，如类型、目标读者、大纲、写作风格等。这会修改项目核心设定，需要用户确认。',
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      field: {
        type: 'string',
        description: '要更新的字段名',
        enum: ['genre', 'subGenre', 'targetAudience', 'totalChapters', 'wordsPerChapter',
               'coreOutline', 'worldSetting', 'goldenFinger', 'protagonistProfile',
               'globalGuidance', 'writingStyle', 'referenceWorks'],
      },
      value: {
        type: 'string',
        description: '新值',
      },
    },
    required: ['field', 'value'],
  },
  requiresConfirmation: true,
  isReadOnly: false,
  execute: async (args) => {
    const field = args.field as string
    const value = args.value as string

    if (!field || value === undefined) {
      return { success: false, content: '', error: '缺少 field 或 value 参数' }
    }

    const project = useProjectStore.getState().currentProject
    if (!project) {
      return { success: false, content: '', error: '没有打开的项目' }
    }

    // 数值字段需转 number：value schema 恒为 string，直接写入会污染 NovelConfig 类型契约
    // （store 后续被 UI/工作流当数字用，如 totalChapters * 0.2）
    let typedValue: string | number = value
    if (field === 'totalChapters' || field === 'wordsPerChapter') {
      const n = Number.parseInt(value, 10)
      if (!Number.isFinite(n) || n <= 0) {
        return { success: false, content: '', error: `字段 ${field} 需为正整数，收到："${value}"` }
      }
      typedValue = n
    }

    // 构造更新数据
    const updateData = {
      novelConfig: { ...project.novelConfig, [field]: typedValue },
    }

    const result = await ipc.invoke('project:update-config', project.id, updateData)
    if (!result.success) {
      return { success: false, content: '', error: result.error ?? '配置更新失败' }
    }

    // 同步 renderer store，否则 store 仍持旧值，后续 saveProject 会把本次修改覆盖回去
    useProjectStore.getState().updateNovelConfig(updateData.novelConfig)

    return {
      success: true,
      content: `✅ 配置已更新：${field} = "${typeof value === 'string' && value.length > 50 ? value.slice(0, 50) + '…' : value}"`,
    }
  },
})

/**
 * update_config — 更新小说配置
 */
import { buildAgentTool } from '../tool-registry'
import { useProjectStore } from '../../../stores/project-store'
import { getProjectToken } from '../../../stores/volume-store'
import type { NovelConfig } from '../../../shared/ipc-channels'

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
    // 入口捕获：下面到写库之间有 await，且本工具由 Agent 异步调度
    const actionToken = getProjectToken()

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

    // 只发本次真正改的那一个字段。
    // 原实现发的是 `{...project.novelConfig, [field]: value}` 整份快照，
    // 其余字段的值读于本次工具执行之前——期间若有别的写入落地（如续卷改了
    // coreOutline / totalChapters），会被这份旧快照原样覆盖回去。
    const patch = { [field]: typedValue } as Partial<NovelConfig>

    // 先同步 store 再持久化：saveProject 的补丁与 store 必须一致，
    // 否则冲突重载时用户看到的内存值与刚提交的值对不上
    useProjectStore.getState().updateNovelConfig(patch)
    const res = await useProjectStore.getState().saveProject({ novelConfig: patch }, actionToken)
    if (res.kind !== 'success') {
      // 分种类给文案：只有 conflict 才真的重载过。把三种混成一句，
      // 会在「项目已切换」和普通错误时向用户谎报「已重新加载最新内容」
      // 外层不能统一写「未生效」——只有 conflict 是确定未生效
      const reason =
        res.kind === 'conflict'
          ? '配置更新未生效：已被其它操作更新，已重新加载最新内容，请基于新内容重试'
          : res.kind === 'project-switched'
            ? '配置更新未能确认：项目已切换，本次修改是否落库无法确定'
            : `配置更新未能确认：${res.message}（可能已写入，请刷新后核对）`
      return { success: false, content: '', error: reason }
    }

    return {
      success: true,
      content: `✅ 配置已更新：${field} = "${typeof value === 'string' && value.length > 50 ? value.slice(0, 50) + '…' : value}"`,
    }
  },
})

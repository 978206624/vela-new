/**
 * JSON 资料卡字段字典 —— 把工具结果 JSON 的英文 key / 枚举值映射成中文，
 * 让信息卡显示中文属性而非原始字段名。
 *
 * 来源：与 NovelConfigEditor 的字段标签、project_core 表设计保持一致。
 * 未收录的 key 由 fieldLabel() 降级返回原 key（不报错、不丢信息）。
 */

/** 字段 key → 中文属性名 */
export const FIELD_LABELS: Record<string, string> = {
  // —— 项目配置（read_project_state 配置块）——
  projectName: '项目名',
  name: '名称',
  title: '标题',
  genre: '类型',
  subGenre: '细分类型',
  targetAudience: '目标受众',
  totalChapters: '总章数',
  wordsPerChapter: '每章字数',
  plotStructure: '故事结构',
  narrativePov: '叙事视角',
  writingStyle: '文风',
  referenceWorks: '参考作品',
  globalGuidance: '全局指导',
  goldenFinger: '金手指',
  // —— 架构四大件 ——
  premise: '故事前提',
  worldbuilding: '世界观',
  charactersArch: '人物群像',
  synopsis: '情节大纲',
  characterStates: '角色状态',
  // —— 分卷（Phase 19）——
  // ⚠️ `volumeTitle` / `volumePremise` / `volumeSynopsis` 目前**没有任何生产者**：
  // 实际的 `VolumeData` 用的是 title/premise/synopsis，而 `read_project_state`
  // 还不返回卷数据，`JsonCard` 按 JSON 原 key 查表，所以这三条**当前不可达**。
  // 保留它们是 DEV-PLAN 明确指定的**预置**——等 Agent 侧出现卷数据工具、
  // 输出带 volume 前缀的展示 key 时才生效（那三个裸 key 属于全书架构，
  // 直接复用会让「本卷主线」显示成「故事前提」，故不能就地改成裸名）。
  // 已登记待排期。
  volumeNumber: '卷序号',
  volumeTitle: '卷名',
  volumePremise: '本卷主线',
  volumeSynopsis: '本卷大纲',
  startChapter: '起始章',
  endChapter: '结束章',
  openingState: '开卷状态',
  closingState: '收卷状态',
  openThreads: '未回收伏笔',
  urgency: '优先级',
  thread: '伏笔内容',
  // 这两条是**当前就可达**的：卷记录用 `status`，伏笔条目用 `chapter`
  status: '状态',
  chapter: '章号',
  // —— 章节蓝图 ——
  chapterNumber: '章节号',
  role: '章节作用',
  purpose: '核心目的',
  keyEvents: '关键事件',
  characters: '出场角色',
  suspenseHook: '悬念钩子',
  notes: '要点',
  userGuidance: '用户指引',
  // —— 角色卡 ——
  gender: '性别',
  age: '年龄',
  appearance: '外貌',
  personality: '性格',
  background: '背景',
  abilities: '能力',
  motivation: '动机',
  relationships: '关系',
  arc: '弧光',
}

/** 枚举字段值 → 中文（按字段 key 归类） */
export const ENUM_LABELS: Record<string, Record<string, string>> = {
  plotStructure: {
    three_act: '三幕结构',
    heros_journey: '英雄之旅',
    save_the_cat: '节拍表',
    kishotenketsu: '起承转合',
    multi_thread: '多线叙事',
    freeform: '自由结构',
  },
  narrativePov: {
    first_person: '第一人称',
    third_limited: '第三人称有限视角',
    third_omniscient: '第三人称全知视角',
    multi_pov: '多视角轮换',
  },
  role: {
    protagonist: '主角',
    antagonist: '反派',
    supporting: '配角',
    minor: '次要角色',
  },
  // 卷状态三态，与 VOLUME_STATUS_LABELS 同一套文案（那边是 UI 徽章，这边是资料卡）
  status: {
    planned: '未开始',
    writing: '写作中',
    done: '已完成',
  },
  urgency: {
    high: '高',
    mid: '中',
    low: '低',
  },
}

/** 取字段中文标签；未收录返回原 key */
export function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key
}

/** 取枚举值中文；非枚举或未收录返回 null（调用方用原值） */
export function enumLabel(key: string, value: unknown): string | null {
  if (typeof value !== 'string') return null
  return ENUM_LABELS[key]?.[value] ?? null
}

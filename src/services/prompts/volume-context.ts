/**
 * volume-context — 分卷相关的上下文采集与格式化（Phase 19）
 *
 * 与 `volume-workflow.ts` 的职责切分：本文件只负责**读数据、拼文本**，
 * 不含工作流编排与写库。T4（目录接卷）与 T5（正文卷罗盘）同样需要
 * 「某卷章号区间内的实际写作要点」与「未回收伏笔清单」，故收在这里复用，
 * 避免各自再实现一遍口径不同的版本。
 */
import { ipc } from '../ipc-client'
import type { OpenThread } from '../../../electron/repositories/volume-repository'

/**
 * 把角色卡拼成状态档案文本。
 * 与 `chapter-context.ts` 的 `readCharacterStates` **同口径**——两处若分叉，
 * 续卷推演看到的角色状态会与写正文时看到的不一致。
 */
export async function readCharacterStates(): Promise<string> {
    try {
        const allChars = await ipc.invoke('db:character-get-all')
        const states: string[] = []
        for (const card of allChars) {
            if (card.name && card.currentState) {
                const cs = card.currentState
                states.push(
                    `${card.name}（${card.role || '未知'}）| ` +
                    `境界：${cs.powerLevel || '未知'} | 位置：${cs.location || '未知'} | ` +
                    `身体：${cs.physicalState || '正常'} | 心理：${cs.mentalState || '正常'} | ` +
                    `道具：${cs.keyItems || '无'} | 最近：第${cs.updatedAtChapter || 0}章 ${cs.recentEvents || ''}`
                )
            }
        }
        return states.length > 0 ? states.join('\n') : '（暂无角色状态档案）'
    } catch {
        return '（角色状态档案读取失败）'
    }
}

/**
 * 读某卷章号区间内各章的**实际写作要点**（蓝图 `notes`，由定稿后处理从正文提炼）。
 *
 * 刻意读 `notes` 而非 `keyEvents`：后者是当初的写作计划，正文写着写着必然偏离，
 * 拿计划去推演下一卷等于「接着一份过期的计划续」。无 notes 的章只留标题行。
 */
export async function readVolumeChapterNotes(startChapter: number, endChapter: number): Promise<string> {
    // ⚠️ **按实际存在的蓝图记录遍历，不按章号区间逐个探**。
    //
    // 早先是 `for (i = start; i <= end; i++) ipc('db:blueprint-get', i)`：
    // 区间有多长就发多少次 IPC，与库里实际有几条无关。
    // 而卷边界曾经可以合法地非常大——「两端都是安全整数」并不意味着
    // 「区间可遍历」。Task 19.4 已给单卷加了 `MAX_VOLUME_CHAPTERS` 上限，
    // 新建的卷不会再这样；但**老库与外部导入的库仍可能有**，
    // 而本函数不该假设数据都合规。
    // 改成一次取全量再过滤，耗时只与**真实数据量**相关，
    // 与区间大小彻底解耦——这比给区间加上限更根本，上限只是第二道。
    let blueprints: Array<{ chapterNumber: number; title?: string; notes?: string }>
    try {
        blueprints = (await ipc.invoke('db:blueprint-get-all')) as never
    } catch {
        return '（该卷暂无章节要点）'
    }

    const lines = (blueprints ?? [])
        .filter(bp => bp.chapterNumber >= startChapter && bp.chapterNumber <= endChapter)
        .sort((a, b) => a.chapterNumber - b.chapterNumber)
        .map(bp => (bp.notes?.trim()
            ? `【第${bp.chapterNumber}章 ${bp.title || ''}】\n${bp.notes.trim()}`
            : `【第${bp.chapterNumber}章 ${bp.title || ''}】（无要点）`))

    return lines.join('\n\n') || '（该卷暂无章节要点）'
}

/** 把未回收伏笔拼成可读清单，供 prompt 注入 */
export function formatOpenThreads(threads: OpenThread[] | undefined): string {
    if (!threads || threads.length === 0) return '（无未回收伏笔）'
    const label: Record<string, string> = { high: '高', mid: '中', low: '低' }
    return threads.map(t => `- [第${t.chapter}章 · ${label[t.urgency] ?? '中'}] ${t.thread}`).join('\n')
}

/**
 * 读取指定章号区间内已存在的蓝图，拼成「兼容参照」文本。
 *
 * 供孤儿蓝图 `keep` 策略使用：用户选择保留那几章的既定安排时，必须把它们注入
 * 卷大纲 prompt，否则 AI 会写出与之冲突的大纲（Spec §4.11 该策略要求「新卷大纲须兼容」）。
 * 此处读 `keyEvents` 而非 `notes`——这些章尚未写出，notes 必然为空，
 * keyEvents 才是它们「已定的安排」。
 *
 * 返回文本**自带约束说明**，不在模板里另写一条守则：模板守则是无条件存在的，
 * 而本段在无内容时会被空段落裁剪去掉，会留下一条引用已消失段落的悬空守则。
 *
 * **读失败抛错、不返回空串**：静默退化会让「保留旧蓝图」这个选项失效，
 * AI 照样写出冲突大纲——正是本注入要根治的问题，比直接失败更糟。
 */
export async function readRetainedBlueprints(startChapter: number, endChapter: number): Promise<string> {
    if (endChapter < startChapter) return ''
    const all = await ipc.invoke('db:blueprint-get-all')
    const inRange = all
        .filter(b => b.chapterNumber >= startChapter && b.chapterNumber <= endChapter)
        .sort((a, b) => a.chapterNumber - b.chapterNumber)
    if (inRange.length === 0) return ''

    const list = inRange
        .map(b => `第${b.chapterNumber}章 ${b.title || ''}：${(b.keyEvents || '').trim() || '（无关键事件）'}`)
        .join('\n')
    return `作者选择保留以下 ${inRange.length} 章的既定安排，你的大纲**必须与它们兼容**——` +
        `不得推翻这些章已定的事件走向，可在其前后补足过渡与铺垫，把它们自然纳入本卷主线：\n${list}`
}

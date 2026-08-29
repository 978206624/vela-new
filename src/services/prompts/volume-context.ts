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
    try {
        return await readVolumeChapterNotesStrict(startChapter, endChapter)
    } catch {
        return '（该卷暂无章节要点）'
    }
}

/**
 * 同上，但**读失败抛错、不返回回退文案**。
 *
 * 为什么必须有这个严格版：宽容版把「IPC/数据库临时失败」与「确实没有章节要点」
 * 压成同一个字符串，调用方分不出来。续卷（读**上一卷**的要点）可以接受降级——
 * 那一卷已经写完、大纲是新建的，缺要点只是推演质量差一点。
 *
 * 但「重新生成本卷大纲」不行：本卷可能已经写了十几章，Product-Spec §4.11 的硬约束是
 * **「已写章节是既成事实，不得推翻」**。读失败时静默回落成「暂无要点」，模型会
 * 当整卷空白重排一遍，而用户拿到的是一份看起来正常、实际与已发布正文冲突的大纲，
 * 还能点保存落库——比直接失败糟得多（Codex round-03 major #3）。
 *
 * 拆成两个导出而不是加个 `strict` 布尔参数：布尔参数会让调用点读起来像
 * `readVolumeChapterNotes(1, 60, true)`，那个 `true` 是什么得跳到定义里看。
 */
export async function readVolumeChapterNotesStrict(startChapter: number, endChapter: number): Promise<string> {
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
    const blueprints = (await ipc.invoke('db:blueprint-get-all')) as Array<{
        chapterNumber: number; title?: string; notes?: string
    }>

    const lines = (blueprints ?? [])
        .filter(bp => bp.chapterNumber >= startChapter && bp.chapterNumber <= endChapter)
        .sort((a, b) => a.chapterNumber - b.chapterNumber)
        .map(bp => (bp.notes?.trim()
            ? `【第${bp.chapterNumber}章 ${bp.title || ''}】\n${bp.notes.trim()}`
            : `【第${bp.chapterNumber}章 ${bp.title || ''}】（无要点）`))

    return lines.join('\n\n') || '（该卷暂无章节要点）'
}

/**
 * 「本卷已写事实」的快照——供「重新生成本卷大纲」做 fail-closed 前置校验与结算前复核。
 *
 * 与 `readVolumeChapterNotesStrict` 的差别：那个只给拼 prompt 用的文本，
 * 而本函数额外回答两个问题：
 *
 * ① **事实完整吗**：区间内每个**已定稿**章节都得有非空 `notes`。
 *    定稿流程是「先把草稿写成 finalized，再跑可能失败的 `chapter_notes` 后处理」，
 *    故「已定稿但 notes 为空」是实际可达的故障态。此时那一章的正文读者已经看过，
 *    模型却看不到它写了什么，会当空白重排——生成出来的大纲能推翻已发布正文，
 *    还能被用户点保存落库（Codex round-04 major）。
 * ② **事实是当前版本的吗**：Phase 14 允许重新定稿（改已定稿章节），而
 *    `finalizeExclusive` **不清** `blueprints.notes`。新版的后处理跑完之前，
 *    旧 notes 会冒充当前事实。故对每个已定稿章节还要比一次
 *    `notes_updated_at` 与该定稿稿件的 `updated_at`：notes 更早 = 属于上一版
 *    （Codex round-05 major #2）。
 * ③ **事实变了吗**：`digest` 是这份快照的稳定摘要。重生成跨一次分钟级 LLM 调用，
 *    期间另一条定稿工作流完全可能更新 notes。结算前重读一次、比对 digest，
 *    不一致就丢弃这份大纲——它是按过期事实生成的。
 */
export interface VolumeWrittenFacts {
    /** 拼 prompt 用的要点文本 */
    text: string
    /** 稳定摘要：仅由「章号 + notes 原文」决定，与读取顺序、无关字段无关 */
    digest: string
    /** 已定稿却没有 notes 的章号（升序）。非空 = 事实不完整，必须拦在 LLM 之前 */
    finalizedWithoutNotes: number[]
    /**
     * 已定稿、有 notes，但那份 notes **可证明地早于本次定稿**的章号（升序）。
     *
     * ⚠️ 判据是「**可证明**过期」，不是「无法证明新鲜」：`notes_updated_at` 为空时
     * 一律**不**算过期。空值是可达的正常状态——用户可以在「章节蓝图」界面手写要点，
     * 那条路径（`db:blueprint-upsert`）不写 `notes_updated_at`。
     * 把「证明不了」也算成过期，会让所有手写过要点的项目再也用不了重新生成。
     */
    finalizedWithStaleNotes: number[]
}

/**
 * 读一份「本卷已写事实」快照。**读失败抛错，不回落**（理由同 `readVolumeChapterNotesStrict`）。
 *
 * 定稿清单直接打 IPC 拿，**不读渲染层的 `draft-store`**：那份只覆盖「已有蓝图的章」，
 * 是展示用近似值（见 `countFinalizedInRange` 的注释）。fail-closed 的判据不能建在
 * 近似值上——它漏判一章，这道门就白设了。
 */
export async function readVolumeWrittenFacts(
    startChapter: number,
    endChapter: number,
): Promise<VolumeWrittenFacts> {
    const blueprints = (await ipc.invoke('db:blueprint-get-all')) as Array<{
        chapterNumber: number; title?: string; notes?: string; notesUpdatedAt?: string
    }>
    const finalized = await ipc.invoke('db:draft-list-finalized-in-range', startChapter, endChapter)

    const inRange = (blueprints ?? [])
        .filter(bp => bp.chapterNumber >= startChapter && bp.chapterNumber <= endChapter)
        .sort((a, b) => a.chapterNumber - b.chapterNumber)

    const notesByChapter = new Map<number, string>()
    const notesStampByChapter = new Map<number, string>()
    for (const bp of inRange) {
        notesByChapter.set(bp.chapterNumber, bp.notes?.trim() ?? '')
        notesStampByChapter.set(bp.chapterNumber, (bp.notesUpdatedAt ?? '').trim())
    }

    // 已定稿却没有要点的章。**遍历的是定稿清单**，不是蓝图列表——
    // 无蓝图却已定稿的章同样算「已写」，只看蓝图会漏掉它们
    const finalizedWithoutNotes = (finalized ?? [])
        .filter(f => !(notesByChapter.get(f.chapterNumber) ?? '').trim())
        .map(f => f.chapterNumber)
        .sort((a, b) => a - b)

    // 已定稿、有要点，但那份要点**可证明地**早于本次定稿（Phase 14 重新定稿后
    // 新版后处理还没跑完）。两个时间戳都是 SQLite 的 `datetime('now')`
    // （`YYYY-MM-DD HH:MM:SS`），字典序即时间序，可直接比。
    // ⚠️ 任一时间戳为空就**不判过期**：证明不了不等于过期（见类型注释）
    const finalizedWithStaleNotes = (finalized ?? [])
        .filter(f => {
            if (!(notesByChapter.get(f.chapterNumber) ?? '').trim()) return false  // 空要点归上一档
            const stamp = notesStampByChapter.get(f.chapterNumber) ?? ''
            if (!stamp || !f.finalizedAt) return false
            return stamp < f.finalizedAt
        })
        .map(f => f.chapterNumber)
        .sort((a, b) => a - b)

    const lines = inRange.map(bp => (bp.notes?.trim()
        ? `【第${bp.chapterNumber}章 ${bp.title || ''}】\n${bp.notes.trim()}`
        : `【第${bp.chapterNumber}章 ${bp.title || ''}】（无要点）`))

    // digest 只由「章号 + notes 原文」决定：标题改动、蓝图其它字段变化都不该
    // 让一份正在生成的大纲作废——它们不是「已写事实」
    const digest = JSON.stringify(
        [...notesByChapter.entries()].sort((a, b) => a[0] - b[0]),
    )

    return {
        text: lines.join('\n\n') || '（该卷暂无章节要点）',
        digest,
        finalizedWithoutNotes,
        finalizedWithStaleNotes,
    }
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

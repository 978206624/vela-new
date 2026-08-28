/**
 * volume-workflow-harness — **整条续卷工作流**的 UI-less 运行时证据（Phase 19 / Task 19.2b）
 *
 * ## 与 volume-commit-harness 的分工
 *
 * `volume-commit-harness` 测的是**主进程事务**：断言、不变量、回滚。
 * 本文件测的是**渲染层编排**：两次 `callLLM(logPolicy:'defer')` → `collectResult`
 * → 预览确认 / 取消 → `takeWorkflowResult` / `discardWorkflowResult`。
 *
 * 为什么必须分开测：事务 harness 直接调 `commitNextVolume()`，永远走不到延迟统计、
 * 产物回传、取消释放这三套设施。评审指出「只测 inspectFirstVolume 是纯读」
 * 并不能验收「取消 = 零副作用」——若 defer 或产物释放回归，那条用例仍会绿。
 *
 * ## 怎么在 node 里跑渲染层代码
 *
 * 渲染层经 `window.velaAPI.invoke` 打 IPC，而 `ipc-client` 是**调用时**才读 window
 * （不是模块加载时），所以在 import 之前塞一个 `globalThis.window` 就能接管全部通道，
 * 直接转发到真实仓储——于是断言的是真库里的行，不是 mock 的返回值。
 * LLM 则替换 `useLLMStore` 的 `generateStream`：本文件要验证的是编排，不是模型。
 *
 * ```bash
 * npm run harness:volume-workflow     # 退出码 0 = 全通过
 * ```
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ===== 1. 必须在任何渲染层模块 import 之前装好 window 垫片 =====

/** 记录每次 IPC 调用，供断言「取消后没打过写库通道」 */
const ipcLog: Array<{ channel: string; args: unknown[] }> = []

// 用 var + 延迟绑定：真正的 handler 要等仓储模块加载后才能装配
let invokeHandler: (channel: string, ...args: unknown[]) => Promise<unknown> = async () => {
    throw new Error('IPC handler 尚未装配')
}

;(globalThis as unknown as { window: unknown }).window = {
    velaAPI: {
        invoke: (channel: string, ...args: unknown[]) => {
            ipcLog.push({ channel, args })
            return invokeHandler(channel, ...args)
        },
        on: () => () => {},
        once: () => {},
        send: () => {},
        setZoomLevel: () => {},
        setZoomFactor: () => {},
        getZoomLevel: () => 0,
    },
}

// ===== 2. 主进程侧（真实仓储，非 mock）=====

import { initProjectDatabase, closeProjectDatabase, getProjectDb } from '../../electron/database'
import { VolumeRepository, type VolumeData } from '../../electron/repositories/volume-repository'
import { commitNextVolume, inspectFirstVolume } from '../../electron/repositories/volume-commit'
import { BlueprintRepository } from '../../electron/repositories/blueprint-repository'
import { PostProcessRepository } from '../../electron/repositories/post-process-repository'
import { ProjectCoreRepository } from '../../electron/repositories/project-core-repository'
import { applyProjectSave, applyProjectCoreUpdate } from '../../electron/services/project-save'

// ===== 3. 渲染层侧 =====

import { useWorkflowStore } from '../../src/stores/workflow-store'
import { useProjectStore, selectPendingConfigFields } from '../../src/stores/project-store'
import { useLLMStore } from '../../src/stores/llm-store'
import {
    createNextVolumeWorkflow,
    takeNextVolumeResult,
    discardNextVolumeResult,
    commitNextVolume as commitFromRenderer,
    buildCommitPayload,
    type NextVolumeWorkflowResult,
} from '../../src/services/workflows/volume-workflow'
import { createDirectoryWorkflow } from '../../src/services/workflows/directory-workflow'
import { useVolumeStore } from '../../src/stores/volume-store'
import { useVolumeFlowStore, invalidateVolumeFlow } from '../../src/stores/volume-flow-store'
// 只取类型：X26 用它做「除 project-switched 外全部 reason」的**编译期穷尽约束**
import type { StartFlowFailReason } from '../../src/services/volume-flow'

// ===== 迷你断言框架（与 volume-commit-harness 同款口径）=====

let passed = 0
const failures: string[] = []

async function testCase(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn()
        console.log(`  ✅ ${name}`)
        passed++
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.log(`  ❌ ${name}\n       ${msg}`)
        failures.push(`${name}: ${msg}`)
    }
}

function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new Error(`断言失败：${msg}`)
}

function assertEq<T>(actual: T, expected: T, what: string): void {
    const a = JSON.stringify(actual), e = JSON.stringify(expected)
    if (a !== e) throw new Error(`${what}\n       期望: ${e}\n       实际: ${a}`)
}

/** 五张表的完整快照——比事务 harness 多一张 llm_calls，因为本文件要验收延迟统计 */
function snapshot(): string {
    const db = getProjectDb()!
    return JSON.stringify({
        volumes: db.prepare('SELECT * FROM volumes ORDER BY volume_number').all(),
        blueprints: db.prepare('SELECT * FROM blueprints ORDER BY chapter_number').all(),
        drafts: db.prepare('SELECT * FROM drafts ORDER BY id').all(),
        core: db.prepare('SELECT * FROM project_core').all(),
        llmCalls: db.prepare('SELECT * FROM llm_calls ORDER BY id').all(),
    })
}

function assertUnchanged(before: string, what: string): void {
    const after = snapshot()
    if (before !== after) {
        throw new Error(`${what}：库发生了改动\n       before=${before.slice(0, 500)}\n       after =${after.slice(0, 500)}`)
    }
}

function countLLMCalls(): number {
    return (getProjectDb()!.prepare('SELECT COUNT(*) c FROM llm_calls').get() as { c: number }).c
}

// ===== 夹具 =====

let tmpRoot = ''
let dbSeq = 0
/** 当前项目 token。渲染层经 project-store.currentToken 读到它 */
let currentToken = 1

function freshEnv(): void {
    closeProjectDatabase()
    const dir = path.join(tmpRoot, `p-${++dbSeq}`)
    fs.mkdirSync(dir, { recursive: true })
    initProjectDatabase(dir)
    const db = getProjectDb()!
    db.prepare(
        `INSERT INTO project_core (id, project_name, total_chapters, synopsis, premise) VALUES ('main','harness',0,'原始大纲','某个前提')`
    ).run()
    for (let c = 1; c <= 10; c++) {
        const info = db.prepare(`INSERT INTO contents (body) VALUES (?)`).run(`第 ${c} 章正文`)
        db.prepare(
            `INSERT INTO drafts (chapter_number, version, status, content_id, word_count) VALUES (?,1,'finalized',?,100)`
        ).run(c, info.lastInsertRowid)
        db.prepare(
            `INSERT INTO blueprints (chapter_number, title, key_events, notes) VALUES (?,?,?,?)`
        ).run(c, `第${c}章`, `事件${c}`, `第${c}章要点`)
    }
    ipcLog.length = 0
    currentToken += 1

    // project-store：工作流只用到 currentProject 的存在性与 novelConfig.coreOutline，
    // 以及 currentToken（token 纪律的来源）。用 setState 直接摆好，不走 openProject
    useProjectStore.setState({
        currentProject: {
            id: 'harness', name: 'harness', path: dir,
            novelConfig: { coreOutline: '原始大纲', totalChapters: 0 },
        },
        currentToken,
    } as never)

    // workflow-store 每个用例清空，避免上一例的 results 残留
    useWorkflowStore.setState({ activeRuns: [], history: [], globalLogs: [], waitingRuns: {}, results: {} })
    // 续卷流程同样要作废：它有 single-flight 保护，上一例停在 wizard 的话，
    // 下一例的发起会被判成「已有流程在进行」——用例间互相污染。
    // 用 invalidateVolumeFlow 而不是裸 setState：它保证 flowId 不回退
    invalidateVolumeFlow()
    // 默认「ready 且零卷」= 真单卷模式。需要分卷的用例自行 setState 覆盖；
    // 默认设成 ready 而非 idle，是为了让「未就绪 fail closed」成为需要显式构造的场景，
    // 而不是所有用例都在无意中测它
    useVolumeStore.setState({ volumes: [], status: 'ready' })
}

/** 架构三大件 + 全书大纲，都得**超过** 50 字才过 directory-workflow 的既有闸门（`> 50`，不是 `>=`） */
const ARCH = {
    premise: '故事前提：主角沈砚出身北境边镇，因一枚来历不明的玉佩意外卷入王朝更替的暗流，被迫在旧秩序与新兴势力之间反复选边，每一次抉择都在缩小他的退路。',
    charactersArch: '角色图谱：主角沈砚是少年武者，师父柳无咎为前朝暗卫，宿敌赵北望执掌北境都督府，三方围绕玉佩与气脉枢纽构成核心张力网络，彼此既互相牵制又不得不短暂结盟。',
    worldbuilding: '世界观：王朝末年中央权威崩解，北境十三镇半独立自治，武道体系以气脉为根基，而玉佩正是前朝用来控制气脉枢纽的信物之一，得之可号令一方却也招致围杀。',
    synopsis: '全书情节大纲：主角从边镇少年一路成长为北境之主，先后经历夺镇、结盟、背叛与反攻，最终揭开玉佩背后的真相、终结王朝更替带来的长期动荡，故事在此彻底闭环收束。',
}

/**
 * 造一张角色卡。`guardDirectoryGeneration` 要求角色卡非空
 *（「角色图谱已生成」的反向约束），Agent 路径的用例必须先播种。
 */
function seedCharacter(): void {
    getProjectDb()!.prepare(
        `INSERT OR IGNORE INTO characters (name, role) VALUES ('沈砚', 'protagonist')`
    ).run()
}

/** 把架构四大件写进 project_core（默认 freshEnv 只写了短文本，过不了 50 字闸门） */
function seedArchitecture(): void {
    getProjectDb()!.prepare(
        `UPDATE project_core SET premise=?, characters_arch=?, worldbuilding=?, synopsis=? WHERE id='main'`
    ).run(ARCH.premise, ARCH.charactersArch, ARCH.worldbuilding, ARCH.synopsis)
}

/** 构造一条 VolumeData（与 volume-commit-harness 的 vol() 同款） */
function vol(n: number, start: number, end: number, extra: Partial<VolumeData> = {}): VolumeData {
    return {
        volumeNumber: n, title: `第${n}卷`, startChapter: start, endChapter: end,
        premise: '', synopsis: `卷${n}大纲`, openingState: '', closingState: '',
        openThreads: [], status: 'done', ...extra,
    }
}

/** 把若干卷置入 volume-store（生成关键路径读的是 store 快照，不是库） */
function setVolumes(vols: VolumeData[]): void {
    useVolumeStore.setState({ volumes: vols, status: 'ready' })
}

/**
 * 替换 LLM：按调用顺序依次返回预置的 JSON。
 * `failAt` 指定第几次调用（1-based）走 onError，用于验证失败路径的统计立即落库。
 */
function stubLLM(
    responses: string[],
    opts: {
        failAt?: number
        /** 第 N 次调用**完全结束之后**触发（模拟「两批之间」切项目） */
        afterCall?: (n: number) => void
        /**
         * 第 N 次调用**流到一半时**触发（第一个 chunk 之后、onDone 之前）。
         * 这才是真正危险的窗口：此时流式预览写入已经在发了、权威保存还没发，
         * 挂在 afterCall 上验不到这一段——那时两种写入都早已落库。
         */
        duringCall?: (n: number) => void | Promise<void>
        /**
         * 后半段**不作为 chunk 推送**，只在 onDone 里随完整文本给出。
         * 用于证明「整批保存确实补写了未预览到的章节」——否则第二个 chunk
         * 会把剩余章节也预览掉，断言就成了空转（Codex round-07 指出）。
         */
        withholdTail?: boolean
    } = {},
): {
    calls: number; prompts: string[]
} {
    const state = { calls: 0, prompts: [] as string[] }
    useLLMStore.setState({
        defaultModelId: 'm1',
        models: [{ id: 'm1', name: '测试模型' }],
        getModelIdForPurpose: () => 'm1',
        cancelGeneration: async () => {},
        generateStream: async (
            messages: Array<{ role: string; content: string }>,
            callbacks: { onChunk: (c: string) => void; onDone: (t: string, u?: unknown) => void; onError: (e: string) => void },
        ) => {
            // 留存实际发出的 prompt：没有它就无法证明「读到的是真 notes」
            state.prompts.push(messages.map(m => m.content).join('\n'))
            const idx = state.calls++
            // 异步 resolve，模拟真实流式：executor 会 await 这个 Promise 链
            setTimeout(() => {
                void (async () => {
                    if (opts.failAt !== undefined && state.calls === opts.failAt) {
                        callbacks.onError('模拟的模型调用失败')
                        return
                    }
                    const text = responses[idx] ?? '{}'
                    // 切成两段推，验证 streamChunkMode 的触发时机
                    callbacks.onChunk(text.slice(0, Math.floor(text.length / 2)))
                    // duringCall 可以是 async：同批次用例需要先等流式预览写入真正落库
                    // （那是个 .then 链，不 await 的话编辑会跑在预览之前，测的就不是那个窗口）
                    await opts.duringCall?.(state.calls)
                    if (!opts.withholdTail) {
                        callbacks.onChunk(text.slice(Math.floor(text.length / 2)))
                    }
                    callbacks.onDone(text, { promptTokens: 10, completionTokens: 20, totalTokens: 30 })
                    // 模拟「第 N 次调用**结束之后**、下一次发起之前」用户切了项目。
                    // 必须挂在 onDone 之后：挂在调用内部就已经晚了，那时守卫早已放行
                    opts.afterCall?.(state.calls)
                })()
            }, 0)
            return 'req-1'
        },
    } as never)
    return state
}

const CLOSING_JSON = JSON.stringify({
    closingState: '主角拿下北境',
    openThreads: [{ chapter: 3, thread: '玉佩来历未明', urgency: 'high' }],
})
const SYNOPSIS_JSON = JSON.stringify({
    title: '第二卷 · 南征',
    premise: '南下夺回失地',
    synopsis: '本卷分三段推进……',
    suggestedChapterCount: 5,
})

// ===== IPC 路由：全部转发到真实仓储 =====

invokeHandler = async (channel, ...args) => {
    switch (channel) {
        case 'db:volume-get-all':
            return VolumeRepository.getAll()
        case 'db:volume-inspect-first':
            return inspectFirstVolume()
        case 'db:blueprint-get':
            // 必须是 getByChapter——仓储上根本没有 get()。
            // 早先写错时异常被 readVolumeChapterNotes 的逐章 catch 吞掉，
            // harness 全绿却从未读到过任何真实 notes（W9 现在专门盯这条）
            return BlueprintRepository.getByChapter(args[0] as number)
        case 'db:blueprint-get-all':
            return BlueprintRepository.getAll()
        case 'db:blueprint-upsert-many': {
            // 复刻真实 controller：缺省 token 放行，token 不符即 stale
            const expected = args[1] as number | undefined
            if (expected !== undefined && expected !== currentToken) return { success: false, stale: true }
            BlueprintRepository.upsertMany(args[0] as never)
            return { success: true }
        }
        case 'db:character-get-all':
            // 转发到真实表：`guardDirectoryGeneration` 用「角色卡是否为空」当
            // 「角色图谱已生成」的反向约束，写死返回 [] 会让 Agent 路径永远进不去
            return getProjectDb()!.prepare('SELECT name, role FROM characters').all() as never
        // 保存蓝图那步会调 refreshFileTree() 刷侧边栏资产树。harness 不关心文件树，
        // 返回空目录即可——但**必须显式路由**，未知通道会直接抛错炸掉整个 harness
        case 'fs:list-dir':
            return []
        // 正文上下文拼装（buildChapterContext）会用到的只读通道。
        // 本 harness 只验证卷罗盘那一段，其余给最小可用返回值即可
        case 'fs:read-file':
            return { success: false, content: '' }
        case 'kb:search':
            return []
        // ── 导出 / 卷状态流转（Task 19.3c）用到的通道 ──
        case 'db:draft-get-finalized': {
            const row = getProjectDb()!.prepare(
                `SELECT id FROM drafts WHERE chapter_number = ? AND status = 'finalized' LIMIT 1`
            ).get(args[0] as number) as { id: number } | undefined
            return row ?? null
        }
        case 'db:draft-get-full': {
            const row = getProjectDb()!.prepare(`
                SELECT c.body as content FROM drafts d JOIN contents c ON c.id = d.content_id WHERE d.id = ?
            `).get(args[0] as number) as { content: string } | undefined
            return row ?? null
        }
        case 'db:volume-get-by-chapter':
            return VolumeRepository.getByChapter(args[0] as number)
        case 'db:volume-advance-status': {
            const expected = args[1] as number | undefined
            if (expected === undefined || expected !== currentToken) return { success: false, stale: true }
            return { success: true, changed: VolumeRepository.advanceStatusByChapter(args[0] as number) }
        }
        case 'db:volume-update-status': {
            // 复刻 db-controller 的守卫：**缺省 token 也判 stale**
            const expected = args[2] as number | undefined
            if (expected === undefined || expected !== currentToken) return { success: false, stale: true }
            const ok = VolumeRepository.updateStatus(args[0] as number, args[1] as never)
            return ok ? { success: true } : { success: false, error: '卷不存在' }
        }
        // ── 后处理记账（修复模式必经）。转发真实仓储而非写死返回值：
        //    写死 null / [] 会让「跳过已成功步骤」的逻辑永远走不到，
        //    X23b 想验的那一步根本执行不到，用例就成了空转 ──
        case 'db:post-process-get-latest-run':
            return PostProcessRepository.getLatestRun(args[0] as string, args[1] as string)
        case 'db:post-process-get-steps':
            return PostProcessRepository.getSteps(args[0] as string)
        case 'db:post-process-create-run':
            // 必须回 id：调用方检查 `!createRes.id` 并抛「创建跑批失败」，
            // 只回 {success:true} 会让用例挂在一个与被测行为无关的错误上
            return { success: true, id: PostProcessRepository.createRun(args[0] as never) }
        case 'db:post-process-mark-step-ok':
            PostProcessRepository.markStepOk(args[0] as string, args[1] as string)
            return { success: true }
        case 'db:post-process-mark-step-failed':
            PostProcessRepository.markStepFailed(args[0] as string, args[1] as string, args[2] as string)
            return { success: true }
        case 'db:post-process-is-all-passed':
            return PostProcessRepository.isAllCriticalPassed(args[0] as string, args[1] as string)
        case 'fs:mkdir':
            fs.mkdirSync(String(args[0]), { recursive: true })
            return { success: true }
        case 'fs:write-file':
            fs.mkdirSync(path.dirname(String(args[0])), { recursive: true })
            fs.writeFileSync(String(args[0]), String(args[1]), 'utf-8')
            return { success: true }
        case 'db:project-core-get': {
            const row = getProjectDb()!.prepare(`SELECT * FROM project_core WHERE id='main'`).get() as Record<string, unknown>
            // 转发真实列（含 revision）：写死子集会让保存 CAS 与冲突重载在 harness 里
            // 拿不到版本号，用例只能测个空壳
            return {
                projectName: row.project_name, genre: row.genre, subGenre: row.sub_genre,
                targetAudience: row.target_audience, totalChapters: row.total_chapters,
                wordsPerChapter: row.words_per_chapter, plotStructure: row.plot_structure,
                narrativePov: row.narrative_pov, writingStyle: row.writing_style,
                referenceWorks: row.reference_works, globalGuidance: row.global_guidance,
                goldenFinger: row.golden_finger, premise: row.premise,
                worldbuilding: row.worldbuilding, charactersArch: row.characters_arch,
                synopsis: row.synopsis, characterStates: row.character_states,
                revision: row.revision ?? 0,
            } as never
        }
        // ⚠️ 直接调**主进程的真实实现**，不再手写垫片。
        // 本 Task 已经两次栽在「垫片与真实 handler 不一致」上（一次漏了版本号
        // fail-closed，一次漏了 token 守卫），用例测的都是垫片自己的行为。
        // `applyProjectSave` / `applyProjectCoreUpdate` 把判定与写入从 ipcMain
        // handler 里抽了出来、当前项目 token 由调用方注入，两侧共用同一份代码。
        case 'project:save':
            return applyProjectSave({
                patch: args[1] as never,
                expectedRevision: args[2] as number,
                expectedToken: args[3] as number | undefined,
                currentToken,
            }) as never
        case 'db:project-core-update':
            return applyProjectCoreUpdate({
                patch: args[0] as never,
                expectedToken: args[1] as number | undefined,
                currentToken,
            }) as never
        case 'db:volume-commit-next': {
            // 复刻 db-controller 的 token 守卫。**缺省也必须拒**——
            // 真实 controller 对本通道要求必传 token，垫片若放行 undefined，
            // 就会把「忘了传 token」这类缺陷测成通过
            const expected = args[1] as number | undefined
            if (expected === undefined || expected !== currentToken) return { success: false, stale: true }
            return commitNextVolume(args[0] as never)
        }
        case 'db:log-llm-call': {
            const expected = args[1] as number | undefined
            if (expected !== undefined && expected !== currentToken) return { success: false, stale: true }
            const e = args[0] as Record<string, unknown>
            getProjectDb()!.prepare(`
        INSERT INTO llm_calls (model_id, model_name, purpose, prompt_tokens, completion_tokens, total_tokens, duration_ms, success, error_message)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(e.modelId, e.modelName, e.purpose, e.promptTokens, e.completionTokens, e.totalTokens, e.durationMs,
                e.success ? 1 : 0, e.errorMessage ?? '')
            return { success: true }
        }
        default:
            throw new Error(`harness 未路由的 IPC 通道：${channel}`)
    }
}

// ===== 用例 =====

async function main(): Promise<void> {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-wf-harness-'))
    console.log(`[harness] 临时库根目录：${tmpRoot}\n`)

    console.log('▶ 取消路径：零副作用')

    await testCase('W1 跑完整条工作流后取消预览 → 五张表（含 llm_calls）一字不改，产物已释放', async () => {
        freshEnv()
        stubLLM([CLOSING_JSON, SYNOPSIS_JSON])
        const before = snapshot()

        const runId = await useWorkflowStore.getState().startWorkflow(
            createNextVolumeWorkflow({ userIntent: '', structure: 'three_act', chapterCount: 5 })
        )

        // 工作流跑完了，但**一次库写入都不该发生**——前三步零副作用，第四步只等确认
        assertUnchanged(before, '工作流跑完、尚未确认时')
        assertEq(countLLMCalls(), 0, '两次 LLM 调用的统计必须还压在 context 里，没落库')

        const result = takeNextVolumeResult(runId)
        assert(result !== null, '产物应能取到（否则预览对话框拿不到数据）')
        assertEq(result!.deferredLLMLogs.length, 2, '两次调用的统计都应延迟在产物里')
        assertEq(result!.closingReport.closingState, '主角拿下北境', '收卷状态应来自第一次 LLM')
        assertEq(result!.draftVolume.title, '第二卷 · 南征', '卷名应来自第二次 LLM')

        // 用户点「取消」
        discardNextVolumeResult(runId)
        assertEq(takeNextVolumeResult(runId), null, '取消后产物必须已释放，不得留在 store 里')
        assertUnchanged(before, '用户取消后')
        assertEq(countLLMCalls(), 0, '取消 = 零副作用：延迟统计随之作废，一条都不该写')

        // 取消路径全程不该碰任何写库通道
        const writeChannels = ipcLog.filter(l => l.channel === 'db:volume-commit-next' || l.channel === 'db:log-llm-call')
        assertEq(writeChannels.length, 0, `取消路径不应调用写库通道，实际调了：${writeChannels.map(w => w.channel).join(',')}`)
    })

    console.log('\n▶ 确认路径：产物落库 + 延迟统计 flush')

    await testCase('W2 确认提交 → 卷落库、延迟统计一次性补写、产物释放', async () => {
        freshEnv()
        stubLLM([CLOSING_JSON, SYNOPSIS_JSON])

        const runId = await useWorkflowStore.getState().startWorkflow(
            createNextVolumeWorkflow({ userIntent: '南下', structure: 'three_act', chapterCount: 5 })
        )
        const r = takeNextVolumeResult(runId) as NextVolumeWorkflowResult
        assert(r !== null, '产物应能取到')

        const payload = buildCommitPayload(
            { prevVolume: r.prevVolume, firstVolume: r.firstVolume, closingReport: r.closingReport },
            r.draftVolume, 5,
        )
        const res = await commitFromRenderer(payload, r.capturedToken, r.deferredLLMLogs)
        assert(res.success, `提交应成功，实际：${res.error}`)

        assertEq(VolumeRepository.getAll().length, 2, '应有首卷 + 新卷两卷')
        assertEq(VolumeRepository.get(1)!.closingState, '主角拿下北境', '收卷状态应写进首卷')
        assertEq(VolumeRepository.get(2)!.title, '第二卷 · 南征', '新卷名')
        // 结转不变量：新卷台账必须**深等于**收卷报告的未回收清单，开卷状态同理。
        // 不断言这个的话，把 buildCommitPayload 的结转赋值退回 `[]` 仍会全绿（round-02 #5）
        assertEq(VolumeRepository.get(2)!.openThreads, r.closingReport.openThreads,
            '新卷台账必须由上一卷的未回收清单结转而来')
        assertEq(VolumeRepository.get(2)!.openingState, r.closingReport.closingState,
            '新卷开卷状态必须等于上一卷收卷状态')
        assertEq(countLLMCalls(), 2, '确认后两条延迟统计应一次性补写')

        const core = getProjectDb()!.prepare(`SELECT total_chapters, synopsis FROM project_core WHERE id='main'`)
            .get() as { total_chapters: number; synopsis: string }
        assertEq(core.total_chapters, 15, '总章数 = 新卷末章')
        assert(core.synopsis.includes('原始大纲') && core.synopsis.includes('第二卷 · 南征'),
            '情节大纲应是「原值 + 新卷段」，两边都在')
    })

    await testCase('W3 生成期间用户改了内存大纲 → 新卷段合并到用户版本，两边都不丢', async () => {
        freshEnv()
        stubLLM([CLOSING_JSON, SYNOPSIS_JSON])
        const runId = await useWorkflowStore.getState().startWorkflow(
            createNextVolumeWorkflow({ userIntent: '', structure: 'three_act', chapterCount: 5 })
        )
        const r = takeNextVolumeResult(runId) as NextVolumeWorkflowResult

        // 用户在预览期间编辑了情节大纲但没保存（只进了 zustand，没进库）
        useProjectStore.getState().updateNovelConfig({ coreOutline: '原始大纲\n\n用户后补的一段' })

        const payload = buildCommitPayload(
            { prevVolume: r.prevVolume, firstVolume: r.firstVolume, closingReport: r.closingReport },
            r.draftVolume, 5,
        )
        assert((await commitFromRenderer(payload, r.capturedToken, r.deferredLLMLogs)).success, '提交应成功')

        const storeOutline = useProjectStore.getState().currentProject!.novelConfig.coreOutline
        assert(storeOutline.includes('用户后补的一段'), '用户未保存的编辑不得被覆盖掉')
        assert(storeOutline.includes('第二卷 · 南征'), '新卷段必须并进来，否则用户一保存就把新卷抹掉')
    })

    await testCase('W4 提交前切了项目 → token 不符，主进程拒写，内存也不同步', async () => {
        freshEnv()
        stubLLM([CLOSING_JSON, SYNOPSIS_JSON])
        const runId = await useWorkflowStore.getState().startWorkflow(
            createNextVolumeWorkflow({ userIntent: '', structure: 'three_act', chapterCount: 5 })
        )
        const r = takeNextVolumeResult(runId) as NextVolumeWorkflowResult
        const before = snapshot()

        currentToken += 1 // 用户切到了别的项目
        useProjectStore.setState({ currentToken } as never)

        const payload = buildCommitPayload(
            { prevVolume: r.prevVolume, firstVolume: r.firstVolume, closingReport: r.closingReport },
            r.draftVolume, 5,
        )
        const res = await commitFromRenderer(payload, r.capturedToken, r.deferredLLMLogs)
        assert(!res.success, '项目已切换时必须拒绝')
        assert(res.error!.includes('项目已切换'), `实为：${res.error}`)
        assertUnchanged(before, '切项目后提交被拒')
        assertEq(countLLMCalls(), 0, '被拒时延迟统计也不该 flush')
    })

    console.log('\n▶ 失败路径：统计不能延迟到永远')

    await testCase('W5 第二次 LLM 调用失败 → 工作流失败、无产物；失败统计已立即落库', async () => {
        freshEnv()
        stubLLM([CLOSING_JSON, SYNOPSIS_JSON], { failAt: 2 })

        const runId = await useWorkflowStore.getState().startWorkflow(
            createNextVolumeWorkflow({ userIntent: '', structure: 'three_act', chapterCount: 5 })
        )
        assertEq(takeNextVolumeResult(runId), null, '失败的工作流不该留下产物（半成品会诱导 UI 误用）')
        assertEq(VolumeRepository.getAll().length, 0, '失败不得留下任何卷')
        // 第 1 次成功走 defer（随失败一起作废），第 2 次失败走立即写
        assertEq(countLLMCalls(), 1, '失败调用的统计必须立即落库——工作流已中止，延迟等于永远丢失')
        const row = getProjectDb()!.prepare('SELECT success, error_message FROM llm_calls').get() as
            { success: number; error_message: string }
        assertEq(row.success, 0, '落库的应是一条失败记录')
        assert(row.error_message.includes('模拟的模型调用失败'), `错误信息应保留，实为：${row.error_message}`)
    })

    console.log('\n▶ 入口参数校验：别烧掉两次 LLM 调用才报错')

    await testCase('W6 chapterCount 非法 → 建工作流时就抛，一次模型都不调', async () => {
        freshEnv()
        const llm = stubLLM([CLOSING_JSON, SYNOPSIS_JSON])
        let threw = ''
        try {
            createNextVolumeWorkflow({ userIntent: '', structure: 'three_act', chapterCount: 0 })
        } catch (e) { threw = e instanceof Error ? e.message : String(e) }
        assert(threw.includes('本卷章数非法'), `应在入口抛错，实为：${threw || '（没抛）'}`)
        assertEq(llm.calls, 0, '不得调用任何模型')
    })

    await testCase('W7 发现孤儿蓝图却没选处置策略 → 第一步就终止，不进 LLM', async () => {
        freshEnv()
        // 造孤儿：第 11、12 章有蓝图但未定稿
        getProjectDb()!.prepare(`INSERT INTO blueprints (chapter_number,title,key_events) VALUES (11,'BP-11','e11')`).run()
        getProjectDb()!.prepare(`INSERT INTO blueprints (chapter_number,title,key_events) VALUES (12,'BP-12','e12')`).run()
        const llm = stubLLM([CLOSING_JSON, SYNOPSIS_JSON])
        const before = snapshot()

        const runId = await useWorkflowStore.getState().startWorkflow(
            createNextVolumeWorkflow({ userIntent: '', structure: 'three_act', chapterCount: 5 })
        )
        assertEq(llm.calls, 0, '策略缺省时不该发起任何模型调用')
        assertEq(takeNextVolumeResult(runId), null, '失败的工作流无产物')
        assertUnchanged(before, '终止后')
    })

    await testCase('W8 keep 且新卷盖不住孤儿区间 → 第一步就终止，不进 LLM', async () => {
        freshEnv()
        for (const c of [11, 12, 18]) {
            getProjectDb()!.prepare(`INSERT INTO blueprints (chapter_number,title,key_events) VALUES (?,?,?)`)
                .run(c, `BP-${c}`, `e${c}`)
        }
        const llm = stubLLM([CLOSING_JSON, SYNOPSIS_JSON])
        const before = snapshot()

        // 首卷止于 10，新卷 3 章 → 止于 13，盖不住孤儿末章 18
        const runId = await useWorkflowStore.getState().startWorkflow(
            createNextVolumeWorkflow({ userIntent: '', structure: 'three_act', chapterCount: 3, orphanPolicy: 'keep' })
        )
        assertEq(llm.calls, 0, '必须在两次 LLM 调用之前拦下，否则成本已经烧掉了')
        assertEq(takeNextVolumeResult(runId), null, '失败的工作流无产物')
        assertUnchanged(before, '终止后')

        const logs = useWorkflowStore.getState().globalLogs.map(l => l.message).join('\n')
        assert(logs.includes('保留旧蓝图'), `错误应说清怎么改，实为：\n${logs.slice(-500)}`)
    })

    await testCase('W9 第一次 prompt 里确实带着库里的真实章节要点（防垫片写错却全绿）', async () => {
        freshEnv()
        const llm = stubLLM([CLOSING_JSON, SYNOPSIS_JSON])
        await useWorkflowStore.getState().startWorkflow(
            createNextVolumeWorkflow({ userIntent: '', structure: 'three_act', chapterCount: 5 })
        )
        assertEq(llm.calls, 2, '应发起两次调用')
        // readVolumeChapterNotes 对每一章都是 try/catch，读失败会静默变成「暂无章节要点」。
        // 早先垫片错调了不存在的 BlueprintRepository.get()，异常被逐章吞掉，
        // 8 个用例全绿却一条真实 notes 都没读到——本断言就是为堵这个洞
        assert(llm.prompts[0].includes('第1章要点'), '第一次 prompt 应含第 1 章的真实 notes')
        assert(llm.prompts[0].includes('第10章要点'), '第一次 prompt 应含第 10 章的真实 notes')
        assert(!llm.prompts[0].includes('暂无章节要点'),
            `不应出现兜底文案，说明 notes 读取整体失败了：\n${llm.prompts[0].slice(0, 400)}`)
    })

    await testCase('W10 第一次 LLM 之后切项目 → 第二次调用不得发起，B 库零写入', async () => {
        freshEnv()
        // 在第 2 次调用发起前切项目：这是 W4 覆盖不到的窗口
        //（W4 是两次调用都结束后才切，测的是提交期守卫）
        const llm = stubLLM([CLOSING_JSON, SYNOPSIS_JSON], {
            afterCall: (n) => {
                if (n === 1) {                    currentToken += 1
                    useProjectStore.setState({ currentToken } as never)
                }
            },
        })
        const before = snapshot()
        const runId = await useWorkflowStore.getState().startWorkflow(
            createNextVolumeWorkflow({ userIntent: '', structure: 'three_act', chapterCount: 5 })
        )
        assertEq(takeNextVolumeResult(runId), null, '切了项目的工作流不该产出可提交的产物')
        assertUnchanged(before, '切项目后')
        assertEq(llm.calls, 1, '第二次调用必须被拦在发模之前，只应发生过一次')
        assertEq(countLLMCalls(), 0,
            '第二次调用被拦在发模之前，不该产生任何统计——尤其不能记进切换后的新项目库')
    })

    await testCase('W11 不 take 直接 discard → 产物同样释放（覆盖 discard 本身）', async () => {
        freshEnv()
        stubLLM([CLOSING_JSON, SYNOPSIS_JSON])
        const runId = await useWorkflowStore.getState().startWorkflow(
            createNextVolumeWorkflow({ userIntent: '', structure: 'three_act', chapterCount: 5 })
        )
        // W1 是先 take 再 discard，那时 discard 已是 no-op，测不到它本身
        assert(useWorkflowStore.getState().results[runId] !== undefined, '前置：产物应还在 store 里')
        discardNextVolumeResult(runId)
        assertEq(useWorkflowStore.getState().results[runId], undefined, 'discard 后产物必须消失')
        assertEq(takeNextVolumeResult(runId), null, 'discard 之后再 take 应拿不到')
        assertEq(countLLMCalls(), 0, '取消 = 零副作用')
    })

    console.log('\n▶ 目录生成接卷（Task 19.3a）')

    /**
     * 跑一次目录生成，返回**全部批次**的 prompt。
     * 只看首个 prompt 会漏掉「第二批切到下一卷」这类跨卷缺陷（round-01 #8）。
     */
    async function runDirectoryAll(opts: {
        mode?: 'append' | 'full'
        startChapter?: number
        count?: number
        /** 每批模型返回什么。默认空数组；要模拟超额返回就在这里塞跨卷章节 */
        responses?: string[]
    } = {}): Promise<string[]> {
        const { mode = 'append', startChapter = 11, count = 3 } = opts
        const llm = stubLLM(opts.responses ?? ['{"blueprints":[]}', '{"blueprints":[]}', '{"blueprints":[]}'])
        await useWorkflowStore.getState().startWorkflow(
            mode === 'full'
                ? createDirectoryWorkflow({ mode: 'full', count })
                : createDirectoryWorkflow({ mode: 'append', startChapter, count })
        )
        assert(llm.prompts.length > 0,
            `目录工作流没发出任何 prompt：${useWorkflowStore.getState().globalLogs.map(l => l.message).join(' | ').slice(-400)}`)
        return llm.prompts
    }

    /** 只要首批 prompt 的便捷包装 */
    async function runDirectory(count = 3, startChapter = 11): Promise<string> {
        return (await runDirectoryAll({ count, startChapter }))[0]
    }

    await testCase('V1 零卷（单卷模式）：architecture 与分卷前逐字节一致', async () => {
        freshEnv()
        seedArchitecture()
        const prompt = await runDirectory()
        // 分卷前的组装就是「四大件按 \n\n---\n\n 依次拼接」。本 Task 把 synopsis
        // 拆出去单独走 getVolumeOutline，零卷回落必须还原成完全相同的串
        const expected = [ARCH.premise, ARCH.charactersArch, ARCH.worldbuilding, ARCH.synopsis].join('\n\n---\n\n')
        assert(prompt.includes(expected),
            `零卷 architecture 应与分卷前逐字节一致。\n实际 prompt 片段：\n${prompt.slice(0, 900)}`)
    })

    await testCase('V2 零卷：两个卷段落被 finalizePrompt 裁净，不留孤儿标题', async () => {
        freshEnv()
        seedArchitecture()
        const prompt = await runDirectory()
        // 断言的是**小节标题**（带「（如有）」的那个形态）被整段裁掉。
        // 不能只搜「【待回收伏笔台账」——指令正文里有一句「优先处理【待回收伏笔台账】中列出的条目」，
        // 那是对小节的引用而非孤儿标题，单卷模式下它由后半句「台账为空时，则…」兜住
        assert(!prompt.includes('【本卷定位（如有）】'),
            `单卷模式不该残留本卷定位标题：\n${prompt.slice(0, 700)}`)
        assert(!prompt.includes('【待回收伏笔台账（如有）】'), '单卷模式不该残留伏笔台账标题')
        assert(!prompt.includes('（无未回收伏笔）'),
            '零卷必须传空串而非 formatOpenThreads 的占位文案，否则标题裁不掉')
        // 正向确认裁剪确实发生过：架构池之后应直接接前置进度，中间没有空标题
        assert(/【全书架构数据池】\n[\s\S]*?\n\n【前置剧情进度与连贯性检查】/.test(prompt),
            `裁剪后两段应直接相邻：\n${prompt.slice(prompt.indexOf('【全书架构数据池】'), prompt.indexOf('【全书架构数据池】') + 400)}`)
    })

    await testCase('V3 有卷：architecture 换成本卷主线/大纲，且**不含**全书 synopsis', async () => {
        freshEnv()
        seedArchitecture()
        setVolumes([
            vol(1, 1, 10, { title: '第一卷', premise: '边镇少年初露锋芒', synopsis: '第一卷卷内大纲：从边镇到北境' }),
            vol(2, 11, 60, {
                title: '第二卷 · 北境风雪', premise: '本卷主线：夺回北境十三镇',
                synopsis: '第二卷卷内大纲：三段式推进', openingState: '主角已掌握玉佩', status: 'planned',
            }),
        ])
        const prompt = await runDirectory()
        assert(!prompt.includes(ARCH.synopsis),
            '有卷时绝不能注入已闭环的全书 synopsis——那正是本 Phase 要根治的缺陷')
        assert(prompt.includes('本卷主线：夺回北境十三镇'), '应含本卷主线')
        assert(prompt.includes('第二卷卷内大纲：三段式推进'), '应含本卷卷内大纲')
        assert(prompt.includes(ARCH.premise) && prompt.includes(ARCH.worldbuilding),
            '三大件是全书唯一的，任何卷都照原样喂')
        // 不断言 openingState 的话，把 withVolumeContext() 整个删掉本用例仍会绿
        assert(prompt.includes('主角已掌握玉佩'), '上一卷收卷状态必须注入（本卷 openingState）')
        assert(prompt.includes('【上一卷收卷状态】'), '应带小标题，AI 才知道这段是什么')
    })

    await testCase('V4 有卷：全书规模报**本卷末章**，而非全书有效总章数', async () => {
        freshEnv()
        seedArchitecture()
        setVolumes([
            vol(1, 1, 10, { title: '第一卷' }),
            vol(2, 11, 60, { title: '第二卷', status: 'planned' }),
        ])
        // ⚠️ 必须在**第一卷内**生成，让「本卷末章(10)」与「全书有效总章数(60)」分离。
        // 早先这条测的是第二卷（末章 60 == 有效总章数），两者不可区分——
        // 把 scopeTotal 改回 totalChapters 的变异下用例照样绿，等于没测
        const prompt = await runDirectory(3, 5)
        assert(prompt.includes('共 10 章'),
            `全书规模应报本卷末章 10。实际：
${prompt.slice(0, 600)}`)
        assert(!prompt.includes('共 60 章'),
            '报全书总章数会与「请推演第 5–7 章」形成矛盾指令：AI 一边被告知全书 60 章、一边只写到第 10 章')
    })

    await testCase('V5 前置进度优先取 notes（实际写成的），回落 keyEvents（当初计划的）', async () => {
        freshEnv()
        seedArchitecture()
        const db = getProjectDb()!
        // 第 3 章有 notes（定稿后处理提炼的实际要点），第 4 章只有 keyEvents
        db.prepare(`UPDATE blueprints SET notes='第3章实际写成：主角改走水路', key_events='第3章原计划：主角走陆路' WHERE chapter_number=3`).run()
        db.prepare(`UPDATE blueprints SET notes='', key_events='第4章原计划：抵达渡口' WHERE chapter_number=4`).run()
        const prompt = await runDirectory()
        assert(prompt.includes('第3章实际写成：主角改走水路'), '有 notes 时必须用 notes')
        assert(!prompt.includes('第3章原计划：主角走陆路'),
            '计划与写成的正文已分叉，喂计划会让新章节接到一条不存在的剧情线上')
        assert(prompt.includes('第4章原计划：抵达渡口'), '无 notes 时回落 keyEvents')
    })

    await testCase('V6 伏笔台账注入本卷条目，且不重复', async () => {
        freshEnv()
        seedArchitecture()
        setVolumes([
            vol(1, 1, 10, { title: '第一卷', openThreads: [{ chapter: 3, thread: '玉佩来历未明', urgency: 'high' }] }),
            vol(2, 11, 60, {
                title: '第二卷', status: 'planned',
                // 建卷时已由 buildCommitPayload 从上一卷结转过来，本卷台账即权威
                openThreads: [
                    { chapter: 3, thread: '玉佩来历未明', urgency: 'high' },
                    { chapter: 9, thread: '用户手工补录的线索', urgency: 'mid' },
                ],
            }),
        ])
        const prompt = await runDirectory()
        assert(prompt.includes('玉佩来历未明'), '结转进本卷的伏笔必须注入')
        assert(prompt.includes('用户手工补录的线索'), '用户手工补录的条目同样要注入')
        assert(prompt.includes('[第3章 · 高]'), `应带埋设章号与优先级。实际：
${prompt.slice(0, 500)}`)
        const occurrences = prompt.split('玉佩来历未明').length - 1
        assertEq(occurrences, 1, '同一条目不得在 prompt 里出现两遍')
    })

    await testCase('V7 分卷数据未就绪 → 终止生成，不按零卷继续', async () => {
        freshEnv()
        seedArchitecture()
        useVolumeStore.setState({ volumes: [], status: 'loading' })
        const llm = stubLLM(['{"blueprints":[]}'])
        const before = snapshot()
        await useWorkflowStore.getState().startWorkflow(
            createDirectoryWorkflow({ mode: 'append', startChapter: 11, count: 3 })
        )
        assertEq(llm.calls, 0,
            '未就绪时必须 fail closed——当零卷继续会退回「全书总章数 + 已闭环 synopsis」的老路')
        assertUnchanged(before, '终止后')
        const logs = useWorkflowStore.getState().globalLogs.map(l => l.message).join('\n')
        assert(logs.includes('正在加载'), `错误应说清原因，实为：\n${logs.slice(-400)}`)
    })

    await testCase('V8 单批不得横跨卷界：第二批必须切到下一卷的上下文', async () => {
        freshEnv()
        seedArchitecture()
        setVolumes([
            vol(1, 1, 10, { title: '第一卷', premise: '卷一主线：夺回边镇' }),
            vol(2, 11, 60, { title: '第二卷', premise: '卷二主线：南征', status: 'planned' }),
        ])
        // 从第 8 章生成 6 章 → 跨越卷界（8–10 属卷一，11–13 属卷二）。
        // 不夹住的话首批就是 8–13：用卷一大纲、声明「共 10 章」，却要求生成第 11–13 章
        const prompts = await runDirectoryAll({ startChapter: 8, count: 6 })
        assertEq(prompts.length, 2, '跨卷应恰好拆成两批——只断言「至少两批」发现不了多余的重复批次')
        assert(prompts[0].includes('共 10 章') && prompts[0].includes('第8章 到 第10章'),
            `首批应止于卷一末章。实际：\n${prompts[0].slice(0, 600)}`)
        assert(prompts[0].includes('卷一主线：夺回边镇'), '首批应用卷一上下文')
        assert(prompts[1].includes('共 60 章') && prompts[1].includes('第11章 到 第13章'),
            `第二批应切到卷二。实际：\n${prompts[1].slice(0, 600)}`)
        assert(prompts[1].includes('卷二主线：南征'), '第二批应用卷二上下文')
    })

    await testCase('V9 模型超额返回跨卷章节 → 一条都不落库', async () => {
        freshEnv()
        seedArchitecture()
        setVolumes([
            vol(1, 1, 10, { title: '第一卷' }),
            vol(2, 11, 60, { title: '第二卷', premise: '卷二主线：南征', status: 'planned' }),
        ])
        // 首批只该覆盖 8–10，但模型一口气返回到第 13 章（真实模型常这么干）。
        // ⚠️ 污染标题必须**唯一可辨**：早先写成「第11章」，与合法生成的标题撞车，
        // 断言 `!ch11 || title === '第11章'` 反而放行了污染——把流式过滤退回
        // endChapter 的变异下用例照样绿，是个假阳性（round-02 #4）
        const overflow = JSON.stringify({
            blueprints: [8, 9, 10, 11, 12, 13].map(n => ({
                chapterNumber: n, title: `OVERFLOW-${n}`, role: '发展', purpose: 'p',
                characters: [], keyEvents: `事件${n}`, suspenseHook: 'h',
            })),
        })
        // 第二批返回空：这样第 11–13 章若出现在库里，只可能来自首批的跨卷污染
        const prompts = await runDirectoryAll({
            startChapter: 8, count: 6,
            responses: [overflow, '{"blueprints":[]}', '{"blueprints":[]}'],
        })
        const db = getProjectDb()!
        const polluted = db.prepare(
            `SELECT chapter_number FROM blueprints WHERE title LIKE 'OVERFLOW-%' AND chapter_number > 10`
        ).all() as Array<{ chapter_number: number }>
        assertEq(polluted, [],
            '跨卷章节不得被首批（卷一上下文）落库——它们会带着上一卷的大纲与伏笔台账定型')
        // 卷一范围内的超额返回是允许的（本来就属于本批的卷）
        assertEq(
            (db.prepare(`SELECT COUNT(*) c FROM blueprints WHERE title LIKE 'OVERFLOW-%'`).get() as { c: number }).c,
            3, '第 8–10 章属于卷一，应正常落库')
        assertEq(prompts.length, 2, '超额返回不得让 cursor 跳过卷二')
        assert(prompts[1].includes('卷二主线：南征'), '第二批必须仍带卷二上下文')
    })

    await testCase('V10 分卷项目跑 full → 不走 legacy 全量模板，仍按卷分批', async () => {
        freshEnv()
        seedArchitecture()
        setVolumes([
            vol(1, 1, 10, { title: '第一卷', premise: '卷一主线：夺回边镇' }),
            vol(2, 11, 60, { title: '第二卷', premise: '卷二主线：南征', status: 'planned' }),
        ])
        const prompts = await runDirectoryAll({ mode: 'full', count: 13 })
        // legacy chapter_blueprint 模板没有卷占位符，且一次要求生成 1..endChapter，
        // 分卷项目走它会拿第一卷 architecture 生成整本书，后续再也切不回第二卷
        assert(prompts[0].includes('卷一主线：夺回边镇'),
            `分卷模式的 full 也必须带卷上下文。实际：\n${prompts[0].slice(0, 600)}`)
        assert(prompts[0].includes('共 10 章'), '首批仍应按卷一末章报规模')
        assertEq(prompts.length, 2, '应恰好按卷拆成两批')
        assert(prompts[1].includes('卷二主线：南征'), '应继续按卷分批切到卷二')
    })

    await testCase('V11 逐批卷界 guard 现在是纵深防御：正常入口已被前置校验拦在更早', async () => {
        freshEnv()
        seedArchitecture()
        setVolumes([vol(1, 1, 10, { title: '第一卷' }), vol(2, 11, 60, { title: '第二卷' })])
        const llm = stubLLM(['{"blueprints":[]}'])
        const before = snapshot()
        await useWorkflowStore.getState().startWorkflow(
            createDirectoryWorkflow({ mode: 'append', startChapter: 61, count: 3 })
        )
        // round-02 加了整区间前置校验后，越界在第一次 LLM 之前就被拒，
        // 报的是「已超出最后一卷」而不是逐批 guard 的「不属于任何卷」。
        // 逐批 guard 因此成为纯纵深防御——快照只取一次，区间已校验，
        // 正常入口下 cursor 不可能落到卷外。此处固化该结论：
        // 若将来有人放宽前置校验导致逐批 guard 重新可达，下面的断言会先红
        assertEq(llm.calls, 0, '越界必须在任何模型调用前拒绝')
        assertUnchanged(before, '库不变')
        const logs = useWorkflowStore.getState().globalLogs.map(l => l.message).join('\n')
        assert(logs.includes('已超出最后一卷'),
            `应由前置校验拦下（而非逐批 guard），实为：\n${logs.slice(-400)}`)
        assert(!logs.includes('不属于任何卷（当前最后一卷'),
            '不应走到逐批 guard——那意味着已经进过生成循环')
    })

    await testCase('V12 伏笔台账以**本卷**为权威：已回收不复活', async () => {
        freshEnv()
        seedArchitecture()
        setVolumes([
            vol(1, 1, 10, {
                title: '第一卷',
                openThreads: [
                    { chapter: 3, thread: '玉佩来历未明', urgency: 'high' },
                    { chapter: 7, thread: '卷二已回收的旧线索', urgency: 'mid' },
                ],
            }),
            vol(2, 11, 60, {
                title: '第二卷', status: 'planned',
                // 结转后用户在卷详情里回收了「旧线索」，本卷台账才是权威
                openThreads: [{ chapter: 3, thread: '玉佩来历未明', urgency: 'high' }],
            }),
        ])
        const prompt = await runDirectory()
        assert(prompt.includes('玉佩来历未明'), '本卷台账里的条目必须注入')
        assert(!prompt.includes('卷二已回收的旧线索'),
            '本卷已清掉的条目不得被上一卷「复活」——合并方案的核心缺陷')
    })

    await testCase('V12b 真实结转链：V1→V2 走完整工作流，新卷台账由收卷报告结转而来', async () => {
        freshEnv()
        // ⚠️ 不手工塞 store，而是**真的跑一遍续卷工作流并提交**，
        // 断言库里落下的新卷台账。V12 那种手工构造的夹具证明不了结转真的发生过
        // ——把 buildCommitPayload 的结转赋值退回 `[]`，V12 照样绿（round-02 #5）
        stubLLM([CLOSING_JSON, SYNOPSIS_JSON])
        const runId = await useWorkflowStore.getState().startWorkflow(
            createNextVolumeWorkflow({ userIntent: '', structure: 'three_act', chapterCount: 5 })
        )
        const r = takeNextVolumeResult(runId) as NextVolumeWorkflowResult
        assert(r !== null, '产物应能取到')
        assert(r.closingReport.openThreads.length > 0, '前置：收卷报告应含未回收伏笔')

        const payload = buildCommitPayload(
            { prevVolume: r.prevVolume, firstVolume: r.firstVolume, closingReport: r.closingReport },
            r.draftVolume, 5,
        )
        assert((await commitFromRenderer(payload, r.capturedToken, r.deferredLLMLogs)).success, '提交应成功')

        const v1 = VolumeRepository.get(1)!
        const v2 = VolumeRepository.get(2)!
        assertEq(v2.openThreads, r.closingReport.openThreads, '新卷台账 = 上一卷收卷报告的未回收清单')
        assertEq(v1.openThreads, r.closingReport.openThreads, '上一卷保留自己那份历史快照')

        // 结转之后，第 11 章（属新卷）的罗盘必须能看到这些伏笔——
        // 这正是「只读本卷台账」在多卷链条上不断链的证据
        useVolumeStore.setState({ volumes: VolumeRepository.getAll(), status: 'ready' })
        seedArchitecture()
        const prompt = await runDirectory(3, 11)
        assert(prompt.includes('玉佩来历未明'),
            `结转进新卷的伏笔必须出现在新卷的目录 prompt 里。实际：\n${prompt.slice(0, 600)}`)
    })

    await testCase('V13 生成范围超出末卷 → 在任何 LLM 调用与落库**之前**拒绝', async () => {
        freshEnv()
        seedArchitecture()
        setVolumes([vol(1, 1, 10, { title: '第一卷' }), vol(2, 11, 60, { title: '第二卷' })])
        const llm = stubLLM(['{"blueprints":[]}', '{"blueprints":[]}'])
        const before = snapshot()
        // 58–63 跨出末卷。逐批检查是不够的：58–60 那批会先跑完模型、把蓝图写进库，
        // 游标推到 61 才报错——工作流失败了，副作用却已经产生（round-02 #1）
        await useWorkflowStore.getState().startWorkflow(
            createDirectoryWorkflow({ mode: 'append', startChapter: 58, count: 6 })
        )
        assertEq(llm.calls, 0, '必须在第一次 LLM 调用之前就拒绝')
        assertUnchanged(before, '拒绝后库一字不改（尤其不能留下 58–60 的蓝图）')
        const logs = useWorkflowStore.getState().globalLogs.map(l => l.message).join('\n')
        assert(logs.includes('已超出最后一卷'), `错误应点明超出末卷，实为：\n${logs.slice(-400)}`)
    })

    await testCase('V14 末卷之后续写且不传章数 → 显式报错，不得静默生成 0 章', async () => {
        freshEnv()
        seedArchitecture()
        setVolumes([vol(1, 1, 10, { title: '第一卷' }), vol(2, 11, 60, { title: '第二卷' })])
        const llm = stubLLM(['{"blueprints":[]}'])
        const before = snapshot()
        // 不传 count 时 endChapter 仍是有效总章数 60，startChapter=61 → 区间为空。
        // while 一次都不进，工作流会以「已生成 0 章」**静默成功**，用户以为生成过了
        await useWorkflowStore.getState().startWorkflow(
            createDirectoryWorkflow({ mode: 'append', startChapter: 61 })
        )
        assertEq(llm.calls, 0, '空区间不该调用模型')
        assertUnchanged(before, '库不变')
        const logs = useWorkflowStore.getState().globalLogs.map(l => l.message).join('\n')
        assert(logs.includes('生成范围为空'), `必须显式报错而非静默成功，实为：\n${logs.slice(-400)}`)
    })

    await testCase('V15 卷间缺口落在请求范围内 → 前置拒绝', async () => {
        freshEnv()
        seedArchitecture()
        // 人为制造缺口：卷一 1–10、卷二 15–60，第 11–14 章无卷归属
        setVolumes([vol(1, 1, 10, { title: '第一卷' }), vol(2, 15, 60, { title: '第二卷' })])
        const llm = stubLLM(['{"blueprints":[]}'])
        const before = snapshot()
        await useWorkflowStore.getState().startWorkflow(
            createDirectoryWorkflow({ mode: 'append', startChapter: 8, count: 10 })
        )
        assertEq(llm.calls, 0, '范围内存在无卷归属的章号时不该开始生成')
        assertUnchanged(before, '库不变')
        const logs = useWorkflowStore.getState().globalLogs.map(l => l.message).join('\n')
        assert(logs.includes('第 11–14 章不属于任何卷'), `应点名缺口区间，实为：\n${logs.slice(-400)}`)
    })

    console.log('\n▶ 正文卷罗盘（Task 19.3b）')

    /** 拼一次正文上下文，返回 { 实际发送的 prompt, 预览分段 } */
    async function buildDraftContext(chapterNumber: number) {
        const { buildChapterContext } = await import('../../src/services/prompts/chapter-context')
        const ctx = await buildChapterContext({ chapterNumber, title: `第${chapterNumber}章`, userGuidance: '' } as never)
        return { prompt: ctx.builder.build(), segments: ctx.segments }
    }

    await testCase('C1 零卷（单卷模式）：罗盘不注入，预览里**也不出现空卡片**', async () => {
        freshEnv()
        seedArchitecture()
        const { prompt, segments } = await buildDraftContext(5)
        assert(!prompt.includes('【本卷罗盘（如有）】'), `不该残留罗盘标题：\n${prompt.slice(0, 500)}`)
        assert(!prompt.includes('当前卷：'), '不该出现卷信息')
        // 实际 prompt 已被 finalizePrompt 整段裁掉，预览就不能再显示「本卷罗盘 ~0（空）」——
        // 那既破坏「预览==执行」，也让单卷模式的老项目看见本不该有的分卷卡片
        assertEq(segments.find(s => s.key === 'volume_compass'), undefined, '预览不得有空的罗盘分段')
        assertEq(segments.find(s => s.key === 'volume_position'), undefined, '预览不得有空的位置分段')
    })

    await testCase('C2 精确命中：卷名/主线/high 伏笔进**稳定段**，位置进**逐章段**', async () => {
        freshEnv()
        seedArchitecture()
        setVolumes([
            vol(1, 1, 10, { title: '第一卷' }),
            vol(2, 11, 60, {
                title: '第二卷 · 北境风雪', premise: '本卷主线：夺回北境十三镇', status: 'writing',
                openThreads: [
                    { chapter: 3, thread: '玉佩来历未明', urgency: 'high' },
                    { chapter: 7, thread: '师门旧怨', urgency: 'low' },
                    { chapter: 9, thread: '粮道被断', urgency: 'high' },
                ],
            }),
        ])
        const { prompt, segments } = await buildDraftContext(15)
        assert(prompt.includes('第二卷 · 北境风雪'), '应注入卷名')
        assert(prompt.includes('本卷主线：夺回北境十三镇'), '应注入本卷主线')
        assert(prompt.includes('玉佩来历未明') && prompt.includes('粮道被断'), '两条 high 伏笔都要注入')
        assert(!prompt.includes('师门旧怨'),
            'low 优先级不进正文罗盘——正文一章一章写，铺满整卷伏笔会淹没本章任务、也撑大稳定前缀')
        // 第 15 章是卷二（11–60）的第 5 章，共 50 章
        assert(prompt.includes('第 5 / 50 章'), `位置应为 5/50。实际：\n${prompt.slice(0, 800)}`)

        const stable = segments.find(s => s.key === 'volume_compass')
        const pos = segments.find(s => s.key === 'volume_position')
        assertEq(stable?.zone, 'stable', '卷级内容归缓存命中区')
        assertEq(pos?.zone, 'volatile', '逐章位置归缓存失效区')
        assert(!stable!.content.includes('/ 50 章'), '位置绝不能混进稳定段——那正是破坏前缀缓存的原因')
    })

    await testCase('C2b 同卷相邻两章：稳定前缀逐字节一致，只有位置段不同', async () => {
        freshEnv()
        seedArchitecture()
        setVolumes([
            vol(1, 1, 10, { title: '第一卷' }),
            vol(2, 11, 60, { title: '第二卷', premise: '本卷主线：夺回北境', status: 'writing' }),
        ])
        const a = await buildDraftContext(15)
        const b = await buildDraftContext(16)
        const stableA = a.segments.find(s => s.key === 'volume_compass')!.content
        const stableB = b.segments.find(s => s.key === 'volume_compass')!.content
        assertEq(stableA, stableB, '同卷内罗盘稳定段必须逐字节一致，否则前缀缓存失效')
        const posA = a.segments.find(s => s.key === 'volume_position')!.content
        const posB = b.segments.find(s => s.key === 'volume_position')!.content
        assert(posA !== posB, '位置段本来就该逐章变——正因如此它不能待在稳定段里')
        assert(a.prompt.indexOf(stableA) < a.prompt.indexOf(posA),
            '罗盘稳定段应排在逐章位置之前，否则「稳定前缀」名不副实')
    })

    await testCase('C3 末卷之后：回落前一卷，给主线与伏笔但**不给**失真位置', async () => {
        freshEnv()
        seedArchitecture()
        setVolumes([
            vol(1, 1, 10, { title: '第一卷' }),
            vol(2, 11, 50, {
                title: '第二卷', premise: '本卷主线：夺回北境',
                openThreads: [{ chapter: 3, thread: '玉佩来历未明', urgency: 'high' }],
            }),
        ])
        const { prompt, segments } = await buildDraftContext(61)
        assert(prompt.includes('本卷主线：夺回北境'), '回落时主线仍是最贴近的承接上下文')
        assert(prompt.includes('玉佩来历未明'), '伏笔同样注入')
        assert(prompt.includes('尚未纳入任何卷'), '必须如实告知这是回落上下文')
        assertEq(segments.find(s => s.key === 'volume_position'), undefined,
            '越界时位置会算成「第 51 / 40 章」这种自相矛盾的值，必须整段不给')
    })

    await testCase('C3b 卷间缺口：回落**前一卷**，绝不能拿到未来卷', async () => {
        freshEnv()
        seedArchitecture()
        // 卷一 1–10、卷二 15–60，第 12 章落在缺口里
        setVolumes([
            vol(1, 1, 10, {
                title: '第一卷', premise: '卷一主线：夺回边镇',
                openThreads: [{ chapter: 3, thread: '卷一埋的伏笔', urgency: 'high' }],
            }),
            vol(2, 15, 60, {
                title: '第二卷', premise: '卷二主线：南征（本章还没写到这儿）',
                openThreads: [{ chapter: 20, thread: '卷二才埋的伏笔', urgency: 'high' }],
            }),
        ])
        const { prompt } = await buildDraftContext(12)
        assert(prompt.includes('卷一主线：夺回边镇'), '缺口应回落到它**之前**的卷一')
        assert(!prompt.includes('卷二主线：南征'),
            '取「最后一卷」会拿到未来的卷二，等于把还没写到的主线提前泄给模型')
        assert(!prompt.includes('卷二才埋的伏笔'), '未来卷的伏笔更不能提前注入')
    })

    await testCase('C3c 首卷之前无前序卷 → 整段不注入（不能编造「最近一卷」）', async () => {
        freshEnv()
        seedArchitecture()
        // 首卷从第 5 章才开始，第 2 章在它之前，没有任何前序卷可回落
        setVolumes([vol(1, 5, 60, { title: '第一卷', premise: '卷一主线' })])
        const { prompt, segments } = await buildDraftContext(2)
        assert(!prompt.includes('当前卷：'), '没有前序卷时任何注入都是编造')
        assert(!prompt.includes('卷一主线'), '不得把未来的首卷当成「最近一卷」')
        assertEq(segments.find(s => s.key === 'volume_compass'), undefined, '预览同样不显示')
    })

    await testCase('C4 分卷数据未就绪：不阻断写作，且日志不重复「分卷数据」', async () => {
        freshEnv()
        seedArchitecture()
        useVolumeStore.setState({ volumes: [], status: 'loading' })
        const logs: string[] = []
        const { buildChapterContext } = await import('../../src/services/prompts/chapter-context')
        const ctx = await buildChapterContext(
            { chapterNumber: 15, title: '第15章', userGuidance: '' } as never,
            (m: string) => logs.push(m),
        )
        // 与目录生成的 fail closed 是**有意的不同取舍**：正文生成不会写坏分卷结构
        assert(ctx.builder.build().length > 0, '未就绪不应抛错')
        assert(!ctx.builder.build().includes('当前卷：'), '未就绪时不注入罗盘')
        const joined = logs.join('\n')
        assert(joined.includes('分卷数据'), `应有未就绪提示，实为：${joined}`)
        assert(!joined.includes('分卷数据分卷数据'),
            `describeNotReady 自带「分卷数据」前缀，调用点不能再加一遍：${joined}`)
    })

    await testCase('C5 首章模板没有该占位符 → 不注入、预览不显示、日志不谎报', async () => {
        freshEnv()
        seedArchitecture()
        setVolumes([vol(1, 1, 10, { title: '第一卷', premise: '卷一主线' })])
        const logs: string[] = []
        const { buildChapterContext } = await import('../../src/services/prompts/chapter-context')
        const ctx = await buildChapterContext(
            { chapterNumber: 1, title: '第1章', userGuidance: '' } as never,
            (m: string) => logs.push(m),
        )
        assertEq(ctx.segments.find(s => s.key === 'volume_compass'), undefined,
            'first_chapter_draft 未引用 {{volume_compass}}，预览不得显示该行')
        assert(!ctx.builder.build().includes('当前卷：'), '首章 prompt 里也不该有罗盘')
        assert(!logs.join('\n').includes('已注入本卷罗盘'),
            '模板根本没引用该占位符，日志不能谎报「已注入」')
    })

    console.log('\n▶ 卷状态流转 / 按卷导出 / Agent 续目录（Task 19.3c）')

    /** 跑一次卷状态流转步骤（定稿后处理流水线里的那一步） */
    async function runVolumeStatusStep(chapterNumber: number, token = currentToken) {
        const { buildFinalizePostProcessSteps } = await import(
            '../../src/services/workflows/commands/finalize-chapter.command')
        const steps = buildFinalizePostProcessSteps(
            { path: 'x' }, chapterNumber, `第${chapterNumber}章`, '正文', token)
        const step = steps.find(st => st.key === 'volume_status')
        assert(step, '定稿流水线里应有 volume_status 步骤')
        const logs: string[] = []
        await step!.executor({ log: (m: string) => logs.push(m), setProgress: () => {}, appendText: () => {} } as never)
        return logs.join('\n')
    }

    await testCase('X1 首章定稿 → planned 流转为 writing；末章定稿 → done', async () => {
        freshEnv()
        VolumeRepository.upsert(vol(1, 1, 10, { title: '第一卷', status: 'done' }))
        VolumeRepository.upsert(vol(2, 11, 20, { title: '第二卷', status: 'planned' }))

        await runVolumeStatusStep(11)
        assertEq(VolumeRepository.get(2)!.status, 'writing', '首章定稿应流转为写作中')

        await runVolumeStatusStep(20)
        assertEq(VolumeRepository.get(2)!.status, 'done', '末章定稿应流转为已完成')
    })

    await testCase('X2 单章卷（start === end）→ 落在 done 而不是 writing', async () => {
        freshEnv()
        VolumeRepository.upsert(vol(1, 1, 10, { title: '第一卷', status: 'done' }))
        VolumeRepository.upsert(vol(2, 11, 11, { title: '单章卷', status: 'planned' }))
        await runVolumeStatusStep(11)
        // 两个条件同时成立时必须先判末章——否则这卷永远停在「写作中」
        assertEq(VolumeRepository.get(2)!.status, 'done', '单章卷定稿后应直接完成')
    })

    await testCase('X3 用户手动置回 planned 表示「搁置」→ 中间章定稿不得顶回 writing', async () => {
        freshEnv()
        VolumeRepository.upsert(vol(1, 1, 10, { title: '第一卷', status: 'done' }))
        // 用户写了几章后决定搁置本卷，手动把状态改回 planned（Spec §4.11 允许）
        VolumeRepository.upsert(vol(2, 11, 20, { title: '第二卷', status: 'planned' }))
        await runVolumeStatusStep(15)
        // 「任何章定稿都算开写」看似无害超集，实则会推翻用户的显式意图
        assertEq(VolumeRepository.get(2)!.status, 'planned',
            '中间章定稿不得覆盖用户手动设置的搁置状态')
    })

    await testCase('X4 已 done 的卷不被中间章回退，零卷整步跳过', async () => {
        freshEnv()
        VolumeRepository.upsert(vol(1, 1, 10, { title: '第一卷', status: 'done' }))
        await runVolumeStatusStep(5)
        assertEq(VolumeRepository.get(1)!.status, 'done', '已完成的卷不得被中间章拉回写作中')

        // 零卷：没有任何卷，整步跳过且不报错
        freshEnv()
        const before = snapshot()
        const logs = await runVolumeStatusStep(5)
        assertUnchanged(before, '零卷时不应有任何写入')
        assertEq(logs, '', '零卷时不该产生日志')
    })

    await testCase('X5 项目已切换 → 卷状态不写入，且**必须抛错**（不能被记成成功）', async () => {
        freshEnv()
        VolumeRepository.upsert(vol(1, 1, 10, { title: '第一卷', status: 'planned' }))
        let threw = ''
        try {
            await runVolumeStatusStep(1, currentToken - 1)   // 用上一个项目的旧 token
        } catch (e) { threw = e instanceof Error ? e.message : String(e) }
        assertEq(VolumeRepository.get(1)!.status, 'planned', '跨项目写入必须被守卫拦下')
        // 只记日志正常返回的话，流水线会把这步标成成功，既不重试、修复模式也不重跑
        assert(threw.includes('项目已切换'), `必须抛错而非静默返回，实为：${threw || '（没抛）'}`)
    })

    await testCase('X5b 边界改变后按新边界判定（非原子性的动态证明，见注释）', async () => {
        freshEnv()
        VolumeRepository.upsert(vol(1, 1, 10, { title: '第一卷', status: 'writing' }))
        // 「后处理跑了几分钟，期间用户把末卷从止于 10 延长到 20」
        VolumeRepository.upsert(vol(1, 1, 20, { title: '第一卷', status: 'writing' }))
        await runVolumeStatusStep(10)
        assertEq(VolumeRepository.get(1)!.status, 'writing',
            '第 10 章已不是末章，刚被延长的卷不该显示「已完成」')
        // ⚠️ 本用例**不构成原子性的动态证明**：它在调用事务之前就把边界改完了，
        // 证明的是「判定读的是当前值、不是陈旧副本」。真正的读写交错需要在事务内部
        // 注入并发写，本 harness 是单线程 + better-sqlite3 同步 API，构造不出来。
        // 原子性由实现保证——判定与更新同在 `advanceStatusByChapter` 的一个 transaction 内。
    })

    await testCase('X6 按卷导出：只含本卷章节，文件名带卷名，大纲用本卷的', async () => {
        freshEnv()
        seedArchitecture()
        VolumeRepository.upsert(vol(1, 1, 5, { title: '第一卷', premise: '卷一主线：夺回边镇', synopsis: '卷一大纲内容' }))
        VolumeRepository.upsert(vol(2, 6, 10, { title: '第二卷', premise: '卷二主线：南征', synopsis: '卷二大纲内容' }))
        setVolumes(VolumeRepository.getAll())

        const { exportNovel } = await import('../../src/services/export-service')
        const outDir = path.join(tmpRoot, `exp-${dbSeq}`)
        const res = await exportNovel({
            format: 'merged-md', outputDir: outDir, includeOutline: true,
            scope: 'volume', volumeNumber: 2,
        })
        assert(res.success, `导出应成功：${res.error}`)
        assert(res.path!.includes('第2卷'), `文件名应带卷名，实为：${res.path}`)

        const content = fs.readFileSync(res.path!, 'utf-8')
        assert(content.includes('第 6 章正文') && content.includes('第 10 章正文'), '应含本卷章节')
        assert(!content.includes('第 5 章正文'), '不得含其它卷的章节')
        assert(content.includes('卷二主线：南征'), '按卷导出应用本卷主线')
        assert(!content.includes(ARCH.synopsis),
            '按卷导出塞全书大纲会把后续卷剧情剧透给读者，且那描述的是整本书')
    })

    await testCase('X7 整本导出：各卷首章前插卷标题；零卷时逐字节维持原样', async () => {
        freshEnv()
        seedArchitecture()
        VolumeRepository.upsert(vol(1, 1, 5, { title: '第一卷' }))
        VolumeRepository.upsert(vol(2, 6, 10, { title: '第二卷' }))
        setVolumes(VolumeRepository.getAll())

        const { exportNovel } = await import('../../src/services/export-service')
        const withVols = await exportNovel({
            format: 'merged-md', outputDir: path.join(tmpRoot, `exp-a-${dbSeq}`),
        })
        assert(withVols.success, `导出应成功：${withVols.error}`)
        const a = fs.readFileSync(withVols.path!, 'utf-8')
        assert(a.includes('## 第1卷 · 第一卷') && a.includes('## 第2卷 · 第二卷'), '应插入两个卷标题')
        // 标题必须紧挨着卷**首章**，不能插到卷中间
        assert(a.indexOf('## 第2卷') < a.indexOf('第 6 章正文'), '卷二标题应在其首章之前')
        assert(a.indexOf('## 第2卷') > a.indexOf('第 5 章正文'), '卷二标题不应插到卷一章节之前')

        // 零卷项目：不应出现任何卷标题
        freshEnv()
        seedArchitecture()
        const noVols = await exportNovel({
            format: 'merged-md', outputDir: path.join(tmpRoot, `exp-b-${dbSeq}`),
        })
        assert(noVols.success, `零卷导出应成功：${noVols.error}`)
        const b = fs.readFileSync(noVols.path!, 'utf-8')
        assert(!b.includes('## 第1卷'), '零卷项目导出结果里不得出现卷标题（老项目零感知）')
    })

    await testCase('X8 按卷导出：卷内无定稿章 / 卷不存在 → 明确报错', async () => {
        freshEnv()
        VolumeRepository.upsert(vol(1, 1, 10, { title: '第一卷' }))
        VolumeRepository.upsert(vol(2, 50, 60, { title: '第二卷' }))  // 50–60 章没定稿
        setVolumes(VolumeRepository.getAll())
        const { exportNovel } = await import('../../src/services/export-service')

        const empty = await exportNovel({
            format: 'txt', outputDir: path.join(tmpRoot, `exp-c-${dbSeq}`),
            scope: 'volume', volumeNumber: 2,
        })
        assert(!empty.success && empty.error!.includes('没有已定稿的章节'), `实为：${empty.error}`)

        const missing = await exportNovel({
            format: 'txt', outputDir: path.join(tmpRoot, `exp-d-${dbSeq}`),
            scope: 'volume', volumeNumber: 99,
        })
        assert(!missing.success && missing.error!.includes('第 99 卷不存在'), `实为：${missing.error}`)

        const noNumber = await exportNovel({
            format: 'txt', outputDir: path.join(tmpRoot, `exp-e-${dbSeq}`), scope: 'volume',
        })
        assert(!noNumber.success && noNumber.error!.includes('必须指定卷序号'), `实为：${noNumber.error}`)
    })

    await testCase('X9 Agent 路径：无蓝图 → full；已有蓝图 → 从最大章号+1 追加', async () => {
        freshEnv()
        seedArchitecture()
        seedCharacter()
        const { startWorkflowTool } = await import('../../src/services/agent/tools/start-workflow.tool')

        // 先清空蓝图（freshEnv 默认播了 1–10 章）
        getProjectDb()!.prepare('DELETE FROM blueprints').run()
        stubLLM(['{"blueprints":[]}', '{"blueprints":[]}', '{"blueprints":[]}'])
        const r1 = await startWorkflowTool.execute({ workflow: 'generate_blueprint' } as never)
        assert(r1.success, `无蓝图时应放行 full：${r1.error}`)
        assert(useWorkflowStore.getState().globalLogs.some(l => l.message.includes('全量')),
            '无蓝图时应走全量生成')

        // 已有蓝图：故意造一个**有缺口**的分布（1,2,90），验证起始章取「最大章号+1」
        freshEnv()
        seedArchitecture()
        seedCharacter()
        getProjectDb()!.prepare('DELETE FROM blueprints').run()
        for (const c of [1, 2, 90]) {
            getProjectDb()!.prepare(`INSERT INTO blueprints (chapter_number,title,key_events) VALUES (?,?,?)`)
                .run(c, `第${c}章`, 'e')
        }
        setVolumes([vol(1, 1, 200, { title: '第一卷' })])
        stubLLM(['{"blueprints":[]}', '{"blueprints":[]}'])
        const r2 = await startWorkflowTool.execute({ workflow: 'generate_blueprint' } as never)
        assert(r2.success, `已有蓝图时应允许追加：${r2.error}`)
        const title = useWorkflowStore.getState().history[0]?.title
            ?? useWorkflowStore.getState().activeRuns[0]?.title ?? ''
        assert(title.includes('第 91 章'),
            `起始章应为「最大章号 90 + 1」而非「条数 3 + 1」。实际标题：${title}`)
    })

    await testCase('X10 Agent 路径：非法入参一律拒绝，且一次模型都不调', async () => {
        freshEnv()
        seedArchitecture()
        seedCharacter()
        const { startWorkflowTool } = await import('../../src/services/agent/tools/start-workflow.tool')
        const llm = stubLLM(['{"blueprints":[]}'])

        // inputSchema 只是给模型看的提示，执行链不按它校验 → 必须运行时验
        // 1e308 是关键一例：Number.isInteger(1e308) 为 true，但 1e308 + 1 === 1e308，
        // 目录生成的 `cursor = actualMax + 1` 会永远不前进、循环卡死并持续调用模型。
        // 只有 isSafeInteger 拦得住它
        for (const bad of [0, -1, 1.5, '2', Number.POSITIVE_INFINITY, NaN, 1e308]) {
            const r = await startWorkflowTool.execute(
                { workflow: 'generate_blueprint', blueprint_start_chapter: bad } as never)
            assert(!r.success, `blueprint_start_chapter=${String(bad)} 应被拒绝`)
            assert(r.error!.includes('安全整数'), `实为：${r.error}`)
        }
        const rc = await startWorkflowTool.execute(
            { workflow: 'generate_blueprint', blueprint_count: 0 } as never)
        assert(!rc.success && rc.error!.includes('安全整数'), `实为：${rc.error}`)
        // 两个参数各自安全、相加溢出
        const rsum = await startWorkflowTool.execute({
            workflow: 'generate_blueprint',
            blueprint_start_chapter: Number.MAX_SAFE_INTEGER, blueprint_count: 10,
        } as never)
        assert(!rsum.success && rsum.error!.includes('超出可表示范围'), `实为：${rsum.error}`)

        // ↓ 以下两例走的是**派生起点**那条路：省略 start 时起点由「已有蓝图最大章号 + 1」
        //   算出，原来的校验只看显式入参，这条路径上根本没有 start 可校验。
        //   （上一轮我声称 X10 已覆盖它们，其实没有——Codex 点出来的）

        // ① 已有蓝图到第 10 章（freshEnv 播的），只传天文数字的 count
        const rderived = await startWorkflowTool.execute({
            workflow: 'generate_blueprint', blueprint_count: Number.MAX_SAFE_INTEGER,
        } as never)
        assert(!rderived.success && rderived.error!.includes('超出可表示范围'),
            `省略 start + MAX_SAFE count 应被拒，实为：${JSON.stringify(rderived)}`)

        // ② 已有蓝图最大章号本身就是 MAX_SAFE_INTEGER → 派生起点 +1 已不是安全整数
        getProjectDb()!.prepare(
            `INSERT INTO blueprints (chapter_number, title, key_events) VALUES (?,?,?)`
        ).run(Number.MAX_SAFE_INTEGER, '边界章', 'e')
        const rderived2 = await startWorkflowTool.execute(
            { workflow: 'generate_blueprint', blueprint_count: 5 } as never)
        assert(!rderived2.success && rderived2.error!.includes('推导出的起始章号非法'),
            `派生起点自身越界应被拒，实为：${JSON.stringify(rderived2)}`)

        assertEq(llm.calls, 0, '参数非法时不该发起任何模型调用')
    })

    await testCase('X11 Agent 路径：起始章落在已有蓝图上 → 拒绝覆盖', async () => {
        freshEnv()
        seedArchitecture()
        seedCharacter()
        setVolumes([vol(1, 1, 100, { title: '第一卷' })])
        const { startWorkflowTool } = await import('../../src/services/agent/tools/start-workflow.tool')
        const llm = stubLLM(['{"blueprints":[]}'])
        // freshEnv 已有 1–10 章蓝图，指定从第 5 章开始 = 要覆盖
        const r = await startWorkflowTool.execute(
            { workflow: 'generate_blueprint', blueprint_start_chapter: 5 } as never)
        assert(!r.success, 'Agent 只能向后追加')
        assert(r.error!.includes('已有蓝图'), `实为：${r.error}`)
        assertEq(llm.calls, 0, '拒绝时不该调用模型')
    })

    await testCase('X12 蓝图写通道的 token 守卫：stale 直接拒写', async () => {
        freshEnv()
        const { saveAllBlueprints } = await import('../../src/services/workflows/directory-workflow')
        const before = snapshot()
        const res = await saveAllBlueprints(
            [{ chapterNumber: 77, title: 'CROSS-77', role: '发展', purpose: '', keyEvents: '',
               characters: [], suspenseHook: '', userGuidance: '', notes: '', notesUpdatedAt: '', targetWords: 0 }],
            currentToken - 1,   // 上一个项目的旧 token
        )
        assert(!res.success && res.stale, `应判 stale，实为：${JSON.stringify(res)}`)
        assertUnchanged(before, 'stale 时一条都不该写进来')
    })

    await testCase('X12b LLM 返回后、落库前切项目 → 该批拒写且整个生成中止', async () => {
        freshEnv()
        seedArchitecture()
        setVolumes([vol(1, 1, 100, { title: '第一卷' })])
        const before = snapshot()
        // 切换点在第 1 批**流到一半**时：此时流式预览写入正在路上、权威保存还没发。
        // 两条写入路径各自带着旧 token，必须都被拒——只拦住其中一条，
        // 另一条照样把 A 的章节灌进 B 的库
        const batch1 = JSON.stringify({
            blueprints: [11, 12].map(n => ({
                chapterNumber: n, title: `INFLIGHT-${n}`, role: '发展', purpose: 'p',
                characters: [], keyEvents: 'e', suspenseHook: 'h',
            })),
        })
        const llmState = stubLLM([batch1, batch1, batch1], {
            duringCall: (n) => {
                if (n === 1) {
                    currentToken += 1
                    useProjectStore.setState({ currentToken } as never)
                }
            },
        })
        await useWorkflowStore.getState().startWorkflow(
            createDirectoryWorkflow({ mode: 'append', startChapter: 11, count: 30 })
        )
        // 只跑一批是**正确**的：第 1 批的保存被 token 守卫拒绝后立即抛错中止，
        // 不该继续往下跑——继续只会让后续批次一次次撞同一堵墙，
        // 用户看到「一直在生成」却什么都没落库
        assertEq(llmState.calls, 1, '写入被拒后应立即中止，不再发起后续批次')
        const leaked = getProjectDb()!.prepare(
            `SELECT COUNT(*) c FROM blueprints WHERE title LIKE 'INFLIGHT-%'`).get() as { c: number }
        assertEq(leaked.c, 0, '在途批次的内容一条都不该落进切换后的项目')
        assertUnchanged(before, '切项目后不得有任何写入')
        const logs = useWorkflowStore.getState().globalLogs.map(l => l.message).join('\n')
        assert(logs.includes('项目已切换'),
            `工作流应如实失败并说明原因，实为：\n${logs.slice(-400)}`)
    })

    await testCase('X13 零卷导出是确定的，且不含任何分卷结构（非跨版本 golden 比对）', async () => {
        // 基线：零卷项目导出一次
        freshEnv()
        seedArchitecture()
        const { exportNovel } = await import('../../src/services/export-service')
        const baseRes = await exportNovel({
            format: 'merged-md', outputDir: path.join(tmpRoot, `base-${dbSeq}`), includeOutline: true,
        })
        assert(baseRes.success, `基线导出应成功：${baseRes.error}`)
        const baseline = fs.readFileSync(baseRes.path!, 'utf-8')

        // ⚠️ 这是**同一实现连跑两次互比**，证明的是「零卷路径确定、无分卷副作用」，
        // **不是**与分卷前版本的逐字节比对——那需要一份钉死的 golden 输出，
        // 而 golden 里含项目名/流派等夹具字段，维护成本高于收益。
        // 真正锁住「与分卷前一致」的是 V1（architecture 拼装逐字节比对），
        // 它比的是分卷改造前后同一段拼接逻辑的输出。
        const againRes = await exportNovel({
            format: 'merged-md', outputDir: path.join(tmpRoot, `base2-${dbSeq}`), includeOutline: true,
        })
        assert(againRes.success, `复跑应成功：${againRes.error}`)
        assertEq(fs.readFileSync(againRes.path!, 'utf-8'), baseline, '零卷导出应完全确定')

        // 关键断言：基线里既不含卷标题，也不含任何「卷」字样的结构性插入
        assert(!baseline.includes('## 第1卷'), '零卷项目不得出现卷标题')
        assert(baseline.includes(ARCH.synopsis), '零卷仍应包含全书大纲（与分卷前一致）')
    })

    await testCase('X14 导出：文件系统失败必须如实报错，不得谎报成功', async () => {
        freshEnv()
        seedArchitecture()
        const { exportNovel } = await import('../../src/services/export-service')
        // 让 fs:write-file 返回 {success:false}（真实 controller 会把权限不足/磁盘满转成它）
        const realHandler = invokeHandler
        invokeHandler = async (channel, ...args) => {
            if (channel === 'fs:write-file') return { success: false, error: '磁盘已满' }
            return realHandler(channel, ...args)
        }
        try {
            const res = await exportNovel({
                format: 'merged-md', outputDir: path.join(tmpRoot, `fail-${dbSeq}`),
            })
            assert(!res.success, '写盘失败时不得返回成功')
            assert(res.error!.includes('磁盘已满'), `应透传底层原因，实为：${res.error}`)
        } finally {
            invokeHandler = realHandler
        }
    })

    await testCase('X15 导出：卷名含冒号时正文标题保原样、文件名才净化', async () => {
        freshEnv()
        seedArchitecture()
        // 用半角冒号——它在 Windows 上是非法文件名字符；
        // 全角「：」是合法的，拿它测等于要求净化一个本不该净化的字符
        VolumeRepository.upsert(vol(1, 1, 5, { title: '第二卷: 南征' }))
        VolumeRepository.upsert(vol(2, 6, 10, { title: '第三卷' }))
        setVolumes(VolumeRepository.getAll())
        const { exportNovel } = await import('../../src/services/export-service')
        const res = await exportNovel({
            format: 'merged-md', outputDir: path.join(tmpRoot, `colon-${dbSeq}`),
            scope: 'volume', volumeNumber: 1,
        })
        assert(res.success, `导出应成功：${res.error}`)
        assert(!res.path!.includes(': '), `文件名必须净化掉半角冒号：${res.path}`)
        const content = fs.readFileSync(res.path!, 'utf-8')
        assert(content.includes('第二卷: 南征'),
            '正文标题应保留原始卷名——把技术约束（文件名净化）泄漏给读者是缺陷')
    })

    await testCase('X16 append 最终保存不得覆盖生成期间的并发编辑', async () => {
        freshEnv()
        seedArchitecture()
        setVolumes([vol(1, 1, 100, { title: '第一卷' })])
        // 工作流启动时会把 1–10 章快照进 context；生成期间用户改了第 3 章
        stubLLM(['{"blueprints":[]}'], {
            afterCall: () => {
                getProjectDb()!.prepare(
                    `UPDATE blueprints SET title = '用户生成期间改的标题' WHERE chapter_number = 3`
                ).run()
            },
        })
        await useWorkflowStore.getState().startWorkflow(
            createDirectoryWorkflow({ mode: 'append', startChapter: 11, count: 2 })
        )
        const ch3 = getProjectDb()!.prepare(
            'SELECT title FROM blueprints WHERE chapter_number = 3').get() as { title: string }
        assertEq(ch3.title, '用户生成期间改的标题',
            'append 只该写新生成的章节；把启动时的旧快照整份重写回去会覆盖用户的并发编辑')
    })

    await testCase('X17 Agent：前置检查之后切项目 → 中止，不拿 A 的结论去写 B', async () => {
        freshEnv()
        seedArchitecture()
        seedCharacter()
        setVolumes([vol(1, 1, 100, { title: '第一卷' })])
        const { startWorkflowTool } = await import('../../src/services/agent/tools/start-workflow.tool')
        const llm = stubLLM(['{"blueprints":[]}'])
        const before = snapshot()

        // 让「查蓝图」这一步之后、工作流启动之前发生项目切换
        const realHandler = invokeHandler
        invokeHandler = async (channel, ...args) => {
            const r = await realHandler(channel, ...args)
            if (channel === 'db:blueprint-get-all') {
                currentToken += 1
                useProjectStore.setState({ currentToken } as never)
            }
            return r
        }
        try {
            const res = await startWorkflowTool.execute({ workflow: 'generate_blueprint' } as never)
            assert(!res.success, '前置检查结论已失效，必须中止')
            assert(res.error!.includes('项目已切换'), `实为：${res.error}`)
            assertEq(llm.calls, 0, '不该发起任何模型调用')
            assertUnchanged(before, '不得对新项目产生任何写入')
        } finally {
            invokeHandler = realHandler
        }
    })

    await testCase('X18 导出范围跨项目不残留：切到零卷项目后回落全书', async () => {
        freshEnv()
        seedArchitecture()
        VolumeRepository.upsert(vol(1, 1, 5, { title: '第一卷' }))
        VolumeRepository.upsert(vol(2, 6, 10, { title: '第二卷' }))
        setVolumes(VolumeRepository.getAll())
        const { exportNovel } = await import('../../src/services/export-service')

        // 模拟「上个项目选了按卷/第 2 卷」的残留 state 直接提交到零卷项目：
        // 服务层必须给出明确错误而不是静默导出错内容
        freshEnv()
        seedArchitecture()
        useVolumeStore.setState({ volumes: [], status: 'ready' })
        const res = await exportNovel({
            format: 'txt', outputDir: path.join(tmpRoot, `stale-${dbSeq}`),
            scope: 'volume', volumeNumber: 2,
        })
        assert(!res.success && res.error!.includes('第 2 卷不存在'),
            `零卷项目收到残留的卷号必须明确报错，实为：${res.error}`)
    })

    await testCase('X19 split-md 第二次导出章节变少：不得混入上次的残留章节文件', async () => {
        freshEnv()
        seedArchitecture()
        VolumeRepository.upsert(vol(1, 1, 10, { title: '第一卷' }))
        setVolumes(VolumeRepository.getAll())
        const { exportNovel } = await import('../../src/services/export-service')
        const outDir = path.join(tmpRoot, `split-${dbSeq}`)

        const r1 = await exportNovel({ format: 'split-md', outputDir: outDir, scope: 'volume', volumeNumber: 1 })
        assert(r1.success, `第一次导出应成功：${r1.error}`)
        assertEq(fs.readdirSync(r1.path!).length, 10, '第一次应写出 10 章')

        // 卷号与卷名都不变，只把末章从 10 缩到 6（很常见：章节被退回草稿 / 手动调边界）。
        // 若沿用固定目录名，上次的 chapter_7..10.md 会原地留着，
        // 用户拿到的「本卷全文」混着已经不属于本次范围的四章
        VolumeRepository.upsert(vol(1, 1, 6, { title: '第一卷' }))
        setVolumes(VolumeRepository.getAll())
        const r2 = await exportNovel({ format: 'split-md', outputDir: outDir, scope: 'volume', volumeNumber: 1 })
        assert(r2.success, `第二次导出应成功：${r2.error}`)
        assert(r2.path !== r1.path, `两次范围不同必须写进不同目录，实为同一个：${r2.path}`)
        const files = fs.readdirSync(r2.path!).sort()
        assertEq(files.length, 6, `第二次目录里应只有 6 章，实为：${files.join(',')}`)
        assert(!files.includes('chapter_7.md'), '缩小后的范围里不该出现第 7 章')
    })

    await testCase('X20 append 生成期间编辑「第一批新章」，最终不得被陈旧副本覆盖', async () => {
        freshEnv()
        seedArchitecture()
        setVolumes([vol(1, 1, 100, { title: '第一卷' })])
        const mk = (ns: number[], tag: string) => JSON.stringify({
            blueprints: ns.map(n => ({
                chapterNumber: n, title: `${tag}-${n}`, role: '发展', purpose: 'p',
                characters: [], keyEvents: 'e', suspenseHook: 'h',
            })),
        })
        // 两批：11–12 与 13–14。在第 2 批流到一半时，模拟用户回头编辑了
        // **第 1 批刚生成的第 11 章**（改标题并保存）。
        // 旧实现在工作流末尾把 context 里累计的 newBlueprints 整份重写，
        // 那份副本里第 11 章还是模型给的原标题 → 用户的编辑被静默吞掉
        stubLLM([mk([11, 12], 'GEN'), mk([13, 14], 'GEN')], {
            duringCall: (n) => {
                if (n === 2) {
                    BlueprintRepository.upsertMany([{
                        chapterNumber: 11, title: 'USER-EDITED-11', role: '发展', purpose: 'p',
                        characters: [], keyEvents: 'e', suspenseHook: 'h',
                        userGuidance: '', notes: '', notesUpdatedAt: '', targetWords: 0,
                    }] as never)
                }
            },
        })
        await useWorkflowStore.getState().startWorkflow(
            createDirectoryWorkflow({ mode: 'append', startChapter: 11, count: 4 })
        )
        assertEq(BlueprintRepository.getByChapter(11)!.title, 'USER-EDITED-11',
            '生成期间对已落库新章的编辑不得被工作流末尾的陈旧副本覆盖')
        assertEq(BlueprintRepository.getByChapter(14)!.title, 'GEN-14', '后续批次仍应正常落库')
    })

    await testCase('X21 导出途中切项目：不得写出任何文件', async () => {
        freshEnv()
        seedArchitecture()
        VolumeRepository.upsert(vol(1, 1, 10, { title: '第一卷' }))
        setVolumes(VolumeRepository.getAll())
        const { exportNovel } = await import('../../src/services/export-service')
        const outDir = path.join(tmpRoot, `switch-${dbSeq}`)

        // 切换点必须落在**读完卷之后、写盘之前**——否则读卷那道复核先拦下，
        // 本用例就证明不了「落盘前那道」的存在（这正是第一版写错的地方：
        // 开跑前就切，删掉落盘前的复核它照样绿）
        const clickToken = currentToken
        const realHandler = invokeHandler
        invokeHandler = async (channel, ...args) => {
            const r = await realHandler(channel, ...args)
            // 逐章读正文是几百次 IPC、可达数十秒，是真实世界里最可能被切走的那一段
            if (channel === 'db:draft-get-full' && currentToken === clickToken) {
                currentToken += 1
                useProjectStore.setState({ currentToken } as never)
            }
            return r
        }
        try {
            const res = await exportNovel({
                format: 'split-md', outputDir: outDir, expectedToken: clickToken,
            })
            assert(!res.success && res.error!.includes('项目已切换'),
                `切项目后应明确中止，实为：${JSON.stringify(res)}`)
            assert(!fs.existsSync(outDir), `中止时一个文件都不该落盘，但目录已存在：${outDir}`)
        } finally {
            invokeHandler = realHandler
        }
    })

    await testCase('X21b merged-md 全书大纲：复核之后不得再读项目库', async () => {
        freshEnv()
        seedArchitecture()
        setVolumes([])
        const { exportNovel } = await import('../../src/services/export-service')
        const outDir = path.join(tmpRoot, `switch2-${dbSeq}`)

        // 切换点卡在 `fs:mkdir` 上——它排在「落盘前复核」之后。
        // 若全书大纲的读取留在 merged-md 分支里（复核之后），
        // 这一刀就能让 A 的目录里写进 B 的全书大纲：
        // 复核只有当它之后不再碰项目数据库时才算数
        const clickToken = currentToken
        const realHandler = invokeHandler
        let coreReadAfterSwitch = false
        invokeHandler = async (channel, ...args) => {
            if (channel === 'db:project-core-get' && currentToken !== clickToken) {
                coreReadAfterSwitch = true
            }
            const r = await realHandler(channel, ...args)
            if (channel === 'fs:mkdir' && currentToken === clickToken) {
                currentToken += 1
                useProjectStore.setState({ currentToken } as never)
            }
            return r
        }
        try {
            const res = await exportNovel({
                format: 'merged-md', outputDir: outDir,
                includeOutline: true, expectedToken: clickToken,
            })
            assert(!coreReadAfterSwitch, '最后一道复核之后不得再读项目库（全书大纲必须提前读完）')
            assert(res.success, `本例中切换发生在复核之后，导出应正常完成：${res.error}`)
            const body = fs.readFileSync(res.path!, 'utf-8')
            assert(body.includes(ARCH.synopsis), '写出的应是复核时那个项目的大纲')
        } finally {
            invokeHandler = realHandler
        }
    })

    await testCase('X22 空项目：Agent 指定起始章必须明确拒绝，不得静默生成第 1 章起', async () => {
        freshEnv()
        seedArchitecture()
        seedCharacter()
        // 清空 freshEnv 播的 1–10 章蓝图，构造「一张蓝图都没有」的新项目
        getProjectDb()!.prepare('DELETE FROM blueprints').run()
        setVolumes([])
        const { startWorkflowTool } = await import('../../src/services/agent/tools/start-workflow.tool')
        const llm = stubLLM(['{"blueprints":[]}'])

        // 空项目走 mode:'full'，而 full 的起点在命令里**写死为 1**——
        // 旧实现直接丢掉 startChapter，于是「第 50 章起 10 章」被"成功受理"、
        // 实际生成第 1–10 章：范围与所求完全不同，还白烧一次模型调用
        const r = await startWorkflowTool.execute({
            workflow: 'generate_blueprint',
            blueprint_start_chapter: 50, blueprint_count: 10,
        } as never)
        assert(!r.success, `空项目指定第 50 章起必须被拒，实为：${JSON.stringify(r)}`)
        assert(r.error!.includes('只能从第 1 章开始'), `错误应说明原因，实为：${r.error}`)
        assertEq(llm.calls, 0, '被拒时不该发起任何模型调用')
        assertEq(BlueprintRepository.getAll().length, 0, '被拒时不该写入任何蓝图')

        // 显式传 1 是合法的，不能被上面那道误伤
        const ok = await startWorkflowTool.execute({
            workflow: 'generate_blueprint',
            blueprint_start_chapter: 1, blueprint_count: 3,
        } as never)
        assert(ok.success, `空项目从第 1 章起应放行，实为：${JSON.stringify(ok)}`)
    })

    await testCase('X20b 同一批内：流式预览已落库并被用户编辑，整批保存不得盖回模型版本', async () => {
        freshEnv()
        seedArchitecture()
        setVolumes([vol(1, 1, 100, { title: '第一卷' })])
        // 一批四章，前两章会落在第一个 chunk 里（预览写入 → 编辑器立刻可见可改）
        const batch = JSON.stringify({
            blueprints: [11, 12, 13, 14].map(n => ({
                chapterNumber: n, title: `MODEL-${n}`, role: '发展', purpose: 'p',
                characters: [], keyEvents: 'e', suspenseHook: 'h',
            })),
        })
        let previewLanded = false
        stubLLM([batch], {
            // 后半段只在 onDone 给：13–14 章绝不会被流式预览写入，
            // 于是「第 14 章仍然落库」只可能来自整批补写那条路（否则断言是空转）
            withholdTail: true,
            duringCall: async () => {
                // 等预览写入那条 .then 链落定（它是异步的，不等就跑在它前面）
                for (let i = 0; i < 20 && !previewLanded; i++) {
                    await new Promise(r => setTimeout(r, 0))
                    previewLanded = !!BlueprintRepository.getByChapter(11)
                }
                // 用户在编辑器里改了刚出现的第 11 章并保存
                if (previewLanded) {
                    BlueprintRepository.upsertMany([{
                        chapterNumber: 11, title: 'USER-EDITED-11', role: '发展', purpose: 'p',
                        characters: [], keyEvents: 'e', suspenseHook: 'h',
                        userGuidance: '', notes: '', notesUpdatedAt: '', targetWords: 0,
                    }] as never)
                }
            },
        })
        await useWorkflowStore.getState().startWorkflow(
            createDirectoryWorkflow({ mode: 'append', startChapter: 11, count: 4 })
        )
        // 前置条件必须在这里断言：duringCall 跑在 stub 的 async IIFE 里，
        // 在那儿抛出只会变成 unhandled rejection，用例照样绿——
        // 那样"预览没落库"就会伪装成"覆盖没发生"，是最坏的一种假通过
        assert(previewLanded, '前置条件不成立：流式预览未把第 11 章落库，本用例测不到同批次窗口')
        assertEq(BlueprintRepository.getByChapter(11)!.title, 'USER-EDITED-11',
            '同一批内被用户编辑过的章节，整批保存不得用模型版本盖回')
        // 第 14 章在后半段里、从未作为 chunk 推送过，故它落库只能来自整批补写。
        // 这条不是锦上添花：「跳过已预览」写歪了就会变成「漏写」，而漏写比覆盖更难发现
        assertEq(BlueprintRepository.getByChapter(14)?.title, 'MODEL-14',
            '只在 onDone 出现的章节必须由整批保存补写')
    })

    await testCase('X20c 预览写入失败的章节，必须由整批保存补上（跳过≠漏写）', async () => {
        freshEnv()
        seedArchitecture()
        setVolumes([vol(1, 1, 100, { title: '第一卷' })])
        const batch = JSON.stringify({
            blueprints: [11, 12, 13, 14].map(n => ({
                chapterNumber: n, title: `MODEL-${n}`, role: '发展', purpose: 'p',
                characters: [], keyEvents: 'e', suspenseHook: 'h',
            })),
        })
        stubLLM([batch])

        // 让**第一次** upsert-many 失败（那是流式预览那次），后续放行。
        // 「只补写未成功预览的章节」这条优化，若把失败也当成功登记，
        // 这几章就永远不会被写进去——静默丢章，比覆盖更难发现
        let upsertCalls = 0
        const realHandler = invokeHandler
        invokeHandler = async (channel, ...args) => {
            if (channel === 'db:blueprint-upsert-many') {
                upsertCalls += 1
                if (upsertCalls === 1) return { success: false, error: '模拟的预览写入失败' }
            }
            return realHandler(channel, ...args)
        }
        try {
            await useWorkflowStore.getState().startWorkflow(
                createDirectoryWorkflow({ mode: 'append', startChapter: 11, count: 4 })
            )
            assert(upsertCalls >= 2, `前置条件不成立：预期至少两次写入（预览 + 整批），实为 ${upsertCalls}`)
            for (const n of [11, 12, 13, 14]) {
                assertEq(BlueprintRepository.getByChapter(n)?.title, `MODEL-${n}`,
                    `第 ${n} 章必须落库——预览失败不该让它被跳过`)
            }
        } finally {
            invokeHandler = realHandler
        }
    })

    await testCase('X20d 推理段（<think>）里的临时蓝图不得被预览写入并顶掉正式答案', async () => {
        freshEnv()
        seedArchitecture()
        setVolumes([vol(1, 1, 100, { title: '第一卷' })])
        const bp = (n: number, tag: string) => ({
            chapterNumber: n, title: `${tag}-${n}`, role: '发展', purpose: 'p',
            characters: [], keyEvents: 'e', suspenseHook: 'h',
        })
        // DeepSeek / Claude 的推理里出现「先草拟一版第 11 章」是常态。
        // 流式预览若扫的是**未剥离**的原文，会把 THINK-11 先落库并登记为"已预览"，
        // 正式答案里的 MODEL-11 随后被「已预览就跳过」滤掉 —— 库里永久留着推理版
        const text =
            `<think>我先草拟一下：${JSON.stringify([bp(11, 'THINK')])}，感觉不好，重来。</think>` +
            JSON.stringify({ blueprints: [11, 12].map(n => bp(n, 'MODEL')) })
        stubLLM([text])
        await useWorkflowStore.getState().startWorkflow(
            createDirectoryWorkflow({ mode: 'append', startChapter: 11, count: 2 })
        )
        assertEq(BlueprintRepository.getByChapter(11)?.title, 'MODEL-11',
            '落库的必须是正式答案，不能是推理段里的临时版本')
        assertEq(BlueprintRepository.getByChapter(12)?.title, 'MODEL-12', '第 12 章应正常落库')
    })

    await testCase('X23 定稿工作流的 token 在**构造时**捕获，不是执行时现取', async () => {
        freshEnv()
        const { createFinalizeWorkflow } = await import('../../src/services/workflows/chapter-workflow')
        const mod = await import('../../src/services/workflows/commands/finalize-chapter.command')

        // 拦下 execute，只记录「最终到达 Command 的是哪个 token」。
        // X5 直接把旧 token 注入步骤，只证明守卫本身有效，
        // 证明不了**传下来的确实是旧 token** —— 这条补的正是那一环
        const seen: Array<number | undefined> = []
        const realExec = mod.FinalizeChapterCommand.prototype.execute
        mod.FinalizeChapterCommand.prototype.execute = async function (this: {
            params: { capturedToken?: number }
        }) { seen.push(this.params.capturedToken) }

        const params = {
            chapterNumber: 3, chapterTitle: '第三章',
            draftPath: 'x.md', draftContent: '正文',
        }
        try {
            // ① 不传 override：构造时就该把当时的 token 钉住
            const atConstruction = currentToken
            const def = createFinalizeWorkflow(params)
            // 工作流是排队执行的，未必立刻跑；这期间用户切走了
            currentToken += 1
            useProjectStore.setState({ currentToken } as never)
            await def.steps[0].executor(
                {} as never, { data: {} } as never,
                { log: () => {}, setProgress: () => {}, appendText: () => {} } as never)
            assertEq(seen[0], atConstruction,
                '构造时钉住的 token 必须原样传到 Command；执行时现取会拿到切换后项目的合法 token')

            // ② 传 override（UI / Agent 在点击入口捕获的那个）：必须优先于构造时的现取
            const clickToken = currentToken - 5
            const def2 = createFinalizeWorkflow(params, clickToken)
            await def2.steps[0].executor(
                {} as never, { data: {} } as never,
                { log: () => {}, setProgress: () => {}, appendText: () => {} } as never)
            assertEq(seen[1], clickToken, '显式传入的入口 token 必须优先于构造时现取')
        } finally {
            mod.FinalizeChapterCommand.prototype.execute = realExec
        }
    })

    await testCase('X23b 修复后处理工作流：同样必须用入口 token，不得构造时现取', async () => {
        freshEnv()
        seedArchitecture()
        VolumeRepository.upsert(vol(1, 1, 10, { title: '第一卷', status: 'planned' }))
        const { createRepairFinalizeWorkflow } = await import('../../src/services/workflows/chapter-workflow')

        // 修复路径与普通定稿是两条独立的构造函数，各修各的——
        // round-09 之前只修了普通定稿那条，修复这条照旧在 guard/import 之后才现取。
        // 这里用「卷状态是否被改动」当探针：入口 token 已过期，那一步必须拒写
        const clickToken = currentToken - 1   // 用户点「修复」时还在上一个项目
        const def = createRepairFinalizeWorkflow(3, clickToken)
        try {
            await def.steps[0].executor(
                {} as never, { data: {} } as never,
                { log: () => {}, setProgress: () => {}, appendText: () => {} } as never)
        } catch { /* 管线把步骤失败记账、不外抛；证据取自记账表（见下） */ }
        assertEq(VolumeRepository.get(1)!.status, 'planned',
            '入口 token 已过期时，修复流水线不得改动卷状态')
        // 必须验失败原因**来自 token 守卫**：只断言"状态没变"是不够的——
        // 任何一步提前炸掉都会让状态没变，用例就成了空转
        const failed = getProjectDb()!.prepare(
            `SELECT step_key, ok, error_msg FROM post_process_steps
             WHERE step_key='volume_status'`
        ).get() as { error_msg?: string } | undefined
        assert(!!failed, '卷状态那步必须出现在记账表里（而不是根本没执行到）')
        assertEq((failed as { ok?: number }).ok, 0, '卷状态那步必须被记为失败')
        assert((failed!.error_msg ?? '').includes('项目已切换'),
            `失败原因必须是项目已切换，实为：${failed!.error_msg}`)
    })

    /**
     * 最小可提交的续卷载荷：已有第一卷（1–10 章），续第二卷（11–20 章）。
     * 只用来触发「主进程事务里改 project_core」这一副作用，
     * 卷内容本身不是本组用例的被测对象。
     */
    function makeCommitPayload() {
        VolumeRepository.upsert(vol(1, 1, 10, { title: '第一卷', status: 'done' }))
        return {
            closingReport: { volumeNumber: 1, closingState: '主角拿下北境', openThreads: [] },
            newVolume: vol(2, 11, 20, { title: '第二卷', status: 'planned', synopsis: '卷二大纲' }),
            newVolumeSection: '## 第二卷 · 南征\n\n卷二大纲',
        }
    }

    await testCase('P1 旧 project:save 晚于续卷到达 → 必须被拒绝，不得覆盖新大纲', async () => {
        freshEnv()
        seedArchitecture()
        const store = useProjectStore.getState()
        // 用户打开小说配置编辑器时读到的版本（此刻库里还没续卷）
        const staleRevision = ProjectCoreRepository.getRevision()!
        const staleOutline = ProjectCoreRepository.get()!.synopsis

        // 续卷在主进程事务里改了 synopsis 与 total_chapters，revision +1
        const commitRes = commitNextVolume(makeCommitPayload())
        assert(commitRes.success, `续卷应成功：${commitRes.error}`)
        const afterCommit = ProjectCoreRepository.get()!
        assert(afterCommit.synopsis !== staleOutline, '前置条件：续卷应当改动了 synopsis')
        assert(afterCommit.revision > staleRevision, '前置条件：续卷应当让 revision 自增')

        // 编辑器里那份「读于续卷之前」的大纲，现在带着旧 revision 提交保存
        useProjectStore.setState({ coreRevision: staleRevision } as never)
        const ok = await store.saveProject({ novelConfig: { coreOutline: staleOutline } }, currentToken)

        assertEq(ok.kind, 'conflict',
            `过期 revision 应判 conflict（而非 error/project-switched），实为：${JSON.stringify(ok)}`)
        assertEq(ProjectCoreRepository.get()!.synopsis, afterCommit.synopsis,
            '续卷写入的大纲不得被旧快照覆盖回去')
        assertEq(useProjectStore.getState().coreRevision, afterCommit.revision,
            '冲突后应重载并对齐到库里的真实版本号，否则用户再点一次保存还是失败')
    })

    await testCase('P2 版本相符时保存正常写入，并把新 revision 交回渲染层', async () => {
        freshEnv()
        seedArchitecture()
        const store = useProjectStore.getState()
        const rev0 = ProjectCoreRepository.getRevision()!
        useProjectStore.setState({ coreRevision: rev0 } as never)

        const ok = await store.saveProject({ novelConfig: { goldenFinger: '系统流金手指' } }, currentToken)
        assertEq(ok.kind, 'success', `版本相符时应成功，实为：${JSON.stringify(ok)}`)
        assertEq(ProjectCoreRepository.get()!.goldenFinger, '系统流金手指', '值应真的落库')
        const rev1 = ProjectCoreRepository.getRevision()!
        assert(rev1 > rev0, 'revision 必须自增')
        assertEq(useProjectStore.getState().coreRevision, rev1,
            '新版本号必须回到 store —— 不回带的话连存两次，第二次必然误判冲突')

        // 连存两次：这是「回带 revision」这条最容易被漏掉的证据
        const ok2 = await useProjectStore.getState().saveProject({ novelConfig: { goldenFinger: '改一次' } }, currentToken)
        assertEq(ok2.kind, 'success', `连续第二次保存不该被判成冲突，实为：${JSON.stringify(ok2)}`)
        assertEq(ProjectCoreRepository.get()!.goldenFinger, '改一次', '第二次的值也应落库')
    })

    await testCase('P3 保存只写补丁里的字段，不碰其它列', async () => {
        freshEnv()
        seedArchitecture()
        const before = ProjectCoreRepository.get()!
        useProjectStore.setState({ coreRevision: before.revision } as never)

        // 故意让 store 内存里的 coreOutline 是**过期**的（模拟别处刚改过库），
        // 然后只保存 writingStyle。旧实现发整份快照会把过期的大纲一起写回去
        getProjectDb()!.prepare(`UPDATE project_core SET synopsis='库里的新大纲' WHERE id='main'`).run()
        useProjectStore.setState({
            currentProject: {
                ...useProjectStore.getState().currentProject!,
                novelConfig: {
                    ...useProjectStore.getState().currentProject!.novelConfig,
                    coreOutline: '内存里的旧大纲',
                },
            },
        } as never)

        const ok = await useProjectStore.getState().saveProject({ novelConfig: { writingStyle: '冷硬派' } }, currentToken)
        assertEq(ok.kind, 'success', `应成功（直接改库那步没走 revision，CAS 仍相符），实为：${JSON.stringify(ok)}`)
        assertEq(ProjectCoreRepository.get()!.writingStyle, '冷硬派', '补丁字段应写入')
        assertEq(ProjectCoreRepository.get()!.synopsis, '库里的新大纲',
            '不在补丁里的字段一列都不能碰——发整份快照就会把它覆盖成「内存里的旧大纲」')
    })

    await testCase('P4 点击后切项目 → 渲染层就拦下，请求不发出', async () => {
        freshEnv()
        seedArchitecture()
        const before = ProjectCoreRepository.get()!
        useProjectStore.setState({ coreRevision: before.revision } as never)
        // 用户点「保存」那一刻的 token
        const clickToken = currentToken
        // 随后切项目：主进程与渲染层的 token 都推进（真实 project:open 会同时更新两侧）
        currentToken += 1
        useProjectStore.setState({ currentToken } as never)

        ipcLog.length = 0
        const ok = await useProjectStore.getState().saveProject(
            { novelConfig: { goldenFinger: '不该写进来' } }, clickToken)
        // ⚠️ 本例只手工推进 token，**没有**走真实的 closeProject 生命周期。
        // 所以这里只断言「判定结果是 project-switched（而不是 conflict——什么都没重载）」，
        // 不对脏集合的去向下结论：那由 P15 用真实 closeProject 覆盖，结论是「已被清空」
        assertEq(ok.kind, 'project-switched',
            `必须判 project-switched 而非 conflict（什么都没重载），实为：${JSON.stringify(ok)}`)
        assert(!ipcLog.some(l => l.channel === 'project:save'),
            '渲染层自查就该拦下，不必白跑一趟必然被拒的 IPC')
        assertEq(ProjectCoreRepository.get()!.goldenFinger, before.goldenFinger, '一列都不该写')
    })

    await testCase('P4b 渲染层尚未察觉切换时，主进程那道守卫必须独立拦住', async () => {
        freshEnv()
        seedArchitecture()
        const before = ProjectCoreRepository.get()!
        const clickToken = currentToken
        useProjectStore.setState({ coreRevision: before.revision } as never)

        // 只推进**主进程**的 token，渲染层 store 仍停在旧值——
        // 对应「主进程已切库、渲染层的状态更新还没跑到」那一瞬。
        // 此时渲染层自查看不出问题，请求会真的发出去，
        // 全靠主进程那道守卫兜底。少了它，A 的配置就写进 B 了
        currentToken += 1

        ipcLog.length = 0
        const ok = await useProjectStore.getState().saveProject(
            { novelConfig: { goldenFinger: '不该写进来' } }, clickToken)
        assert(ipcLog.some(l => l.channel === 'project:save'),
            '前置条件：本例中请求应当真的发出去，否则测不到主进程那道')
        // 主进程用 stale 表达「跨项目」，而渲染层那道 token 复核先一步返回 project-switched；
        // 本例中渲染层看不出问题，走到的是回包后的复核 → 同样是 project-switched
        assertEq(ok.kind, 'project-switched', `主进程守卫必须拒绝，实为：${JSON.stringify(ok)}`)
        assertEq(ProjectCoreRepository.get()!.goldenFinger, before.goldenFinger, '一列都不该写')
    })

    await testCase('P4c 漏传 expectedRevision 时主进程拒绝，不得退化成"无 CAS"', async () => {
        freshEnv()
        seedArchitecture()
        const before = ProjectCoreRepository.get()!
        // 直接打 IPC，绕过 store 的封装——模拟将来某个新调用点漏传版本号。
        // 仓储把 undefined 解读为「不做 CAS」（那是留给主进程内部初始化的口子），
        // 若 handler 不挡，这条路径就等于把守卫静默关掉
        const res = await invokeHandler(
            'project:save', 'main',
            { novelConfig: { goldenFinger: '不该写进来' } },
            undefined, currentToken) as { success: boolean }
        assert(!res.success, `漏传版本号必须被拒，实为：${JSON.stringify(res)}`)
        assertEq(ProjectCoreRepository.get()!.goldenFinger, before.goldenFinger, '一列都不该写')
    })

    await testCase('P4d 空补丁 + 过期版本号：不得被当成"保存成功"', async () => {
        freshEnv()
        seedArchitecture()
        const staleRevision = ProjectCoreRepository.getRevision()!
        // 让库前进一格
        ProjectCoreRepository.update({ goldenFinger: '别处改的' })
        const cur = ProjectCoreRepository.getRevision()!
        assert(cur > staleRevision, '前置条件：版本号应已前进')

        // 空补丁走的是仓储里的早返回分支。早先那条无条件返回 ok:true，
        // 于是调用方会把过期的 revision 当成"已对齐"继续用——
        // 一次静默的成功比一次明确的失败危险得多
        const res = ProjectCoreRepository.update({}, staleRevision)
        assert(!res.ok, `空补丁 + 过期版本号必须判 stale，实为：${JSON.stringify(res)}`)
        assertEq(res.revision, cur, 'stale 时应回真实当前版本，供调用方直接对齐')
    })

    await testCase('P5 coreRevision 未知时，保存请求根本不发出（fail-closed）', async () => {
        freshEnv()
        seedArchitecture()
        const before = ProjectCoreRepository.get()!
        // 项目刚切换、状态还没对齐的那一刻正是这种情形——最该拦的时候
        useProjectStore.setState({ coreRevision: null } as never)
        ipcLog.length = 0
        const ok = await useProjectStore.getState().saveProject({ novelConfig: { goldenFinger: '不该写进来' } }, currentToken)
        assertEq(ok.kind, 'error',
            `版本未知应判 error（什么都没重载，脏标记必须留着），实为：${JSON.stringify(ok)}`)
        // ⚠️ 只断言「没写进去」是不够的：去掉守卫后 expectedRevision 会是 null，
        // SQL 的 `revision = NULL` 恒不匹配，CAS 照样拒绝——用例会因为一个
        // 与守卫无关的原因而通过。真正的证据是**请求压根没发出去**
        assert(!ipcLog.some(l => l.channel === 'project:save'),
            '版本未知时不该发出 project:save，应在渲染层就拦掉')
        assertEq(ProjectCoreRepository.get()!.goldenFinger, before.goldenFinger, '一列都不该写')
    })

    await testCase('P6 老库（无 revision 列）打开时自动补列，且保存守卫立即生效', async () => {
        freshEnv()
        seedArchitecture()
        const dir = path.join(tmpRoot, `p-${dbSeq}`)

        // 构造「分卷之前建的库」：把 revision 列摘掉。
        // 所有存量项目升级时走的都是这条路，不测等于把最大的一批用户放在没验过的路径上
        getProjectDb()!.exec(`ALTER TABLE project_core DROP COLUMN revision`)
        const colsBefore = (getProjectDb()!.pragma('table_info(project_core)') as Array<{ name: string }>)
        assert(!colsBefore.some(c => c.name === 'revision'), '前置条件：此刻应当没有 revision 列')
        closeProjectDatabase()

        // 重新打开 = 真实的「用户打开老项目」路径
        initProjectDatabase(dir)
        const colsAfter = (getProjectDb()!.pragma('table_info(project_core)') as Array<{ name: string }>)
        assert(colsAfter.some(c => c.name === 'revision'), '打开老库时必须自动补上 revision 列')
        assertEq(ProjectCoreRepository.getRevision(), 0, '补列后应为 0（默认值）')

        // 补完列，CAS 必须马上能用——只补列不生效等于迁移做了一半
        useProjectStore.setState({ coreRevision: 0 } as never)
        const ok = await useProjectStore.getState().saveProject({ novelConfig: { goldenFinger: '老库也能存' } }, currentToken)
        assertEq(ok.kind, 'success', `补列后的第一次保存应成功，实为：${JSON.stringify(ok)}`)
        assertEq(ProjectCoreRepository.get()!.goldenFinger, '老库也能存', '值应真的落库')
        assertEq(ProjectCoreRepository.getRevision(), 1, '写入后版本号应自增')

        // 再用「补列前那个 0」提交一次，必须被拒
        useProjectStore.setState({ coreRevision: 0 } as never)
        const ok2 = await useProjectStore.getState().saveProject({ novelConfig: { goldenFinger: '不该写进来' } }, currentToken)
        assertEq(ok2.kind, 'conflict', `过期版本号在老库上同样必须被拒，实为：${JSON.stringify(ok2)}`)
        assertEq(ProjectCoreRepository.get()!.goldenFinger, '老库也能存', '不得被旧快照覆盖')
    })

    await testCase('P7 updateProjectCore：渲染层自查拦下过期 token，请求不发出', async () => {
        freshEnv()
        seedArchitecture()
        const { updateProjectCore } = await import('../../src/services/vela-protocol')
        const before = ProjectCoreRepository.get()!

        const staleToken = currentToken - 1   // 用户点「保存架构」时还在上一个项目
        ipcLog.length = 0
        const ok = await updateProjectCore({ premise: '不该写进来' }, staleToken)

        assertEq(ok, false,
            '必须返回 false —— 返回 true 会让 ArchFileViewer 把另一个项目的 tab 标成已保存、' +
            '让架构工作流发「已生成」事件')
        // ⚠️ 只断言「没写进去」测不出是哪道守卫在起作用：渲染层自查和主进程守卫
        // 两道重叠，去掉任一道结果都还是 false。要咬住这一道，得看请求有没有发出去
        assert(!ipcLog.some(l => l.channel === 'db:project-core-update'),
            '渲染层自查就该拦下，不必白跑一趟必然被拒的 IPC')
        assertEq(ProjectCoreRepository.get()!.premise, before.premise, '一列都不该写')
        assertEq(ProjectCoreRepository.getRevision(), before.revision, 'revision 也不该动')
    })

    await testCase('P7c 渲染层尚未察觉切换时，主进程 core-update 守卫必须独立拦住', async () => {
        freshEnv()
        seedArchitecture()
        const { updateProjectCore } = await import('../../src/services/vela-protocol')
        const before = ProjectCoreRepository.get()!
        const actionToken = currentToken

        // 只推进**主进程**的 token，渲染层 store 仍停在旧值：
        // 渲染层自查看不出问题，请求会真的发出去，全靠主进程那道兜底
        currentToken += 1
        ipcLog.length = 0
        const ok = await updateProjectCore({ premise: '不该写进来' }, actionToken)

        assert(ipcLog.some(l => l.channel === 'db:project-core-update'),
            '前置条件：本例中请求应当真的发出去，否则测不到主进程那道')
        assertEq(ok, false, '主进程守卫必须拒绝')
        assertEq(ProjectCoreRepository.get()!.premise, before.premise, '一列都不该写')
    })

    await testCase('P7b updateProjectCore：回包晚于项目切换 → 不污染新项目的 store', async () => {
        freshEnv()
        seedArchitecture()
        const { updateProjectCore } = await import('../../src/services/vela-protocol')
        const actionToken = currentToken
        useProjectStore.setState({ coreRevision: ProjectCoreRepository.getRevision() } as never)
        const revisionBefore = useProjectStore.getState().coreRevision

        // 主进程写入成功（token 相符），但回包到达之前渲染层已经切走
        const realHandler = invokeHandler
        invokeHandler = async (channel, ...args) => {
            const r = await realHandler(channel, ...args)
            if (channel === 'db:project-core-update') {
                // 写入已完成，此刻用户切了项目
                useProjectStore.setState({ currentToken: (currentToken + 100) } as never)
            }
            return r
        }
        try {
            const ok = await updateProjectCore({ premise: '写给旧项目的' }, actionToken)
            assertEq(ok, false, '回包晚于切换时必须返回 false —— 那次写入属于上一个项目')
            assertEq(useProjectStore.getState().coreRevision, revisionBefore,
                '不得把旧项目的 revision 写进切换后的 store')
        } finally {
            invokeHandler = realHandler
            useProjectStore.setState({ currentToken } as never)
        }
    })

    await testCase('P8 保存成功只清「本次提交的字段」，不误清等待期间的新编辑', async () => {
        freshEnv()
        seedArchitecture()
        const store = useProjectStore.getState()
        useProjectStore.setState({ coreRevision: ProjectCoreRepository.getRevision() } as never)

        // 用户改了两个字段
        store.updateNovelConfig({ goldenFinger: '金手指 v1' })
        store.updateNovelConfig({ globalGuidance: '指导 v1' })
        assertEq(selectPendingConfigFields(useProjectStore.getState()).size, 2, '前置条件：应有两个脏字段')

        // 只提交其中一个，且在 IPC 等待期间用户又改了第三个字段
        const realHandler = invokeHandler
        invokeHandler = async (channel, ...args) => {
            if (channel === 'project:save') {
                useProjectStore.getState().updateNovelConfig({ referenceWorks: '等待期间改的' })
            }
            return realHandler(channel, ...args)
        }
        try {
            const res = await useProjectStore.getState().saveProject(
                { novelConfig: { goldenFinger: '金手指 v1' } }, currentToken)
            assertEq(res.kind, 'success', `应成功，实为：${JSON.stringify(res)}`)
        } finally {
            invokeHandler = realHandler
        }

        const left = selectPendingConfigFields(useProjectStore.getState())
        assert(!left.has('goldenFinger'), '本次提交的字段应被清掉')
        assert(left.has('globalGuidance'), '没提交的字段必须留着，否则它永远不会被保存')
        assert(left.has('referenceWorks'),
            '等待期间新改的字段必须留着 —— 整体清空会让它悄无声息地丢失')
    })

    await testCase('P9 脏字段由 store 统一登记：AI 路径改内存也算数', async () => {
        freshEnv()
        seedArchitecture()
        useProjectStore.setState({ coreRevision: ProjectCoreRepository.getRevision() } as never)
        assertEq(selectPendingConfigFields(useProjectStore.getState()).size, 0, '前置条件：初始应无脏字段')

        // 模拟 AI / Agent 直接改内存（不经编辑器）
        useProjectStore.getState().updateNovelConfig({ writingStyle: 'AI 分析出来的文风' })
        assert(selectPendingConfigFields(useProjectStore.getState()).has('writingStyle'),
            '非编辑器路径的改动同样要登记 —— 挂在组件 ref 上时这些改动完全不可见，' +
            '用户点保存会看到「没有改动」而那份内容其实还没落库')

        // 「值来自数据库」的同步不该登记为脏
        useProjectStore.getState().updateNovelConfig({ coreOutline: '库里读来的' }, { persisted: true })
        assert(!selectPendingConfigFields(useProjectStore.getState()).has('coreOutline'),
            '来自库的值不是未保存改动，登记成脏会让下次保存把它再发一遍')
    })

    await testCase('P10 切项目时脏字段清空：不得把 A 的字段名带进 B', async () => {
        freshEnv()
        seedArchitecture()
        useProjectStore.getState().updateNovelConfig({ goldenFinger: 'A 的金手指' })
        assert(selectPendingConfigFields(useProjectStore.getState()).size > 0, '前置条件：应有脏字段')

        // freshEnv 会重建项目与 store（等价于打开另一个项目）
        freshEnv()
        assertEq(selectPendingConfigFields(useProjectStore.getState()).size, 0,
            '切项目后脏字段必须清空 —— 带过去会把 A 的字段名当成 B 的未保存改动发出去')
    })

    await testCase('P11 重载失败时不得报 conflict（conflict 的语义是「已重载」）', async () => {
        freshEnv()
        seedArchitecture()
        const staleRevision = ProjectCoreRepository.getRevision()!
        commitNextVolume(makeCommitPayload())   // 让库前进一格，制造版本冲突
        useProjectStore.setState({ coreRevision: staleRevision } as never)

        // 让重载那次读取失败
        const realHandler = invokeHandler
        invokeHandler = async (channel, ...args) => {
            if (channel === 'db:project-core-get') return null as never
            return realHandler(channel, ...args)
        }
        try {
            const res = await useProjectStore.getState().saveProject(
                { novelConfig: { goldenFinger: 'x' } }, currentToken)
            // conflict 的语义是「已重载、你的改动已作废」，调用方据此清脏标记。
            // 重载没成功还回 conflict，用户的改动会被清掉而内存根本没换成新值
            assertEq(res.kind, 'error',
                `重载失败时必须回 error 而不是 conflict，实为：${JSON.stringify(res)}`)
        } finally {
            invokeHandler = realHandler
        }
    })

    await testCase('P12 同一字段在保存途中被改成新值 → 不得从脏集合里清掉', async () => {
        freshEnv()
        seedArchitecture()
        useProjectStore.setState({ coreRevision: ProjectCoreRepository.getRevision() } as never)
        useProjectStore.getState().updateNovelConfig({ goldenFinger: 'v1' })

        // IPC 在途期间，用户把**同一个字段**改成 v2
        const realHandler = invokeHandler
        invokeHandler = async (channel, ...args) => {
            if (channel === 'project:save') {
                useProjectStore.getState().updateNovelConfig({ goldenFinger: 'v2' })
            }
            return realHandler(channel, ...args)
        }
        try {
            const res = await useProjectStore.getState().saveProject(
                { novelConfig: { goldenFinger: 'v1' } }, currentToken)
            assertEq(res.kind, 'success', `提交 v1 应成功：${JSON.stringify(res)}`)
        } finally {
            invokeHandler = realHandler
        }

        assertEq(ProjectCoreRepository.get()!.goldenFinger, 'v1', '库里应是提交的 v1')
        assertEq(useProjectStore.getState().currentProject!.novelConfig.goldenFinger, 'v2', '内存里是 v2')
        // 只按字段名清理的话，v2 会被判成「已保存」——库里却是 v1，
        // 而界面显示「没有改动」，用户的 v2 永远回不去库里
        assert(selectPendingConfigFields(useProjectStore.getState()).has('goldenFinger'),
            '值已变成 v2，该字段必须继续留在脏集合里')
    })

    await testCase('P13 updateProjectCore 在途期间用户编辑同字段 → 不得用库值盖回', async () => {
        freshEnv()
        seedArchitecture()
        const { updateProjectCore } = await import('../../src/services/vela-protocol')
        useProjectStore.setState({ coreRevision: ProjectCoreRepository.getRevision() } as never)

        const realHandler = invokeHandler
        invokeHandler = async (channel, ...args) => {
            const r = await realHandler(channel, ...args)
            if (channel === 'db:project-core-update') {
                // 写库已成功，此刻用户在编辑器里改了同一个字段
                useProjectStore.getState().updateNovelConfig({ coreOutline: '用户正在敲的新大纲' })
            }
            return r
        }
        try {
            const ok = await updateProjectCore({ synopsis: 'AI 写的大纲' }, currentToken)
            assertEq(ok, true, '库写入本身应成功')
        } finally {
            invokeHandler = realHandler
        }

        assertEq(ProjectCoreRepository.get()!.synopsis, 'AI 写的大纲', '库里是 AI 那份')
        assertEq(useProjectStore.getState().currentProject!.novelConfig.coreOutline, '用户正在敲的新大纲',
            'token 只能识别跨项目；同项目内在途编辑必须靠值比对保住，' +
            '无条件同步会把用户正在敲的内容原地抹掉')
        assert(selectPendingConfigFields(useProjectStore.getState()).has('coreOutline'),
            '用户那份还没落库，必须留在脏集合里')
    })

    await testCase('P14 多字段别名同步**途中**切项目 → 剩余字段不同步且返回 false', async () => {
        freshEnv()
        seedArchitecture()
        const { updateProjectCore } = await import('../../src/services/vela-protocol')
        const actionToken = currentToken
        const before = useProjectStore.getState().currentProject!.novelConfig

        // 切换点必须落在**同步循环内部**：落在回包之前的话，
        // `updateProjectCore` 回包后那道复核会先返回 false，
        // 循环里这道就永远测不到（第一版正是这么写的，变异不转红）
        let flipped = false
        const unsub = useProjectStore.subscribe((st) => {
            // 第一个别名刚写进内存 → 立刻切走
            if (!flipped && st.currentProject?.novelConfig.worldSetting === '新世界观') {
                flipped = true
                useProjectStore.setState({ currentToken: currentToken + 50 } as never)
            }
        })
        try {
            const ok = await updateProjectCore(
                { worldbuilding: '新世界观', synopsis: '新大纲' }, actionToken)
            assert(flipped, '前置条件：第一个别名应当已同步并触发切换')
            // 静默跳过剩余字段却返回 true，会让调用方发「已生成」事件、把 tab 标成已保存
            assertEq(ok, false, '同步途中切项目必须返回 false')
            assert(useProjectStore.getState().currentProject!.novelConfig.coreOutline === before.coreOutline,
                '切换之后的字段不该再被同步进来')
        } finally {
            unsub()
            useProjectStore.setState({ currentToken } as never)
        }
    })

    await testCase('P15 closeProject 清空脏集合：这是「切项目后改动已丢失」文案的依据', async () => {
        freshEnv()
        seedArchitecture()
        useProjectStore.getState().updateNovelConfig({ goldenFinger: '未保存的改动' })
        assert(selectPendingConfigFields(useProjectStore.getState()).has('goldenFinger'),
            '前置条件：应有未保存的脏字段')

        // 真实切项目一律先 close 再 open。这里直接调 closeProject，
        // 覆盖 P4/P4b 没碰的那段生命周期（它们只改 token、没走 close）
        const realHandler = invokeHandler
        invokeHandler = async (channel, ...args) => {
            // close 会调这两条；harness 不需要它们的真实副作用
            if (channel === 'project:set-current' || channel === 'db:close') return { success: true } as never
            return realHandler(channel, ...args)
        }
        try {
            await useProjectStore.getState().closeProject()
        } finally {
            invokeHandler = realHandler
        }

        assertEq(useProjectStore.getState().currentProject, null, '项目应已关闭')
        assertEq(selectPendingConfigFields(useProjectStore.getState()).size, 0,
            '脏集合必须随项目一起清空——留着会在下一个项目里被当成它的未保存改动发出去')
        // 这条断言的意义不止于「清干净了」：它同时钉住了
        // `saveProject` 返回 project-switched 时的文案边界——
        // 那份改动此刻确实已经不在内存里，所以不能对用户说「改动仍保留在编辑器里」
    })

    // ===== 续卷流程发起（Task 19.4 卷 UI）=====
    // 这段分支判定决定「要不要弹孤儿处置对话框」「首卷边界取哪个值」，
    // 是 UI 层唯一可测的纯逻辑；对话框本身在 React 层，本 harness 不覆盖

    /**
     * 一份最小可提交的续卷工作流产物。`capturedToken` 取当前 token——
     * 提交时主进程要拿它核对，不对就整单拒绝
     */
    function makeWorkflowResult() {
        return {
            prevVolume: VolumeRepository.get(1)!,
            firstVolume: undefined,
            closingReport: { volumeNumber: 1, closingState: 'AI 原始收束', openThreads: [] },
            draftVolume: { title: 'AI 拟的名', premise: '', synopsis: '', suggestedChapterCount: 10 },
            capturedToken: currentToken,
            deferredLLMLogs: [],
        } as never
    }

    await testCase('F1 已有卷 → 直接进向导，承接末卷边界', async () => {
        freshEnv()
        seedArchitecture()
        VolumeRepository.upsert(vol(1, 1, 10, { title: '第一卷', status: 'done' }))
        VolumeRepository.upsert(vol(2, 11, 30, { title: '第二卷', status: 'writing' }))
        const { startNextVolumeFlow } = await import('../../src/services/volume-flow')

        const res = await startNextVolumeFlow()
        assert(res.ok && res.stage === 'wizard', `应直接进向导，实为：${JSON.stringify(res)}`)
        const f = useVolumeFlowStore.getState()
        assertEq(f.prevTitle, '第二卷', '承接的应是**末卷**')
        assertEq(f.prevEndChapter, 30, '新卷从末卷末章的下一章开始')
        assertEq(f.prevChapterCount, 20, '章数默认取末卷的章数（11–30 共 20 章）')
        assertEq(f.orphan, null, '已有卷时不该有孤儿处置这一步')
    })

    await testCase('F2 零卷 + 无孤儿蓝图 → 进向导，首卷止于已定稿最大章号', async () => {
        freshEnv()
        seedArchitecture()
        // freshEnv 播了 1–10 章蓝图且全部定稿 → maxBlueprint === maxFinalized，无孤儿
        const { startNextVolumeFlow } = await import('../../src/services/volume-flow')

        const res = await startNextVolumeFlow()
        assert(res.ok && res.stage === 'wizard', `无孤儿时应跳过处置直接进向导，实为：${JSON.stringify(res)}`)
        assertEq(useVolumeFlowStore.getState().prevEndChapter, 10, '首卷止于已定稿最大章号')
        assertEq(useVolumeFlowStore.getState().orphan, null, '不该有孤儿信息')
    })

    await testCase('F3 零卷 + 有孤儿蓝图 → 进孤儿处置，条数用实际条数而非区间长度', async () => {
        freshEnv()
        seedArchitecture()
        // 第 11–20 章加蓝图但不定稿 → 孤儿。**故意留缺口**（跳过 15、17），
        // 实际只有 8 条；若 UI 用 end-start+1 会显示 10 条，用户按虚高的数字做决定
        for (const c of [11, 12, 13, 14, 16, 18, 19, 20]) {
            getProjectDb()!.prepare(
                `INSERT INTO blueprints (chapter_number, title, key_events) VALUES (?,?,?)`
            ).run(c, `第${c}章`, 'e')
        }
        const { startNextVolumeFlow } = await import('../../src/services/volume-flow')

        const res = await startNextVolumeFlow()
        assert(res.ok && res.stage === 'orphan', `有孤儿时必须先处置，实为：${JSON.stringify(res)}`)
        const o = useVolumeFlowStore.getState().orphan!
        assert(!!o, '应带上孤儿信息')
        assertEq(o.startChapter, 11, '孤儿区间起点 = 已定稿最大章号 + 1')
        assertEq(o.endChapter, 20, '孤儿区间终点 = 蓝图最大章号')
        assertEq(o.count, 8, '条数必须是**实际存在的蓝图条数**（区间允许有缺口），不是 end-start+1')
        assertEq(o.maxFinalized, 10, '对话框文案要用它说明「首卷按已定稿最大章号定为第 1–10 章」')
    })

    await testCase('F4 零卷 + 无定稿章节 → 拦在发起处，不进流程', async () => {
        freshEnv()
        seedArchitecture()
        // 清掉所有定稿：maxFinalized === 0
        getProjectDb()!.prepare(`DELETE FROM drafts`).run()
        const { startNextVolumeFlow } = await import('../../src/services/volume-flow')

        const res = await startNextVolumeFlow()
        assert(!res.ok && res.reason === 'no-finalized',
            `应拦在发起处，实为：${JSON.stringify(res)}`)
        assertEq(useVolumeFlowStore.getState().stage, 'idle', '流程必须收回 idle，不能停在中间态')
        // 放进工作流才失败的话，要先烧两次分钟级 LLM 调用
    })

    await testCase('F5 查卷表回来后切项目 → 作废，不进向导', async () => {
        freshEnv()
        seedArchitecture()
        // ⚠️ 必须**有卷**：零卷会走到第二次探查，那里还有一道复核会接住，
        // 删掉第一道也测不出来（第一版就是这么写的，变异不转红）。
        // 有卷时第一道是唯一那道
        VolumeRepository.upsert(vol(1, 1, 10, { title: '第一卷', status: 'done' }))
        const { startNextVolumeFlow } = await import('../../src/services/volume-flow')

        const realHandler = invokeHandler
        invokeHandler = async (channel, ...args) => {
            const r = await realHandler(channel, ...args)
            if (channel === 'db:volume-get-all') {
                // 查卷表回来之前用户切走了
                currentToken += 1
                useProjectStore.setState({ currentToken } as never)
            }
            return r
        }
        try {
            const res = await startNextVolumeFlow()
            assert(!res.ok && res.reason === 'project-switched',
                `切项目应作废整条流程，实为：${JSON.stringify(res)}`)
            assertEq(useVolumeFlowStore.getState().stage, 'idle',
                '不能停在 inspecting —— 那会让向导以为还在准备中')
        } finally {
            invokeHandler = realHandler
        }
    })

    await testCase('F5b 首卷探查回来后切项目 → 作废（第二道复核的专属用例）', async () => {
        freshEnv()
        seedArchitecture()
        // 零卷才会走到第二次探查。切换点落在 `db:volume-inspect-first` 的回包上，
        // 此时第一道复核早已通过——只有第二道能接住
        const { startNextVolumeFlow } = await import('../../src/services/volume-flow')

        const realHandler = invokeHandler
        invokeHandler = async (channel, ...args) => {
            const r = await realHandler(channel, ...args)
            if (channel === 'db:volume-inspect-first') {
                currentToken += 1
                useProjectStore.setState({ currentToken } as never)
            }
            return r
        }
        try {
            const res = await startNextVolumeFlow()
            assert(!res.ok && res.reason === 'project-switched',
                `探查回包晚于切项目应作废，实为：${JSON.stringify(res)}`)
            assertEq(useVolumeFlowStore.getState().stage, 'idle', '不能停在中间态')
        } finally {
            invokeHandler = realHandler
        }
    })

    await testCase('F6 流程已在进行时拒绝重复发起（single-flight）', async () => {
        freshEnv()
        seedArchitecture()
        VolumeRepository.upsert(vol(1, 1, 10, { title: '第一卷', status: 'done' }))
        const { startNextVolumeFlow } = await import('../../src/services/volume-flow')

        const first = await startNextVolumeFlow()
        assert(first.ok, `第一次应成功：${JSON.stringify(first)}`)
        const second = await startNextVolumeFlow()
        // 不拦的话，第二次会把第一次的向导顶掉；而第一次若已领到工作流产物，
        // 那份产物就没人 discard，库里留下孤儿统计
        assert(!second.ok && second.reason === 'busy',
            `已有流程在跑时必须拒绝，实为：${JSON.stringify(second)}`)
        assertEq(useVolumeFlowStore.getState().stage, 'wizard', '第一条流程不该被顶掉')
    })

    await testCase('F7 旧流程的回包不得覆盖新流程（同项目内重复发起）', async () => {
        freshEnv()
        seedArchitecture()
        VolumeRepository.upsert(vol(1, 1, 10, { title: '第一卷', status: 'done' }))
        const { startNextVolumeFlow } = await import('../../src/services/volume-flow')

        // 让第一次发起卡在查卷表的回包上：在它 await 期间，
        // 手动把 store 改成「另一条流程正在 preview」的样子
        const realHandler = invokeHandler
        let hijacked = false
        invokeHandler = async (channel, ...args) => {
            const r = await realHandler(channel, ...args)
            if (channel === 'db:volume-get-all' && !hijacked) {
                hijacked = true
                // 模拟：用户取消了这一条，又发起了新的一条（flowId 递增）
                useVolumeFlowStore.setState({
                    stage: 'preview',
                    flowId: useVolumeFlowStore.getState().flowId + 1,
                    prevTitle: '新流程占位',
                } as never)
            }
            return r
        }
        try {
            const res = await startNextVolumeFlow()
            assert(hijacked, '前置条件：应当发生过一次劫持')
            assert(!res.ok, `过期流程不该报成功，实为：${JSON.stringify(res)}`)
            // 关键：过期任务**只返回、不写 store**。若它 reset 或 setState，
            // 用户刚发起的那条流程会被无声关掉或改写
            const f = useVolumeFlowStore.getState()
            assertEq(f.stage, 'preview', '新流程的阶段不该被旧流程改动')
            assertEq(f.prevTitle, '新流程占位', '新流程的数据不该被旧流程覆盖')
        } finally {
            invokeHandler = realHandler
        }
    })

    await testCase('F8 项目关闭时作废流程：不得把 A 的向导留给 B', async () => {
        freshEnv()
        seedArchitecture()
        VolumeRepository.upsert(vol(1, 1, 10, { title: '第一卷', status: 'done' }))
        const { startNextVolumeFlow } = await import('../../src/services/volume-flow')
        const { invalidateVolumeFlow } = await import('../../src/stores/volume-flow-store')

        await startNextVolumeFlow()
        assertEq(useVolumeFlowStore.getState().stage, 'wizard', '前置条件：应停在向导')

        // 真实路径是 onProjectClosed 调它。这里直接调被调方，
        // 避开 onProjectClosed 里那些需要大量垫片的 Layer-2 重置
        invalidateVolumeFlow()
        assertEq(useVolumeFlowStore.getState().stage, 'idle', '关项目必须作废流程')
        assertEq(useVolumeFlowStore.getState().projectToken, null, '归属也要清掉')
    })

    await testCase('F9 实例号发号器从不回退，旧实例号无法冒充新流程', async () => {
        freshEnv()
        const { invalidateVolumeFlow } = await import('../../src/stores/volume-flow-store')
        const { isCurrentFlow } = await import('../../src/stores/volume-flow-store')
        const { startNextVolumeFlow } = await import('../../src/services/volume-flow')
        seedArchitecture()
        VolumeRepository.upsert(vol(1, 1, 10, { title: '第一卷', status: 'done' }))

        await startNextVolumeFlow()
        const idBefore = useVolumeFlowStore.getState().flowId
        invalidateVolumeFlow()
        await startNextVolumeFlow()
        const idAfter = useVolumeFlowStore.getState().flowId

        // 承重的是**发号器**：它回退的话，第二条流程会领到与第一条相同的号，
        // 第一条那些还在飞的回包就能冒充第二条写状态。
        // （store 里的 flowId 归零反而无害——归属校验还要比 projectToken，
        //   而它此刻是 null。这一点我一开始搞反了，变异不转红才发现）
        assert(idAfter > idBefore,
            `实例号必须单调递增（前 ${idBefore} 后 ${idAfter}）`)
        // 拿旧号去验，必须不认
        assert(!isCurrentFlow(useVolumeFlowStore.getState().projectToken ?? undefined, idBefore, currentToken),
            '旧实例号不该再被认作当前流程')
    })

    await testCase('F10 确认写入：正常路径落库并收干净流程', async () => {
        freshEnv()
        seedArchitecture()
        const { startNextVolumeFlow, confirmNextVolume } = await import('../../src/services/volume-flow')
        VolumeRepository.upsert(vol(1, 1, 10, { title: '第一卷', status: 'done' }))
        await startNextVolumeFlow()   // 领取归属键（confirmNextVolume 要用）

        const res = await confirmNextVolume({
            result: makeWorkflowResult(),
            chapterCount: 10,
            edited: { title: '第二卷', premise: '主线', synopsis: '大纲', suggestedChapterCount: 10 },
            editedReport: { volumeNumber: 1, closingState: '收束', openThreads: [] },
        })
        assert(res.ok, `应写入成功：${JSON.stringify(res)}`)
        assertEq(VolumeRepository.get(2)?.title, '第二卷', '新卷应落库')
        assertEq(useVolumeFlowStore.getState().stage, 'idle', '成功后流程收回 idle')
    })

    await testCase('F11 确认写入：用户编辑过的伏笔必须结转进新卷台账', async () => {
        freshEnv()
        seedArchitecture()
        const { startNextVolumeFlow, confirmNextVolume } = await import('../../src/services/volume-flow')
        VolumeRepository.upsert(vol(1, 1, 10, { title: '第一卷', status: 'done' }))
        await startNextVolumeFlow()

        // AI 原本给的是空清单，用户在预览里补录了一条。
        // 走 AI 那份原始产物的话，这条补录永远进不了台账，
        // 「伏笔必须回收」在后续几十章里都拿它没办法
        await confirmNextVolume({
            result: makeWorkflowResult(),
            chapterCount: 10,
            edited: { title: '第二卷', premise: 'p', synopsis: 's', suggestedChapterCount: 10 },
            editedReport: {
                volumeNumber: 1,
                closingState: '用户改过的收束状态',
                openThreads: [{ chapter: 7, thread: '用户补录的伏笔', urgency: 'high' }],
            },
        })
        const v2 = VolumeRepository.get(2)!
        assertEq(v2.openingState, '用户改过的收束状态', '新卷开卷状态取自**编辑后**的收卷报告')
        assertEq(v2.openThreads.length, 1, '用户补录的伏笔必须结转')
        assertEq(v2.openThreads[0].thread, '用户补录的伏笔', '内容要对得上')
    })

    await testCase('F12 确认写入：回包晚于流程作废 → 不动任何状态', async () => {
        freshEnv()
        seedArchitecture()
        const { startNextVolumeFlow, confirmNextVolume } = await import('../../src/services/volume-flow')
        const { invalidateVolumeFlow } = await import('../../src/stores/volume-flow-store')
        VolumeRepository.upsert(vol(1, 1, 10, { title: '第一卷', status: 'done' }))
        await startNextVolumeFlow()

        // 提交事务返回之后、重拉卷表之前，用户关了项目又发起了新流程
        const realHandler = invokeHandler
        invokeHandler = async (channel, ...args) => {
            const r = await realHandler(channel, ...args)
            // 切换点落在**提交事务的回包**上 —— 第一道归属判定的专属窗口
            if (channel === 'db:volume-commit-next') {
                invalidateVolumeFlow()
                useVolumeFlowStore.setState({ stage: 'wizard', prevTitle: '新流程占位' } as never)
            }
            return r
        }
        try {
            ipcLog.length = 0
            const res = await confirmNextVolume({
                result: makeWorkflowResult(),
                chapterCount: 10,
                edited: { title: '第二卷', premise: 'p', synopsis: 's', suggestedChapterCount: 10 },
                editedReport: { volumeNumber: 1, closingState: 'c', openThreads: [] },
            })
            assert(!res.ok && res.reason === 'stale',
                `回包晚于作废应判 stale，实为：${JSON.stringify(res)}`)
            // 库里那条写入确实成功了——但对当前上下文而言这次调用等于没发生。
            // 关键是**不能 reset**：那会把用户刚发起的新流程无声关掉
            const f = useVolumeFlowStore.getState()
            assertEq(f.stage, 'wizard', '新流程的阶段不该被旧提交回包改动')
            assertEq(f.prevTitle, '新流程占位', '新流程的数据不该被覆盖')
            // ⚠️ 这里**曾经**断言「stale 后不该再重拉卷表」，那是条**假绿**：
            // `commitNextVolume` 返回之前就发了 REFRESH_RESOURCE，真实 App 里
            // ProjectService 的监听会照样 loadAll——本流程的归属判定管不着它。
            // harness 没初始化 ProjectService，所以那条断言只在测试里成立。
            // 现在重复的那次显式 loadAll 已从 confirmNextVolume 里删掉，
            // 卷表刷新统一由事件驱动（它自带 token 守卫，串不到别的项目）。
            // 本用例保留的是真正承重的部分：**stale 时不动流程状态**。

        } finally {
            invokeHandler = realHandler
        }
    })

    await testCase('F12b 确认写入：提交失败时不动流程状态，且失败原因如实透传', async () => {
        freshEnv()
        seedArchitecture()
        const { startNextVolumeFlow, confirmNextVolume } = await import('../../src/services/volume-flow')
        VolumeRepository.upsert(vol(1, 1, 10, { title: '第一卷', status: 'done' }))
        await startNextVolumeFlow()

        // 让提交事务失败（主进程拒绝）。流程必须**留在原地**让用户重试，
        // 不能像成功那样 reset —— 那会把预览界面连同用户的编辑一起关掉
        const realHandler = invokeHandler
        invokeHandler = async (channel, ...args) => {
            if (channel === 'db:volume-commit-next') {
                return { success: false, error: '模拟的提交失败' } as never
            }
            return realHandler(channel, ...args)
        }
        try {
            const res = await confirmNextVolume({
                result: makeWorkflowResult(),
                chapterCount: 10,
                edited: { title: '第二卷', premise: 'p', synopsis: 's', suggestedChapterCount: 10 },
                editedReport: { volumeNumber: 1, closingState: 'c', openThreads: [] },
            })
            assert(!res.ok && res.reason === 'failed', `应判 failed，实为：${JSON.stringify(res)}`)
            assert(res.ok === false && res.reason === 'failed' && res.message.includes('模拟的提交失败'),
                `失败原因要如实透传，实为：${JSON.stringify(res)}`)
            assert(useVolumeFlowStore.getState().stage !== 'idle',
                '提交失败不该收掉流程 —— 用户的编辑还在预览里，得让他能重试')
            assertEq(VolumeRepository.get(2), null, '失败时不该有新卷落库')
        } finally {
            invokeHandler = realHandler
        }
    })

    await testCase('F13 伏笔校验：逐条合规不等于整体合规（字节上限）', async () => {
        const { validateOpenThreads, MAX_OPEN_THREADS, MAX_THREAD_LEN, MAX_OPEN_THREADS_BYTES } =
            await import('../../src/shared/volume-limits')

        assertEq(validateOpenThreads([]), '', '空清单合法')
        assertEq(validateOpenThreads([{ chapter: 1, thread: 'ok', urgency: 'mid' }]), '', '正常条目合法')

        // 逐条都在限内，但总量超字节上限 —— 只查条数与单条长度会放行，
        // 主进程随后拒绝，用户看到的是一条底层报错
        const fat = Array.from({ length: MAX_OPEN_THREADS }, () => ({
            chapter: 1, thread: '伏'.repeat(MAX_THREAD_LEN), urgency: 'mid',
        }))
        assert(fat.length <= MAX_OPEN_THREADS, '前置：条数在限内')
        assert(fat.every(t => t.thread.length <= MAX_THREAD_LEN), '前置：单条长度在限内')
        const err = validateOpenThreads(fat)
        assert(err.includes('总量'), `应报总量超限，实为：${err || '（通过了）'}`)
        assert(MAX_OPEN_THREADS_BYTES > 0, 'sanity')

        assert(validateOpenThreads([{ chapter: 0, thread: 'x', urgency: 'mid' }]).includes('章号'),
            '章号非法要报出来')
        assert(validateOpenThreads([{ chapter: 1, thread: '   ', urgency: 'mid' }]).includes('为空'),
            '空内容要报出来')
    })

    await testCase('F14 续卷工作流：章数必须是安全整数（1e21 这类要拦住）', async () => {
        freshEnv()
        seedArchitecture()
        VolumeRepository.upsert(vol(1, 1, 10, { title: '第一卷', status: 'done' }))
        const { createNextVolumeWorkflow } = await import('../../src/services/workflows/volume-workflow')

        // `Number.isInteger(1e21)` 为**真**，但 `1e21 + 1 === 1e21`——
        // 章号运算静默丢精度，而这一切发生在两次分钟级 LLM 调用**之后**才暴露。
        // UI 那道只是第一道，Agent 或将来的其它调用方绕不开工作流入口这道
        for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e21, Number.MAX_SAFE_INTEGER + 10]) {
            let threw = ''
            try {
                createNextVolumeWorkflow({ userIntent: '', structure: 'three_act', chapterCount: bad as number })
            } catch (e) { threw = e instanceof Error ? e.message : String(e) }
            assert(threw.includes('章数非法'), `chapterCount=${String(bad)} 应被拒，实为：${threw || '（没抛）'}`)
        }
        // 合法值不该被误伤
        let ok = true
        try {
            createNextVolumeWorkflow({ userIntent: '', structure: 'three_act', chapterCount: 60 })
        } catch { ok = false }
        assert(ok, '合法章数不该被拒')
    })

    await testCase('F15 探查抛异常 + 归属已失 → 按 project-switched 静默，不报「准备失败」', async () => {
        freshEnv()
        seedArchitecture()
        const { startNextVolumeFlow } = await import('../../src/services/volume-flow')
        const { invalidateVolumeFlow } = await import('../../src/stores/volume-flow-store')

        // 用户切走导致在途请求失败，是很常见的一种「异常」。
        // 报 inspect-failed 会让 VolumeGroup 在**新项目的界面**上弹
        // 「续卷准备失败」——一句用户看不懂、也没法处理的错误
        const realHandler = invokeHandler
        invokeHandler = async (channel, ...args) => {
            if (channel === 'db:volume-get-all') {
                invalidateVolumeFlow()
                useVolumeFlowStore.setState({ stage: 'wizard', prevTitle: '新流程占位' } as never)
                throw new Error('模拟：项目关闭导致在途请求失败')
            }
            return realHandler(channel, ...args)
        }
        try {
            const res = await startNextVolumeFlow()
            assert(!res.ok && res.reason === 'project-switched',
                `归属已失时的异常应按 project-switched 静默，实为：${JSON.stringify(res)}`)
            // 且不得动新流程
            assertEq(useVolumeFlowStore.getState().prevTitle, '新流程占位', '不该改动新流程的数据')
        } finally {
            invokeHandler = realHandler
        }
    })

    await testCase('F16 章数输入的严格解析：parseInt 会把 1e21 / 1.5 静默截成 1', async () => {
        const { parseChapterCount } = await import('../../src/shared/volume-limits')

        // 这两个是关键：`Number.parseInt('1e21', 10) === 1`、
        // `Number.parseInt('1.5', 10) === 1`——先转换再校验，
        // 用户敲 1e21 会按 1 章去生成，而他毫不知情
        assert(Number.isNaN(parseChapterCount('1e21')), '1e21 必须判非法，不能截成 1')
        assert(Number.isNaN(parseChapterCount('1.5')), '1.5 必须判非法，不能截成 1')
        // 对照：证明上面那两条确实在防「静默截断」而不是随手写的
        assertEq(Number.parseInt('1e21', 10), 1, '前置事实：parseInt 会把 1e21 截成 1')
        assertEq(Number.parseInt('1.5', 10), 1, '前置事实：parseInt 会把 1.5 截成 1')

        assert(Number.isNaN(parseChapterCount('')), '空串非法')
        assert(Number.isNaN(parseChapterCount('  ')), '空白非法')
        assert(Number.isNaN(parseChapterCount('0')), '0 非法')
        assert(Number.isNaN(parseChapterCount('-3')), '负数非法')
        assert(Number.isNaN(parseChapterCount('abc')), '非数字非法')
        assert(Number.isNaN(parseChapterCount(String(Number.MAX_SAFE_INTEGER + 10))), '越界非法')
        assertEq(parseChapterCount('60'), 60, '合法值原样返回')
        assertEq(parseChapterCount(' 60 '), 60, '两侧空白可容忍')
    })

    await testCase('F17 派生末章越界必须在第一次 LLM 之前拦下', async () => {
        freshEnv()
        seedArchitecture()
        const { buildCommitPayload } = await import('../../src/services/workflows/volume-workflow')

        // 上一卷末章接近 MAX_SAFE_INTEGER 时，**合法的 chapterCount: 1**
        // 照样算出不安全的章号。工作流入口那道只验 chapterCount 本身，兜不住；
        // 仓储层虽然也验（Task 19.4 收紧过），但那是落库时——
        // 本函数的返回值会先被拿去拼 prompt 发给模型
        const prev = vol(1, 1, Number.MAX_SAFE_INTEGER, { title: '第一卷' })
        let threw = ''
        try {
            buildCommitPayload(
                { prevVolume: prev, closingReport: { volumeNumber: 1, closingState: '', openThreads: [] } },
                { title: 'x', premise: '', synopsis: '', suggestedChapterCount: 1 },
                1,
            )
        } catch (e) { threw = e instanceof Error ? e.message : String(e) }
        assert(threw.includes('章号非法'), `派生末章越界应被拒，实为：${threw || '（没抛）'}`)

        // 正常区间不该被误伤
        const okPrev = vol(1, 1, 10, { title: '第一卷' })
        const payload = buildCommitPayload(
            { prevVolume: okPrev, closingReport: { volumeNumber: 1, closingState: '', openThreads: [] } },
            { title: '第二卷', premise: '', synopsis: '', suggestedChapterCount: 10 },
            10,
        )
        assertEq(payload.newVolume.startChapter, 11, '正常区间起点')
        assertEq(payload.newVolume.endChapter, 20, '正常区间终点')
    })

    await testCase('F17b 老库里的超长卷：工作流第一步就拦下（不烧掉两次 LLM）', async () => {
        freshEnv()
        seedArchitecture()
        // ⚠️ **绕过仓储直接写库**：仓储层现在会拒绝这种超长卷（F18b 验的就是那道），
        // 所以正常路径已经建不出来。这里模拟的是**老库脏数据**——
        // 加区间上限之前建的卷，或从外部导入的库。
        // 工作流那道守卫的意义正在于此：它不能假设库里的数据都合规
        getProjectDb()!.prepare(
            `INSERT INTO volumes (volume_number, title, start_chapter, end_chapter, status) VALUES (?,?,?,?,?)`
        ).run(1, '第一卷', 1, Number.MAX_SAFE_INTEGER, 'done')
        const { createNextVolumeWorkflow } = await import('../../src/services/workflows/volume-workflow')
        const llm = stubLLM(['{}', '{}'])

        const def = createNextVolumeWorkflow({ userIntent: '', structure: 'three_act', chapterCount: 1 })
        let threw = ''
        try {
            await def.steps[0].executor(
                {} as never,
                { data: {}, cancelled: false } as never,
                { log: () => {}, setProgress: () => {}, appendText: () => {} } as never)
        } catch (e) { threw = e instanceof Error ? e.message : String(e) }

        assert(threw.includes('章号越界'), `第一步就该拦下，实为：${threw || '（没抛）'}`)
        // 关键：拦在**第一次 LLM 之前**。事后才发现的话，两次分钟级调用的成本已经烧掉了
        assertEq(llm.calls, 0, '拦下时不该发起任何模型调用')

        // ⚠️ 这道守卫拦的是**章号越界**那一类。
        // （`readVolumeChapterNotes` 本身已改成按实际记录遍历，不再逐章循环，
        //   所以它不会再因为区间大而挂死；但越界章号仍会让后续所有加减静默出错。）
        // 「上一卷区间超长」是**另一类**，由紧随其后的 span 检查拦，见 F17c。
    })

    await testCase('F18 端点安全但区间巨大 —— 安全整数 ≠ 可遍历', async () => {
        freshEnv()
        const { MAX_VOLUME_CHAPTERS, parseChapterCount } = await import('../../src/shared/volume-limits')

        // ⚠️ 这是上一轮我漏掉的那类反例：`prevEnd=10 + count=MAX_SAFE_INTEGER-10`
        // 两端相加**仍是**安全整数，只验端点的守卫会放行，
        // 而按区间逐章处理的代码要跑 9 千万亿次。
        const huge = Number.MAX_SAFE_INTEGER - 10
        assert(Number.isSafeInteger(huge), '前置事实：它本身是安全整数')
        assert(Number.isSafeInteger(10 + huge), '前置事实：与上一卷末章相加**也是**安全整数')
        assert(Number.isNaN(parseChapterCount(String(huge))),
            '正是这种「端点安全」的值必须被拒 —— 只查安全整数是不够的')

        assertEq(parseChapterCount(String(MAX_VOLUME_CHAPTERS)), MAX_VOLUME_CHAPTERS, '恰好等于上限应放行')
        assert(Number.isNaN(parseChapterCount(String(MAX_VOLUME_CHAPTERS + 1))), '超过一格即拒')
    })

    await testCase('F18b 仓储层是最后一道：直接建超长卷必须被拒', async () => {
        freshEnv()
        const { MAX_VOLUME_CHAPTERS } = await import('../../src/shared/volume-limits')

        // 渲染层的解析、工作流入口都只护住各自那条链；
        // `db:volume-upsert` 是公开通道，Agent 或将来的调用方可以直接打进来
        let threw = ''
        try {
            VolumeRepository.upsert(vol(1, 1, MAX_VOLUME_CHAPTERS + 1, { title: '超长卷' }))
        } catch (e) { threw = e instanceof Error ? e.message : String(e) }
        assert(threw.includes('超过上限'), `超长区间应被拒，实为：${threw || '（没抛）'}`)

        // 不安全整数同样拒。⚠️ 这里的**区间必须是小的**：
        // 用 `1..1e21` 的话 span 检查会抢先拦下，`isSafeInteger` 这道就测不到
        // （第一版正是这么写的，把 isInteger 换回去也不转红）。
        // `start = end = 1e21` 时 span 恰好是 1，只有安全整数这道能拦
        let threw2 = ''
        try {
            VolumeRepository.upsert(vol(1, 1e21, 1e21, { title: '越界卷' }))
        } catch (e) { threw2 = e instanceof Error ? e.message : String(e) }
        assert(threw2.includes('安全整数'),
            `1e21 章号应被「安全整数」那道拦下，实为：${threw2 || '（没抛）'}`)
        // ⚠️ 本断言证明的是「**这一对**安全整数检查里至少有一道生效」，
        // 不是「每一道各自生效」：`end >= start` 使得起始章不安全时结束章必然也不安全，
        // 两道互为掩护，单独去掉任一道另一道都会接住（实测两条变异都不转红，
        // 同时去掉两道才转红）。这是有意的纵深防御，不是冗余代码——
        // 但用例只能证明到这个粒度，不该声称更多。

        // 正常卷不该被误伤
        VolumeRepository.upsert(vol(1, 1, 100, { title: '正常卷' }))
        assertEq(VolumeRepository.get(1)?.title, '正常卷', '合法卷应正常落库')
    })

    await testCase('F19 盘点上一卷要点：耗时只与真实数据量相关，与区间大小无关', async () => {
        freshEnv()
        seedArchitecture()
        const { readVolumeChapterNotes } = await import('../../src/services/prompts/volume-context')

        // freshEnv 播了 1–10 章蓝图。用一个**巨大的区间**去读——
        // 逐章循环的旧实现会在这里跑到天荒地老；按记录遍历则只看库里那 10 条
        ipcLog.length = 0
        const text = await readVolumeChapterNotes(1, Number.MAX_SAFE_INTEGER)

        assert(text.includes('第1章'), '应读到实际存在的章')
        assert(text.includes('第10章'), '应读到区间内最后一条实际记录')
        // 关键断言：IPC 次数与**区间大小**无关。逐章实现会发 9 千万亿次
        const calls = ipcLog.filter(l => l.channel.startsWith('db:blueprint')).length
        assert(calls <= 2, `蓝图相关 IPC 应为常数次（一次取全量），实为 ${calls} 次`)
    })

    await testCase('F17c 上一卷区间超长（端点全安全）→ 工作流前置拒绝', async () => {
        freshEnv()
        seedArchitecture()
        const { MAX_VOLUME_CHAPTERS } = await import('../../src/shared/volume-limits')
        const { createNextVolumeWorkflow } = await import('../../src/services/workflows/volume-workflow')

        // ⚠️ 这正是 F17b 漏掉的那一类：`start=1, end=MAX_SAFE_INTEGER-10001, count=1`
        // —— 末章是安全整数、派生末章也是安全整数，只验端点的守卫会**放行**，
        // 然后跑完两次分钟级 LLM，最后才在「把上一卷 upsert 回去」那步被仓储层拒绝。
        // 绕过仓储直接写库：这种卷正是老库/外部导入才有的
        const hugeEnd = Number.MAX_SAFE_INTEGER - 10001
        assert(Number.isSafeInteger(hugeEnd), '前置事实：末章是安全整数')
        assert(Number.isSafeInteger(hugeEnd + 1), '前置事实：派生末章也是安全整数')
        assert(hugeEnd - 1 + 1 > MAX_VOLUME_CHAPTERS, '前置事实：但区间远超单卷上限')

        getProjectDb()!.prepare(
            `INSERT INTO volumes (volume_number, title, start_chapter, end_chapter, status) VALUES (?,?,?,?,?)`
        ).run(1, '老库超长卷', 1, hugeEnd, 'done')

        const llm = stubLLM(['{}', '{}'])
        const def = createNextVolumeWorkflow({ userIntent: '', structure: 'three_act', chapterCount: 1 })
        let threw = ''
        try {
            await def.steps[0].executor(
                {} as never, { data: {}, cancelled: false } as never,
                { log: () => {}, setProgress: () => {}, appendText: () => {} } as never)
        } catch (e) { threw = e instanceof Error ? e.message : String(e) }

        assert(threw.includes('区间异常'), `超长的上一卷应被前置拒绝，实为：${threw || '（没抛）'}`)
        assert(threw.includes('卷详情'), '错误里要告诉用户去哪儿修')
        assertEq(llm.calls, 0, '拦下时不该发起任何模型调用')
    })

    await testCase('F20 伏笔章号的严格解析与优先级校验', async () => {
        const { parseChapterNumber, validateOpenThreads } = await import('../../src/shared/volume-limits')

        // 与「本卷章数」同一个坑：`parseInt('1.5')===1`、`parseInt('1e21')===1`。
        // 用户粘一个 1.5 进去，系统当成第 1 章存下来，而他毫不知情
        assert(Number.isNaN(parseChapterNumber('1.5')), '1.5 必须判非法')
        assert(Number.isNaN(parseChapterNumber('1e21')), '1e21 必须判非法')
        assertEq(Number.parseInt('1.5', 10), 1, '前置事实：parseInt 会把 1.5 截成 1')
        assertEq(parseChapterNumber('12'), 12, '合法值原样返回')
        assert(Number.isNaN(parseChapterNumber('0')), '0 非法')

        // urgency 也得验：仓储层 assertThreadForWrite 会拒绝列表外的值，
        // 预检漏了它，「与仓储层同一套判据」就是空话
        const bad = validateOpenThreads([{ chapter: 1, thread: 'x', urgency: 'urgent' }])
        assert(bad.includes('优先级'), `列表外的 urgency 应被拒，实为：${bad || '（通过了）'}`)
        for (const u of ['high', 'mid', 'low']) {
            assertEq(validateOpenThreads([{ chapter: 1, thread: 'x', urgency: u }]), '', `${u} 应合法`)
        }
        // 不安全整数章号同样拒（isInteger 放行 1e21，isSafeInteger 才拦得住）
        assert(validateOpenThreads([{ chapter: 1e21, thread: 'x', urgency: 'mid' }]).includes('章号'),
            '1e21 章号应被拒')
    })

    await testCase('F17d 上一卷零长度/反向区间同样前置拒绝', async () => {
        freshEnv()
        seedArchitecture()
        const { createNextVolumeWorkflow } = await import('../../src/services/workflows/volume-workflow')

        // `start=2, end=1` → span 为 0，**端点全是安全整数**、也没超上限。
        // 只拦「太长」会放行它，跑完两次 LLM 才在回写上一卷时被仓储层拒绝
        getProjectDb()!.prepare(
            `INSERT INTO volumes (volume_number, title, start_chapter, end_chapter, status) VALUES (?,?,?,?,?)`
        ).run(1, '反向区间卷', 2, 1, 'done')

        const llm = stubLLM(['{}', '{}'])
        const def = createNextVolumeWorkflow({ userIntent: '', structure: 'three_act', chapterCount: 1 })
        let threw = ''
        try {
            await def.steps[0].executor(
                {} as never, { data: {}, cancelled: false } as never,
                { log: () => {}, setProgress: () => {}, appendText: () => {} } as never)
        } catch (e) { threw = e instanceof Error ? e.message : String(e) }
        assert(threw.includes('区间异常'), `零长度区间应被前置拒绝，实为：${threw || '（没抛）'}`)
        assertEq(llm.calls, 0, '拦下时不该发起任何模型调用')
    })

    await testCase('F21 主进程伏笔校验与渲染层预检同判据', async () => {
        freshEnv()
        const { assertThreadForWrite } = await import('../../electron/repositories/volume-threads')
        const { validateOpenThreads, THREAD_URGENCIES } = await import('../../src/shared/volume-limits')

        // 渲染层已经拒 1e21，主进程若还用 isInteger，
        // 直接打 `db:volume-upsert` / `db:volume-update-threads` 就能把它存进去
        const bad = { chapter: 1e21, thread: 'x', urgency: 'mid' }
        assert(validateOpenThreads([bad]).includes('章号'), '前置：渲染层拒绝它')
        let threw = ''
        try { assertThreadForWrite(bad, 1, 0) } catch (e) { threw = e instanceof Error ? e.message : String(e) }
        assert(threw.includes('章号'), `主进程也必须拒绝，实为：${threw || '（放行了）'}`)

        // urgency 清单两侧共用同一份，不各写一套
        for (const u of THREAD_URGENCIES) {
            const t = assertThreadForWrite({ chapter: 1, thread: 'x', urgency: u }, 1, 0)
            assertEq(t.urgency, u, `${u} 两侧都该合法`)
        }

        // trim 口径：仓储层存的是 trim 后的内容，预检也按 trim 后量长度。
        // 不一致的话，带首尾空白的边界输入会被 UI 拒绝、而仓储层本来会接受
        const padded = { chapter: 1, thread: `  ${'伏'.repeat(500)}  `, urgency: 'mid' }
        assertEq(validateOpenThreads([padded]), '', '预检按 trim 后量，恰好 500 字应放行')
        const kept = assertThreadForWrite(padded, 1, 0)
        assertEq(kept.thread.length, 500, '仓储层存的是 trim 后的内容')
    })

    await testCase('F22 字节预检只算落库字段：UI 专用字段不得计入限额', async () => {
        const { validateOpenThreads, MAX_OPEN_THREADS, MAX_OPEN_THREADS_BYTES, utf8Bytes } =
            await import('../../src/shared/volume-limits')
        const { serializeOpenThreads } = await import('../../electron/repositories/volume-threads')

        // 预览对话框给每行挂了个稳定 `_id`（删除后原始输入文本不串行所必需）。
        // 字节校验若用 `{...t}` 展开，这个纯 UI 字段会被算进 256KB 限额——
        // 近上限时 UI 拒绝、而仓储层本来接受，用户被一个不存在的规则挡住。
        // 419 字 × 200 条：这个尺寸卡在两者之间——**落库形态在限内、
        // 带 `_id` 的 UI 形态超限**，正好能区分「按落库字段量」与「按 UI 对象量」。
        //
        // ⚠️ 刻意**不在注释里写死字节数**：那个值随 `_id` 的位数、章号位数、
        // 甚至 JSON 键序而变，写死了迟早与构造对不上（上一版就抄错过一组，
        // 注释里的数字对应的是另一种构造）。
        // 两条前置断言是**动态计算**的，它们负责证明这个尺寸确实卡在两者之间；
        // 尺寸本身若哪天不再满足，断言会直接失败，而不是悄悄退化成空转。
        const rows = Array.from({ length: MAX_OPEN_THREADS }, (_, i) => ({
            chapter: i + 1, thread: '伏'.repeat(419), urgency: 'mid', _id: `t${i}`,
        }))

        // 前置事实：**落库形态**确实在限内
        const persistedBytes = utf8Bytes(serializeOpenThreads(
            rows.map(r => ({ chapter: r.chapter, thread: r.thread, urgency: r.urgency as never })), 1))
        assert(persistedBytes <= MAX_OPEN_THREADS_BYTES,
            `前置事实：落库形态 ${persistedBytes} 字节应在 ${MAX_OPEN_THREADS_BYTES} 限内`)
        // 前置事实：带 _id 的形态确实超限——证明这条用例测的是真差异，不是空转
        const uiBytes = utf8Bytes(JSON.stringify(rows))
        assert(uiBytes > MAX_OPEN_THREADS_BYTES,
            `前置事实：带 _id 的形态 ${uiBytes} 字节应超限，否则本用例证明不了什么`)

        assertEq(validateOpenThreads(rows), '',
            '预检必须按落库字段量：UI 专用字段计入限额会误拒仓储层本来接受的数据')
    })

    console.log('\n▶ 卷 UI 的展示口径（Task 19.4 批次二）')

    await testCase('X24 已写章数只数区间内的 finalized（上下界各自可辨）', async () => {
        const { countFinalizedInRange, countFinalizedTotal } =
            await import('../../src/services/volume-service')

        // 第 2 章有稿但都没定稿；第 9 章定稿但在窄区间之外
        const drafts = {
            1: [{ status: 'finalized' }],
            2: [{ status: 'draft' }, { status: 'reviewed' }],
            3: [{ status: 'finalized' }],
            9: [{ status: 'finalized' }],
        }

        // 三条断言刻意各自只让**一道**判据成为唯一那道，避免「两道守卫互相掩护、
        // 单独去掉任一道都不转红」（本 Task 已在别处栽过六次）：
        //   ① 上界：start=1 时下界不排除任何章，去掉 `c > end` 就会多数到第 9 章
        assertEq(countFinalizedInRange(drafts, 1, 3), 2, '第 1–3 章内定稿的是第 1、3 章')
        //   ② 下界：end=9 时上界不排除任何章，去掉 `c < start` 就会多数到第 1 章
        assertEq(countFinalizedInRange(drafts, 3, 9), 2, '第 3–9 章内定稿的是第 3、9 章')
        //   ③ 定稿判据：区间里只有第 2 章，它有草稿但无定稿。把 `status==='finalized'`
        //      放宽成「有草稿就算」会数出 1
        assertEq(countFinalizedInRange(drafts, 2, 2), 0, '只有未定稿草稿的章不算已写')

        assertEq(countFinalizedTotal(drafts), 3, '全书口径与区间口径同源：共 3 章有定稿')
    })

    await testCase('X25 区间可以大到不可遍历，统计仍只按实际记录走', async () => {
        const { countFinalizedInRange } = await import('../../src/services/volume-service')

        // 老库与外部导入的库仍可能有超长卷（MAX_VOLUME_CHAPTERS 只约束新写入），
        // 而这个函数跑在侧栏与总览页这类每次状态变更都要重算的位置。
        //
        // ⚠️ 断言方式刻意**不是**「跑一遍看耗时」：若实现退化成
        // `for (i=start; i<=end; i++)`，那种写法会挂死在 9 千万亿次循环里，
        // harness 永远不结束——那是可观测的失败，但不是一条能在有界时间内
        // 拿到的红。改用**只允许被访问 N 次的代理对象**：按记录遍历时
        // (`Object.entries`) 恰好访问 2 次；按区间循环则在第 3 次访问时抛错，
        // 微秒级变红且带明确原因。
        const records: Record<number, Array<{ status: string }>> = {
            1: [{ status: 'finalized' }],
            5: [{ status: 'finalized' }],
        }
        const budget = Object.keys(records).length
        let reads = 0
        const guarded = new Proxy(records, {
            get(target, prop, recv) {
                // 只统计**数据键**的读取：Symbol 与原型方法不算遍历成本
                if (typeof prop === 'string' && /^\d+$/.test(prop)) {
                    reads++
                    if (reads > budget) {
                        throw new Error(
                            `统计按章号区间遍历了：读了第 ${reads} 个键（记录只有 ${budget} 条）。` +
                            `必须按实际记录遍历，否则超长卷会让侧栏渲染冻住`
                        )
                    }
                }
                return Reflect.get(target, prop, recv)
            },
        })

        assertEq(
            countFinalizedInRange(guarded, 1, Number.MAX_SAFE_INTEGER), 2,
            '两条记录都在区间内',
        )
        assertEq(reads, budget, `应恰好读 ${budget} 次（每条记录一次），实际 ${reads} 次`)
    })

    await testCase('X26 project-switched 刻意不提示，其余失败原因**全部**原样透传', async () => {
        const { describeStartFlowResult } = await import('../../src/services/volume-flow')

        assertEq(describeStartFlowResult({ ok: true, stage: 'wizard' }), null, '成功不提示')
        // 这一条是判据的**唯一**保护点：去掉 `reason === 'project-switched'` 那行，
        // 只有它会变红
        assertEq(
            describeStartFlowResult({ ok: false, reason: 'project-switched', message: '项目已切换，本次续卷已取消' }),
            null,
            'project-switched 是用户自己切走的，再弹一句等于告诉他他刚做过的事',
        )

        // 表驱动枚举**除 project-switched 外的全部** reason。
        // 用 `Record<Exclude<...>>` 而非数组：数组漏一项 tsc 不会管，
        // 而 Record 缺项直接编译失败——将来往联合里加 reason 却忘了归类时，
        // 本用例会在编译期就拦下，而不是继续全绿。
        const passthrough: Record<Exclude<StartFlowFailReason, 'project-switched'>, string> = {
            'no-project': '未打开项目',
            'busy': '已有续卷流程正在进行',
            'no-finalized': '尚无定稿章节，先写完至少一章再续卷',
            'inspect-failed': '首卷探查失败，请重试',
        }
        for (const [reason, message] of Object.entries(passthrough)) {
            assertEq(
                describeStartFlowResult({ ok: false, reason: reason as StartFlowFailReason, message }),
                message,
                `reason=${reason} 的原始 message 必须原样传到 UI`,
            )
        }
        // 注：`if (res.ok) return null` 那一道**去不掉**——判别联合下，
        // 删了它就访问不到 `res.reason`，tsc 直接报错。故本用例不宣称用变异证明过它。
    })

    await testCase('X27 卷卡摘要回落 synopsis；伏笔计数区分「确定的 0」与「还没建台账」', async () => {
        const { getVolumeSummary, describeOpenThreadCount, computeEffectiveTotalChapters } =
            await import('../../src/services/volume-service')

        // 惰性首卷的真实形状：premise 恒为空，synopsis 是原有的全书大纲。
        // 只看 premise 的实现会让它在总览页显示「尚无摘要」，而它其实有大纲
        const lazyFirst = { premise: '', synopsis: '全书原大纲', openThreads: [] }
        assertEq(getVolumeSummary(lazyFirst), '全书原大纲', 'premise 为空时必须回落 synopsis')
        // premise 存在时优先它（否则「回落」会变成「永远用 synopsis」）
        assertEq(
            getVolumeSummary({ premise: '本卷主线', synopsis: '本卷大纲' }), '本卷主线',
            'premise 有内容时优先展示它',
        )
        // 只有空白字符不算内容——否则一个换行就能让卡片显示一片空白
        assertEq(getVolumeSummary({ premise: '  \n ', synopsis: '' }), '', '纯空白不算摘要')

        // 有大纲 + 零条伏笔：这是**权威的 0**，必须写出数字
        assertEq(describeOpenThreadCount(lazyFirst), 0, '有大纲的卷，0 条是确定结论，要如实写')
        // 无大纲 + 零条：台账还没建，谈「0 条」会被读成「已确认没有伏笔」
        assertEq(
            describeOpenThreadCount({ premise: '', synopsis: '', openThreads: [] }), null,
            '无大纲且无伏笔的卷应交给 UI 写「—」，不能报 0',
        )
        // 无大纲 + **有伏笔**：伏笔经 db:volume-update-threads 独立更新，与摘要毫无绑定。
        // 只凭「有没有摘要」决定要不要显示数字，会把用户刚补录的伏笔藏成「—」
        assertEq(
            describeOpenThreadCount({
                premise: '', synopsis: '',
                openThreads: [
                    { chapter: 3, thread: '锈剑铭文', urgency: 'high' },
                    { chapter: 7, thread: '师门叛徒', urgency: 'mid' },
                ],
            }),
            2,
            '没写大纲但已补录伏笔时，必须如实写出条数——那是确定存在的数据',
        )
        assertEq(
            describeOpenThreadCount({ premise: 'P', synopsis: '', openThreads: [{ chapter: 1, thread: 'x', urgency: 'mid' }] }),
            1,
            '有大纲时按实际条数',
        )

        // 顺带钉住「卷表为准」这条规则只有一份实现：总览页用的是同一个纯函数
        assertEq(computeEffectiveTotalChapters([], 220), 220, '零卷回落 novelConfig.totalChapters')
        assertEq(
            computeEffectiveTotalChapters(
                [vol(1, 1, 100), vol(2, 101, 160)] as never, 999,
            ),
            160,
            '有卷时取各卷 endChapter 最大值，忽略 novelConfig 的总章数',
        )
    })

    // ===== 汇总 =====
    closeProjectDatabase()
    fs.rmSync(tmpRoot, { recursive: true, force: true })

    console.log(`\n${'='.repeat(60)}`)
    if (failures.length === 0) {
        console.log(`✅ 全部通过：${passed} 个用例`)
        process.exit(0)
    } else {
        console.log(`❌ ${failures.length} 个失败 / ${passed + failures.length} 个用例`)
        for (const f of failures) console.log(`   - ${f}`)
        process.exit(1)
    }
}

main().catch(err => {
    console.error('[harness] 未捕获异常：', err)
    process.exit(1)
})

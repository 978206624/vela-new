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

// ===== 3. 渲染层侧 =====

import { useWorkflowStore } from '../../src/stores/workflow-store'
import { useProjectStore } from '../../src/stores/project-store'
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
function stubLLM(responses: string[], opts: { failAt?: number; afterCall?: (n: number) => void } = {}): {
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
                if (opts.failAt !== undefined && state.calls === opts.failAt) {
                    callbacks.onError('模拟的模型调用失败')
                    return
                }
                const text = responses[idx] ?? '{}'
                // 切成两段推，验证 streamChunkMode 的触发时机
                callbacks.onChunk(text.slice(0, Math.floor(text.length / 2)))
                callbacks.onChunk(text.slice(Math.floor(text.length / 2)))
                callbacks.onDone(text, { promptTokens: 10, completionTokens: 20, totalTokens: 30 })
                // 模拟「第 N 次调用**结束之后**、下一次发起之前」用户切了项目。
                // 必须挂在 onDone 之后：挂在调用内部就已经晚了，那时守卫早已放行
                opts.afterCall?.(state.calls)
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
        case 'db:blueprint-upsert-many':
            BlueprintRepository.upsertMany(args[0] as never)
            return { success: true }
        case 'db:character-get-all':
            return []
        // 保存蓝图那步会调 refreshFileTree() 刷侧边栏资产树。harness 不关心文件树，
        // 返回空目录即可——但**必须显式路由**，未知通道会直接抛错炸掉整个 harness
        case 'fs:list-dir':
            return []
        // 正文上下文拼装（buildChapterContext）会用到的只读通道。
        // 本 harness 只验证卷罗盘那一段，其余给最小可用返回值即可
        case 'fs:read-file':
            return { success: false, content: '' }
        case 'db:draft-get-finalized':
            return null
        case 'db:draft-get-full':
            return null
        case 'kb:search':
            return []
        case 'db:project-core-get': {
            const row = getProjectDb()!.prepare(`SELECT * FROM project_core WHERE id='main'`).get() as Record<string, string>
            return { premise: row.premise, worldbuilding: row.worldbuilding, charactersArch: row.characters_arch, synopsis: row.synopsis }
        }
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

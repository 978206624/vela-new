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
import { VolumeRepository } from '../../electron/repositories/volume-repository'
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
        case 'db:character-get-all':
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

/**
 * volume-regen-harness — 「重新生成本卷大纲」的 UI-less 运行时证据（Phase 19 / Task 19.4 T3）
 *
 * 与 `volume-workflow-harness` 的分工：那边验的是「续写下一卷」四步工作流的
 * 编排（盘点 → 提炼 → 生成 → 确认）。本文件验的是**单次 LLM 调用**的
 * 「重新生成本卷大纲」路径：
 *
 * ① partial-json 提取器在各种半截 JSON 形态下的稳健性（含教学意义的反例）
 * ② 工作流的第 1 步：**不重新提炼**上一卷收束状态、直接读库里已落库的那份
 * ③ 工作流的第 1 步：发起时冻结的章号边界与库里读回来的不一致 → 中止
 * ④ 「停止生成」= `cancelWorkflow` 中断在途的 LLM 流 → 产物未生成、表单不变
 * ⑤ 成功路径：单次 LLM 调用、产物落入 `volume-draft-store`、库零改动
 * ⑥ 「dirty 时拒绝发起」前置校验
 * ⑦ `validateVolumeRangeForRegen` 的四档区间（合法 / 太长 / 反向 / 起点 <1）
 *
 * `npm run harness:volume-regen` 跑这份脚本；退出码 0 = 全通过。
 *
 * ## 为什么走 IPC 路由
 *
 * 与 volume-workflow-harness 同样的理由：在 import 渲染层之前把 `window.velaAPI`
 * 接到真实仓储——于是断言的是真库里那一行，不是 mock。LLM 用 `useLLMStore.generateStream`
 * 桩函数取代。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ===== 1. window 垫片（必须在任何渲染层 import 之前） =====

const ipcLog: Array<{ channel: string; args: unknown[] }> = []
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

// ===== 2. 主进程侧 =====

import { initProjectDatabase, closeProjectDatabase, getProjectDb } from '../../electron/database'
import { VolumeRepository } from '../../electron/repositories/volume-repository'
import { BlueprintRepository } from '../../electron/repositories/blueprint-repository'
import { DraftRepository } from '../../electron/repositories/draft-repository'

// ===== 3. 渲染层侧 =====

import { useWorkflowStore } from '../../src/stores/workflow-store'
import { useProjectStore } from '../../src/stores/project-store'
import { useLLMStore } from '../../src/stores/llm-store'
import { useVolumeStore } from '../../src/stores/volume-store'
import { useVolumeDraftStore } from '../../src/stores/volume-draft-store'
import {
    useVolumeRegenStore,
    discardVolumeRegenResultForTab,
    selectRegenResultFor,
} from '../../src/stores/volume-regen-store'
import { extractPartialJSONString } from '../../src/shared/partial-json'
import {
    findActiveRegenRunId,
    validateVolumeRangeForRegen,
    VOLUME_REGEN_WORKFLOW_TYPE,
} from '../../src/services/workflows/volume-regen-workflow'
import {
    startVolumeSynopsisRegen,
    stopVolumeSynopsisRegen,
    invalidateVolumeRegen,
    describeRegenOutcome,
} from '../../src/services/volume-regen'

// ===== 4. 断言 =====

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

function assertEq<T>(actual: T, expected: T, what?: string): void {
    const a = JSON.stringify(actual), e = JSON.stringify(expected)
    if (a !== e) throw new Error(`${what ?? '值不等'}\n       期望: ${e}\n       实际: ${a}`)
}

// 删掉：当前用例都用「跑完等不到就视为失败」的同步设计，没用到有界等待。
// 真要验「回归表现为挂住」的路径再去加（与 volume-workflow-harness 同款）。

/** 取某一卷当前的待显示结果（结果按 `projectToken:volumeNumber` 分槽，见 store 注释） */
function regenResultFor(volumeNumber: number) {
    return selectRegenResultFor(useVolumeRegenStore.getState(), currentToken, volumeNumber)
}

// ===== 5. 夹具 =====

let tmpRoot = ''
let dbSeq = 0
let currentToken = 1

function freshEnv(): void {
    closeProjectDatabase()
    const dir = path.join(tmpRoot, `p-${++dbSeq}`)
    fs.mkdirSync(dir, { recursive: true })
    initProjectDatabase(dir)
    const db = getProjectDb()!
    db.prepare(
        `INSERT INTO project_core (id, project_name, total_chapters, synopsis, premise) VALUES ('main','harness',0,'',?)`
    ).run('全书故事前提：北境少年卷入王朝更替。')
    // 播种蓝图覆盖 V1 (1–3) 与 V2 (4–10) 的整段区间，让两卷都能读到真实 notes
    for (let c = 1; c <= 10; c++) {
        db.prepare(`INSERT INTO blueprints (chapter_number, title, key_events, notes) VALUES (?,?,?,?)`)
            .run(c, `第${c}章`, `事件${c}`, `第${c}章要点：主角沈砚在第${c}章正式登场`)
    }
    ipcLog.length = 0
    currentToken += 1
    useProjectStore.setState({
        currentProject: {
            id: 'harness', name: 'harness', path: dir,
            novelConfig: { corePlot: '', coreOutline: '', totalChapters: 0, plotStructure: 'three_act' },
        },
        currentToken,
    } as never)
    useWorkflowStore.setState({ activeRuns: [], history: [], globalLogs: [], waitingRuns: {}, results: {} })
    useVolumeStore.setState({ volumes: [], status: 'ready' })
    useVolumeDraftStore.getState().reset()
    useVolumeRegenStore.getState().reset()
}

/** 替换 LLM：单次返回 `text`，模拟「编辑好后一刀切完」的形态。`onCall` 在 chunk 推送之后触发 */
function stubLLM(
    text: string,
    onCall?: () => void,
): { calls: number; prompts: string[]; partials: string[] } {
    const state = { calls: 0, prompts: [] as string[], partials: [] as string[] }
    useLLMStore.setState({
        defaultModelId: 'm1',
        models: [{ id: 'm1', name: 'claude-opus-5' }],
        getModelIdForPurpose: () => 'm1',
        cancelGeneration: async () => {},
        generateStream: async (
            messages: Array<{ role: string; content: string }>,
            callbacks: { onChunk: (c: string) => void; onDone: (t: string) => void; onError: (e: string) => void },
        ) => {
            state.calls++
            state.prompts.push(messages.map(m => m.content).join('\n'))
            // 异步：把推送延迟到下一轮，让发起方 await 的窗口里能截到中间态
            setTimeout(() => {
                // 切成两半推一次，验证 streamChunkMode:'every' 让每次都触发 onStreamChunk
                const half = Math.floor(text.length / 2)
                callbacks.onChunk(text.slice(0, half))
                state.partials.push(text.slice(0, half))
                callbacks.onChunk(text.slice(half))
                callbacks.onDone(text)
                onCall?.()
            }, 0)
            return 'req-1'
        },
    } as never)
    return state
}

/** 替换 LLM：把 `text` 切成 `pieces`，**每片之间留一帧**，方便测试「中途取消」 */
function stubLLMSliced(
    pieces: string[],
    onChunkAfterEach: () => void | Promise<void>,
): { calls: number } {
    const state = { calls: 0 }
    useLLMStore.setState({
        defaultModelId: 'm1',
        models: [{ id: 'm1', name: 'claude-opus-5' }],
        getModelIdForPurpose: () => 'm1',
        cancelGeneration: async () => {},
        generateStream: async (
            _messages: Array<{ role: string; content: string }>,
            callbacks: { onChunk: (c: string) => void; onDone: (t: string) => void; onError: (e: string) => void },
        ) => {
            state.calls++
            const full = pieces.join('')
            // 异步顺序推，每片之后留窗口让用户取消
            setTimeout(() => {
                void (async () => {
                    for (const p of pieces) {
                        callbacks.onChunk(p)
                        await onChunkAfterEach()
                    }
                    callbacks.onDone(full)
                })()
            }, 0)
            return 'req-1'
        },
    } as never)
    return state
}

/** 在库里播种两条卷 + 第 1 卷的 blueprints 已在 freshEnv 阶段种好（1–3 章） */
function seedTwoVolumes(): { firstEnd: number; secondStart: number } {
    // 蓝图 1–3 章 → 第一卷 1–3 章
    VolumeRepository.upsert({
        volumeNumber: 1, title: '第一卷', startChapter: 1, endChapter: 3,
        premise: '主角登场', synopsis: '旧大纲：凑合用',
        openingState: '', closingState: '主角已启程',
        openThreads: [], status: 'done',
    })
    // 第二卷 4–10 章，无蓝图，无 closingState（验上一卷无收束状态时也能跑）
    VolumeRepository.upsert({
        volumeNumber: 2, title: '第二卷', startChapter: 4, endChapter: 10,
        premise: '南下夺回失地',
        synopsis: '（旧大纲，将被重生成）',
        openingState: '主角已启程',
        closingState: '',
        openThreads: [],
        status: 'planned',
    })
    // 刷新 store
    useVolumeStore.setState({ volumes: VolumeRepository.getAll(), status: 'ready' })
    return { firstEnd: 3, secondStart: 4 }
}

/** 把数据库「业务表」快照成字符串。
 *
 *  刻意**不含** `llm_calls`——那条是模型调用的真实统计，本流程成功时会写一条，
 *  与「库零改动」是两件事：「库零改动」指的是 volumes / drafts / project_core 等
 *  用户看得见的业务表，统计是底层账本。断言「业务库零改动」必须排除它，否则
 *  把「写了一条统计」当成「库被改了」会让本流程**永远过不了**。 */
function snapshot(): string {
    const db = getProjectDb()!
    return JSON.stringify({
        volumes: db.prepare('SELECT * FROM volumes ORDER BY volume_number').all(),
        blueprints: db.prepare('SELECT * FROM blueprints ORDER BY chapter_number').all(),
        drafts: db.prepare('SELECT * FROM drafts ORDER BY id').all(),
        core: db.prepare('SELECT * FROM project_core').all(),
    })
}

// ===== 6. IPC 路由 =====

/**
 * 让 `db:blueprint-get-all` 抛错的开关，供 fail-closed 用例使用。
 *
 * 用开关而不是临时替换 `invokeHandler`：替换会让「本用例改坏了 handler、
 * 后面所有用例跟着挂」变成一种可能，而开关的作用域由 try/finally 保证归位。
 */
let blueprintGetAllShouldThrow = false

invokeHandler = async (channel, ...args) => {
    switch (channel) {
        case 'db:volume-get-all':
            return VolumeRepository.getAll()
        case 'db:blueprint-get-all':
            if (blueprintGetAllShouldThrow) throw new Error('模拟的数据库读取失败')
            return BlueprintRepository.getAll()
        case 'db:blueprint-get':
            return BlueprintRepository.getByChapter(args[0] as number)
        case 'db:draft-list-finalized-in-range':
            return DraftRepository.listFinalizedChaptersInRange(args[0] as number, args[1] as number)
        case 'db:project-core-get': {
            const row = getProjectDb()!.prepare(`SELECT * FROM project_core WHERE id='main'`).get() as Record<string, unknown>
            return {
                projectName: row.project_name, premise: row.premise,
                worldbuilding: row.worldbuilding, charactersArch: row.characters_arch,
                synopsis: row.synopsis, characterStates: row.character_states,
                revision: row.revision ?? 0,
            } as never
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

// ===== 7. 用例 =====

async function main(): Promise<void> {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-regen-harness-'))

    // ===== partial-json 提取器（纯函数，可独立验） =====

    await testCase('P1 还没出现 key → null（不是空串，避免 UI 先亮「输出中」再空等）', async () => {
        assertEq(extractPartialJSONString('{"something":"else"', 'synopsis'), null)
    })
    await testCase('P2 出现 key 但还没开引号 → null', async () => {
        assertEq(extractPartialJSONString('{"synopsis": ', 'synopsis'), null)
    })
    await testCase('P3 key 后是数字/null 而不是字符串 → null', async () => {
        assertEq(extractPartialJSONString('{"synopsis":42', 'synopsis'), null)
    })
    await testCase('P4 完整串（直接等于 JSON.parse 的结果）', async () => {
        const json = '{"synopsis":"南下的第一节：北风与旧伤","x":1}'
        assertEq(extractPartialJSONString(json, 'synopsis'), '南下的第一节：北风与旧伤')
    })
    await testCase('P5 流到一半：synopsis 字段已开引号但无内容', async () => {
        assertEq(extractPartialJSONString('{"synopsis":"', 'synopsis'), '')
    })
    await testCase('P6 流到一半：含转义 \\n', async () => {
        assertEq(extractPartialJSONString('{"synopsis":"第一幕\\n建置', 'synopsis'), '第一幕\n建置')
    })
    await testCase('P7 流到一半：含 \\uXXXX 完整转义', async () => {
        assertEq(extractPartialJSONString('{"synopsis":"角色\\u8c08', 'synopsis'), '角色谈')
    })
    await testCase('P8 半截转义 \\u12 → 丢弃该半截序列', async () => {
        // 流停在 \u12，下一段才会变 ሴ。提前吐 \u12 会让预览闪乱码
        assertEq(extractPartialJSONString('{"synopsis":"a\\u12', 'synopsis'), 'a')
    })
    await testCase('P9 半截转义 \\（尾部裸反斜杠）→ 丢弃', async () => {
        assertEq(extractPartialJSONString('{"synopsis":"a\\', 'synopsis'), 'a')
    })
    await testCase('P10 嵌套字段有同名 key 时取**第一处**（消费方是预览、不是落库）', async () => {
        // 设计取舍：真正的 JSON 解析器要维护栈，代价远大于收益。预览错了下一 chunk 就纠正
        const json = '{"meta":"keep","synopsis":"这是大纲","alias":{"synopsis":"不要用我"}}'
        assertEq(extractPartialJSONString(json, 'synopsis'), '这是大纲')
    })
    await testCase('P11 含中文标点与全角空格', async () => {
        assertEq(extractPartialJSONString('{"synopsis":"第1幕｜建置　　起点', 'synopsis'), '第1幕｜建置　　起点')
    })

    // UTF-16 代理对（Codex round-01 minor #3）
    //
    // ⚠️ 测试用例要绕开 JS 字面量转义：JS 解析阶段就把 `'\uD83D'` 当成单个
    // 高代理字符；真正要喂给 `extractPartialJSONString` 的是**字面六个 ASCII
    // 字符 `\uD83D`**——只能通过 `String.raw` 或拼接造出来。
    await testCase('P12 高代理项后跟完整低代理项 → 拼成 emoji', async () => {
        const raw = '{"synopsis":"a' + '\\uD83D\\uDE00' + 'b"}'
        assertEq(extractPartialJSONString(raw, 'synopsis'), 'a😀b')
    })
    await testCase('P13 流停在高代理项后面 → 不输出（防替换字符闪烁）', async () => {
        const raw = '{"synopsis":"a' + '\\uD83D' + '"'
        assertEq(extractPartialJSONString(raw, 'synopsis'), 'a')
    })
    await testCase('P14 流停在低代理项中间（孤立） → 不输出', async () => {
        // JSON 规范上孤立的低代理项非法，预览不该把它显示成替换字符
        const raw = '{"synopsis":"a' + '\\uDE00' + '"'
        assertEq(extractPartialJSONString(raw, 'synopsis'), 'a')
    })
    await testCase('P15 高代理项后跟非低代理项（如反斜杠 u）→ 暂不输出高代理项', async () => {
        const raw = '{"synopsis":"a' + '\\uD83D\\u0030' + '"'
        assertEq(extractPartialJSONString(raw, 'synopsis'), 'a')
    })
    await testCase('P16 高代理项后跟 4 位但不是低代理项 → 暂不输出', async () => {
        const raw = '{"synopsis":"a' + '\\uD83D' + '0"}'
        assertEq(extractPartialJSONString(raw, 'synopsis'), 'a')
    })

    // ===== 纯函数：validateVolumeRangeForRegen =====

    await testCase('R1 合法区间 1–10 → null', async () => {
        assertEq(validateVolumeRangeForRegen({ title: 'V', startChapter: 1, endChapter: 10 }), null)
    })
    await testCase('R2 反向区间 5–3 → 报错', async () => {
        const msg = validateVolumeRangeForRegen({ title: 'V', startChapter: 5, endChapter: 3 })
        assert(msg !== null && msg.includes('异常'), `应报错：${msg}`)
    })
    await testCase('R3 起点为 0 → 报错', async () => {
        const msg = validateVolumeRangeForRegen({ title: 'V', startChapter: 0, endChapter: 10 })
        assert(msg !== null && msg.includes('必须 ≥1'), `应报错：${msg}`)
    })
    await testCase('R4 超长 1–10001 → 报错', async () => {
        const msg = validateVolumeRangeForRegen({ title: 'V', startChapter: 1, endChapter: 10001 })
        assert(msg !== null && msg.includes('10000'), `应报错：${msg}`)
    })
    await testCase('R5 端点不是安全整数（1e21）→ 报错', async () => {
        // ⚠️ 夹具必须让**这一道**成为唯一能拦下它的守卫：
        // `1–1e21` 会先被「区间长度上限」拦住（span 超 10000），于是去掉安全整数
        // 那道也不转红——两道互为掩护。取 `start = end = 1e21`：span 恰为 1、
        // 起点也 ≥1，只剩安全整数这道能说话（硬教训「两道守卫重叠时给每道配专属夹具」）
        const msg = validateVolumeRangeForRegen({ title: 'V', startChapter: 1e21, endChapter: 1e21 })
        assert(msg !== null && msg.includes('可精确表示'), `应报错：${msg}`)
    })

    // ===== 服务层入口：纯状态机的判定 =====

    await testCase('S1 单卷模式 → dirty 校验先于 IPC、文本不会发到 LLM', async () => {
        freshEnv()
        // dirty：先给第 1 卷种上（要存在的卷）+ 一份草稿
        seedTwoVolumes()
        useVolumeDraftStore.getState().set(currentToken, 2, {
            title: '第二卷', startRaw: '4', endRaw: '10',
            status: 'planned', premise: '暂存', synopsis: '',
            openingState: '', threads: [], threadChapterInputs: {}, nextThreadId: 0,
            touched: ['premise'],
        })
        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 2)!
        const llm = stubLLM('{"synopsis":"不应到达"}')
        const res = await startVolumeSynopsisRegen(v, 0)
        assertEq(res.ok, false)
        assertEq(res.ok ? null : res.reason, 'dirty')
        assertEq(llm.calls, 0, 'dirty 时绝不该发起 LLM 调用')
        // store 没被开新 run
        assertEq(useVolumeRegenStore.getState().run, null)
        // 草稿原样保留
        const draft = useVolumeDraftStore.getState().get(currentToken, 2)
        assertEq(draft?.premise, '暂存')
    })

    await testCase('S2 表单干净 → 成功路径：单次 LLM 调用、草稿已落地、result 就位、业务库零改动', async () => {
        freshEnv()
        seedTwoVolumes()
        const before = snapshot()
        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 2)!
        const llm = stubLLM('{"synopsis":"新大纲：南下夺回失地，分三幕推进"}')
        const res = await startVolumeSynopsisRegen(v, 0)
        assertEq(res.ok, true)
        // 单次 LLM
        assertEq(llm.calls, 1, '重新生成只有一次 LLM 调用（不跑收卷提炼）')
        // service **先写草稿再 settle**：组件的判据是「草稿 synopsis 等于 result」，
        // 顺序反了会出现「result 已就位、草稿还没写」的一帧
        const draft = useVolumeDraftStore.getState().get(currentToken, 2)
        assertEq(draft?.synopsis, '新大纲：南下夺回失地，分三幕推进')
        assertEq(draft?.touched, ['synopsis'], '产物只有卷大纲一项，patch 里不该有别的列')
        // 非 synopsis 的列以卷行为基线，不被改
        assertEq(draft?.premise, '南下夺回失地')
        assertEq(draft?.title, '第二卷')
        // result 就位，且与草稿逐字相同（组件比对判据成立）
        const regenStore = useVolumeRegenStore.getState()
        assert(regenStore.run === null, 'run 已清空')
        const r = regenResultFor(2)
        assert(r !== null, 'result 已就位')
        assertEq(r.synopsis, draft?.synopsis, 'result 与草稿必须逐字相同，否则组件判据不成立')
        // ⚠️ 库的 volumes / blueprints 一字未动 —— 本流程完全不写业务库
        assertEq(snapshot(), before, '成功路径业务库零改动（待用户点保存才落）')
    })

    await testCase('S3 prompt 不含全书 synopsis（避免诱导 AI 收尾）', async () => {
        freshEnv()
        seedTwoVolumes()
        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 2)!
        const llm = stubLLM('{"synopsis":"新大纲"}')
        await startVolumeSynopsisRegen(v, 0)
        const prompt = llm.prompts[0]
        // prompt 里有本卷主线、章号区间、已写章节要点；不应含全书 synopsis 字段
        assert(prompt.includes('南下夺回失地'), 'prompt 应注入本卷主线（输入约束）')
        // ⚠️ 断言必须落在**要点正文**上，不能拿「第4章」当关键词——
        // 模板开头「本卷覆盖 第{{volume_start}}章 到 第{{volume_end}}章」本来就会渲染出
        // 「第4章」，拿它做判据的话，把要点整段抽掉都照样绿（变异检验替我抓出来的）
        assert(prompt.includes('要点：主角沈砚在第4章正式登场'),
            `prompt 应注入本卷已写章节要点正文（V2 区间 4–10）。实际片段：${prompt.slice(0, 600)}`)
        // ⚠️ 全书 synopsis 是个「已闭环文本」，不应注入（与续卷的命令同款硬约束）
        assert(!prompt.includes('【全书情节大纲】'), '不应注入全书情节大纲字段')
    })

    await testCase('S4 中途点「停止生成」 → 不产生结果、表单不变', async () => {
        freshEnv()
        seedTwoVolumes()
        const before = snapshot()
        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 2)!
        // 三段切片：「{」、「\"synopsis\":\"正在」、「写\"」
        // 每片之后**点停止**，让取消能跑在 LLM 调用未结束前
        let cancelFired = false
        stubLLMSliced(['{"synopsis":"正在', '写', '"更多内容'], () => {
            if (!cancelFired) {
                cancelFired = true
                stopVolumeSynopsisRegen()
            }
        })
        const res = await startVolumeSynopsisRegen(v, 0)
        assertEq(res.ok, false)
        assertEq(res.ok ? null : res.reason, 'failed')
        // 库零改动
        assertEq(snapshot(), before)
        // 没有产物
        const regenStore = useVolumeRegenStore.getState()
        assertEq(regenStore.run, null)
        assertEq(regenResultFor(2), null)
        // 没有草稿
        const draft = useVolumeDraftStore.getState().get(currentToken, 2)
        assertEq(draft, null)
    })

    await testCase('S5 区间预检：超长卷在工作流之前就被拒', async () => {
        freshEnv()
        // 不通过仓储层插入超长卷（仓储会拒），直接手写库行
        const db = getProjectDb()!
        db.prepare(`INSERT INTO volumes (volume_number, title, start_chapter, end_chapter, premise, synopsis, opening_state, closing_state, open_threads, status)
                   VALUES (1, '超长卷', 1, 10001, '', '', '', '', '[]', 'done')`).run()
        useVolumeStore.setState({ volumes: VolumeRepository.getAll(), status: 'ready' })
        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 1)!
        const llm = stubLLM('{"synopsis":"不应到达"}')
        const res = await startVolumeSynopsisRegen(v, 0)
        assertEq(res.ok, false)
        assertEq(res.ok ? null : res.reason, 'bad-range')
        assertEq(llm.calls, 0, '预检拒绝时绝不该发起 LLM')
    })

    await testCase('S6 adoptGeneratedSynopsis 在已有草稿时拒绝（Codex round-01 major 兜底）', async () => {
        freshEnv()
        seedTwoVolumes()
        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 2)!
        // 先种一份草稿（模拟用户期间改了别的字段）
        useVolumeDraftStore.getState().set(currentToken, 2, {
            title: '第二卷·手改', startRaw: '4', endRaw: '10',
            status: 'planned', premise: '用户手动改', synopsis: '',
            openingState: '', threads: [], threadChapterInputs: {}, nextThreadId: 0,
            touched: ['premise'],
        })
        const ok = useVolumeDraftStore.getState().adoptGeneratedSynopsis(currentToken, v, 'AI 大纲')
        assertEq(ok, false, '已有草稿时拒绝采纳，避免静默覆盖用户编辑')
        const draft = useVolumeDraftStore.getState().get(currentToken, 2)
        assertEq(draft?.premise, '用户手动改', '被拒绝时原草稿不动')
    })

    await testCase('S7 生成期间冒出草稿 → AI 稿作废、不覆盖用户编辑、也不 settle result', async () => {
        freshEnv()
        seedTwoVolumes()
        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 2)!
        // 在 LLM 流到一半时插一份草稿（模拟 UI 锁被绕开 / 别的入口写了草稿）
        stubLLMSliced(['{"synopsis":"新', '大纲"}'], () => {
            if (useVolumeDraftStore.getState().get(currentToken, 2) === null) {
                useVolumeDraftStore.getState().set(currentToken, 2, {
                    title: '第二卷', startRaw: '4', endRaw: '10',
                    status: 'planned', premise: '用户中途改的', synopsis: '',
                    openingState: '', threads: [], threadChapterInputs: {}, nextThreadId: 0,
                    touched: ['premise'],
                })
            }
        })
        const res = await startVolumeSynopsisRegen(v, 0)
        assertEq(res.ok, false, '有草稿冒出来时必须失败，不能静默覆盖')
        assertEq(res.ok ? null : res.reason, 'failed')
        // 用户的编辑原样保留
        const draft = useVolumeDraftStore.getState().get(currentToken, 2)
        assertEq(draft?.premise, '用户中途改的')
        assertEq(draft?.synopsis, '', 'AI 大纲没有覆盖进来')
        // 没有 result（组件不会显示「已重新生成」）
        assertEq(regenResultFor(2), null)
    })

    await testCase('S9 保存成功后 result 被清掉（完成态提示收掉），二次发起正常', async () => {
        freshEnv()
        seedTwoVolumes()
        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 2)!
        stubLLM('{"synopsis":"新大纲"}')
        const res1 = await startVolumeSynopsisRegen(v, 0)
        assertEq(res1.ok, true)
        const r = regenResultFor(2)
        assert(r !== null, 'service 成功后 result 必须非 null')
        // 模拟组件在保存成功后收掉提示
        assertEq(useVolumeRegenStore.getState().adoptResult(r.regenId), true)
        assertEq(regenResultFor(2), null)
        // 再用错的 regenId 调 → 不该清掉别人的
        assertEq(useVolumeRegenStore.getState().adoptResult(r.regenId), false, 'regenId 不匹配时不动 store')
        // 模拟用户点保存 → 草稿清空
        useVolumeDraftStore.getState().clear(currentToken, 2)
        // 二次发起应能照常工作
        stubLLM('{"synopsis":"第二份"}')
        const res2 = await startVolumeSynopsisRegen(v, 0)
        assertEq(res2.ok, true)
    })

    await testCase('S10 第 2 卷结果待保存 → 第 1 卷**完整生成成功** → 第 2 卷那份仍在（跨卷不丢稿）', async () => {
        // Codex round-03 major #1：结果曾是单槽，`begin()` 虽然不清它，
        // 但 `settle()` 会把整槽换掉——第 1 卷完成时第 2 卷那份就没了。
        // 故本用例必须跑到**成功结算**，只验 begin 之后那一瞬间等于没验
        freshEnv()
        seedTwoVolumes()
        const v1 = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 1)!
        const v2 = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 2)!

        // ① 第 2 卷生成一份，留着不保存
        stubLLM('{"synopsis":"第二卷的 AI 大纲"}')
        assertEq((await startVolumeSynopsisRegen(v2, 0)).ok, true)
        const kept = regenResultFor(2)
        assert(kept !== null && kept.synopsis === '第二卷的 AI 大纲', '第 2 卷结果应就位')

        // ② 第 1 卷走完整流程（含 settle 成功）
        stubLLM('{"synopsis":"第一卷的 AI 大纲"}')
        assertEq((await startVolumeSynopsisRegen(v1, 0)).ok, true)

        // ③ 两卷的结果必须**各在各的槽里**
        const r1 = regenResultFor(1)
        const r2 = regenResultFor(2)
        assert(r1 !== null && r1.synopsis === '第一卷的 AI 大纲', '第 1 卷结果应就位')
        assert(r2 !== null && r2.synopsis === '第二卷的 AI 大纲',
            '第 1 卷成功结算不得顶掉第 2 卷尚未保存的结果（round-03 major #1）')
        // 两条 regenId 不同（发号器不回退）
        assert(r1.regenId !== r2.regenId, '两次生成的 regenId 必须不同')
        // ④ 各卷的草稿也应各自独立
        assertEq(useVolumeDraftStore.getState().get(currentToken, 1)?.synopsis, '第一卷的 AI 大纲')
        assertEq(useVolumeDraftStore.getState().get(currentToken, 2)?.synopsis, '第二卷的 AI 大纲')
        // ⑤ 清掉第 1 卷那条，第 2 卷不受影响
        assertEq(useVolumeRegenStore.getState().adoptResult(r1.regenId), true)
        assertEq(regenResultFor(1), null)
        assert(regenResultFor(2) !== null, 'adoptResult 只该清掉指名的那一条')
    })

    await testCase('S12 本卷要点读取失败（IPC 抛错）→ 第 2 步就中止，一次模型都不调', async () => {
        // Codex round-03 major #3：宽容版 `readVolumeChapterNotes` 把读失败伪装成
        // 「暂无要点」，模型会当整卷空白重排，产出一份与已发布正文冲突、
        // 却能被保存的大纲。重生成路径必须 fail-closed
        freshEnv()
        seedTwoVolumes()
        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 2)!
        const llm = stubLLM('{"synopsis":"不应到达"}')
        // 只让 `db:blueprint-get-all` 炸，其它通道照常
        blueprintGetAllShouldThrow = true
        try {
            const res = await startVolumeSynopsisRegen(v, 0)
            assertEq(res.ok, false, '读要点失败必须整体失败，不能带着「暂无要点」继续生成')
            assertEq(res.ok ? null : res.reason, 'failed')
            assertEq(llm.calls, 0, 'fail-closed：一次模型调用都不该发起')
            // 无草稿、无结果
            assertEq(useVolumeDraftStore.getState().get(currentToken, 2), null)
            assertEq(regenResultFor(2), null)
        } finally {
            blueprintGetAllShouldThrow = false
        }
    })

    await testCase('S13 宽容版 readVolumeChapterNotes 仍然回落（续卷那条路径不受影响）', async () => {
        // 严格版是新加的**第二个**导出，不能顺手把宽容版也改成抛错——
        // 续卷读的是上一卷的要点，那一卷已写完、大纲是新建的，缺要点只是质量差一点
        freshEnv()
        const { readVolumeChapterNotes } = await import('../../src/services/prompts/volume-context')
        blueprintGetAllShouldThrow = true
        try {
            assertEq(await readVolumeChapterNotes(1, 10), '（该卷暂无章节要点）',
                '宽容版必须保持回落语义，供续卷等可降级路径使用')
        } finally {
            blueprintGetAllShouldThrow = false
        }
    })

    await testCase('S14 已定稿但 notes 为空 → LLM 之前就拦下（事实不完整不能生成）', async () => {
        // Codex round-04 major：定稿流程是「先写 finalized，再跑可能失败的 notes 后处理」，
        // 「已定稿但 notes 为空」是实际可达的故障态。那几章的正文读者已经看过，
        // 模型却看不到，会当空白重排
        freshEnv()
        seedTwoVolumes()
        const db = getProjectDb()!
        // 第 5 章定稿（落在 V2 的 4–10 区间内），但把它的 notes 清空
        const info = db.prepare(`INSERT INTO contents (body) VALUES ('第 5 章正文')`).run()
        db.prepare(
            `INSERT INTO drafts (chapter_number, version, status, content_id, word_count) VALUES (5,1,'finalized',?,100)`
        ).run(info.lastInsertRowid)
        db.prepare(`UPDATE blueprints SET notes = '' WHERE chapter_number = 5`).run()

        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 2)!
        const llm = stubLLM('{"synopsis":"不应到达"}')
        const res = await startVolumeSynopsisRegen(v, 0)
        assertEq(res.ok, false, '事实不完整必须拦下')
        assertEq(res.ok ? null : res.reason, 'failed')
        assertEq(llm.calls, 0, 'fail-closed：一次模型调用都不该发起')
        // 错误信息要点名是哪几章，否则用户不知道去修哪里
        const logs = useWorkflowStore.getState().globalLogs.map(l => l.message).join(' | ')
        assert(logs.includes('第 5') && logs.includes('没有章节要点'),
            `错误信息应点名缺要点的章号。实际日志：${logs}`)
        assertEq(useVolumeDraftStore.getState().get(currentToken, 2), null)
        assertEq(regenResultFor(2), null)
    })

    await testCase('S15 无蓝图但已定稿的章也算「已写」（只看蓝图会漏掉它）', async () => {
        // 遍历定稿清单而不是蓝图列表：无蓝图却已定稿的章同样是既成事实
        freshEnv()
        seedTwoVolumes()
        const db = getProjectDb()!
        // 第 20 章根本没有蓝图。先把 V2 边界扩到 20 让它落进区间
        VolumeRepository.upsert({
            volumeNumber: 2, title: '第二卷', startChapter: 4, endChapter: 20,
            premise: '南下夺回失地', synopsis: '（旧大纲，将被重生成）',
            openingState: '主角已启程', closingState: '', openThreads: [], status: 'planned',
        })
        useVolumeStore.setState({ volumes: VolumeRepository.getAll(), status: 'ready' })
        const info = db.prepare(`INSERT INTO contents (body) VALUES ('第 20 章正文')`).run()
        db.prepare(
            `INSERT INTO drafts (chapter_number, version, status, content_id, word_count) VALUES (20,1,'finalized',?,100)`
        ).run(info.lastInsertRowid)

        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 2)!
        const llm = stubLLM('{"synopsis":"不应到达"}')
        const res = await startVolumeSynopsisRegen(v, 0)
        assertEq(res.ok, false, '无蓝图但已定稿的章同样要拦')
        assertEq(llm.calls, 0)
        const logs = useWorkflowStore.getState().globalLogs.map(l => l.message).join(' | ')
        assert(logs.includes('第 20'), `应点名第 20 章。实际日志：${logs}`)
    })

    await testCase('S16 生成期间 notes 被改（另一条定稿流水线写入）→ 大纲作废，不落草稿', async () => {
        // Codex round-04 major：重生成跨一次分钟级 LLM 调用，期间用户完全可以定稿一章、
        // 后处理随即写入新 notes。那份按旧事实生成的大纲不能落地
        freshEnv()
        seedTwoVolumes()
        const before = snapshot()
        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 2)!
        let mutated = false
        stubLLMSliced(['{"synopsis":"按旧', '事实生成的大纲"}'], () => {
            if (!mutated) {
                mutated = true
                // 模拟另一条流水线更新了本卷某章的要点
                getProjectDb()!.prepare(
                    `UPDATE blueprints SET notes = '第5章要点：剧情已改道' WHERE chapter_number = 5`
                ).run()
            }
        })
        const res = await startVolumeSynopsisRegen(v, 0)
        assertEq(res.ok, false, '事实变了这份大纲必须作废')
        assertEq(res.ok ? null : res.reason, 'failed')
        const logs = useWorkflowStore.getState().globalLogs.map(l => l.message).join(' | ')
        assert(logs.includes('章节要点发生了变化'), `应说明作废原因。实际日志：${logs}`)
        // 不落草稿、不产生结果
        assertEq(useVolumeDraftStore.getState().get(currentToken, 2), null)
        assertEq(regenResultFor(2), null)
        // 唯一的库改动是那条 UPDATE（本用例自己造的），volumes 不动
        const after = JSON.parse(snapshot()) as Record<string, unknown>
        assertEq(after.volumes, JSON.parse(before).volumes, '卷表不该被这次失败的生成碰到')
    })

    await testCase('S17 事实未变（notes 原样）→ 复核放行，正常落草稿', async () => {
        // S16 的对照组：证明那道复核不是「只要跑过就红」，而是真的在比对
        freshEnv()
        seedTwoVolumes()
        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 2)!
        let touched = false
        stubLLMSliced(['{"synopsis":"新', '大纲"}'], () => {
            if (!touched) {
                touched = true
                // 写回**同样的值**：digest 不变，复核应放行
                getProjectDb()!.prepare(
                    `UPDATE blueprints SET notes = '第5章要点：主角沈砚在第5章正式登场' WHERE chapter_number = 5`
                ).run()
            }
        })
        const res = await startVolumeSynopsisRegen(v, 0)
        assertEq(res.ok, true, '事实没变就该放行（否则那道复核等于恒红）')
        assertEq(useVolumeDraftStore.getState().get(currentToken, 2)?.synopsis, '新大纲')
    })

    await testCase('S18 结果归属键带 projectToken：切项目后旧结果不再可见', async () => {
        // 归属键必须带 token（与 volume-draft-store 的 draftKey 同款）：
        // 只用卷序号的话，A 项目第 2 卷的待显示结果会在打开 B 项目时冒出来。
        // ⚠️ 这里刻意**不调 reset()** —— reset 会把 results 清空，那样无论键里
        // 有没有 token 都看不见旧结果，等于什么都没验
        freshEnv()
        seedTwoVolumes()
        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 2)!
        stubLLM('{"synopsis":"A 项目的大纲"}')
        await startVolumeSynopsisRegen(v, 0)
        assert(regenResultFor(2) !== null, 'A 项目下应看得到结果')
        // 模拟切到另一个项目：token 递增，但 store 没被 reset
        const tokenA = currentToken
        currentToken += 1
        useProjectStore.setState({ currentToken } as never)
        assertEq(regenResultFor(2), null, '换了 token 之后旧结果不该再被本卷读到')
        // 切回去还能看到（证明它只是被归属隔开，不是被清掉了）
        currentToken = tokenA
        useProjectStore.setState({ currentToken } as never)
        assert(regenResultFor(2) !== null, '切回原 token 应重新可见')
    })

    await testCase('S19 发起时的边界与库里不一致 → 中止（store 快照过期的那种情形）', async () => {
        // 边界复核的被测点：`boundaryAtStart` 是点击那一刻从界面复制的值，
        // 工作流第 1 步读的是**库里**那一行。二者不一致说明期间有人改过边界，
        // 按另一个区间生成出来的大纲会静默错位
        freshEnv()
        seedTwoVolumes()
        // 让 store 里的第 2 卷比库里"宽"：库是 4–10，store 说 4–8
        const stale = useVolumeStore.getState().volumes.map(v =>
            v.volumeNumber === 2 ? { ...v, endChapter: 8 } : v)
        useVolumeStore.setState({ volumes: stale, status: 'ready' })
        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 2)!
        const llm = stubLLM('{"synopsis":"不应到达"}')
        const res = await startVolumeSynopsisRegen(v, 0)
        assertEq(res.ok, false, '边界不一致必须中止')
        assertEq(llm.calls, 0, '边界复核在第 1 步，LLM 一次都不该调')
        const logs = useWorkflowStore.getState().globalLogs.map(l => l.message).join(' | ')
        assert(logs.includes('章号区间已变更'), `应说明是边界变更导致中止。实际日志：${logs}`)
    })

    await testCase('S20 卷号有缺口（V1、V3）→ 上一卷取 V1，不是「卷号-1」', async () => {
        // 卷序号允许有缺口（中间卷被删过）。写成 `volumeNumber - 1` 会找不到 V2、
        // 被误判成「本卷是第一卷」，于是真正的上一卷收束状态整段丢失
        freshEnv()
        VolumeRepository.upsert({
            volumeNumber: 1, title: '第一卷', startChapter: 1, endChapter: 3,
            premise: '起于北境', synopsis: '卷一大纲', openingState: '',
            closingState: '第一卷收束：主角已夺下雁门镇', openThreads: [], status: 'done',
        })
        VolumeRepository.upsert({
            volumeNumber: 3, title: '第三卷', startChapter: 4, endChapter: 10,
            premise: '南下', synopsis: '旧大纲', openingState: '承接雁门',
            closingState: '', openThreads: [], status: 'planned',
        })
        useVolumeStore.setState({ volumes: VolumeRepository.getAll(), status: 'ready' })
        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 3)!
        const llm = stubLLM('{"synopsis":"新大纲"}')
        assertEq((await startVolumeSynopsisRegen(v, 0)).ok, true)
        const prompt = llm.prompts[0]
        assert(prompt.includes('主角已夺下雁门镇'),
            `第三卷的上一卷应是第一卷（卷号有缺口）。实际片段：${prompt.slice(0, 600)}`)
        assert(!prompt.includes('没有上一卷；请以全书故事前提为起点'),
            `第三卷不得被当成首卷。实际片段：${prompt.slice(0, 600)}`)
    })

    await testCase('S21 目标卷在库里已不存在（store 还留着）→ 中止，不拿 undefined 往下跑', async () => {
        freshEnv()
        seedTwoVolumes()
        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 2)!
        // 库里删掉，但 store 仍持有——模拟别处刚删完、刷新还没到
        getProjectDb()!.prepare(`DELETE FROM volumes WHERE volume_number = 2`).run()
        const llm = stubLLM('{"synopsis":"不应到达"}')
        const res = await startVolumeSynopsisRegen(v, 0)
        assertEq(res.ok, false, '卷已不存在必须中止')
        assertEq(llm.calls, 0)
        const logs = useWorkflowStore.getState().globalLogs.map(l => l.message).join(' | ')
        assert(logs.includes('已不存在'), `应说明卷已不存在。实际日志：${logs}`)
    })

    await testCase('S22 流式预览拿到的是**解转义后的大纲正文**，不是原始 JSON 串', async () => {
        // 设计稿 30 的大纲区是给用户看的。把原始 JSON 串（含 `{"synopsis":"` 与
        // 转义符）直接灌进去，用户看到的是一坨代码
        freshEnv()
        seedTwoVolumes()
        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 2)!
        const seen: string[] = []
        stubLLMSliced(['{"synopsis":"第一幕\\n建置', '：北风与旧伤"}'], () => {
            const run = useVolumeRegenStore.getState().run
            if (run) seen.push(run.partial)
        })
        assertEq((await startVolumeSynopsisRegen(v, 0)).ok, true)
        assert(seen.length > 0, '生成期间应有流式片段写进 store')
        const first = seen[0]
        assert(!first.includes('{"synopsis"'),
            `预览片段不该含原始 JSON 结构。实际：${JSON.stringify(first)}`)
        assert(!first.includes('\\n'),
            `预览片段里的转义符应已解开。实际：${JSON.stringify(first)}`)
        assert(first.startsWith('第一幕'),
            `预览片段应是大纲正文。实际：${JSON.stringify(first)}`)
    })

    await testCase('S23 模型返回空 synopsis → 判失败，不把空大纲落成草稿', async () => {
        freshEnv()
        seedTwoVolumes()
        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 2)!
        stubLLM('{"synopsis":"   "}')
        const res = await startVolumeSynopsisRegen(v, 0)
        assertEq(res.ok, false, '空大纲必须判失败')
        const logs = useWorkflowStore.getState().globalLogs.map(l => l.message).join(' | ')
        assert(logs.includes('未返回有效的卷大纲'), `应说明产物无效。实际日志：${logs}`)
        assertEq(useVolumeDraftStore.getState().get(currentToken, 2), null, '空大纲不该落草稿')
        assertEq(regenResultFor(2), null)
    })

    await testCase('S24 发起本身抛异常（同项目）→ 报 failed，不能误判成 stale', async () => {
        // `catch` 分支里若先 `settleFailed()` 再判归属，`stillMine()` 看到的 run
        // 已被清掉、永远返回 false，同项目内的真实异常会被静默吞成 stale
        freshEnv()
        seedTwoVolumes()
        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 2)!
        const realStart = useWorkflowStore.getState().startWorkflow
        useWorkflowStore.setState({
            startWorkflow: async () => { throw new Error('模拟的发起失败') },
        } as never)
        try {
            const res = await startVolumeSynopsisRegen(v, 0)
            assertEq(res.ok, false, '发起抛异常应判失败')
            assertEq(res.ok ? null : res.reason, 'failed',
                '同项目内的真实异常必须报 failed，不能误判成 stale（stale 会被静默吞掉）')
            assert(!res.ok && res.message.includes('模拟的发起失败'),
                `错误信息应带上原因。实际：${res.ok ? '' : res.message}`)
        } finally {
            useWorkflowStore.setState({ startWorkflow: realStart } as never)
        }
    })

    await testCase('S25 生成后复核读失败 → 中止（读不到就不能断言「事实没变」）', async () => {
        // 与 S12 的区别：S12 是**第 2 步**读失败，本例是第 2 步成功、
        // **第 4 步复核**时才失败。复核同样是 fail-closed
        freshEnv()
        seedTwoVolumes()
        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 2)!
        let armed = false
        stubLLMSliced(['{"synopsis":"新', '大纲"}'], () => {
            if (!armed) {
                armed = true
                // 第 2 步已经读完，让第 4 步的复核读失败
                blueprintGetAllShouldThrow = true
            }
        })
        try {
            const res = await startVolumeSynopsisRegen(v, 0)
            assertEq(res.ok, false, '复核读失败必须中止')
            const logs = useWorkflowStore.getState().globalLogs.map(l => l.message).join(' | ')
            assert(logs.includes('复核本卷已写事实失败'), `应说明是复核失败。实际日志：${logs}`)
            assertEq(useVolumeDraftStore.getState().get(currentToken, 2), null)
            assertEq(regenResultFor(2), null)
        } finally {
            blueprintGetAllShouldThrow = false
        }
    })

    await testCase('S26 生成期间某章变成「已定稿但无要点」→ 后置复核作废（digest 不变也要拦）', async () => {
        // Codex round-05 major #1：digest 只由「章号 + notes」构成。
        // 「某章刚变成 finalized、notes 仍为空」不改动任何 notes → digest 一模一样，
        // 只比 digest 就放行了，而那一章的正文读者已经看过
        freshEnv()
        seedTwoVolumes()
        const db = getProjectDb()!
        // 第 6 章：有蓝图但 notes 为空，尚未定稿（发起时不触发前置检查）
        db.prepare(`UPDATE blueprints SET notes = '' WHERE chapter_number = 6`).run()
        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 2)!
        let armed = false
        stubLLMSliced(['{"synopsis":"新', '大纲"}'], () => {
            if (!armed) {
                armed = true
                // 生成期间它被定稿了，后处理还没写要点
                const info = db.prepare(`INSERT INTO contents (body) VALUES ('第 6 章正文')`).run()
                db.prepare(
                    `INSERT INTO drafts (chapter_number, version, status, content_id, word_count) VALUES (6,1,'finalized',?,100)`
                ).run(info.lastInsertRowid)
            }
        })
        const res = await startVolumeSynopsisRegen(v, 0)
        assertEq(res.ok, false, '生成期间新增「已定稿但无要点」必须作废这份大纲')
        const logs = useWorkflowStore.getState().globalLogs.map(l => l.message).join(' | ')
        assert(logs.includes('变成了已定稿但还没有章节要点'),
            `应说明是后置完整性复核拦下的。实际日志：${logs}`)
        assertEq(useVolumeDraftStore.getState().get(currentToken, 2), null)
        assertEq(regenResultFor(2), null)
    })

    await testCase('S27 要点早于本次定稿（重新定稿后新要点未写）→ LLM 之前就拦下', async () => {
        // Codex round-05 major #2：Phase 14 允许改已定稿章节，而 finalizeExclusive
        // 不清 blueprints.notes。新版后处理跑完之前，旧要点会冒充当前事实
        freshEnv()
        seedTwoVolumes()
        const db = getProjectDb()!
        // 第 5 章：要点写于 2026-01-01，定稿于 2026-06-01 → 要点属于上一版
        db.prepare(
            `UPDATE blueprints SET notes = '第5章要点：上一版的剧情', notes_updated_at = '2026-01-01 00:00:00' WHERE chapter_number = 5`
        ).run()
        const info = db.prepare(`INSERT INTO contents (body) VALUES ('第 5 章新版正文')`).run()
        db.prepare(
            `INSERT INTO drafts (chapter_number, version, status, content_id, word_count, updated_at)
             VALUES (5,2,'finalized',?,100,'2026-06-01 00:00:00')`
        ).run(info.lastInsertRowid)

        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 2)!
        const llm = stubLLM('{"synopsis":"不应到达"}')
        const res = await startVolumeSynopsisRegen(v, 0)
        assertEq(res.ok, false, '要点属于上一版必须拦下')
        assertEq(llm.calls, 0, 'fail-closed：一次模型调用都不该发起')
        const logs = useWorkflowStore.getState().globalLogs.map(l => l.message).join(' | ')
        assert(logs.includes('早于它最近一次定稿'), `应说明要点属于上一版。实际日志：${logs}`)
    })

    await testCase('S28 要点与定稿**同一秒**（后处理紧接着跑完）→ 放行，不判过期', async () => {
        // S27 的对照组，且刻意取**相等**这一格：两个时间戳都是 SQLite 的
        // `datetime('now')`，秒级精度，定稿后处理在同一秒内写完要点是常见情形。
        // 判据写成 `<=` 就会把这种正常情况判成过期（「空输入那一格必须单独试」的同款教训）
        freshEnv()
        seedTwoVolumes()
        const db = getProjectDb()!
        db.prepare(
            `UPDATE blueprints SET notes = '第5章要点：当前版剧情', notes_updated_at = '2026-06-01 00:00:00' WHERE chapter_number = 5`
        ).run()
        const info = db.prepare(`INSERT INTO contents (body) VALUES ('第 5 章正文')`).run()
        db.prepare(
            `INSERT INTO drafts (chapter_number, version, status, content_id, word_count, updated_at)
             VALUES (5,2,'finalized',?,100,'2026-06-01 00:00:00')`
        ).run(info.lastInsertRowid)

        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 2)!
        stubLLM('{"synopsis":"新大纲"}')
        assertEq((await startVolumeSynopsisRegen(v, 0)).ok, true, '要点晚于定稿应放行')
    })

    await testCase('S28b 要点严格晚于定稿 → 放行', async () => {
        freshEnv()
        seedTwoVolumes()
        const db = getProjectDb()!
        db.prepare(
            `UPDATE blueprints SET notes = '第5章要点：当前版剧情', notes_updated_at = '2026-06-01 00:00:10' WHERE chapter_number = 5`
        ).run()
        const info = db.prepare(`INSERT INTO contents (body) VALUES ('第 5 章正文')`).run()
        db.prepare(
            `INSERT INTO drafts (chapter_number, version, status, content_id, word_count, updated_at)
             VALUES (5,2,'finalized',?,100,'2026-06-01 00:00:00')`
        ).run(info.lastInsertRowid)

        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 2)!
        stubLLM('{"synopsis":"新大纲"}')
        assertEq((await startVolumeSynopsisRegen(v, 0)).ok, true, '要点晚于定稿应放行')
    })

    await testCase('S29 手写要点（notes_updated_at 为空）→ 不判过期，照常放行', async () => {
        // 「证明不了新鲜」≠「过期」。用户可以在章节蓝图界面手写要点，
        // 那条路径（db:blueprint-upsert）不写 notes_updated_at。
        // 把空值也算成过期，会让所有手写过要点的项目再也用不了重新生成
        freshEnv()
        seedTwoVolumes()
        const db = getProjectDb()!
        db.prepare(
            `UPDATE blueprints SET notes = '第5章要点：作者手写', notes_updated_at = '' WHERE chapter_number = 5`
        ).run()
        const info = db.prepare(`INSERT INTO contents (body) VALUES ('第 5 章正文')`).run()
        db.prepare(
            `INSERT INTO drafts (chapter_number, version, status, content_id, word_count, updated_at)
             VALUES (5,1,'finalized',?,100,'2026-06-01 00:00:00')`
        ).run(info.lastInsertRowid)

        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 2)!
        stubLLM('{"synopsis":"新大纲"}')
        assertEq((await startVolumeSynopsisRegen(v, 0)).ok, true,
            '手写要点（无时间戳）不该被判成过期')
    })

    await testCase('S11 discardVolumeRegenResultForTab：关闭卷 Tab 清掉它的待显示结果', async () => {
        freshEnv()
        seedTwoVolumes()
        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 2)!
        stubLLM('{"synopsis":"AI 大纲"}')
        await startVolumeSynopsisRegen(v, 0)
        assert(regenResultFor(2) !== null, '生成成功后 result 应就位')
        // 别的卷的 tabId 不该动它
        discardVolumeRegenResultForTab('volume:3', currentToken)
        assert(regenResultFor(2) !== null, '别卷的 tabId 不该清掉本卷结果')
        // 非卷 tabId 同样不动
        discardVolumeRegenResultForTab('chapter:12', currentToken)
        assert(regenResultFor(2) !== null, '非卷 tabId 不该清')
        // 正确的 tabId 才清
        discardVolumeRegenResultForTab('volume:2', currentToken)
        assertEq(regenResultFor(2), null, '关闭本卷 Tab 应清掉结果，避免重开后复活')
    })

    // ===== 工作流层 =====

    await testCase('W1 上一卷无 closingState（已清空）→ 不算错，但日志如实报出', async () => {
        freshEnv()
        seedTwoVolumes()
        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 2)!
        // 把 V1 的 closingState 清成 ''
        getProjectDb()!.prepare(`UPDATE volumes SET closing_state = '' WHERE volume_number = 1`).run()
        useVolumeStore.setState({ volumes: VolumeRepository.getAll(), status: 'ready' })
        stubLLM('{"synopsis":"新大纲"}')
        const res = await startVolumeSynopsisRegen(v, 0)
        assertEq(res.ok, true, '无 closingState 不是错误，照常生成')
        // 工作流日志含「无收束状态记录」
        const logs = useWorkflowStore.getState().globalLogs.map(l => l.message).join(' | ')
        assert(logs.includes('无收束状态') || logs.includes('尚未记录收卷状态'),
            `日志应明示收卷状态缺失：${logs}`)
    })

    await testCase('W1b 上一卷存在但无 closingState → prompt 里**不得**说「本卷是第一卷」', async () => {
        // Codex round-02 major #4：两种状态都压成空串时，第五卷也会被告知
        // 「本卷是第一卷，没有上一卷」——一句明确的错误事实，模型会从零起笔
        freshEnv()
        seedTwoVolumes()
        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 2)!
        getProjectDb()!.prepare(`UPDATE volumes SET closing_state = '' WHERE volume_number = 1`).run()
        useVolumeStore.setState({ volumes: VolumeRepository.getAll(), status: 'ready' })
        const llm = stubLLM('{"synopsis":"新大纲"}')
        await startVolumeSynopsisRegen(v, 0)
        const prompt = llm.prompts[0]
        // ⚠️ 断言必须落在**注入的那一段**上，不能拿「本卷是第一卷」当关键词——
        // 模板的推演守则第 4 条里本来就有「没有上一卷时（本卷是第一卷）」这句
        // 条件性指导，它无条件存在，拿它做判据会永远命中、变成假红。
        // 用回退文案独有的尾巴（「没有上一卷；请以全书故事前提为起点」）来分辨
        assert(!prompt.includes('没有上一卷；请以全书故事前提为起点'),
            `第二卷不得注入首卷回退文案。实际片段：${prompt.slice(0, 600)}`)
        assert(prompt.includes('尚未记录收卷状态'),
            `应如实说明上一卷没记收卷状态。实际片段：${prompt.slice(0, 600)}`)
    })

    await testCase('W1c 真的没有上一卷（首卷）→ 注入首卷回退文案', async () => {
        freshEnv()
        VolumeRepository.upsert({
            volumeNumber: 1, title: '第一卷', startChapter: 1, endChapter: 3,
            premise: '首发', synopsis: '旧大纲', openingState: '', closingState: '',
            openThreads: [], status: 'writing',
        })
        useVolumeStore.setState({ volumes: VolumeRepository.getAll(), status: 'ready' })
        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 1)!
        const llm = stubLLM('{"synopsis":"新大纲"}')
        await startVolumeSynopsisRegen(v, 0)
        const prompt = llm.prompts[0]
        assert(prompt.includes('没有上一卷；请以全书故事前提为起点'),
            `首卷应注入首卷回退文案。实际片段：${prompt.slice(0, 600)}`)
        assert(!prompt.includes('尚未记录收卷状态'),
            `首卷不该说「上一卷尚未记录收卷状态」——它根本没有上一卷。实际片段：${prompt.slice(0, 600)}`)
    })

    await testCase('W2 上一卷收卷状态直接读库、不重新提炼 → 只有一次 LLM 调用', async () => {
        freshEnv()
        seedTwoVolumes()
        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 2)!
        const llm = stubLLM('{"synopsis":"新大纲"}')
        await startVolumeSynopsisRegen(v, 0)
        // 关键判定：续卷路径是 2 次（提取 + 生成），重生路径必须是 1 次
        assertEq(llm.calls, 1)
        // prompt 里**没有**「未回收伏笔 / openThreads」字段名（那是收卷提炼的产物）
        // ——重生路径不应触发收卷提炼
        const prompt = llm.prompts[0]
        assert(!prompt.includes('openThreads'),
            '重生路径不应跑收卷提炼、prompt 里不应含该字段')
    })

    await testCase('W3 第一卷（无上一卷）→ 跳过第 1 步的「上一卷」部分', async () => {
        freshEnv()
        // 单卷：第一卷 1–3 章
        VolumeRepository.upsert({
            volumeNumber: 1, title: '第一卷', startChapter: 1, endChapter: 3,
            premise: '首发', synopsis: '旧大纲', openingState: '', closingState: '',
            openThreads: [], status: 'writing',
        })
        useVolumeStore.setState({ volumes: VolumeRepository.getAll(), status: 'ready' })
        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 1)!
        stubLLM('{"synopsis":"新大纲"}')
        const res = await startVolumeSynopsisRegen(v, 0)
        assertEq(res.ok, true)
        const logs = useWorkflowStore.getState().globalLogs.map(l => l.message).join(' | ')
        assert(logs.includes('没有其它卷') || logs.includes('无上一卷'),
            `首卷日志应明示无上一卷：${logs}`)
    })

    await testCase('W4 取消路径不走 takeWorkflowResult → runId 仍可由 activeRuns 找回', async () => {
        // 这是接口约定：startWorkflow 完成才返回 runId，「停止生成」期间得能从 activeRuns 找
        freshEnv()
        seedTwoVolumes()
        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 2)!
        let stopAttempted = false
        stubLLMSliced(['{"synopsis":"第一', '部分'], () => {
            if (!stopAttempted) {
                stopAttempted = true
                // 跑在工作流尚未完成时，store 里有 run
                const runId = findActiveRegenRunId()
                assert(typeof runId === 'string', '生成中应能从 activeRuns 找回 runId')
                stopVolumeSynopsisRegen()
            }
        })
        await startVolumeSynopsisRegen(v, 0)
        // 跑完后 activeRuns 里没有
        assertEq(findActiveRegenRunId(), null)
    })

    await testCase('W5 describeRegenOutcome：dirty / stale 各按预期翻译', async () => {
        // null 表示「刻意不提示」，stale 也不该提示（用户自己的操作）
        assertEq(describeRegenOutcome({ ok: false, reason: 'stale', message: 'x' }), null)
        assertEq(describeRegenOutcome({ ok: true, volumeNumber: 1, charCount: 1 }), null)
        // 其它 reason 应原样透传 message
        const msg = describeRegenOutcome({ ok: false, reason: 'dirty', message: '有未保存改动' })
        assertEq(msg, '有未保存改动')
    })

    await testCase('W6 single-flight：第二条同时发起 → busy', async () => {
        freshEnv()
        seedTwoVolumes()
        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 2)!
        // 用 sliced LLM：每片之后**不**点停止，让工作流继续跑着
        stubLLMSliced(['{"synopsis":"长期生成', '中', '"更多内容'], async () => { /* 等 */ })
        // ⚠️ 关键：**不 await**第一条，让它跑在后台、run 留在 store 里。
        // await 会让出事件循环，第一条可能就已经跑完了
        const p1 = startVolumeSynopsisRegen(v, 0)
        // 让微任务跑一下、把 run 钉进 store
        await Promise.resolve()
        const regenStore = useVolumeRegenStore.getState()
        assert(regenStore.run !== null, '第一条发起后 run 应留在 store 里')
        // 第二条抢 begin：run 还在、应当返回 busy
        const llm2 = stubLLM('{"synopsis":"第二条"}')
        const res2 = await startVolumeSynopsisRegen(v, 0)
        assertEq(res2.ok, false, 'single-flight：已有一条在跑时第二条必须被拒')
        assertEq(res2.ok ? null : res2.reason, 'busy', 'single-flight 的拒绝原因应为 busy')
        assertEq(llm2.calls, 0, 'busy 时不发起 LLM')
        // 放掉第一条让它跑完
        await p1
    })

    await testCase('W7 invalidateVolumeRegen（项目关闭）→ run 与 result 都清空', async () => {
        freshEnv()
        seedTwoVolumes()
        // 种一个已就位的结果
        useVolumeRegenStore.setState({
            results: {
                [`${currentToken}:2`]: {
                    regenId: 999, projectToken: currentToken, volumeNumber: 2, synopsis: '旧结果',
                },
            },
        })
        // 模拟项目切换
        invalidateVolumeRegen()
        const regenStore = useVolumeRegenStore.getState()
        assertEq(regenStore.run, null, 'run 应清空')
        assertEq(regenResultFor(2), null, 'result 应清空')
    })

    await testCase('W8 取走产物 → workflow-store 已释放（覆盖「不 take 直接走人」漏窗）', async () => {
        freshEnv()
        seedTwoVolumes()
        const v = useVolumeStore.getState().volumes.find(v => v.volumeNumber === 2)!
        stubLLM('{"synopsis":"大纲"}')
        await startVolumeSynopsisRegen(v, 0)
        // 第二次再调：service 已经把 workflow-store.results 取走、清空了
        const { takeRegenerateVolumeResult } = await import('../../src/services/workflows/volume-regen-workflow')
        const leftovers = takeRegenerateVolumeResult('non-existent-id')
        assertEq(leftovers, null)
    })

    await testCase('W9 workType 标识已注册为合法值', async () => {
        // 防止有人把 VOLUME_REGEN_WORKFLOW_TYPE 拼错导致 activeRuns.find 永远找不到
        assertEq(VOLUME_REGEN_WORKFLOW_TYPE, 'volume_synopsis')
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
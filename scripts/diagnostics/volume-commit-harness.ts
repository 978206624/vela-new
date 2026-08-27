/**
 * volume-commit-harness — 续卷提交事务的 **UIless 运行时证据**（Phase 19 / Task 19.2b）
 *
 * ## 为什么需要它
 *
 * `commitNextVolume` 是本 Phase 唯一会**同时改四张表**的写入点，它的正确性全靠
 * 一串事务内断言。这些断言只有在并发/重复提交/中途异常时才会走到，
 * 而那几条路径在 UI 上极难复现——评审要求「合入前给出最小运行时证据」，即此文件。
 *
 * 覆盖：零副作用探查 / 三种孤儿策略 / 重复提交 / 上一卷边界被改 / 卷号断档 /
 * 快照条数与内容指纹失配 / 写到一半异常的整体回滚 / synopsis 库内读改写 /
 * open_threads 读写两套语义。
 *
 * ## 怎么跑
 *
 * ```bash
 * npm run harness:volume     # 退出码 0 = 全通过
 * ```
 *
 * `better-sqlite3` 是按 **Electron 的 ABI** 编译的（见 package.json 的 rebuild 脚本），
 * 普通 node 加载会 `ERR_DLOPEN_FAILED`，故 launcher 用 `ELECTRON_RUN_AS_NODE=1`
 * 借 Electron 的 node 跑（细节见 scripts/diagnostics/run-volume-harness.mjs）。
 *
 * 全程只在系统临时目录里建库，**不碰任何真实项目**。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initProjectDatabase, closeProjectDatabase, getProjectDb } from '../../electron/database'
import { VolumeRepository, type VolumeData } from '../../electron/repositories/volume-repository'
import { BlueprintRepository } from '../../electron/repositories/blueprint-repository'
import {
    commitNextVolume, inspectFirstVolume,
    type CommitNextVolumePayload, type FirstVolumeGuard, type FirstVolumeInspection, type OrphanPolicy,
} from '../../electron/repositories/volume-commit'
import { parseOpenThreads, serializeOpenThreads } from '../../electron/repositories/volume-threads'
import { MAX_OPEN_THREADS, MAX_THREAD_LEN, MAX_OPEN_THREADS_BYTES, utf8Bytes } from '../../src/shared/volume-limits'

// ===== 迷你断言框架 =====

let passed = 0
const failures: string[] = []
let currentCase = ''

/**
 * 跑一个用例。
 *
 * `expectLogs` 声明本用例**是否允许**业务代码打 console.error：
 * 负向用例每条都会让 volume-commit 打一份「事务已回滚」的日志，那是预期行为；
 * 正向用例则一条都不该有——若有，说明业务代码自己 catch 了某个异常、
 * 只用日志上报而照常返回成功，那种问题不捕获日志就完全看不见。
 * 所以是**捕获**而不是丢弃：丢弃等于给正向用例开了一个无痕通过的口子。
 */
function testCase(name: string, fn: () => void, expectLogs: 'none' | 'allowed' = 'none'): void {
    currentCase = name
    const realError = console.error
    const captured: string[] = []
    console.error = (...args: unknown[]) => { captured.push(args.map(String).join(' ')) }
    try {
        fn()
        if (expectLogs === 'none' && captured.length > 0) {
            throw new Error(
                `用例通过但业务代码打了 ${captured.length} 条 console.error（正向用例不应有）：\n` +
                captured.map(l => `         ${l.slice(0, 200)}`).join('\n')
            )
        }
        console.log(`  ✅ ${name}`)
        passed++
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const tail = captured.length > 0
            ? `\n       —— 期间捕获的 console.error ——\n` +
              captured.map(l => `       ${l.slice(0, 300)}`).join('\n')
            : ''
        console.log(`  ❌ ${name}\n       ${msg}${tail}`)
        failures.push(`${name}: ${msg}`)
    } finally {
        console.error = realError
    }
}

function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new Error(`断言失败：${msg}`)
}

function assertEq<T>(actual: T, expected: T, what: string): void {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    if (a !== e) throw new Error(`${what}\n       期望: ${e}\n       实际: ${a}`)
}

/** 断言 fn 抛出的错误信息包含 fragment，并把错误对象返回 */
function assertThrows(fn: () => void, fragment: string): Error {
    try {
        fn()
    } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err))
        if (!e.message.includes(fragment)) {
            throw new Error(`抛错信息不含「${fragment}」，实为：${e.message}`)
        }
        return e
    }
    throw new Error(`期望抛出含「${fragment}」的错误，但没有抛错`)
}

// ===== 库快照（判断「表未被改动」的唯一依据）=====

/** 四张受影响的表的完整快照。回滚断言比对的就是它 */
function snapshot(): string {
    const db = getProjectDb()!
    return JSON.stringify({
        volumes: db.prepare('SELECT * FROM volumes ORDER BY volume_number').all(),
        blueprints: db.prepare('SELECT * FROM blueprints ORDER BY chapter_number').all(),
        drafts: db.prepare('SELECT * FROM drafts ORDER BY id').all(),
        core: db.prepare('SELECT * FROM project_core').all(),
    })
}

function assertUnchanged(before: string, what: string): void {
    const after = snapshot()
    if (before !== after) {
        // 只报第一处差异，整库 JSON 贴出来没法读
        throw new Error(`${what}：库发生了改动\n       before=${before.slice(0, 400)}\n       after =${after.slice(0, 400)}`)
    }
}

// ===== 测试夹具 =====

let tmpRoot = ''
let dbSeq = 0

/** 每个用例开一个全新的临时库，杜绝用例间互相污染 */
function freshDb(): void {
    closeProjectDatabase()
    const dir = path.join(tmpRoot, `p-${++dbSeq}`)
    fs.mkdirSync(dir, { recursive: true })
    initProjectDatabase(dir)
    getProjectDb()!.prepare(
        `INSERT INTO project_core (id, project_name, total_chapters, synopsis) VALUES ('main', 'harness', 0, '')`
    ).run()
}

/** 造 finalized 定稿章（drafts 有 FK 到 contents，必须先建 content） */
function seedFinalized(from: number, to: number): void {
    const db = getProjectDb()!
    for (let c = from; c <= to; c++) {
        const info = db.prepare(`INSERT INTO contents (body) VALUES (?)`).run(`第 ${c} 章正文`)
        db.prepare(
            `INSERT INTO drafts (chapter_number, version, status, content_id, word_count) VALUES (?, 1, 'finalized', ?, 100)`
        ).run(c, info.lastInsertRowid)
    }
}

/** 造蓝图。chapters 显式给定，好构造「有缺口」的区间 */
function seedBlueprints(chapters: number[], titlePrefix = 'BP'): void {
    const db = getProjectDb()!
    for (const c of chapters) {
        db.prepare(
            `INSERT INTO blueprints (chapter_number, title, key_events) VALUES (?, ?, ?)`
        ).run(c, `${titlePrefix}-${c}`, `事件${c}`)
    }
}

function setSynopsis(s: string): void {
    getProjectDb()!.prepare(`UPDATE project_core SET synopsis = ? WHERE id='main'`).run(s)
}

function getCore(): { total_chapters: number; synopsis: string } {
    return getProjectDb()!.prepare(
        `SELECT total_chapters, synopsis FROM project_core WHERE id='main'`
    ).get() as { total_chapters: number; synopsis: string }
}

function vol(n: number, start: number, end: number, extra: Partial<VolumeData> = {}): VolumeData {
    return {
        volumeNumber: n, title: `第${n}卷`, startChapter: start, endChapter: end,
        premise: '', synopsis: `卷${n}大纲`, openingState: '', closingState: '',
        openThreads: [], status: 'done', ...extra,
    }
}

/** 标准 payload：上一卷 prev，新卷紧接其后 count 章。字段构造方式对齐 buildCommitPayload */
function payloadFor(prev: VolumeData, count: number, over: Partial<CommitNextVolumePayload> = {}): CommitNextVolumePayload {
    const start = prev.endChapter + 1
    const closingState = '主角登顶'
    return {
        closingReport: {
            volumeNumber: prev.volumeNumber,
            closingState,
            openThreads: [{ chapter: 3, thread: '玉佩来历未明', urgency: 'high' }],
        },
        // openingState 由 buildCommitPayload 从 closingReport.closingState 取，
        // 事务层原样落库、不再推导——此处照搬同一构造方式，保证 F3 测的是真实形状
        newVolume: vol(prev.volumeNumber + 1, start, start + count - 1,
            { status: 'planned', title: '新卷', openingState: closingState }),
        newVolumeSection: '## 新卷\n\n新卷正文段落',
        ...over,
    }
}

/**
 * 由一次探查结果构造首卷提交凭据。
 * **无孤儿时也必须构造**——凭据记的是探查时的两个边界事实，
 * 「当前没有孤儿」同样是个会过期的结论（D8 就是照这个洞写的）。
 */
function guardOf(insp: FirstVolumeInspection, policy?: OrphanPolicy): FirstVolumeGuard {
    const base = {
        maxFinalized: insp.firstVolumeBase?.maxFinalized ?? 0,
        maxBlueprint: insp.firstVolumeBase?.maxBlueprint ?? 0,
    }
    return (insp.orphan && policy)
        ? { kind: 'orphan', policy, snapshot: insp.orphan, ...base }
        : { kind: 'none', ...base }
}

/** 就地探查并构造凭据（用于不关心 insp 其它字段的用例） */
function guardNow(policy?: OrphanPolicy): FirstVolumeGuard {
    return guardOf(inspectFirstVolume(), policy)
}

// ===== 用例 =====

function main(): void {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-volume-harness-'))
    console.log(`[harness] 临时库根目录：${tmpRoot}\n`)

    console.log('▶ A 组：探查零副作用 + 孤儿识别')

    testCase('A1 inspectFirstVolume 是纯读，四张表一字不改', () => {
        freshDb()
        seedFinalized(1, 10)
        seedBlueprints([11, 12, 15])
        const before = snapshot()
        const insp = inspectFirstVolume()
        assert(insp.needsFirstVolume, '零卷时应判定需要建首卷')
        assertUnchanged(before, 'inspectFirstVolume 之后')
    })

    testCase('A2 孤儿条数按实际统计，不按 end-start+1 推导（区间允许有缺口）', () => {
        freshDb()
        seedFinalized(1, 10)
        seedBlueprints([11, 12, 15]) // 11–15 共 5 个章号，但只有 3 条蓝图
        const insp = inspectFirstVolume()
        assertEq(insp.orphan?.startChapter, 11, '孤儿起始章')
        assertEq(insp.orphan?.endChapter, 15, '孤儿结束章')
        assertEq(insp.orphan?.count, 3, '孤儿条数应为实际条数 3，而非区间宽度 5')
        assert(typeof insp.orphan?.fingerprint === 'string' && insp.orphan.fingerprint.length === 64,
            '指纹应为 64 位 sha256 十六进制串')
    })

    testCase('A3 无孤儿时不返回 orphan；已分卷时不需要建首卷', () => {
        freshDb()
        seedFinalized(1, 10)
        seedBlueprints([1, 5, 10])
        assertEq(inspectFirstVolume().orphan, undefined, '蓝图未超出定稿范围时不应有孤儿')
        VolumeRepository.upsert(vol(1, 1, 10))
        assertEq(inspectFirstVolume().needsFirstVolume, false, '已有卷时不应再建首卷')
    })

    console.log('\n▶ B 组：三种孤儿策略（惰性建卷路径）')

    testCase('B1 clear：孤儿蓝图被删，首卷止于最大定稿章', () => {
        freshDb()
        seedFinalized(1, 10)
        seedBlueprints([11, 12, 15])
        setSynopsis('旧大纲')
        const insp = inspectFirstVolume()
        const first = vol(1, 1, insp.firstVolumeBase!.maxFinalized, { title: '第一卷' })
        const res = commitNextVolume({
            ...payloadFor(first, 5),
            firstVolume: { draft: first, guard: guardOf(insp, 'clear') },
        })
        assert(res.success, `提交应成功，实际：${res.error}`)
        const db = getProjectDb()!
        assertEq((db.prepare('SELECT COUNT(*) c FROM blueprints').get() as { c: number }).c, 0, 'clear 后孤儿蓝图应清空')
        assertEq(VolumeRepository.get(1)!.endChapter, 10, '首卷应止于第 10 章')
        assertEq(VolumeRepository.get(2)!.startChapter, 11, '新卷应起于第 11 章')
        assertEq(getCore().total_chapters, 15, '总章数应更新为新卷末章')
        assertEq(getCore().synopsis, '旧大纲\n\n---\n\n## 新卷\n\n新卷正文段落', 'synopsis 应为追加拼接')
    })

    testCase('B2 keep + 新卷覆盖整个孤儿区间：蓝图一条不删，且全部有卷归属', () => {
        freshDb()
        seedFinalized(1, 10)
        seedBlueprints([11, 12, 15, 18]) // 孤儿区间 11–18
        const insp = inspectFirstVolume()
        const first = vol(1, 1, insp.firstVolumeBase!.maxFinalized, { title: '第一卷' })
        // 新卷 11–20，完整覆盖孤儿区间。必须显式传 'keep'——round-05 审查发现
        // 早先这里调的是无参 guardNow()，名为 keep 实际没带任何策略
        const res = commitNextVolume({ ...payloadFor(first, 10), firstVolume: { draft: first, guard: guardNow('keep') } })
        assert(res.success, `提交应成功，实际：${res.error}`)
        const db = getProjectDb()!
        assertEq((db.prepare('SELECT COUNT(*) c FROM blueprints').get() as { c: number }).c, 4, 'keep 策略不得删任何蓝图')
        assertEq(VolumeRepository.get(2)!.endChapter, 20, '新卷止于第 20 章')
        // 关键：保留下来的每一条蓝图都必须落在某个卷内，否则它既不进 prompt、也无归属
        for (const c of [11, 12, 15, 18]) {
            assert(VolumeRepository.getByChapter(c) !== null, `第 ${c} 章的保留蓝图必须有卷归属`)
        }
        assertEq(getCore().total_chapters, 20, '总章数按新卷末章更新')
    })

    testCase('B2b keep 且新卷短于孤儿区间 → 事务层拒绝（预览阶段改小章数也逃不掉）', () => {
        freshDb()
        seedFinalized(1, 10)
        seedBlueprints([11, 12, 15, 18]) // 孤儿区间 11–18
        const insp = inspectFirstVolume()
        assert(insp.orphan, '前置：应识别出孤儿')
        const first = vol(1, 1, 10, { title: '第一卷' })
        // 工作流发起时章数可能够用（预检通过），但用户在预览里把章数改小了——
        // 载荷是确认时才构造的，事务层必须自己再拦，不能信任上游查过。
        // ⚠️ 快照必须在提交**之前**取：提交之后取再跟自己比是恒真断言（round-06 #3）
        const before = snapshot()
        const res = commitNextVolume({
            ...payloadFor(first, 3), firstVolume: { draft: first, guard: guardOf(insp, 'keep') },
        })
        assert(!res.success, 'keep 的新卷盖不住孤儿末章时必须拒绝')
        assert(res.error!.includes('保留旧蓝图') && res.error!.includes('第 18 章'), `实为：${res.error}`)
        assertUnchanged(before, '拒绝后')
    }, 'allowed')

    testCase('B3 extend：首卷吞下孤儿区间，止于蓝图末章', () => {
        freshDb()
        seedFinalized(1, 10)
        seedBlueprints([11, 12, 15])
        const insp = inspectFirstVolume()
        const b = insp.firstVolumeBase!
        const endChapter = Math.max(b.maxBlueprint, b.maxFinalized) // = buildFirstVolumeDraft 的 extend 分支
        assertEq(endChapter, 15, 'extend 首卷应止于第 15 章')
        const first = vol(1, 1, endChapter, { title: '第一卷' })
        const res = commitNextVolume({ ...payloadFor(first, 5), firstVolume: { draft: first, guard: guardNow('extend') } })
        assert(res.success, `提交应成功，实际：${res.error}`)
        assertEq(VolumeRepository.get(1)!.endChapter, 15, '首卷止于 15')
        assertEq(VolumeRepository.get(2)!.startChapter, 16, '新卷起于 16')
        assertEq((getProjectDb()!.prepare('SELECT COUNT(*) c FROM blueprints').get() as { c: number }).c, 3, 'extend 不删蓝图')
    })

    testCase('B4 extend 且蓝图末章 < 定稿末章时，首卷不得倒退到定稿之前', () => {
        freshDb()
        seedFinalized(1, 20)
        seedBlueprints([1, 2, 3]) // maxBlueprint(3) < maxFinalized(20)
        const insp = inspectFirstVolume()
        const b = insp.firstVolumeBase!
        assertEq(insp.orphan, undefined, '蓝图未超出定稿范围，不应判为孤儿')
        assertEq(Math.max(b.maxBlueprint, b.maxFinalized), 20,
            'extend 取 max，否则首卷会止于第 3 章，第 4–20 章的已写正文将脱离分卷')
    })

    console.log('\n▶ C 组：并发与重复提交的拒绝（跨字段不变量）')

    testCase('C1 重复提交被识别为「已存在」，且第二次不改动任何数据', () => {
        freshDb()
        seedFinalized(1, 10)
        VolumeRepository.upsert(vol(1, 1, 10))
        const p = payloadFor(vol(1, 1, 10), 5)
        assert(commitNextVolume(p).success, '首次提交应成功')
        const afterFirst = snapshot()
        const res2 = commitNextVolume(p)
        assert(!res2.success, '重复提交必须失败')
        assert(res2.error!.includes('已存在'), `报错应指向重复提交，实为：${res2.error}`)
        assertUnchanged(afterFirst, '重复提交被拒后')
    }, 'allowed')

    testCase('C2 生成期间上一卷**扩张**到覆盖新卷起点 → 拒绝，且文案说「重叠」而非「空洞」', () => {
        freshDb()
        seedFinalized(1, 10)
        VolumeRepository.upsert(vol(1, 1, 10))
        const p = payloadFor(vol(1, 1, 10), 5) // 新卷 11–15
        // 模拟用户在两次 LLM 调用期间把第 1 卷改成 1–12
        VolumeRepository.upsert(vol(1, 1, 12))
        const before = snapshot()
        const res = commitNextVolume(p)
        assert(!res.success, '边界已变时必须拒绝')
        assert(res.error!.includes('重叠'), `这是重叠方向，文案不该说空洞。实为：${res.error}`)
        assert(!res.error!.includes('空洞'), `不该同时出现「空洞」字样。实为：${res.error}`)
        assertUnchanged(before, '拒绝后')
    }, 'allowed')

    testCase('C2b 生成期间上一卷**收缩** → 拒绝，且文案点名无归属的章号区间', () => {
        freshDb()
        seedFinalized(1, 10)
        VolumeRepository.upsert(vol(1, 1, 10))
        const p = payloadFor(vol(1, 1, 10), 5) // 新卷 11–15
        VolumeRepository.upsert(vol(1, 1, 8))  // 上一卷缩到 1–8，第 9、10 章将无归属
        const before = snapshot()
        const res = commitNextVolume(p)
        assert(!res.success, '边界已变时必须拒绝')
        assert(res.error!.includes('第 9–10 章将无卷归属'), `应点名具体空洞区间。实为：${res.error}`)
        assertUnchanged(before, '拒绝后')
    }, 'allowed')

    testCase('C3 新卷序号断档 → 拒绝', () => {
        freshDb()
        seedFinalized(1, 10)
        VolumeRepository.upsert(vol(1, 1, 10))
        const p = payloadFor(vol(1, 1, 10), 5)
        p.newVolume = { ...p.newVolume, volumeNumber: 5 } // 应为 2
        const res = commitNextVolume(p)
        assert(!res.success && res.error!.includes('新卷序号应为第 2 卷'), `实为：${res.error}`)
    }, 'allowed')

    testCase('C4 上一卷已不是最后一卷（他处已续过卷）→ 拒绝', () => {
        freshDb()
        seedFinalized(1, 10)
        VolumeRepository.upsert(vol(1, 1, 10))
        const p = payloadFor(vol(1, 1, 10), 5)
        VolumeRepository.upsert(vol(2, 11, 30)) // 别处抢先建了第 2 卷
        p.newVolume = { ...p.newVolume, volumeNumber: 3, startChapter: 31, endChapter: 35 }
        const res = commitNextVolume(p)
        assert(!res.success && res.error!.includes('上一卷已不是最后一卷'), `实为：${res.error}`)
    }, 'allowed')

    testCase('C5 惰性路径下卷表已非空 → 拒绝', () => {
        freshDb()
        seedFinalized(1, 10)
        const first = vol(1, 1, 10, { title: '第一卷' })
        const p: CommitNextVolumePayload = { ...payloadFor(first, 5), firstVolume: { draft: first, guard: guardNow() } }
        VolumeRepository.upsert(vol(1, 1, 10)) // 别处抢先建了卷
        const res = commitNextVolume(p)
        assert(!res.success && res.error!.includes('分卷状态已变化'), `实为：${res.error}`)
    }, 'allowed')

    testCase('C6 惰性路径下首卷与新卷不相接 → 拒绝（upsert 只查重叠，查不出空洞）', () => {
        freshDb()
        seedFinalized(1, 10)
        const first = vol(1, 1, 10, { title: '第一卷' })
        const p: CommitNextVolumePayload = { ...payloadFor(first, 5), firstVolume: { draft: first, guard: guardNow() } }
        p.newVolume = { ...p.newVolume, startChapter: 12, endChapter: 16 } // 跳过第 11 章
        const before = snapshot()
        const res = commitNextVolume(p)
        assert(!res.success && res.error!.includes('无卷归属'), `实为：${res.error}`)
        assertUnchanged(before, '拒绝后')
    }, 'allowed')

    console.log('\n▶ D 组：孤儿快照复核（条数 + 内容指纹）')

    testCase('D1a 确认后区间内多出一条蓝图 → 条数失配拒绝', () => {
        freshDb()
        seedFinalized(1, 10)
        seedBlueprints([11, 13]) // 孤儿区间 11–13，但只有 2 条（第 12 章是缺口）
        const insp = inspectFirstVolume()
        assertEq(insp.orphan?.count, 2, '前置：快照记录 2 条')
        const first = vol(1, 1, 10, { title: '第一卷' })
        seedBlueprints([12]) // 用户确认后把缺口补上了，区间没变、条数变了
        const before = snapshot()
        const res = commitNextVolume({ ...payloadFor(first, 5), firstVolume: { draft: first, guard: guardOf(insp, 'clear') } })
        assert(!res.success && res.error!.includes('发生了变化'), `实为：${res.error}`)
        assertUnchanged(before, '拒绝后')
    }, 'allowed')

    testCase('D1b 确认后在快照区间**之外**又生成蓝图 → 拒绝（只查区间内会漏，clear 会留下幽灵蓝图）', () => {
        freshDb()
        seedFinalized(1, 10)
        seedBlueprints([11, 12])
        const insp = inspectFirstVolume()
        const first = vol(1, 1, 10, { title: '第一卷' })
        seedBlueprints([13]) // 区间 11–12 内的条数与指纹都不变
        assertEq(
            (getProjectDb()!.prepare('SELECT COUNT(*) c FROM blueprints WHERE chapter_number BETWEEN 11 AND 12')
                .get() as { c: number }).c,
            2, '前置：区间内条数确实未变，故只靠条数/指纹检查必然放行',
        )
        const before = snapshot()
        const res = commitNextVolume({ ...payloadFor(first, 5), firstVolume: { draft: first, guard: guardOf(insp, 'clear') } })
        assert(!res.success, 'clear 的语义是清掉全部孤儿，区间外冒出新孤儿必须拒绝')
        // 现由②的 maxBlueprint 复核统一拦下（比原先只在孤儿区间内查更早、更普适）
        assert(res.error!.includes('新增到第 13 章'), `实为：${res.error}`)
        assertUnchanged(before, '拒绝后')
    }, 'allowed')

    testCase('D2 条数不变但内容被改 → 指纹拦截（只比 count 会漏）', () => {
        freshDb()
        seedFinalized(1, 10)
        seedBlueprints([11, 12])
        const insp = inspectFirstVolume()
        const first = vol(1, 1, 10, { title: '第一卷' })
        // 用户在预览期间改了第 11 章蓝图的内容，条数一条没变
        getProjectDb()!.prepare(`UPDATE blueprints SET key_events = '用户刚写的新事件' WHERE chapter_number = 11`).run()
        const before = snapshot()
        const res = commitNextVolume({ ...payloadFor(first, 5), firstVolume: { draft: first, guard: guardOf(insp, 'clear') } })
        assert(!res.success, '内容变化必须拒绝，否则用户刚写的内容会被 clear 删掉')
        assert(res.error!.includes('内容在你确认后被修改过'), `实为：${res.error}`)
        assertUnchanged(before, '指纹拦截后')
    }, 'allowed')

    testCase('D4 同一秒内只改 user_guidance（标题/关键事件/时间戳都不变）→ 指纹仍须拦下', () => {
        freshDb()
        seedFinalized(1, 10)
        seedBlueprints([11, 12])
        const insp = inspectFirstVolume()
        const first = vol(1, 1, 10, { title: '第一卷' })
        const db = getProjectDb()!
        const before0 = db.prepare(
            'SELECT title, key_events, updated_at FROM blueprints WHERE chapter_number = 11'
        ).get() as { title: string; key_events: string; updated_at: string }
        // 只改 user_guidance，且**不动 updated_at**（模拟同一秒内的修改）
        db.prepare(`UPDATE blueprints SET user_guidance = '这一章我想写得慢一点' WHERE chapter_number = 11`).run()
        const after0 = db.prepare(
            'SELECT title, key_events, updated_at FROM blueprints WHERE chapter_number = 11'
        ).get() as { title: string; key_events: string; updated_at: string }
        assertEq(after0, before0, '前置：标题/关键事件/时间戳三项确实都没变，只比这三项必然放行')
        const before = snapshot()
        const res = commitNextVolume({ ...payloadFor(first, 5), firstVolume: { draft: first, guard: guardOf(insp, 'clear') } })
        assert(!res.success, 'user_guidance 也会被 clear 删掉，必须纳入指纹')
        assert(res.error!.includes('内容在你确认后被修改过'), `实为：${res.error}`)
        assertUnchanged(before, '拒绝后')
    }, 'allowed')

    testCase('D3 快照未变 → 放行', () => {
        freshDb()
        seedFinalized(1, 10)
        seedBlueprints([11, 12])
        const insp = inspectFirstVolume()
        const first = vol(1, 1, 10, { title: '第一卷' })
        const res = commitNextVolume({ ...payloadFor(first, 5), firstVolume: { draft: first, guard: guardOf(insp, 'clear') } })
        assert(res.success, `快照未变时应放行，实际：${res.error}`)
    })

    testCase('D5 extend 策略下确认后新增末章蓝图 → 同样拒绝（复核不是 clear 专属）', () => {
        freshDb()
        seedFinalized(1, 10)
        seedBlueprints([11, 12, 18])
        const insp = inspectFirstVolume()
        // extend：首卷吞到蓝图末章 18，新卷 19–23
        const first = vol(1, 1, 18, { title: '第一卷' })
        seedBlueprints([24]) // 生成期间又冒出第 24 章
        const before = snapshot()
        const res = commitNextVolume({
            ...payloadFor(first, 5), firstVolume: { draft: first, guard: guardOf(insp, 'extend') },
        })
        assert(!res.success, 'extend 的首卷边界按探查时的蓝图末章定死，新增的第 24 章会无卷归属')
        assert(res.error!.includes('新增到第 24 章'), `实为：${res.error}`)
        assertUnchanged(before, '拒绝后')
    }, 'allowed')

    testCase('D6 keep 策略下确认后改了保留蓝图的内容 → 拒绝（新卷大纲基于旧内容推演）', () => {
        freshDb()
        seedFinalized(1, 10)
        seedBlueprints([11, 12])
        const insp = inspectFirstVolume()
        const first = vol(1, 1, 10, { title: '第一卷' })
        getProjectDb()!.prepare(`UPDATE blueprints SET key_events = '用户改写的关键事件' WHERE chapter_number = 12`).run()
        const before = snapshot()
        const res = commitNextVolume({
            ...payloadFor(first, 5), firstVolume: { draft: first, guard: guardOf(insp, 'keep') },
        })
        assert(!res.success, 'keep 不删蓝图，但新卷大纲是照旧内容推演的，改了就对不上')
        assert(res.error!.includes('基于旧内容推演'), `实为：${res.error}`)
        assertUnchanged(before, '拒绝后')
    }, 'allowed')

    testCase('D7 keep 策略正常提交：复核通过且一条蓝图都不删', () => {
        freshDb()
        seedFinalized(1, 10)
        seedBlueprints([11, 12])
        const insp = inspectFirstVolume()
        const first = vol(1, 1, 10, { title: '第一卷' })
        const res = commitNextVolume({
            ...payloadFor(first, 5), firstVolume: { draft: first, guard: guardOf(insp, 'keep') },
        })
        assert(res.success, `keep 应成功，实际：${res.error}`)
        assertEq((getProjectDb()!.prepare('SELECT COUNT(*) c FROM blueprints').get() as { c: number }).c, 2,
            'keep 复核归复核，删除只属于 clear')
    })

    testCase('D8 探查时**本来就没有孤儿**，生成期间新建蓝图 → 仍须拒绝（凭据必须无条件携带）', () => {
        freshDb()
        seedFinalized(1, 10)
        seedBlueprints([1, 5, 10]) // 全在定稿范围内，探查判定无孤儿
        const insp = inspectFirstVolume()
        assertEq(insp.orphan, undefined, '前置：此时确实没有孤儿')
        const guard = guardOf(insp) // 无孤儿也要有凭据——这正是本用例要证明的
        const first = vol(1, 1, 10, { title: '第一卷' })

        seedBlueprints([20]) // 用户在预览期间生成了第 20 章蓝图
        const before = snapshot()
        const res = commitNextVolume({ ...payloadFor(first, 5), firstVolume: { draft: first, guard } })
        assert(!res.success,
            '首卷 1–10 + 新卷 11–15 都盖不到第 20 章；若因「探查时没孤儿」而不带凭据，这里会静默放行')
        assert(res.error!.includes('新增到第 20 章'), `实为：${res.error}`)
        assertUnchanged(before, '拒绝后')
    }, 'allowed')

    testCase('D9 生成期间用户又定稿了一章 → 拒绝（首卷边界是照旧的 maxFinalized 算的）', () => {
        freshDb()
        seedFinalized(1, 10)
        const guard = guardOf(inspectFirstVolume())
        const first = vol(1, 1, 10, { title: '第一卷' })
        seedFinalized(11, 11)
        const before = snapshot()
        const res = commitNextVolume({ ...payloadFor(first, 5), firstVolume: { draft: first, guard } })
        assert(!res.success && res.error!.includes('已定稿章节在你确认后发生了变化'), `实为：${res.error}`)
        assertUnchanged(before, '拒绝后')
    }, 'allowed')

    testCase('D10 带首卷草案却不带凭据 → 运行时拒绝（类型挡不住跨进程来的载荷）', () => {
        freshDb()
        seedFinalized(1, 10)
        const first = vol(1, 1, 10, { title: '第一卷' })
        const before = snapshot()
        // 模拟渲染层被改成只传草案：类型上构造不出来，但 IPC 那头可以
        const bad = { ...payloadFor(first, 5), firstVolume: { draft: first } } as unknown as CommitNextVolumePayload
        const res = commitNextVolume(bad)
        assert(!res.success && res.error!.includes('首卷提交凭据缺失'), `实为：${res.error}`)
        assertUnchanged(before, '拒绝后')
    })

    testCase('D11 实际有孤儿却只传 none 分支 → 自洽性检查拒绝（round-05 的洞）', () => {
        freshDb()
        seedFinalized(1, 10)
        seedBlueprints([11, 12]) // 库里确实有孤儿：maxBlueprint(12) > maxFinalized(10)
        const first = vol(1, 1, 10, { title: '第一卷' })
        // 伪造「探查时无孤儿」的凭据。类型上构造不出来（判别联合），
        // 但载荷跨进程而来，运行时必须自己识破
        const bad = {
            ...payloadFor(first, 5),
            firstVolume: {
                draft: first,
                guard: { kind: 'none', maxFinalized: 10, maxBlueprint: 12 } as FirstVolumeGuard,
            },
        }
        const before = snapshot()
        const res = commitNextVolume(bad)
        assert(!res.success, '有孤儿却没带处置快照时必须拒绝，否则策略/指纹/覆盖三道复核全部跳过')
        assert(res.error!.includes('没有携带处置快照'), `实为：${res.error}`)
        assertUnchanged(before, '拒绝后')
    }, 'allowed')

    testCase('D12 快照区间与探查边界不符 → 拒绝（防报窄区间让指纹检查形同虚设）', () => {
        freshDb()
        seedFinalized(1, 10)
        seedBlueprints([11, 12])
        const insp = inspectFirstVolume()
        const first = vol(1, 1, 10, { title: '第一卷' })
        const g = guardOf(insp, 'clear') as Extract<FirstVolumeGuard, { kind: 'orphan' }>
        // 篡改区间：报一个不存在的更窄区间。若放行，区间外的改动就能逃过指纹复核
        const bad = {
            ...payloadFor(first, 5),
            firstVolume: {
                draft: first,
                guard: { ...g, snapshot: { ...g.snapshot, startChapter: 11, endChapter: 11 } },
            },
        }
        const before = snapshot()
        const res = commitNextVolume(bad)
        assert(!res.success && res.error!.includes('孤儿快照与探查边界不符'), `实为：${res.error}`)
        assertUnchanged(before, '拒绝后')
    }, 'allowed')

    testCase('D13 策略与首卷边界对不上（keep 却吞了孤儿区间）→ 拒绝', () => {
        freshDb()
        seedFinalized(1, 10)
        seedBlueprints([11, 12])
        const insp = inspectFirstVolume()
        // keep 的首卷应止于 maxFinalized=10；这里伪造 extend 形状的边界 12
        const first = vol(1, 1, 12, { title: '第一卷' })
        const bad = {
            ...payloadFor(first, 5),
            firstVolume: { draft: first, guard: guardOf(insp, 'keep') },
        }
        const before = snapshot()
        const res = commitNextVolume(bad)
        assert(!res.success && res.error!.includes('首卷应为第 1 卷、从第 1 章到第 10 章'), `实为：${res.error}`)
        assertUnchanged(before, '拒绝后')
    }, 'allowed')

    testCase('D14 kind:none 配伪造的首卷 2–10 → 基础边界校验拒绝（round-06 #1）', () => {
        freshDb()
        seedFinalized(1, 10)
        seedBlueprints([1, 5, 10]) // 无孤儿，凭据合法地走 none 分支
        const insp = inspectFirstVolume()
        // 伪造草案：首卷从第 2 卷、第 2 章开始——若放行，第 1 章从此无卷归属
        const forged = vol(2, 2, 10, { title: '伪首卷' })
        const bad = {
            ...payloadFor(forged, 5),
            firstVolume: { draft: forged, guard: guardOf(insp) },
        }
        const before = snapshot()
        const res = commitNextVolume(bad)
        assert(!res.success, '首卷必须是第 1 卷且从第 1 章开始')
        assert(res.error!.includes('首卷应为第 1 卷'), `实为：${res.error}`)
        assertUnchanged(before, '拒绝后')
    }, 'allowed')

    testCase('D15 孤儿分支带非法 policy（bogus）→ 枚举校验拒绝（round-06 #2）', () => {
        freshDb()
        seedFinalized(1, 10)
        seedBlueprints([11, 12, 18]) // 真孤儿
        const insp = inspectFirstVolume()
        const first = vol(1, 1, 10, { title: '第一卷' })
        const g = guardOf(insp, 'clear') as Extract<FirstVolumeGuard, { kind: 'orphan' }>
        const bad = {
            ...payloadFor(first, 3), // 新卷 11–13，盖不住孤儿末章 18
            firstVolume: {
                draft: first,
                guard: { ...g, policy: 'bogus' as never }, // 伪造策略
            },
        }
        const before = snapshot()
        const res = commitNextVolume(bad)
        assert(!res.success, "非法 policy 不能按「非 extend」混过边界推导")
        assert(res.error!.includes('孤儿处置策略非法'), `实为：${res.error}`)
        assertUnchanged(before, '拒绝后')
        // 若放行会怎样：既不触发 keep 的覆盖检查、也不执行 clear 的删除，
        // 第 18 章的蓝图将静默留在所有卷之外
    }, 'allowed')

    testCase('D16 伪造的 kind 值 → 枚举校验拒绝（round-07 #1：kind 分支此前无运行时证据）', () => {
        freshDb()
        seedFinalized(1, 10)
        seedBlueprints([1, 5, 10]) // 无孤儿，凭据合法走 none 分支
        const insp = inspectFirstVolume()
        const first = vol(1, 1, 10, { title: '第一卷' })
        // 把合法 none 凭据的 kind 篡改成任意未知值。自洽性检查只认 === 'orphan'，
        // 若没有显式的 kind 枚举校验，这种载荷会静默滑过两道分支判断、零复核提交
        const bad = {
            ...payloadFor(first, 5),
            firstVolume: {
                draft: first,
                guard: { ...guardOf(insp), kind: 'bogus' as never },
            },
        }
        const before = snapshot()
        const res = commitNextVolume(bad)
        assert(!res.success, '伪造 kind 不能落进「默认放行」路径')
        assert(res.error!.includes('kind 非法'), `实为：${res.error}`)
        assertUnchanged(before, '拒绝后')
    }, 'allowed')

    console.log('\n▶ E 组：中途异常的整体回滚')

    testCase('E1 收卷步失败（已写入删蓝图 + 建首卷）→ 全部回滚', () => {
        freshDb()
        seedFinalized(1, 10)
        seedBlueprints([11, 12])
        const insp = inspectFirstVolume()
        const first = vol(1, 1, 10, { title: '第一卷' })
        const p: CommitNextVolumePayload = { ...payloadFor(first, 5), firstVolume: { draft: first, guard: guardOf(insp, 'clear') } }
        // 让第⑥步（写上一卷收卷状态）失败：指向一个建不出来的卷号
        p.closingReport = { ...p.closingReport, volumeNumber: 99 }
        const before = snapshot()
        const res = commitNextVolume(p)
        assert(!res.success && res.error!.includes('第 99 卷不存在'), `实为：${res.error}`)
        // 关键：此时④已删蓝图、⑤已建首卷，若无事务这两项会残留
        assertUnchanged(before, '收卷步失败后（蓝图删除与首卷创建都必须回滚）')
    }, 'allowed')

    testCase('E2 最后一步 project_core 失败（前面四步都已写）→ 全部回滚', () => {
        freshDb()
        seedFinalized(1, 10)
        seedBlueprints([11, 12])
        const insp = inspectFirstVolume()
        const first = vol(1, 1, 10, { title: '第一卷' })
        const p: CommitNextVolumePayload = { ...payloadFor(first, 5), firstVolume: { draft: first, guard: guardOf(insp, 'clear') } }
        // 抽掉 project_core 主记录，让第⑧步抛错——此时④⑤⑥⑦全部已写
        getProjectDb()!.prepare(`DELETE FROM project_core WHERE id='main'`).run()
        const before = snapshot()
        const res = commitNextVolume(p)
        assert(!res.success && res.error!.includes('project_core 主记录缺失'), `实为：${res.error}`)
        assertUnchanged(before, 'project_core 步失败后（删蓝图/首卷/收卷/新卷四项都必须回滚）')
    }, 'allowed')

    testCase('E3 预览期间用户把孤儿章定稿了 → 动作②的 maxFinalized 复核拦下', () => {
        freshDb()
        seedFinalized(1, 10)
        seedBlueprints([11, 12]) // 此刻 11–12 是真孤儿
        const insp = inspectFirstVolume()
        assertEq(insp.orphan?.count, 2, '前置：应识别出 2 条孤儿')
        const first = vol(1, 1, insp.firstVolumeBase!.maxFinalized, { title: '第一卷' })
        // 用户在预览对话框开着的时候，回去把第 11 章写完并定稿了。
        // ⚠️ 本用例**测不到 deleteRange 的保护**：round-04 加了 maxFinalized 复核后，
        // 这条路径在动作②就死了（定稿数从 10 变 11，与凭据不符），根本走不到④。
        // 它现在证明的是②的边界复核；deleteRange 的「区间内不得有定稿章」保护
        // 由下方 E3b 在仓储层直测（提交入口已无法触达它）
        seedFinalized(11, 11)
        const before = snapshot()
        const res = commitNextVolume({ ...payloadFor(first, 5), firstVolume: { draft: first, guard: guardOf(insp, 'clear') } })
        assert(!res.success, '边界已变必须拒绝')
        assert(res.error!.includes('已定稿章节在你确认后发生了变化'), `实为：${res.error}`)
        assertUnchanged(before, '拒绝后')
    }, 'allowed')

    testCase('E3b deleteRange 对含定稿章的区间直接拒绝（仓储层纵深防御，不经提交入口）', () => {
        freshDb()
        seedFinalized(1, 12)
        seedBlueprints([11, 12])
        const before = snapshot()
        // round-05 之后，「凭据与库一致、却要 clear 已定稿区间」的载荷在提交入口
        // 已经构造不出来（maxFinalized 复核 + 自洽性检查双重拦截），故 deleteRange 的
        // 「区间内不得有定稿章」保护成为纯纵深防御——只能在本层直接验证
        assertThrows(() => BlueprintRepository.deleteRange(11, 12), '已定稿，不可删除其蓝图')
        assertUnchanged(before, '保护触发后')
    })

    console.log('\n▶ F 组：synopsis 库内读改写（防 lost update）')

    testCase('F1 提交前库里的 synopsis 被改过 → 以库内最新值为基准拼接，不覆盖', () => {
        freshDb()
        seedFinalized(1, 10)
        VolumeRepository.upsert(vol(1, 1, 10))
        setSynopsis('原始大纲')
        const p = payloadFor(vol(1, 1, 10), 5)
        // 模拟：渲染层拿到 payload 后，用户又编辑并保存了情节大纲
        setSynopsis('原始大纲\n\n用户后来补写的一段')
        const res = commitNextVolume(p)
        assert(res.success, `应成功，实际：${res.error}`)
        assertEq(
            getCore().synopsis,
            '原始大纲\n\n用户后来补写的一段\n\n---\n\n## 新卷\n\n新卷正文段落',
            '必须基于库内最新 synopsis 追加，用户后补的段落不能丢',
        )
        assertEq(res.synopsis, getCore().synopsis, 'IPC 返回值应与库内一致')
    })

    testCase('F2 原大纲为空时不加前导分隔线', () => {
        freshDb()
        seedFinalized(1, 10)
        VolumeRepository.upsert(vol(1, 1, 10))
        setSynopsis('')
        assert(commitNextVolume(payloadFor(vol(1, 1, 10), 5)).success, '应成功')
        assertEq(getCore().synopsis, '## 新卷\n\n新卷正文段落', '空大纲不得产生孤立的 --- 首行')
    })

    testCase('F3 收卷状态与伏笔确实写进了上一卷', () => {
        freshDb()
        seedFinalized(1, 10)
        VolumeRepository.upsert(vol(1, 1, 10))
        assert(commitNextVolume(payloadFor(vol(1, 1, 10), 5)).success, '应成功')
        const prev = VolumeRepository.get(1)!
        assertEq(prev.closingState, '主角登顶', '上一卷收卷状态')
        assertEq(prev.openThreads.length, 1, '上一卷未回收伏笔条数')
        assertEq(prev.startChapter, 1, '收卷写入不得改动上一卷边界')
        assertEq(prev.endChapter, 10, '收卷写入不得改动上一卷边界')
        assertEq(VolumeRepository.get(2)!.openingState, '主角登顶', '新卷开卷状态应继承上一卷收卷状态')
    })

    testCase('F4 返回 previousSynopsis = 追加前的库内原值（渲染层判断用户是否改过的唯一基准）', () => {
        freshDb()
        seedFinalized(1, 10)
        VolumeRepository.upsert(vol(1, 1, 10))
        setSynopsis('原始大纲')
        const res = commitNextVolume(payloadFor(vol(1, 1, 10), 5))
        assert(res.success, `应成功，实际：${res.error}`)
        assertEq(res.previousSynopsis, '原始大纲', 'previousSynopsis 必须是追加前的原值')
        assertEq(res.appendedSection, '## 新卷\n\n新卷正文段落', 'appendedSection 供渲染层在 store 已偏离时自行合并')
        assert(res.synopsis !== res.previousSynopsis, '新值应已含追加段')
        // previousSynopsis 不 trim：渲染层要拿它和内存 store 做等值比较，
        // trim 会让「store 只多一个尾随换行」被误判成用户编辑过
        freshDb()
        seedFinalized(1, 10)
        VolumeRepository.upsert(vol(1, 1, 10))
        setSynopsis('带尾随换行\n')
        assertEq(commitNextVolume(payloadFor(vol(1, 1, 10), 5)).previousSynopsis, '带尾随换行\n',
            'previousSynopsis 必须原样返回，不得 trim')
    })

    testCase('F5 结转不变量由**事务**强制：载荷台账为空也要从收卷报告派生', () => {
        freshDb()
        seedFinalized(1, 10)
        VolumeRepository.upsert(vol(1, 1, 10))
        // payloadFor 造出的正是「收卷报告含伏笔、新卷台账为空」这种不一致载荷
        //（vol() 默认 openThreads: []）。渲染层的 buildCommitPayload 会补上，
        // 但那只是个 helper，约束不了 IPC 边界——持久化不变量必须在写入层强制
        const p = payloadFor(vol(1, 1, 10), 5)
        assertEq(p.newVolume.openThreads, [], '前置：载荷里的新卷台账确实是空的')
        assert(p.closingReport.openThreads.length > 0, '前置：收卷报告确实带着伏笔')

        assert(commitNextVolume(p).success, '应成功')
        assertEq(VolumeRepository.get(2)!.openThreads, p.closingReport.openThreads,
            '新卷台账必须由事务从 closingReport 派生——否则下一卷罗盘会丢掉这些伏笔，链条无声断掉')
        assertEq(VolumeRepository.get(2)!.openingState, p.closingReport.closingState,
            '开卷状态同理，两者是同一条不变量的两个面')
        assertEq(VolumeRepository.get(1)!.openThreads, p.closingReport.openThreads,
            '上一卷保留自己那份历史快照')
    })

    console.log('\n▶ G 组：open_threads 读宽容 / 写严格')

    testCase('G1 写侧对非法值一律抛错，不静默改写', () => {
        freshDb()
        assertThrows(() => serializeOpenThreads([{ chapter: 0, thread: 'x', urgency: 'high' }], 1), '章号非法')
        assertThrows(() => serializeOpenThreads([{ chapter: 1, thread: '', urgency: 'high' }], 1), '内容为空')
        assertThrows(() => serializeOpenThreads(
            [{ chapter: 1, thread: 'x', urgency: 'urgent' as never }], 1), '优先级非法')
        assertThrows(() => serializeOpenThreads(
            [{ chapter: 1, thread: '字'.repeat(MAX_THREAD_LEN + 1), urgency: 'low' }], 1), `超过 ${MAX_THREAD_LEN} 字`)
    })

    testCase('G2 写侧条数上限与字节上限都生效', () => {
        const many = Array.from({ length: MAX_OPEN_THREADS + 1 },
            (_, i) => ({ chapter: i + 1, thread: 't', urgency: 'mid' as const }))
        assertThrows(() => serializeOpenThreads(many, 1), `超过 ${MAX_OPEN_THREADS} 条上限`)
        // 条数合法但字节超限：200 条 × 500 中文字 ≈ 300KB > 256KB
        const fat = Array.from({ length: MAX_OPEN_THREADS },
            (_, i) => ({ chapter: i + 1, thread: '字'.repeat(MAX_THREAD_LEN), urgency: 'mid' as const }))
        assert(utf8Bytes(JSON.stringify(fat)) > MAX_OPEN_THREADS_BYTES, '前置条件：该组合确应超字节上限')
        assertThrows(() => serializeOpenThreads(fat, 1), '字节上限')
    })

    testCase('G3 读侧宽容：脏条目丢弃、认不得的 urgency 归 mid、超长截断', () => {
        const raw = JSON.stringify([
            { chapter: 3, thread: '正常', urgency: 'high' },
            { chapter: -1, thread: '负章号', urgency: 'high' },   // 丢弃
            { chapter: 4, thread: '', urgency: 'high' },           // 丢弃
            { chapter: 5, thread: '未知优先级', urgency: '紧急' },  // 归 mid
            { chapter: 6, thread: '字'.repeat(MAX_THREAD_LEN + 50), urgency: 'low' }, // 截断
            'not-an-object',                                        // 丢弃
        ])
        const got = parseOpenThreads(raw)
        assertEq(got.length, 3, '应保留 3 条')
        assertEq(got[1].urgency, 'mid', '认不得的 urgency 归 mid')
        assertEq(got[2].thread.length, MAX_THREAD_LEN, '超长应截断到上限')
    })

    testCase('G4 读侧对超字节的 blob 直接按空清单处理，不 parse', () => {
        const huge = JSON.stringify(Array.from({ length: MAX_OPEN_THREADS },
            (_, i) => ({ chapter: i + 1, thread: '字'.repeat(MAX_THREAD_LEN), urgency: 'mid' })))
        assert(utf8Bytes(huge) > MAX_OPEN_THREADS_BYTES, '前置条件：确应超上限')
        assertEq(parseOpenThreads(huge), [], '超字节上限应返回空清单')
    })

    testCase('G5 落库往返：写进去什么，读出来就是什么', () => {
        freshDb()
        const threads = [
            { chapter: 1, thread: '玉佩', urgency: 'high' as const },
            { chapter: 7, thread: '师门旧怨', urgency: 'low' as const },
        ]
        VolumeRepository.upsert(vol(1, 1, 10, { openThreads: threads }))
        assertEq(VolumeRepository.get(1)!.openThreads, threads, 'open_threads 往返应完全一致')
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


try {
    main()
} catch (err) {
    console.error(`[harness] 用例「${currentCase}」之外发生未捕获异常：`, err)
    process.exit(1)
}

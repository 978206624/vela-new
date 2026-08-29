"""
mutate-19.4b2-t3.py — Task 19.4 批次二 T3（重新生成本卷大纲）的变异检验

纪律与 T1/T2 那两份完全相同，逐条抄在这里免得日后靠记性：

1. **先跑基线并强制全绿**。否则「目标用例本来就红」会让每条变异都被误记成命中。
2. **变异必须朝「让缺陷重现」的方向做**，且施加前 `assert` 原串在文件里**唯一命中**。
   栽过的反面例子：`= undefined` 让检查更容易触发、`if (false)` 被 esbuild 死代码
   消除、只挪 `emit` 没挪登记语句、加了个 no-op 却以为改了行为。
3. **try/finally 无条件按字节还原**，跑完再做一次完整性核对
   （`assert_sources_pristine`）。**绝不用手工 `cp` 备份**——上个 session 就是
   `cp` 时源码里已残留一个 `while (false)`，备份把污染状态存了下来，
   导致整整一轮的变异结论全部作废，而当时没有任何东西提示源码已脏。
4. **命中判定要同时核对「用例编号（完整 + 边界）」与「失败原因片段」**。
   只按编号子串匹配，会让「同号旧用例变红」被误记成命中
   （harness 里有 W1/W1b/W1c、S1/S10/S11 这类前缀相同的编号）。
5. **两道守卫重叠时，单独去掉任一道都不转红**。办法是给每道配专属夹具；
   若两道在数学上互为掩护，就如实标注只证明到「这一对里至少有一道生效」，
   不硬拆、也不改成能红的样子凑数。

## 本 Task 的证明力边界（如实标注，别读成「全都覆盖了」）

harness **不挂载 React 组件**（DEV-PLAN「已知问题（待排期）」已登记）。因此
`VolumeEditor.tsx` 里的这些改动**拿不到变异覆盖**，只有静态审查与人工验证：

- 生成期间各控件的 `disabled` / `readOnly`
- 渲染期采纳（`regenAdopted` 判据驱动 `setSynopsis`）
- 头部副信息、大纲区标签、四段步进器三处完成态文案
- `openVolumeDetail` 新建 Tab 时按草稿恢复 `dirty`（这条要挂载 EditorArea 才验得到）

能覆盖的是：纯函数（partial-json、区间校验）、store 状态机、service 编排、
工作流步骤、prompt 组装——下面每条变异都落在这些上面。

用法：PYTHONIOENCODING=utf-8 python scripts/diagnostics/mutate-19.4b2-t3.py
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PARTIAL = ROOT / "src" / "shared" / "partial-json.ts"
REGEN_STORE = ROOT / "src" / "stores" / "volume-regen-store.ts"
DRAFT_STORE = ROOT / "src" / "stores" / "volume-draft-store.ts"
REGEN_SVC = ROOT / "src" / "services" / "volume-regen.ts"
REGEN_WF = ROOT / "src" / "services" / "workflows" / "volume-regen-workflow.ts"
REGEN_CMD = ROOT / "src" / "services" / "workflows" / "commands" / "volume-synopsis-regen.command.ts"
VOL_CTX = ROOT / "src" / "services" / "prompts" / "volume-context.ts"

# (标签, 文件, 原串, 变异串, 期望变红的用例编号, 期望出现在失败详情里的片段)
MUTATIONS = [
    # ================================================================
    # partial-json：每一档半截形态都该有专属用例
    # ================================================================
    (
        "M1 key 未出现时返回空串而不是 null（UI 会先亮「输出中」再空等）",
        PARTIAL,
        "    const keyAt = raw.indexOf(marker)\n    if (keyAt < 0) return null",
        "    const keyAt = raw.indexOf(marker)\n    if (keyAt < 0) return ''",
        "P1",
        "期望: null",
    ),
    (
        "M2 值不是字符串（数字/null）时也当字符串开始解",
        PARTIAL,
        "    if (raw[i] !== '\"') return null\n    i++",
        "    if (raw[i] !== '\"') return ''\n    i++",
        "P3",
        "期望: null",
    ),
    (
        "M3 尾部裸反斜杠原样输出（预览会闪一下多余的 \\）",
        PARTIAL,
        "        if (i + 1 >= raw.length) return out",
        "        if (i + 1 >= raw.length) { out += ch; i++; continue }",
        "P9",
        "期望: \"a\"",
    ),
    (
        "M4 半截 \\u12 原样输出（下一段到达时会被替换掉 = 乱码闪烁）",
        PARTIAL,
        "            if (hex.length < 4) return out",
        "            if (hex.length < 4) { out += '\\\\u' + hex; i += 2 + hex.length; continue }",
        "P8",
        "期望: \"a\"",
    ),
    (
        "M5 高代理项不等低代理项就直接输出（孤立高代理 = 替换字符）",
        PARTIAL,
        "            if (code >= 0xD800 && code <= 0xDBFF) {",
        "            if (false as boolean) {",
        "P13",
        "期望: \"a\"",
    ),
    (
        "M6 孤立低代理项也照样输出",
        PARTIAL,
        "            if (code >= 0xDC00 && code <= 0xDFFF) return out",
        "            if (code >= 0xDC00 && code <= 0xDFFF) { /* 照样输出 */ }",
        "P14",
        "期望: \"a\"",
    ),
    (
        "M7 收引号不当终止符（会把后续字段一起吞进大纲）",
        PARTIAL,
        "        if (ch === '\"') return out          // 未转义的收引号 = 该字段已完整",
        "        if (ch === '\"') { out += ch; i++; continue }",
        "P4",
        "期望: \"南下的第一节：北风与旧伤\"",
    ),
    # ================================================================
    # validateVolumeRangeForRegen：四道判据各有专属夹具
    # ================================================================
    (
        "M8 去掉端点安全整数判据",
        REGEN_WF,
        "    if (!Number.isSafeInteger(volume.startChapter) || !Number.isSafeInteger(volume.endChapter)) {",
        "    if (false as boolean) {",
        "R5",
        "应报错",
    ),
    (
        "M9 去掉起点 ≥1 判据",
        REGEN_WF,
        "    if (volume.startChapter < 1) {",
        "    if (false as boolean) {",
        "R3",
        "应报错",
    ),
    (
        "M10 只拦「太长」，漏掉零长度与反向区间",
        REGEN_WF,
        "    if (span < 1 || span > MAX_VOLUME_CHAPTERS) {",
        "    if (span > MAX_VOLUME_CHAPTERS) {",
        "R2",
        "应报错",
    ),
    (
        "M11 区间上限放宽到安全整数（安全整数 ≠ 可遍历）",
        REGEN_WF,
        "    if (span < 1 || span > MAX_VOLUME_CHAPTERS) {",
        "    if (span < 1 || span > Number.MAX_SAFE_INTEGER) {",
        "R4",
        "应报错",
    ),
    # ================================================================
    # service 层：发起前置校验与归属纪律
    # ================================================================
    (
        "M12 去掉「表单脏时拒绝发起」前置校验（生成依据与用户所见不一致）",
        REGEN_SVC,
        "  if (useVolumeDraftStore.getState().get(actionToken, volume.volumeNumber) !== null) {",
        "  if (false as boolean) {",
        "S1",
        "期望: \"dirty\"",
    ),
    (
        "M13 去掉发起前的区间预检（会白起一趟工作流）",
        REGEN_SVC,
        "  const rangeError = validateVolumeRangeForRegen(volume)\n  if (rangeError) return { ok: false, reason: 'bad-range', message: rangeError }",
        "  const rangeError: string | null = null\n  if (rangeError) return { ok: false, reason: 'bad-range', message: rangeError }",
        "S5",
        "期望: \"bad-range\"",
    ),
    # ⚠️ 这里**刻意没有**「boundaryAtStart 传引用而不是值快照」那条变异。
    #
    # 试过：把 `boundaryAtStart: { startChapter: volume.startChapter, ... }` 改成
    # `boundaryAtStart: volume`，44 条里唯一一条**全绿**且无法转红的。原因是
    # zustand 的更新是不可变的（`loadAll` / `updateDetail` 都造新对象、从不原地改），
    # 于是「发起时那个 store 对象」与「一份从它复制出来的快照」在数学上等价——
    # 复核照样能发现库里的行不一样。
    #
    # 按纪律如实标注而不是改成能红的样子凑数：写成值快照的收益是**不依赖**
    # 「store 永远不做原地修改」这条外部约定（T4 就是在一个会随后台刷新更新的
    # prop 上栽的），但这条性质在当前代码里无法用变异复现。
    (
        "M15 single-flight 失效（begin 永远发号，两条并发跑）",
        REGEN_STORE,
        "    if (get().run !== null) return null\n    const regenId = ++regenSeq",
        "    const regenId = ++regenSeq",
        "W6",
        "single-flight",
    ),
    (
        "M16 草稿已存在时照样覆盖（静默吞掉用户中途的编辑）",
        DRAFT_STORE,
        "    if (get().drafts[key] !== undefined) return false",
        "    if (false as boolean) return false",
        "S6",
        "已有草稿时拒绝采纳",
    ),
    (
        "M17 采纳失败仍然 settle（result 与草稿不一致，完成态说谎）",
        REGEN_SVC,
        "  if (!adopted) {\n    settleFailed()",
        "  if (false as boolean) {\n    settleFailed()",
        "S7",
        "有草稿冒出来时必须失败",
    ),
    (
        "M18 patch 带上全部字段而不只 synopsis（会撤销后台写入的伏笔/状态）",
        DRAFT_STORE,
        "      touched: ['synopsis'],",
        "      touched: ['synopsis', 'premise', 'title', 'status', 'openThreads'],",
        "S2",
        "产物只有卷大纲一项",
    ),
    (
        "M19 settle 时不带 synopsis 原文（组件的「草稿==result」判据不成立）",
        REGEN_SVC,
        "  useVolumeRegenStore.getState().settle(regenId, result.synopsis)",
        "  useVolumeRegenStore.getState().settle(regenId, result.synopsis + ' ')",
        "S2",
        "result 与草稿必须逐字相同",
    ),
    # ================================================================
    # 结果分槽：跨卷不丢稿
    # ================================================================
    (
        "M20 settle 用整槽替换（第 1 卷完成会顶掉第 2 卷待保存的结果）",
        REGEN_STORE,
        "    set(s => ({\n      run: null,\n      results: {\n        ...s.results,\n        [key]: {",
        "    set(() => ({\n      run: null,\n      results: {\n        [key]: {",
        "S10",
        "不得顶掉第 2 卷",
    ),
    (
        "M21 begin 顺手清空全部结果槽（回到 round-02 那个缺陷）",
        REGEN_STORE,
        "    set({ run: { projectToken, volumeNumber, regenId, partial: '', modelName } })\n    return regenId",
        "    set({ run: { projectToken, volumeNumber, regenId, partial: '', modelName }, results: {} })\n    return regenId",
        "S10",
        "不得顶掉第 2 卷",
    ),
    (
        "M22 adoptResult 清掉所有槽而不只指名那一条",
        REGEN_STORE,
        "    set(s => {\n      const next = { ...s.results }\n      delete next[entry[0]]\n      return { results: next }\n    })",
        "    set({ results: {} })",
        "S10",
        "只该清掉指名的那一条",
    ),
    (
        "M23 结果归属键不带 projectToken（A 项目的结果会在 B 项目冒出来）",
        REGEN_STORE,
        "function resultKey(projectToken: number, volumeNumber: number): string {\n  return `${projectToken}:${volumeNumber}`\n}",
        "function resultKey(_projectToken: number, volumeNumber: number): string {\n  return `${volumeNumber}`\n}",
        "S18",
        "换了 token 之后旧结果不该再被本卷读到",
    ),
    (
        "M24 关闭 Tab 不清结果（重开后已放弃的 AI 大纲复活）",
        REGEN_STORE,
        "  useVolumeRegenStore.getState().discardResult(r.regenId)\n}",
        "  void r\n}",
        "S11",
        "关闭本卷 Tab 应清掉结果",
    ),
    (
        "M25 discardVolumeRegenResultForTab 不校验 tabId 形态（非卷 Tab 也清）",
        REGEN_STORE,
        "  const m = /^volume:(\\d+)$/.exec(tabId)\n  if (!m) return\n  if (projectToken === undefined) return",
        "  const m = /^volume:(\\d+)$/.exec(tabId) ?? ['', '2']\n  if (projectToken === undefined) return",
        "S11",
        "非卷 tabId 不该清",
    ),
    # ================================================================
    # 工作流：边界复核、上一卷定位、fail-closed
    # ================================================================
    (
        "M26 去掉「发起时边界 vs 库里边界」复核",
        REGEN_WF,
        "                    if (\n                        volume.startChapter !== boundaryAtStart.startChapter\n                        || volume.endChapter !== boundaryAtStart.endChapter\n                    ) {",
        "                    if (false as boolean) {",
        "S19",
        "边界不一致必须中止",
    ),
    (
        "M27 上一卷按「卷号 - 1」定位（卷号有缺口时会误判成首卷）",
        REGEN_WF,
        "                    const prev = volumes\n                        .filter(v => v.volumeNumber < volumeNumber)",
        "                    const prev = volumes\n                        .filter(v => v.volumeNumber === volumeNumber - 1)",
        "S20",
        "第三卷的上一卷应是第一卷",
    ),
    (
        "M28 「有上一卷但无收卷状态」与「无上一卷」压成一档（对第五卷谎称首卷）",
        REGEN_WF,
        "                    context.data.hasPrevVolume = prev !== null",
        "                    context.data.hasPrevVolume = (prev?.closingState ?? '').trim() !== ''",
        "W1b",
        "第二卷不得注入首卷回退文案",
    ),
    (
        "M29 命令层缺省按「无上一卷」处理（缺省方向反了）",
        REGEN_CMD,
        "        const hasPrevVolume = context.data.hasPrevVolume !== false",
        "        const hasPrevVolume = context.data.hasPrevVolume === true && false",
        "W1b",
        "第二卷不得注入首卷回退文案",
    ),
    (
        "M31 事实快照内部又把异常吞掉（吞异常的 helper 让 fail-closed 静默失效）",
        VOL_CTX,
        "    const blueprints = (await ipc.invoke('db:blueprint-get-all')) as Array<{\n        chapterNumber: number; title?: string; notes?: string; notesUpdatedAt?: string\n    }>\n    const finalized = await ipc.invoke('db:draft-list-finalized-in-range', startChapter, endChapter)",
        "    let blueprints: Array<{ chapterNumber: number; title?: string; notes?: string; notesUpdatedAt?: string }> = []\n    let finalized: Array<{ chapterNumber: number; finalizedAt: string }> = []\n    try {\n        blueprints = (await ipc.invoke('db:blueprint-get-all')) as never\n        finalized = await ipc.invoke('db:draft-list-finalized-in-range', startChapter, endChapter)\n    } catch { /* 吞掉 */ }",
        "S12",
        "读要点失败必须整体失败",
    ),
    (
        "M32 宽容版被顺手改成抛错（续卷那条可降级路径会跟着炸）",
        VOL_CTX,
        "        return await readVolumeChapterNotesStrict(startChapter, endChapter)\n    } catch {\n        return '（该卷暂无章节要点）'\n    }",
        "        return await readVolumeChapterNotesStrict(startChapter, endChapter)\n    } catch (e) {\n        throw e\n    }",
        "S13",
        "模拟的数据库读取失败",
    ),
    (
        "M33 「卷已不存在」不再拦（会拿 undefined 继续往下跑）",
        REGEN_WF,
        "                    if (!volume) {\n                        throw new Error(`第 ${volumeNumber} 卷已不存在（可能已被删除），本次生成中止`)\n                    }",
        "                    if (!volume) { /* 放行 */ }",
        "S21",
        "应说明卷已不存在",
    ),
    # ================================================================
    # prompt 组装：三处输入约束都得真的进 prompt
    # ================================================================
    (
        "M34 本卷主线不注入（AI 会自己重新定方向）",
        REGEN_CMD,
        "            .withVolumePremise(volumePremise)",
        "            .withVolumePremise('')",
        "S3",
        "prompt 应注入本卷主线",
    ),
    (
        "M35 本卷已写章节要点不注入（已写章节会被推翻）",
        REGEN_CMD,
        "            .withWrittenNotes(writtenNotes)",
        "            .withWrittenNotes('')",
        "S3",
        "prompt 应注入本卷已写章节要点正文",
    ),
    (
        "M36 流式回调不剥 JSON（把原始 JSON 串直接喂给预览）",
        REGEN_CMD,
        "                    const partial = extractPartialJSONString(full, 'synopsis')\n                    if (partial !== null) this.params.onPartial?.(partial)",
        "                    this.params.onPartial?.(full)",
        "S22",
        "预览片段不该含原始 JSON 结构",
    ),
    (
        "M37 产物解析不 trim、也不拒空（空大纲会被当成功落草稿）",
        REGEN_CMD,
        "        if (!synopsis) throw new Error('模型未返回有效的卷大纲，请重试')",
        "        void synopsis",
        "S23",
        "空大纲必须判失败",
    ),
    (
        "M38 catch 分支先 settleFailed 再判归属（真实异常被误判成 stale）",
        REGEN_SVC,
        "    const mine = stillMine()\n    settleFailed()\n    if (!mine) return { ok: false, reason: 'stale', message: '' }\n    return { ok: false, reason: 'failed', message: `重新生成失败：${e}` }",
        "    settleFailed()\n    if (!stillMine()) return { ok: false, reason: 'stale', message: '' }\n    return { ok: false, reason: 'failed', message: `重新生成失败：${e}` }",
        "S24",
        "同项目内的真实异常必须报 failed",
    ),
    # ⚠️ 这里**刻意没有**三条变异：M30 / M39 / M44。
    #
    # 它们的本意是验证「去掉保护就漏坏」，但变异后要么抛 TypeError、要么被另一道
    # 同源守卫接住——TypeError 与「另一句文案」都不是这些用例想守的东西（用例守的是
    # **这道守卫**有没有，不是有没有崩溃）。
    #
    # - M30「改用宽容版」：宽容版返回 string，调用点却按 `VolumeWrittenFacts` 解包
    #   → 访问 `.finalizedWithoutNotes.length` 时 TypeError。
    #   想验「去掉读失败保护」得改 mock 拆法——超出单点变异范围
    # - M39「去掉前置判据」：后置复核仍用另一句文案拦住，于是 S14 拿不到
    #   预期的「事实不完整必须拦下」。要同时拆后置——结构性改动
    # - M44「复核读失败时放行」：try/catch 本来就把读失败**强制为中止**
    #   ——「中止」就是这条守卫要做的事。改成「不放行」就是直接删 try/catch，
    #   那本身已超出单点变异范围
    #
    # 不硬改成能红的样子凑数：把意图留在注释里，下一轮若发现更精准的变异写法再补回。
    # ================================================================
    # 已写事实的完整性与新鲜度（Codex round-04 major）
    # ================================================================
    (
        "M40 缺要点的章从**蓝图列表**里找（无蓝图却已定稿的章会被漏掉）",
        VOL_CTX,
        "    const finalizedWithoutNotes = (finalized ?? [])\n        .filter(f => !(notesByChapter.get(f.chapterNumber) ?? '').trim())\n        .map(f => f.chapterNumber)",
        "    const finalizedWithoutNotes = inRange\n        .map(bp => bp.chapterNumber)\n        .filter(ch => !(notesByChapter.get(ch) ?? '').trim())",
        "S15",
        "无蓝图但已定稿的章同样要拦",
    ),
    (
        "M41 去掉生成后的事实复核（按过期事实生成的大纲会落地）",
        REGEN_WF,
        "                    if (after.digest !== before) {",
        "                    if (false as boolean) {",
        "S16",
        "事实变了这份大纲必须作废",
    ),
    (
        "M42 digest 恒为空串（复核变成拿空串比空串，永远相等）",
        VOL_CTX,
        "    const digest = JSON.stringify(\n        [...notesByChapter.entries()].sort((a, b) => a[0] - b[0]),\n    )",
        "    const digest = ''",
        "S16",
        "事实变了这份大纲必须作废",
    ),
    (
        "M43 digest 把标题也算进去（改个标题就让正在生成的大纲作废 = 过度敏感）",
        VOL_CTX,
        "    const digest = JSON.stringify(\n        [...notesByChapter.entries()].sort((a, b) => a[0] - b[0]),\n    )",
        "    const digest = JSON.stringify(inRange.map(bp => [bp.chapterNumber, bp.notes, bp.title, Math.random()]))",
        "S17",
        "事实没变就该放行",
    ),
    (
        "M45 后置复核只比 digest，不查「新出现的已定稿但无要点」",
        REGEN_WF,
        "                    if (after.finalizedWithoutNotes.length > 0) {",
        "                    if (false as boolean) {",
        "S26",
        "生成期间新增「已定稿但无要点」必须作废",
    ),
    (
        "M46 去掉「要点早于本次定稿」的前置判据（旧要点冒充当前事实）",
        REGEN_WF,
        "                    if (facts.finalizedWithStaleNotes.length > 0) {",
        "                    if (false as boolean) {",
        # 前置判据被去掉时，**后置复核**仍会拦住这份大纲（两道同源），
        # 于是唯一的可观测差别是「白烧了一次模型调用」——这正是前置那道的职责。
        # 故命中判据落在 `llm.calls === 0` 那条断言上，而不是错误文案上
        "S27",
        "fail-closed：一次模型调用都不该发起",
    ),
    (
        "M47 过期判据用 <= 而不是 <（要点与定稿同一秒会被误判成过期）",
        VOL_CTX,
        "            return stamp < f.finalizedAt",
        "            return stamp <= f.finalizedAt",
        "S28",
        "要点晚于定稿应放行",
    ),
    (
        "M48 时间戳缺失也算过期（手写要点的项目从此用不了重新生成）",
        VOL_CTX,
        "            if (!stamp || !f.finalizedAt) return false",
        "            if (!stamp || !f.finalizedAt) return true",
        "S29",
        "手写要点（无时间戳）不该被判成过期",
    ),
    # ⚠️ 这里**刻意没有**「定稿时间取 MIN 而非 MAX」那条变异。
    # 同章至多一条 finalized 由 `finalizeExclusive` 的事务保证，MIN 与 MAX 在
    # 合法状态下恒等，任何用例都复现不出差别。SQL 写 MAX 是防御性的
    # （真出现多条时取最严基准），这条性质无法用变异证明，如实标注而不是
    # 造一个事务禁止的夹具去凑红。
]


def run_harness():
    p = subprocess.run(
        ["npm", "run", "harness:volume-regen"],
        cwd=ROOT, capture_output=True, shell=True,
    )
    return p.returncode, p.stdout.decode("utf-8", "replace")


def failure_blocks(out):
    """把 harness 的失败输出切成 (编号+名称, 详情文本) 的块。

    输出形如：
        ✅ P1 ...
        ❌ S2 名称
               断言消息（可能多行）
    故从 `❌ ` 开始收，直到遇到下一条 ✅/❌ 或分隔线为止。
    """
    blocks = []
    lines = out.splitlines()
    i = 0
    while i < len(lines):
        s = lines[i].strip()
        if s.startswith("❌ "):
            head = s
            detail = []
            i += 1
            while i < len(lines):
                nxt = lines[i].strip()
                if nxt.startswith("✅ ") or nxt.startswith("❌ ") or nxt.startswith("==="):
                    break
                detail.append(nxt)
                i += 1
            blocks.append((head, "\n".join(detail)))
        else:
            i += 1
    return blocks


def hit_exact(blocks, case_id, reason_fragment):
    """既要编号完全对上（含尾随空格边界，防 P1 命中 P11/P13），也要失败原因对上。"""
    prefix = f"❌ {case_id} "
    for head, detail in blocks:
        if head.startswith(prefix) and reason_fragment in f"{head}\n{detail}":
            return True
    return False


def assert_sources_pristine(snapshots):
    """全部跑完后核对每个被变异过的文件与开跑前**逐字节相同**。

    per-mutation 的 try/finally 已经会还原，这一道是兜底：本项目真实发生过
    「源码里残留一个 while (false)，随后几轮的变异结论全部作废」——
    而当时没有任何东西提示源码已脏，是靠人工比对才发现的。
    """
    dirty = [p.name for p, b in snapshots.items() if p.read_bytes() != b]
    if dirty:
        print("")
        print(f"[X] 变异未还原干净，以下文件与开跑前不一致：{dirty}")
        print("   本轮所有结论都不可信，请先用 git 恢复这些文件再重跑。")
        sys.exit(3)
    print("[OK] 源码完整性核对通过：所有被变异文件已逐字节还原")


def main():
    sys.stdout.reconfigure(encoding="utf-8")

    # 可选：命令行给若干标签前缀（如 `M33`），只跑这几条。
    # 跑一轮全量 40–60 分钟，为核对一条改动重跑全量不划算；
    # ⚠️ 但**结论只能按全量那一轮记**——单跑不构成「这一轮全中」的证据
    only = [a for a in sys.argv[1:] if not a.startswith("-")]
    selected = [m for m in MUTATIONS if not only or any(m[0].startswith(t) for t in only)]
    if only:
        print(f"[!] 只跑 {len(selected)} 条：{[m[0].split()[0] for m in selected]}")

    print("=== 基线（未变异）===")
    code, out = run_harness()
    if code != 0:
        print(f"  退出码 {code}，基线本身就是红的，变异检验无从谈起：")
        for head, _ in failure_blocks(out):
            print(f"  {head}")
        sys.exit(2)
    print("  退出码 0，基线全绿，可以开始变异")

    # 开跑前的字节快照，跑完逐一核对（见 assert_sources_pristine）
    snapshots = {m[1]: m[1].read_bytes() for m in selected}

    # ⚠️ **先把所有原串校验一遍，再开始逐条施加**。
    # 曾经是「边跑边 assert」：某条的原串因源码演进而失配时，assert 在跑到那一条
    # 才抛出、整个进程随之中止——per-mutation 的 try/finally 保住了已施加的那些，
    # 但 `assert_sources_pristine` 那道兜底核对**根本来不及执行**，
    # 于是「源码到底干净没有」只能靠人工比对（正是纪律第 3 条要消灭的状态）。
    # 本 Task 真实发生过一次：M31 的原串因 `readVolumeWrittenFacts` 加了一个字段而失配。
    preflight = []
    for label, path, old, _new, _expect, _reason in selected:
        text = path.read_bytes().decode("utf-8")
        crlf_ = chr(13) + chr(10)
        o = old.replace(chr(10), crlf_) if crlf_ in text else old
        cnt = text.count(o)
        if cnt != 1:
            preflight.append(f"{label}: 原串在 {path.name} 命中 {cnt} 次（需恰好 1 次）")
    if preflight:
        print("")
        print("[X] 预检失败，本轮一条都不跑（源码未被改动）：")
        for line in preflight:
            print(f"   - {line}")
        print("   原因通常是源码演进后原串失配——请先更新变异条目再重跑。")
        sys.exit(4)
    print(f"[OK] 预检通过：{len(selected)} 条原串各自唯一命中")

    results = []
    for label, path, old, new, expect, reason in selected:
        # ⚠️ 按**原始字节**读写。`read_text`/`write_text` 在 Windows 上默认做换行
        # 转换（读时 CRLF→LF、写时 LF→os.linesep），对 LF 源文件会整体改成 CRLF——
        # 变异检验不该有任何副作用，还原也必须字节级一致
        src = path.read_bytes()
        text = src.decode("utf-8")
        # 原串按源文件实际换行归一，免得 LF 写法在 CRLF 文件里匹配不到
        crlf = chr(13) + chr(10)
        o, n = old, new
        if crlf in text:
            o = o.replace(chr(10), crlf)
            n = n.replace(chr(10), crlf)
        assert o in text, f"{label}: 原串未命中 {path.name}，变异未生效"
        assert text.count(o) == 1, f"{label}: 原串在 {path.name} 命中 {text.count(o)} 次，需唯一"
        try:
            path.write_bytes(text.replace(o, n).encode("utf-8"))
            code, out = run_harness()
            blocks = failure_blocks(out)
            hit = hit_exact(blocks, expect, reason)
            results.append((label, expect, reason, code != 0, hit))
            print(f"\n=== {label} ===")
            print(f"  退出码 {code}（0=全绿，说明变异没被抓住）")
            for head, detail in blocks:
                print(f"  {head}")
                if detail:
                    print(f"      {detail.splitlines()[0]}")
        finally:
            path.write_bytes(src)

    assert_sources_pristine(snapshots)
    print("\n" + "=" * 60)
    ok = True
    for label, expect, reason, went_red, hit in results:
        good = went_red and hit
        ok = ok and good
        print(f"{'✅' if good else '❌'} {label} → 期望 {expect} 因「{reason}」变红："
              f"整体{'红' if went_red else '绿'}，{'命中' if hit else '未命中'}")
    sys.exit(0 if ok else 1)


main()

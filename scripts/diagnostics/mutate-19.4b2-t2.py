"""
mutate-19.4b2-t2.py — Task 19.4 批次二 T2（卷详情编辑器）的变异检验

纪律与 T1 那份相同：
1. 先跑基线并强制全绿（否则「目标用例本来就红」会让每条变异都被误记成命中）
2. 变异朝「让缺陷重现」的方向做，施加前 assert 原串唯一命中
3. try/finally 无条件还原
4. 命中判定按完整编号 + 尾随空格边界（harness 里有 X20b/X21b/X23b 这类后缀编号）

第 5 条是 Codex 在 T2 round-01 指出的补强：
5. **不只认用例编号，还要认失败原因**。harness 的失败输出是
   `  ❌ <名称>\\n       <断言消息>`，只看编号的话，目标用例因导入错误、
   或因同一用例里**另一条**断言失败而变红，都会被记成「这条变异被抓住了」。
   故每条变异额外声明一段期望出现在失败详情里的文字。

用法：python scripts/diagnostics/mutate-19.4b2-t2.py
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SERVICE = ROOT / "src" / "services" / "volume-service.ts"
LIMITS = ROOT / "src" / "shared" / "volume-limits.ts"
REPO = ROOT / "electron" / "repositories" / "volume-repository.ts"
DRAFT_STORE = ROOT / "src" / "stores" / "volume-draft-store.ts"
VOLUME_STORE = ROOT / "src" / "stores" / "volume-store.ts"
DIR_CMD = ROOT / "src" / "services" / "workflows" / "commands" / "directory.command.ts"

# ⚠️ 关于 M14 的证明力边界（Codex T2 round-04 指出，如实记下）：
# 旧写法的缺陷是「跳过同步但**照样推进 syncedFrom 游标**」，而游标推进发生在
# 组件渲染体里，不在 decideVolumeSnapshotSync 内——**任何对该纯函数的变异都复现不了它**。
# M14 证明的只是「'none' 与 'wait' 在真值表上可辨」，不要把它读成「旧缺陷会被抓住」。
# 真正挡住旧缺陷的是把游标推进收进 'adopt' 分支这一结构改动，
# 而它属于组件渲染体，本 harness 不挂载 React 组件，覆盖不到。
# (标签, 文件, 原串, 变异串, 期望变红的用例编号, 期望出现在失败详情里的片段)
MUTATIONS = [
    # ---- validateVolumeRange 的四道判据，各有专属夹具，去掉任一道都该单独转红 ----
    (
        "M1 去掉起始章的安全整数判据",
        LIMITS,
        "  if (!Number.isSafeInteger(startChapter) || startChapter < 1) {\n    return '起始章号非法，须为 ≥1 的整数'\n  }\n",
        "",
        "X28",
        "parseChapterNumber 返回 NaN 或小数时必须拦下",
    ),
    (
        "M2 去掉结束章的安全整数判据",
        LIMITS,
        "  if (!Number.isSafeInteger(endChapter) || endChapter < 1) {\n    return '结束章号非法，须为 ≥1 的整数'\n  }\n",
        "",
        "X28",
        "结束章同样要按安全整数验",
    ),
    (
        "M3 去掉反向区间判据",
        LIMITS,
        "  if (endChapter < startChapter) {\n    return `结束章（第 ${endChapter} 章）不能小于起始章（第 ${startChapter} 章）`\n  }\n",
        "",
        "X28",
        "反向区间只有第三道能拦",
    ),
    (
        "M4 去掉区间长度上限（安全整数 ≠ 可遍历）",
        LIMITS,
        "  if (span > MAX_VOLUME_CHAPTERS) {",
        "  if (span > Number.MAX_SAFE_INTEGER) {",
        "X28",
        "超长区间只有第四道能拦",
    ),
    # ---- buildVolumeSavePayload 的不变量 ----
    (
        "M5 收卷状态又混回 patch（回到会被并发覆盖的老写法）",
        SERVICE,
        "    if (has('openingState')) patch.openingState = form.openingState",
        "    if (has('openingState')) patch.openingState = form.openingState\n    ;(patch as { closingState?: string }).closingState = ''",
        "X29",
        "收卷状态不得出现在卷详情 patch 里",
    ),
    (
        "M6 卷名不 trim",
        SERVICE,
        "    if (has('title')) patch.title = form.title.trim()",
        "    if (has('title')) patch.title = form.title",
        "X29",
        "卷名要 trim",
    ),
    (
        "M7 空白伏笔行不剔除",
        SERVICE,
        "        patch.openThreads = form.openThreads\n            .filter(t => t.thread.trim())\n            .map(t => ({ chapter: t.chapter, thread: t.thread, urgency: t.urgency }))",
        "        patch.openThreads = form.openThreads\n            .map(t => ({ chapter: t.chapter, thread: t.thread, urgency: t.urgency }))",
        "X29",
        "内容为空白的伏笔行必须剔除",
    ),
    (
        "M8 展开整行导致 _id 混进落库载荷",
        SERVICE,
        "            .map(t => ({ chapter: t.chapter, thread: t.thread, urgency: t.urgency }))",
        "            .map(t => ({ ...t }))",
        "X29",
        "落库载荷只能有 chapter/thread/urgency 三个字段",
    ),
    (
        "M9 无视 touched，整表提交（撤销后台写入的 status / openThreads）",
        SERVICE,
        "    const has = (f: VolumeDetailField) => touched.includes(f)",
        "    const has = (_f: VolumeDetailField) => true",
        "X29",
        "只改大纲时，patch 里除卷序号外只能有 synopsis",
    ),
    # ---- updateDetail 事务 ----
    (
        "M10 updateDetail 的 SET 列表混进 closing_state",
        REPO,
        "        if (sets.length === 0) {",
        "        sets.push(\"closing_state = ''\")\n        if (sets.length === 0) {",
        "X30",
        "收卷状态必须原封不动",
    ),
    (
        "M11 updateDetail 对不存在的卷不再短路返回 false",
        REPO,
        "            const exists = db.prepare('SELECT 1 FROM volumes WHERE volume_number = ?')\n                .get(patch.volumeNumber)\n            if (!exists) return null\n",
        "",
        "X30",
        # 去掉 exists 那道之后，第 99 卷会先撞上区间重叠校验并**抛错**，
        # 故失败详情是这条抛出来的消息，而不是用例里那句 assertEq 文案
        "第 99 卷区间 101–160 与第 2 卷",
    ),
    (
        "M12 只给一端边界时静默放行，而不是拒绝",
        REPO,
        "            throw new Error('修改卷边界时必须同时提供起始章与结束章')",
        "            // mutated: 静默放行",
        "X30",
        "只给一端边界应被明确拒绝",
    ),
    # ---- 后台快照同步判据 ----
    (
        "M13 脏时返回 adopt（覆盖用户正在打的字）",
        SERVICE,
        "    return dirty ? 'wait' : 'adopt'",
        "    return 'adopt'",
        "X31",
        "脏的时候必须等",
    ),
    (
        "M14 脏时返回 none（真值表可辨；**不**等价于旧写法，见脚注）",
        SERVICE,
        "    if (!snapshotChanged) return 'none'",
        "    if (!snapshotChanged || dirty) return 'none'",
        "X31",
        "脏的时候必须等",
    ),
    # ---- 草稿 store 的共享契约 ----
    (
        "M15 全部确认后不清草稿（保存完仍显示未保存）",
        DRAFT_STORE,
        "    if (stillPending.length === 0) {",
        "    if (stillPending.length === -1) {",
        "X32",
        "没人再改过时应全部确认并清空草稿",
    ),
    (
        "M16 确认时无视逐字段戳，只要在 savedFields 里就摘掉",
        DRAFT_STORE,
        "      f => !(savedFields.includes(f) && now[f] === stampsAtSave[f]),",
        "      f => !savedFields.includes(f),",
        "X32",
        "该字段在保存期间又被改过，不能当成已保存",
    ),
    (
        "M17 确认时退回整卷判定：期间动过任何字段就一个都不摘",
        DRAFT_STORE,
        "      f => !(savedFields.includes(f) && now[f] === stampsAtSave[f]),",
        "      f => !(savedFields.includes(f) && JSON.stringify(now) === JSON.stringify(stampsAtSave)),",
        "X32",
        "已落库的 openThreads 必须从 touched 里摘掉",
    ),
    (
        "M18 租约不去重（保存在途仍可再次发起，旧 patch 被提交两次）",
        DRAFT_STORE,
        "    if (get().leases[key]) return null",
        "",
        "X32",
        "占用期间必须拒绝第二次发起",
    ),
    (
        "M19 任意 id 都能释放租约（single-flight 形同虚设）",
        DRAFT_STORE,
        "      if (s.leases[key]?.id !== leaseId) return {}",
        "",
        "X32",
        "id 不匹配的回包不得释放占用",
    ),
    # ---- 写入成功后必须直接合并整行 ----
    (
        "M20 退回「写完再发一次 loadAll」（刷新失败/被顶掉时留下过期表单）",
        VOLUME_STORE,
        "      if (res.success && res.volume && getProjectToken() === token && myGate === writeGate) {",
        "      if (false) {",
        "X33",
        # 合并被跳过后**一次刷新都不会发生**，第一条断言（用户刚存的值）就先红了
        "store 里要有用户刚存的值",
    ),
    (
        "M21 返回的整行漏掉本次没碰过的列（渲染层合并后仍是残缺行）",
        REPO,
            "            return row ? rowToData(row) : null",
            "            return row ? { ...rowToData(row), closingState: '' } : null",
        "X30",
        "返回的整行要带上本次没碰过的列",
    ),
    # ---- 在途旧刷新的行级叠加 ----
    (
        "M22 不登记行级叠加（在途旧刷新把合并结果盖回旧值）",
        VOLUME_STORE,
        "        mergedRows.set(merged.volumeNumber, { row: merged, atSeq: writeCutoff })",
        "",
        "X34",
        "不得覆盖已合并的新行",
    ),
    (
        "M23 退回 loadSeq++ 作废在途请求（store 永久卡在 loading）",
        VOLUME_STORE,
        "        mergedRows.set(merged.volumeNumber, { row: merged, atSeq: writeCutoff })",
        "        loadSeq++",
        "X34",
        "store 不得被卡在 loading",
    ),
    (
        "M24 叠加永不失效（保存后发起的合法刷新被旧行钉住）",
        VOLUME_STORE,
        "        if (seq <= m.atSeq) {",
        "        if (true) {",
        "X34",
        "发起于写入之后的刷新必须正常落地",
    ),
    # ---- 读写交叠的消歧 ----
    # ⚠️ 这里**刻意没有**「atSeq 取回包时的 loadSeq」这条变异。
    # 试过，它不转红——因为刷新已被 pendingDetailWrites 推迟到写入结束之后，
    # 被推迟的那次读取要等写完才取序号，于是合并那一刻 loadSeq === writeCutoff，
    # 两种写法**在当前结构下完全等价**，任何夹具都区分不开。
    # 换言之 writeCutoff 是「推迟」之上的第二道保险（万一将来有人去掉推迟，
    # 它仍能把窗口收窄），但它本身**没有**变异覆盖——如实记在这里，不假装有。
    (
        "M26 刷新不再等待在途的详情写入（读写交叠重新出现）",
        VOLUME_STORE,
        "    while (myGate.pending > 0) {",
        "    while (false) {",
        "X35",
        "详情写入在途时，刷新必须先等着，不能抢跑",
    ),
    # ---- 写入闸门的换代隔离 ----
    (
        "M27 reset 不换代，只放行等待者（等待者重新入队，堵死新项目加载）",
        VOLUME_STORE,
        "    writeGate = { pending: 0, waiters: [] }\n    releaseGate(staleGate)",
        "    releaseGate(staleGate)",
        "X36",
        # 闸门不换代时，等待者重新入队 → 卡在第一条有界等待上，
        # 后面那条「B 的首次加载」根本走不到。如实按实际先红的那条写
        "reset 后 A 的刷新必须立刻退出",
    ),
    (
        "M28 等待者醒来不检查换代（reset 后仍继续等旧项目的写入）",
        VOLUME_STORE,
        "      if (myGate !== writeGate) return\n    }\n    if (myGate !== writeGate) return",
        "      if (false) return\n    }\n    if (false) return",
        "X36",
        "reset 后 A 的刷新必须立刻退出",
    ),
    # ---- 蓝图按卷分组（T4）----
    (
        "M29 去掉零卷快路径（零卷 + 空列表时返回零组，界面上连「未分卷」都没有）",
        SERVICE,
        "    if (vols.length === 0) return [{ volume: null, items: [...items] }]",
        "",
        "X37",
        "零卷且无条目时也必须返回一个空组",
    ),
    (
        "M30 越界章节被丢弃（孤儿蓝图在界面上凭空消失）",
        SERVICE,
        "        else orphans.push(item)",
        "        // mutated: 丢弃",
        "X37",
        "越界章节必须归入未归卷组",
    ),
    (
        "M31 空卷不保留分组头（「这一卷还没生成蓝图」这条信息丢了）",
        SERVICE,
        "    const result = groups",
        "    const result = groups.filter(g => g.items.length > 0)",
        "X37",
        "空卷必须保留分组头",
    ),
    (
        "M32 不按卷序号排序（组头顺序跟着调用方数组乱跳）",
        SERVICE,
        "    const ordered = [...vols].sort((a, b) => a.volumeNumber - b.volumeNumber)",
        "    const ordered = [...vols]",
        "X37",
        "分组按卷序号升序",
    ),
    # ---- 目录生成区间上限（T4）----
    (
        "M33 去掉单次生成章数上限（零卷项目可进入近乎无界的按批 LLM 循环）",
        LIMITS,
        "  if (count > MAX_DIRECTORY_CHAPTERS) {",
        "  if (count > Number.MAX_SAFE_INTEGER) {",
        "X38",
        "超上限只有第三道能拦",
    ),
    (
        "M34 去掉派生末章的越界校验",
        LIMITS,
        "  if (!Number.isSafeInteger(startChapter + count - 1)) {",
        "  if (false) {",
        "X38",
        "相加越界时只有第四道能拦",
    ),
    # ⚠️ 这里**刻意没有**「count 的 isSafeInteger 放宽成 isInteger」那条变异。
    # 试过，不转红：任何「是整数但不安全」的值都 ≥ 2^53，必然 > MAX_DIRECTORY_CHAPTERS，
    # 于是第三道（上限）总会先接住它——两道在**数学上互为掩护**，构造不出专属夹具。
    # 第二道真正独有的作用是拦**非整数**（1.5），那一格由 X38 的②号夹具证明。
    # ---- 命令层：先验原始参数，再推导 ----
    (
        "M36 回落用条数+1 而非最大章号+1（有缺口时覆盖已有蓝图）",
        DIR_CMD,
        "      startChapter = this.params.startChapter ?? (maxExisting + 1)",
        "      startChapter = this.params.startChapter ?? (existingBlueprints.length + 1)",
        "X39",
        "回落起点应为最大章号+1=104",
    ),
    (
        "M37 显式非法起点被回落改写后放行",
        DIR_CMD,
        "    if (raw.startChapter !== undefined",
        "    if (false && raw.startChapter !== undefined",
        "X39",
        "显式 startChapter=0 必须按原值报错",
    ),
    (
        "M38 超上限先被 Math.min 钳到全书章数再放行",
        DIR_CMD,
        "      if (raw.count > MAX_DIRECTORY_CHAPTERS) {",
        "      if (false) {",
        "X39",
        "count 超上限必须拒绝原始请求",
    ),
]


def run_harness():
    p = subprocess.run(
        ["npm", "run", "harness:volume-workflow"],
        cwd=ROOT, capture_output=True, shell=True,
    )
    return p.returncode, p.stdout.decode("utf-8", "replace")


def failure_blocks(out):
    """把 harness 的失败输出切成 {编号+名称: 详情文本} 的块。

    输出形如：
        ✅ X28 ...
        ❌ X29 名称
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
    """既要编号完全对上（含尾随空格边界，防 X28 命中 X28b），也要失败原因对上。"""
    prefix = f"❌ {case_id} "
    for head, detail in blocks:
        if head.startswith(prefix) and reason_fragment in f"{head}\n{detail}":
            return True
    return False




def assert_sources_pristine(snapshots):
    """全部跑完后核对每个被变异过的文件与开跑前**逐字节相同**。

    per-mutation 的 try/finally 已经会还原，这一道是兜底：本 Task 真实发生过
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

    print("=== 基线（未变异）===")
    code, out = run_harness()
    if code != 0:
        print(f"  退出码 {code}，基线本身就是红的，变异检验无从谈起：")
        for head, _ in failure_blocks(out):
            print(f"  {head}")
        sys.exit(2)
    print("  退出码 0，基线全绿，可以开始变异")

    # 开跑前的字节快照，跑完逐一核对（见 assert_sources_pristine）
    snapshots = {m[1]: m[1].read_bytes() for m in MUTATIONS}

    results = []
    for label, path, old, new, expect, reason in MUTATIONS:
        # ⚠️ 按**原始字节**读写。`read_text`/`write_text` 在 Windows 上默认做换行
        # 转换（读时 CRLF→LF、写时 LF→os.linesep），对 LF 源文件会整体改成 CRLF——
        # 变异检验不该有任何副作用，还原也必须字节级一致
        src = path.read_bytes()
        text = src.decode("utf-8")
        # 原串按源文件实际换行归一，免得 LF 写法在 CRLF 文件里匹配不到
        crlf = chr(13) + chr(10)
        if crlf in text:
            old = old.replace(chr(10), crlf)
            new = new.replace(chr(10), crlf)
        assert old in text, f"{label}: 原串未命中 {path.name}，变异未生效"
        assert text.count(old) == 1, f"{label}: 原串在 {path.name} 命中 {text.count(old)} 次，需唯一"
        try:
            path.write_bytes(text.replace(old, new).encode("utf-8"))
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

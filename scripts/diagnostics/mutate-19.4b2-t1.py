"""
mutate-19.4b2-t1.py — Task 19.4 批次二 T1 的变异检验

三条纪律，都是这个 Task 用代价换来的：
1. **先跑基线并强制全绿**。不验基线的话，目标用例若已因无关回归变红，
   每一条变异都会被报告成「成功抓住」——而它们其实一个新失败都没造成。
2. **变异朝「让缺陷重现」的方向做，施加前 assert 原串唯一命中**，否则等于空转。
3. **try/finally 无条件还原**。曾经被中断后把变异留在源码里过。

另外，命中判定按**完整编号 + 边界**匹配（`❌ X24 `），不用子串：
harness 里已经有 X20–X23 与 X20b/X20c/X20d 等编号，子串匹配会让
「旧的同编号用例变红」被误记成「新用例抓住了变异」。

用法：python scripts/diagnostics/mutate-19.4b2-t1.py
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SERVICE = ROOT / "src" / "services" / "volume-service.ts"
FLOW = ROOT / "src" / "services" / "volume-flow.ts"

# (标签, 文件, 原串, 变异串, 期望变红的用例编号)
MUTATIONS = [
    (
        "M1 去掉区间上界",
        SERVICE,
        "        if (c < startChapter || c > endChapter) continue",
        "        if (c < startChapter) continue",
        "X24",
    ),
    (
        "M2 去掉区间下界",
        SERVICE,
        "        if (c < startChapter || c > endChapter) continue",
        "        if (c > endChapter) continue",
        "X24",
    ),
    (
        "M3 放宽定稿判据（有草稿就算已写）",
        SERVICE,
        "    !!drafts?.some(d => d.status === 'finalized')",
        "    !!drafts?.some(() => true)",
        "X24",
    ),
    (
        "M4 去掉 project-switched 的静默分支",
        FLOW,
        "  if (res.reason === 'project-switched') return null\n",
        "",
        "X26",
    ),
    (
        "M5 摘要只看 premise，不回落 synopsis",
        SERVICE,
        "    return v.premise?.trim() || v.synopsis?.trim() || ''",
        "    return v.premise?.trim() || ''",
        "X27",
    ),
    (
        "M6 无大纲的卷一律报「—」，隐藏已补录的伏笔",
        SERVICE,
        "    if (count > 0) return count\n    return getVolumeSummary(v) ? 0 : null",
        "    if (!getVolumeSummary(v)) return null\n    return count",
        "X27",
    ),
    (
        "M7 有大纲且 0 条时也报「—」（把确定的零伪装成未知）",
        SERVICE,
        "    if (count > 0) return count\n    return getVolumeSummary(v) ? 0 : null",
        "    return count > 0 ? count : null",
        "X27",
    ),
    (
        "M8 有卷时仍取 novelConfig 的总章数（丢掉「卷表为准」）",
        SERVICE,
        "    if (vols.length === 0) return fallbackTotal\n    return vols.reduce((max, v) => Math.max(max, v.endChapter), 0)",
        "    return fallbackTotal",
        "X27",
    ),
]


def run_harness():
    p = subprocess.run(
        ["npm", "run", "harness:volume-workflow"],
        cwd=ROOT, capture_output=True, shell=True,
    )
    return p.returncode, p.stdout.decode("utf-8", "replace")


def failure_lines(out):
    return [ln.strip() for ln in out.splitlines() if "❌" in ln]


def hit_exact(lines, case_id):
    """按完整编号 + 尾随空格匹配，避免 X24 命中 X24b、或命中既有的同号旧用例。"""
    prefix = f"❌ {case_id} "
    return any(ln.startswith(prefix) for ln in lines)




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
        for ln in failure_lines(out):
            print(f"  {ln}")
        sys.exit(2)
    print("  退出码 0，基线全绿，可以开始变异")

    # 开跑前的字节快照，跑完逐一核对（见 assert_sources_pristine）
    snapshots = {m[1]: m[1].read_bytes() for m in MUTATIONS}

    results = []
    for label, path, old, new, expect in MUTATIONS:
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
            lines = failure_lines(out)
            hit = hit_exact(lines, expect)
            results.append((label, expect, code != 0, hit))
            print(f"\n=== {label} ===")
            print(f"  退出码 {code}（0=全绿，说明变异没被抓住）")
            for ln in lines:
                print(f"  {ln}")
        finally:
            path.write_bytes(src)

    assert_sources_pristine(snapshots)
    print("\n" + "=" * 60)
    ok = True
    for label, expect, went_red, hit in results:
        good = went_red and hit
        ok = ok and good
        print(f"{'✅' if good else '❌'} {label} → 期望 {expect} 变红："
              f"整体{'红' if went_red else '绿'}，{expect} {'命中' if hit else '未命中'}")
    sys.exit(0 if ok else 1)


main()

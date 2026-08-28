/**
 * volume-limits — 分卷相关的数值上限（Phase 19）
 *
 * 放在 `src/shared/` 而非 `electron/repositories/volume-threads.ts`，是为了让
 * **渲染层与主进程共用同一组常量而不打破进程边界**。
 *
 * 本项目的跨边界约定：`electron/ → src/shared/` 是正向依赖（多个 controller
 * 已如此 import `ipc-channels`）；反向的 `src/ → electron/` **只允许 `import type`**
 * （编译期擦除）。若渲染层对 `electron/repositories/volume-threads.ts` 做**值导入**，
 * 整个仓储模块会被打进渲染进程 bundle，连带拖入 better-sqlite3 等主进程依赖；
 * 而这类 Node-only 引用 tsc 与 eslint 都不报，只在运行时炸。
 * 限额既然两侧都要用，就必须住在 `src/shared/`，度量函数同理。
 */

/**
 * 单卷章数上限。
 *
 * 这不是「怕用户写太长」，而是**可遍历性**的兜底。本上限存在之前，
 * 卷边界只要两端是安全整数就能合法存在，而 `start=11, end=MAX_SAFE_INTEGER`
 * 这种区间会让任何「按区间逐章处理」的代码跑 9 千万亿次。
 * 主要防线是让那些地方改成**按实际记录遍历**（见 `readVolumeChapterNotes`），
 * 本上限是第二道：它让非法值在**用户输入时**就被拒绝，
 * 而不是等某处忘了改成按记录遍历才炸。
 * 注意上限只约束**新写入**——老库与外部导入的库里仍可能有超长卷，
 * 故按记录遍历那道不能省。
 *
 * 取 10000：一卷一万章已远超任何现实写法（全书百万字约 300–400 章），
 * 卡在这里的一定是误输入。
 */
export const MAX_VOLUME_CHAPTERS = 10000

/** 单卷未回收伏笔的条数上限 */
export const MAX_OPEN_THREADS = 200

/** 单条伏笔内容的字数上限 */
export const MAX_THREAD_LEN = 500

/**
 * `open_threads` JSON 的 **UTF-8 字节**上限。
 * 必须按字节算——`String.length` 是 UTF-16 code unit，中文下同样的「长度」
 * 实际可达约三倍字节数，上限会形同虚设。
 */
export const MAX_OPEN_THREADS_BYTES = 256 * 1024

/**
 * 量一个字符串的 **UTF-8 字节数**，主进程与渲染层通用。
 *
 * 主进程有 `Buffer.byteLength`，渲染层没有（`nodeIntegration: false`）。
 * `TextEncoder` 是 Web 标准，Node 18+ 与 Chromium 都内置，两侧结果一致，
 * 故限额校验放在任一侧都能得到相同判定——这正是常量与度量方式必须同源的原因。
 */
export function utf8Bytes(s: string): number {
    return new TextEncoder().encode(s).length
}

/** 校验用的最小伏笔形状。与仓储层的 `OpenThread` 结构一致，但不依赖它 */
interface ThreadLike {
  chapter: number
  thread: string
  urgency: string
}

/** 伏笔优先级的合法取值，与仓储层 `assertThreadForWrite` 同一套 */
export const THREAD_URGENCIES = ['high', 'mid', 'low'] as const

/**
 * 解析章号输入框里的原始字符串，非法返回 `NaN`。
 *
 * 与 `parseChapterCount` 同理：**不能用 `parseInt`**。
 * `Number.parseInt('1.5', 10) === 1`、`Number.parseInt('1e21', 10) === 1`——
 * 用户粘一个 `1.5` 进去，系统当成第 1 章存下来，而他毫不知情。
 */
export function parseChapterNumber(raw: string): number {
  if (raw.trim() === '') return Number.NaN
  const n = Number(raw)
  return Number.isSafeInteger(n) && n >= 1 ? n : Number.NaN
}

/**
 * 提交前的伏笔清单校验，返回空串表示通过。
 *
 * 放在 shared 而不是对话框组件里，有两个理由：
 * ① 它是**纯逻辑**，留在组件里就只能靠人工点；
 * ② 将来卷详情编辑器（Task 19.4 后续批次）也要补录伏笔，两处必须同一套判据——
 *    各写一份迟早分叉，而分叉的那一份会放行主进程要拒绝的内容。
 *
 * ⚠️ **逐条合规 ≠ 整体合规**：200 条 × 500 个中文字符各自都在限内，
 * 序列化后约 30 万字节，仍超 256KB 上限。字节这一道必须单独查。
 */
export function validateOpenThreads(threads: ThreadLike[]): string {
  if (threads.length > MAX_OPEN_THREADS) {
    return `伏笔最多 ${MAX_OPEN_THREADS} 条，当前 ${threads.length} 条`
  }
  for (let i = 0; i < threads.length; i++) {
    const t = threads[i]
    // ⚠️ 长度按 **trim 后**量，与仓储层同口径。
    // 不 trim 的话，带首尾空白的边界输入会被 UI 拒绝、而仓储层本来会接受——
    // 「同一套判据」就不成立了，用户被一个不存在的规则挡住
    const body = t.thread.trim()
    if (!body) return `第 ${i + 1} 条伏笔内容为空`
    if (body.length > MAX_THREAD_LEN) {
      return `第 ${i + 1} 条伏笔超过 ${MAX_THREAD_LEN} 字（当前 ${body.length} 字）`
    }
    // `isSafeInteger`：`Number.isInteger(1e21)` 为真，而那种章号一旦落库，
    // 所有做章号加减的地方都会静默出错
    if (!Number.isSafeInteger(t.chapter) || t.chapter < 1) return `第 ${i + 1} 条伏笔的章号非法`
    // 仓储层 `assertThreadForWrite` 会拒绝列表外的 urgency。这里漏验的话，
    // 「与仓储层同一套判据」就是空话——预检放行、提交时被底层拒绝
    if (!(THREAD_URGENCIES as readonly string[]).includes(t.urgency)) {
      return `第 ${i + 1} 条伏笔的优先级非法：${t.urgency}`
    }
  }
  // 字节数必须按**仓储层实际序列化的形态**量，两点：
  // ① 它存的是 trim 过的内容；
  // ② 它**只存 chapter/thread/urgency 三个字段**。
  //    这里若用 `{ ...t }` 展开，调用方挂在对象上的 UI 专用字段（如预览对话框
  //    给每行加的稳定 `_id`）会被一并计入限额——近上限时 UI 拒绝、
  //    而仓储层本来接受，用户被一个不存在的规则挡住。
  //    显式挑字段，与 `serializeOpenThreads` 一一对应
  const bytes = utf8Bytes(JSON.stringify(
    threads
      .filter(t => t.thread.trim())
      .map(t => ({ chapter: t.chapter, thread: t.thread.trim(), urgency: t.urgency })),
  ))
  if (bytes > MAX_OPEN_THREADS_BYTES) {
    return `伏笔总量 ${Math.round(bytes / 1024)}KB 超过 ${Math.round(MAX_OPEN_THREADS_BYTES / 1024)}KB 上限，请精简内容或删减条目`
  }
  return ''
}

/**
 * 卷章号区间的提交前预检，返回空串表示通过。
 *
 * 与仓储层 `assertValidRange`（`electron/repositories/volume-repository.ts`）
 * **同一套判据**——各写一份迟早分叉，而分叉的那份会放行主进程要拒绝的值，
 * 用户则看到一条来自底层的报错而不是「结束章不能小于起始章」。
 *
 * 这里挡住的是「点了保存才被拒绝」；最终授权仍在仓储层事务内
 * （它还要查区间重叠与「只有最后一卷能改边界」，那两条需要库）。
 *
 * ⚠️ 三条都要验，且**上下界分开**：
 * - `isSafeInteger` 而非 `isInteger`——`Number.isInteger(1e21)` 为真，
 *   而 `1e21 + 1 === 1e21`，这种章号落库后所有章号加减都会静默出错。
 * - 区间长度单独卡：两端都是安全整数**不代表**区间可遍历
 *   （`start=11, end=MAX_SAFE_INTEGER` 两端都合法，却有 9 千万亿章）。
 */
export function validateVolumeRange(startChapter: number, endChapter: number): string {
  if (!Number.isSafeInteger(startChapter) || startChapter < 1) {
    return '起始章号非法，须为 ≥1 的整数'
  }
  if (!Number.isSafeInteger(endChapter) || endChapter < 1) {
    return '结束章号非法，须为 ≥1 的整数'
  }
  if (endChapter < startChapter) {
    return `结束章（第 ${endChapter} 章）不能小于起始章（第 ${startChapter} 章）`
  }
  const span = endChapter - startChapter + 1
  if (span > MAX_VOLUME_CHAPTERS) {
    return `本卷共 ${span} 章，超过单卷上限 ${MAX_VOLUME_CHAPTERS} 章`
  }
  return ''
}

/**
 * 解析「本卷章数」输入框里的原始字符串，非法一律返回 `NaN`。
 *
 * ⚠️ 用 `Number()` 而非 `parseInt`。`Number.parseInt('1e21', 10) === 1`、
 * `Number.parseInt('1.5', 10) === 1`——先转换再校验等于把非法输入**静默改成
 * 合法值**提交：用户敲了 1e21，系统按 1 章去生成，而他毫不知情。
 *
 * 抽成纯函数是为了可测：留在组件的 onChange 里，这个坑只能靠人工敲边界值发现。
 */
export function parseChapterCount(raw: string): number {
  if (raw.trim() === '') return Number.NaN
  const n = Number(raw)
  // 上限一并在这里卡掉：安全整数 ≠ 可遍历区间。
  // `MAX_SAFE_INTEGER - 10` 是个安全整数，但按它建卷会让侧栏与盘点逻辑跑到天荒地老
  return Number.isSafeInteger(n) && n >= 1 && n <= MAX_VOLUME_CHAPTERS ? n : Number.NaN
}

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

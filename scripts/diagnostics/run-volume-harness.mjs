/**
 * run-volume-harness — 编译并运行续卷事务 harness 的启动器
 *
 * 存在的理由是**跨平台**：harness 必须以 `ELECTRON_RUN_AS_NODE=1` 借 Electron 的
 * node 运行（better-sqlite3 按 Electron ABI 编译，普通 node 加载会 ERR_DLOPEN_FAILED），
 * 而 `VAR=1 cmd` 这种前缀写法在 Windows 的 npm script（走 cmd.exe）下不成立，
 * 本项目又没装 cross-env。用一个 launcher 显式传 env 比新增依赖干净。
 */
/* eslint-env node */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
// 第一个参数选跑哪个 harness：commit（主进程事务）| workflow（渲染层编排）| regen（重生卷大纲）
const arg = process.argv[2]
const which = arg === 'workflow' ? 'volume-workflow-harness'
    : arg === 'regen' ? 'volume-regen-harness'
    : 'volume-commit-harness'
const entry = path.join(root, 'scripts', 'diagnostics', `${which}.ts`)
const bundle = path.join(root, 'node_modules', '.cache', `${which}.mjs`)

/** npm 会把 .bin 放进 PATH，但直接 spawn 在 Windows 上要带 .cmd，故统一走 shell */
function run(cmd, args, env) {
    return spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: true, env: { ...process.env, ...env } })
}

// `--packages=external` 保留 better-sqlite3 的 require，不把原生模块打进 bundle
const build = run('npx', [
    'esbuild', JSON.stringify(entry),
    '--bundle', '--format=esm', '--platform=node', '--packages=external',
    `--outfile=${JSON.stringify(bundle)}`,
])
if (build.status !== 0) process.exit(build.status ?? 1)

const res = run('npx', ['electron', JSON.stringify(bundle)], { ELECTRON_RUN_AS_NODE: '1' })
process.exit(res.status ?? 1)

/**
 * 当前已打开项目路径的主进程内状态。
 *
 * 历史上 kb-controller 用 recent-projects.json[0] 反推"当前项目"，
 * 但 recent[0] 只反映"最近被 open 过"，跟前端实际打开的项目可能错位
 * （如在 A 后又开了 B，UI 切回 A 时 recent[0] 仍是 B），导致 KB IPC 操作错项目。
 *
 * 这里用单一变量做真相来源：由 project:open / project:set-current 写入，
 * 由 KB / 其他 IPC 读取。前端关闭项目时显式传 null 清空。
 *
 * **Token**：每次 setCurrentProjectPath 都递增 token。给前端做 stale-write guard 用——
 * 前端"关闭项目"是 fire-and-forget，可能晚于"打开同名项目"到达主进程；只比对 path
 * 在 close A → reopen A 的场景下会误清，配合 token 才能彻底排除竞态。
 */

let currentProjectPath: string | null = null
let currentProjectToken: number = 0

/** 写入"当前项目"并返回最新 token（前端用作后续 guard）。 */
export function setCurrentProjectPath(p: string | null): { token: number } {
  currentProjectPath = p && p.trim() ? p : null
  currentProjectToken += 1
  return { token: currentProjectToken }
}

export function getCurrentProjectPath(): string | null {
  return currentProjectPath
}

export function getCurrentProjectToken(): number {
  return currentProjectToken
}

/**
 * vela-protocol — 统一管理 vela:// 伪协议路径解析
 *
 * 所有 vela:// 路径的常量映射和解析逻辑集中在此，
 * 新增架构字段或路径协议时只需修改此文件。
 */

import { ipc } from './ipc-client'
import type { NovelConfig } from '../shared/ipc-channels'
import type { ProjectCorePatch } from '../../electron/repositories/project-core-repository'

// ===== vela://core/ 架构字段映射 =====

/** 路径 key → ProjectCoreData 中的驼峰字段名 */
export const CORE_FIELD_MAP: Record<string, string> = {
    premise: 'premise',
    worldbuilding: 'worldbuilding',
    characters: 'charactersArch',
    synopsis: 'synopsis',
}

/**
 * ProjectCoreData 架构字段 → NovelConfig 旧别名。
 * 这三个字段在 NovelConfig 里另有别名（小说配置编辑器读写），premise 无别名。
 * 任何写入 DB 架构字段的路径都应同步 store 的别名，避免配置编辑器持有陈旧值后保存覆盖。
 */
export const CORE_FIELD_TO_CONFIG_ALIAS: Record<string, keyof NovelConfig> = {
    synopsis: 'coreOutline',
    worldbuilding: 'worldSetting',
    charactersArch: 'protagonistProfile',
}

/**
 * 写入 core 架构字段后，同步 store 中对应的 NovelConfig 别名（保持 store ⟷ DB 一致）。
 *
 * `expectedToken` 必填：本函数内部有一次动态 import 的 await，切换恰好落在那里时，
 * A 的架构别名会被写进 B 的内存配置——调用方在**调用前**核对挡不住这个窗口。
 */
export async function syncCoreAliasToStore(
    dbField: string,
    content: string,
    expectedToken: number | undefined,
    /**
     * 发起写库**之前**内存里该别名的值。用于识别「同项目内、IPC 在途期间
     * 用户又编辑了这个字段」——那种情况下不能把库值盖回去。
     */
    valueBeforeWrite?: unknown,
): Promise<'synced' | 'no-alias' | 'project-switched' | 'skipped-user-edited'> {
    const alias = CORE_FIELD_TO_CONFIG_ALIAS[dbField]
    if (!alias) return 'no-alias'
    // 延迟导入，避免 service 层与 store 的模块加载环
    const { useProjectStore } = await import('../stores/project-store')
    // ⚠️ 复核必须在 await **之后**、写内存之前
    if (expectedToken === undefined || useProjectStore.getState().currentToken !== expectedToken) {
        return 'project-switched'
    }
    const project = useProjectStore.getState().currentProject
    if (!project) return 'project-switched'

    // ⚠️ token 只能识别**跨项目**，识别不了「同项目内用户在 IPC 在途期间又改了这个字段」。
    // 那时内存里是用户刚敲的新文本、库里是本次写进去的旧文本；
    // 无条件同步会把用户正在编辑的内容原地抹掉
    const cfg = project.novelConfig as unknown as Record<string, unknown>
    if (valueBeforeWrite !== undefined && cfg[alias] !== valueBeforeWrite) {
        return 'skipped-user-edited'
    }

    // persisted:true —— 这个值刚刚**写库成功**才同步过来，它与库一致。
    // 登记成脏会让下一次保存把它再发一遍，且把「用户到底改没改过」这件事搅浑
    useProjectStore.getState().updateNovelConfig({ [alias]: content }, { persisted: true })
    return 'synced'
}

/**
 * 渲染端「直接写 project_core 架构字段到 DB」的统一入口。
 * 写库成功后，对其中带 NovelConfig 别名的字段（synopsis/worldbuilding/charactersArch）同步 store，
 * 避免 store⟷DB 漂移导致后续 saveProject 用陈旧别名反向覆盖。
 * 所有直接写架构字段的路径（架构生成 / 手动编辑 / 导入推演）都应走此函数，而非裸调 IPC。
 * @returns DB 写入是否成功
 */
export async function updateProjectCore(
    patch: ProjectCorePatch,
    /**
     * 调用方在**动作入口、任何 await 之前**捕获的项目 token。必填。
     * 架构生成四步走都在一次分钟级 LLM 之后才调本函数，
     * 让本函数自己现取等于把捕获点推迟到那次 LLM 之后——正是要防的窗口。
     */
    expectedToken: number | undefined,
): Promise<boolean> {
    const { useProjectStore } = await import('../stores/project-store')
    // 发请求前自查一次，省一趟必然被拒的 IPC，也让日志能指出是哪一步失效
    if (expectedToken === undefined || useProjectStore.getState().currentToken !== expectedToken) {
        console.warn('[updateProjectCore] 项目已切换，放弃本次写入')
        return false
    }
    const actionToken = expectedToken

    // 发请求**之前**记下这些别名字段在内存里的值：回包时据此判断
    // 「用户是不是在 IPC 在途期间又改了它」
    const beforeValues = new Map<string, unknown>()
    {
        const cfg = useProjectStore.getState().currentProject?.novelConfig as unknown as Record<string, unknown> | undefined
        for (const dbField of Object.keys(patch)) {
            const alias = CORE_FIELD_TO_CONFIG_ALIAS[dbField]
            if (alias && cfg) beforeValues.set(dbField, cfg[alias])
        }
    }

    const res = await ipc.invoke('db:project-core-update', patch, expectedToken)
    const ok = res.success !== false
    if (ok) {
        if (useProjectStore.getState().currentToken !== actionToken) {
            // ⚠️ 必须返回 **false**。早先这里 `return ok`（真），于是调用方
            // 认定「写成功了」：`ArchFileViewer` 会把另一个项目的 tab 标成已保存、
            // 架构工作流会发「已生成」事件、进度条走绿。
            // 库里那条写入确实成功了没错——但它属于**上一个项目**，
            // 对当前上下文而言这次调用等于没发生
            console.warn('[updateProjectCore] 回包晚于项目切换，不同步任何状态到新项目')
            return false
        }
        // 本通道也让 project_core.revision +1。不同步回来，渲染层就继续拿着
        // 写入前的版本号，下一次 saveProject 会撞 CAS 被判成"别人改了"——
        // 而"别人"正是自己刚才这一次写入
        if (res.revision !== undefined) {
            useProjectStore.setState({ coreRevision: res.revision })
        }
        for (const [dbField, value] of Object.entries(patch)) {
            if (typeof value === 'string') {
                // ⚠️ 返回值必须消费：静默跳过会让本函数照样报成功，
                // 调用方据此发「已生成」事件、把 tab 标成已保存
                const r = await syncCoreAliasToStore(
                    dbField, value, actionToken, beforeValues.get(dbField))
                if (r === 'project-switched') {
                    console.warn('[updateProjectCore] 同步别名途中项目已切换，剩余字段不再同步')
                    return false
                }
                // 'skipped-user-edited' 不算失败：库里写成功了，只是内存里
                // 有一份更新的用户编辑不该被盖掉。它仍留在脏集合里等下一次保存
                if (r === 'skipped-user-edited') {
                    console.info(`[updateProjectCore] ${dbField} 在写库期间被用户编辑过，保留编辑器里的版本`)
                }
            }
        }
    }
    return ok
}

/** 从 vela://core/ 路径中解析出 DB 字段名 */
export function parseCoreField(velaPath: string): string | null {
    if (!velaPath.startsWith('vela://core/')) return null
    const key = velaPath.replace('vela://core/', '')
    return CORE_FIELD_MAP[key] ?? null
}

/** 从 DB 读取 vela://core/ 路径对应的内容 */
export async function readCoreContent(velaPath: string): Promise<string> {
    const key = velaPath.replace('vela://core/', '')
    const core = await ipc.invoke('db:project-core-get')
    if (!core) return ''
    const fieldMap: Record<string, string> = {
        premise: core.premise || '',
        worldbuilding: core.worldbuilding || '',
        characters: core.charactersArch || '',
        synopsis: core.synopsis || '',
    }
    return fieldMap[key] || ''
}

/** 将内容写入 vela://core/ 对应的 DB 字段 */
export async function writeCoreContent(
    velaPath: string,
    content: string,
    /** 调用方在保存入口捕获的项目 token（见 updateProjectCore 的说明） */
    expectedToken: number | undefined,
): Promise<boolean> {
    const dbField = parseCoreField(velaPath)
    if (!dbField) return false
    // 经统一入口写库 + 同步 store 别名，避免小说配置编辑器持有陈旧值后保存覆盖手动编辑的架构内容
    // 该路径由架构文件写入复用，token 由调用方一路传下来
    return updateProjectCore({ [dbField]: content }, expectedToken)
}

// ===== vela://draft/ | vela://revision/ | vela://review/ 内容读取 =====

/** 读取 vela:// 伪协议路径的内容（统一入口） */
export async function readVelaContent(filePath: string): Promise<string> {
    if (filePath.startsWith('vela://draft/') || filePath.startsWith('vela://manuscript/')) {
        const prefix = filePath.startsWith('vela://draft/') ? 'vela://draft/' : 'vela://manuscript/'
        const draftId = parseInt(filePath.replace(prefix, ''))
        const full = await ipc.invoke('db:draft-get-full', draftId)
        return full?.content ?? ''
    }

    if (filePath.startsWith('vela://revision/')) {
        const revId = parseInt(filePath.replace('vela://revision/', ''))
        const full = await ipc.invoke('db:revision-get-full', revId)
        return full?.content ?? ''
    }

    if (filePath.startsWith('vela://review/')) {
        const revId = parseInt(filePath.replace('vela://review/', ''))
        const full = await ipc.invoke('db:review-get-full', revId)
        return full?.content ?? ''
    }

    if (filePath.startsWith('vela://core/')) {
        return readCoreContent(filePath)
    }

    console.warn('[readVelaContent] 不支持的路径协议:', filePath)
    return ''
}

/** 判断路径是否为 vela:// 伪协议 */
export function isVelaProtocol(path: string): boolean {
    return path.startsWith('vela://')
}

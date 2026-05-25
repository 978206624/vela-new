/**
 * vela-protocol — 统一管理 vela:// 伪协议路径解析
 *
 * 所有 vela:// 路径的常量映射和解析逻辑集中在此，
 * 新增架构字段或路径协议时只需修改此文件。
 */

import { ipc } from './ipc-client'
import type { NovelConfig } from '../shared/ipc-channels'
import type { ProjectCoreData } from '../../electron/repositories/project-core-repository'

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

/** 写入 core 架构字段后，同步 store 中对应的 NovelConfig 别名（保持 store ⟷ DB 一致） */
export async function syncCoreAliasToStore(dbField: string, content: string): Promise<void> {
    const alias = CORE_FIELD_TO_CONFIG_ALIAS[dbField]
    if (!alias) return
    // 延迟导入，避免 service 层与 store 的模块加载环
    const { useProjectStore } = await import('../stores/project-store')
    if (!useProjectStore.getState().currentProject) return
    useProjectStore.getState().updateNovelConfig({ [alias]: content })
}

/**
 * 渲染端「直接写 project_core 架构字段到 DB」的统一入口。
 * 写库成功后，对其中带 NovelConfig 别名的字段（synopsis/worldbuilding/charactersArch）同步 store，
 * 避免 store⟷DB 漂移导致后续 saveProject 用陈旧别名反向覆盖。
 * 所有直接写架构字段的路径（架构生成 / 手动编辑 / 导入推演）都应走此函数，而非裸调 IPC。
 * @returns DB 写入是否成功
 */
export async function updateProjectCore(patch: Partial<ProjectCoreData>): Promise<boolean> {
    const res = await ipc.invoke('db:project-core-update', patch)
    const ok = res.success !== false
    if (ok) {
        for (const [dbField, value] of Object.entries(patch)) {
            if (typeof value === 'string') await syncCoreAliasToStore(dbField, value)
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
export async function writeCoreContent(velaPath: string, content: string): Promise<boolean> {
    const dbField = parseCoreField(velaPath)
    if (!dbField) return false
    // 经统一入口写库 + 同步 store 别名，避免小说配置编辑器持有陈旧值后保存覆盖手动编辑的架构内容
    return updateProjectCore({ [dbField]: content })
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

/**
 * ProjectCoreRepository — 项目主台账 (project_core 表)
 *
 * 合并 NovelConfig + 架构四大件的统一读写。
 * 始终只有一行数据 (id = 'main')。
 */
import { getProjectDb } from '../database'

/** project_core 表行类型 */
export interface ProjectCoreRow {
    id: string
    /** 老库经 runMigrations 补列；读到 undefined 视为 0 */
    revision?: number
    project_name: string
    genre: string
    sub_genre: string
    target_audience: string
    total_chapters: number
    words_per_chapter: number
    plot_structure: string
    narrative_pov: string
    writing_style: string
    reference_works: string
    global_guidance: string
    golden_finger: string
    premise: string
    worldbuilding: string
    characters_arch: string
    synopsis: string
    character_states: string
    created_at: string
    updated_at: string
}

/** 前端使用的驼峰命名接口 */
export interface ProjectCoreData {
    projectName: string
    genre: string
    subGenre: string
    targetAudience: string
    totalChapters: number
    wordsPerChapter: number
    plotStructure: string
    narrativePov: string
    writingStyle: string
    referenceWorks: string
    globalGuidance: string
    goldenFinger: string
    premise: string
    worldbuilding: string
    charactersArch: string
    synopsis: string
    characterStates: string
    /**
     * 单调递增版本号，每次写入 +1。渲染层保存时原样带回做 CAS。
     * 只出现在**读取结果与返回值**里；写入 API 一律用 `ProjectCorePatch`（见下）把它排除掉。
     */
    revision: number
}

/**
 * 写入用的补丁类型：**结构上**去掉 `revision`。
 *
 * 用 `Partial<ProjectCoreData>` 的话，调用方可以传 `{revision: 99}` 而编译通过，
 * 实现里却被 fieldMap 静默忽略——调用方以为版本已按指定值写入。
 * 让它在类型上就构造不出来，比写注释靠谱。
 */
export type ProjectCorePatch = Partial<Omit<ProjectCoreData, 'revision'>>

/** 数据库行 → 前端数据 */
function rowToData(row: ProjectCoreRow): ProjectCoreData {
    return {
        projectName: row.project_name,
        genre: row.genre,
        subGenre: row.sub_genre,
        targetAudience: row.target_audience,
        totalChapters: row.total_chapters,
        wordsPerChapter: row.words_per_chapter,
        plotStructure: row.plot_structure,
        narrativePov: row.narrative_pov,
        writingStyle: row.writing_style,
        referenceWorks: row.reference_works,
        globalGuidance: row.global_guidance,
        goldenFinger: row.golden_finger,
        premise: row.premise,
        worldbuilding: row.worldbuilding,
        charactersArch: row.characters_arch,
        synopsis: row.synopsis,
        characterStates: row.character_states,
        revision: row.revision ?? 0,
    }
}

export class ProjectCoreRepository {
    /** 获取项目配置（不存在则返回 null） */
    static get(): ProjectCoreData | null {
        const db = getProjectDb()
        if (!db) return null

        const row = db.prepare(
            'SELECT * FROM project_core WHERE id = ?'
        ).get('main') as ProjectCoreRow | undefined

        return row ? rowToData(row) : null
    }

    /** 初始化项目配置（创建项目时调用） */
    static init(projectName: string): void {
        const db = getProjectDb()
        if (!db) return

        db.prepare(`
      INSERT OR IGNORE INTO project_core (id, project_name)
      VALUES ('main', ?)
    `).run(projectName)
    }

    /** 当前版本号；表不存在或无行时返回 null */
    static getRevision(): number | null {
        const db = getProjectDb()
        if (!db) return null
        const row = db.prepare(`SELECT revision FROM project_core WHERE id = 'main'`)
            .get() as { revision?: number } | undefined
        return row?.revision ?? null
    }

    /**
     * 更新项目配置（传入部分字段即可）。
     *
     * `expectedRevision` 给出时做 CAS：`WHERE id='main' AND revision = ?`，
     * 不命中即返回 `{ ok:false, stale:true }` 且**一列都不写**。
     * 渲染层持有的整份配置快照可能读于某次主进程写入之前
     * （典型：续卷事务改了 synopsis/total_chapters，而编辑器里的快照还是改之前的），
     * 不做 CAS 就会把刚写进去的值覆盖回旧值。
     *
     * 不给 `expectedRevision` 则无条件写——仅限**主进程内部**、
     * 数据不来自渲染层快照的路径（如新建项目时的初始化）。
     */
    static update(
        data: ProjectCorePatch,
        expectedRevision?: number,
    ): { ok: true; revision: number } | { ok: false; stale: true; revision: number | null } {
        const db = getProjectDb()
        if (!db) return { ok: false, stale: true, revision: null }

        // 构建动态 SET 子句，只更新传入的字段
        const fieldMap: Record<string, string> = {
            projectName: 'project_name',
            genre: 'genre',
            subGenre: 'sub_genre',
            targetAudience: 'target_audience',
            totalChapters: 'total_chapters',
            wordsPerChapter: 'words_per_chapter',
            plotStructure: 'plot_structure',
            narrativePov: 'narrative_pov',
            writingStyle: 'writing_style',
            referenceWorks: 'reference_works',
            globalGuidance: 'global_guidance',
            goldenFinger: 'golden_finger',
            premise: 'premise',
            worldbuilding: 'worldbuilding',
            charactersArch: 'characters_arch',
            synopsis: 'synopsis',
            characterStates: 'character_states',
        }

        const setClauses: string[] = []
        const values: unknown[] = []

        for (const [camel, col] of Object.entries(fieldMap)) {
            if (camel in data) {
                setClauses.push(`${col} = ?`)
                values.push((data as Record<string, unknown>)[camel])
            }
        }

        // 空补丁：**仍须做 CAS 比较**。
        // 早先这里无条件返回 ok:true，于是「补丁为空 + 版本已过期」会被当成保存成功，
        // 调用方据此把过期的 expectedRevision 当成"已对齐"继续用下去——
        // 一次静默的成功比一次明确的失败危险得多。
        if (setClauses.length === 0) {
            const cur = ProjectCoreRepository.getRevision()
            if (cur === null) return { ok: false, stale: true, revision: null }
            if (expectedRevision !== undefined && cur !== expectedRevision) {
                return { ok: false, stale: true, revision: cur }
            }
            return { ok: true, revision: cur }
        }

        // revision 与 updated_at 一起自增：版本号必须与数据在**同一条语句**里更新，
        // 分两条会出现「数据写了、版本没涨」的中间态
        setClauses.push('revision = revision + 1')
        setClauses.push("updated_at = datetime('now')")
        values.push('main')

        const where = expectedRevision === undefined
            ? `WHERE id = ?`
            : `WHERE id = ? AND revision = ?`
        if (expectedRevision !== undefined) values.push(expectedRevision)

        const info = db.prepare(`
      UPDATE project_core SET ${setClauses.join(', ')} ${where}
    `).run(...values)

        if (info.changes === 0) {
            // CAS 未命中 = 期间有别的写入落地。返回真实当前版本，调用方可据此重载
            return { ok: false, stale: true, revision: ProjectCoreRepository.getRevision() }
        }
        return { ok: true, revision: ProjectCoreRepository.getRevision() ?? 0 }
    }
}

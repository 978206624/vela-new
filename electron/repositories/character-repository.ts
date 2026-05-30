/**
 * CharacterRepository — 角色卡 (characters 表)
 *
 * currentState 子结构已拍平为 cs_* 前缀列，杜绝 JSON 大字段。
 */
import { getProjectDb } from '../database'

/** 角色卡动态状态 */
export interface CharacterStateData {
    location: string
    powerLevel: string
    physicalState: string
    mentalState: string
    keyItems: string
    recentEvents: string
    updatedAtChapter: number
}

/** 角色卡完整数据（前端驼峰接口） */
export interface CharacterData {
    name: string
    role: string
    gender: string
    age: string
    appearance: string
    personality: string
    background: string
    abilities: string
    motivation: string
    relationships: string
    arc: string
    notes: string
    currentState?: CharacterStateData
}

function rowToData(row: Record<string, unknown>): CharacterData {
    const data: CharacterData = {
        name: row.name as string,
        role: (row.role as string) || 'supporting',
        gender: (row.gender as string) || '',
        age: (row.age as string) || '',
        appearance: (row.appearance as string) || '',
        personality: (row.personality as string) || '',
        background: (row.background as string) || '',
        abilities: (row.abilities as string) || '',
        motivation: (row.motivation as string) || '',
        relationships: (row.relationships as string) || '',
        arc: (row.arc as string) || '',
        notes: (row.notes as string) || '',
    }

    // 只有当 cs_updated_at_chapter > 0 时才构建 currentState
    const updatedChapter = row.cs_updated_at_chapter as number
    if (updatedChapter > 0) {
        data.currentState = {
            location: (row.cs_location as string) || '',
            powerLevel: (row.cs_power_level as string) || '',
            physicalState: (row.cs_physical_state as string) || '',
            mentalState: (row.cs_mental_state as string) || '',
            keyItems: (row.cs_key_items as string) || '',
            recentEvents: (row.cs_recent_events as string) || '',
            updatedAtChapter: updatedChapter,
        }
    }

    return data
}

export class CharacterRepository {
    /** 获取所有角色（按角色定位排序：主角→配角→反派→龙套） */
    static getAll(): CharacterData[] {
        const db = getProjectDb()
        if (!db) return []

        const rows = db.prepare(`
      SELECT * FROM characters
      ORDER BY
        CASE role
          WHEN 'protagonist' THEN 0
          WHEN 'supporting' THEN 1
          WHEN 'antagonist' THEN 2
          WHEN 'minor' THEN 3
          ELSE 9
        END ASC
    `).all() as Record<string, unknown>[]

        return rows.map(rowToData)
    }

    /** 获取单个角色 */
    static getByName(name: string): CharacterData | null {
        const db = getProjectDb()
        if (!db) return null

        const row = db.prepare(
            'SELECT * FROM characters WHERE name = ?'
        ).get(name) as Record<string, unknown> | undefined

        return row ? rowToData(row) : null
    }

    /** 获取角色数量 */
    static count(): number {
        const db = getProjectDb()
        if (!db) return 0

        const row = db.prepare(
            'SELECT COUNT(*) as cnt FROM characters'
        ).get() as { cnt: number }

        return row.cnt
    }

    /** 插入或更新角色 */
    static upsert(data: CharacterData): void {
        const db = getProjectDb()
        if (!db) return

        const cs = data.currentState
        db.prepare(`
      INSERT INTO characters (
        name, role, gender, age, appearance, personality, background,
        abilities, motivation, relationships, arc, notes,
        cs_location, cs_power_level, cs_physical_state, cs_mental_state,
        cs_key_items, cs_recent_events, cs_updated_at_chapter
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        role = excluded.role,
        gender = excluded.gender,
        age = excluded.age,
        appearance = excluded.appearance,
        personality = excluded.personality,
        background = excluded.background,
        abilities = excluded.abilities,
        motivation = excluded.motivation,
        relationships = excluded.relationships,
        arc = excluded.arc,
        notes = excluded.notes,
        cs_location = excluded.cs_location,
        cs_power_level = excluded.cs_power_level,
        cs_physical_state = excluded.cs_physical_state,
        cs_mental_state = excluded.cs_mental_state,
        cs_key_items = excluded.cs_key_items,
        cs_recent_events = excluded.cs_recent_events,
        cs_updated_at_chapter = excluded.cs_updated_at_chapter,
        updated_at = datetime('now')
    `).run(
            data.name,
            data.role,
            data.gender,
            data.age,
            data.appearance,
            data.personality,
            data.background,
            data.abilities,
            data.motivation,
            data.relationships,
            data.arc,
            data.notes,
            cs?.location ?? '',
            cs?.powerLevel ?? '',
            cs?.physicalState ?? '',
            cs?.mentalState ?? '',
            cs?.keyItems ?? '',
            cs?.recentEvents ?? '',
            cs?.updatedAtChapter ?? 0,
        )
    }

    /** 批量保存角色（事务） */
    static saveAll(characters: CharacterData[]): void {
        const db = getProjectDb()
        if (!db) return

        const tx = db.transaction(() => {
            for (const char of characters) {
                CharacterRepository.upsert(char)
            }
        })
        tx()
    }

    /** 删除角色 */
    static delete(name: string): void {
        const db = getProjectDb()
        if (!db) return

        db.prepare('DELETE FROM characters WHERE name = ?').run(name)
    }

    /**
     * 仅填充「当前为空」的静态人设字段（AI 补全人设用）。
     * SQL 层 `CASE WHEN trim(coalesce(col,''))='' THEN @v ELSE col END` 守卫：
     * 只填空、原子、绝不覆盖用户手填值，也不碰 cs_* 动态状态——即使预览长窗口内
     * 后处理更新了 cs_*，此 UPDATE 也只动这 7 个静态列。
     * 返回本次「实际填入」的字段（DB 中确为空、patch 提供了非空值），供前端精准 merge。
     */
    static fillEmptyStaticProfileFields(
        name: string,
        patch: Partial<Pick<CharacterData, 'appearance' | 'personality' | 'background' | 'abilities' | 'motivation' | 'arc' | 'relationships'>>
    ): { applied: Record<string, string> } {
        const db = getProjectDb()
        if (!db) return { applied: {} }

        const FIELDS = ['appearance', 'personality', 'background', 'abilities', 'motivation', 'arc', 'relationships'] as const
        // 入参归一为完整 7 字段命名参数（缺失绑 ''），避免 better-sqlite3 缺命名参数报错
        const vals: Record<string, string> = {}
        for (const f of FIELDS) vals[f] = (patch[f] ?? '').toString()
        // 全空早返回，不空跑只更 updated_at
        if (FIELDS.every(f => vals[f].trim() === '')) return { applied: {} }

        // 读当前值，计算实际会被填入的字段（DB 为空 且 patch 有值）供前端 merge
        const row = db.prepare(
            `SELECT ${FIELDS.join(', ')} FROM characters WHERE name = ?`
        ).get(name) as Record<string, unknown> | undefined
        if (!row) return { applied: {} }

        const applied: Record<string, string> = {}
        for (const f of FIELDS) {
            const cur = ((row[f] as string) ?? '').trim()
            if (cur === '' && vals[f].trim() !== '') applied[f] = vals[f]
        }
        if (Object.keys(applied).length === 0) return { applied: {} }

        db.prepare(`
      UPDATE characters SET
        appearance    = CASE WHEN trim(coalesce(appearance,''))    = '' THEN @appearance    ELSE appearance    END,
        personality   = CASE WHEN trim(coalesce(personality,''))   = '' THEN @personality   ELSE personality   END,
        background    = CASE WHEN trim(coalesce(background,''))     = '' THEN @background    ELSE background    END,
        abilities     = CASE WHEN trim(coalesce(abilities,''))      = '' THEN @abilities     ELSE abilities     END,
        motivation    = CASE WHEN trim(coalesce(motivation,''))     = '' THEN @motivation    ELSE motivation    END,
        arc           = CASE WHEN trim(coalesce(arc,''))            = '' THEN @arc           ELSE arc           END,
        relationships = CASE WHEN trim(coalesce(relationships,''))  = '' THEN @relationships ELSE relationships END,
        updated_at = datetime('now')
      WHERE name = @name
    `).run({ name, ...vals })

        return { applied }
    }

    /** 仅更新角色动态状态（后处理时使用） */
    static updateState(name: string, state: CharacterStateData): void {
        const db = getProjectDb()
        if (!db) return

        db.prepare(`
      UPDATE characters SET
        cs_location = ?, cs_power_level = ?, cs_physical_state = ?,
        cs_mental_state = ?, cs_key_items = ?, cs_recent_events = ?,
        cs_updated_at_chapter = ?, updated_at = datetime('now')
      WHERE name = ?
    `).run(
            state.location,
            state.powerLevel,
            state.physicalState,
            state.mentalState,
            state.keyItems,
            state.recentEvents,
            state.updatedAtChapter,
            name,
        )
    }
}

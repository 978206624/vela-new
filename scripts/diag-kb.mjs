// 一次性诊断：不修改任何项目数据，只读
import * as lancedb from '@lancedb/lancedb'
import path from 'node:path'
import url from 'node:url'

const projectPath = process.argv[2] || 'C:/Users/ning/Desktop/小说/猫和老鼠'
const dbPath = path.join(projectPath, '.vela', 'lancedb')
console.log('[diag] dbPath =', dbPath)

const db = await lancedb.connect(dbPath)
const tables = await db.tableNames()
console.log('[diag] tables =', tables)

if (!tables.includes('chunks')) {
  console.log('[diag] chunks 表不存在')
  process.exit(0)
}

const t = await db.openTable('chunks')
const schema = await t.schema()
console.log('[diag] schema fields:')
for (const f of schema.fields) {
  console.log('  -', f.name, f.type?.toString?.() ?? String(f.type))
}

const total = await t.countRows()
console.log('[diag] countRows =', total)

// 取一小撮看 vector 字段类型与值
const sample = await t.query().limit(3).toArray()
console.log('[diag] sample rows (vector 字段类型探针):')
sample.forEach((r, i) => {
  const v = r.vector
  let kind = typeof v
  let len = 'n/a'
  let head = 'n/a'
  if (v && typeof v.toArray === 'function') {
    kind = 'has toArray()'
    try {
      const a = v.toArray()
      len = a.length
      head = JSON.stringify(Array.from(a).slice(0, 3))
    } catch (e) { head = 'toArray() throw: ' + e.message }
  } else if (Array.isArray(v)) {
    kind = 'Array'
    len = v.length
    head = JSON.stringify(v.slice(0, 3))
  } else if (v == null) {
    kind = String(v) // null / undefined
  } else if (v && typeof v.length === 'number') {
    kind = (v.constructor && v.constructor.name) || 'unknown'
    len = v.length
    try { head = JSON.stringify(Array.from(v).slice(0, 3)) } catch { head = '<not iterable>' }
  }
  console.log(`  row[${i}] id=${r.id} kind=${kind} length=${len} head=${head}`)
})

// 完整扫描：用 KnowledgeOverview 同款判定，找 缺向量 的行
const allWithSelect = await t.query().select(['id', 'fileName', 'chunkIndex', 'vector']).toArray()
const missing = []
for (const r of allWithSelect) {
  const v = r.vector
  let empty = false
  if (!v) empty = true
  else if (typeof v.toArray === 'function') {
    try { empty = v.toArray().length === 0 } catch { empty = true }
  } else if (typeof v.length === 'number') {
    empty = v.length === 0
  } else {
    empty = true
  }
  if (empty) missing.push({ id: r.id, fileName: r.fileName, chunkIndex: r.chunkIndex })
}
console.log(`[diag] 缺向量 chunk = ${missing.length} / ${allWithSelect.length}`)
console.log('[diag] 缺向量分布（按文件聚合）:')
const byFile = new Map()
for (const m of missing) {
  byFile.set(m.fileName, (byFile.get(m.fileName) || 0) + 1)
}
for (const [name, cnt] of [...byFile.entries()].sort((a,b)=>b[1]-a[1])) {
  console.log(`  ${cnt}  ${name}`)
}

// 同时确认有向量的行的"看起来正确"
const withVec = []
for (const r of allWithSelect) {
  const v = r.vector
  if (!v) continue
  if (typeof v.toArray === 'function') {
    try {
      const a = v.toArray()
      if (a.length > 0) withVec.push({ id: r.id, dim: a.length })
    } catch {}
  } else if (typeof v.length === 'number' && v.length > 0) {
    withVec.push({ id: r.id, dim: v.length })
  }
}
console.log(`[diag] 有向量 chunk = ${withVec.length}（样例维度 ${withVec[0]?.dim ?? 'n/a'}）`)

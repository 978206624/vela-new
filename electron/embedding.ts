/**
 * Vela 嵌入服务 — 主进程使用
 *
 * 提供文本向量化能力（调用远程 Embedding API）
 * 支持 OpenAI 和 Gemini 两种 Embedding API
 *
 * 注意：向量存储和检索能力已迁移至 vector-store.ts (LanceDB)
 * 本模块仅保留 Embedding API 调用和文本分块功能
 */

// ===== 模型维度推断 =====

/**
 * 常见嵌入模型的输出维度（best-effort 静态映射）。
 *
 * 仅作为「换模型前预判维度是否一致」与 UI 展示的提示用途，
 * **不是权威来源** —— 真实维度永远以 API 实际返回的向量长度为准。
 * 命中规则为子串匹配（忽略大小写），未知模型返回 null。
 */
const KNOWN_EMBEDDING_DIMS: Array<[pattern: string, dim: number]> = [
  // OpenAI
  ['text-embedding-3-small', 1536],
  ['text-embedding-3-large', 3072],
  ['text-embedding-ada-002', 1536],
  // Gemini / Google
  ['gemini-embedding-001', 3072],
  ['text-embedding-005', 768],
  ['text-embedding-004', 768],
  ['embedding-001', 768],
  // 国内常见兼容模型
  ['bge-large', 1024],
  ['bge-base', 768],
  ['bge-small', 512],
  ['m3e-base', 768],
  ['text-embedding-v3', 1024], // 阿里 DashScope
  ['text-embedding-v2', 1536],
]

/** 按模型名推断已知输出维度；未知返回 null（真实维度以 API 返回为准） */
export function getKnownEmbeddingDimension(modelName?: string | null): number | null {
  if (!modelName) return null
  const name = modelName.toLowerCase()
  for (const [pattern, dim] of KNOWN_EMBEDDING_DIMS) {
    if (name.includes(pattern)) return dim
  }
  return null
}

// ===== Embedding API 调用 =====

/**
 * 把失败响应体压成简短可读的错误信息。
 * 避免把整页 HTML（如 Cloudflare 挑战页 / 登录页 / 网关错误页）塞进 toast 和日志。
 */
function summarizeErrorBody(body: string): string {
  const trimmed = body.trim()
  if (!trimmed) return '无响应内容'

  // 先剥掉 JSON 错误包装（如 {"error":{"code":"forbidden","message":"403: <html>..."}}），取出真正的 message
  let detail = trimmed
  try {
    const j = JSON.parse(trimmed) as { error?: { message?: string } | string; message?: string }
    const picked = (typeof j.error === 'object' ? j.error?.message : j.error) ?? j.message
    if (typeof picked === 'string' && picked.trim()) detail = picked.trim()
  } catch { /* 非 JSON，按原文处理 */ }

  // 正文任意位置含网页特征（含被 JSON 包裹的 HTML）→ 不回显网页，给可操作的提示
  if (/<html|<!doctype|<head|<body|cloudflare|just a moment|enable javascript/i.test(detail)) {
    return '端点返回了网页而非有效响应（多半鉴权失败/被拦截，或该端点不支持 embeddings——请确认「嵌入」用途配的是嵌入模型而非聊天模型）'
  }

  const oneLine = detail.replace(/\s+/g, ' ').trim()
  return oneLine.length > 200 ? oneLine.slice(0, 200) + '…' : (oneLine || '无响应内容')
}

/** OpenAI Embedding API */
export async function embedOpenAI(
  texts: string[],
  model: { baseUrl: string; apiKey: string; modelName?: string },
): Promise<number[][]> {
  const embeddingModel = model.modelName || 'text-embedding-3-small'
  const url = model.baseUrl.replace(/\/$/, '') + '/embeddings'
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${model.apiKey}`,
    },
    body: JSON.stringify({
      model: embeddingModel,
      input: texts,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`OpenAI Embedding 调用失败 (${res.status}): ${summarizeErrorBody(text)}`)
  }

  const data = await res.json() as {
    data: Array<{ embedding: number[]; index: number }>
  }

  // 按 index 排序确保顺序一致
  return data.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding)
}

/** Gemini Embedding API */
export async function embedGemini(
  texts: string[],
  model: { baseUrl: string; apiKey: string; modelName?: string },
): Promise<number[][]> {
  const embeddingModel = model.modelName || 'text-embedding-004'
  const baseUrl = model.baseUrl.replace(/\/$/, '')

  // Gemini batchEmbedContents 支持批量
  const url = `${baseUrl}/v1beta/models/${embeddingModel}:batchEmbedContents`
  const requests = texts.map((text) => ({
    model: `models/${embeddingModel}`,
    content: { parts: [{ text }] },
    taskType: 'RETRIEVAL_DOCUMENT',
  }))

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': model.apiKey,
    },
    body: JSON.stringify({ requests }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Gemini Embedding 调用失败 (${res.status}): ${summarizeErrorBody(text)}`)
  }

  const data = await res.json() as {
    embeddings: Array<{ values: number[] }>
  }

  return data.embeddings.map((e) => e.values)
}

/** 统一的 Embedding 调用接口 */
export async function generateEmbeddings(
  texts: string[],
  protocol: 'openai' | 'gemini',
  model: { baseUrl: string; apiKey: string; modelName?: string },
): Promise<number[][]> {
  // 空文本处理
  if (texts.length === 0) return []

  // 批量限制：每次最多 50 条
  const batchSize = protocol === 'gemini' ? 100 : 50
  const results: number[][] = []

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize)
    const embeddings = protocol === 'gemini'
      ? await embedGemini(batch, model)
      : await embedOpenAI(batch, model)
    results.push(...embeddings)
  }

  return results
}

// ===== 文本分块 =====

/** 将文本按段落分块，每块约 maxChars 字符 */
export function chunkText(
  text: string,
  maxChars: number = 500,
  overlap: number = 50,
): string[] {
  // 先按段落分割
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0)

  const chunks: string[] = []
  let currentChunk = ''

  for (const para of paragraphs) {
    // 如果段落本身就超过 maxChars，按句号分割
    if (para.length > maxChars) {
      if (currentChunk) {
        chunks.push(currentChunk.trim())
        currentChunk = ''
      }
      // 按句号分割长段落
      const sentences = para.split(/(?<=[。！？.!?])\s*/)
      let sentenceChunk = ''
      for (const sentence of sentences) {
        if (sentenceChunk.length + sentence.length > maxChars && sentenceChunk.length > 0) {
          chunks.push(sentenceChunk.trim())
          // 保留 overlap
          sentenceChunk = sentenceChunk.slice(-overlap) + sentence
        } else {
          sentenceChunk += sentence
        }
      }
      if (sentenceChunk.trim()) {
        currentChunk = sentenceChunk
      }
      continue
    }

    // 累积段落
    if (currentChunk.length + para.length > maxChars && currentChunk.length > 0) {
      chunks.push(currentChunk.trim())
      // 保留 overlap
      currentChunk = currentChunk.slice(-overlap) + '\n\n' + para
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + para
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim())
  }

  return chunks.length > 0 ? chunks : [text.trim()]
}

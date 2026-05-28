// 一次性诊断：定位 DeepSeek thinking 模式 400 根因。只调 API、不改任何项目数据。
// 读 ~/.vela/models.json 取 deepseek 配置（key 不打印）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const modelsPath = path.join(os.homedir(), '.vela', 'models.json')
const models = JSON.parse(fs.readFileSync(modelsPath, 'utf-8'))
const ds = models.find((m) => m.provider === 'deepseek')
if (!ds) { console.error('没找到 deepseek 模型配置'); process.exit(1) }

// 复现 vela buildUrl：裸 host → /v1/chat/completions
const base = ds.baseUrl.replace(/\/+$/, '')
const url = base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`
console.log('[diag] model =', ds.modelName, '| url =', url, '\n')

const baseMessages = [
  { role: 'system', content: '你是一个助手。' },
  { role: 'user', content: '只回复 JSON：{"ok":1}' },
]

// 4 个变体：逐步加字段，定位哪个组合触发/解决 400
const variants = [
  {
    name: '#1 enabled，无 reasoning_effort，无 response_format',
    body: { thinking: { type: 'enabled' } },
  },
  {
    name: '#2 enabled + reasoning_effort:high（无 response_format）',
    body: { thinking: { type: 'enabled' }, reasoning_effort: 'high' },
  },
  {
    name: '#3 enabled + reasoning_effort:high + response_format:json_object（完全复现 architecture.command）',
    body: { thinking: { type: 'enabled' }, reasoning_effort: 'high', response_format: { type: 'json_object' } },
  },
  {
    name: '#4 disabled + response_format:json_object（验证关闭路径）',
    body: { thinking: { type: 'disabled' }, response_format: { type: 'json_object' }, temperature: 0.7 },
  },
  {
    name: '#5 多轮：assistant 历史缺 reasoning_content + thinking enabled（怀疑这才是根因）',
    messages: [
      { role: 'system', content: '你是一个助手。' },
      { role: 'user', content: '说"好"' },
      { role: 'assistant', content: '好' },
      { role: 'user', content: '只回复 JSON：{"ok":1}' },
    ],
    body: { thinking: { type: 'enabled' } },
  },
  {
    name: '#6 多轮：assistant 历史缺 reasoning_content + thinking disabled（对照）',
    messages: [
      { role: 'system', content: '你是一个助手。' },
      { role: 'user', content: '说"好"' },
      { role: 'assistant', content: '好' },
      { role: 'user', content: '只回复 JSON：{"ok":1}' },
    ],
    body: { thinking: { type: 'disabled' }, temperature: 0.7 },
  },
  {
    name: '#7 tool_calls 多轮：assistant 带 tool_calls 缺 reasoning_content + thinking enabled（复现 Agent 路径）',
    messages: [
      { role: 'system', content: '你是一个助手。' },
      { role: 'user', content: '查北京天气' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '晴 25度' },
    ],
    body: {
      thinking: { type: 'enabled' },
      tools: [{ type: 'function', function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    },
  },
  {
    name: '#8 tool_calls 多轮：thinking disabled（对照，验证关闭可绕过）',
    messages: [
      { role: 'system', content: '你是一个助手。' },
      { role: 'user', content: '查北京天气' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '晴 25度' },
    ],
    body: {
      thinking: { type: 'disabled' },
      temperature: 0.7,
      tools: [{ type: 'function', function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    },
  },
  {
    name: '#9 方案A验证：tool_calls 多轮 + assistant 回传 reasoning_content + thinking enabled（预期 200）',
    messages: [
      { role: 'system', content: '你是一个助手。' },
      { role: 'user', content: '查北京天气' },
      { role: 'assistant', content: '', reasoning_content: '用户想查北京的天气，我需要调用 get_weather 工具。', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '晴 25度' },
    ],
    body: {
      thinking: { type: 'enabled' },
      tools: [{ type: 'function', function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    },
  },
  {
    name: '#10 cc-switch 占位策略：assistant reasoning_content 用占位字符串（缺真实思考时的兜底）',
    messages: [
      { role: 'system', content: '你是一个助手。' },
      { role: 'user', content: '查北京天气' },
      { role: 'assistant', content: '', reasoning_content: 'tool call', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '晴 25度' },
    ],
    body: {
      thinking: { type: 'enabled' },
      tools: [{ type: 'function', function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    },
  },
]

for (const v of variants) {
  const body = {
    model: ds.modelName,
    messages: v.messages ?? baseMessages,
    max_tokens: 200,
    stream: false,
    ...v.body,
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ds.apiKey}` },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) {
      console.log(`${v.name}\n  ❌ ${res.status}: ${text.slice(0, 300)}\n`)
    } else {
      const j = JSON.parse(text)
      const msg = j.choices?.[0]?.message ?? {}
      const hasReasoning = typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0
      const content = (msg.content ?? '').slice(0, 80)
      console.log(`${v.name}\n  ✅ ${res.status} | reasoning_content=${hasReasoning ? `有(${msg.reasoning_content.length}字)` : '无'} | content="${content}"\n`)
    }
  } catch (e) {
    console.log(`${v.name}\n  ⚠️ 异常: ${String(e).slice(0, 200)}\n`)
  }
}

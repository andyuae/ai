import type { Attachment, ChatMsg } from './types'
import { attSummary } from './atts'
import { PROVIDERS } from '../config'

/* ================= DeepSeek 官方搜索接口（四家统一联网数据源，¥0.005/次） ================= */
export async function deepseekWebSearch(query: string, apiKey: string, signal?: AbortSignal) {
  const res = await fetch('https://api.deepseek.com/v1/tools/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({ query: String(query).slice(0, 128), count: 8, need_content: false }),
    signal
  })
  if (!res.ok) throw new Error('搜索接口错误 HTTP ' + res.status)
  const data = await res.json()
  return (data.results || []).map((r: any) => ({
    title: r.title, url: r.url, summary: r.summary, date: r.date, site: r.site_name
  }))
}

/* ================= 单轮流式请求 ================= */
async function streamChatOnce(opts: {
  baseUrl: string; apiKey: string; model: string; messages: ChatMsg[]
  onDelta?: (delta: string, all: string) => void; signal: AbortSignal
}) {
  const { baseUrl, apiKey, model, messages, onDelta, signal } = opts
  const res = await fetch(baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({ model, messages, stream: true }),
    signal
  })
  if (!res.ok) {
    let detail = ''
    try { detail = (await res.text()).slice(0, 200) } catch { /* ignore */ }
    throw new Error(`接口错误 HTTP ${res.status} ${detail}`)
  }
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = '', content = '', usage: { pt: number; ct: number } | null = null
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      try {
        const json = JSON.parse(data)
        const ch = json.choices && json.choices[0]
        if (ch && ch.delta && ch.delta.content) {
          content += ch.delta.content
          onDelta && onDelta(ch.delta.content, content)
        }
        if (json.usage) usage = { pt: json.usage.prompt_tokens || 0, ct: json.usage.completion_tokens || 0 }
      } catch { /* 忽略不完整行 */ }
    }
  }
  return { content, usage }
}

/* ================= 为某个 AI 构造完整对话 =================
   系统提示 + 该 AI 视角的历史（附件只留名字）+ 当前消息（图片为 content 数组、文件全文附后） */
export function buildMessages(
  provider: string, model: string, history: { sender: string; provider?: string; status?: string; content: string }[],
  curText: string, curAtts: Attachment[]
): ChatMsg[] {
  const meta = PROVIDERS[provider] || { name: provider }
  const sys = `你是用户的 AI 助手 ${meta.name}（当前模型：${model}）。用户把同一条消息同时发给了多个 AI 助手，各 AI 彼此独立作答、互相看不到对方的回答。请独立、直接地回答用户，用中文，条理清晰；若消息带有图片或文件附件，请结合附件内容回答。`
  const msgs: ChatMsg[] = [{ role: 'system', content: sys }]
  history.slice(0, -1).slice(-30).forEach(m => {
    if (m.sender === 'user') msgs.push({ role: 'user', content: attSummary(m.content) })
    else if (m.sender === 'assistant' && m.provider === provider && m.status !== 'error' && m.content)
      msgs.push({ role: 'assistant', content: m.content })
  })
  let txt = curText || '（见附件）'
  curAtts.filter(a => a.kind === 'file').forEach(f => { txt += `\n\n【附件文件：${f.name}】\n${f.text}` })
  const images = curAtts.filter(a => a.kind === 'image')
  let content: any
  if (images.length) {
    const parts: any[] = [{ type: 'text', text: txt }]
    images.forEach(im => parts.push({ type: 'image_url', image_url: { url: im.dataUrl } }))
    content = parts
  } else {
    content = txt
  }
  msgs.push({ role: 'user', content })
  return msgs
}

/* ================= 调用一家 AI（始终先联网搜索，再流式回答） ================= */
export async function callAI(opts: {
  provider: string; model: string; messages: ChatMsg[]
  apiKey: string; baseUrl: string
  visionModel?: string; visionModels?: string[]
  deepseekApiKey?: string | null
  onDelta?: (delta: string, all: string) => void
  signal: AbortSignal
}): Promise<{ content: string; usage: { pt: number; ct: number } }> {
  let { provider, model, messages } = opts
  const { apiKey, baseUrl, visionModel, visionModels, deepseekApiKey, onDelta, signal } = opts

  const meta = PROVIDERS[provider]
  const hasImages = messages.some(m => Array.isArray(m.content) && m.content.some((c: any) => c.type === 'image_url'))
  if (hasImages && meta?.visionModels && !meta.visionModels.includes(model)) model = meta.visionModel || model

  /* 始终联网：先查实时资料注入系统提示；失败不阻塞回答 */
  try {
    const lastUser = [...messages].reverse().find(m => m.role === 'user')
    let q = ''
    if (lastUser) {
      q = typeof lastUser.content === 'string'
        ? lastUser.content
        : (Array.isArray(lastUser.content) ? ((lastUser.content.find((c: any) => c.type === 'text') || {}).text || '') : '')
    }
    q = String(q).replace(/\s+/g, ' ').trim().slice(0, 100)
    if (q && deepseekApiKey) {
      const results = await deepseekWebSearch(q, deepseekApiKey, signal)
      if (results && results.length) {
        const today = new Date().toLocaleDateString('zh-CN')
        const block = `\n\n【${today} 实时网络搜索结果（供参考，请结合这些最新资料回答；引用时注明来源）】\n`
          + results.map((r: any) => `• ${r.title}${r.site ? '（' + r.site + '）' : ''}${r.date ? ' ' + r.date : ''}\n  ${r.url}\n  ${r.summary || ''}`).join('\n')
        messages = messages.slice()
        const sysIdx = messages.findIndex(m => m.role === 'system')
        if (sysIdx >= 0) messages[sysIdx] = { ...messages[sysIdx], content: messages[sysIdx].content + block }
        else messages = [{ role: 'system', content: block.trim() }, ...messages]
      }
    }
  } catch { /* 搜索失败不影响正常回答 */ }

  const r = await streamChatOnce({ baseUrl, apiKey, model, messages, onDelta, signal })
  const usage = r.usage || { pt: 0, ct: Math.round((r.content || '').length / 1.5) }
  return { content: r.content, usage }
}

/* ================= 连通测试：依次尝试候选模型，404 才换下一个 ================= */
export function friendlyTestError(status: number, body: string, name: string, providerKey: string): string {
  const detail = (body || '').slice(0, 200)
  if (status === 401 || status === 403) return `密钥无效或没有权限（HTTP ${status}）——请检查密钥是否复制完整、是否已过期`
  if (status === 402) return `账户余额不足（HTTP 402）——请到 ${name} 官网充值后再试`
  if (status === 404) {
    if (/not found the model|permission denied/i.test(body))
      return `该模型不存在或你的密钥没有它的使用权限（HTTP 404）——系统会自动尝试其他模型；若全部失败，请到服务商官网确认账号已开通模型权限`
    return `接口或模型不存在（HTTP 404）——${detail}`
  }
  if (status === 429) return `请求太频繁被限流（HTTP 429）——稍等片刻再试`
  if (status >= 500) return `${name} 服务器暂时故障（HTTP ${status}）——稍后再试`
  if (status === 400 && /valid api key/i.test(body)) {
    if (providerKey === 'gemini') return `密钥无效（HTTP 400）——Gemini 密钥通常以 AIza 开头（官方）或 sk- 开头（中转站），请确认粘贴正确`
    return `密钥无效（HTTP 400）——请确认粘贴的是 ${name} 官网生成的 API 密钥`
  }
  return `接口返回错误（HTTP ${status}）——${detail}`
}

export async function testProviderModel(opts: {
  baseUrl: string; apiKey: string; model: string; signal: AbortSignal
}): Promise<{ ok: boolean; status?: number; body?: string }> {
  const { baseUrl, apiKey, model, signal } = opts
  try {
    const res = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ model, stream: false, max_tokens: 8, messages: [{ role: 'user', content: '回复"连通成功"四个字' }] }),
      signal
    })
    return { ok: res.ok, status: res.status, body: res.ok ? '' : await res.text().catch(() => '') }
  } catch (e: any) {
    return { ok: false, status: -1, body: e?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK' }
  }
}

/* 拉取服务商真实可用模型列表（GET /models） */
export async function fetchModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20000)
  try {
    const res = await fetch(baseUrl + '/models', { headers: { Authorization: 'Bearer ' + apiKey }, signal: ctrl.signal })
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text().catch(() => '')).slice(0, 120))
    const json = await res.json()
    const ids = (json.data || []).map((m: any) => m.id).filter(Boolean).sort()
    if (!ids.length) throw new Error('服务返回了空模型列表')
    return ids
  } finally {
    clearTimeout(timer)
  }
}

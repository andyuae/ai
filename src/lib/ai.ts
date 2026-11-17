import type { Attachment, ChatMsg } from './types'
import { attSummary, parseAtts } from './atts'
import { PROVIDERS } from '../config'

/* ================= 图片识别：模型判定与选择 =================
   不写死"视觉模型"名字（写死会导致中转站无该模型 → 403），
   而是先看当前模型是否本身就能看图，再从"你这个密钥实际可用的模型列表"里挑。 */

/** 名字里带这些特征的多半是多模态模型 */
const VISION_HINT = /(vision|4o\b|gpt-4\.1|gpt-5|gpt-6|gemini|claude|o3|o4|llava|pixtral|internvl|glm-4v|qwen[\w.-]*vl|yi-vision|doubao[\w.-]*vision)/i

export function looksVisionModel(model: string): boolean {
  return VISION_HINT.test(String(model || ''))
}

/**
 * 为带图片的请求挑一个能看图的模型。
 * @param available 该服务当前可选的模型（来自设置页"拉取模型列表"/默认列表）
 * @returns 可用的视觉模型名；返回 '' 表示没有任何可用的视觉模型
 */
export function pickVisionModel(provider: string, current: string, available?: string[]): string {
  const meta: any = PROVIDERS[provider] || {}
  const hintList: string[] = meta.visionModels || []
  const catalog: string[] = available && available.length ? available : (meta.models || [])

  /* 1) 当前模型本身就能看图 → 直接用它，不做任何替换（避免换成无权限的模型） */
  if (hintList.includes(current) || looksVisionModel(current)) return current

  /* 2) 配置里标注的视觉模型里，挑一个"你这个密钥确实能用"的 */
  const fromHint = hintList.find((m: string) => catalog.includes(m))
  if (fromHint) return fromHint

  /* 3) 再按名字特征在可用列表里找 */
  const guessed = catalog.find(looksVisionModel)
  return guessed || ''
}

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
    /* 把中转站/服务商的原始说明带出来，否则界面上只剩一句"调用失败"，没法定位 */
    let detail = ''
    try {
      const raw = await res.text()
      let msg = ''
      try {
        const j = JSON.parse(raw)
        msg = j?.error?.message || j?.error || j?.message || ''
        if (typeof msg === 'object') msg = JSON.stringify(msg)
      } catch { msg = raw }
      detail = String(msg || raw || '').replace(/\s+/g, ' ').trim().slice(0, 240)
    } catch { /* ignore */ }
    throw new Error(`HTTP ${res.status}${detail ? '：' + detail : ''}`)
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
        /* 个别中转站会在 200 的流里塞错误对象 */
        if (json.error) {
          const m2 = json.error.message || json.error
          throw new Error(typeof m2 === 'string' ? m2 : JSON.stringify(m2))
        }
        const ch = json.choices && json.choices[0]
        const d = ch && ch.delta && ch.delta.content
        if (d) {
          /* 少数中转站把 content 返回成 [{type:'text',text:'…'}] */
          const piece = Array.isArray(d) ? d.map((x: any) => (typeof x === 'string' ? x : (x?.text || ''))).join('') : String(d)
          if (piece) {
            content += piece
            onDelta && onDelta(piece, content)
          }
        }
        if (json.usage) usage = { pt: json.usage.prompt_tokens || 0, ct: json.usage.completion_tokens || 0 }
      } catch (e: any) {
        if (e && e.message && !/Unexpected|JSON/.test(e.message)) throw e
        /* 忽略不完整行 / 非 JSON 行 */
      }
    }
  }
  if (!content) throw new Error('模型没有返回任何内容（服务返回 200 但响应为空，常见于中转站拒绝了图片或该模型不可用）')
  return { content, usage }
}

/* ================= 为某个 AI 构造完整对话 =================
   系统提示 + 该 AI 视角的历史 + 当前消息。
   图片用 OpenAI 兼容的 image_url + dataURL 发送；
   历史里最近两条带图消息也保留图片，这样"这张图里……"这类追问才不会丢图。 */
/* 单次请求里图片 base64 的字符总量软上限。
   超过后不再带历史图片（历史里同一张图往往会重复出现，把请求体撑到几 MB，
   中转站会直接 413/400，表现就是"某一家失败"，但看图本身没问题）。 */
export const IMG_BODY_BUDGET = 5 * 1024 * 1024

function imgKey(u: string) { return u.length + '|' + u.slice(0, 40) + '|' + u.slice(-40) }

function imageParts(text: string, imgs: Attachment[], limit = 4, seen?: Set<string>): any[] {
  const parts: any[] = [{ type: 'text', text: text || '（见图片）' }]
  let n = 0
  for (const im of imgs) {
    if (n >= limit) break
    if (!im.dataUrl) continue
    const k = imgKey(im.dataUrl)
    if (seen) {
      if (seen.has(k)) continue   // 同一张图一次请求里只发一次
      seen.add(k)
    }
    parts.push({ type: 'image_url', image_url: { url: im.dataUrl, detail: 'auto' } })
    n++
  }
  return parts
}

export function buildMessages(
  provider: string, model: string, history: { sender: string; provider?: string; status?: string; content: string }[],
  curText: string, curAtts: Attachment[]
): ChatMsg[] {
  const meta = PROVIDERS[provider] || { name: provider }
  const sys = `你是用户的 AI 助手 ${meta.name}（当前模型：${model}）。用户把同一条消息同时发给了多个 AI 助手，各 AI 彼此独立作答、互相看不到对方的回答。请独立、直接地回答用户，用中文，条理清晰；若消息带有图片或文件附件，请结合附件内容回答（图片请先准确描述你看到的内容，再作分析）。`
  const msgs: ChatMsg[] = [{ role: 'system', content: sys }]
  const hist = history.slice(0, -1).slice(-30)

  /* 本次消息的图片优先：与历史重复的图不再重发，请求体不至于翻倍 */
  const curImgs = curAtts.filter(a => a.kind === 'image').slice(0, 6)
  const curImgsChars = curImgs.reduce((s, im) => s + (im.dataUrl ? im.dataUrl.length : 0), 0)
  const seen = new Set(curImgs.filter(im => im.dataUrl).map(im => imgKey(im.dataUrl!)))
  const allowHistImgs = curImgsChars < IMG_BODY_BUDGET

  /* 最近 2 条带图的消息保留图片（每条最多 2 张），保证多轮追问可用 */
  const imgMsgs = hist.filter(m => m.sender === 'user' && parseAtts(m.content).atts.some(a => a.kind === 'image'))
  const keepImgs = allowHistImgs ? new Set(imgMsgs.slice(-2)) : new Set()
  /* 最近 1 条带文件的消息保留正文，保证"表格第三列什么意思"这类追问可用 */
  const fileMsgs = hist.filter(m => m.sender === 'user' && parseAtts(m.content).atts.some(a => a.kind === 'file'))
  const keepFile = fileMsgs[fileMsgs.length - 1]

  hist.forEach(m => {
    if (m.sender === 'user') {
      const { text, atts } = parseAtts(m.content)
      const imgs = atts.filter(a => a.kind === 'image')
      if (keepImgs.has(m) && imgs.length) {
        msgs.push({ role: 'user', content: imageParts(text, imgs, 2, seen) })
      } else if (m === keepFile) {
        let body = text || ''
        atts.filter(a => a.kind === 'file').forEach(f => {
          body += `\n\n【附件文件：${f.name}】\n${String(f.text || '').slice(0, 20000)}`
        })
        msgs.push({ role: 'user', content: body.slice(0, 30000) })
      } else {
        msgs.push({ role: 'user', content: attSummary(m.content) })
      }
    } else if (m.sender === 'assistant' && m.provider === provider && m.status !== 'error' && m.content) {
      msgs.push({ role: 'assistant', content: m.content })
    }
  })

  let txt = curText || ''
  curAtts.filter(a => a.kind === 'file').forEach(f => { txt += `\n\n【附件文件：${f.name}】\n${f.text}` })
  const content: any = curImgs.length ? imageParts(txt, curImgs, 6, new Set<string>()) : (txt || '（见附件）')
  msgs.push({ role: 'user', content })
  return msgs
}

/* ================= 调用一家 AI（始终先联网搜索，再流式回答） ================= */
/* ================= 借别家的眼睛：把图片转成文字描述 ================= */
export async function describeImages(opts: {
  provider: string; model: string; apiKey: string; baseUrl: string
  images: Attachment[]; signal: AbortSignal
}): Promise<string> {
  const prompt = '下面是一张或多张图片。请客观、完整地描述看到的内容：整体是什么（截图 / 照片 / 表格 / 图表 / 聊天记录）、画面中的文字（尽量逐字准确）、关键数字与它们之间的关系。只做描述，不要分析、不要评价、不要使用 Markdown 标题。'
  const msgs: ChatMsg[] = [{ role: 'user', content: imageParts(prompt, opts.images, 4) }]
  const r = await streamChatOnce({ baseUrl: opts.baseUrl, apiKey: opts.apiKey, model: opts.model, messages: msgs, signal: opts.signal })
  return String(r.content || '').trim()
}

function collectImages(messages: ChatMsg[]): Attachment[] {
  const out: Attachment[] = []
  messages.forEach(m => {
    if (!Array.isArray(m.content)) return
    m.content.forEach((c: any) => {
      if (c && c.type === 'image_url' && c.image_url && c.image_url.url) {
        out.push({ kind: 'image', name: '图片' + (out.length + 1), dataUrl: c.image_url.url })
      }
    })
  })
  return out
}

/** 把图片段替换成文字描述，交给不支持视觉的模型（否则它会因为收到图片而报错） */
function imagesToText(messages: ChatMsg[], desc: string): ChatMsg[] {
  const block = `\n\n【附图内容（由另一个 AI 转述，请据此回答；如需更精确的细节请直接说明）】\n${desc}`
  const out = messages.map(m => {
    if (!Array.isArray(m.content)) return m
    const text = m.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
    return { ...m, content: text || '（见附图）' }
  })
  const i = out.length - 1
  out[i] = { ...out[i], content: String(out[i].content || '') + block }
  return out
}

/* ================= 调用一家 AI（始终先联网搜索，再流式回答） ================= */
export async function callAI(opts: {
  provider: string; model: string; messages: ChatMsg[]
  apiKey: string; baseUrl: string
  availableModels?: string[]
  deepseekApiKey?: string | null
  describeImages?: (imgs: Attachment[]) => Promise<{ text: string; by: string }>
  onDelta?: (delta: string, all: string) => void
  signal: AbortSignal
}): Promise<{ content: string; usage: { pt: number; ct: number }; model: string; note: string }> {
  let { provider, model, messages } = opts
  const { apiKey, baseUrl, availableModels, deepseekApiKey, onDelta, signal } = opts

  /* 带图片时：能自己看图就用自己；不能看就借别家的眼睛转述成文字，绝不直接甩错误 */
  let note = ''
  let bridged = false
  const hasImages = messages.some(m => Array.isArray(m.content) && m.content.some((c: any) => c.type === 'image_url'))
  if (hasImages) {
    const vision = pickVisionModel(provider, model, availableModels)
    if (vision) {
      model = vision
    } else {
      const imgs = collectImages(messages)
      let bridge: { text: string; by: string } | null = null
      try { bridge = opts.describeImages ? await opts.describeImages(imgs) : null } catch { bridge = null }
      if (!bridge || !bridge.text) {
        throw new Error(`当前模型 ${model} 不支持图片识别，也没有其他可用的视觉模型可以代为转述。请在设置页为任意一家勾选支持图片的模型（名字含 vision / 4o / gemini / claude 等）。`)
      }
      messages = imagesToText(messages, bridge.text)
      note = `图片由 ${bridge.by} 转述`
      bridged = true
    }
  }

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
    /* 只发了图、没写字时不做无意义的联网搜索 */
    if (q && deepseekApiKey && !/^（见(附件|图片)）$/.test(q)) {
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

  const send = () => streamChatOnce({ baseUrl, apiKey, model, messages, onDelta, signal })
  let r: Awaited<ReturnType<typeof send>>
  try {
    r = await send()
  } catch (e: any) {
    const aborted = e?.name === 'AbortError'
    /* 自己看图失败（常见：中转站不给该模型传图、图太大被拒、该模型其实不支持视觉）
       → 自动降级：借别家的眼睛把图片转述成文字，再回答一次，而不是让这一列空着 */
    if (aborted || !hasImages || bridged || !opts.describeImages) throw e
    const imgs = collectImages(messages)
    let bridge: { text: string; by: string } | null = null
    try { bridge = await opts.describeImages(imgs) } catch { bridge = null }
    if (!bridge || !bridge.text) throw e
    const first = shortErr(e)
    messages = imagesToText(messages, bridge.text)
    note = `图片由 ${bridge.by} 转述`
    onDelta && onDelta('', '')   // 清掉第一次可能已经流出的半截内容
    try {
      r = await send()
    } catch (e2: any) {
      throw new Error(`直传图片失败（${first}）；改用 ${bridge.by} 转述图片后仍失败（${shortErr(e2)}）`)
    }
  }
  const usage = r.usage || { pt: 0, ct: Math.round((r.content || '').length / 1.5) }
  return { content: r.content, usage, model, note }
}

function shortErr(e: any): string {
  const m = String((e && e.message) || e || '未知错误').replace(/\s+/g, ' ')
  return m.length > 120 ? m.slice(0, 120) + '…' : m
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

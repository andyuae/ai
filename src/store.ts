import { reactive, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { sb } from './lib/supabase'
import { PROVIDERS, KEY_PREFIX_HINT } from './config'
import type { Conversation, DbMessage, LiveCol, ProviderState, SettingsData, Attachment, Insight, SharedInsight, Minute } from './lib/types'
import { serializeAtts, parseAtts, processFile, ATT_COUNT_MAX } from './lib/atts'
import { buildMessages, callAI, testProviderModel, friendlyTestError, fetchModels, pickVisionModel, describeImages, isSafetyBlock, buildInsightMessages, parseInsightJson, buildMinuteMessages, parseMinuteJson, detectReplyLang } from './lib/ai'

type View = 'chat' | 'settings' | 'insights'

const state = reactive({
  view: 'chat' as View,
  user: null as any,
  authReady: false,
  providers: [] as ProviderState[],
  settings: {} as SettingsData,
  conversations: [] as Conversation[],
  currentConvId: null as number | null,
  currentMessages: [] as DbMessage[],
  liveCols: [] as LiveCol[],          // 进行中的 AI 回答分块
  discussing: false,
  stopFlag: false,
  attachments: [] as Attachment[],    // 输入框待发送附件
  inputText: '',
  testResults: {} as Record<string, string>,  // provider -> 测试结果文案
  testBusy: {} as Record<string, boolean>,
  testAllBusy: false,                          // 一键测试全部进行中
  modelBusy: {} as Record<string, boolean>,
  retryingId: 0,                               // 正在重试的那条失败消息 id
  chatTitle: '新对话',
  insights: [] as Insight[],                   // 结论卡列表
  insightsLoaded: false,
  insightsBusy: false,
  insightQ: '',                                // 结论库搜索词
  insightTag: '',                              // 结论库标签筛选
  insightEditor: {                             // 结论卡编辑器（全局抽屉）
    open: false,
    busy: false,                               // AI 提炼中
    saving: false,
    draft: blankInsight(),
    error: ''
  },
  /* 小秘书：会议纪要。每次总结 = 一个选项卡，存 messages 表（sender='host'） */
  secretary: {
    open: false,
    menuOpen: false,
    busy: false,
    loading: false,
    error: '',
    minutes: [] as Minute[],
    activeId: 0,
    convId: null as number | null
  }
})

const currentModelSel = reactive<Record<string, string>>({})

/* 展示顺序（从左到右固定为）：ChatGPT → Gemini → DeepSeek → Kimi → Anthropic */
export const DISPLAY_ORDER = ['openai', 'gemini', 'deepseek', 'kimi', 'anthropic']
export function orderOf(key?: string) {
  const i = DISPLAY_ORDER.indexOf(key || '')
  return i < 0 ? 99 : i
}

function effBaseUrl(key: string): string {
  return state.settings.baseUrls?.[key] || PROVIDERS[key].baseUrl
}
function providerOf(key: string): ProviderState | undefined {
  return state.providers.find(p => p.key === key)
}

/* 找一家"能看图"的 AI：给不支持视觉的模型转述图片内容（DeepSeek 这类纯文本模型靠它） */
function pickVisionHelper(exclude: string) {
  for (const key of DISPLAY_ORDER) {
    if (key === exclude) continue
    const p = providerOf(key)
    if (!p || !p.configured || !p.enabled || !p.apiKey) continue
    const vm = pickVisionModel(key, currentModelSel[key] || p.models[0], p.models)
    if (vm) return { key, name: p.name, model: vm, baseUrl: effBaseUrl(key), apiKey: p.apiKey }
  }
  return null
}

function dbErr(op: string, error: any): never {
  throw new Error(op + '失败：' + (error?.message || error))
}

/* 单个 AI 的一次完整调用（发送与"重试"共用同一套逻辑） */
function callOne(
  p: { provider: string; model: string },
  history: DbMessage[], text: string, atts: Attachment[],
  onDelta: (d: string, all: string) => void, signal: AbortSignal
) {
  const prov = providerOf(p.provider)!
  return callAI({
    provider: p.provider, model: p.model,
    messages: buildMessages(p.provider, p.model, history, text, atts),
    apiKey: prov.apiKey!, baseUrl: effBaseUrl(p.provider),
    availableModels: prov.models,
    deepseekApiKey: (providerOf('deepseek') || {}).apiKey,
    /* 该服务没有可用的视觉模型（或直传图片失败）时，借别家的眼睛把图片转述成文字 */
    describeImages: async (imgs, lang) => {
      const helper = pickVisionHelper(p.provider)
      if (!helper) return { text: '', by: '' }
      const desc = await describeImages({
        provider: helper.key, model: helper.model, apiKey: helper.apiKey,
        baseUrl: helper.baseUrl, images: imgs, signal, lang
      })
      return { text: desc, by: helper.name }
    },
    onDelta, signal
  })
}

/* ================= 数据加载 ================= */
async function loadSettings() {
  const { data, error } = await sb.from('settings').select('*').eq('user_id', state.user.id).maybeSingle()
  if (error) dbErr('读取偏好设置', error)
  state.settings = Object.assign({}, { default_participants: [], baseUrls: {}, relayModels: {} }, (data && data.data) || {})
}

async function persistSettings() {
  const { error } = await sb.from('settings').upsert(
    { user_id: state.user.id, data: state.settings, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' })
  if (error) dbErr('保存偏好设置', error)
}

async function loadConfigs() {
  const { data, error } = await sb.from('provider_configs').select('*')
  if (error) dbErr('读取密钥配置', error)
  const map: Record<string, any> = {}
  data.forEach((r: any) => { map[r.provider] = r })

  /* 一次性修正：新默认是"配了密钥的成员全部启用"，保存成功才记标记 */
  const flagKey = 'enabledAll4'
  if (!localStorage.getItem(flagKey)) {
    const off = Object.keys(PROVIDERS).filter(k => map[k]?.api_key && map[k]?.enabled === false)
    if (off.length) {
      try {
        for (const k of off) await upsertProvider(k, { enabled: true })
        localStorage.setItem(flagKey, '1')
        return loadConfigs()
      } catch { /* 失败下次再试 */ }
    } else {
      localStorage.setItem(flagKey, '1')
    }
  }

  state.providers = Object.entries(PROVIDERS).map(([key, meta]) => {
    const row = map[key] || {}
    const relay = state.settings.relayModels?.[key]
    return {
      key, name: meta.name, oversea: !!meta.oversea,
      models: relay && relay.length ? relay : meta.models,
      modelLabel: relay && relay.length ? {} : meta.modelLabel,
      configured: !!row.api_key,
      enabled: row.enabled !== false,
      apiKey: row.api_key || null
    }
  })
  /* 固定展示顺序：ChatGPT → Gemini → DeepSeek → Kimi（成员芯片与回答分块都按此排列） */
  state.providers.sort((a, b) => orderOf(a.key) - orderOf(b.key))
  /* 发送用的模型 = 设置页勾选的模型（第一个），未勾选则默认第一个 */
  Object.keys(currentModelSel).forEach(k => delete currentModelSel[k])
  state.providers.forEach(p => {
    const sel = (state.settings.selModels?.[p.key] || []).filter(m => p.models.includes(m))
    if (sel.length) currentModelSel[p.key] = sel[0]
    else if (p.enabled && p.models.length) currentModelSel[p.key] = p.models[0]
  })
}

async function upsertProvider(provider: string, patch: Record<string, unknown>) {
  const payload = Object.assign({ user_id: state.user.id, provider }, patch)
  const { error } = await sb.from('provider_configs').upsert(payload, { onConflict: 'user_id,provider' })
  if (error) dbErr('保存密钥配置', error)
}

async function loadConversations() {
  const { data, error } = await sb.from('conversations').select('*').order('updated_at', { ascending: false })
  if (error) dbErr('读取会话列表', error)
  state.conversations = data as any
}

async function enterApp(u: any) {
  state.user = u
  await loadSettings()
  await Promise.all([loadConfigs(), loadConversations()])
  state.view = 'chat'
}


/* ================= 结论卡：把一次多 AI 对比压缩成"我自己的判断" ================= */

function blankInsight(): Insight {
  return {
    title: '', question: '', conclusion: '', evidence: '', disputes: '',
    counter: '', followup: '', sources: [], tags: [], conversation_id: null
  }
}

function isMissingTable(error: any) {
  const m = String(error?.message || error || '')
  return /42P01|does not exist|Could not find the table|schema cache/i.test(m)
}

async function loadInsights() {
  state.insightsBusy = true
  try {
    const { data, error } = await sb.from('insights').select('*').order('created_at', { ascending: false })
    if (error) {
      if (isMissingTable(error)) throw new Error('结论表还没建：请在 Supabase SQL Editor 里执行仓库根目录的 insights-schema.sql，然后刷新页面')
      dbErr('读取结论库', error)
    }
    state.insights = (data || []) as any
    state.insightsLoaded = true
  } finally {
    state.insightsBusy = false
  }
}

function openInsightEditor(opts?: { insight?: Insight; convId?: number | null }) {
  const e = state.insightEditor
  e.error = ''
  e.busy = false
  e.saving = false
  e.draft = opts?.insight
    ? { ...opts.insight, sources: [...(opts.insight.sources || [])], tags: [...(opts.insight.tags || [])] }
    : blankInsight()
  if (!opts?.insight) e.draft.conversation_id = opts?.convId ?? state.currentConvId ?? null
  e.open = true
}

function closeInsightEditor() {
  state.insightEditor.open = false
  state.insightEditor.busy = false
  state.insightEditor.error = ''
}

/* 用一家最便宜的可用模型把当前会话提炼成结论卡 —— 只有点按钮才调用 */
async function draftInsight(): Promise<string> {
  const e = state.insightEditor
  const usable = state.providers.filter(p => p.configured && p.enabled && p.apiKey)
  if (!usable.length) return '没有可用的 AI：请先在设置页配置密钥'

  const msgs = state.currentMessages
  const users = msgs.filter(m => m.sender === 'user')
  const lastUser = users.length ? users[users.length - 1] : null
  const question = lastUser ? (parseAtts(lastUser.content).text || '').trim() : ''
  const afterId = lastUser ? lastUser.id : 0

  let answers = msgs
    .filter(m => m.sender === 'assistant' && m.id > afterId && m.status !== 'error' && m.content)
    .map(m => ({ provider: m.provider || '', name: providerOf(m.provider || '')?.name || m.provider || '', content: m.content }))

  /* 回答还在流式输出、尚未落库时，用实时列兜底 */
  if (!answers.length && state.liveCols.length) {
    answers = state.liveCols
      .filter(c => c.text && c.state !== 'error')
      .map(c => ({ provider: c.provider, name: providerOf(c.provider)?.name || c.provider, content: c.text }))
  }
  if (!answers.length) return '当前会话还没有 AI 回答，先在聊天里提个问题再提炼'

  /* 提炼优先用 DeepSeek（最便宜），没有就用第一家可用的 */
  const pick = usable.find(p => p.key === 'deepseek') || usable[0]
  const model = currentModelSel[pick.key] || pick.models[0]
  e.busy = true
  e.error = ''
  try {
    const { content, usage } = await callAI({
      provider: pick.key, model,
      messages: buildInsightMessages(question, answers),
      apiKey: pick.apiKey!, baseUrl: effBaseUrl(pick.key),
      signal: new AbortController().signal
    })
    const d = parseInsightJson(content)
    if (!d) return '模型没有按格式返回（可能被截断），再点一次或手动填写'
    e.draft = { ...e.draft, ...d }
    logUsage(pick.key, model, usage)
    return ''
  } catch (err: any) {
    return '提炼失败：' + (err?.message || err)
  } finally {
    e.busy = false
  }
}

/* 保存（新建或更新），返回错误文案，空字符串表示成功 */
async function saveInsight(): Promise<string> {
  const e = state.insightEditor
  const d = e.draft
  if (!d.conclusion.trim() && !d.evidence.trim()) return '至少写一句「我的判断」，否则以后翻出来也看不懂'
  const payload: any = {
    title: (d.title || '').trim() || d.conclusion.trim().slice(0, 18) || '未命名结论',
    question: d.question || '', conclusion: d.conclusion || '', evidence: d.evidence || '',
    disputes: d.disputes || '', counter: d.counter || '', followup: d.followup || '',
    sources: d.sources || [], tags: d.tags || [],
    conversation_id: d.conversation_id ?? null,
    updated_at: new Date().toISOString()
  }
  e.saving = true
  try {
    if (d.id) {
      const { error } = await sb.from('insights').update(payload).eq('id', d.id)
      if (error) return '保存失败：' + (isMissingTable(error) ? '结论表还没建，请先执行 insights-schema.sql' : error.message)
    } else {
      const { error } = await sb.from('insights').insert({ ...payload, user_id: state.user?.id })
      if (error) return '保存失败：' + (isMissingTable(error) ? '结论表还没建，请先执行 insights-schema.sql' : error.message)
    }
    closeInsightEditor()
    await loadInsights()
    return ''
  } finally {
    e.saving = false
  }
}

async function deleteInsight(item: Insight) {
  if (item.id == null) return
  try {
    await ElMessageBox.confirm('删除后无法恢复，确定删除这张结论卡吗？', '删除结论卡', {
      type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消'
    })
  } catch { return }
  const { error } = await sb.from('insights').delete().eq('id', item.id)
  if (error) { ElMessage.error('删除失败：' + error.message); return }
  state.insights = state.insights.filter(x => x.id !== item.id)
}

function makeShareToken() {
  const buf = new Uint8Array(9)
  crypto.getRandomValues(buf)
  return Array.from(buf).map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 14)
}

/* 生成/复用分享链接：只读页面免登录，按 token 取单条 */
async function shareInsight(item: Insight): Promise<string> {
  if (item.id == null) return ''
  let token = item.share_token || ''
  if (!token) {
    token = makeShareToken()
    const { error } = await sb.from('insights')
      .update({ share_token: token, shared_at: new Date().toISOString() })
      .eq('id', item.id)
    if (error) { ElMessage.error('生成分享链接失败：' + error.message); return '' }
    item.share_token = token
    item.shared_at = new Date().toISOString()
  }
    /* 不依赖构建期常量：从当前地址推导站点根（/ai/），本地与线上都能用 */
  const base = location.pathname.replace(/[^/]*$/, '') || '/'
  return `${location.origin}${base}?s=${token}`
}

async function unshareInsight(item: Insight) {
  if (item.id == null) return
  const { error } = await sb.from('insights').update({ share_token: null, shared_at: null }).eq('id', item.id)
  if (error) { ElMessage.error('取消分享失败：' + error.message); return }
  item.share_token = null
  item.shared_at = null
}

/* 分享页用：匿名读取（服务端函数只回展示字段） */
async function loadSharedInsight(token: string): Promise<SharedInsight | null> {
  const { data, error } = await sb.rpc('get_shared_insight', { tok: token })
  if (error) throw new Error(/function|does not exist|schema cache/i.test(error.message)
    ? '分享功能还没启用：请先执行 insights-schema.sql'
    : error.message)
  const row = Array.isArray(data) ? data[0] : data
  return row || null
}

/* ================= 小秘书：会议纪要 =================
   1) 只有点「分析总结」时才调用模型（一次一问，可先设为 DeepSeek 省钱）
   2) 纪要存在 messages 表里（sender='host'），一篇纪要 = 一个选项卡，
      不额外建表，换设备/换浏览器也能看到历次总结
   3) 每次总结都带上一次的纪要，让它标注「哪些分歧这轮已经收敛」 */

let secAbort: AbortController | null = null

function secretaryConf() {
  const cfg = state.settings.secretary || { provider: '', model: '' }
  const usable = state.providers.filter(p => p.configured && p.enabled && p.apiKey)
  const p = usable.find(x => x.key === cfg.provider) || usable.find(x => x.key === 'deepseek') || usable[0]
  if (!p) return null
  const model = cfg.model && p.models.includes(cfg.model) ? cfg.model : (currentModelSel[p.key] || p.models[0])
  return { key: p.key, name: p.name, model, label: (p.modelLabel || {})[model] || model }
}
const secretaryModel = computed(() => secretaryConf())

async function saveSecretaryConf(provider: string, model: string) {
  state.settings.secretary = { provider, model }
  await persistSettings()
}

/* 一条 host 消息 → 一份纪要 */
function parseMinuteRow(row: any): Minute | null {
  if (!row) return null
  let obj: any = null
  try { obj = JSON.parse(row.content) } catch { obj = null }
  if (obj && obj.v === 1) {
    return {
      id: row.id, n: Number(obj.n) || 0,
      title: obj.title || '本次总结', overview: obj.overview || '',
      consensus: Array.isArray(obj.consensus) ? obj.consensus : [],
      differences: Array.isArray(obj.differences) ? obj.differences : [],
      resolved: Array.isArray(obj.resolved) ? obj.resolved : [],
      blind: Array.isArray(obj.blind) ? obj.blind : [],
      next: Array.isArray(obj.next) ? obj.next : [],
      raw: obj.raw || '',
      models: Array.isArray(obj.models) ? obj.models : [],
      secProvider: obj.secProvider, secModel: obj.secModel, rangeTo: obj.rangeTo,
      created_at: row.created_at
    }
  }
  return {
    id: row.id, n: 0, title: '早期纪要', overview: '', consensus: [], differences: [],
    resolved: [], blind: [], next: [], raw: String(row.content || ''),
    models: [], created_at: row.created_at
  }
}

async function loadMinutes() {
  const s = state.secretary
  const cid = state.currentConvId
  if (cid == null) { s.minutes = []; s.activeId = 0; s.convId = null; return }
  s.loading = true
  try {
    const { data, error } = await sb.from('messages')
      .select('id, content, created_at')
      .eq('conversation_id', cid).eq('sender', 'host').order('id')
    if (error) throw new Error(error.message)
    s.minutes = (data || []).map(parseMinuteRow).filter(Boolean) as Minute[]
    s.minutes.forEach((m, i) => { if (!m.n) m.n = i + 1 })
    if (!s.minutes.some(m => m.id === s.activeId)) {
      s.activeId = s.minutes.length ? s.minutes[s.minutes.length - 1].id : 0
    }
    s.convId = cid
  } catch (e: any) {
    s.error = '读取历次总结失败：' + (e?.message || e)
  } finally {
    s.loading = false
  }
}

function toggleSecretaryMenu() {
  const s = state.secretary
  s.menuOpen = !s.menuOpen
  /* 菜单上的「已总结 N 次」要准确：会话换过就顺手取一次（不阻塞菜单展开） */
  if (s.menuOpen && state.currentConvId != null && s.convId !== state.currentConvId) loadMinutes()
}
function closeSecretaryMenu() { state.secretary.menuOpen = false }

async function openSecretary(mode: 'list' | 'summarize' = 'list') {
  const s = state.secretary
  s.menuOpen = false
  s.open = true
  s.error = ''
  await loadMinutes()
  if (mode === 'summarize') await summarizeNow()
}

function closeSecretary() { state.secretary.open = false }
function setActiveMinute(id: number) { state.secretary.activeId = id }

/* 切换会话 / 新建时收起面板（正在生成的总结不打断，跑完仍会落库） */
function resetSecretary() {
  const s = state.secretary
  s.open = false; s.menuOpen = false
  s.minutes = []; s.activeId = 0; s.error = ''; s.convId = null
}

async function summarizeNow() {
  const s = state.secretary
  if (s.busy) return
  if (state.discussing) { ElMessage.warning('等这一轮回答结束再总结，免得纪要漏掉一半'); return }
  const convId = state.currentConvId
  if (convId == null) { ElMessage.warning('当前还没有会话，先向五家提个问题'); return }

  const msgs = state.currentMessages.filter(m => m.sender !== 'host')
  const okAnswers = msgs.filter(m => m.sender === 'assistant' && m.status !== 'error' && m.content)
  if (!msgs.some(m => m.sender === 'user')) { ElMessage.warning('当前会话还没有提问，先向五家问点什么'); return }
  if (!okAnswers.length) { ElMessage.warning('还没有 AI 成功回答，暂时没有可总结的内容'); return }

  const conf = secretaryConf()
  if (!conf) { s.error = '没有可用的 AI：请先在设置页配置密钥并启用'; return }

  const prev = s.minutes.length ? s.minutes[s.minutes.length - 1] : null
  const lastUser = [...msgs].reverse().find(m => m.sender === 'user')
  const lang = detectReplyLang(lastUser ? parseAtts(lastUser.content).text : '')

  s.open = true
  s.menuOpen = false
  s.busy = true
  s.error = ''
  const ctrl = new AbortController()
  secAbort = ctrl

  try {
    const { content, usage, model: usedModel } = await callAI({
      provider: conf.key, model: conf.model,
      messages: buildMinuteMessages(msgs, { prev, lang }),
      apiKey: providerOf(conf.key)!.apiKey!, baseUrl: effBaseUrl(conf.key),
      signal: ctrl.signal, noSearch: true
    })
    const draft = parseMinuteJson(content)
    const n = s.minutes.length + 1
    const models = [...new Set(okAnswers.map(m => providerOf(m.provider || '')?.name || m.provider || '').filter(Boolean))] as string[]
    const payload: any = draft
      ? { v: 1, n, ...draft, models }
      : { v: 1, n, title: `第 ${n} 次总结`, overview: '', consensus: [], differences: [], resolved: [], blind: [], next: [], raw: content, models }
    payload.secProvider = conf.key
    payload.secModel = usedModel

    const { data, error } = await sb.from('messages').insert({
      conversation_id: convId, sender: 'host',
      provider: conf.key, model: usedModel,
      content: JSON.stringify(payload), tokens: usage.ct, status: 'done'
    }).select('id, created_at').single()
    if (error) throw new Error('纪要保存失败：' + error.message)

    logUsage(conf.key, usedModel, usage)
    if (state.currentConvId === convId) {
      const m = parseMinuteRow({ id: data.id, content: JSON.stringify(payload), created_at: data.created_at })
      if (m) { s.minutes.push(m); s.activeId = m.id }
    }
    if (!draft) ElMessage.warning('模型没按格式返回，已把原文存进这次纪要')
  } catch (e: any) {
    if (e?.name === 'AbortError') ElMessage.info('已停止本次总结')
    else s.error = '总结失败：' + (e?.message || e)
  } finally {
    s.busy = false
    secAbort = null
  }
}

function stopSummarize() {
  try { secAbort?.abort() } catch { /* ignore */ }
  secAbort = null
  state.secretary.busy = false
}

async function deleteMinute(m: Minute) {
  const idx = state.secretary.minutes.findIndex(x => x.id === m.id)
  try {
    await ElMessageBox.confirm(`删除第 ${m.n || idx + 1} 次总结后无法恢复，确定删除吗？`, '删除这次总结', {
      type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消'
    })
  } catch { return }
  const { error } = await sb.from('messages').delete().eq('id', m.id)
  if (error) { ElMessage.error('删除失败：' + error.message); return }
  state.secretary.minutes = state.secretary.minutes.filter(x => x.id !== m.id)
  state.currentMessages = state.currentMessages.filter(x => x.id !== m.id)
  if (state.secretary.activeId === m.id) {
    const arr = state.secretary.minutes
    state.secretary.activeId = arr.length ? arr[arr.length - 1].id : 0
  }
}

/* 复制成 Markdown，方便贴到笔记 / 群里 */
function minuteToText(m: Minute): string {
  const lines: string[] = [`# 第 ${m.n} 次总结：${m.title}`]
  if (m.created_at) lines.push(new Date(m.created_at).toLocaleString('zh-CN'))
  if (m.models.length) lines.push('参与：' + m.models.join('、'))
  if (m.overview) lines.push('', m.overview)
  if (m.consensus.length) {
    lines.push('', '## 已达成的共识')
    m.consensus.forEach(c => lines.push(`- ${c.point}${c.who?.length ? `（${c.who.join('、')}）` : ''}`))
  }
  if (m.differences.length) {
    lines.push('', '## 分歧')
    m.differences.forEach(d => {
      lines.push(`### ${d.topic}`)
      ;(d.sides || []).forEach(sd => lines.push(`- **${sd.who || '一方'}**：${sd.view}`))
      if (d.note) lines.push(`> ${d.note}`)
    })
  }
  if (m.resolved?.length) { lines.push('', '## 本轮收敛'); m.resolved.forEach(x => lines.push(`- ${x}`)) }
  if (m.blind?.length) { lines.push('', '## 盲区'); m.blind.forEach(x => lines.push(`- ${x}`)) }
  if (m.next?.length) {
    lines.push('', '## 下一步可以这样问')
    m.next.forEach((x, i) => lines.push(`${i + 1}. ${x}`))
  }
  if (m.raw) lines.push('', m.raw)
  return lines.join('\n')
}

/* ================= 登录 / 注册 ================= */
/* 登录名别名：Supabase Auth 只接受邮箱格式（必须有 @），所以「ai」这种短名字在前端映射成真实账号邮箱。
   新增别名只需在这里加一行，键统一小写；输入里带 @ 的按原样走，兼容完整邮箱登录。 */
const LOGIN_ALIAS: Record<string, string> = {
  ai: 'ai@qq.com'
}
async function resolveLoginEmail(input: string): Promise<string> {
  const v = input.trim()
  if (!v) return v
  const alias = LOGIN_ALIAS[v.toLowerCase()]
  if (alias) return alias
  // 用户名可以是任意字符（含中文、空格、甚至 @），所以先查用户表；查不到再按邮箱原样走
  try {
    const { data } = await sb.rpc('resolve_login_email', { p_name: v })
    if (typeof data === 'string' && data.includes('@')) return data
  } catch { /* 表还没建时忽略，按原样继续 */ }
  return v
}

/* 只允许登录，不开放自助注册：账号统一由超级管理员在「设置 → 用户管理」创建
   （后台调用 Edge Function 走 Admin API，前端拿不到 service_role，普通用户无法注册） */
async function doLogin(emailInput: string, password: string): Promise<string | null> {
  // 返回 null 表示成功，否则返回错误提示文案
  const email = await resolveLoginEmail(emailInput)
  const { data, error } = await sb.auth.signInWithPassword({ email, password })
  if (error) {
    const m = error.message || ''
    if (m === 'Invalid login credentials') return '账号或密码不正确，请重试'
    // 被超管停用的账号：Supabase 用封禁（banned_until）实现，这里翻译成人话
    if (/banned/i.test(m)) return '该账号已被停用，请联系管理员'
    return '登录失败：' + m
  }
  await enterApp(data.user)
  return null
}

async function logout() {
  await sb.auth.signOut()
  state.user = null
  state.view = 'chat'
  state.currentConvId = null
  state.currentMessages = []
  state.liveCols = []
  resetSecretary()
}

async function changePassword(oldPass: string, newPass: string): Promise<string> {
  if (newPass.length < 6) return '新密码至少 6 位'
  const { error } = await sb.auth.signInWithPassword({ email: state.user.email, password: oldPass })
  if (error) return '原密码不正确'
  const { error: e2 } = await sb.auth.updateUser({ password: newPass })
  return e2 ? ('修改失败：' + e2.message) : ''
}

/* ================= 设置页操作 ================= */
async function saveProviderKey(key: string, rawVal: string): Promise<string | null> {
  const val = rawVal.trim().replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, '')
  if (!val) return '请先粘贴密钥'
  const hint = KEY_PREFIX_HINT[key]
  if (hint && !val.startsWith(hint.prefix) && !(hint.altPrefix && val.startsWith(hint.altPrefix))) {
    try {
      await ElMessageBox.confirm(
        `${hint.name} 的密钥通常以 "${hint.altPrefix || hint.prefix}" 开头，而你粘贴的密钥不是这个格式（可能是复制错了服务，或混入了多余文字）。仍要按原样保存吗？`,
        '密钥格式提醒', { type: 'warning', confirmButtonText: '仍要保存', cancelButtonText: '取消' })
    } catch { return null }
  }
  await upsertProvider(key, { api_key: val, enabled: true })
  await loadConfigs()
  ElMessage.success('密钥已保存到云端数据库（仅你本人可读取）')
  return null
}

async function saveBaseUrl(key: string, rawVal: string): Promise<void> {
  const val = (rawVal || '').trim().replace(/\/+$/, '')
  if (val && !/^https?:\/\//i.test(val)) { ElMessage.warning('接口地址需要以 https:// 开头，例如：https://4sapi.com/v1'); return }
  if (val) state.settings.baseUrls = { ...(state.settings.baseUrls || {}), [key]: val }
  else if (state.settings.baseUrls) delete state.settings.baseUrls[key]
  await persistSettings()
  await loadConfigs()
  ElMessage.success(val ? '接口地址已保存，请再点"拉取模型列表"获取该服务的真实模型' : '已恢复默认官方接口地址')
}

async function testProvider(key: string): Promise<void> {
  const p = providerOf(key)
  if (!p?.apiKey) { ElMessage.warning('请先保存该服务的 API 密钥'); return }
  state.testBusy[key] = true
  state.testResults[key] = `正在连接 ${p.name}……`
  let lastErr = ''
  try {
    for (const model of p.models) {
      state.testResults[key] = `正在测试 ${p.name} · ${model} ……`
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 25000)
      const r = await testProviderModel({ baseUrl: effBaseUrl(key), apiKey: p.apiKey, model, signal: ctrl.signal })
      clearTimeout(timer)
      if (r.ok) {
        state.testResults[key] = `✅ 连通成功（模型 ${model}）`
        currentModelSel[key] = model
        /* 测试成功的模型自动勾选为使用模型，并保存到数据库 */
        try {
          const rest = (state.settings.selModels?.[key] || []).filter((m: string) => m !== model)
          state.settings.selModels = { ...(state.settings.selModels || {}), [key]: [model, ...rest] }
          await persistSettings()
        } catch { /* 保存勾选失败不影响测试结果 */ }
        return
      }
      lastErr = `模型 ${model}：` + (r.status === -1
        ? (r.body === 'TIMEOUT' ? '连接超时（25 秒无响应）——检查网络' : '网络无法连接——接口从你的网络环境不可达')
        : friendlyTestError(r.status!, r.body || '', p.name, key))
      if (r.status !== 404) break
    }
    state.testResults[key] = '❌ ' + lastErr
  } finally {
    state.testBusy[key] = false
  }
}

/* 一键测试全部：并行测试所有已配置密钥的服务，结束后汇总成功数 */
async function testAllProviders(): Promise<void> {
  const targets = state.providers.filter(p => p.configured && p.apiKey)
  if (!targets.length) { ElMessage.warning('还没有配置任何密钥，请先在下方填入并保存'); return }
  if (state.testAllBusy) return
  state.testAllBusy = true
  ElMessage.info(`开始测试 ${targets.length} 家 AI 的连通性……`)
  try {
    await Promise.all(targets.map(p => testProvider(p.key)))
    const ok = targets.filter(p => (state.testResults[p.key] || '').startsWith('✅')).length
    const fail = targets.filter(p => (state.testResults[p.key] || '').startsWith('❌'))
      .map(p => p.name).join('、')
    if (ok === targets.length) {
      ElMessage.success(`测试完成：${targets.length} 家全部连通 ✅`)
    } else {
      ElMessage.warning(`测试完成：${ok}/${targets.length} 家连通成功，失败：${fail}`)
    }
  } finally {
    state.testAllBusy = false
  }
}

async function fetchModelList(key: string): Promise<void> {
  const p = providerOf(key)
  if (!p?.apiKey) { ElMessage.warning('请先保存该服务的 API 密钥'); return }
  state.modelBusy[key] = true
  try {
    const ids = await fetchModels(effBaseUrl(key), p.apiKey)
    state.settings.relayModels = { ...(state.settings.relayModels || {}), [key]: ids }
    await persistSettings()
    await loadConfigs()
    state.testResults[key] = `✅ 获取到 ${ids.length} 个模型，已在下方勾选列表中显示`
  } catch (e: any) {
    state.testResults[key] = '❌ 拉取模型列表失败：' + (e?.message || e)
  } finally {
    state.modelBusy[key] = false
  }
}

async function toggleProvider(key: string, enabled: boolean) {
  await upsertProvider(key, { enabled })
  await loadConfigs()
}

/* 设置勾选的模型列表：第一个勾选的为发送时使用的模型；变更立即保存到数据库 */
async function setSelModels(key: string, checked: string[]) {
  const p = providerOf(key)
  if (!p) return
  let next = p.models.filter(m => checked.includes(m))
  if (!next.length) next = [p.models[0]]   // 至少保留一个
  state.settings.selModels = { ...(state.settings.selModels || {}), [key]: next }
  currentModelSel[key] = next[0]
  try {
    await persistSettings()
  } catch (e: any) {
    ElMessage.error('模型选择保存失败：' + (e?.message || e))
  }
}

export interface UsageCell { tokens: number; cost: number }
export interface UsageRow {
  key: string; provider: string; model: string; label: string
  cells: Record<number, UsageCell>; tokens: number; cost: number; calls: number
}
export interface UsageMatrix {
  monthLabel: string
  days: number[]
  rows: UsageRow[]
  totals: { cells: Record<number, UsageCell>; tokens: number; cost: number }
}

/* 按月读取用量，聚合成"模型 × 日期"的矩阵（monthOffset=0 表示本月，-1 上月） */
async function loadUsage(monthOffset = 0): Promise<UsageMatrix> {
  const base = new Date()
  base.setDate(1); base.setHours(0, 0, 0, 0)
  base.setMonth(base.getMonth() + monthOffset)
  const end = new Date(base.getFullYear(), base.getMonth() + 1, 1)
  const daysInMonth = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate()

  const { data, error } = await sb.from('usage_logs')
    .select('provider, model, prompt_tokens, completion_tokens, cost_estimate, created_at')
    .gte('created_at', base.toISOString())
    .lt('created_at', end.toISOString())
    .limit(5000)
  if (error) throw error

  const map: Record<string, UsageRow> = {}
  ;(data || []).forEach((r: any) => {
    const key = r.provider + '|' + r.model
    if (!map[key]) {
      map[key] = {
        key, provider: r.provider, model: r.model,
        label: `${(PROVIDERS[r.provider] || {}).name || r.provider} · ${r.model}`,
        cells: {}, tokens: 0, cost: 0, calls: 0
      }
    }
    const row = map[key]
    const day = new Date(r.created_at).getDate()
    const tk = (r.prompt_tokens || 0) + (r.completion_tokens || 0)
    const cost = Number(r.cost_estimate) || 0
    if (!row.cells[day]) row.cells[day] = { tokens: 0, cost: 0 }
    row.cells[day].tokens += tk
    row.cells[day].cost += cost
    row.tokens += tk
    row.cost += cost
    row.calls++
  })

  /* 行顺序与聊天区一致：ChatGPT → Gemini → DeepSeek → Kimi */
  const rows = Object.values(map).sort(
    (a, b) => orderOf(a.provider) - orderOf(b.provider) || a.model.localeCompare(b.model)
  )

  const totals: UsageMatrix['totals'] = { cells: {}, tokens: 0, cost: 0 }
  rows.forEach(r => {
    Object.entries(r.cells).forEach(([d, c]) => {
      const day = Number(d)
      if (!totals.cells[day]) totals.cells[day] = { tokens: 0, cost: 0 }
      totals.cells[day].tokens += c.tokens
      totals.cells[day].cost += c.cost
    })
    totals.tokens += r.tokens
    totals.cost += r.cost
  })

  return {
    monthLabel: `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}`,
    days: Array.from({ length: daysInMonth }, (_, i) => i + 1),
    rows, totals
  }
}

/* ================= 会话 ================= */
async function newDraft() {
  if (state.discussing) { ElMessage.warning('当前回答进行中，请先点击"停止"'); return }
  state.currentConvId = null
  state.currentMessages = []
  state.liveCols = []
  state.chatTitle = '新对话'
  state.inputText = ''
  state.attachments = []
  resetSecretary()
}

async function openConversation(id: number) {
  if (state.discussing) { ElMessage.warning('当前回答进行中，请先点击"停止"'); return }
  const { data, error } = await sb.from('messages').select('*').eq('conversation_id', id).order('id')
  if (error) dbErr('读取历史消息', error)
  state.currentConvId = id
  state.currentMessages = data as any
  state.liveCols = []
  resetSecretary()
  const conv = state.conversations.find(c => c.id === id)
  state.chatTitle = conv ? conv.title : '对话'
}

async function deleteConversation(id: number) {
  if (state.discussing && id === state.currentConvId) { ElMessage.warning('当前回答进行中，请先点击"停止"'); return }
  try {
    await ElMessageBox.confirm('删除后无法恢复，确定删除这个会话吗？', '删除会话', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' })
  } catch { return }
  const { error } = await sb.from('conversations').delete().eq('id', id)
  if (error) { ElMessage.error('删除失败：' + error.message); return }
  if (id === state.currentConvId) { state.currentConvId = null; state.currentMessages = []; state.chatTitle = '新对话'; resetSecretary() }
  await loadConversations()
}

async function deleteCurrent() {
  if (state.currentConvId == null) { ElMessage.warning('当前没有已保存的会话'); return }
  await deleteConversation(state.currentConvId)
}

function exportCurrent() {
  if (!state.currentMessages.length) { ElMessage.warning('当前会话还没有内容'); return }
  const lines: string[] = [`# ${state.chatTitle}`, '']
  state.currentMessages.forEach(m => {
    if (m.sender === 'host') {
      /* 小秘书纪要：导出时转成可读文本，不要甩一段 JSON 出去 */
      const min = parseMinuteRow({ id: m.id, content: m.content, created_at: m.created_at })
      if (min) lines.push(minuteToText(min) + '\n')
    } else if (m.sender === 'user') {
      lines.push(`【我】\n${parseAtts(m.content).text}\n`)
    } else {
      lines.push(`【${(PROVIDERS[m.provider || ''] || {}).name || m.provider}】\n${m.content}\n`)
    }
  })
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${state.chatTitle}.txt`
  a.click()
  URL.revokeObjectURL(a.href)
}

/* ================= 发送（核心） ================= */
function stopAnswer() {
  state.stopFlag = true
  aborters.forEach(c => { try { c.abort() } catch { /* ignore */ } })
  aborters = []
}
let aborters: AbortController[] = []

async function logUsage(provider: string, model: string, usage: { pt: number; ct: number }) {
  const price = (PROVIDERS[provider] || {}).price || { in: 0, out: 0 }
  const cost = (usage.pt * price.in + usage.ct * price.out) / 1e6
  try {
    await sb.from('usage_logs').insert({
      user_id: state.user.id, provider, model,
      prompt_tokens: usage.pt, completion_tokens: usage.ct,
      cost_estimate: Number(cost.toFixed(6))
    })
  } catch { /* 用量记录失败不影响回答 */ }
}

async function saveMessage(m: Partial<DbMessage>): Promise<number> {
  const { data, error } = await sb.from('messages').insert({
    conversation_id: m.conversation_id, sender: m.sender, provider: m.provider || null,
    model: m.model || null, round_no: 0, content: m.content || '', tokens: m.tokens || 0, status: m.status || 'done'
  }).select('id').single()
  if (error) dbErr('保存消息', error)
  return data.id
}

async function send() {
  const text = state.inputText.trim()
  const atts = state.attachments.slice()
  if (!text && !atts.length) { ElMessage.warning('请输入消息，或点绿色 ＋ 添加附件'); return }
  if (state.discussing) return

  const participants = state.providers
    .filter(p => p.configured && p.enabled)
    .map(p => ({ provider: p.key, model: currentModelSel[p.key] || p.models[0] }))
  if (!participants.length) { ElMessage.warning('没有可用的 AI：请先在设置页配置密钥并启用'); return }

  state.discussing = true
  state.stopFlag = false

  try {
    const fullContent = serializeAtts(text, atts)
    const title = (text || atts.map(a => a.name).join('、')).slice(0, 20)
    state.chatTitle = title
    state.inputText = ''
    state.attachments = []

    /* 建立/更新会话 + 保存用户消息 */
    if (state.currentConvId === null) {
      const { data, error } = await sb.from('conversations').insert({
        title, mode: 'solo', participants, rounds: 0, status: 'active'
      }).select('id').single()
      if (error) dbErr('创建会话', error)
      state.currentConvId = data.id
      await loadConversations()
    } else {
      await sb.from('conversations').update({
        participants, status: 'active', updated_at: new Date().toISOString()
      }).eq('id', state.currentConvId)
    }
    const um = await saveMessage({ conversation_id: state.currentConvId!, sender: 'user', content: fullContent })
    const userMsg: DbMessage = { id: um, conversation_id: state.currentConvId!, sender: 'user', content: fullContent, tokens: 0, status: 'done' }
    state.currentMessages.push(userMsg)

    /* 同时发给所有 AI：并行流式回答。
       关键：回答进行期间不把已完成的写入历史消息（否则会额外渲染一个历史网格、
       页面反复重排）。所有 AI 都固定在 liveCols 自己的"跑道"里，直到全部跑完 */
    state.liveCols = participants.map(p => ({ provider: p.provider, model: p.model, text: '', state: 'running' as const }))
    const historySnapshot = state.currentMessages.slice()
    aborters = participants.map(() => new AbortController())
    const finished: DbMessage[] = []

    await Promise.all(participants.map(async (p, i) => {
      const col = state.liveCols[i]
      try {
        const { content, usage, model: usedModel, note } = await callOne(
          { provider: p.provider, model: p.model },
          historySnapshot, text, atts,
          (_d, all) => { col.text = all },
          aborters[i].signal
        )
        col.text = content
        /* 带图时可能换用视觉模型：表头显示实际用的模型，避免"表头与报错对不上" */
        col.model = usedModel
        if (note) col.note = note
        col.state = 'done'
        const id = await saveMessage({
          conversation_id: state.currentConvId!, sender: 'assistant',
          provider: p.provider, model: usedModel, content, tokens: usage.ct
        })
        finished.push({ id, conversation_id: state.currentConvId!, sender: 'assistant', provider: p.provider, model: usedModel, content, tokens: usage.ct, status: 'done' })
        logUsage(p.provider, usedModel, usage)
      } catch (e: any) {
        const aborted = e?.name === 'AbortError' || state.stopFlag
        const raw = aborted ? '已停止' : (e?.message || String(e))
        const msg = (!aborted && isSafetyBlock(raw))
          ? raw + `\n\n提示：这是 ${providerOf(p.provider)?.name || p.provider} 上游的内容安全策略拦截，与你的密钥和网站代码无关。上游会累计「拒绝次数」，反复重试可能延长临时限制；建议换成同家其他模型，或过几小时再试。`
          : raw
        col.state = 'error'
        col.error = msg
        if (!aborted) {
          try {
            /* 把真实原因存进去：否则历史里只剩一句"本次调用失败"，事后无法定位 */
            const id = await saveMessage({ conversation_id: state.currentConvId!, sender: 'assistant', provider: p.provider, model: p.model, content: msg.slice(0, 800), status: 'error' })
            finished.push({ id, conversation_id: state.currentConvId!, sender: 'assistant', provider: p.provider, model: p.model, content: msg.slice(0, 800), tokens: 0, status: 'error' })
          } catch { /* ignore */ }
        }
      }
    }))

    await sb.from('conversations').update({ status: state.stopFlag ? 'stopped' : 'completed', updated_at: new Date().toISOString() }).eq('id', state.currentConvId)
    /* 全部跑完：先撤掉进行中的跑道，再按固定顺序一次性归入历史消息 */
    state.liveCols = []
    finished.sort((a, b) => orderOf(a.provider || '') - orderOf(b.provider || ''))
    state.currentMessages.push(...finished)
    await loadConversations()
  } catch (e: any) {
    ElMessage.error('发送失败：' + (e?.message || e))
  } finally {
    aborters = []
    state.discussing = false
  }
}

/* ================= 单列重试：某一家失败，不必整条消息重发 ================= */
async function retryOne(m: DbMessage) {
  if (state.discussing) { ElMessage.warning('请等当前回答结束后再重试'); return }
  /* 安全策略拦截：重试只会累加"拒绝次数"，挡住，不让人越点越糟 */
  if (isSafetyBlock(m.content)) {
    ElMessage.warning('这是上游内容安全策略拦截，原样重试大概率仍会被拒，还可能延长限制。建议换模型或稍后再试')
    return
  }
  if (!m.provider || state.currentConvId == null) return
  const prov = providerOf(m.provider)
  if (!prov?.apiKey) { ElMessage.warning('该服务的密钥不可用，请到设置页重新配置'); return }
  const idx = state.currentMessages.findIndex(x => x.id === m.id)
  if (idx < 0) return
  let uIdx = -1
  for (let k = idx - 1; k >= 0; k--) {
    if (state.currentMessages[k].sender === 'user') { uIdx = k; break }
  }
  if (uIdx < 0) return

  const { text, atts } = parseAtts(state.currentMessages[uIdx].content)
  const history = state.currentMessages.slice(0, uIdx + 1)
  const model = m.model || prov.models[0]

  state.discussing = true
  state.stopFlag = false
  state.retryingId = m.id
  const ctrl = new AbortController()
  aborters = [ctrl]
  try {
    const r = await callOne({ provider: m.provider, model }, history, text, atts, () => { /* 历史卡片只在结束时更新 */ }, ctrl.signal)
    m.content = r.content
    m.status = 'done'
    m.model = r.model
    m.tokens = r.usage.ct
    try {
      await sb.from('messages').update({ content: r.content, status: 'done', model: r.model, tokens: r.usage.ct }).eq('id', m.id)
    } catch { /* 落库失败不影响本次展示 */ }
    logUsage(m.provider, r.model, r.usage)
    ElMessage.success(`${prov.name} 重试成功`)
  } catch (e: any) {
    const msg = e?.name === 'AbortError' ? '已停止' : (e?.message || String(e))
    m.content = msg.slice(0, 500)
    m.status = 'error'
    try { await sb.from('messages').update({ content: m.content, status: 'error' }).eq('id', m.id) } catch { /* ignore */ }
    ElMessage.error(`${prov.name} 仍然失败（原因已写在该列）`)
  } finally {
    state.retryingId = 0
    state.discussing = false
    aborters = []
  }
}

/* ================= 附件 ================= */
async function addFiles(files: File[]) {
  for (const f of files) {
    if (state.attachments.length >= ATT_COUNT_MAX) { ElMessage.warning(`一条消息最多 ${ATT_COUNT_MAX} 个附件`); break }
    try {
      state.attachments.push(await processFile(f))
    } catch (e: any) {
      ElMessage.error('附件处理失败：' + (e?.message || e))
    }
  }
}
function removeAttachment(i: number) { state.attachments.splice(i, 1) }

/* 编辑重发：把历史消息还原到输入框 */
function editResend(content: string) {
  const { text, atts } = parseAtts(content)
  state.inputText = text || ''
  state.attachments = (atts || []).slice()
}

/* ================= 供组件使用 ================= */
const usableProviders = computed(() => state.providers.filter(p => p.configured && p.enabled))

export const store = {
  state, currentModelSel, usableProviders, secretaryModel,
  effBaseUrl, providerOf,
  enterApp, doLogin, logout, changePassword,
  saveProviderKey, saveBaseUrl, testProvider, fetchModelList, toggleProvider, setSelModels, loadUsage,
  testAllProviders,
  loadConversations, openConversation, deleteConversation, deleteCurrent, newDraft, exportCurrent,
  send, stopAnswer, retryOne, addFiles, removeAttachment, editResend,
  loadInsights, openInsightEditor, closeInsightEditor, draftInsight, saveInsight, deleteInsight,
  shareInsight, unshareInsight, loadSharedInsight,
  loadMinutes, toggleSecretaryMenu, closeSecretaryMenu, openSecretary, closeSecretary,
  setActiveMinute, summarizeNow, stopSummarize, deleteMinute, minuteToText, saveSecretaryConf,
  setView: (v: View) => { state.view = v }
}

export type Store = typeof store

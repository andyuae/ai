import { reactive, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { sb } from './lib/supabase'
import { PROVIDERS, KEY_PREFIX_HINT } from './config'
import type { Conversation, DbMessage, LiveCol, ProviderState, SettingsData, Attachment } from './lib/types'
import { serializeAtts, parseAtts, processFile, ATT_COUNT_MAX } from './lib/atts'
import { buildMessages, callAI, testProviderModel, friendlyTestError, fetchModels } from './lib/ai'

type View = 'chat' | 'settings'

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
  modelBusy: {} as Record<string, boolean>,
  chatTitle: '新对话'
})

const currentModelSel: Record<string, string> = {}

function effBaseUrl(key: string): string {
  return state.settings.baseUrls?.[key] || PROVIDERS[key].baseUrl
}
function providerOf(key: string): ProviderState | undefined {
  return state.providers.find(p => p.key === key)
}

function dbErr(op: string, error: any): never {
  throw new Error(op + '失败：' + (error?.message || error))
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
  Object.keys(currentModelSel).forEach(k => delete currentModelSel[k])
  state.providers.forEach(p => { if (p.enabled && p.models.length) currentModelSel[p.key] = p.models[0] })
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

/* ================= 登录 / 注册 ================= */
async function doLogin(email: string, password: string, signup: boolean): Promise<string | null> {
  // 返回 null 表示成功，否则返回错误提示文案
  if (signup) {
    if (password.length < 6) return '密码至少 6 位'
    const { error } = await sb.auth.signUp({ email, password })
    if (error) return '注册失败：' + error.message
    return 'SIGNUP_OK'
  }
  const { data, error } = await sb.auth.signInWithPassword({ email, password })
  if (error) return error.message === 'Invalid login credentials' ? '邮箱或密码不正确，请重试' : ('登录失败：' + error.message)
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

async function fetchModelList(key: string): Promise<void> {
  const p = providerOf(key)
  if (!p?.apiKey) { ElMessage.warning('请先保存该服务的 API 密钥'); return }
  state.modelBusy[key] = true
  try {
    const ids = await fetchModels(effBaseUrl(key), p.apiKey)
    state.settings.relayModels = { ...(state.settings.relayModels || {}), [key]: ids }
    await persistSettings()
    await loadConfigs()
    state.testResults[key] = `✅ 获取到 ${ids.length} 个模型，已在聊天页模型下拉框中显示`
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

async function loadUsage(): Promise<{ label: string; detail: string }[]> {
  const monthStart = new Date()
  monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0)
  const { data, error } = await sb.from('usage_logs')
    .select('provider, model, prompt_tokens, completion_tokens, cost_estimate, created_at')
    .gte('created_at', monthStart.toISOString())
  if (error) throw error
  const agg: Record<string, any> = {}
  data.forEach((r: any) => {
    const k = r.provider + '|' + r.model
    agg[k] = agg[k] || { provider: r.provider, model: r.model, calls: 0, pt: 0, ct: 0, cost: 0 }
    agg[k].calls++; agg[k].pt += r.prompt_tokens || 0; agg[k].ct += r.completion_tokens || 0
    agg[k].cost += Number(r.cost_estimate) || 0
  })
  return Object.values(agg).map((r: any) => ({
    label: `${(PROVIDERS[r.provider] || {}).name || r.provider} · ${r.model}`,
    detail: `${r.calls} 次 · 输入 ${r.pt.toLocaleString()} / 输出 ${r.ct.toLocaleString()} tokens · 约 ¥${r.cost.toFixed(2)}`
  }))
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
}

async function openConversation(id: number) {
  if (state.discussing) { ElMessage.warning('当前回答进行中，请先点击"停止"'); return }
  const { data, error } = await sb.from('messages').select('*').eq('conversation_id', id).order('id')
  if (error) dbErr('读取历史消息', error)
  state.currentConvId = id
  state.currentMessages = data as any
  state.liveCols = []
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
  if (id === state.currentConvId) { state.currentConvId = null; state.currentMessages = []; state.chatTitle = '新对话' }
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
    if (m.sender === 'user') lines.push(`【我】\n${parseAtts(m.content).text}\n`)
    else lines.push(`【${(PROVIDERS[m.provider || ''] || {}).name || m.provider}】\n${m.content}\n`)
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
    const um = await saveMessage({ conversation_id: state.currentConvId, sender: 'user', content: fullContent })
    const userMsg: DbMessage = { id: um, conversation_id: state.currentConvId, sender: 'user', content: fullContent, tokens: 0, status: 'done' }
    state.currentMessages.push(userMsg)

    /* 同时发给所有 AI：并行流式回答 */
    state.liveCols = participants.map(p => ({ provider: p.provider, model: p.model, text: '', state: 'running' as const }))
    const deepseekKey = (providerOf('deepseek') || {}).apiKey
    const historySnapshot = state.currentMessages.slice()
    aborters = participants.map(() => new AbortController())

    await Promise.all(participants.map(async (p, i) => {
      const col = state.liveCols[i]
      const prov = providerOf(p.provider)!
      try {
        const { content, usage } = await callAI({
          provider: p.provider, model: p.model,
          messages: buildMessages(p.provider, p.model, historySnapshot, text, atts),
          apiKey: prov.apiKey!, baseUrl: effBaseUrl(p.provider),
          deepseekApiKey: deepseekKey,
          onDelta: (_d, all) => { col.text = all },
          signal: aborters[i].signal
        })
        col.text = content
        col.state = 'done'
        const id = await saveMessage({
          conversation_id: state.currentConvId!, sender: 'assistant',
          provider: p.provider, model: p.model, content, tokens: usage.ct
        })
        state.currentMessages.push({ id, conversation_id: state.currentConvId!, sender: 'assistant', provider: p.provider, model: p.model, content, tokens: usage.ct, status: 'done' })
        logUsage(p.provider, p.model, usage)
      } catch (e: any) {
        const aborted = e?.name === 'AbortError' || state.stopFlag
        col.state = 'error'
        col.error = aborted ? '已停止' : (e?.message || String(e))
        if (!aborted) {
          try {
            const id = await saveMessage({ conversation_id: state.currentConvId!, sender: 'assistant', provider: p.provider, model: p.model, content: '', status: 'error' })
            state.currentMessages.push({ id, conversation_id: state.currentConvId!, sender: 'assistant', provider: p.provider, model: p.model, content: '', tokens: 0, status: 'error' })
          } catch { /* ignore */ }
        }
      }
    }))

    await sb.from('conversations').update({ status: state.stopFlag ? 'stopped' : 'completed', updated_at: new Date().toISOString() }).eq('id', state.currentConvId)
    state.liveCols = []
    await loadConversations()
  } catch (e: any) {
    ElMessage.error('发送失败：' + (e?.message || e))
  } finally {
    aborters = []
    state.discussing = false
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
  state, currentModelSel, usableProviders,
  effBaseUrl, providerOf,
  enterApp, doLogin, logout, changePassword,
  saveProviderKey, saveBaseUrl, testProvider, fetchModelList, toggleProvider, loadUsage,
  loadConversations, openConversation, deleteConversation, deleteCurrent, newDraft, exportCurrent,
  send, stopAnswer, addFiles, removeAttachment, editResend,
  setView: (v: View) => { state.view = v }
}

export type Store = typeof store

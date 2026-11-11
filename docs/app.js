/**
 * app.js —— AI 圆桌前端逻辑（云端直连版）
 * 架构：GitHub Pages 静态界面 + Supabase 云数据库 + 浏览器直连各家 AI API
 * 依赖：supabase.min.js（CDN）、config.js（连接配置与 AI 服务商信息）
 */

const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_KEY);
const PROVIDER_META = window.PROVIDERS;

/* ---------- 通用 ---------- */
const $ = id => document.getElementById(id);
function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function showView(v) {
  document.querySelectorAll('.view').forEach(e => e.classList.remove('active'));
  $('view-' + v).classList.add('active');
}

/* ---------- 状态 ---------- */
let user = null;           // 当前登录用户
let providers = [];        // 服务商状态（静态配置 + 数据库密钥行合并）
let settings = null;       // 偏好设置（settings.data）
let conversations = [];    // 会话列表
let currentConvId = null;  // 当前会话
let currentMessages = [];  // 当前会话消息（含本地新增）
let mode = 'roundtable';
let discussing = false;    // 是否正在讨论
let stopFlag = false;      // 停止标记
let aborters = [];         // 进行中的 fetch 控制器
let currentModelSel = {};  // provider -> model（临时选择）
let signupMode = false;    // 登录页：注册模式

/* ================= 登录 / 注册 ================= */
function setLoginError(msg) {
  const el = $('login-error');
  el.textContent = msg || '邮箱或密码不正确，请重试';
  el.style.display = 'block';
}

async function doLogin() {
  const email = $('login-user').value.trim();
  const password = $('login-pass').value.trim();
  $('login-error').style.display = 'none';
  $('login-neterr').style.display = 'none';
  if (!email || !password) { setLoginError(signupMode ? '请填写邮箱和密码（至少 6 位）' : '请填写邮箱和密码'); return; }
  $('btn-login').disabled = true;
  $('btn-signup').disabled = true;
  try {
    if (signupMode) {
      if (password.length < 6) { setLoginError('密码至少 6 位'); return; }
      const { error } = await sb.auth.signUp({ email, password });
      if (error) throw error;
      setLoginError('');
      $('login-error').style.display = 'block';
      $('login-error').textContent = '✅ 账号创建成功，请使用邮箱和密码登录';
      toggleSignup(false);
      return;
    }
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      setLoginError(error.message === 'Invalid login credentials' ? '邮箱或密码不正确，请重试' : ('登录失败：' + error.message));
      return;
    }
    await enterApp(data.user);
  } catch (e) {
    if (e.message && /fetch|network/i.test(e.message)) $('login-neterr').style.display = 'block';
    else setLoginError('登录失败：' + (e.message || e));
  } finally {
    $('btn-login').disabled = false;
    $('btn-signup').disabled = false;
  }
}

function toggleSignup(on) {
  signupMode = on;
  $('btn-login').style.display = on ? 'none' : 'inline-block';
  $('btn-signup').style.display = on ? 'inline-block' : 'none';
  $('link-toggle').textContent = on ? '返回登录' : '点这里创建账号';
  $('login-error').style.display = 'none';
}

function logout(calledByUser) {
  if (calledByUser) sb.auth.signOut();
  showView('login');
}

async function enterApp(u) {
  user = u;
  await Promise.all([loadConfigs(), loadSettings(), loadConversations()]);
  const hasKey = providers.some(p => p.configured && p.enabled);
  showView('chat');
  if (!hasKey) {
    if (confirm('检测到你还没有配置任何 AI 密钥。\n\n是否现在前往"设置"页填写 API 密钥？\n（国内：DeepSeek、Kimi 官网注册充值即可获取）')) openSettings();
  }
  newDraft();
}

/* ================= 数据层（Supabase） ================= */
function dbErr(op, error) {
  throw new Error(op + '失败：' + (error && error.message ? error.message : error));
}

async function loadConfigs() {
  const { data, error } = await sb.from('provider_configs').select('*');
  if (error) dbErr('读取密钥配置', error);
  const map = {};
  data.forEach(r => { map[r.provider] = r; });
  providers = Object.entries(PROVIDER_META).map(([key, meta]) => {
    const row = map[key] || {};
    return {
      key, name: meta.name, models: meta.models, modelLabel: meta.modelLabel,
      oversea: !!meta.oversea,
      configured: !!row.api_key,
      enabled: row.enabled !== false,
      apiKey: row.api_key || null
    };
  });
  currentModelSel = {};
  providers.forEach(p => { if (p.enabled && p.models.length) currentModelSel[p.key] = p.models[0]; });
  renderChips();
  renderProviderSettings();
}

async function upsertProvider(provider, patch) {
  const payload = Object.assign({ user_id: user.id, provider }, patch);
  const { error } = await sb.from('provider_configs').upsert(payload, { onConflict: 'user_id,provider' });
  if (error) dbErr('保存密钥配置', error);
}

const DEFAULT_SETTINGS = {
  default_mode: 'roundtable', default_rounds: 2,
  host_provider: 'deepseek', host_model: 'deepseek-reasoner',
  default_participants: []
};

async function loadSettings() {
  const { data, error } = await sb.from('settings').select('*').eq('user_id', user.id).maybeSingle();
  if (error) dbErr('读取偏好设置', error);
  settings = Object.assign({}, DEFAULT_SETTINGS, (data && data.data) || {});
  mode = settings.default_mode || 'roundtable';
  renderChips();
  $('set-mode').value = settings.default_mode;
  $('set-rounds').value = String(settings.default_rounds);
  const hostSel = $('set-host');
  hostSel.innerHTML = '';
  providers.forEach(p => p.models.forEach(m => {
    const o = document.createElement('option');
    o.value = p.key + '|' + m;
    o.textContent = `${p.name}（${p.modelLabel[m] || m}）`;
    if (p.key === settings.host_provider && m === settings.host_model) o.selected = true;
    hostSel.appendChild(o);
  }));
  const setMembers = $('set-members');
  setMembers.innerHTML = '';
  providers.forEach(p => {
    const chip = document.createElement('span');
    const isOn = (settings.default_participants || []).some(x => x.provider === p.key);
    chip.className = 'member-chip' + (isOn && p.configured && p.enabled ? ' on' : '');
    chip.dataset.provider = p.key;
    chip.innerHTML = `<span class="dot"></span>${p.name}`;
    chip.onclick = () => chip.classList.toggle('on');
    setMembers.appendChild(chip);
  });
}

async function saveSettings() {
  const host = $('set-host').value.split('|');
  const members = [...$('set-members').querySelectorAll('.member-chip.on')]
    .map(c => ({ provider: c.dataset.provider, model: (providers.find(p => p.key === c.dataset.provider).models[0]) }));
  const data = {
    default_mode: $('set-mode').value,
    default_rounds: Number($('set-rounds').value),
    host_provider: host[0],
    host_model: host[1],
    default_participants: members
  };
  const { error } = await sb.from('settings').upsert({ user_id: user.id, data }, { onConflict: 'user_id' });
  if (error) dbErr('保存偏好设置', error);
  await loadSettings();
  alert('讨论设置已保存');
}

async function loadConversations() {
  const { data, error } = await sb.from('conversations').select('*').order('updated_at', { ascending: false });
  if (error) dbErr('读取会话列表', error);
  conversations = data;
  renderSessions();
}

/* ================= 设置页 ================= */
async function openSettings() {
  showView('settings');
  renderProviderSettings();
  loadUsage();
}

function renderProviderSettings() {
  const list = $('provider-list');
  const switches = $('provider-switches');
  list.innerHTML = '';
  switches.innerHTML = '';
  providers.forEach(p => {
    const row = document.createElement('div');
    row.className = 'api-row';
    row.innerHTML = `
      <span class="api-name">${p.name}${p.oversea ? ' <span class="muted small">(海外)</span>' : ''}</span>
      <span class="api-status ${p.configured ? 'st-ok' : 'st-no'}">${p.configured ? '已配置' : '未配置'}</span>
      <input type="password" placeholder="${p.configured ? '输入新密钥可更换' : '粘贴 API 密钥'}" id="key-${p.key}">
      <button class="btn-save" data-p="${p.key}">保存密钥</button>`;
    list.appendChild(row);
    row.querySelector('button').onclick = () => saveProviderKey(p.key);

    const sw = document.createElement('div');
    sw.className = 'form-line';
    sw.innerHTML = `<label>${p.name}${p.configured ? '' : '（未配置密钥）'}</label>
      <span class="switch ${p.enabled ? 'on' : ''}" data-p="${p.key}"></span>`;
    switches.appendChild(sw);
    sw.querySelector('.switch').onclick = async (e) => {
      const el = e.target;
      const next = !el.classList.contains('on');
      await upsertProvider(p.key, { enabled: next });
      el.classList.toggle('on', next);
      await loadConfigs();
    };
  });
}

async function saveProviderKey(key) {
  const input = $('key-' + key);
  const val = input.value.trim();
  if (!val) { alert('请先粘贴密钥'); return; }
  await upsertProvider(key, { api_key: val, enabled: true });
  input.value = '';
  await loadConfigs();
  alert('密钥已保存到云端数据库（仅你本人可读取）');
}

async function loadUsage() {
  $('usage-list').textContent = '加载中……';
  try {
    const monthStart = new Date();
    monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const { data, error } = await sb.from('usage_logs')
      .select('provider, model, prompt_tokens, completion_tokens, cost_estimate, created_at')
      .gte('created_at', monthStart.toISOString());
    if (error) throw error;
    if (!data.length) { $('usage-list').textContent = '本月暂无调用记录'; return; }
    const agg = {};
    data.forEach(r => {
      const k = r.provider + '|' + r.model;
      agg[k] = agg[k] || { provider: r.provider, model: r.model, calls: 0, pt: 0, ct: 0, cost: 0 };
      agg[k].calls++; agg[k].pt += r.prompt_tokens || 0; agg[k].ct += r.completion_tokens || 0;
      agg[k].cost += Number(r.cost_estimate) || 0;
    });
    $('usage-list').innerHTML = Object.values(agg).map(r => {
      const name = (PROVIDER_META[r.provider] || {}).name || r.provider;
      return `<div class="usage-row"><span>${name} · ${r.model}</span>
        <span class="muted">${r.calls} 次 · 输入 ${r.pt.toLocaleString()} / 输出 ${r.ct.toLocaleString()} tokens · 约 ¥${r.cost.toFixed(2)}</span></div>`;
    }).join('');
  } catch (e) {
    $('usage-list').textContent = '统计加载失败：' + e.message;
  }
}

/* ================= 会话列表 ================= */
function renderSessions() {
  const el = $('session-list');
  el.innerHTML = '';
  conversations.forEach(c => {
    const d = document.createElement('div');
    d.className = 'session-item' + (c.id === currentConvId ? ' current' : '');
    const stMap = { active: '', completed: '', stopped: '（已停止）' };
    d.innerHTML = `${esc(c.title)} <span class="st">${stMap[c.status] || ''}</span>
      <span class="time">${fmtTime(c.updated_at)}</span>`;
    d.onclick = () => openConversation(c.id);
    el.appendChild(d);
  });
}

async function openConversation(id) {
  if (discussing) { alert('当前讨论进行中，请先点击"停止"'); return; }
  currentConvId = id;
  renderSessions();
  const conv = conversations.find(c => c.id === id);
  const { data, error } = await sb.from('messages').select('*').eq('conversation_id', id).order('id');
  if (error) dbErr('读取消息', error);
  currentMessages = data;
  mode = (conv && conv.mode) || 'roundtable';
  renderChips();
  $('chat-title').textContent = conv ? conv.title : '讨论';
  $('chat-sub').textContent = `${mode === 'roundtable' ? '圆桌模式' : '快速模式'} · ${((conv && conv.participants) || []).length} 个 AI 参与`;
  const box = $('messages');
  box.innerHTML = '';
  currentMessages.forEach(appendMessageFromDb);
  box.scrollTop = box.scrollHeight;
}

function newDraft() {
  if (discussing) { alert('当前讨论进行中，请先点击"停止"'); return; }
  currentConvId = null; currentMessages = [];
  $('messages').innerHTML = '';
  $('chat-title').textContent = '新讨论';
  $('chat-sub').textContent = '';
  $('chat-input').value = '';
  renderSessions();
  renderChips();
  $('chat-input').focus();
}

/* ================= 消息渲染 ================= */
function senderLabel(m) {
  if (m.sender === 'user') return { name: '我', av: 'av-me' };
  if (m.sender === 'host') return { name: '主持人 · 综合方案', av: 'av-host' };
  const meta = PROVIDER_META[m.provider] || { name: m.provider };
  const prov = providers.find(p => p.key === m.provider) || {};
  const modelTxt = m.model ? ` · ${prov.modelLabel?.[m.model] || m.model}` : '';
  return { name: meta.name + modelTxt, av: `av-${m.provider}` };
}

function appendMessageFromDb(m) {
  const s = senderLabel(m);
  const box = $('messages');
  const div = document.createElement('div');
  div.className = 'msg' + (m.sender === 'user' ? ' mine' : '');
  div.dataset.msgId = m.id;
  const summary = m.sender === 'host';
  div.innerHTML = `<div class="avatar ${s.av}">${m.sender === 'user' ? '我' : ''}</div>
    <div class="bubble-wrap"><div class="sender">${esc(s.name)}</div>
    <div class="bubble ${summary ? 'summary' : ''}">${summary ? '<div class="sum-title">综合方案</div>' : ''}${esc(m.content)}
    ${m.status === 'error' ? '<span class="err">（本次调用失败）</span>' : ''}</div></div>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

function addPhaseTip(text) {
  const box = $('messages');
  const d = document.createElement('div');
  d.className = 'phase-tip';
  d.textContent = text;
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
  return d;
}

/* ================= 聊天输入区 ================= */
function renderChips() {
  const chips = $('member-chips');
  chips.innerHTML = '';
  providers.forEach(p => {
    const chip = document.createElement('span');
    const usable = p.configured && p.enabled;
    const isDefault = (settings && (settings.default_participants || []).some(x => x.provider === p.key));
    chip.className = 'member-chip' + (usable && (isDefault || !settings) ? ' on' : '') + (usable ? '' : ' disabled');
    if (usable) chip.dataset.provider = p.key;
    chip.innerHTML = `<span class="dot"></span>${p.name} <select>${p.models.map(m =>
      `<option value="${m}" ${currentModelSel[p.key] === m ? 'selected' : ''}>${p.modelLabel[m] || m}</option>`).join('')}</select>`;
    const sel = chip.querySelector('select');
    sel.onchange = e => { e.stopPropagation(); currentModelSel[p.key] = e.target.value; };
    sel.onclick = e => e.stopPropagation();
    chip.onclick = () => { if (usable) chip.classList.toggle('on'); };
    chips.appendChild(chip);
  });
  updateModeUI();
}

function setMode(m) { mode = m; updateModeUI(); }
function updateModeUI() {
  $('mode-round').classList.toggle('on', mode === 'roundtable');
  $('mode-fast').classList.toggle('on', mode === 'fast');
  const sub = $('chat-sub').textContent;
  if (/圆桌模式|快速模式/.test(sub)) $('chat-sub').textContent = sub.replace(/圆桌模式|快速模式/, mode === 'roundtable' ? '圆桌模式' : '快速模式');
}

function currentParticipants() {
  return [...document.querySelectorAll('#member-chips .member-chip.on[data-provider]')]
    .map(c => ({ provider: c.dataset.provider, model: currentModelSel[c.dataset.provider] }));
}

/* ================= AI 直连调用（OpenAI 兼容流式接口） ================= */
async function callAI({ provider, model, messages, onDelta }) {
  const conf = PROVIDER_META[provider];
  const prov = providers.find(p => p.key === provider);
  if (!prov || !prov.apiKey) throw new Error(`${conf.name} 未配置 API 密钥`);
  const ctrl = new AbortController();
  aborters.push(ctrl);
  const res = await fetch(conf.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + prov.apiKey },
    body: JSON.stringify({ model, messages, stream: true }),
    signal: ctrl.signal
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch (_) {}
    throw new Error(`${conf.name} 接口错误 HTTP ${res.status} ${detail}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', content = '', usage = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        const delta = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
        if (delta) { content += delta; onDelta && onDelta(delta, content); }
        if (json.usage) usage = { pt: json.usage.prompt_tokens || 0, ct: json.usage.completion_tokens || 0 };
      } catch (_) { /* 忽略不完整行 */ }
    }
  }
  if (!usage) usage = { pt: 0, ct: Math.round(content.length / 1.5) };
  return { content, usage };
}

async function logUsage(provider, model, usage) {
  const price = (PROVIDER_META[provider] || {}).price || { in: 0, out: 0 };
  const cost = (usage.pt * price.in + usage.ct * price.out) / 1e6;
  try {
    await sb.from('usage_logs').insert({
      user_id: user.id, provider, model,
      prompt_tokens: usage.pt, completion_tokens: usage.ct,
      cost_estimate: Number(cost.toFixed(6))
    });
  } catch (_) { /* 用量记录失败不影响讨论 */ }
}

async function saveMessage(m) {
  const { data, error } = await sb.from('messages').insert({
    conversation_id: m.conversation_id, sender: m.sender, provider: m.provider || null,
    model: m.model || null, round_no: m.round_no || null,
    content: m.content || '', tokens: m.tokens || 0, status: m.status || 'done'
  }).select('id').single();
  if (error) dbErr('保存消息', error);
  return data.id;
}

/* ================= 圆桌讨论编排 ================= */
function makeStreamBubble(provider, model, isHost) {
  const s = senderLabel({ sender: isHost ? 'host' : 'assistant', provider, model });
  const box = $('messages');
  const div = document.createElement('div');
  div.className = 'msg';
  div.innerHTML = `<div class="avatar ${s.av}"></div>
    <div class="bubble-wrap"><div class="sender">${esc(s.name)}</div>
    <div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div></div>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return { div, bubble: div.querySelector('.bubble'), text: '' };
}

function transcriptFor(curProvider) {
  return currentMessages.map(m => {
    if (m.sender === 'user') return `【用户】${m.content}`;
    const name = m.sender === 'host' ? '主持人' : (PROVIDER_META[m.provider] || {}).name || m.provider;
    return `【${name}】${m.content}`;
  }).join('\n\n');
}

async function memberTurn({ convId, provider, model, roundNo, system, userPrompt, isHost }) {
  const st = makeStreamBubble(provider, model, isHost);
  try {
    const { content, usage } = await callAI({
      provider, model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: userPrompt }],
      onDelta: (delta, all) => {
        st.text = all;
        st.bubble.textContent = all;
        const box = $('messages');
        if (box.scrollHeight - box.scrollTop - box.clientHeight < 120) box.scrollTop = box.scrollHeight;
      }
    });
    st.bubble.textContent = content;
    const id = await saveMessage({
      conversation_id: convId, sender: isHost ? 'host' : 'assistant',
      provider, model, round_no: roundNo, content, tokens: usage.ct
    });
    currentMessages.push({ id, conversation_id: convId, sender: isHost ? 'host' : 'assistant', provider, model, round_no: roundNo, content, status: 'done' });
    logUsage(provider, model, usage);
    return true;
  } catch (e) {
    const msg = (e && e.name === 'AbortError') ? '已停止' : e.message;
    st.bubble.innerHTML = `<span class="err">${esc((PROVIDER_META[provider] || {}).name || provider)} 暂时离线：${esc(msg)}</span>`;
    if (e && e.name === 'AbortError') return false;
    try {
      const id = await saveMessage({ conversation_id: convId, sender: isHost ? 'host' : 'assistant', provider, model, round_no: roundNo, content: '', status: 'error' });
      currentMessages.push({ id, conversation_id: convId, sender: isHost ? 'host' : 'assistant', provider, model, round_no: roundNo, content: '', status: 'error' });
    } catch (_) {}
    return false;
  }
}

function setDiscussingUI(on) {
  $('btn-send').style.display = on ? 'none' : 'inline-block';
  $('btn-stop').style.display = on ? 'inline-block' : 'none';
}

function stopDiscussionUI() {
  stopFlag = true;
  aborters.forEach(c => { try { c.abort(); } catch (_) {} });
  aborters = [];
}

async function sendQuestion() {
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) { input.placeholder = '请先输入你的问题'; return; }
  if (discussing) return;

  const participants = currentParticipants();
  if (!participants.length) { alert('请至少勾选一位参与成员（需在设置页配置密钥并启用）'); return; }
  const rounds = Number(settings.default_rounds) || 2;
  const hostPair = (settings.host_provider || 'deepseek') + '|' + (settings.host_model || '');
  const hostProv = hostPair.split('|')[0];
  const hostModel = hostPair.split('|')[1] || currentModelSel[hostProv] || providers.find(p => p.key === hostProv).models[0];
  const hostReady = providers.find(p => p.key === hostProv && p.configured && p.enabled);

  discussing = true; stopFlag = false; aborters = [];
  setDiscussingUI(true);

  try {
    appendUserBubble(text);
    $('chat-title').textContent = text.slice(0, 20);
    input.value = '';

    /* 建立/更新会话 + 保存用户消息 */
    if (currentConvId === null) {
      const { data, error } = await sb.from('conversations').insert({
        title: text.slice(0, 20), mode, participants, rounds, status: 'active'
      }).select('id').single();
      if (error) dbErr('创建会话', error);
      currentConvId = data.id;
      await loadConversations();
    } else {
      await sb.from('conversations').update({
        mode, participants, rounds, status: 'active', updated_at: new Date().toISOString()
      }).eq('id', currentConvId);
    }
    const um = await saveMessage({ conversation_id: currentConvId, sender: 'user', content: text });
    currentMessages.push({ id: um, conversation_id: currentConvId, sender: 'user', content: text, status: 'done' });

    /* 第 0 轮：并行独立作答 */
    addPhaseTip('—— 第 1 轮：各成员独立作答 ——');
    await Promise.all(participants.map(p => memberTurn({
      convId: currentConvId, provider: p.provider, model: p.model, roundNo: 0,
      system: `你是"AI圆桌"讨论的成员 ${PROVIDER_META[p.provider].name}（当前模型：${p.model}）。用户提出了一个问题，请给出你的独立分析和建议。用中文回答，观点鲜明、有条理，控制在 300 字以内。`,
      userPrompt: `用户的问题：${text}`
    })));

    /* 圆桌模式：互相讨论 N 轮 */
    if (mode === 'roundtable' && !stopFlag) {
      for (let r = 1; r <= rounds && !stopFlag; r++) {
        addPhaseTip(`—— 圆桌讨论 第 ${r} 轮 ——`);
        for (const p of participants) {
          if (stopFlag) break;
          await memberTurn({
            convId: currentConvId, provider: p.provider, model: p.model, roundNo: r,
            system: `你是"AI圆桌"讨论的成员 ${PROVIDER_META[p.provider].name}（当前模型：${p.model}）。这是一场多 AI 圆桌讨论，请阅读以下完整对话记录，然后发表你本轮的观点：简短点评、补充或反驳其他成员的观点（用中文，150 字以内）。`,
            userPrompt: `完整的讨论记录：\n\n${transcriptFor(p.provider)}\n\n请发表第 ${r} 轮观点。`
          });
        }
      }
      /* 主持人汇总 */
      if (!stopFlag && hostReady) {
        addPhaseTip('—— 主持人正在汇总综合方案 ——');
        await memberTurn({
          convId: currentConvId, provider: hostProv, model: hostModel, roundNo: 99, isHost: true,
          system: `你是"AI圆桌"讨论的主持人。请通读全部讨论记录，输出一份《综合方案》，包含三部分：一、共识（各成员一致认同的要点）；二、分歧（各成员意见不一致之处）；三、最终建议（给出可执行的综合结论）。用中文，条理清晰。`,
          userPrompt: `用户的问题与讨论记录：\n\n${transcriptFor(hostProv)}\n\n请输出综合方案。`
        });
      }
    }

    /* 会话收尾 */
    await sb.from('conversations').update({ status: stopFlag ? 'stopped' : 'completed', updated_at: new Date().toISOString() }).eq('id', currentConvId);
    if (stopFlag) addPhaseTip('—— 讨论已手动停止 ——');
  } catch (e) {
    addPhaseTip('发起讨论失败：' + (e.message || e));
  } finally {
    discussing = false;
    setDiscussingUI(false);
    loadConversations();
  }
}

function appendUserBubble(text) {
  const box = $('messages');
  const div = document.createElement('div');
  div.className = 'msg mine';
  div.innerHTML = `<div class="avatar av-me">我</div>
    <div class="bubble-wrap"><div class="sender">我</div><div class="bubble">${esc(text)}</div></div>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

/* ================= 导出 / 删除 / 改密 ================= */
function exportCurrent() {
  if (!currentConvId || !currentMessages.length) { alert('请先打开一场讨论'); return; }
  const lines = [`【AI 圆桌讨论记录】${$('chat-title').textContent}`, `导出时间：${new Date().toLocaleString()}`, ''];
  currentMessages.forEach(m => {
    const s = m.sender === 'user' ? '我' : (m.sender === 'host' ? '主持人·综合方案' : ((PROVIDER_META[m.provider] || {}).name || m.provider));
    lines.push(`--- ${s} ---`);
    lines.push(m.content || (m.status === 'error' ? '（本次调用失败）' : ''));
    lines.push('');
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `AI圆桌-${$('chat-title').textContent}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function deleteCurrent() {
  if (!currentConvId) { alert('请先选择一场讨论'); return; }
  if (!confirm('确定删除这场讨论吗？全部消息将一并删除，不可恢复。')) return;
  const { error } = await sb.from('conversations').delete().eq('id', currentConvId);
  if (error) { alert('删除失败：' + error.message); return; }
  currentConvId = null; currentMessages = [];
  await loadConversations();
  newDraft();
}

async function changePasswordUI() {
  const oldP = $('old-pass').value, newP = $('new-pass').value;
  if (!oldP || newP.length < 6) { alert('请填写原密码，新密码至少 6 位'); return; }
  try {
    const { error } = await sb.auth.signInWithPassword({ email: user.email, password: oldP });
    if (error) { alert('原密码不正确'); return; }
    const { error: e2 } = await sb.auth.updateUser({ password: newP });
    if (e2) throw e2;
    $('old-pass').value = ''; $('new-pass').value = '';
    alert('密码修改成功');
  } catch (e) {
    alert('修改失败：' + (e.message || e));
  }
}

/* ================= 事件绑定与启动 ================= */
$('btn-login').onclick = doLogin;
$('btn-signup').onclick = doLogin;
$('link-toggle').onclick = () => toggleSignup(!signupMode);
$('login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
$('btn-new').onclick = newDraft;
$('btn-settings').onclick = openSettings;
$('btn-back').onclick = () => showView('chat');
$('btn-logout').onclick = () => logout(true);
$('mode-round').onclick = () => setMode('roundtable');
$('mode-fast').onclick = () => setMode('fast');
$('btn-send').onclick = sendQuestion;
$('btn-stop').onclick = stopDiscussionUI;
$('btn-export').onclick = exportCurrent;
$('btn-del').onclick = deleteCurrent;
$('btn-save-settings').onclick = saveSettings;
$('btn-changepass').onclick = changePasswordUI;
$('chat-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendQuestion(); }
});

/* 登录状态监听（30 天免登录由 Supabase 自动续期） */
sb.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT') { user = null; showView('login'); }
});

(async function boot() {
  const { data } = await sb.auth.getSession();
  const u = data && data.session && data.session.user;
  if (!u) { showView('login'); return; }
  try {
    await enterApp(u);
  } catch (e) {
    showView('login');
    setLoginError('初始化失败：' + (e.message || e));
  }
})();

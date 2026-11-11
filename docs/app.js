/**
 * app.js —— AI 群聊前端逻辑（云端直连版）
 * 架构：GitHub Pages 静态界面 + Supabase 云数据库 + 浏览器直连各家 AI API
 * 交互：一条消息（可带图片/文件附件）同时发给多个 AI，各自独立作答、并排分块展示
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
let discussing = false;    // 是否正在等待 AI 回答
let stopFlag = false;      // 停止标记
let aborters = [];         // 进行中的 fetch 控制器
let currentModelSel = {};  // provider -> model（临时选择）
let signupMode = false;    // 登录页：注册模式
let pendingAttachments = []; // 待发送附件 [{kind:'image'|'file', name, dataUrl?|text?}]

/* 每个用户的接口地址覆盖：{ provider: 'https://xxx/v1' }（存于 settings.data.baseUrls）
   用中转站（如 4sapi）时，ChatGPT/Gemini 的请求发往中转站而不是官方地址 */
let baseUrls = {};
function confFor(key) {
  const meta = PROVIDER_META[key];
  return baseUrls[key] ? Object.assign({}, meta, { baseUrl: baseUrls[key] }) : meta;
}

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
  await loadSettings();          // 先读偏好（含接口地址覆盖、模型列表覆盖）
  await Promise.all([loadConfigs(), loadConversations()]);
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
    const relay = (settings && settings.relayModels && settings.relayModels[key]) || null;
    return {
      key, name: meta.name, oversea: !!meta.oversea,
      models: (relay && relay.length) ? relay : meta.models,
      modelLabel: (relay && relay.length) ? {} : meta.modelLabel,
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
  default_participants: [],
  baseUrls: {},      // provider -> 自定义接口地址（中转站）
  relayModels: {}    // provider -> 从服务拉取到的真实模型列表
};

async function loadSettings() {
  const { data, error } = await sb.from('settings').select('*').eq('user_id', user.id).maybeSingle();
  if (error) dbErr('读取偏好设置', error);
  settings = Object.assign({}, DEFAULT_SETTINGS, (data && data.data) || {});
  baseUrls = settings.baseUrls || {};
}

async function persistSettings() {
  const { error } = await sb.from('settings').upsert(
    { user_id: user.id, data: settings, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' });
  if (error) dbErr('保存偏好设置', error);
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
      <button class="btn-save" data-p="${p.key}">保存密钥</button>
      <button class="btn-test" data-p="${p.key}" ${p.configured ? '' : 'disabled'}>测试连通</button>
      <span class="api-test-result" id="test-${p.key}"></span>
      <div class="api-sub">
        <label class="muted small">接口地址</label>
        <input type="text" id="base-${p.key}" placeholder="${esc(confFor(p.key).baseUrl)}" value="${esc(baseUrls[p.key] || '')}">
        <button class="btn-base" data-p="${p.key}">保存地址</button>
        <button class="btn-models" data-p="${p.key}" ${p.configured ? '' : 'disabled'}>拉取模型列表</button>
        <span class="muted small">（用中转站密钥时，请把地址改为中转站给的地址，再拉取真实可用模型）</span>
      </div>`;
    list.appendChild(row);
    row.querySelector('.btn-save').onclick = () => saveProviderKey(p.key);
    row.querySelector('.btn-test').onclick = () => testProvider(p.key);
    row.querySelector('.btn-base').onclick = () => saveBaseUrl(p.key);
    row.querySelector('.btn-models').onclick = () => fetchModelList(p.key);

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

/* 各家密钥的标准开头，用于保存前做格式提醒（不强制） */
const KEY_PREFIX_HINT = {
  deepseek: { prefix: 'sk-', name: 'DeepSeek' },
  kimi: { prefix: 'sk-', name: 'Kimi（月之暗面）' },
  openai: { prefix: 'sk-', name: 'ChatGPT（中转站或 OpenAI 官方）' },
  gemini: { prefix: 'sk-', altPrefix: 'AIza', name: 'Gemini（中转站 sk- 开头；Google 官方 AIza 开头）' }
};

async function saveProviderKey(key) {
  const input = $('key-' + key);
  let val = input.value.trim().replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ''); // 去掉首尾引号和所有空白
  if (!val) { alert('请先粘贴密钥'); return; }
  const hint = KEY_PREFIX_HINT[key];
  if (hint && !val.startsWith(hint.prefix) && !(hint.altPrefix && val.startsWith(hint.altPrefix))) {
    const ok = confirm(`提醒：${hint.name} 的密钥通常以 "${hint.altPrefix || hint.prefix}" 开头，\n而你粘贴的密钥不是这个格式（可能是复制错了服务，或混入了多余文字）。\n\n仍要按原样保存吗？`);
    if (!ok) return;
  }
  await upsertProvider(key, { api_key: val, enabled: true });
  input.value = '';
  await loadConfigs();
  alert('密钥已保存到云端数据库（仅你本人可读取）');
}

/* 保存某家服务的自定义接口地址（中转站），留空则恢复默认官方地址 */
async function saveBaseUrl(key) {
  const input = $('base-' + key);
  let val = (input.value || '').trim().replace(/\/+$/, '');
  if (val && !/^https?:\/\//i.test(val)) {
    alert('接口地址需要以 https:// 开头，例如：https://4sapi.com/v1');
    return;
  }
  if (val) baseUrls[key] = val; else delete baseUrls[key];
  settings.baseUrls = baseUrls;
  await persistSettings();
  await loadConfigs();
  alert(val ? '接口地址已保存，请再点"拉取模型列表"获取该服务的真实模型' : '已恢复默认官方接口地址');
}

/* 从服务商（官方或中转站）拉取真实可用的模型列表，替换界面上的候选模型 */
async function fetchModelList(key) {
  const p = providers.find(x => x.key === key);
  if (!p || !p.apiKey) { alert('请先保存该服务的 API 密钥'); return; }
  const conf = confFor(key);
  const btn = document.querySelector(`.btn-models[data-p="${key}"]`);
  const out = $('test-' + key);
  btn.disabled = true;
  btn.textContent = '获取中…';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(conf.baseUrl + '/models', {
      headers: { Authorization: 'Bearer ' + p.apiKey },
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text().catch(() => '')).slice(0, 120));
    const json = await res.json();
    const ids = (json.data || []).map(m => m.id).filter(Boolean).sort();
    if (!ids.length) throw new Error('服务返回了空模型列表');
    settings.relayModels = settings.relayModels || {};
    settings.relayModels[key] = ids;
    await persistSettings();
    await loadConfigs();
    out.className = 'api-test-result tr-ok';
    out.textContent = `✅ 获取到 ${ids.length} 个模型，已在聊天页模型下拉框中显示`;
  } catch (e) {
    out.className = 'api-test-result tr-fail';
    out.textContent = '❌ 拉取模型列表失败：' + (e.message || e);
  } finally {
    btn.disabled = false;
    btn.textContent = '拉取模型列表';
  }
}

/* 一键测试某家 AI 的连通性：用已保存的密钥发一个极小请求（约几个 token，费用可忽略）
   会依次尝试该服务的候选模型，第一个测试成功的即为可用模型（并自动设为默认） */
async function testProvider(key) {
  const p = providers.find(x => x.key === key);
  if (!p || !p.apiKey) { alert('请先保存该服务的 API 密钥'); return; }
  const conf = confFor(key);
  const btn = document.querySelector(`.btn-test[data-p="${key}"]`);
  const out = $('test-' + key);
  btn.disabled = true;
  btn.textContent = '测试中…';
  out.className = 'api-test-result';
  out.textContent = '正在连接 ' + conf.name + '……';
  const started = Date.now();
  let lastErr = '';
  try {
    for (const model of p.models) {
      out.textContent = `正在测试 ${conf.name} · ${model} ……`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25000); // 25 秒超时
      let res, ok = false, body = '';
      try {
        res = await fetch(conf.baseUrl + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.apiKey },
          body: JSON.stringify({
            model, stream: false, max_tokens: 8,
            messages: [{ role: 'user', content: '回复"连通成功"四个字' }]
          }),
          signal: ctrl.signal
        });
        ok = res.ok;
        if (!ok) body = await res.text().catch(() => '');
      } catch (e) {
        clearTimeout(timer);
        lastErr = e.name === 'AbortError'
          ? `模型 ${model}：连接超时（25 秒无响应）——检查网络，海外服务需要相应的网络环境`
          : `网络无法连接——${conf.name} 的接口从你的网络环境不可达（海外服务常见，可先关闭该成员）`;
        break; // 网络层面不通，换模型也没用，直接结束
      }
      clearTimeout(timer);
      if (ok) {
        const sec = ((Date.now() - started) / 1000).toFixed(1);
        out.className = 'api-test-result tr-ok';
        out.textContent = `✅ 连通成功（${sec} 秒，模型 ${model}）`;
        currentModelSel[key] = model; // 顺手把可用模型设为默认
        return;
      }
      lastErr = `模型 ${model}：` + friendlyTestError(res.status, body, conf.name, key);
      // 401/402 是密钥/余额问题，换模型也不会好；只有 404（模型不存在或无权限）才值得换下一个模型
      if (res.status !== 404) break;
    }
    out.className = 'api-test-result tr-fail';
    out.textContent = '❌ ' + lastErr;
  } finally {
    btn.disabled = false;
    btn.textContent = '测试连通';
  }
}

/* 把接口报错翻译成普通人能看懂的话 */
function friendlyTestError(status, body, name, providerKey) {
  const detail = (body || '').slice(0, 200);
  if (status === 401 || status === 403) return `密钥无效或没有权限（HTTP ${status}）——请检查密钥是否复制完整、是否已过期`;
  if (status === 402) return `账户余额不足（HTTP 402）——请到 ${name} 官网充值后再试`;
  if (status === 404) {
    if (/not found the model|permission denied/i.test(body))
      return `该模型不存在或你的密钥没有它的使用权限（HTTP 404）——系统会自动尝试其他模型；若全部失败，请到服务商官网确认账号已开通模型权限`;
    return `接口或模型不存在（HTTP 404）——${detail}`;
  }
  if (status === 429) return `请求太频繁被限流（HTTP 429）——稍等片刻再试`;
  if (status >= 500) return `${name} 服务器暂时故障（HTTP ${status}）——稍后再试`;
  if (status === 400 && /valid api key/i.test(body)) {
    if (providerKey === 'gemini') return `密钥无效（HTTP 400）——Gemini 密钥通常以 AIza 开头，请确认粘贴的是 Google AI Studio 生成的完整密钥（不要混入其他服务的密钥）`;
    return `密钥无效（HTTP 400）——请确认粘贴的是 ${name} 官网生成的 API 密钥`;
  }
  return `接口返回错误（HTTP ${status}）——${detail}`;
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
      <span class="time">${fmtTime(c.updated_at)}</span>
      <button class="del-x" title="删除此会话">✕</button>`;
    d.onclick = () => openConversation(c.id);
    d.querySelector('.del-x').onclick = (e) => { e.stopPropagation(); deleteConversation(c.id); };
    el.appendChild(d);
  });
}

async function deleteConversation(id) {
  if (discussing && id === currentConvId) { alert('当前讨论进行中，请先点击"停止"'); return; }
  const conv = conversations.find(c => c.id === id);
  if (!confirm(`确定删除「${(conv && conv.title) || '该讨论'}」吗？\n全部消息将一并删除，不可恢复。`)) return;
  const { error } = await sb.from('conversations').delete().eq('id', id);
  if (error) { alert('删除失败：' + error.message); return; }
  if (id === currentConvId) { currentConvId = null; currentMessages = []; newDraft(); }
  await loadConversations();
}

async function openConversation(id) {
  if (discussing) { alert('当前讨论进行中，请先点击"停止"'); return; }
  currentConvId = id;
  renderSessions();
  const conv = conversations.find(c => c.id === id);
  const { data, error } = await sb.from('messages').select('*').eq('conversation_id', id).order('id');
  if (error) dbErr('读取消息', error);
  currentMessages = data;
  const convMode = (conv && conv.mode) || 'solo';
  renderChips();
  $('chat-title').textContent = conv ? conv.title : '对话';
  $('chat-sub').textContent = `${((conv && conv.participants) || []).length} 个 AI 同时回答`;
  const box = $('messages');
  box.innerHTML = '';
  if (convMode === 'roundtable') {
    /* 旧版圆桌会话：保留群聊气泡样式 */
    currentMessages.forEach(appendMessageFromDb);
  } else {
    /* 群聊/快速会话：用户消息 + 各 AI 并排分块 */
    let grid = null;
    currentMessages.forEach(m => {
      if (m.sender === 'user') { grid = null; appendMessageFromDb(m); }
      else if (m.sender === 'assistant') {
        if (!grid) grid = makeFastGrid();
        const st = makeFastCol(grid, m.provider, m.model);
        if (m.status === 'error') st.bubble.innerHTML = '<span class="err">（本次调用失败）</span>';
        else st.bubble.textContent = m.content || '';
      } else {
        appendMessageFromDb(m);
      }
    });
  }
  box.scrollTop = box.scrollHeight;
}

function newDraft() {
  if (discussing) { alert('当前讨论进行中，请先点击"停止"'); return; }
  currentConvId = null; currentMessages = [];
  $('messages').innerHTML = '';
  $('chat-title').textContent = '新对话';
  $('chat-sub').textContent = '';
  $('chat-input').value = '';
  renderSessions();
  renderChips();
  $('chat-input').focus();
}

/* ================= 附件存取与解析 ================= */
/* 附件以标记形式随消息内容存入数据库：[[附件:图片|名称|dataURL]] / [[附件:文件|名称|文本]] */
function serializeAtts(text, atts) {
  const marks = (atts || []).map(a =>
    `[[附件:${a.kind === 'image' ? '图片' : '文件'}|${a.name}|${a.kind === 'image' ? a.dataUrl : a.text}]]`);
  return [text || '', ...marks].filter(Boolean).join('\n');
}

function parseAtts(content) {
  const atts = [];
  const text = String(content || '').replace(/\[\[附件:(图片|文件)\|([^\]|]*)\|([\s\S]*?)\]\]/g,
    (_, kind, name, payload) => {
      atts.push(kind === '图片'
        ? { kind: 'image', name, dataUrl: payload }
        : { kind: 'file', name, text: payload });
      return '';
    }).trim();
  return { text, atts };
}

/* 给 AI 看的历史消息：附件只留名字提示，不带大数据 */
function attSummary(content) {
  const { text, atts } = parseAtts(content);
  const notes = atts.map(a => a.kind === 'image' ? `[图片：${a.name}]` : `[附件文件：${a.name}]`).join(' ');
  return [text, notes].filter(Boolean).join(' ');
}

/* 用户消息气泡内容（含附件渲染） */
function userBubbleHtml(content) {
  const { text, atts } = parseAtts(content);
  let html = text ? esc(text) : '';
  atts.forEach(a => {
    if (a.kind === 'image') {
      html += `<a href="${esc(a.dataUrl)}" target="_blank"><img class="att-thumb" src="${esc(a.dataUrl)}" alt="${esc(a.name)}"></a>`;
    } else {
      html += `<span class="att-file">📄 ${esc(a.name)}</span>`;
    }
  });
  return html || '（空消息）';
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
    <div class="bubble ${summary ? 'summary' : ''}">${summary ? '<div class="sum-title">综合方案</div>' : ''}${m.sender === 'user' ? userBubbleHtml(m.content) : esc(m.content)}
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
  const defaults = (settings && settings.default_participants) || [];
  providers.forEach(p => {
    const chip = document.createElement('span');
    const usable = p.configured && p.enabled;
    const isDefault = defaults.some(x => x.provider === p.key);
    chip.className = 'member-chip' + (usable && (!settings || !defaults.length || isDefault) ? ' on' : '') + (usable ? '' : ' disabled');
    if (usable) chip.dataset.provider = p.key;
    chip.innerHTML = `<span class="dot"></span>${p.name} <select>${p.models.map(m =>
      `<option value="${m}" ${currentModelSel[p.key] === m ? 'selected' : ''}>${p.modelLabel[m] || m}</option>`).join('')}</select>`;
    const sel = chip.querySelector('select');
    sel.onchange = e => { e.stopPropagation(); currentModelSel[p.key] = e.target.value; };
    sel.onclick = e => e.stopPropagation();
    chip.onclick = () => { if (usable) chip.classList.toggle('on'); };
    chips.appendChild(chip);
  });
}

function currentParticipants() {
  return [...document.querySelectorAll('#member-chips .member-chip.on[data-provider]')]
    .map(c => ({ provider: c.dataset.provider, model: currentModelSel[c.dataset.provider] }));
}

/* ================= 附件选择与处理 ================= */
const ATT_IMAGE_MAX = 4 * 1024 * 1024;   // 单张图片上限 4MB
const ATT_TEXT_MAX = 60000;              // 单个文件提取文本上限（字符）
const ATT_COUNT_MAX = 6;                 // 单条消息附件数量上限

function isImageFile(f) { return /^image\/(png|jpe?g|gif|webp|bmp)$/i.test(f.type); }
function isTextLikeFile(f) {
  if (f.type && f.type.startsWith('text/')) return true;
  return /\.(txt|md|markdown|csv|tsv|json|xml|yaml|yml|log|js|ts|jsx|tsx|py|java|c|cpp|h|cs|go|rs|rb|php|html|htm|css|sql|sh|bat|ini|conf|toml|env)$/i.test(f.name);
}

function readAsDataURL(f) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result); r.onerror = () => rej(new Error('读取失败'));
    r.readAsDataURL(f);
  });
}
function readAsText(f) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result); r.onerror = () => rej(new Error('读取失败'));
    r.readAsText(f);
  });
}

/* 懒加载 pdf.js（仅attach PDF时才下载） */
let pdfjsReady = null;
function loadPdfJs() {
  if (pdfjsReady) return pdfjsReady;
  pdfjsReady = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      resolve(window.pdfjsLib);
    };
    s.onerror = () => reject(new Error('PDF 解析组件加载失败（网络问题）'));
    document.head.appendChild(s);
  });
  return pdfjsReady;
}

/* 懒加载 mammoth.js（解析 Word .docx） */
let mammothReady = null;
function loadMammoth() {
  if (mammothReady) return mammothReady;
  mammothReady = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js';
    s.onload = () => resolve(window.mammoth);
    s.onerror = () => reject(new Error('Word 解析组件加载失败（网络问题）'));
    document.head.appendChild(s);
  });
  return mammothReady;
}

async function extractPdfText(f) {
  const lib = await loadPdfJs();
  const buf = await f.arrayBuffer();
  const pdf = await lib.getDocument({ data: buf }).promise;
  let out = '';
  const pages = Math.min(pdf.numPages, 50);
  for (let i = 1; i <= pages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    out += tc.items.map(it => it.str).join(' ') + '\n';
    if (out.length > ATT_TEXT_MAX) break;
  }
  return out.slice(0, ATT_TEXT_MAX);
}

async function processFile(f) {
  if (pendingAttachments.length >= ATT_COUNT_MAX) { alert(`一条消息最多 ${ATT_COUNT_MAX} 个附件`); return; }
  try {
    if (isImageFile(f)) {
      if (f.size > ATT_IMAGE_MAX) { alert(`图片 ${f.name} 超过 4MB，请压缩后再试`); return; }
      const dataUrl = await readAsDataURL(f);
      pendingAttachments.push({ kind: 'image', name: f.name, dataUrl });
    } else if (/\.pdf$/i.test(f.name)) {
      const text = (await extractPdfText(f)).trim();
      if (!text) { alert(`PDF ${f.name} 中没有可提取的文字（可能是扫描件，暂不支持）`); return; }
      pendingAttachments.push({ kind: 'file', name: f.name, text });
    } else if (/\.docx$/i.test(f.name)) {
      const mammoth = await loadMammoth();
      const { value } = await mammoth.extractRawText({ arrayBuffer: await f.arrayBuffer() });
      pendingAttachments.push({ kind: 'file', name: f.name, text: String(value || '').slice(0, ATT_TEXT_MAX) });
    } else if (isTextLikeFile(f)) {
      pendingAttachments.push({ kind: 'file', name: f.name, text: (await readAsText(f)).slice(0, ATT_TEXT_MAX) });
    } else {
      alert(`暂不支持文件类型：${f.name}\n支持：图片、PDF、Word(.docx)、文本和代码文件`);
      return;
    }
    renderAttPreview();
  } catch (e) {
    alert('附件处理失败：' + (e.message || e));
  }
}

function renderAttPreview() {
  const box = $('att-preview');
  box.innerHTML = '';
  pendingAttachments.forEach((a, i) => {
    const chip = document.createElement('span');
    chip.className = 'att-chip';
    chip.innerHTML = `${a.kind === 'image' ? `<img src="${esc(a.dataUrl)}">` : '📄'}
      <span class="nm">${esc(a.name)}</span><span class="rm" title="移除">✕</span>`;
    chip.querySelector('.rm').onclick = () => { pendingAttachments.splice(i, 1); renderAttPreview(); };
    box.appendChild(chip);
  });
}

function clearAttachments() { pendingAttachments = []; renderAttPreview(); }

/* ================= AI 直连调用（OpenAI 兼容流式接口 + 自动联网搜索） ================= */

/* 联网搜索工具声明：Kimi 用官方内置工具（服务端代为搜索），DeepSeek 走标准 function 工具 */
function webSearchTools(provider) {
  if (provider === 'kimi') {
    return [{ type: 'builtin_function', function: { name: '$web_search' } }];
  }
  return [{
    type: 'function',
    function: {
      name: 'web_search',
      description: '搜索互联网获取实时信息。当问题涉及最新资讯、实时数据（价格、天气、赛事、新闻等）或你不确定的近期事实时，调用本工具搜索后再回答。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜索关键词，简洁明确' } },
        required: ['query']
      }
    }
  }];
}

/* DeepSeek 官方自研搜索接口（POST /v1/tools/search，¥5/1000 次成功请求） */
async function deepseekWebSearch(query, apiKey, signal) {
  const res = await fetch('https://api.deepseek.com/v1/tools/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({ query: String(query).slice(0, 128), count: 8, need_content: false }),
    signal
  });
  if (!res.ok) throw new Error('搜索接口错误 HTTP ' + res.status);
  const data = await res.json();
  return (data.results || []).map(r => ({
    title: r.title, url: r.url, summary: r.summary, date: r.date, site: r.site_name
  }));
}

/* 单轮流式请求：返回正文、用量，以及（若有）工具调用请求 */
async function streamChatOnce({ conf, prov, model, messages, tools, onDelta, signal }) {
  const body = { model, messages, stream: true };
  if (tools) body.tools = tools;
  const res = await fetch(conf.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + prov.apiKey },
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch (_) {}
    throw new Error(`${conf.name} 接口错误 HTTP ${res.status} ${detail}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', content = '', usage = null, finish = null;
  const toolCalls = [];
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
        const ch = json.choices && json.choices[0];
        if (ch && ch.delta) {
          const delta = ch.delta.content;
          if (delta) { content += delta; onDelta && onDelta(delta, content); }
          if (ch.delta.tool_calls) {
            for (const tc of ch.delta.tool_calls) {
              const i = tc.index != null ? tc.index : 0;
              toolCalls[i] = toolCalls[i] || { id: '', type: 'function', function: { name: '', arguments: '' } };
              if (tc.id) toolCalls[i].id = tc.id;
              if (tc.function) {
                if (tc.function.name) toolCalls[i].function.name += tc.function.name;
                if (tc.function.arguments) toolCalls[i].function.arguments += tc.function.arguments;
              }
            }
          }
        }
        if (ch && ch.finish_reason) finish = ch.finish_reason;
        if (json.usage) usage = { pt: json.usage.prompt_tokens || 0, ct: json.usage.completion_tokens || 0 };
      } catch (_) { /* 忽略不完整行 */ }
    }
  }
  return { content, usage, toolCalls: toolCalls.filter(Boolean), finish };
}

async function callAI({ provider, model, messages, onDelta }) {
  const conf = confFor(provider);
  const prov = providers.find(p => p.key === provider);
  if (!prov || !prov.apiKey) throw new Error(`${conf.name} 未配置 API 密钥`);
  const ctrl = new AbortController();
  aborters.push(ctrl);
  /* 消息中带图片时，自动切换到该家支持视觉的模型 */
  const hasImages = messages.some(m => Array.isArray(m.content) && m.content.some(c => c.type === 'image_url'));
  if (hasImages && conf.visionModels && !conf.visionModels.includes(model)) model = conf.visionModel;
  /* DeepSeek 视觉模型（实验版）暂不叠加搜索工具，避免不兼容 */
  const tools = conf.webSearch && !(hasImages && provider === 'deepseek') ? webSearchTools(provider) : null;
  let convo = messages.slice();
  let content = '', usage = null;

  /* 联网搜索循环：AI 决定要搜索时，自动执行搜索并把结果喂回给它，直到给出最终回答 */
  for (let hop = 0; hop < 4; hop++) {
    const r = await streamChatOnce({ conf, prov, model, messages: convo, tools, onDelta, signal: ctrl.signal });
    if (r.usage) {
      usage = usage ? { pt: usage.pt + r.usage.pt, ct: usage.ct + r.usage.ct } : r.usage;
    }
    const wantsSearch = r.finish === 'tool_calls' && r.toolCalls.length > 0;
    if (!tools || !wantsSearch) { content = r.content; break; }

    /* 执行每一笔搜索调用 */
    const toolMsgs = [];
    for (const tc of r.toolCalls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch (_) {}
      const query = String(args.query || args.search_query || args.keyword || '').slice(0, 128);
      let resultStr;
      if (provider === 'kimi') {
        // Kimi 内置工具：把调用参数原样回传，Kimi 服务端会代为执行真正的搜索
        resultStr = tc.function.arguments || '{}';
      } else {
        try {
          const results = await deepseekWebSearch(query, prov.apiKey, ctrl.signal);
          resultStr = JSON.stringify(results);
        } catch (e) {
          resultStr = JSON.stringify({ error: '搜索暂不可用：' + e.message });
        }
      }
      toolMsgs.push({ role: 'tool', tool_call_id: tc.id || ('call_' + toolMsgs.length), content: resultStr });
    }
    convo = convo.concat([
      { role: 'assistant', content: r.content || null, tool_calls: r.toolCalls },
      ...toolMsgs
    ]);
    // 下一轮：模型基于搜索结果生成最终回答（继续流式输出到同一个气泡）
    onDelta && onDelta('', '');
    content = '';
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

/* ================= 多 AI 并行回答编排 ================= */
const AVATAR_COLOR = { deepseek: '#378ADD', kimi: '#1D9E75', openai: '#0C447C', gemini: '#639922', host: '#534AB7', me: '#D85A30' };

function makeStreamBubble(provider, model) {
  const s = senderLabel({ sender: 'assistant', provider, model });
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

/* 快速模式：并排分块展示，每个 AI 一块 */
function makeFastGrid() {
  const box = $('messages');
  const grid = document.createElement('div');
  grid.className = 'fast-grid';
  box.appendChild(grid);
  box.scrollTop = box.scrollHeight;
  return grid;
}

function makeFastCol(grid, provider, model) {
  const meta = PROVIDER_META[provider] || { name: provider };
  const prov = providers.find(p => p.key === provider) || {};
  const modelTxt = model ? (prov.modelLabel?.[model] || model) : '';
  const col = document.createElement('div');
  col.className = 'fast-col';
  col.innerHTML = `<div class="fast-head">
      <span class="fdot" style="background:${AVATAR_COLOR[provider] || '#888'}"></span>
      <span class="fname">${esc(meta.name || provider)}</span>
      <span class="fm">${esc(modelTxt)}</span>
    </div>
    <div class="fast-body"><span class="typing"><i></i><i></i><i></i></span></div>`;
  grid.appendChild(col);
  return { bubble: col.querySelector('.fast-body'), col };
}

function transcriptFor(curProvider) {
  return currentMessages.map(m => {
    if (m.sender === 'user') return `【用户】${attSummary(m.content)}`;
    const name = m.sender === 'host' ? '主持人' : (PROVIDER_META[m.provider] || {}).name || m.provider;
    return `【${name}】${m.content}`;
  }).join('\n\n');
}

/* 为某个 AI 构造完整对话：系统提示 + 该 AI 视角的历史 + 当前消息（含图片/附件） */
function buildMessages(provider, model, curText, curAtts) {
  const meta = PROVIDER_META[provider] || { name: provider };
  const sys = `你是用户的 AI 助手 ${meta.name}（当前模型：${model}）。用户把同一条消息同时发给了多个 AI 助手，各 AI 彼此独立作答、互相看不到对方的回答。请独立、直接地回答用户，用中文，条理清晰；若消息带有图片或文件附件，请结合附件内容回答。`;
  const msgs = [{ role: 'system', content: sys }];
  /* 历史：该 AI 自己的回答 + 用户消息（附件只留名字提示）。最多取最近 30 条 */
  const hist = currentMessages.slice(0, -1).slice(-30);
  hist.forEach(m => {
    if (m.sender === 'user') msgs.push({ role: 'user', content: attSummary(m.content) });
    else if (m.sender === 'assistant' && m.provider === provider && m.status !== 'error' && m.content)
      msgs.push({ role: 'assistant', content: m.content });
  });
  /* 当前消息：完整内容（图片为 content 数组，文件全文附在文本里） */
  let txt = curText || '（见附件）';
  curAtts.filter(a => a.kind === 'file').forEach(f => { txt += `\n\n【附件文件：${f.name}】\n${f.text}`; });
  const images = curAtts.filter(a => a.kind === 'image');
  let content;
  if (images.length) {
    const parts = [{ type: 'text', text: txt }];
    images.forEach(im => parts.push({ type: 'image_url', image_url: { url: im.dataUrl } }));
    content = parts;
  } else {
    content = txt;
  }
  msgs.push({ role: 'user', content });
  return msgs;
}

async function memberTurn({ convId, provider, model, messages, col }) {
  const st = col || makeStreamBubble(provider, model);
  try {
    const { content, usage } = await callAI({
      provider, model,
      messages,   // 上层已用 buildMessages 构造好：系统提示 + 该 AI 视角历史 + 当前消息（含附件）
      onDelta: (delta, all) => {
        st.text = all;
        st.bubble.textContent = all;
        const box = $('messages');
        if (box.scrollHeight - box.scrollTop - box.clientHeight < 120) box.scrollTop = box.scrollHeight;
      }
    });
    st.bubble.textContent = content;
    const id = await saveMessage({
      conversation_id: convId, sender: 'assistant',
      provider, model, round_no: 0, content, tokens: usage.ct
    });
    currentMessages.push({ id, conversation_id: convId, sender: 'assistant', provider, model, round_no: 0, content, status: 'done' });
    logUsage(provider, model, usage);
    return true;
  } catch (e) {
    const msg = (e && e.name === 'AbortError') ? '已停止' : e.message;
    st.bubble.innerHTML = `<span class="err">${esc((PROVIDER_META[provider] || {}).name || provider)} 暂时离线：${esc(msg)}</span>`;
    if (e && e.name === 'AbortError') return false;
    try {
      const id = await saveMessage({ conversation_id: convId, sender: 'assistant', provider, model, round_no: 0, content: '', status: 'error' });
      currentMessages.push({ id, conversation_id: convId, sender: 'assistant', provider, model, round_no: 0, content: '', status: 'error' });
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
  const atts = pendingAttachments.slice();
  if (!text && !atts.length) { input.placeholder = '请输入消息，或点 📎 添加附件'; return; }
  if (discussing) return;

  const participants = currentParticipants();
  if (!participants.length) { alert('请至少勾选一位 AI（需在设置页配置密钥并启用）'); return; }

  discussing = true; stopFlag = false; aborters = [];
  setDiscussingUI(true);

  try {
    const fullContent = serializeAtts(text, atts);
    appendUserBubble(fullContent);
    const title = (text || atts.map(a => a.name).join('、')).slice(0, 20);
    $('chat-title').textContent = title;
    input.value = '';
    clearAttachments();

    /* 建立/更新会话 + 保存用户消息 */
    if (currentConvId === null) {
      const { data, error } = await sb.from('conversations').insert({
        title, mode: 'solo', participants, rounds: 0, status: 'active'
      }).select('id').single();
      if (error) dbErr('创建会话', error);
      currentConvId = data.id;
      await loadConversations();
    } else {
      await sb.from('conversations').update({
        participants, status: 'active', updated_at: new Date().toISOString()
      }).eq('id', currentConvId);
    }
    const um = await saveMessage({ conversation_id: currentConvId, sender: 'user', content: fullContent });
    currentMessages.push({ id: um, conversation_id: currentConvId, sender: 'user', content: fullContent, status: 'done' });

    /* 同时发给所有勾选的 AI，各自独立回答、并排分块展示 */
    addPhaseTip('—— 已同时发给以下 AI，各自独立回答 ——');
    const grid = makeFastGrid();
    await Promise.all(participants.map(p => memberTurn({
      convId: currentConvId, provider: p.provider, model: p.model,
      messages: buildMessages(p.provider, p.model, text, atts),
      col: makeFastCol(grid, p.provider, p.model)
    })));

    /* 会话收尾 */
    await sb.from('conversations').update({ status: stopFlag ? 'stopped' : 'completed', updated_at: new Date().toISOString() }).eq('id', currentConvId);
    if (stopFlag) addPhaseTip('—— 已手动停止 ——');
  } catch (e) {
    addPhaseTip('发送失败：' + (e.message || e));
  } finally {
    discussing = false;
    setDiscussingUI(false);
    loadConversations();
  }
}

function appendUserBubble(content) {
  const box = $('messages');
  const div = document.createElement('div');
  div.className = 'msg mine';
  div.innerHTML = `<div class="avatar av-me">我</div>
    <div class="bubble-wrap"><div class="sender">我</div><div class="bubble">${userBubbleHtml(content)}</div></div>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

/* ================= 导出 / 删除 / 改密 ================= */
function exportCurrent() {
  if (!currentConvId || !currentMessages.length) { alert('请先打开一场对话'); return; }
  const lines = [`【AI 群聊对话记录】${$('chat-title').textContent}`, `导出时间：${new Date().toLocaleString()}`, ''];
  currentMessages.forEach(m => {
    const s = m.sender === 'user' ? '我' : ((PROVIDER_META[m.provider] || {}).name || m.provider);
    lines.push(`--- ${s} ---`);
    if (m.sender === 'user') {
      const { text, atts } = parseAtts(m.content);
      let out = text;
      atts.forEach(a => { out += `\n[附件：${a.name}]`; });
      lines.push(out || (m.status === 'error' ? '（本次调用失败）' : ''));
    } else {
      lines.push(m.content || (m.status === 'error' ? '（本次调用失败）' : ''));
    }
    lines.push('');
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `AI群聊-${$('chat-title').textContent}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function deleteCurrent() {
  if (!currentConvId) { alert('请先选择一场讨论'); return; }
  await deleteConversation(currentConvId);
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
$('btn-send').onclick = sendQuestion;
$('btn-stop').onclick = stopDiscussionUI;
$('btn-export').onclick = exportCurrent;
$('btn-del').onclick = deleteCurrent;
$('btn-changepass').onclick = changePasswordUI;
$('btn-attach').onclick = () => $('file-input').click();
$('file-input').onchange = e => {
  [...e.target.files].forEach(processFile);
  e.target.value = ''; /* 允许重复选择同一文件 */
};
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

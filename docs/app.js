/**
 * app.js —— AI 圆桌前端逻辑
 * 依赖：config.js 提供 window.API_BASE
 */
const API = (window.API_BASE || '').replace(/\/$/, '');

/* ---------- 通用 ---------- */
const $ = id => document.getElementById(id);
function token() { return localStorage.getItem('aiz_token') || ''; }
function saveToken(t) { t ? localStorage.setItem('aiz_token', t) : localStorage.removeItem('aiz_token'); }

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token() ? { Authorization: 'Bearer ' + token() } : {}),
      ...(opts.headers || {})
    }
  });
  if (res.status === 401) { logout(false); throw new Error('登录已过期'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('请求失败 ' + res.status));
  return data;
}

function showView(v) {
  document.querySelectorAll('.view').forEach(e => e.classList.remove('active'));
  $('view-' + v).classList.add('active');
}

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ---------- 状态 ---------- */
const PROVIDER_META = {
  deepseek: { name: 'DeepSeek', av: 'av-deepseek' },
  kimi: { name: 'Kimi', av: 'av-kimi' },
  openai: { name: 'ChatGPT', av: 'av-openai' },
  gemini: { name: 'Gemini', av: 'av-gemini' }
};
let providers = [];        // 服务商状态（来自后端）
let settings = null;       // 偏好设置
let conversations = [];    // 会话列表
let currentConvId = null;  // 当前会话
let mode = 'roundtable';   // 当前界面选择
let discussing = false;    // 是否正在讨论（禁止重复发送）
let currentModelSel = {};  // provider -> model（聊天页临时选择）

/* ================= 登录 ================= */
async function doLogin() {
  const username = $('login-user').value.trim();
  const password = $('login-pass').value.trim();
  $('login-error').style.display = 'none';
  $('login-neterr').style.display = 'none';
  if (!username || !password) { $('login-error').style.display = 'block'; return; }
  $('btn-login').disabled = true;
  try {
    const data = await fetch(API + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    }).then(r => r.json());
    if (data.token) {
      saveToken(data.token);
      await enterApp();
    } else {
      $('login-error').style.display = 'block';
    }
  } catch (e) {
    $('login-neterr').style.display = 'block';
  } finally {
    $('btn-login').disabled = false;
  }
}

function logout(calledByUser) {
  saveToken('');
  showView('login');
  if (calledByUser) { /* 已在聊天页点退出 */ }
}

async function enterApp() {
  await Promise.all([loadProviders(), loadSettings(), loadConversations()]);
  const hasKey = providers.some(p => p.configured && p.enabled);
  showView('chat');
  if (!hasKey) {
    if (confirm('检测到你还没有配置任何 AI 密钥。\n\n是否现在前往"设置"页填写 API 密钥？\n（国内：DeepSeek、Kimi 官网注册充值即可获取）')) openSettings();
  }
  newDraft();
}

/* ================= 服务商 ================= */
async function loadProviders() {
  providers = await api('/api/providers');
  currentModelSel = {};
  providers.forEach(p => { if (p.enabled && p.models.length) currentModelSel[p.key] = p.models[0]; });
  renderChips();
  renderProviderSettings();
}

/* ================= 设置 ================= */
async function loadSettings() {
  settings = await api('/api/settings');
  mode = settings.default_mode || 'roundtable';
  renderChips();
  // 填充设置页
  $('set-mode').value = settings.default_mode || 'roundtable';
  $('set-rounds').value = String(settings.default_rounds || 2);
  const hostSel = $('set-host');
  hostSel.innerHTML = '';
  providers.forEach(p => p.models.forEach(m => {
    const o = document.createElement('option');
    o.value = p.key + '|' + m;
    o.textContent = `${p.name}（${(p.modelLabel && p.modelLabel[m]) || m}）`;
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
      <span class="api-name">${p.name}</span>
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
      await api('/api/providers/' + p.key, { method: 'PUT', body: JSON.stringify({ enabled: next }) });
      el.classList.toggle('on', next);
      await loadProviders();
    };
  });
}

async function saveProviderKey(key) {
  const input = $('key-' + key);
  const val = input.value.trim();
  if (!val) { alert('请先粘贴密钥'); return; }
  await api('/api/providers/' + key, { method: 'PUT', body: JSON.stringify({ apiKey: val }) });
  input.value = '';
  await loadProviders();
  alert('密钥已加密保存到云端服务器');
}

async function saveSettings() {
  const host = $('set-host').value.split('|');
  const members = [...$('set-members').querySelectorAll('.member-chip.on')]
    .map(c => ({ provider: c.dataset.provider, model: (providers.find(p => p.key === c.dataset.provider).models[0]) }));
  await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({
      default_mode: $('set-mode').value,
      default_rounds: Number($('set-rounds').value),
      host_provider: host[0],
      host_model: host[1],
      default_participants: members
    })
  });
  await loadSettings();
  alert('讨论设置已保存');
}

async function loadUsage() {
  $('usage-list').textContent = '加载中……';
  try {
    const data = await api('/api/usage');
    if (!data.rows.length) { $('usage-list').textContent = '本月暂无调用记录'; return; }
    $('usage-list').innerHTML = data.rows.map(r => {
      const name = (PROVIDER_META[r.provider] || {}).name || r.provider;
      return `<div class="usage-row"><span>${name} · ${r.model}</span>
        <span class="muted">${r.calls} 次 · 输入 ${(r.pt || 0).toLocaleString()} / 输出 ${(r.ct || 0).toLocaleString()} tokens · 约 ¥${(r.cost || 0).toFixed(2)}</span></div>`;
    }).join('');
  } catch (e) {
    $('usage-list').textContent = '统计加载失败：' + e.message;
  }
}

/* ================= 会话列表 ================= */
async function loadConversations() {
  conversations = await api('/api/conversations');
  renderSessions();
}

function renderSessions() {
  const el = $('session-list');
  el.innerHTML = '';
  conversations.forEach(c => {
    const d = document.createElement('div');
    d.className = 'session-item' + (c.id === currentConvId ? ' current' : '');
    const stMap = { active: '', completed: '', stopped: '（已停止）' };
    d.innerHTML = `${esc(c.title)} <span class="st">${stMap[c.status] || ''}</span>
      <span class="time">${c.updated_at || ''}</span>`;
    d.onclick = () => openConversation(c.id);
    el.appendChild(d);
  });
}

async function openConversation(id) {
  if (discussing) { alert('当前讨论进行中，请先点击"停止"'); return; }
  currentConvId = id;
  renderSessions();
  const data = await api(`/api/conversations/${id}/messages`);
  const conv = data.conversation;
  mode = conv.mode || 'roundtable';
  renderChips();
  $('chat-title').textContent = conv.title;
  $('chat-sub').textContent = `${mode === 'roundtable' ? '圆桌模式' : '快速模式'} · ${JSON.parse(conv.participants || '[]').length} 个 AI 参与`;
  const box = $('messages');
  box.innerHTML = '';
  data.messages.forEach(m => appendMessageFromDb(m));
  box.scrollTop = box.scrollHeight;
}

function newDraft() {
  if (discussing) { alert('当前讨论进行中，请先点击"停止"'); return; }
  currentConvId = null;
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
  const meta = PROVIDER_META[m.provider] || { name: m.provider, av: 'av-openai' };
  const modelTxt = m.model ? ` · ${(providers.find(p => p.key === m.provider) || {}).modelLabel?.[m.model] || m.model}` : '';
  return { name: meta.name + modelTxt, av: meta.av };
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
      `<option value="${m}" ${currentModelSel[p.key] === m ? 'selected' : ''}>${(p.modelLabel && p.modelLabel[m]) || m}</option>`).join('')}</select>`;
    const sel = chip.querySelector('select');
    sel.onchange = e => { e.stopPropagation(); currentModelSel[p.key] = e.target.value; };
    sel.onclick = e => e.stopPropagation();
    chip.onclick = () => { if (usable) chip.classList.toggle('on'); };
    chips.appendChild(chip);
  });
  updateModeUI();
}

function setMode(m) {
  mode = m;
  updateModeUI();
}
function updateModeUI() {
  $('mode-round').classList.toggle('on', mode === 'roundtable');
  $('mode-fast').classList.toggle('on', mode === 'fast');
  $('chat-sub').textContent = $('chat-sub').textContent.replace(/圆桌模式|快速模式/, mode === 'roundtable' ? '圆桌模式' : '快速模式');
}

/* ================= 发起讨论（SSE 流式接收） ================= */
function currentParticipants() {
  return [...document.querySelectorAll('#member-chips .member-chip.on[data-provider]')]
    .map(c => ({ provider: c.dataset.provider, model: currentModelSel[c.dataset.provider] }));
}

async function sendQuestion() {
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) { input.placeholder = '请先输入你的问题'; return; }
  if (discussing) return;

  const participants = currentParticipants();
  if (!participants.length) { alert('请至少勾选一位参与成员（需在设置页配置密钥并启用）'); return; }

  discussing = true;
  setDiscussingUI(true);
  const isNew = currentConvId === null;

  try {
    // 新讨论：先在本地渲染用户消息和标题；已有会话：追加用户消息
    appendUserBubble(text);
    if (isNew) {
      $('chat-title').textContent = text.slice(0, 20);
    } else {
      $('chat-title').textContent = text.slice(0, 20);
    }
    input.value = '';

    // 后端：若新会话则先创建
    if (isNew) {
      const conv = await api('/api/conversations', { method: 'POST', body: JSON.stringify({ title: text.slice(0, 20) }) });
      currentConvId = conv.id;
    }

    await streamDiscussion(text, participants);
  } catch (e) {
    addPhaseTip('发起讨论失败：' + e.message);
  } finally {
    discussing = false;
    setDiscussingUI(false);
    loadConversations();
  }
}

async function streamDiscussion(text, participants) {
  const rounds = Number(settings.default_rounds) || 2;
  const host = (settings.host_provider || 'deepseek') ;
  const body = JSON.stringify({
    message: text, mode, participants, rounds
  });

  const res = await fetch(API + `/api/conversations/${currentConvId}/discuss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
    body
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    addPhaseTip(data.error || '请求失败 ' + res.status);
    return;
  }

  // 每个流式成员气泡：{ provider, round } -> { div, bubbleEl, text }
  const streams = new Map();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  const handleEvent = (chunk) => {
    const line = chunk.trim();
    if (!line.startsWith('data:')) return;
    let ev;
    try { ev = JSON.parse(line.slice(5)); } catch (_) { return; }

    if (ev.type === 'phase') {
      const tips = {
        first_answers: '—— 第 1 轮：各成员独立作答 ——',
        summary: '—— 主持人正在汇总综合方案 ——'
      };
      if (tips[ev.phase]) addPhaseTip(tips[ev.phase]);
      else if (ev.phase.startsWith('round_')) addPhaseTip(`—— 圆桌讨论 第 ${ev.phase.split('_')[1]} 轮 ——`);
    } else if (ev.type === 'stream_start') {
      const key = ev.provider + '|' + ev.round_no;
      const s = senderLabel({ sender: ev.sender === 'host' ? 'host' : 'assistant', provider: ev.provider, model: ev.model });
      const box = $('messages');
      const div = document.createElement('div');
      div.className = 'msg';
      div.innerHTML = `<div class="avatar ${s.av}"></div>
        <div class="bubble-wrap"><div class="sender">${esc(s.name)}</div>
        <div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div></div>`;
      box.appendChild(div);
      box.scrollTop = box.scrollHeight;
      streams.set(key, { div, bubble: div.querySelector('.bubble'), text: '' });
    } else if (ev.type === 'token') {
      const st = streams.get(ev.provider + '|' + ev.round_no);
      if (st) {
        st.text += ev.delta;
        st.bubble.textContent = st.text;
        const box = $('messages');
        if (box.scrollHeight - box.scrollTop - box.clientHeight < 120) box.scrollTop = box.scrollHeight;
      }
    } else if (ev.type === 'member_error') {
      const st = streams.get(ev.provider + '|' + ev.round_no);
      if (st) {
        st.bubble.innerHTML = `<span class="err">${esc((PROVIDER_META[ev.provider] || {}).name || ev.provider)} 暂时离线：${esc(ev.error)}</span>`;
      }
    } else if (ev.type === 'user_message') {
      /* 用户消息已在本地渲染 */
    } else if (ev.type === 'done') {
      if (ev.status === 'stopped') addPhaseTip('—— 讨论已手动停止 ——');
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      handleEvent(chunk);
    }
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

function setDiscussingUI(on) {
  $('btn-send').style.display = on ? 'none' : 'inline-block';
  $('btn-stop').style.display = on ? 'inline-block' : 'none';
  $('btn-send').disabled = on;
}

async function stopDiscussionUI() {
  if (!currentConvId) return;
  try { await api(`/api/conversations/${currentConvId}/stop`, { method: 'POST' }); } catch (_) {}
}

/* ================= 导出 / 删除 / 改密 ================= */
function exportCurrent() {
  if (!currentConvId) { alert('请先打开一场讨论'); return; }
  window.open(API + `/api/conversations/${currentConvId}/export?t=${token()}`, '_blank');
}
async function deleteCurrent() {
  if (!currentConvId) { alert('请先选择一场讨论'); return; }
  if (!confirm('确定删除这场讨论吗？全部消息将一并删除，不可恢复。')) return;
  await api(`/api/conversations/${currentConvId}`, { method: 'DELETE' });
  currentConvId = null;
  await loadConversations();
  newDraft();
}
async function changePasswordUI() {
  const oldP = $('old-pass').value, newP = $('new-pass').value;
  if (!oldP || newP.length < 6) { alert('请填写原密码，新密码至少 6 位'); return; }
  try {
    await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ oldPassword: oldP, newPassword: newP }) });
    $('old-pass').value = ''; $('new-pass').value = '';
    alert('密码修改成功');
  } catch (e) {
    alert('修改失败：' + e.message);
  }
}

/* ================= 事件绑定与启动 ================= */
$('btn-login').onclick = doLogin;
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

(async function boot() {
  if (!token()) { showView('login'); return; }
  try {
    await enterApp();
  } catch (e) {
    showView('login');
  }
})();

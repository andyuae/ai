<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Close } from '@element-plus/icons-vue'
import { store, orderOf } from '../store'
import { userBubbleHtml, parseAtts } from '../lib/atts'
import type { DbMessage } from '../lib/types'

const state = store.state
const currentModelSel = store.currentModelSel

const boxRef = ref<HTMLElement>()
const fileRef = ref<HTMLInputElement>()
let streamFollow = true

/* 分组渲染：用户消息独立气泡；连续的 assistant 消息合为一个并排分块网格 */
interface RenderItem { kind: 'user' | 'grid'; msg?: DbMessage; msgs?: DbMessage[] }
const renderList = computed<RenderItem[]>(() => {
  const list: RenderItem[] = []
  let grid: RenderItem | null = null
  state.currentMessages.forEach((m: DbMessage) => {
    if (m.sender === 'user') { grid = null; list.push({ kind: 'user', msg: m }) }
    else if (m.sender === 'assistant') {
      if (!grid) { grid = { kind: 'grid', msgs: [] }; list.push(grid) }
      grid.msgs!.push(m)
    }
  })
  /* 历史回答也按固定顺序排列：ChatGPT → Gemini → DeepSeek → Kimi */
  list.forEach(it => {
    if (it.kind === 'grid') it.msgs!.sort((a, b) => orderOf(a.provider) - orderOf(b.provider))
  })
  return list
})

const DOT: Record<string, string> = {
  openai: '#0C447C', gemini: '#639922', deepseek: '#378ADD', kimi: '#1D9E75', anthropic: '#C15F3C'
}
function dotColor(p?: string) { return DOT[p || ''] || '#888' }
function provName(key?: string) { return store.providerOf(key || '')?.name || key || '' }
function provLabel(provider: string | undefined, model?: string) {
  if (!model) return ''
  const p = store.providerOf(provider || '')
  return p?.modelLabel?.[model] || model
}

/* 自动跟随滚动 */
async function followScroll(force = false) {
  if (!streamFollow && !force) return
  await nextTick()
  const box = boxRef.value
  if (box) box.scrollTop = box.scrollHeight
}
watch(() => state.liveCols.map((c: any) => c.text).join('|'), () => followScroll())
function onScroll() {
  const box = boxRef.value
  if (box) streamFollow = box.scrollHeight - box.scrollTop - box.clientHeight < 250
}

/* 复制（带按钮反馈） */
async function doCopy(t: string, btn?: HTMLElement) {
  t = String(t || '')
  try { await navigator.clipboard.writeText(t) } catch {
    const ta = document.createElement('textarea')
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta); ta.select()
    try { document.execCommand('copy') } catch { /* ignore */ }
    ta.remove()
  }
  if (btn) {
    const orig = btn.dataset.orig || btn.textContent || '复制'
    btn.dataset.orig = orig
    btn.textContent = '已复制'; btn.classList.add('copied')
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied') }, 1200)
  }
}
function copyUser(m: DbMessage, e: MouseEvent) {
  doCopy(parseAtts(m.content).text || '', e.currentTarget as HTMLElement)
}
function copyAi(t: string, e: MouseEvent) {
  doCopy(t, e.currentTarget as HTMLElement)
}

/* 成员芯片：默认全部点亮；未配置/被关闭的置灰 */
function chipUsable(p: any) { return p.configured && p.enabled }
function chipClick(p: any) {
  if (!p.configured) ElMessage.warning('请先在设置页配置该服务的密钥')
  else if (!p.enabled) ElMessage.warning('该成员已在设置页关闭，请到设置页打开开关')
}

/* 菜单图标下拉命令 */
function onMenu(cmd: string) {
  if (cmd === 'export') store.exportCurrent()
  else if (cmd === 'delete') store.deleteCurrent()
  else if (cmd === 'settings') store.setView('settings')
  else if (cmd === 'logout') store.logout()
}

/* 附件 */
function onPickFiles(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files) store.addFiles([...input.files])
  input.value = ''
}
function onPaste(e: ClipboardEvent) {
  const files = [...(e.clipboardData?.files || [])]
  if (files.length) { e.preventDefault(); store.addFiles(files) }
}
function onInputEnter(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); store.send() }
}

/* ===== 放大查看（抽屉）：点空白处或 Esc 关闭 ===== */
const zoomCol = ref<any>(null)            // 进行中的回答（流式，实时更新）
const zoomMsg = ref<DbMessage | null>(null) // 历史回答
const zoomOpen = computed(() => !!(zoomCol.value || zoomMsg.value))
const zoomText = computed(() => zoomCol.value ? zoomCol.value.text : (zoomMsg.value?.content || ''))
const zoomProvider = computed(() => zoomCol.value?.provider || zoomMsg.value?.provider)
const zoomModel = computed(() => zoomCol.value?.model || zoomMsg.value?.model)
function openZoom(p: { col?: any; msg?: DbMessage }) {
  zoomCol.value = p.col || null
  zoomMsg.value = p.msg || null
}
function closeZoom() { zoomCol.value = null; zoomMsg.value = null }
function onKeyDown(e: KeyboardEvent) { if (e.key === 'Escape') closeZoom() }

onMounted(() => {
  followScroll(true)
  window.addEventListener('keydown', onKeyDown)
})
onUnmounted(() => window.removeEventListener('keydown', onKeyDown))
</script>

<template>
  <div class="chat-layout">
    <!-- 单行工具栏：菜单图标 + 书签式会话栏 -->
    <nav class="session-bar">
      <el-dropdown trigger="click" @command="onMenu">
        <span class="brand-mark menu-trigger" title="菜单">群<i class="caret"></i></span>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="export">导出当前对话</el-dropdown-item>
            <el-dropdown-item command="delete">删除当前对话</el-dropdown-item>
            <el-dropdown-item command="settings" divided>设置</el-dropdown-item>
            <el-dropdown-item command="logout">退出登录</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>

      <button class="new-conv" @click="store.newDraft()">＋ 新开对话</button>

      <div class="session-tabs">
        <div v-for="c in state.conversations" :key="c.id"
          class="s-tab" :class="{ current: c.id === state.currentConvId }"
          :title="c.title"
          @click="store.openConversation(c.id)">
          <span class="t-title">{{ c.title }}<i v-if="c.status === 'stopped'" class="st">（已停止）</i></span>
          <span class="t-time">{{ c.updated_at ? new Date(c.updated_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '' }}</span>
          <el-icon class="del-x" title="删除此会话" @click.stop="store.deleteConversation(c.id)"><Close /></el-icon>
        </div>
        <div v-if="!state.conversations.length" class="empty-tip">暂无历史会话，点「＋ 新开对话」开始</div>
      </div>

      <span v-if="state.discussing" class="live-pill"><i></i>回答中</span>
    </nav>

    <!-- 消息区 -->
    <div ref="boxRef" class="messages" @scroll="onScroll">
        <template v-for="(item, gi) in renderList" :key="item.msg?.id || 'g' + gi">
          <!-- 用户消息 -->
          <div v-if="item.kind === 'user'" class="msg mine">
            <div class="avatar av-me">我</div>
            <div class="bubble-wrap">
              <div class="sender">我</div>
              <div class="bubble" v-html="userBubbleHtml(item.msg!.content)"></div>
              <div class="msg-actions">
                <button class="act-btn" @click="copyUser(item.msg!, $event)">复制</button>
                <button class="act-btn" :disabled="state.discussing" @click="store.editResend(item.msg!.content)">编辑重发</button>
              </div>
            </div>
          </div>

          <!-- AI 并排分块（历史） -->
          <div v-else class="fast-grid">
            <div v-for="m in item.msgs" :key="m.id" class="fast-col">
              <div class="fast-head">
                <span class="fdot" :style="{ background: dotColor(m.provider) }"></span>
                <span class="fname">{{ provName(m.provider) }}</span>
                <span class="fm">{{ provLabel(m.provider, m.model) }}</span>
                <button class="zoom-btn" title="放大查看" @click="openZoom({ msg: m })">
                  <svg viewBox="0 0 24 24" width="13" height="13"><path d="M9 3H3v6M15 3h6v6M9 21H3v-6M21 15v6h-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
              </div>
              <div class="fast-body">
                <span v-if="m.status === 'error'" class="err">（本次调用失败）</span>
                <template v-else>{{ m.content }}</template>
              </div>
              <div class="fast-foot">
                <button class="fast-copy" @click="copyAi(m.content, $event)">复制</button>
              </div>
            </div>
          </div>
        </template>

        <!-- 进行中的 AI 回答 -->
        <div v-if="state.liveCols.length" class="fast-grid">
          <div v-for="(c, i) in state.liveCols" :key="i" class="fast-col">
            <div class="fast-head">
              <span class="fdot" :style="{ background: dotColor(c.provider) }"></span>
              <span class="fname">{{ provName(c.provider) }}</span>
              <span class="fm">{{ provLabel(c.provider, c.model) }}</span>
              <button class="zoom-btn" title="放大查看" @click="openZoom({ col: c })">
                <svg viewBox="0 0 24 24" width="13" height="13"><path d="M9 3H3v6M15 3h6v6M9 21H3v-6M21 15v6h-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
            </div>
            <div class="fast-body">
              <span v-if="c.state === 'error'" class="err">{{ provName(c.provider) }} 暂时离线：{{ c.error }}</span>
              <template v-else-if="c.text">{{ c.text }}</template>
              <span v-else class="typing"><i></i><i></i><i></i></span>
            </div>
            <div class="fast-foot">
              <button class="fast-copy" @click="copyAi(c.text, $event)">复制</button>
            </div>
          </div>
        </div>
      </div>

      <div class="composer">
        <div class="composer-bar">
          <span class="muted small">发给：</span>
          <span v-for="p in state.providers" :key="p.key" class="member-chip"
            :class="{ on: chipUsable(p), disabled: !chipUsable(p) }"
            @click="chipClick(p)">
            <span class="dot"></span>{{ p.name }}
            <el-select v-if="p.models.length" :model-value="currentModelSel[p.key]" size="small"
              style="width: 118px" @click.stop @change="(v: string) => currentModelSel[p.key] = v">
              <el-option v-for="m in p.models" :key="m" :value="m" :label="p.modelLabel[m] || m" />
            </el-select>
          </span>
        </div>
        <div v-if="state.attachments.length" class="att-preview">
          <span v-for="(a, i) in state.attachments" :key="i" class="att-chip">
            <img v-if="a.kind === 'image'" :src="a.dataUrl">
            <span v-else>📄</span>
            <span class="nm">{{ a.name }}</span>
            <span class="rm" title="移除" @click="store.removeAttachment(i)">✕</span>
          </span>
        </div>
        <div class="input-row">
          <button class="btn-attach" title="添加图片或文件" @click="fileRef?.click()">
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <circle cx="12" cy="12" r="11" fill="#18a05e" />
              <path d="M12 6.8v10.4M6.8 12h10.4" stroke="#fff" stroke-width="2.4" stroke-linecap="round" />
            </svg>
          </button>
          <input ref="fileRef" type="file" multiple style="display:none" @change="onPickFiles">
          <el-input v-model="state.inputText" type="textarea" :rows="2" resize="none"
            placeholder="输入消息，同时发给所有 AI……（Enter 发送，Shift+Enter 换行；可点 ＋ 附图片/文件）"
            @keydown="onInputEnter" @paste="onPaste" />
          <el-button v-if="!state.discussing" type="primary" class="btn-send" @click="store.send()">发 送</el-button>
          <el-button v-else type="danger" class="btn-send" @click="store.stopAnswer()">停 止</el-button>
        </div>
      </div>

    <!-- 放大查看：点空白处 / 关闭按钮 / Esc 退出 -->
    <teleport to="body">
      <div v-if="zoomOpen" class="zoom-mask" @click.self="closeZoom">
        <div class="zoom-card">
          <div class="zoom-head">
            <span class="fdot" :style="{ background: dotColor(zoomProvider) }"></span>
            <span class="fname">{{ provName(zoomProvider) }}</span>
            <span class="fm">{{ provLabel(zoomProvider, zoomModel) }}</span>
            <div class="zoom-actions">
              <button class="act-btn" @click="doCopy(zoomText, $event)">复制全文</button>
              <button class="act-btn" @click="closeZoom">关闭</button>
            </div>
          </div>
          <div class="zoom-body">{{ zoomText || '（暂无内容）' }}</div>
          <div class="zoom-tip">点击空白处或按 Esc 关闭</div>
        </div>
      </div>
    </teleport>
  </div>
</template>

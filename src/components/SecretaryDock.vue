<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { store } from '../store'
import { mdToHtml } from '../lib/md'
import SecretaryMascot from './SecretaryMascot.vue'
import type { Minute } from '../lib/types'

const s = store.state.secretary
const state = store.state

/* 每次总结一个选项卡：当前选中项 */
const activeIdx = computed(() => {
  const i = s.minutes.findIndex(m => m.id === s.activeId)
  return i < 0 ? s.minutes.length - 1 : i
})
const active = computed<Minute | null>(() => (activeIdx.value >= 0 ? s.minutes[activeIdx.value] : null))

const headMeta = computed(() => {
  if (s.busy) return `正在整理第 ${s.minutes.length + 1} 次 · 读的是本会话到目前为止的全部对话`
  if (active.value) return `${active.value.models?.length || 0} 家参与 · 本会话共 ${s.minutes.length} 次总结`
  return '把多 AI 讨论汇总成共识与分歧'
})

const modelLabel = computed(() => {
  const c = store.secretaryModel.value
  return c ? `模型：${c.name} · ${c.label}` : '还没有可用的模型'
})

/* 生成中的分阶段文案 + 计时（一次通常 10–40 秒） */
const elapsed = ref(0)
let timer: any = null
watch(() => s.busy, (b) => {
  clearInterval(timer)
  elapsed.value = 0
  if (!b) return
  const t0 = Date.now()
  timer = setInterval(() => { elapsed.value = Math.floor((Date.now() - t0) / 1000) }, 500)
}, { immediate: true })
const STAGES = ['读取五家回答…', '对齐相同观点…', '标出实质分歧…', '整理下一步问题…']
const stage = computed(() => STAGES[Math.min(STAGES.length - 1, Math.floor(elapsed.value / 7))])

function fmt(iso?: string) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function fmtFull(iso?: string) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

async function onSummarize() {
  if (s.busy) return
  if (!state.currentMessages.length) {
    ElMessage.warning('当前会话还没有内容，先向五家提个问题')
    return
  }
  hoverOpen.value = false
  await store.openSecretary('summarize')
}

function onView() {
  hoverOpen.value = false
  store.openSecretary('list')
}

function onSettings() {
  hoverOpen.value = false
  store.closeSecretaryMenu()
  store.closeSecretary()
  store.setView('settings')
}

/* ===== 悬停即展开：移上去 130ms 打开，移开 240ms 收起（给手指/鼠标留缓冲，不闪） ===== */
const hoverOpen = ref(false)
let hoverIn: any = null
let hoverOut: any = null
const menuVisible = computed(() => hoverOpen.value || s.menuOpen)

function prefetchMinutes() {
  if (state.currentConvId != null && s.convId !== state.currentConvId) store.loadMinutes()
}
function onEnter() {
  clearTimeout(hoverOut)
  clearTimeout(hoverIn)
  if (menuVisible.value) return
  hoverIn = setTimeout(() => { hoverOpen.value = true; prefetchMinutes() }, 130)
}
function onLeave() {
  clearTimeout(hoverIn)
  clearTimeout(hoverOut)
  hoverOut = setTimeout(() => { hoverOpen.value = false }, 240)
}
function closeMenu() {
  clearTimeout(hoverIn)
  clearTimeout(hoverOut)
  hoverOpen.value = false
  store.closeSecretaryMenu()
}
/* 点一下 = 钉住菜单（触屏没悬停，靠点击）；再点收起 */
function onFabClick() {
  clearTimeout(hoverIn)
  clearTimeout(hoverOut)
  if (s.menuOpen) { closeMenu(); return }
  if (!hoverOpen.value) hoverOpen.value = true
  store.toggleSecretaryMenu()
}

/* 把建议的问题直接放进输入框：关掉纪要，接着开会 */
function useQuestion(q: string) {
  state.inputText = q
  store.closeSecretary()
  ElMessage.success('已放进输入框，可以改一改再发出去')
}

async function copyActive() {
  if (!active.value) return
  const t = store.minuteToText(active.value)
  try { await navigator.clipboard.writeText(t) } catch {
    const ta = document.createElement('textarea')
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta); ta.select()
    try { document.execCommand('copy') } catch { /* ignore */ }
    ta.remove()
  }
  ElMessage.success('纪要已复制，可直接贴到笔记或群里')
}

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (s.open) store.closeSecretary()
  else if (menuVisible.value) closeMenu()
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  if (state.currentConvId != null) store.loadMinutes()
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
  clearInterval(timer)
  clearTimeout(hoverIn)
  clearTimeout(hoverOut)
})

/* 切换会话后重新取该会话的历次总结（角标数量才准确） */
watch(() => state.currentConvId, (id) => { if (id != null) store.loadMinutes() })
/* 打开大面板时收起悬停菜单，免得关掉面板后菜单凭空出现 */
watch(() => s.open, (v) => { if (v) hoverOpen.value = false })
</script>

<template>
  <teleport to="body">
    <div v-if="s.menuOpen" class="sec-menu-mask" @click="closeMenu()"></div>

    <div v-if="!s.open" class="sec-dock" @mouseenter="onEnter" @mouseleave="onLeave">
      <transition name="sec-pop">
        <div v-if="menuVisible" class="sec-menu">
          <div class="sec-menu-head">
            <SecretaryMascot :size="26" />
            <div>小秘书<i>会议纪要 · 只在你点击时调用</i></div>
          </div>

          <button type="button" class="sec-mi" @click="onSummarize">
            <span class="ic">✦</span>
            <span class="tx"><b>分析总结</b><i>汇总共识 · 标出分歧 · 给下一步问题</i></span>
          </button>
          <button type="button" class="sec-mi" @click="onView">
            <span class="ic">▤</span>
            <span class="tx"><b>查看已总结</b><i>{{ s.minutes.length ? `本会话已总结 ${s.minutes.length} 次` : '本会话还没有总结' }}</i></span>
          </button>
          <button type="button" class="sec-mi" @click="onSettings">
            <span class="ic">⚙</span>
            <span class="tx"><b>秘书设置</b><i>{{ modelLabel }}</i></span>
          </button>
        </div>
      </transition>

      <button class="sec-fab" :class="{ busy: s.busy, open: menuVisible }"
        :aria-label="s.busy ? '小秘书正在整理纪要' : '小秘书：汇总共识与分歧'"
        :title="s.busy ? '小秘书正在整理纪要…' : '小秘书 · 把讨论汇总成共识与分歧'"
        @click="onFabClick">
        <SecretaryMascot :size="46" />
        <em v-if="s.minutes.length" class="badge">{{ s.minutes.length > 9 ? '9+' : s.minutes.length }}</em>
        <em v-if="s.busy" class="ring"></em>
      </button>
    </div>

    <div v-if="s.open" class="sec-mask" @click.self="store.closeSecretary()">
      <div class="sec-panel">
        <header class="sec-panel-head">
          <div class="sec-brand">
            <span class="sec-avatar"><SecretaryMascot :size="34" /></span>
            <div>
              <h2>会议纪要</h2>
              <div class="sec-meta">{{ headMeta }}</div>
            </div>
          </div>
          <div class="sec-top-actions">
            <button class="sec-btn primary" :disabled="s.busy" @click="onSummarize">
              {{ s.busy ? '整理中…' : '总结现在' }}
            </button>
            <button v-if="s.busy" class="sec-btn" @click="store.stopSummarize()">停止</button>
            <button class="sec-x" title="关闭" @click="store.closeSecretary()">✕</button>
          </div>
        </header>

        <div v-if="s.minutes.length || s.busy" class="sec-tabs">
          <button v-for="(m, i) in s.minutes" :key="m.id" class="sec-tab"
            :class="{ on: active && m.id === active.id }" @click="store.setActiveMinute(m.id)">
            <span class="tt">第 {{ m.n || i + 1 }} 次</span>
            <i>{{ fmt(m.created_at) }}</i>
          </button>
          <span v-if="s.busy" class="sec-tab generating">
            <span class="tt">第 {{ s.minutes.length + 1 }} 次</span>
            <i>生成中…</i>
          </span>
          <button v-else type="button" class="sec-tab-add" @click="onSummarize">＋ 再总结一次</button>
        </div>

        <div class="sec-body">
          <div v-if="s.error" class="sec-error">
            <div class="se-title">这次没整理出来</div>
            <p>{{ s.error }}</p>
            <button class="sec-btn primary" @click="onSummarize">重试</button>
          </div>

          <div v-else-if="s.busy" class="sec-wait">
            <div class="orb"><SecretaryMascot :size="66" /></div>
            <div class="stage">{{ stage }}</div>
            <div class="elapsed">{{ elapsed }} 秒 · 正在通读整场讨论</div>
            <div class="hint">{{ modelLabel }}</div>
          </div>

          <div v-else-if="s.loading" class="sec-wait">
            <div class="stage">正在读取历次总结…</div>
          </div>

          <div v-else-if="!active" class="sec-empty">
            <div class="se-emoji"><SecretaryMascot :size="60" /></div>
            <h3>还没有总结过</h3>
            <p>你们聊到一定程度后，点「总结现在」，<br>它会把这整场讨论汇总成：已达成的共识 · 还有哪些分歧 · 下一步该问什么。</p>
            <button class="sec-btn primary" @click="onSummarize">总结现在</button>
          </div>

          <article v-else class="min">
            <div class="min-head">
              <h3>{{ active.title }}</h3>
              <div class="min-meta">
                <span>第 {{ active.n }} 次总结</span>
                <span v-if="active.created_at">{{ fmtFull(active.created_at) }}</span>
                <span v-if="active.models?.length">参与：{{ active.models.join('、') }}</span>
              </div>
              <p v-if="active.overview" class="min-overview">{{ active.overview }}</p>
            </div>

            <section v-if="active.consensus?.length" class="min-sec">
              <h4><span class="tag green">共识</span> 已经谈到一起的 {{ active.consensus.length }} 条</h4>
              <ul class="min-consensus">
                <li v-for="(c, i) in active.consensus" :key="i">
                  <span class="idx">{{ i + 1 }}</span>
                  <p>{{ c.point }}</p>
                  <span v-if="c.who?.length" class="who"><i>{{ c.who.join(' · ') }}</i></span>
                </li>
              </ul>
            </section>

            <section v-if="active.differences?.length" class="min-sec">
              <h4><span class="tag amber">分歧</span> 还没谈拢的 {{ active.differences.length }} 处</h4>
              <div v-for="(d, i) in active.differences" :key="i" class="min-diff">
                <div class="diff-topic">{{ d.topic }}</div>
                <div class="diff-sides">
                  <div v-for="(sd, j) in d.sides" :key="j" class="diff-side">
                    <b>{{ sd.who || '一方' }}</b>
                    <p>{{ sd.view }}</p>
                  </div>
                </div>
                <div v-if="d.note" class="diff-note">{{ d.note }}</div>
              </div>
            </section>

            <section v-if="active.resolved?.length" class="min-sec">
              <h4><span class="tag blue">收敛</span> 上次的分歧，这轮解决了</h4>
              <ul class="min-list">
                <li v-for="(x, i) in active.resolved" :key="i">{{ x }}</li>
              </ul>
            </section>

            <section v-if="active.blind?.length" class="min-sec">
              <h4><span class="tag gray">盲区</span> 没人提到，但值得补</h4>
              <ul class="min-list blind">
                <li v-for="(x, i) in active.blind" :key="i">{{ x }}</li>
              </ul>
            </section>

            <section v-if="active.next?.length" class="min-next">
              <h4><span class="tag blue">下一步</span> 可以这样继续问</h4>
              <button v-for="(q, i) in active.next" :key="i" type="button" class="ask-btn" @click="useQuestion(q)">
                <span class="qn">{{ i + 1 }}</span>
                <span class="qt">{{ q }}</span>
                <span class="qa">发到输入框 →</span>
              </button>
            </section>

            <div v-if="active.raw" class="md min-raw" v-html="mdToHtml(active.raw)"></div>
          </article>
        </div>

        <footer v-if="active && !s.busy" class="sec-panel-foot">
          <span>第 {{ active.n }} 次 · {{ fmtFull(active.created_at) }}</span>
          <span class="grow"></span>
          <button class="sec-foot-btn" @click="copyActive">复制纪要</button>
          <button class="sec-foot-btn danger" @click="store.deleteMinute(active)">删除这次</button>
        </footer>
      </div>
    </div>
  </teleport>
</template>

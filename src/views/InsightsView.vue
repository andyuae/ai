<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { store, DISPLAY_ORDER } from '../store'
import type { Insight } from '../lib/types'

const state = store.state

const DOT: Record<string, string> = {
  openai: '#0C447C', gemini: '#639922', deepseek: '#378ADD', kimi: '#1D9E75', anthropic: '#C15F3C'
}

const tags = computed(() => {
  const m: Record<string, number> = {}
  state.insights.forEach(i => (i.tags || []).forEach(t => { m[t] = (m[t] || 0) + 1 }))
  return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 12)
})

const list = computed(() => {
  const q = state.insightQ.trim().toLowerCase()
  const tag = state.insightTag
  return state.insights.filter(i => {
    if (tag && !(i.tags || []).includes(tag)) return false
    if (!q) return true
    const hay = [i.title, i.question, i.conclusion, i.evidence, i.disputes, i.counter, i.followup, (i.tags || []).join(' ')]
      .join(' ').toLowerCase()
    return hay.includes(q)
  })
})

function fmt(d?: string | null) {
  if (!d) return ''
  return new Date(d).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' })
}
function srcName(k: string) { return store.providerOf(k)?.name || k }
function srcKeys(i: Insight) {
  return (i.sources || []).slice().sort((a, b) => DISPLAY_ORDER.indexOf(a) - DISPLAY_ORDER.indexOf(b))
}

async function refresh() {
  try { await store.loadInsights() } catch (e: any) { ElMessage.warning(e?.message || String(e)) }
}

async function copyText(t: string) {
  try { await navigator.clipboard.writeText(t) }
  catch {
    const ta = document.createElement('textarea')
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta); ta.select()
    try { document.execCommand('copy') } catch { /* ignore */ }
    ta.remove()
  }
}

async function onShare(i: Insight) {
  if (i.share_token) {
    const base = location.pathname.replace(/[^/]*$/, '') || '/'
    await copyText(`${location.origin}${base}?s=${i.share_token}`)
    ElMessage.success('分享链接已复制')
    return
  }
  const link = await store.shareInsight(i)
  if (!link) return
  await copyText(link)
  ElMessage.success('已生成只读链接并复制，任何人打开可看但不能改')
}

async function onUnshare(i: Insight) {
  await store.unshareInsight(i)
  ElMessage.success('已取消分享，旧链接立即失效')
}

onMounted(() => { if (!state.insightsLoaded) refresh() })
</script>

<template>
  <div class="kb-wrap">
    <div class="kb-top">
      <el-button text class="back-link" @click="store.setView('chat')">← 返回聊天</el-button>
      <div class="kb-title-row">
        <div>
          <h1>结论库</h1>
          <div class="kb-sub">每次问完五家，把「共识 / 分歧 / 我的判断」存成一张卡。这里是你自己的判断账本。</div>
        </div>
        <div class="kb-top-actions">
          <el-button @click="refresh" :loading="state.insightsBusy">刷新</el-button>
          <el-button type="primary" @click="store.openInsightEditor({ convId: state.currentConvId })">＋ 新建结论卡</el-button>
        </div>
      </div>
    </div>

    <div class="kb-toolbar">
      <el-input v-model="state.insightQ" clearable placeholder="搜索标题、判断、分歧点、标签…" class="kb-search" />
      <div class="kb-tagbar">
        <button class="kb-chip" :class="{ on: !state.insightTag }" @click="state.insightTag = ''">全部 {{ state.insights.length }}</button>
        <button v-for="[t, n] in tags" :key="t" class="kb-chip" :class="{ on: state.insightTag === t }"
          @click="state.insightTag = state.insightTag === t ? '' : t">{{ t }} <i>{{ n }}</i></button>
      </div>
    </div>

    <div v-if="state.insightsBusy && !state.insights.length" class="kb-empty">加载中…</div>

    <div v-else-if="!state.insights.length" class="kb-empty">
      <div class="kb-empty-emoji">◍</div>
      <h3>还没有结论卡</h3>
      <p>去聊天里问一个问题，等五家答完，回来点「＋ 新建结论卡」<br>再点「AI 提炼当前会话」，它会先帮你起草一张，你改完保存即可。</p>
    </div>

    <div v-else-if="!list.length" class="kb-empty">
      <h3>没有匹配的结论</h3>
      <p>换个关键词，或点「全部」清掉标签筛选。</p>
    </div>

    <div v-else class="kb-grid">
      <article v-for="i in list" :key="i.id" class="kb-card">
        <div class="kb-card-head">
          <h3 :title="i.title">{{ i.title }}</h3>
          <span class="kb-date">{{ fmt(i.created_at) }}</span>
        </div>

        <p v-if="i.question" class="kb-q">{{ i.question }}</p>

        <div v-if="i.conclusion" class="kb-judge">
          <span class="kb-label">我的判断</span>
          <p>{{ i.conclusion }}</p>
        </div>

        <div v-if="i.disputes" class="kb-dispute">
          <span class="kb-label">分歧</span>
          <p>{{ i.disputes }}</p>
        </div>

        <div v-if="i.tags?.length" class="kb-card-tags">
          <span v-for="t in i.tags" :key="t" class="kb-tag" @click="state.insightTag = t">{{ t }}</span>
        </div>

        <div class="kb-card-foot">
          <span v-if="srcKeys(i).length" class="kb-sources" title="最终采信">
            <i v-for="k in srcKeys(i)" :key="k" class="kb-dot" :style="{ background: DOT[k] || '#888' }" :title="srcName(k)"></i>
            <span class="kb-src-text">采信 {{ srcKeys(i).map(srcName).join('、') }}</span>
          </span>
          <span class="kb-actions">
            <button class="kb-act" @click="store.openInsightEditor({ insight: i })">编辑</button>
            <button class="kb-act" :class="{ shared: i.share_token }" @click="onShare(i)">
              {{ i.share_token ? '复制链接' : '分享' }}
            </button>
            <button v-if="i.share_token" class="kb-act" @click="onUnshare(i)">取消分享</button>
            <button class="kb-act danger" @click="store.deleteInsight(i)">删除</button>
          </span>
        </div>
      </article>
    </div>
  </div>
</template>

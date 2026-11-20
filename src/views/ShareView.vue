<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { store, DISPLAY_ORDER } from '../store'
import { PROVIDERS } from '../config'
import type { SharedInsight } from '../lib/types'

const props = defineProps<{ token: string }>()
const data = ref<SharedInsight | null>(null)
const loading = ref(true)
const err = ref('')

function srcName(k: string) { return store.providerOf(k)?.name || PROVIDERS[k]?.name || k }
function fmt(d?: string | null) {
  if (!d) return ''
  return new Date(d).toLocaleString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
}
function keys() {
  return (data.value?.sources || []).slice().sort((a, b) => DISPLAY_ORDER.indexOf(a) - DISPLAY_ORDER.indexOf(b))
}
function lines(t?: string) {
  return String(t || '').split(/\n|；|;/).map(s => s.trim()).filter(Boolean)
}
function goHome() {
  location.href = location.pathname
}

onMounted(async () => {
  try {
    data.value = await store.loadSharedInsight(props.token)
    if (!data.value) err.value = '这个分享链接不存在，或者已经被取消了。'
  } catch (e: any) {
    err.value = e?.message || String(e)
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="share-page">
    <div class="share-bar">
      <span class="share-brand">AI 圆桌 · 结论卡</span>
      <button class="share-home" @click="goHome">我也要问五个 AI →</button>
    </div>

    <div v-if="loading" class="share-state">加载中…</div>
    <div v-else-if="err" class="share-state">{{ err }}</div>

    <article v-else-if="data" class="share-card">
      <h1>{{ data.title }}</h1>
      <div class="share-meta">
        <span v-if="data.shared_at">{{ fmt(data.shared_at) }}</span>
        <span v-if="keys().length">采信：{{ keys().map(srcName).join('、') }}</span>
      </div>

      <p v-if="data.question" class="share-q">{{ data.question }}</p>

      <section v-if="data.conclusion" class="share-sec judge">
        <h2>我的判断</h2>
        <p>{{ data.conclusion }}</p>
      </section>

      <section v-if="lines(data.evidence).length" class="share-sec">
        <h2>多家一致的依据</h2>
        <ul><li v-for="(x, i) in lines(data.evidence)" :key="'e' + i">{{ x }}</li></ul>
      </section>

      <section v-if="lines(data.disputes).length" class="share-sec disputes">
        <h2>分歧点</h2>
        <ul><li v-for="(x, i) in lines(data.disputes)" :key="'d' + i">{{ x }}</li></ul>
      </section>

      <section v-if="lines(data.counter).length" class="share-sec">
        <h2>反例与风险</h2>
        <ul><li v-for="(x, i) in lines(data.counter)" :key="'c' + i">{{ x }}</li></ul>
      </section>

      <section v-if="lines(data.followup).length" class="share-sec">
        <h2>待验证</h2>
        <ul><li v-for="(x, i) in lines(data.followup)" :key="'f' + i">{{ x }}</li></ul>
      </section>

      <div v-if="data.tags?.length" class="share-tags">
        <span v-for="t in data.tags" :key="t">{{ t }}</span>
      </div>

      <footer class="share-foot">
        这是只读页面。内容由本人在「AI 圆桌」中对比多家 AI 的回答后整理，判断属于个人观点，不构成建议。
      </footer>
    </article>
  </div>
</template>

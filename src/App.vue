<script setup lang="ts">
import { onMounted } from 'vue'
import { store } from './store'
import { sb } from './lib/supabase'
import LoginView from './views/LoginView.vue'
import ChatView from './views/ChatView.vue'
import SettingsView from './views/SettingsView.vue'
import InsightsView from './views/InsightsView.vue'
import ShareView from './views/ShareView.vue'
import InsightEditor from './components/InsightEditor.vue'

/* 分享链接：?s=<token> 直接进只读页，不需要登录 */
const shareToken = new URLSearchParams(location.search).get('s') || ''

onMounted(async () => {
  if (shareToken) return
  /* 恢复登录态（30 天免登录由 Supabase 自动续期） */
  const { data } = await sb.auth.getSession()
  if (data?.session?.user) {
    await store.enterApp(data.session.user)
  }
  store.state.authReady = true
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') {
      store.state.user = null
      store.setView('chat')
    }
  })
})
</script>

<template>
  <ShareView v-if="shareToken" :token="shareToken" />
  <div v-else-if="!store.state.authReady" class="boot-loading">加载中……</div>
  <LoginView v-else-if="!store.state.user" />
  <InsightsView v-else-if="store.state.view === 'insights'" />
  <SettingsView v-else-if="store.state.view === 'settings'" />
  <ChatView v-else />
  <InsightEditor v-if="store.state.user && !shareToken" />
</template>

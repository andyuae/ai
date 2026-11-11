<script setup lang="ts">
import { onMounted } from 'vue'
import { store } from './store'
import { sb } from './lib/supabase'
import LoginView from './views/LoginView.vue'
import ChatView from './views/ChatView.vue'
import SettingsView from './views/SettingsView.vue'

onMounted(async () => {
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
  <div v-if="!store.state.authReady" class="boot-loading">加载中……</div>
  <LoginView v-else-if="!store.state.user" />
  <SettingsView v-else-if="store.state.view === 'settings'" />
  <ChatView v-else />
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { store } from '../store'

const email = ref('')
const password = ref('')
const err = ref('')
const busy = ref(false)

async function submit() {
  err.value = ''
  if (!email.value.trim() || !password.value.trim()) { err.value = '请填写账号和密码'; return }
  busy.value = true
  try {
    const r = await store.doLogin(email.value.trim(), password.value.trim())
    if (r) err.value = r
  } catch (e: any) {
    err.value = /fetch|network/i.test(e?.message || '') ? '无法连接服务器，请稍后再试' : ('登录失败：' + (e?.message || e))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="login-wrap">
    <div class="login-card">
      <div class="login-logo">
        <img class="logo-circle" src="/favicon.svg" alt="" aria-hidden="true" />
        <h1>AI 群聊</h1>
        <p>一条消息，同时发给多个 AI，各自独立回答</p>
      </div>
      <el-form @submit.prevent="submit">
        <el-form-item>
          <el-input v-model="email" type="text" placeholder="请输入用户名（或邮箱）" autocomplete="username" size="large" />
        </el-form-item>
        <el-form-item>
          <el-input v-model="password" type="password" placeholder="请输入密码" show-password
            autocomplete="current-password" size="large" @keyup.enter="submit" />
        </el-form-item>
        <div v-if="err" class="login-err">{{ err }}</div>
        <el-button type="primary" size="large" class="w100" :loading="busy" @click="submit">登 录</el-button>
      </el-form>
      <div class="login-tip">
        账号由管理员统一开通，不开放自助注册 · 密码由云端加密保存 · 30 天内免登录
      </div>
    </div>
  </div>
</template>

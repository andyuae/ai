<script setup lang="ts">
import { ref } from 'vue'
import { store } from '../store'
import { ElMessage } from 'element-plus'

const email = ref('')
const password = ref('')
const signup = ref(false)
const err = ref('')
const busy = ref(false)

async function submit() {
  err.value = ''
  if (!email.value.trim() || !password.value.trim()) { err.value = '请填写邮箱和密码'; return }
  busy.value = true
  try {
    const r = await store.doLogin(email.value.trim(), password.value.trim(), signup.value)
    if (r === 'SIGNUP_OK') {
      ElMessage.success('账号创建成功，请使用邮箱和密码登录')
      signup.value = false
    } else if (r) {
      err.value = r
    }
  } catch (e: any) {
    err.value = /fetch|network/i.test(e?.message || '') ? '无法连接服务器，请稍后再试' : ('操作失败：' + (e?.message || e))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="login-wrap">
    <div class="login-card">
      <div class="login-logo">
        <span class="logo-circle">群</span>
        <h1>AI 群聊</h1>
        <p>一条消息，同时发给多个 AI，各自独立回答</p>
      </div>
      <el-form @submit.prevent="submit">
        <el-form-item>
          <el-input v-model="email" type="email" placeholder="请输入邮箱" autocomplete="email" size="large" />
        </el-form-item>
        <el-form-item>
          <el-input v-model="password" type="password" placeholder="请输入密码" show-password
            autocomplete="current-password" size="large" @keyup.enter="submit" />
        </el-form-item>
        <div v-if="err" class="login-err">{{ err }}</div>
        <el-button type="primary" size="large" class="w100" :loading="busy" @click="submit">
          {{ signup ? '创建新账号' : '登 录' }}
        </el-button>
      </el-form>
      <div class="login-tip">
        <template v-if="!signup">首次使用？<a @click="signup = true">点这里创建账号</a></template>
        <template v-else>已有账号？<a @click="signup = false">返回登录</a></template>
        · 密码由云端数据库加密保存 · 30 天内免登录
      </div>
    </div>
  </div>
</template>

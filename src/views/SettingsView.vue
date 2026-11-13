<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { store } from '../store'
import type { UsageMatrix, UsageCell } from '../store'

const state = store.state
const keyInputs = ref<Record<string, string>>({})
const baseInputs = ref<Record<string, string>>({})
const usage = ref<UsageMatrix | null>(null)
const usageLoading = ref(true)
const usageErr = ref('')
const monthOffset = ref(0)

const oldPass = ref('')
const newPass = ref('')
const passMsg = ref('')

async function loadUsageData() {
  usageLoading.value = true
  usageErr.value = ''
  try {
    usage.value = await store.loadUsage(monthOffset.value)
  } catch (e: any) {
    usageErr.value = '统计加载失败：' + (e?.message || e)
  } finally {
    usageLoading.value = false
  }
}
function shiftMonth(n: number) {
  if (monthOffset.value + n > 0) return
  monthOffset.value += n
  loadUsageData()
}
/* 单元格显示：token 数 / 花费（元） */
function cellText(c?: UsageCell) {
  if (!c || (!c.tokens && !c.cost)) return '–'
  const cost = c.cost < 0.01 ? c.cost.toFixed(3) : c.cost.toFixed(2)
  return `${c.tokens ? c.tokens.toLocaleString('zh-CN') : 0} / ¥${cost}`
}

onMounted(async () => {
  await loadUsageData()
  state.providers.forEach((p: any) => { baseInputs.value[p.key] = store.effBaseUrl(p.key) })
})

async function saveKey(key: string) {
  const err = await store.saveProviderKey(key, keyInputs.value[key] || '')
  if (err) ElMessage.warning(err)
  else keyInputs.value[key] = ''
}

async function saveBase(key: string) {
  await store.saveBaseUrl(key, baseInputs.value[key] || '')
  baseInputs.value[key] = store.effBaseUrl(key)
}

async function changePass() {
  passMsg.value = ''
  const r = await store.changePassword(oldPass.value, newPass.value)
  if (r) passMsg.value = r
  else { passMsg.value = '✅ 密码修改成功'; oldPass.value = ''; newPass.value = '' }
}
</script>

<template>
  <div class="settings-wrap">
    <el-button text class="back-link" @click="store.setView('chat')">← 返回聊天</el-button>

    <!-- 密钥配置 -->
    <div class="settings-card">
      <div class="card-head">
        <div>
          <h2>AI 服务密钥配置</h2>
          <div class="sub">填入各家的 API 密钥。密钥保存在云端数据库（仅你本人登录后可读取），网页上仅显示状态，不会回显内容。保存后可点「测试连通」一键验证密钥是否可用。</div>
        </div>
        <el-button type="success" class="test-all-btn" :loading="state.testAllBusy" @click="store.testAllProviders()">
          {{ state.testAllBusy ? '测试中……' : '⚡ 一键测试全部' }}
        </el-button>
      </div>
      <div v-for="p in state.providers" :key="p.key" class="prov-block">
        <div class="prov-head">
          <span class="api-name">{{ p.name }}<span v-if="p.oversea" class="muted small">（海外）</span></span>
          <el-tag :type="p.configured ? 'success' : 'info'" size="small">{{ p.configured ? '已配置' : '未配置' }}</el-tag>
        </div>
        <div class="prov-row">
          <el-input v-model="keyInputs[p.key]" type="password" show-password
            :placeholder="p.configured ? '输入新密钥可更换' : '粘贴 API 密钥'" />
          <el-button type="primary" @click="saveKey(p.key)">保存密钥</el-button>
          <el-button :disabled="!p.configured" :loading="state.testBusy[p.key]" @click="store.testProvider(p.key)">测试连通</el-button>
        </div>
        <div v-if="state.testResults[p.key]" class="test-result" :class="{ ok: state.testResults[p.key].startsWith('✅'), fail: state.testResults[p.key].startsWith('❌') }">
          {{ state.testResults[p.key] }}
        </div>
        <div class="prov-row sub-row">
          <span class="muted small">接口地址</span>
          <el-input v-model="baseInputs[p.key]" size="small" placeholder="https://..." />
          <el-button size="small" @click="saveBase(p.key)">保存地址</el-button>
          <el-button size="small" :disabled="!p.configured" :loading="state.modelBusy[p.key]" @click="store.fetchModelList(p.key)">拉取模型列表</el-button>
        </div>
        <div class="muted small">（用中转站密钥时，请把地址改为中转站给的地址，再拉取真实可用模型）</div>
      </div>
    </div>

    <!-- 启用开关 -->
    <div class="settings-card">
      <h2>模型启用开关</h2>
      <div class="sub">临时关闭某家 AI（例如密钥欠费、服务故障时），不影响其他成员。默认全部启用。</div>
      <div v-for="p in state.providers" :key="p.key" class="switch-line">
        <span>{{ p.name }}<span v-if="!p.configured" class="muted small">（未配置密钥）</span></span>
        <el-switch :model-value="p.enabled" @change="(v: any) => store.toggleProvider(p.key, !!v)" />
      </div>
    </div>

    <!-- 用量 -->
    <div class="settings-card">
      <div class="usage-head">
        <div>
          <h2>用量统计</h2>
          <div class="sub">按 API 返回的 token 估算费用（估算值，以各家账单为准）。单元格为「token 数 / 花费（元）」。</div>
        </div>
        <div class="month-switch">
          <button class="m-btn" title="上一个月" @click="shiftMonth(-1)">‹</button>
          <span class="m-label">{{ usage?.monthLabel || '——' }}</span>
          <button class="m-btn" title="下一个月" :disabled="monthOffset >= 0" @click="shiftMonth(1)">›</button>
        </div>
      </div>
      <div v-if="usageLoading" class="muted">加载中……</div>
      <div v-else-if="usageErr" class="muted">{{ usageErr }}</div>
      <div v-else-if="!usage || !usage.rows.length" class="muted">该月暂无调用记录</div>
      <div v-else class="usage-table-wrap">
        <table class="usage-table">
          <thead>
            <tr>
              <th class="uc-model">模型 \ 日期</th>
              <th v-for="d in usage.days" :key="d">{{ d }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in usage.rows" :key="r.key">
              <td class="uc-model" :title="r.label">{{ r.label }}</td>
              <td v-for="d in usage.days" :key="d" :class="{ empty: !r.cells[d] }">{{ cellText(r.cells[d]) }}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td class="uc-model">合计</td>
              <td v-for="d in usage.days" :key="d" :class="{ empty: !usage.totals.cells[d] }">{{ cellText(usage.totals.cells[d]) }}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div v-if="usage && usage.rows.length" class="usage-foot">
        本月共 {{ usage.totals.tokens.toLocaleString('zh-CN') }} tokens，预计花费 ¥{{ usage.totals.cost.toFixed(2) }}
      </div>
    </div>

    <!-- 账号安全 -->
    <div class="settings-card">
      <h2>账号安全</h2>
      <div class="switch-line">
        <span class="muted">原密码</span>
        <el-input v-model="oldPass" type="password" show-password style="width: 220px" />
      </div>
      <div class="switch-line">
        <span class="muted">新密码（至少 6 位）</span>
        <el-input v-model="newPass" type="password" show-password style="width: 220px" />
        <el-button type="primary" @click="changePass">确认修改</el-button>
      </div>
      <div v-if="passMsg" class="muted">{{ passMsg }}</div>
    </div>
  </div>
</template>

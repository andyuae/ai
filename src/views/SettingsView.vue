<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { store } from '../store'
import type { UsageMatrix, UsageCell } from '../store'
import { isAdminRole, listUsers, createUser, setUserPassword, clearInitPassword, deleteUser, setUserStatus } from '../lib/admin'
import type { AdminUserRow } from '../lib/admin'

const state = store.state
const keyInputs = ref<Record<string, string>>({})
const baseInputs = ref<Record<string, string>>({})
const usage = ref<UsageMatrix | null>(null)
const usageLoading = ref(true)
const usageErr = ref('')
const monthOffset = ref(0)

/* 小秘书用哪家的哪个模型做总结 */
const secProvider = ref('')
const secModel = ref('')
const secUsable = computed(() => state.providers.filter((p: any) => p.configured && p.apiKey))
const secModels = computed(() => state.providers.find((x: any) => x.key === secProvider.value)?.models || [])

function initSecretary() {
  const cfg = state.settings.secretary
  const usable = secUsable.value
  const key = cfg?.provider && usable.some((p: any) => p.key === cfg.provider)
    ? cfg.provider
    : (usable.find((p: any) => p.key === 'deepseek')?.key || usable[0]?.key || '')
  secProvider.value = key
  const p = state.providers.find((x: any) => x.key === key)
  secModel.value = cfg?.model && p?.models.includes(cfg.model) ? cfg.model : (p?.models[0] || '')
}

async function persistSecretary() {
  if (!secProvider.value || !secModel.value) return
  try {
    await store.saveSecretaryConf(secProvider.value, secModel.value)
    ElMessage.success('小秘书模型已保存')
  } catch (e: any) {
    ElMessage.error('保存失败：' + (e?.message || e))
  }
}
async function onSecProvider(v: string) {
  const p = state.providers.find((x: any) => x.key === v)
  secModel.value = p?.models[0] || ''
  await persistSecretary()
}

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
  initSecretary()
  loadAdminUsers()
})

/* ===== 用户管理（仅管理员）===== */
const isAdmin = computed(() => isAdminRole(state.myRole))
const userRows = ref<AdminUserRow[]>([])
const usersLoading = ref(false)
const usersErr = ref('')
const userDialog = ref(false)
const newEmail = ref('')
const newUsername = ref('')
const newPassword = ref('')
const newNote = ref('')
const newRole = ref<'admin' | 'member'>('member')
const creating = ref(false)
const showPwd = ref<Record<string, boolean>>({})
/** 正在切换状态的用户 id（控制开关 loading） */
const statusBusy = ref('')

async function loadAdminUsers() {
  if (!isAdmin.value) return
  usersLoading.value = true
  usersErr.value = ''
  try {
    userRows.value = await listUsers()
  } catch (e: any) {
    usersErr.value = '读取用户列表失败：' + (e?.message || e)
  } finally {
    usersLoading.value = false
  }
}

function openUserDialog() {
  newEmail.value = ''
  newUsername.value = ''
  newPassword.value = ''
  newNote.value = ''
  newRole.value = 'member'
  userDialog.value = true
}

async function submitNewUser() {
  const username = newUsername.value.trim()
  const email = newEmail.value.trim()
  if (!username) { ElMessage.warning('请填写用户名（中文、符号、空格都可以）'); return }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { ElMessage.warning('邮箱格式不对；不想填就留空，系统会自动生成'); return }
  if (newPassword.value.length < 6) { ElMessage.warning('密码至少 6 位（Supabase 平台限制，字符不限）'); return }
  creating.value = true
  try {
    await createUser({
      username,
      email,
      password: newPassword.value,
      role: newRole.value,
      note: newNote.value.trim()
    })
    ElMessage.success('账号已创建，把用户名和密码告知对方即可登录')
    userDialog.value = false
    await loadAdminUsers()
  } catch (e: any) {
    ElMessage.error(e?.message || '创建失败')
  } finally {
    creating.value = false
  }
}

async function resetPwd(u: AdminUserRow) {
  try {
    const { value } = await ElMessageBox.prompt(`给 ${u.username || u.email} 设置新密码`, '重置密码', {
      inputPlaceholder: '至少 6 位',
      inputType: 'password',
      confirmButtonText: '确认重置',
      cancelButtonText: '取消',
      inputValidator: (v: string) => (v && v.length >= 6 ? true : '密码至少 6 位')
    })
    await setUserPassword(u.id, value)
    ElMessage.success('密码已重置，初始密码记录已同步更新')
    await loadAdminUsers()
  } catch (e: any) {
    if (e === 'cancel' || e === 'close') return
    ElMessage.error(e?.message || '重置失败')
  }
}

/** 启用 / 停用：停用 = Auth 封禁，对方连登录都进不来；历史数据保留 */
async function toggleStatus(u: AdminUserRow, enabled: boolean) {
  if (!enabled) {
    try {
      await ElMessageBox.confirm(
        `停用后「${u.username || u.email}」将无法登录（已登录的会话在 token 过期后失效），历史数据会保留。确定停用？`,
        '停用账号',
        { type: 'warning', confirmButtonText: '停用', cancelButtonText: '取消' }
      )
    } catch { return }
  }
  statusBusy.value = u.id
  try {
    await setUserStatus(u.id, enabled)
    u.disabled = !enabled
    ElMessage.success(enabled ? '已启用，对方可以正常登录了' : '已停用，对方无法再登录')
  } catch (e: any) {
    ElMessage.error(e?.message || '操作失败')
  } finally {
    statusBusy.value = ''
  }
}

/** 初始密码列：默认打码，点眼睛看明文 */
function pwdText(u: AdminUserRow) {
  if (!u.init_password) return '—'
  return showPwd.value[u.id] ? u.init_password : '••••••'
}
function togglePwd(u: AdminUserRow) {
  showPwd.value[u.id] = !showPwd.value[u.id]
}

async function clearPwd(u: AdminUserRow) {
  try {
    await ElMessageBox.confirm(
      `清除 ${u.username || u.email} 的初始密码记录？对方现有的密码不受影响，仍可正常登录。`,
      '清除初始密码',
      { type: 'info', confirmButtonText: '清除', cancelButtonText: '取消' }
    )
    await clearInitPassword(u.id)
    ElMessage.success('已清除')
    await loadAdminUsers()
  } catch (e: any) {
    if (e === 'cancel' || e === 'close') return
    ElMessage.error(e?.message || '清除失败')
  }
}

async function removeUser(u: AdminUserRow) {
  try {
    await ElMessageBox.confirm(
      `删除 ${u.username || u.email} 会同时清除他的全部会话、API 密钥和用量记录，且不可恢复。确定删除？`,
      '删除账号',
      { type: 'warning', confirmButtonText: '确定删除', cancelButtonText: '取消', confirmButtonClass: 'el-button--danger' }
    )
    await deleteUser(u.id)
    ElMessage.success('账号已删除')
    await loadAdminUsers()
  } catch (e: any) {
    if (e === 'cancel' || e === 'close') return
    ElMessage.error(e?.message || '删除失败')
  }
}

function fmtTime(t: string | null) {
  if (!t) return '–'
  const d = new Date(t)
  if (isNaN(d.getTime())) return '–'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 没填邮箱时后台自动生成的占位邮箱，界面上不显示，避免一串乱码 */
function isInternalEmail(e: string) {
  return !!e && e.toLowerCase().endsWith('@user.local')
}

async function saveKey(key: string) {
  const err = await store.saveProviderKey(key, keyInputs.value[key] || '')
  if (err) ElMessage.warning(err)
  else keyInputs.value[key] = ''
}

async function saveBase(key: string) {
  await store.saveBaseUrl(key, baseInputs.value[key] || '')
  baseInputs.value[key] = store.effBaseUrl(key)
}

/* 勾选模型变更：整理顺序后交给 store 落库（第一个勾选的为聊天时使用的模型） */
function onModelChange(key: string, checked: string[]) {
  store.setSelModels(key, checked || [])
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
          <span class="muted small">参与回答</span>
          <el-switch :model-value="p.enabled" :disabled="!p.configured"
            @change="(v: any) => store.toggleProvider(p.key, !!v)" />
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
        <!-- 模型勾选：第一个勾选的为聊天时使用的模型 -->
        <div v-if="p.models.length" class="model-checks">
          <div class="mc-title">
            使用模型：<b>{{ (state.settings.selModels?.[p.key] || [p.models[0]])[0] }}</b>
            <span class="muted small">（勾选即保存到数据库，聊天页直接生效）</span>
          </div>
          <el-checkbox-group :model-value="state.settings.selModels?.[p.key] || [p.models[0]]"
            @change="(v: any) => onModelChange(p.key, v)">
            <el-checkbox v-for="m in p.models" :key="m" :value="m" class="mc-item">
              {{ p.modelLabel[m] || m }}
            </el-checkbox>
          </el-checkbox-group>
        </div>
      </div>
    </div>

    <!-- 小秘书（会议纪要）用哪家的模型 -->
    <div class="settings-card">
      <h2>小秘书（会议纪要）</h2>
      <div class="sub">
        聊天页右下角的「小秘书」用它来汇总共识、标出分歧。只有你点「分析总结」时才调用一次，平时零成本。
        建议选便宜、长文能力强的模型（DeepSeek / Gemini Flash）。
      </div>
      <div v-if="!secUsable.length" class="muted small">还没有配置任何密钥，先在上方保存至少一家的密钥。</div>
      <div v-else class="sec-set">
        <label>服务商</label>
        <el-select v-model="secProvider" style="width:180px" @change="onSecProvider">
          <el-option v-for="p in secUsable" :key="p.key" :label="p.name" :value="p.key" />
        </el-select>
        <label>模型</label>
        <el-select v-model="secModel" style="width:300px" @change="persistSecretary">
          <el-option v-for="m in secModels" :key="m"
            :label="(store.providerOf(secProvider)?.modelLabel || {})[m] || m" :value="m" />
        </el-select>
      </div>
      <div class="muted small sec-set-hint">纪要按会话保存，随时可在「查看已总结」里切换第 1 次、第 2 次……</div>
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

    <!-- 用户管理：仅超级管理员可见 -->
    <div v-if="isAdmin" class="settings-card">
      <div class="card-head">
        <div>
          <h2>用户管理 <el-tag size="small" type="warning" effect="plain">仅超级管理员</el-tag></h2>
          <div class="sub">
            登录页已关闭自助注册，账号只能在这里开通。新建后把「用户名（或邮箱）+ 初始密码」告知对方；
            对方忘了密码就在这里点「重置密码」给他设新的，不想再留记录时点「清除」。
            删除账号会一并清除他的全部会话、密钥和用量记录。
          </div>
        </div>
        <el-button type="primary" @click="openUserDialog">＋ 新建账号</el-button>
      </div>
      <div v-if="usersLoading" class="muted">加载中……</div>
      <div v-else-if="usersErr" class="user-err">
        <div>{{ usersErr }}</div>
        <div class="small">
          站内用户管理需要先部署一次 <code>admin-users</code> 边缘函数：Supabase 控制台 → Edge Functions → Deploy a new function，
          名称填 <code>admin-users</code>，把项目里 <code>supabase/functions/admin-users/index.ts</code> 整段粘贴进去 → Deploy。
        </div>
        <div class="small">
          临时也可以直接在 Supabase 控制台 → Authentication → Users → Add user 创建（公开注册已关闭，只有后台能建号）。
        </div>
      </div>
      <div v-else-if="!userRows.length" class="muted">还没有其他账号</div>
      <div v-else class="usage-table-wrap">
        <table class="usage-table user-table">
          <thead>
            <tr><th>用户名</th><th>邮箱</th><th>角色</th><th>状态</th><th>初始密码</th><th>最近登录</th><th class="ut-act">操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="u in userRows" :key="u.id">
              <td class="ut-name">
                <div>
                  {{ u.username || '–' }}
                  <el-tag v-if="u.id === state.user?.id" size="small" type="warning" effect="plain">我</el-tag>
                </div>
                <div v-if="u.note" class="ut-note">{{ u.note }}</div>
              </td>
              <td class="ut-mail" :title="u.email">
                <span v-if="isInternalEmail(u.email)" class="muted">未设置（内部账号）</span>
                <template v-else>{{ u.email }}</template>
              </td>
              <td>
                <el-tag size="small" :type="u.role === 'admin' ? 'danger' : 'info'" effect="plain">
                  {{ u.role === 'admin' ? '管理员' : '成员' }}
                </el-tag>
              </td>
              <td class="ut-status">
                <el-switch
                  :model-value="!u.disabled"
                  :loading="statusBusy === u.id"
                  :disabled="u.role === 'admin' || u.id === state.user?.id"
                  @change="(v: any) => toggleStatus(u, !!v)"
                />
                <span class="ut-status-text" :class="{ off: u.disabled }">{{ u.disabled ? '停用' : '启用' }}</span>
              </td>
              <td class="ut-pwd">
                <span class="pwd-val" :class="{ masked: u.init_password && !showPwd[u.id] }">{{ pwdText(u) }}</span>
                <template v-if="u.init_password">
                  <el-button size="small" text type="primary" @click="togglePwd(u)">{{ showPwd[u.id] ? '隐藏' : '查看' }}</el-button>
                  <el-button size="small" text @click="clearPwd(u)">清除</el-button>
                </template>
              </td>
              <td>{{ fmtTime(u.last_sign_in_at) }}</td>
              <td class="ut-act">
                <el-button size="small" text type="primary" @click="resetPwd(u)">重置密码</el-button>
                <el-button size="small" text type="danger"
                  :disabled="u.role === 'admin' || u.id === state.user?.id" @click="removeUser(u)">删除</el-button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 新建账号弹窗 -->
    <el-dialog v-model="userDialog" title="新建账号" width="440px" append-to-body>
      <el-form label-width="84px" @submit.prevent="submitNewUser">
        <el-form-item label="用户名" required>
          <el-input v-model="newUsername" maxlength="64" placeholder="随便填：中文、空格、符号、emoji 都行" autocomplete="off" />
        </el-form-item>
        <el-form-item label="邮箱">
          <el-input v-model="newEmail" placeholder="选填，留空则自动生成内部账号" autocomplete="off" />
        </el-form-item>
        <el-form-item label="密码" required>
          <el-input v-model="newPassword" placeholder="任意字符，6 位以上" show-password autocomplete="new-password" />
        </el-form-item>
        <el-form-item label="角色">
          <el-radio-group v-model="newRole">
            <el-radio value="member">普通成员</el-radio>
            <el-radio value="admin">管理员</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="newNote" maxlength="40" placeholder="选填，例如：运营-小王" />
        </el-form-item>
      </el-form>
      <div class="muted small">
        登录只填「用户名 + 密码」即可，邮箱留空完全不影响使用；邮箱填了也能用它登录。
        密码 6 位是 Supabase 平台的硬下限（改不了），字符类型不限：中文、空格、符号都能用。
      </div>
      <template #footer>
        <el-button @click="userDialog = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="submitNewUser">创建账号</el-button>
      </template>
    </el-dialog>
  </div>
</template>

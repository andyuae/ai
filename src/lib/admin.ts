import { sb } from './supabase'

/* ===== 用户管理（仅管理员）=====
   创建 / 改密 / 删除用户必须用 service_role key，这个 key 绝不能进前端。
   所以走 Supabase Edge Function「admin-users」：函数内部用 service_role 调 Admin API，
   并校验调用者在 public.users 里的 role 是不是 admin。
   前端只持有 publishable key，普通用户无法自助注册。 */

/** 权限判定只看 public.users.role，不再依赖任何写死的人名/邮箱 */
export function isAdminRole(role?: string | null): boolean {
  return String(role || '').toLowerCase() === 'admin'
}

/** public.users 档案表 + auth.users 合并后的一行 */
export interface AdminUserRow {
  id: string
  username: string
  email: string
  role: 'admin' | 'member' | string
  /** 初始密码（仅超管可见；非登录凭据，可随时清除） */
  init_password: string
  note: string
  /** 停用状态（Auth banned_until 派生；停用后无法登录） */
  disabled: boolean
  created_at: string | null
  last_sign_in_at: string | null
}

/** 边缘函数名候选：按顺序探测，第一个能通的会被记住。
 *  控制台里实际部署的名字是 hyper-function（创建时填的），admin-users 是文档里的标准名。
 *  这样两边任意一个名字都能用，将来删掉重建改名也不会挂。 */
const FN_CANDIDATES = ['hyper-function', 'admin-users']
let resolvedFn = ''

async function call<T = any>(action: string, payload: Record<string, any> = {}): Promise<T> {
  const names = resolvedFn
    ? [resolvedFn, ...FN_CANDIDATES.filter(n => n !== resolvedFn)]
    : [...FN_CANDIDATES]

  for (const name of names) {
    const { data, error } = await sb.functions.invoke(name, { body: { action, ...payload } })
    if (!error) {
      resolvedFn = name
      if (data?.error) throw new Error(data.error)
      return data as T
    }
    // functions-js 把非 2xx 包装成 FunctionsHttpError，message 里只有状态码，真实原因在 context 响应体里
    const ctx: any = (error as any).context
    let detail = ''
    if (ctx && typeof ctx.json === 'function') {
      try {
        const j = await ctx.clone().json()
        detail = j?.error || j?.message || ''
      } catch { /* 响应体不是 JSON，忽略 */ }
    }
    // 404 = 云端没有这个函数名，换下一个候选（此时对方什么都没执行，重试是安全的）
    if (ctx?.status === 404) continue
    throw new Error(detail || (error as any).message || '调用失败')
  }
  throw new Error('用户管理服务未部署：云端找不到 ' + names.join(' / ') + ' 边缘函数')
}

export async function listUsers(): Promise<AdminUserRow[]> {
  const d = await call<{ users: AdminUserRow[] }>('list')
  return d.users || []
}

export interface CreateUserPayload {
  /** 用户名：任意字符（中文/空格/符号都行），必填，不能重名 */
  username: string
  /** 邮箱：选填，留空则后台自动生成内部账号，用户只靠用户名登录 */
  email?: string
  /** 密码：任意字符，至少 6 位（Supabase 平台下限） */
  password: string
  role?: 'admin' | 'member'
  note?: string
}

export async function createUser(p: CreateUserPayload): Promise<string> {
  const d = await call<{ id: string }>('create', { ...p })
  return d.id
}

export async function setUserPassword(id: string, password: string): Promise<void> {
  await call('password', { id, password })
}

export async function clearInitPassword(id: string): Promise<void> {
  await call('clear_password', { id })
}

/** 启用 / 停用账号（停用后该账号无法登录，已登录的会话在 token 过期后失效） */
export async function setUserStatus(id: string, enabled: boolean): Promise<void> {
  await call('status', { id, enabled })
}

export async function deleteUser(id: string): Promise<void> {
  await call('delete', { id })
}

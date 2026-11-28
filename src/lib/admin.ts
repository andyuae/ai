import { sb } from './supabase'

/* ===== 用户管理（仅超级管理员）=====
   创建 / 改密 / 删除用户必须用 service_role key，这个 key 绝不能进前端。
   所以走 Supabase Edge Function「admin-users」：函数内部用 service_role 调 Admin API，
   并校验调用者 JWT 的邮箱是不是 SUPER_ADMIN_EMAIL。
   前端只持有 publishable key，普通用户无法自助注册。 */

/** 超管账号真实邮箱（Supabase Auth 只接受邮箱格式，短名 ai 靠 store 里的别名/RPC 映射） */
export const SUPER_ADMIN_EMAIL = 'ai@qq.com'

export function isSuperAdmin(user: any): boolean {
  return !!user?.email && String(user.email).toLowerCase() === SUPER_ADMIN_EMAIL
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
  created_at: string | null
  last_sign_in_at: string | null
}

async function call<T = any>(action: string, payload: Record<string, any> = {}): Promise<T> {
  const { data, error } = await sb.functions.invoke('admin-users', { body: { action, ...payload } })
  if (error) {
    // functions-js 把非 2xx 包装成 FunctionsHttpError，message 里只有状态码，真实原因在 context 响应体里
    const ctx: any = (error as any).context
    let detail = ''
    if (ctx && typeof ctx.json === 'function') {
      try {
        const j = await ctx.clone().json()
        detail = j?.error || j?.message || ''
      } catch { /* 响应体不是 JSON，忽略 */ }
    }
    if (ctx?.status === 404) {
      throw new Error('用户管理服务未部署：请先在 Supabase 部署 admin-users 边缘函数')
    }
    throw new Error(detail || (error as any).message || '调用失败')
  }
  if (data?.error) throw new Error(data.error)
  return data as T
}

export async function listUsers(): Promise<AdminUserRow[]> {
  const d = await call<{ users: AdminUserRow[] }>('list')
  return d.users || []
}

export interface CreateUserPayload {
  email: string
  password: string
  username?: string
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

export async function deleteUser(id: string): Promise<void> {
  await call('delete', { id })
}

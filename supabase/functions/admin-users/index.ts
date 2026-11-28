/* =====================================================================
   Supabase Edge Function：admin-users
   作用：让「超级管理员」在网页后台创建 / 重置 / 删除登录账号。

   为什么需要它：创建 auth 用户必须用 service_role key，这个 key 绝不能
   放在前端代码里。所以前端只调这个函数（带自己的登录 JWT），函数内部
   校验「调用者邮箱 == 超管邮箱」之后，再用 service_role 调 Admin API。

   部署（一次即可，2 分钟）：
     1. Supabase 控制台 → Edge Functions → Deploy a new function
     2. 名称填 admin-users（必须一模一样）
     3. 把本文件全部内容粘进在线编辑器 → Deploy
     4. 环境变量不用配：SUPABASE_URL / SUPABASE_ANON_KEY /
        SUPABASE_SERVICE_ROLE_KEY 平台默认已注入
     5. 建议在函数设置里关掉 "Enforce JWT verification"？——不用关，
        保持默认开启即可（前端调用时会自动带当前登录 token）

   另外建议同步关闭公开注册（否则别人拿到 anon key 仍可自己 signUp）：
     Authentication → Sign In / Providers → Email →
     关闭 "Allow new users to sign up" → Save
   ===================================================================== */

// @ts-nocheck —— 本文件运行在 Deno 里，不参与前端 tsc 检查
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

/** 超级管理员邮箱（与前端 src/lib/admin.ts 的 SUPER_ADMIN_EMAIL 保持一致） */
const SUPER_ADMIN_EMAIL = 'ai@qq.com'

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: '只接受 POST' }, 405)

  const url = Deno.env.get('SUPABASE_URL') || ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  if (!url || !anonKey || !serviceKey) return json({ error: '函数缺少环境变量，请检查部署设置' }, 500)

  /* 1. 校验调用者：必须是已登录的超管本人 */
  const authHeader = req.headers.get('Authorization') || ''
  if (!authHeader) return json({ error: '未登录' }, 401)

  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false }
  })
  const { data: authData, error: authErr } = await caller.auth.getUser()
  const me = authData?.user
  if (authErr || !me) return json({ error: '登录状态已失效，请重新登录' }, 401)
  if ((me.email || '').toLowerCase() !== SUPER_ADMIN_EMAIL.toLowerCase()) {
    return json({ error: '无权操作：仅超级管理员可管理用户' }, 403)
  }

  /* 2. 用 service_role 建管理员客户端 */
  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  })

  let body: any = {}
  try { body = await req.json() } catch { body = {} }
  const action = String(body.action || '')

  /* 3. 列表 */
  if (action === 'list') {
    const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
    if (error) return json({ error: '读取用户列表失败：' + error.message }, 400)
    const users = (data?.users || [])
      .map((u: any) => ({
        id: u.id,
        email: u.email || '',
        created_at: u.created_at || null,
        last_sign_in_at: u.last_sign_in_at || null,
        note: String(u.user_metadata?.note || '')
      }))
      .sort((a: any, b: any) => String(a.created_at).localeCompare(String(b.created_at)))
    return json({ users })
  }

  /* 4. 新建 */
  if (action === 'create') {
    const email = String(body.email || '').trim().toLowerCase()
    const password = String(body.password || '')
    const note = String(body.note || '').slice(0, 40)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: '邮箱格式不正确' }, 400)
    if (password.length < 6) return json({ error: '密码至少 6 位' }, 400)

    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,     // 直接标记已确认，省掉验证邮件
      user_metadata: { note }  // 备注存在 user_metadata，方便列表展示
    })
    if (error) {
      const dup = /already|exists|registered/i.test(error.message)
      return json({ error: dup ? '该邮箱已存在' : ('创建失败：' + error.message) }, 400)
    }
    return json({ id: data.user?.id || null })
  }

  /* 5. 重置密码 */
  if (action === 'password') {
    const id = String(body.id || '')
    const password = String(body.password || '')
    if (!id) return json({ error: '缺少用户 ID' }, 400)
    if (password.length < 6) return json({ error: '密码至少 6 位' }, 400)
    const { error } = await admin.auth.admin.updateUserById(id, { password })
    if (error) return json({ error: '重置失败：' + error.message }, 400)
    return json({ ok: true })
  }

  /* 6. 删除（外键 on delete cascade，会一并清掉该用户的会话/密钥/用量） */
  if (action === 'delete') {
    const id = String(body.id || '')
    if (!id) return json({ error: '缺少用户 ID' }, 400)
    if (id === me.id) return json({ error: '不能删除当前登录的账号' }, 400)
    const { error } = await admin.auth.admin.deleteUser(id)
    if (error) return json({ error: '删除失败：' + error.message }, 400)
    return json({ ok: true })
  }

  return json({ error: '未知操作：' + action }, 400)
})

/* =====================================================================
   Supabase Edge Function：admin-users
   作用：让「管理员」在网页后台创建 / 重置 / 删除登录账号。

   为什么需要它：创建 auth 用户必须用 service_role key，这个 key 绝不能
   放在前端代码里。所以前端只调这个函数（带自己的登录 JWT），函数内部
   校验「调用者在 public.users 里的 role == admin」之后，再用 service_role 调 Admin API。
   注意：权限只看数据表里的 role，代码里不写死任何邮箱或用户名。

   部署（一次即可，2 分钟）：
     1. Supabase 控制台 → Edge Functions → 打开已有函数（或 Deploy a new function）
     2. 名称任意，但要和前端能对上：前端按 ['hyper-function', 'admin-users'] 依次探测，
        本项目线上实际部署名是 hyper-function（见 src/lib/admin.ts 的 FN_CANDIDATES）
     3. 把本文件全部内容覆盖进在线编辑器 → Deploy
     4. 环境变量不用配：SUPABASE_URL / SUPABASE_ANON_KEY /
        SUPABASE_SERVICE_ROLE_KEY 平台默认已注入
     5. 不必关闭 "Enforce JWT verification"：保持默认开启，前端调用时会自动带当前登录 token

   另外建议同步关闭公开注册（否则别人拿到 anon key 仍可自己 signUp）：
     Authentication → Sign In / Providers → Email →
     关闭 "Allow new users to sign up" → Save
   ===================================================================== */

// @ts-nocheck —— 本文件运行在 Deno 里，不参与前端 tsc 检查
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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

/** Auth 用户是否处于封禁（banned_until 在未来即视为停用） */
function isBanned(u: any): boolean {
  if (!u?.banned_until) return false
  const t = new Date(u.banned_until).getTime()
  return Number.isFinite(t) && t > Date.now()
}

/** 停用时长：100 年，等于永久（Supabase 没有 "禁止登录" 开关，只能靠封禁） */
const BAN_FOREVER = '876000h'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: '只接受 POST' }, 405)

  const url = Deno.env.get('SUPABASE_URL') || ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  if (!url || !anonKey || !serviceKey) return json({ error: '函数缺少环境变量，请检查部署设置' }, 500)

  /* 1. 校验调用者：必须是已登录账号 */
  const authHeader = req.headers.get('Authorization') || ''
  if (!authHeader) return json({ error: '未登录' }, 401)

  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false }
  })
  const { data: authData, error: authErr } = await caller.auth.getUser()
  const me = authData?.user
  if (authErr || !me) return json({ error: '登录状态已失效，请重新登录' }, 401)

  /* 2. 用 service_role 建管理员客户端，并校验权限 */
  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  })

  /* 权限来源：public.users.role。改管理员只需改这张表，不用改代码、不用重新部署。
     读不到档案按「无权限」处理，宁可拒绝也不误放行。 */
  const { data: profile, error: profileErr } = await admin
    .from('users')
    .select('role')
    .eq('id', me.id)
    .maybeSingle()
  if (profileErr) return json({ error: '读取权限信息失败：' + profileErr.message }, 500)
  if (!profile || String(profile.role || '').toLowerCase() !== 'admin') {
    return json({ error: '无权操作：仅管理员可管理系统用户' }, 403)
  }

  let body: any = {}
  try { body = await req.json() } catch { body = {} }
  const action = String(body.action || '')

  /* 3. 列表（auth 用户 + public.users 档案合并） */
  if (action === 'list') {
    const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
    if (error) return json({ error: '读取用户列表失败：' + error.message }, 400)

    // 档案表可能还没建/还没同步，读不到就用兜底值，不能让整个列表挂掉
    const profiles: Record<string, any> = {}
    try {
      const { data: rows, error: pErr } = await admin
        .from('users')
        .select('id, username, email, role, init_password, note')
      if (!pErr && rows) rows.forEach((r: any) => { profiles[r.id] = r })
    } catch { /* 忽略：表不存在时照常返回 auth 用户 */ }

    const users = (data?.users || [])
      .map((u: any) => {
        const p = profiles[u.id] || {}
        const email = u.email || ''
        return {
          id: u.id,
          email,
          username: p.username || email.split('@')[0] || '',
          role: p.role || 'member',
          init_password: p.init_password || '',
          note: p.note || String(u.user_metadata?.note || ''),
          // 停用状态直接读 Auth 的 banned_until，不额外存字段，避免两处不一致
          disabled: isBanned(u),
          created_at: u.created_at || null,
          last_sign_in_at: u.last_sign_in_at || null
        }
      })
      .sort((a: any, b: any) => String(a.created_at).localeCompare(String(b.created_at)))
    return json({ users })
  }

  /* 4. 新建（同时写 public.users 档案，触发器没建也能兜住）
     规则尽量宽松：用户名任意字符（中文/空格/符号都行），邮箱可以不填，
     不填就自动生成一个内部邮箱，用户只靠「用户名 + 密码」登录。 */
  if (action === 'create') {
    const emailInput = String(body.email || '').trim().toLowerCase()
    const password = String(body.password || '')
    const username = String(body.username || '').trim().slice(0, 64)
    const role = body.role === 'admin' ? 'admin' : 'member'
    const note = String(body.note || '').slice(0, 40)

    if (!username) return json({ error: '用户名不能为空' }, 400)
    // 6 位是 Supabase Auth 的平台下限，改不了；字符类型不限（中文/空格/符号都可以）
    if (password.length < 6) return json({ error: '密码至少 6 位（Supabase 平台限制，字符不限）' }, 400)

    let email = emailInput
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: '邮箱格式不正确（也可以留空，系统自动生成内部账号）' }, 400)
    }
    if (!email) {
      // 内部占位邮箱，永远收不到信；用户实际只用用户名登录
      email = 'u_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12) + '@user.local'
    }

    // 用户名查重：全表比对，避免 ilike 把 % _ 当通配符
    const { data: all, error: dupErr } = await admin.from('users').select('username')
    if (!dupErr && all) {
      const lower = username.toLowerCase()
      if (all.some((r: any) => String(r.username || '').toLowerCase() === lower)) {
        return json({ error: '用户名「' + username + '」已被占用，换一个' }, 400)
      }
    }

    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,                                    // 直接标记已确认，省掉验证邮件
      user_metadata: { note, username, role }                 // 触发器会读这三个字段建档案
    })
    if (error) {
      const dup = /already|exists|registered/i.test(error.message)
      return json({ error: dup ? '该邮箱已存在' : ('创建失败：' + error.message) }, 400)
    }

    const uid = data.user?.id || null
    if (uid) {
      // 触发器已建好档案时这里是更新；表还没建时忽略错误，不影响建号
      await admin.from('users').upsert(
        { id: uid, username, email, role, note, init_password: password },
        { onConflict: 'id' }
      )
    }
    return json({ id: uid, email })
  }

  /* 4.1 启用 / 停用（停用 = Auth 封禁，连登录都会被平台直接拒掉） */
  if (action === 'status') {
    const id = String(body.id || '')
    const enabled = !!body.enabled
    if (!id) return json({ error: '缺少用户 ID' }, 400)
    if (id === me.id) return json({ error: '不能停用当前登录的账号' }, 400)

    const { data: target, error: getErr } = await admin.auth.admin.getUserById(id)
    if (getErr || !target?.user) return json({ error: '找不到该账号' }, 400)
    /* 管理员的角色存在数据库里，停用前查一次；不写死任何账号 */
    const { data: tProf } = await admin.from('users').select('role').eq('id', id).maybeSingle()
    if (String(tProf?.role || '').toLowerCase() === 'admin') {
      return json({ error: '管理员账号不能停用，如需限制请先把角色改成成员' }, 400)
    }

    const { error } = await admin.auth.admin.updateUserById(id, {
      ban_duration: enabled ? 'none' : BAN_FOREVER
    })
    if (error) return json({ error: (enabled ? '启用失败：' : '停用失败：') + error.message }, 400)
    return json({ ok: true, disabled: !enabled })
  }

  /* 5. 重置密码（同步更新初始密码记录，方便再次告知） */
  if (action === 'password') {
    const id = String(body.id || '')
    const password = String(body.password || '')
    if (!id) return json({ error: '缺少用户 ID' }, 400)
    if (password.length < 6) return json({ error: '密码至少 6 位' }, 400)
    const { error } = await admin.auth.admin.updateUserById(id, { password })
    if (error) return json({ error: '重置失败：' + error.message }, 400)
    await admin.from('users').update({ init_password: password }).eq('id', id)
    return json({ ok: true })
  }

  /* 5.1 清除初始密码（对方改完密码后，超管把记录清掉） */
  if (action === 'clear_password') {
    const id = String(body.id || '')
    if (!id) return json({ error: '缺少用户 ID' }, 400)
    const { error } = await admin.from('users').update({ init_password: null }).eq('id', id)
    if (error) return json({ error: '清除失败：' + error.message }, 400)
    return json({ ok: true })
  }

  /* 6. 删除（外键 on delete cascade，会一并清掉该用户的会话/密钥/用量） */
  if (action === 'delete') {
    const id = String(body.id || '')
    if (!id) return json({ error: '缺少用户 ID' }, 400)
    if (id === me.id) return json({ error: '不能删除当前登录的账号' }, 400)
    /* 管理员账号一律不许删：先把角色改回 member，再删，避免误删唯一管理员 */
    const { data: dProf } = await admin.from('users').select('role').eq('id', id).maybeSingle()
    if (String(dProf?.role || '').toLowerCase() === 'admin') {
      return json({ error: '管理员账号不能删除，请先把角色改成成员' }, 400)
    }
    const { error } = await admin.auth.admin.deleteUser(id)
    if (error) return json({ error: '删除失败：' + error.message }, 400)
    return json({ ok: true })
  }

  return json({ error: '未知操作：' + action }, 400)
})

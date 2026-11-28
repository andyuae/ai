/* =====================================================================
   二级权限收口：普通成员只能看自己的数据，管理员可读全部
   ---------------------------------------------------------------------
   现状：conversations / messages / settings / usage_logs 的策略都是
        `auth.uid() = user_id`，即每个人只能看到自己的，这一点已经成立。
   本脚本补的是「管理员只读全站」这一层：
        · 普通成员：行为完全不变，仍然只能看到自己那一份
        · 管理员（public.users.role = 'admin'）：SELECT 能看到所有人的
        · 写入永远只限本人（不给管理员开 insert/update/delete 的全局权限）

   为什么需要：前端只用 publishable key，所有查询都受 RLS 约束。
   管理员如果想用前端（或未来的后台页面）统计全站数据，就需要这条策略。
   注意：在 Supabase 控制台的 SQL Editor 里本来就能查全部（那是 postgres
   角色，绕过 RLS），所以本脚本的意义是「用前端 key 查询时也放行管理员，
   同时仍然挡住普通成员」。

   执行方式：Supabase 控制台 → SQL Editor → New query → 整段粘贴 → Run
   幂等，可重复执行。
   ===================================================================== */

/* ---------------------------------------------------------------------
   1. 判断当前登录用户是不是管理员
   security definer：函数以定义者身份读 public.users，绕开 users 表自己的
   RLS，避免「查 users 要看 users 策略、策略又调 users」的递归。
   --------------------------------------------------------------------- */
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.users
    where id = auth.uid()
      and role = 'admin'
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

/* ---------------------------------------------------------------------
   2. 会话：管理员可读全部（写仍然只限本人，靠原有 conv_own 策略）
   --------------------------------------------------------------------- */
drop policy if exists conv_admin_read on public.conversations;
create policy conv_admin_read on public.conversations
  for select
  to authenticated
  using (public.is_admin());

/* ---------------------------------------------------------------------
   3. 消息：管理员可读全部（消息没有 user_id，靠所属会话判断；
      这里直接用 is_admin()，因为能看到多少条由「能查哪些会话」决定）
   --------------------------------------------------------------------- */
drop policy if exists msg_admin_read on public.messages;
create policy msg_admin_read on public.messages
  for select
  to authenticated
  using (public.is_admin());

/* ---------------------------------------------------------------------
   4. 用量日志：管理员可读全部，方便统计团队总消耗
   --------------------------------------------------------------------- */
drop policy if exists usage_admin_read on public.usage_logs;
create policy usage_admin_read on public.usage_logs
  for select
  to authenticated
  using (public.is_admin());

/* ---------------------------------------------------------------------
   5. 偏好设置：管理员只读（data 里没有密钥，纯偏好，可放行）
   --------------------------------------------------------------------- */
drop policy if exists set_admin_read on public.settings;
create policy set_admin_read on public.settings
  for select
  to authenticated
  using (public.is_admin());

/* --- 故意不开放的东西 ---------------------------------------------------
   public.provider_configs —— 里面是各家大模型的 API 密钥，只允许本人读写，
                              管理员也不行（要看密钥请到 Supabase 控制台）。
   任何表的 insert / update / delete —— 一律只限数据所有者本人。
   --------------------------------------------------------------------- */

/* ---------------------------------------------------------------------
   6. 自检：应看到 4 条 admin_read 策略 + is_admin 函数存在
   --------------------------------------------------------------------- */
select
  (select count(*) from pg_policies
     where schemaname = 'public' and policyname like '%\_admin\_read' escape '\') as admin_read_policies,
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_admin') as is_admin_func,
  (select count(*) from public.users where role = 'admin') as admin_count;

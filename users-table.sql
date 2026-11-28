/* =====================================================================
   用户信息表 public.users
   ---------------------------------------------------------------------
   用途：集中存放用户档案（用户名 / 密码 / 邮箱 / 角色），供「设置 → 用户管理」展示。
   与 auth.users 的关系：id 一一对应（外键 + 级联删除），一个账号一行。

   关于「密码」这一列，务必理解：
   • 真正的登录校验走 Supabase Auth，密码是 bcrypt 加密存在 auth.users 里的，
     这张表里存的 init_password 只是「初始密码」，给超管发给同事用；
   • 该列只对超管可见（RLS 限制），对方首次登录后建议自己改密，
     改完可在用户管理里点「清除初始密码」；
   • 不要把它当成登录凭据去比对，也不要把这张表暴露给前端匿名用户。

   执行方式：Supabase 控制台 → SQL Editor → 粘贴本文件全部内容 → Run
   可重复执行（幂等），不会重复建表或丢数据。
   ===================================================================== */

/* ---------- 1. 建表 ---------- */
create table if not exists public.users (
  id            uuid primary key references auth.users(id) on delete cascade,
  username      text not null,
  email         text not null,
  role          text not null default 'member' check (role in ('admin', 'member')),
  init_password text,                                    -- 初始密码（仅超管可读，可随时清空）
  note          text,                                    -- 备注，如「运营-小王」
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table  public.users               is '用户档案表：用户名/邮箱/角色，与 auth.users 一对一';
comment on column public.users.username      is '显示用用户名，同时可用于登录（由 resolve_login_email 解析）';
comment on column public.users.init_password is '初始密码，仅供超管发放账号使用；非登录凭据，登录校验在 Supabase Auth';

/* 用户名唯一（不区分大小写）——同名时自动加数字后缀，见触发器 */
create unique index if not exists users_username_lower_key on public.users (lower(username));
create index if not exists users_email_idx on public.users (lower(email));
create index if not exists users_role_idx  on public.users (role);

/* ---------- 2. updated_at 自动刷新 ---------- */
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists users_touch_updated_at on public.users;
create trigger users_touch_updated_at
  before update on public.users
  for each row execute function public.touch_updated_at();

/* ---------- 3. 行级安全（RLS） ----------
   本人：只能读自己那一行（用于界面显示自己的用户名/角色）
   超管：全部可读写（邮箱写死 ai@qq.com，换超管就改这里）
   前端用的 publishable key 属于 anon/authenticated，永远拿不到别人的行 */
alter table public.users enable row level security;

drop policy if exists users_read_self on public.users;
create policy users_read_self on public.users
  for select
  using (auth.uid() = id);

drop policy if exists users_admin_all on public.users;
create policy users_admin_all on public.users
  for all
  using  (coalesce(auth.jwt() ->> 'email', '') = 'ai@qq.com')
  with check (coalesce(auth.jwt() ->> 'email', '') = 'ai@qq.com');

/* ---------- 4. 新账号自动建档 ----------
   在 auth.users 上挂触发器：任何方式建的号（站内后台、Supabase 控制台 Add user）
   都会自动在 public.users 里补一行，用户名默认取邮箱 @ 前面那段，重名自动加 2、3… */
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  base  text;
  uname text;
  n     int := 1;
begin
  base := coalesce(nullif(trim(new.raw_user_meta_data ->> 'username'), ''),
                   split_part(new.email, '@', 1));
  uname := base;
  while exists (select 1 from public.users where lower(username) = lower(uname)) loop
    n := n + 1;
    uname := base || n::text;
  end loop;

  insert into public.users (id, username, email, role)
  values (
    new.id,
    uname,
    new.email,
    case
      when coalesce(new.raw_user_meta_data ->> 'role', '') in ('admin', 'member')
        then new.raw_user_meta_data ->> 'role'
      when lower(new.email) = 'ai@qq.com' then 'admin'
      else 'member'
    end
  )
  on conflict (id) do nothing;

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

/* ---------- 5. 回填已有账号 ----------
   把 auth.users 里已经存在的账号（比如 ai@qq.com）补进这张表，重名自动加后缀 */
insert into public.users (id, username, email, role)
select t.id, t.uname, t.email, t.role
from (
  select
    u.id,
    u.email,
    coalesce(u.raw_user_meta_data ->> 'username', split_part(u.email, '@', 1))
      || case when row_number() over (
                partition by coalesce(u.raw_user_meta_data ->> 'username', split_part(u.email, '@', 1))
                order by u.created_at
              ) > 1
              then '_' || substr(u.id::text, 1, 4) else '' end as uname,
    case
      when coalesce(u.raw_user_meta_data ->> 'role', '') in ('admin', 'member')
        then u.raw_user_meta_data ->> 'role'
      when lower(u.email) = 'ai@qq.com' then 'admin'
      else 'member'
    end as role
  from auth.users u
) t
on conflict (id) do nothing;

/* ---------- 6. 登录名解析：用户名 → 邮箱 ----------
   登录页允许输入「用户名」或「邮箱」，用户名可以是任意字符（中文/空格/符号）。
   Supabase Auth 只认邮箱，所以短名先在这里查一次对应邮箱（只返回 email，不泄露其他信息）。
   顺序：先按用户名精确匹配，再兜底按邮箱匹配。 */
create or replace function public.resolve_login_email(p_name text)
returns text
language sql
security definer
set search_path = public
stable
as $$
  select email
  from (
    select 1 as pr, email from public.users where lower(username) = lower(trim(p_name))
    union all
    select 2 as pr, email from public.users where lower(email)    = lower(trim(p_name))
  ) t
  order by pr
  limit 1
$$;

revoke all on function public.resolve_login_email(text) from public;
grant execute on function public.resolve_login_email(text) to anon, authenticated;

/* ---------- 7. 自检 ---------- */
-- 看表里现在有哪些人（执行后应至少有一行 ai）
select username, email, role, (init_password is not null) as has_init_password, created_at
from public.users
order by created_at;

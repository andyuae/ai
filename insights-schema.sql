-- ============================================================
-- AI 圆桌 · 结论卡（insights）数据库升级脚本
-- 使用方法：Supabase 控制台 → 左侧 SQL Editor → New query →
--           粘贴本文件全部内容 → 点 RUN，出现 Success 即完成
-- 说明：
--   1. 结论卡只能本人读写（RLS 强制按 user_id 隔离）
--   2. 分享是"按 token 取单条"，通过 security definer 函数实现，
--      匿名用户无法直接 select 表，也无法枚举别人分享过的卡片
-- ============================================================

create table if not exists public.insights (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  conversation_id bigint,                  -- 来源会话（不设外键：删会话不连带删结论）
  title text not null default '未命名结论',
  question text default '',                -- 我当时问的问题
  conclusion text default '',              -- 我自己的判断（最重要的一栏）
  evidence text default '',                -- 多家一致的依据
  disputes text default '',                -- 各家分歧点
  counter text default '',                 -- 反例 / 风险
  followup text default '',                -- 待验证
  sources text[] not null default '{}',    -- 我最终采信了哪几家
  tags text[] not null default '{}',       -- 标签：选品 / 广告 / 成本…
  share_token text unique,                 -- 分享令牌（为空即未分享）
  shared_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_insights_user on public.insights(user_id);
create index if not exists idx_insights_created on public.insights(created_at desc);

-- 行级安全：只有本人能读写
alter table public.insights enable row level security;

drop policy if exists "insights_own" on public.insights;
create policy "insights_own" on public.insights
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 分享读取：只允许"知道 token 的人"取回这一条，且只暴露展示所需字段
create or replace function public.get_shared_insight(tok text)
returns table (
  title text, question text, conclusion text,
  evidence text, disputes text, counter text, followup text,
  sources text[], tags text[], shared_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select title, question, conclusion, evidence, disputes, counter, followup, sources, tags, shared_at
  from public.insights
  where share_token = tok and share_token is not null and share_token <> ''
$$;

grant execute on function public.get_shared_insight(text) to anon, authenticated;

-- ============================================================
-- 撤销分享（可选，按需手动执行）：
-- update public.insights set share_token = null, shared_at = null where id = 卡片id;
-- ============================================================

-- ============================================================
-- AI 圆桌 · Supabase 数据库初始化脚本
-- 使用方法：Supabase 控制台 → 左侧 SQL Editor → New query →
--           粘贴本文件全部内容 → 点 RUN，出现 Success 即完成
-- 说明：每张表都开启了行级安全（RLS），每个用户只能读写自己的数据
-- ============================================================

-- 1) AI 密钥配置表：每行是一家 AI 的密钥与开关
create table if not exists public.provider_configs (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  provider text not null,
  enabled boolean not null default true,
  api_key text,
  unique (user_id, provider)
);

-- 2) 讨论会话表：每场讨论一条记录
create table if not exists public.conversations (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null default '新讨论',
  mode text not null default 'roundtable',
  participants jsonb not null default '[]'::jsonb,
  rounds int not null default 2,
  host_provider text,
  host_model text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 3) 消息表：讨论中的每一条发言
create table if not exists public.messages (
  id bigint generated always as identity primary key,
  conversation_id bigint not null references public.conversations(id) on delete cascade,
  sender text not null,
  provider text,
  model text,
  round_no int,
  content text not null default '',
  tokens int not null default 0,
  status text not null default 'done',
  created_at timestamptz not null default now()
);

-- 4) 偏好设置表：默认模式/轮数/主持人/默认成员（JSON 存储）
create table if not exists public.settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- 5) 用量日志表：每次 AI 调用的费用记录
create table if not exists public.usage_logs (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  provider text,
  model text,
  prompt_tokens int not null default 0,
  completion_tokens int not null default 0,
  cost_estimate numeric not null default 0,
  created_at timestamptz not null default now()
);

-- 索引
create index if not exists idx_conv_user on public.conversations(user_id);
create index if not exists idx_msg_conv on public.messages(conversation_id);
create index if not exists idx_usage_user on public.usage_logs(user_id);

-- ============================================================
-- 行级安全（RLS）：核心安全机制 —— 数据强制按用户隔离
-- ============================================================
alter table public.provider_configs enable row level security;
alter table public.conversations  enable row level security;
alter table public.messages       enable row level security;
alter table public.settings       enable row level security;
alter table public.usage_logs     enable row level security;

drop policy if exists "pcfg_own" on public.provider_configs;
create policy "pcfg_own" on public.provider_configs
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "conv_own" on public.conversations;
create policy "conv_own" on public.conversations
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "msg_own" on public.messages;
create policy "msg_own" on public.messages
  for all
  using (exists (select 1 from public.conversations c where c.id = messages.conversation_id and c.user_id = auth.uid()))
  with check (exists (select 1 from public.conversations c where c.id = messages.conversation_id and c.user_id = auth.uid()));

drop policy if exists "set_own" on public.settings;
create policy "set_own" on public.settings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "usage_own" on public.usage_logs;
create policy "usage_own" on public.usage_logs
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- AI 圆桌 · 回滚脚本（删除全部数据表，慎用！执行后所有数据清空）
drop table if exists public.usage_logs;
drop table if exists public.messages;
drop table if exists public.settings;
drop table if exists public.provider_configs;
drop table if exists public.conversations;

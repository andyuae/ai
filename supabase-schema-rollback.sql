-- AI 群聊 · 回滚脚本（删除全部数据表，慎用！执行后所有数据清空）
-- 注意：这里只删「数据表」，不动 Auth 里的账号。
--   · public.users 与 auth.users 是级联关系，删 public.users 不会删掉登录账号
--   · 真要连账号一起清，只能在 Authentication → Users 里逐个删，或用 Admin API
-- 顺序：先删有外键指向别的表的（messages → conversations，users 独立）

drop table if exists public.insights;
drop table if exists public.usage_logs;
drop table if exists public.messages;
drop table if exists public.settings;
drop table if exists public.provider_configs;
drop table if exists public.conversations;
drop table if exists public.users;

drop function if exists public.get_shared_insight(text);
drop function if exists public.resolve_login_email(text);
drop function if exists public.is_admin();
drop function if exists public.touch_updated_at();
drop function if exists public.handle_new_auth_user();

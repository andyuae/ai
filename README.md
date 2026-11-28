# AI 群聊

一条消息（可带图片 / PDF / Word / 文本附件），同时发给多个 AI（ChatGPT / Gemini / DeepSeek / Kimi / Anthropic），各自独立作答、五栏并排展示。每个 AI 固定自己的"跑道"，支持放大单栏细读、复制、编辑重发、自动联网搜索。

**线上地址**：https://andyuae.github.io/ai/

## 架构

```
前端（本仓库）                        云端
├── src/        Vue 3 源码           ├── Supabase 认证（邮箱+密码）
├── index.html  Vite 入口            ├── Supabase 数据库（会话/消息/密钥/用量）
├── vite.config.ts  构建配置         └── 行级安全 RLS（数据按用户隔离）
└── public/     静态资源（config.js 运行时配置，原样复制到站点根目录）
```

- 构建产物输出到 `dist/`，**不进仓库**：push 到 `main` 后由 GitHub Actions 构建并部署 Pages
- 技术栈：Vue 3 + Vite + TypeScript + Element Plus
- **业务全在前端**：对话、调用各家 AI（OpenAI 兼容流式）都由浏览器直连完成，没有自己的常驻后端
- **唯一的服务端代码**：`supabase/functions/admin-users`（Edge Function）。建号/改密/删号必须用 `service_role`，只能放云端，函数内部会先校验调用者是超管
- AI 密钥由用户在网站设置页自行填写，保存在 Supabase（仅本人可读）

## 开发

```bash
npm install     # 安装依赖（Node 20+）
npm run dev     # 本地开发
npm run typecheck  # 类型检查（CI 必跑）
npm run build   # 构建输出到 dist/；push 到 main 后由 Actions 自动构建并部署
```

## 数据库

在 Supabase SQL Editor **按顺序**执行（后两个依赖前面的表/函数）：

| 顺序 | 脚本 | 作用 |
|---|---|---|
| 1 | `supabase-schema.sql` | 5 张业务表（provider_configs / conversations / messages / settings / usage_logs）+ 本人读写 RLS |
| 2 | `insights-schema.sql` | 结论卡 `insights` 表 + 分享取单条函数 |
| 3 | `users-table.sql` | 用户档案 `users` 表（用户名/角色/初始密码）+ `resolve_login_email()` + 建档触发器 |
| 4 | `admin-read-policies.sql` | 管理员只读全站（`is_admin()` + 4 条 `_admin_read` 策略） |

`supabase-schema-rollback.sql` 为回滚脚本（删表清数据，慎用）。

# AI 圆桌 —— 项目结构与部署说明

多 AI 群聊讨论网站：提问后多个 AI（DeepSeek / Kimi / ChatGPT / Gemini）像群聊一样各抒己见、互相讨论，最后由主持人汇总《综合方案》。

## 线上架构（当前生效）

```
GitHub Pages（本仓库 docs/ 目录）      Supabase 云端服务
├── index.html                        ├── 用户认证（邮箱+密码，加密保存）
├── style.css                         ├── 云数据库（会话/消息/密钥配置/用量）
├── app.js     业务逻辑全在前端       └── 行级安全 RLS（数据按用户隔离）
└── config.js  连接配置 + AI 服务商信息
```

- 浏览器直连各家 AI 的官方 API（已验证 DeepSeek / Kimi 支持跨域直连）
- 界面文件同步到 GitHub 后自动生效（Pages 从 `docs/` 目录发布）
- 数据库初始化：在 Supabase SQL Editor 运行 `supabase-schema.sql`

## 目录结构

```
├── docs/                  # 网站（GitHub Pages 发布目录）
│   ├── index.html / style.css / app.js / config.js
├── supabase-schema.sql    # Supabase 建表脚本（SQL Editor 运行一次）
├── supabase-schema-rollback.sql
└── backend/               # 旧版自托管后端（Node.js + SQLite，已弃用，仅留档）
```

## 旧版本地启动（留档参考）

```bash
cd backend && npm install && npm start   # http://localhost:3000
```

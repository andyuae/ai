# AI 群聊

一条消息（可带图片 / PDF / Word / 文本附件），同时发给多个 AI（ChatGPT / Gemini / DeepSeek / Kimi / Anthropic），各自独立作答、五栏并排展示。每个 AI 固定自己的"跑道"，支持放大单栏细读、复制、编辑重发、自动联网搜索。

**线上地址**：https://andyuae.github.io/ai/

## 架构

```
前端（本仓库）                        云端
├── src/        Vue 3 源码           ├── Supabase 认证（邮箱+密码）
├── index.html  Vite 入口            ├── Supabase 数据库（会话/消息/密钥/用量）
├── vite.config.ts  构建配置         └── 行级安全 RLS（数据按用户隔离）
└── docs/       构建产物（GitHub Pages 发布目录）
```

- **无任何服务端代码**：前端直连 Supabase 与各家 AI 接口（OpenAI 兼容流式）
- 技术栈：Vue 3 + Vite + TypeScript + Element Plus
- AI 密钥由用户在网站设置页自行填写，保存在 Supabase（仅本人可读）

## 开发

```bash
npm install     # 安装依赖
npm run dev     # 本地开发
npm run build   # 构建输出到 docs/，push 后 GitHub Pages 自动更新
```

## 数据库

在 Supabase SQL Editor 运行 `supabase-schema.sql` 初始化（5 张表 + RLS 策略）；`supabase-schema-rollback.sql` 为回滚脚本。

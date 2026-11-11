# AI 圆桌 —— 项目结构与部署说明（开发者备忘）

## 目录结构

```
ai-roundtable/
├── frontend/          # 静态前端（部署到 GitHub Pages）
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   └── config.js     # API_BASE 指向后端地址
└── backend/           # Node.js 后端（云端托管）
    ├── server.js
    ├── package.json
    ├── .env.example   # 环境变量模板（复制为 .env）
    ├── src/
    │   ├── db.js          # SQLite 初始化 + 密钥 AES 加密
    │   ├── auth.js        # bcrypt + JWT
    │   ├── providers.js   # 四家 AI 统一适配（OpenAI 兼容协议）
    │   └── discussion.js  # 圆桌讨论编排（首答→讨论→主持人汇总）
    └── data/          # SQLite 数据库文件（自动创建，每日备份）
```

## 本地启动

```bash
cd backend
npm install
npm start          # 打开 http://localhost:3000 即是完整网站（后端托管前端）
```

默认管理员：admin / 已删除（首次启动自动创建，登录后请立即改密）。

## 上线步骤（阶段 7）

1. 后端：部署到云托管平台，设置环境变量（PORT、JWT_SECRET、KEY_ENC_SECRET、ALLOWED_ORIGIN）
2. 前端：`frontend/config.js` 中 API_BASE 填后端正式地址
3. 用户把 frontend/ 全部文件上传到 GitHub 仓库，开启 Pages
4. 验证：登录 → 配密钥 → 发起一场真实圆桌讨论

## 已知待办

- [ ] 用真实 API 密钥做端到端测试（阶段 6）
- [ ] 云端部署（阶段 7）
- [ ] 数据库每日备份脚本（部署时在托管平台配置定时任务，复制 data/airoundtable.db）

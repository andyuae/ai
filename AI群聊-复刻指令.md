# AI 群聊 · 完整复刻指令

> 一句话：**一条消息（可带图片 / Word / Excel / PPT / PDF）同时发给 5 家 AI，五列并排各自流式作答，对话历史存云端，纯前端部署在 GitHub Pages，零服务器。**
>
> 线上示例：https://andyuae.github.io/ai/ ｜ 代码规模：约 2200 行（Vue 3 + TS）

**怎么用这份文档**

- 想让 AI 直接帮你搭：跳到最后一节「十四、一键提示词」，整段复制给 AI，再把本文档一起丢给它。
- 想自己动手：从第二节按顺序做到第十二节，每节都给了可直接抄的代码/SQL。

---

## 一、产品定义

一个网页版的「AI 圆桌」：

| 能力 | 说明 |
|---|---|
| 多 AI 并行 | 同一条消息同时发给 ChatGPT / Gemini / DeepSeek / Kimi / Anthropic，各列独立流式输出，互不干扰 |
| 多模态 | 图片直接传（支持视觉的模型）；Word/Excel/PPT/PDF 在浏览器里解析成文字再发 |
| 弱模型兜底 | 本身不能看图的模型（如 DeepSeek），自动借别家的眼睛把图片转述成文字再作答，列头标注「图片由 XX 转述」 |
| 语言跟随 | 中文问中文答、英文问英文答，逐轮跟随 |
| 对话管理 | 会话列表、删除、导出 .txt、编辑重发、单列重试、停止生成 |
| 联网搜索 | 每次提问先查一次实时资料注入上下文（失败不影响回答） |
| 用量统计 | 按「模型 × 日期」统计 token 与预估费用 |
| 账号 | 邮箱 + 密码注册/登录，数据按用户隔离（RLS） |

**明确不做的事**：不做服务端代理（密钥只存在用户自己的 Supabase 里）、不做多人协作、不做移动端 App。

---

## 二、技术选型（照抄，别换）

| 层 | 选型 | 为什么 |
|---|---|---|
| 框架 | Vue 3.5 `<script setup>` + TypeScript | 单页应用，响应式够用，编译期能挡住大半字段错误 |
| 构建 | Vite 6 | 秒级热更新；`base` + `outDir` 直接适配 GitHub Pages |
| UI | Element Plus 2.9（zh-cn locale） | 只用弹窗、消息提示、开关、输入框、标签；主体布局全用自定义 CSS |
| 状态 | 单个 `reactive` store（**不引 Pinia**） | 全站就 1 个页面 + 1 个设置页，多个库反而绕 |
| 路由 | **不用 vue-router**，`state.view: 'chat' \| 'settings'` | 只有两个视图，且需要「未登录时根本不渲染」 |
| Markdown | `marked`（GFM）+ `DOMPurify` | AI 输出 = 不可信内容，必须净化后再 `v-html` |
| 数据库/认证 | Supabase（Postgres + Auth + RLS），前端只用 Publishable Key | 免后端；RLS 保证 A 用户读不到 B 用户的会话和密钥 |
| 部署 | GitHub Pages（仓库 → Settings → Pages → main / docs） | 免费、自带 HTTPS，推送即上线 |
| 后端 | **没有** | 浏览器直连各家 AI 的 OpenAI 兼容接口 |

依赖清单（`package.json`）：

```json
{
  "dependencies": {
    "@element-plus/icons-vue": "^2.3.1",
    "@supabase/supabase-js": "^2.48.0",
    "dompurify": "^3.4.18",
    "element-plus": "^2.9.1",
    "marked": "^18.2.1",
    "vue": "^3.5.13"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.2.1",
    "typescript": "^5.7.2",
    "vite": "^6.0.7"
  }
}
```

`vite.config.ts`（**base 和 outDir 是 Pages 的关键**）：

```ts
export default defineConfig({
  plugins: [vue()],
  base: '/你的仓库名/',        // 必须与仓库路径一致，否则线上白屏 + 资源 404
  build: { outDir: 'docs', emptyOutDir: true }  // 产物进 docs/，Pages 指向这里
})
```

---

## 三、目录与文件职责

```
src/
├── main.ts              挂载 Vue + Element Plus（中文 locale）
├── App.vue              启动时恢复登录态；三选一渲染 登录/聊天/设置
├── config.ts            ⭐ Supabase 地址 + 5 家 AI 的 baseUrl/模型/价格
├── store.ts             ⭐ 全站唯一状态 + 所有业务动作（约 660 行）
├── style.css            全部自定义样式（深色侧栏 + 浅色内容区 + 高密度）
├── lib/
│   ├── supabase.ts      3 行，createClient
│   ├── types.ts         数据模型（Conversation / DbMessage / LiveCol / Attachment…）
│   ├── ai.ts            ⭐ AI 调用核心：建消息、流式解析、视觉兜底、搜索、测试连通
│   ├── atts.ts          ⭐ 附件：图片转 dataURL、docx/xlsx/pptx/pdf 解析、序列化
│   └── md.ts            ⭐ Markdown 渲染 + 中文加粗修复 + 表格装饰
└── views/
    ├── LoginView.vue    登录/注册
    ├── ChatView.vue     聊天主界面（会话栏 + 消息区 + 输入区 + 放大浮层）
    └── SettingsView.vue 密钥配置 + 用量统计 + 改密码
```

---

## 四、数据库（Supabase）

新建 Supabase 项目 → SQL Editor → 整段粘贴执行。**5 张表，全部开 RLS。**

```sql
-- 1) 每家的密钥与开关
create table if not exists public.provider_configs (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  provider text not null,
  enabled boolean not null default true,
  api_key text,
  unique (user_id, provider)
);

-- 2) 会话
create table if not exists public.conversations (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null default '新对话',
  mode text not null default 'solo',
  participants jsonb not null default '[]'::jsonb,   -- [{provider, model}]
  rounds int not null default 0,
  status text not null default 'active',             -- active / completed / stopped
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 3) 消息（一条用户消息 + N 条各 AI 的回答同属一个 conversation）
create table if not exists public.messages (
  id bigint generated always as identity primary key,
  conversation_id bigint not null references public.conversations(id) on delete cascade,
  sender text not null,            -- user / assistant
  provider text,                   -- assistant 才有
  model text,
  round_no int,
  content text not null default '',-- 用户消息里含 [[附件:...]] 标记；失败时存错误原文
  tokens int not null default 0,
  status text not null default 'done',  -- done / error
  created_at timestamptz not null default now()
);

-- 4) 偏好（接口地址、勾选的模型、默认成员…都塞在一个 jsonb 里）
create table if not exists public.settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- 5) 用量
create table if not exists public.usage_logs (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  provider text, model text,
  prompt_tokens int not null default 0,
  completion_tokens int not null default 0,
  cost_estimate numeric not null default 0,       -- 元，按 config 里的单价估算
  created_at timestamptz not null default now()
);

create index if not exists idx_conv_user on public.conversations(user_id);
create index if not exists idx_msg_conv on public.messages(conversation_id);
create index if not exists idx_usage_user on public.usage_logs(user_id);
```

RLS（**这是「不用后端也安全」的全部依托**）：

```sql
alter table public.provider_configs enable row level security;
alter table public.conversations  enable row level security;
alter table public.messages       enable row level security;
alter table public.settings       enable row level security;
alter table public.usage_logs     enable row level security;

create policy "pcfg_own"  on public.provider_configs for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "conv_own"  on public.conversations for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 消息没有 user_id，靠所属会话归属判断
create policy "msg_own"   on public.messages for all
  using  (exists (select 1 from public.conversations c where c.id = messages.conversation_id and c.user_id = auth.uid()))
  with check (exists (select 1 from public.conversations c where c.id = messages.conversation_id and c.user_id = auth.uid()));

create policy "set_own"   on public.settings for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "usage_own" on public.usage_logs for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
```

要点：

1. `user_id` 一律 `default auth.uid()`，前端 insert 时**不用传**，也不可能伪造。
2. 密钥（`api_key`）只在「本人登录 + RLS」前提下可读，页面上只显示「已配置」，不回显内容。
3. 用量统计按月查 `usage_logs`，按 `provider|model` 聚合成矩阵。
4. 认证设置里把 **Confirm email 关掉**（个人用），否则注册后要收邮件才能登录。

---

## 五、认证（6 个调用，全在 store.ts）

```ts
// 注册
await sb.auth.signUp({ email, password })
// 登录
const { data } = await sb.auth.signInWithPassword({ email, password })
// 恢复登录态（30 天免登录由 Supabase 自动续期）
const { data } = await sb.auth.getSession()
// 监听登出（多标签页同步）
sb.auth.onAuthStateChange((event, session) => { if (event === 'SIGNED_OUT') … })
// 退出
await sb.auth.signOut()
// 改密码（先校验旧密码）
await sb.auth.signInWithPassword({ email, password: oldPass })
await sb.auth.updateUser({ password: newPass })
```

`App.vue` 首屏：先 `getSession()`，有 session 就 `enterApp(user)`（并行加载偏好 + 密钥 + 会话列表），加载完成前显示「加载中……」，**不要先渲染聊天页再跳登录页**。

---

## 六、AI 调用层（最容易踩坑的地方，重点看）

### 6.1 统一协议

5 家全部按 **OpenAI 兼容** 调：`POST {baseUrl}/chat/completions`，`Authorization: Bearer <key>`，`stream: true`。

`config.ts` 每家只描述元信息，**不要写死任何"视觉模型"**：

```ts
export const PROVIDERS = {
  openai:    { name: 'ChatGPT',   baseUrl: 'https://<你的中转站或官方>/v1',
               models: [...], modelLabel: {...}, price: { in: 20, out: 80 },
               visionModels: [...] },
  gemini:    { name: 'Gemini',    baseUrl: '…', models: [...], price: {...}, visionModels: [...] },
  deepseek:  { name: 'DeepSeek',  baseUrl: 'https://api.deepseek.com/v1', models: [...], price: {...} },
  kimi:      { name: 'Kimi',      baseUrl: 'https://api.moonshot.cn/v1', models: [...], price: {...}, visionModels: [...] },
  anthropic: { name: 'Anthropic', baseUrl: '…', models: [...], price: {...}, visionModels: [...] }
}
```

> 模型 ID 一律以「设置页 → 拉取模型列表」返回的真实 ID 为准。中转站给你的模型名和官方未必一致，写死就会 403。

### 6.2 系统提示

```
你是用户的 AI 助手 {名称}（当前模型：{model}）。用户把同一条消息同时发给了多个 AI 助手，
各 AI 彼此独立作答、互相看不到对方的回答。请独立、直接地回答用户，条理清晰。
【回答语言】<按下面规则注入>
若消息带有图片或文件附件，请结合附件内容回答（图片请先准确描述你看到的内容，再作分析）。
```

语言规则（**别写死"用中文"**，英文模型会无视）：

| 判定 | 注入内容 |
|---|---|
| 含中日韩字符 → `zh` | 用中文回答（简体回简体，繁体回繁体）；用户改用英文就跟着切换 |
| 纯拉丁字母 → `en` | Reply in English — always match the language of the user's latest message… Never answer in Chinese just because the system prompt or searched material is Chinese. |
| 纯数字/符号/只有图 | 不指定语言，跟随上下文（只有图时继承上一轮用户消息的语言） |

### 6.3 构造消息（`buildMessages`）

- 系统提示 + 该 AI **自己** 的历史回答（别的 AI 的回答不传，避免串味）+ 当前消息。
- 历史只取最近 **30 条**。
- 用户历史消息里的图片默认降级为 `[图片：a.png]` 文字；但**最近 2 条带图消息保留真图**（每条最多 2 张），否则「这张图右边那个按钮呢」就丢图。
- **最近 1 条带文件的消息保留正文**（≤20000 字），否则追问表格内容时文件已经不在上下文里。
- 当前消息：`[{ type:'text', text }, { type:'image_url', image_url:{ url: dataURL, detail:'auto' } }]`。
- **同一张图一次请求只发一次**（用 `长度+首40+末40` 做指纹去重）；当前图 base64 总量超过 **5MB** 时不再带历史图——否则请求体翻倍，中转站直接 413/400，表现就是"某一家莫名其妙失败"。

### 6.4 视觉能力的三层处理（关键设计）

```
带图片？
 ├─ 当前模型本身能看图（visionModels 命中 / 名字含 gpt-5|6、gemini、claude、4o、vision…）
 │    → 原图直发，不换模型
 ├─ 不能看，但有其他可用视觉模型
 │    → 换成这个「你密钥确实有权限」的视觉模型（只从实际可用列表里挑）
 └─ 完全不能看（如 DeepSeek）
      → 借别家的眼睛：让另一家视觉模型把图转述成文字 → 替换掉图片段 → 用它自己的模型作答
        列头显示淡黄标签「图片由 ChatGPT 转述」
```

再叠一层兜底：**直传图片失败**（非用户中止、非安全拦截）时，自动走一次「转述 + 重答」；两次都失败才把两段原因合并报错。这样任何一家的图片渠道出问题，那一列也不会空着。

### 6.5 流式解析要兼容的脏数据

自己写 SSE 解析，不要用 SDK。必须处理：

1. `data: [DONE]` 跳过；
2. **200 的流里塞 `{"error": {...}}`** —— 必须抛出，否则界面一直转圈；
3. `delta.content` 是数组（部分中转站返回 `[{type:'text',text:'…'}]`）→ 拼成字符串；
4. 分块可能在 JSON 中间断开 → 按行缓冲，解析失败的行忽略；
5. 全流程结束 `content` 为空 → 明确报「服务返回 200 但响应为空（常见于中转站拒绝了图片）」。

### 6.6 错误处理（体验分水岭）

- **HTTP 非 2xx**：把状态码 + 响应体里 `error.message` 原文带出来（截 240 字），不要只显示「调用失败」。
- **内容安全拦截** `isSafetyBlock()`：匹配 `safety policy / content policy / general_harm / blocked by upstream / 安全策略 / 审核 / excessive content refusals`。这类**不重试**（每拒一次会累加"拒绝次数"，可能延长封禁），界面上隐藏重试按钮，改为「重试无意义」。
- 失败原因**写入 messages.content（status='error'）**，下次打开历史还能看到原因。
- 用户点「停止」时 `AbortController.abort()` 中止全部列，且**不触发降级重试**。

### 6.7 联网搜索（可选但很加分）

每次提问先用 DeepSeek 的搜索接口查一次（`POST https://api.deepseek.com/v1/tools/search`，`{query, count: 8}`），把结果格式化成一段「【今天日期 实时网络搜索结果】」追加到系统提示末尾。搜索失败**静默跳过**，不阻塞回答。只发图不写字时不搜索。

### 6.8 用量记账

```
cost = (prompt_tokens * priceIn + completion_tokens * priceOut) / 1e6
```
写入 `usage_logs`；写失败不影响回答（try/catch 吞掉）。

---

## 七、附件处理（全部在浏览器内完成）

| 格式 | 解析方式 | 限制 |
|---|---|---|
| 图片 png/jpg/gif/webp/bmp | FileReader → dataURL | 单张 ≤ 4MB |
| Word `.docx` | mammoth（CDN 懒加载）转 HTML → 自定义 `htmlToText`（保留段落、列表、表格用制表符分隔） | 6 万字 |
| Excel `.xlsx/.xlsm/.xls` | SheetJS，逐工作表转 CSV | 最多 12 张表、每表 400 行 |
| PPT `.pptx` | JSZip 解包，读 `ppt/slides/slideN.xml` 里的 `<a:t>` | 最多 80 页 |
| PDF | pdf.js 抽文字层 | 50 页；扫描件会提示"请把页面截图当图片发" |
| 文本/代码 | FileReader 直读 | 6 万字 |
| 旧版 `.doc/.ppt` | 不支持 | 提示用户「另存为 .docx / .pptx」 |

规则：

- **第三方库全部走 CDN 懒加载**（`<script>` 注入 + Promise 缓存），首屏不背这些包。
- 一次最多 6 个附件。
- 附件随消息存库，格式是自定义标记，解析时还原：

```
你问的问题
[[附件:图片|a.png|data:image/png;base64,...]]
[[附件:文件|报表.xlsx|【工作表：Sheet1】\n月份,销售额\n…]]
```

- 历史消息给 AI 看时用 `attSummary()` 只留 `[图片：a.png]`，避免每轮都把几 MB 的 base64 重发一遍。

---

## 八、Markdown 渲染（三个必须处理的坑）

```ts
marked.setOptions({ gfm: true, breaks: true })   // breaks: 单个换行也换行，符合聊天习惯
html = DOMPurify.sanitize(marked.parse(text), { USE_PROFILES: { html: true }, ADD_ATTR: ['target','rel'] })
html = html.replace(/<a\s/gi, '<a target="_blank" rel="noopener noreferrer" ')
```

**坑 1：AI 输出是不可信内容。** 必须 DOMPurify；`<script>`、`<img onerror>`、`javascript:` 链接会被清掉。

**坑 2：中文全角标点会让加粗失效。**

```
**“自然排名”**      ← 星号紧贴全角引号
** “流量占比” **     ← 星号内侧带空格
```

按 CommonMark 的定界符规则，这两种都**不构成强调**，页面上直接露出 `**` 原文。解决：在交给 marked 之前做一遍预处理——把成对的 `**…**` 直接转成 `<strong>`（先处理 `***斜体加粗***`），并清理中文行里没配对的残留星号。**行内代码和围栏代码块里的星号必须先占位保护**，否则代码示例会被改坏。

**坑 3：五列并排时表格显示不全。** 每列只有 300 多像素，真表格必然只露出前两列。

做法（容器查询 + 卡片化）：

```css
.fast-body { container-type: inline-size }

@container (max-width: 520px) {
  .md table, .md tbody, .md tr, .md td { display: block; width: 100% }
  .md thead { display: none }
  .md tr { border: 1px solid #e3e9f2; border-radius: 8px; padding: 7px 9px; margin: 7px 0 }
  .md td { display: grid; grid-template-columns: minmax(4em, 40%) 1fr; gap: 8px }
  .md td::before { content: attr(data-label); color: #8a94a6; font-weight: 600 }
  .md td[data-rowhead] { display: block; font-weight: 650; border-bottom: 1px dashed #e8eef7 }
}
```

配套：渲染后遍历表格，把表头文字写进每个单元格的 `data-label`，首列加 `data-rowhead`。效果——窄列里每行变成一张小卡片：

> **该 ASIN 自然排名**
> 卖家精灵这 4 个词 ｜ 161 / 170 / 168 / 168（第 3 页末尾）

放大查看 / 只开两三家（列更宽）时，仍是正常表格。

外加一个 120 条的 HTML 缓存（`Map`），流式输出每帧都重渲染，不缓存会明显掉帧。

---

## 九、界面与交互

```
┌──────────┬──────────────────────────────────────────────┐
│ 侧栏 220 │ 顶部：会话标签（标题/时间/删除）  ＋新开对话   │
│ 品牌菜单 ├──────────────────────────────────────────────┤
│ 会话列表 │ 用户消息气泡（右对齐，含缩略图）              │
│          │ ┌ChatGPT┐┌Gemini┐┌DeepSeek┐┌Kimi┐┌Anthropic┐ │
│          │ │流式正文││      ││        ││    ││         │ │
│          │ └复制────┘└──────┘└────────┘└────┘└─────────┘ │
│          ├──────────────────────────────────────────────┤
│          │ 输入框（Enter 发送 / Shift+Enter 换行）+ ＋附件 │
└──────────┴──────────────────────────────────────────────┘
```

必须做对的细节：

1. **五列用 `display:grid; grid-auto-flow:column; grid-auto-columns:minmax(0,1fr)`**，保证同一行并排、不折行；窗口 < 820px 退化成 2 列，< 560px 单列。
2. **回答中不写入历史消息**：所有 AI 固定在 `liveCols` 各自的"跑道"里流式更新，全部结束后再一次性落库 + 合并到历史。否则每完成一家就重排一次页面，闪烁且滚不动。
3. 列头：色点（每家一个固定色）+ 名称 + 模型标签（省略号截断）+（转述时）淡黄标签「图片由 XX 转述」+ 放大按钮。
4. 列脚：复制（复制成功变「已复制」2 秒）；`status==='error'` 时显示「重试」（只重发这一家）。
5. 放大浮层：同一套 Markdown 渲染，字号放大到 15px，遮罩点击关闭、Esc 关闭。
6. 输入区：附件预览 chip 可删；拖拽文件到页面也能加；发送后清空输入与附件。
7. 「停止」：`AbortController` 全列中止，会话 status 记 `stopped`，历史里标题旁标「（已停止）」。
8. 用户消息 hover 出现「复制 / 编辑重发」（编辑重发 = 把原文填回输入框，不自动发送）。

---

## 十、设置页（4 个区块）

1. **密钥配置**：每家一行——密码框输入密钥（不回显）→ 保存 → 状态标签「已配置/未配置」→ 参与回答开关 → 测试连通 → 接口地址（可改成中转站）→ 拉取模型列表 → 勾选使用哪些模型（**第一个勾选的即发送时使用的模型**）。
2. **一键测试全部**：并发测 5 家，`max_tokens: 8` 的空跑请求，错误按 401/402/404/429/5xx 翻译成人话（密钥无效 / 余额不足 / 无模型权限 / 限流 / 服务故障）。
3. **用量统计**：按月切换，行 = 模型，列 = 日期，格子里是 token 数（迷你条）与费用，底部合计。
4. **账号安全**：旧密码 + 新密码改密。

所有配置写 `settings.data`（jsonb）：`{ baseUrls, relayModels, selModels, default_participants }`。

---

## 十一、部署（GitHub Pages，10 分钟）

1. 建 Supabase 项目 → SQL Editor 跑完第四节的 SQL → Authentication 里关掉 Confirm email。
2. 把 `config.ts` 里的 `SUPABASE_URL` / `SUPABASE_KEY` 换成你自己的（Publishable/anon key，公开无妨）。
3. `npm install` → `npm run dev` 本地跑通 → 在设置页填一家密钥测试连通。
4. `npm run build` → 产物进 `docs/`。
5. 推 GitHub → Settings → Pages → Source: Deploy from a branch → 分支 `main` / 目录 `/docs` → Save。
6. 等 1~2 分钟，访问 `https://<用户名>.github.io/<仓库名>/`。**首次打开记得 Ctrl+F5**（HTML 常被缓存）。
7. 以后每次改完：`npm run build && git add -A && git commit -m "..." && git push`，40 秒左右自动生效。

> 硬约束：**GitHub Pages 没有后端进程**，浏览器不能写仓库里的文件；仓库是 public，任何放进仓库的 `.sqlite`/`.env`/密钥文件等于公开泄露。所以数据只能放 Supabase（或同类的云端数据库），密钥只能存数据库。

---

## 十二、验收清单

- [ ] 五列并排，各自独立流式，互不串答案
- [ ] 带一张截图提问：ChatGPT/Gemini/Claude/Kimi 正常看图；DeepSeek 出答案且列头标「图片由 XX 转述」
- [ ] 追问「这张图右边那个按钮是什么」：图片仍在上下文里
- [ ] 拖入 xlsx：能读出多个工作表；拖入 pptx：能读出每页文字
- [ ] 英文提问回英文，中文提问回中文
- [ ] 某一家密钥填错：那一列显示「HTTP 401：…」原文，其余四列正常
- [ ] 点停止：所有列立刻停，不报错、不重试
- [ ] 刷新页面：历史会话与消息都在；旧回答的表格仍是表格
- [ ] 用另一个账号登录：看不到第一个账号的任何数据（RLS 生效）
- [ ] 手机上打开：单列纵向排列，输入框可用

---

## 十三、十个已知坑（都是真踩过的）

| # | 现象 | 原因 | 解法 |
|---|---|---|---|
| 1 | 带图就 403「无权访问模型 xxx」 | 代码按 `config.visionModel` 写死替换了模型，而你的密钥没有那个模型 | 只在**实际可用模型列表**里挑；能看图就绝不换模型 |
| 2 | 某一家老是失败，其他家正常 | 同一张图在历史与当前消息里各发一次，请求体翻倍被中转站拒 | base64 指纹去重 + 5MB 预算，超了不带历史图 |
| 3 | 界面永远转圈 | 200 的流里返回了 error 对象 / 空响应 | 解析时检查 `json.error`；结束时空内容明确抛错 |
| 4 | 页面上露出一堆 `**` | 中文全角引号紧贴星号，CommonMark 不识别 | 渲染前 `repairEmphasis()` |
| 5 | 表格只显示两列 | 五列并排每列 300px，真表格放不下 | 容器查询 <520px 转卡片布局 |
| 6 | 某列提示被内容安全策略拦截 | Anthropic 等上游的内容分类器 + 累计拒绝次数临时限制 | 识别后**不重试**，提示换模型/稍后再试 |
| 7 | 线上白屏、资源 404 | `vite base` 与仓库路径不一致 | `base: '/仓库名/'`，产物放 `docs/` |
| 8 | 刷新后又要重新登录 | 只把 user 存了内存，没走 `getSession()` | 首屏 `getSession()` 恢复，Supabase 会续期 |
| 9 | 密钥泄露风险 | 把 key 写进前端常量或提交 .env | 密钥只存数据库（RLS 保护），前端只放 Publishable Key |
| 10 | 长对话越来越慢 / 报超长 | 每轮都把全部历史 + 历史图片重发 | 历史取最近 30 条，附件降级成文件名 |

---

## 十四、一键提示词（整段复制给 AI）

> 你是一名资深前端工程师。请用 **Vue 3 + TypeScript + Vite + Element Plus** 从零实现一个「多 AI 并行对话」网站，不使用任何自建后端。以下是完整需求，请直接产出可运行的代码，不要只给思路。
>
> **一、产品**：一条消息同时发给 5 家 AI（ChatGPT / Gemini / DeepSeek / Kimi / Anthropic），五列并排各自流式作答。支持带图片和 Word/Excel/PPT/PDF 附件；支持多轮追问、会话列表、删除、导出 txt、编辑重发、单列重试、停止生成、按提问语言作答、每次提问先联网搜索再回答。
>
> **二、技术栈（不得替换）**：Vue 3.5 `<script setup>` + TS + Vite 6；Element Plus（zh-cn）；状态用单个 `reactive` store，**不引 Pinia**；**不用 vue-router**，用 `state.view: 'chat'|'settings'` 切换；Markdown 用 `marked`（GFM，breaks:true）+ `DOMPurify`；数据与认证用 `@supabase/supabase-js`；构建 `base: '/仓库名/'`、`outDir: 'docs'`，部署 GitHub Pages。
>
> **三、数据库（Supabase，5 张表，全部开 RLS）**：`provider_configs(user_id, provider, enabled, api_key, unique(user_id,provider))`、`conversations(user_id, title, participants jsonb, status, updated_at)`、`messages(conversation_id, sender, provider, model, content, tokens, status)`、`settings(user_id pk, data jsonb)`、`usage_logs(user_id, provider, model, prompt_tokens, completion_tokens, cost_estimate)`。`user_id` 全部 `default auth.uid()`；messages 的 RLS 通过所属 conversation 的 user_id 判断。请一并输出可直接执行的建表 + RLS 策略 SQL。
>
> **四、认证**：邮箱+密码注册/登录/登出/改密码；首屏 `getSession()` 恢复登录态并监听 `onAuthStateChange`。
>
> **五、AI 调用（核心要求）**：全部按 OpenAI 兼容 `POST {baseUrl}/chat/completions`，`stream:true`，自己写 SSE 解析。必须做到：
> 1. 系统提示里写明"同一条消息发给了多个 AI，各自独立作答"，并**按用户这条消息的语言**决定回答语言（中文→中文，英文→English），不要写死中文；
> 2. 图片用 `image_url + dataURL + detail:'auto'` 发送；**不要写死视觉模型名**——当前模型能看图就原图直发；不能看但有可用视觉模型才换；完全没有视觉模型时，让另一家视觉模型把图片转述成文字再作答，并在列头标注「图片由 XX 转述」；
> 3. 同一张图一次请求只发一次（base64 指纹去重），当前图总量超 5MB 时不再携带历史图；
> 4. 直传图片失败时自动"转述+重答"一次，两次都失败才合并报错；
> 5. 流式解析要兼容：`[DONE]`、200 响应里夹 `error` 对象、`delta.content` 为数组、空响应；
> 6. 非 2xx 时把状态码和上游 `error.message` 原文显示到界面；识别内容安全拦截（safety policy / general_harm / 安全策略 / excessive content refusals）后**不重试**并隐藏重试按钮；失败原因写入数据库；
> 7. 历史消息只取最近 30 条，最近 2 条带图消息保留真图（每条最多 2 张），最近 1 条带文件消息保留正文；其他附件降级为 `[图片：xx]`；
> 8. 每次提问先调用 `POST https://api.deepseek.com/v1/tools/search`（query, count:8），把结果作为「实时搜索结果」追加到系统提示，失败静默跳过；
> 9. 每次调用记录 `prompt_tokens/completion_tokens` 和按单价估算的费用到 `usage_logs`。
>
> **六、附件（浏览器内解析）**：图片 ≤4MB 转 dataURL；`.docx` 用 mammoth 转 HTML 后取文本（保留表格，单元格用制表符）；`.xlsx/.xls` 用 SheetJS 逐工作表转 CSV（≤12 表、每表 400 行）；`.pptx` 用 JSZip 读 `ppt/slides/slideN.xml` 的 `<a:t>`（≤80 页）；`.pdf` 用 pdf.js 抽文字（≤50 页）；纯文本直读。全部 CDN 懒加载，首屏不加载这些库。附件以 `[[附件:图片|名|payload]]` 标记随消息存库。
>
> **七、渲染**：AI 回答按 Markdown 渲染（表格/标题/列表/代码/链接）。必须 DOMPurify 净化，外链加 `target="_blank" rel="noopener"`。要额外处理两件事：① 中文全角标点导致 `**“xx”**`、`** xx **` 不生效，渲染前把成对星号转成 `<strong>`，代码块/行内代码里的星号不动；② 五列并排时列宽仅 300px，用容器查询在 <520px 时把表格每行转成"行首作标题 + 其余单元格『表头：值』"的卡片，放大查看时仍为正常表格。
>
> **八、界面**：左侧会话栏（品牌菜单：导出/删除/设置/退出、＋新开对话、会话标签含时间与删除）；消息区用户气泡右对齐、五列卡片并排（`grid-auto-flow:column`，<820px 两列、<560px 单列），列头有色点/名称/模型/放大按钮，列脚有复制与失败重试；输入区支持 Enter 发送、Shift+Enter 换行、＋附件、附件预览可删、拖拽上传；回答期间所有 AI 在自己的 liveCols 里流式更新，**全部结束后才写入历史**（避免反复重排）；点停止用 AbortController 中止全部。
>
> **九、设置页**：每家密钥（不回显）、启用开关、接口地址可改、拉取模型列表（GET /models）、勾选使用的模型（第一个即发送用）、单家测试与一键测试全部（错误翻译成人话）、按月用量统计矩阵、修改密码。配置存 `settings.data` jsonb。
>
> **十、交付要求**：给出完整目录结构、每个文件的完整代码、`package.json`、`vite.config.ts`、建表 SQL、GitHub Pages 部署步骤。代码要能直接 `npm i && npm run dev` 跑起来。不要用占位符代替实现，不要省略流式解析和错误处理。

---

## 附：技术底座一句话总结

> **Vue 3 + Vite + TypeScript + Element Plus 做界面，Supabase（Postgres + Auth + RLS）做数据与账号，浏览器直连 5 家 OpenAI 兼容接口，GitHub Pages 静态托管。没有后端、没有服务器、密钥不落前端。**

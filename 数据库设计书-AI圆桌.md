# 数据库设计书

> 项目名称：AI 圆桌
> 阶段：4 / 7 —— 数据库设计
> 日期：2026-11-11
> 上游文档：《架构设计书》（技术选型：SQLite，运行于云端服务器）

---

## 一、总体说明（大白话版）

数据库就像网站的"记事本仓库"，一共 6 本账本：

| 账本（数据表） | 存什么 | 谁能看 |
|---|---|---|
| users（用户表） | 你的账号和密码（加密指纹） | 只有后端 |
| provider_configs（密钥配置表） | 四家 AI 的 API 密钥（加密存储）、启用开关、可选模型列表 | 只有后端，网页只显示"已配置"状态 |
| conversations（讨论表） | 每一场讨论：标题、模式（快速/圆桌）、参与成员、时间 | 你登录后 |
| messages（消息表） | 每场讨论里的每一条发言：谁说的、说的什么、用了哪个模型、花了多少 token | 你登录后 |
| settings（偏好设置表） | 默认模式、默认轮数、主持人指定、默认成员 | 你登录后 |
| usage_logs（用量日志表） | 每次 AI 调用的费用记录，用于"用量统计"页面的汇总 | 你登录后 |

**核心关系**：一个用户 → 拥有多场讨论 → 每场讨论有多条消息；一个用户 → 一份密钥配置 + 一份偏好设置 + 多条用量日志。

## 二、表结构明细

### 1. users —— 用户表

| 字段 | 类型 | 说明 |
|---|---|---|
| id | 整数，主键 | 用户编号 |
| username | 文本，唯一 | 用户名（登录用） |
| password_hash | 文本 | 密码的 bcrypt 加密指纹（不存原始密码） |
| created_at | 时间 | 注册时间 |
| last_login_at | 时间 | 最近登录时间 |

> V1 只有一个账号（注册功能关闭）；表结构按多用户设计，未来开放注册无需改动。

### 2. provider_configs —— 密钥配置表

| 字段 | 类型 | 说明 |
|---|---|---|
| id | 整数，主键 | 配置编号 |
| user_id | 整数，外键 → users | 属于哪个用户 |
| provider | 文本 | deepseek / kimi / openai / gemini |
| api_key_encrypted | 文本 | **AES 加密后的密钥**（加密钥匙只在服务器环境变量里，数据库文件泄露也读不出密钥） |
| enabled | 布尔 | 该家 AI 是否启用（对应设置页的开关） |
| models | JSON 文本 | 可选的模型档位列表（如 ["deepseek-chat","deepseek-reasoner"]），后台可添加 |
| updated_at | 时间 | 最近修改时间 |

> 网页端的"设置页"保存密钥后，接口永不返回密钥原文，只返回"已配置/未配置"。

### 3. conversations —— 讨论表

| 字段 | 类型 | 说明 |
|---|---|---|
| id | 整数，主键 | 讨论编号 |
| user_id | 整数，外键 → users | 属于哪个用户 |
| title | 文本 | 讨论标题（取你第一条提问的前 20 字） |
| mode | 文本 | fast（快速）/ roundtable（圆桌） |
| status | 文本 | active（进行中）/ completed（已完成）/ stopped（手动停止） |
| participants | JSON 文本 | 本场参与的成员及各自模型，如 [{"provider":"deepseek","model":"deepseek-reasoner"},…] |
| rounds | 整数 | 本场圆桌讨论轮数 |
| created_at / updated_at | 时间 | 创建 / 最近发言时间 |

### 4. messages —— 消息表（最核心的表）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | 整数，主键 | 消息编号 |
| conversation_id | 整数，外键 → conversations | 属于哪场讨论 |
| sender | 文本 | user（你）/ assistant（AI）/ host（主持人汇总） |
| provider | 文本，可空 | AI 发言时是哪家（user 发言为空） |
| model | 文本，可空 | 该发言用的具体模型档位 |
| round_no | 整数 | 第几轮（0=各自首答，1~3=圆桌讨论轮，99=主持人汇总） |
| content | 文本 | 发言内容 |
| status | 文本 | ok（成功）/ error（该模型调用失败，附错误说明） |
| prompt_tokens / completion_tokens | 整数 | 本次调用的输入/输出 token 数（API 返回的真实数据） |
| created_at | 时间 | 发言时间 |

> 历史记录页的"查看某场讨论"= 按 conversation_id 取出全部消息按时间排序显示。

### 5. settings —— 偏好设置表

| 字段 | 类型 | 说明 |
|---|---|---|
| id | 整数，主键 | 编号 |
| user_id | 整数，外键 → users，唯一 | 属于哪个用户（一人一份） |
| default_mode | 文本 | 默认讨论模式 |
| default_rounds | 整数 | 默认圆桌轮数 |
| host_provider / host_model | 文本 | 指定哪家哪个模型当主持人 |
| default_participants | JSON 文本 | 默认参与成员及各自模型 |

### 6. usage_logs —— 用量日志表

| 字段 | 类型 | 说明 |
|---|---|---|
| id | 整数，主键 | 日志编号 |
| user_id | 整数，外键 → users | 属于哪个用户 |
| provider / model | 文本 | 哪家哪个模型 |
| prompt_tokens / completion_tokens | 整数 | token 用量 |
| cost_estimate | 实数 | 估算费用（按各家公开单价折算） |
| created_at | 时间 | 调用时间 |

> 设置页"用量统计"= 按月汇总本表。每次 AI 调用（含失败重试）都记录一条。

## 三、关系图（一图看懂数据怎么连）

```
users (1) ──── (1) provider_configs   一人一份密钥配置
users (1) ──── (1) settings           一人一份偏好设置
users (1) ──── (n) conversations      一人多场讨论
users (1) ──── (n) usage_logs         一人多条用量日志
conversations (1) ──── (n) messages   一场讨论多条消息
```

## 四、安全与维护设计

| 措施 | 说明 |
|---|---|
| 数据隔离 | 所有表带 user_id，每个接口查询时强制限定"只查当前登录用户的数据" |
| 密钥双保险 | 密钥 AES 加密后入库；加密钥匙存在服务器环境变量（不进数据库、不进代码仓库） |
| 每日备份 | 数据库单文件，每天自动复制一份，保留最近 7 天 |
| 数据删除 | 你删除讨论时，该场消息同步删除；设置页"清空历史"需二次确认 |
| 容量预估 | 一场圆桌讨论（4 AI × 3 轮 + 汇总）约产生 10~20 条消息、几万字符，SQLite 完全无压力；按每天 10 场算，一年数据量 < 100MB |

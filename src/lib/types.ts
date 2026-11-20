export type AttKind = 'image' | 'file'
export interface Attachment { kind: AttKind; name: string; dataUrl?: string; text?: string }
export type Role = 'system' | 'user' | 'assistant' | 'tool'
export interface ChatMsg { role: Role; content: any }

export interface Conversation {
  id: number
  title: string
  mode: string
  participants: { provider: string; model: string }[]
  status: string
  updated_at: string
}

export interface DbMessage {
  id: number
  conversation_id: number
  sender: 'user' | 'assistant' | 'host'
  provider?: string
  model?: string
  content: string
  tokens: number
  status: string
  created_at?: string
}

export interface ProviderState {
  key: string
  name: string
  models: string[]
  modelLabel: Record<string, string>
  oversea: boolean
  configured: boolean
  enabled: boolean
  apiKey: string | null
}

export interface LiveCol {
  provider: string
  model: string
  text: string
  state: 'running' | 'done' | 'error'
  error?: string
  note?: string        // 例如"图片由 Gemini 转述"
}

export interface SettingsData {
  default_participants?: unknown[]
  baseUrls?: Record<string, string>
  relayModels?: Record<string, string[]>
  selModels?: Record<string, string[]>   // 每家勾选的模型（第一个为发送时使用的模型）
  secretary?: SecretaryConf              // 小秘书用哪家的哪个模型做总结
}

/* ===== 小秘书 · 会议纪要 ===== */
export interface SecretaryConf { provider: string; model: string }

export interface MinutePoint { point: string; who: string[] }
export interface MinuteDiffSide { who: string; view: string }
export interface MinuteDiff { topic: string; sides: MinuteDiffSide[]; note?: string }

/** 一次总结 = 一个选项卡；存在 messages 表里（sender='host'），不额外建表 */
export interface Minute {
  id: number
  n: number
  title: string
  overview: string
  consensus: MinutePoint[]
  differences: MinuteDiff[]
  resolved: string[]     // 上次有分歧、这次已收敛
  blind: string[]        // 没人提到但关键的盲区
  next: string[]         // 下一步可以直接问的问题
  raw?: string           // 模型没按 JSON 返回时，原文兜底
  models: string[]       // 参与这场讨论的 AI 名字
  secProvider?: string
  secModel?: string
  rangeTo?: number       // 总结覆盖到哪条消息
  created_at?: string
}

/* 结论卡：把一次多 AI 对比压缩成"我自己的判断"，可搜索、可分享 */
export interface Insight {
  id?: number
  conversation_id?: number | null
  title: string
  question: string
  conclusion: string      // 我的判断
  evidence: string        // 多家一致的依据
  disputes: string        // 分歧点
  counter: string         // 反例 / 风险
  followup: string        // 待验证
  sources: string[]       // 最终采信了哪几家
  tags: string[]
  share_token?: string | null
  shared_at?: string | null
  created_at?: string
  updated_at?: string
}

/* 分享页读到的只读结论（无 id / 无 user_id） */
export type SharedInsight = Omit<Insight, 'id' | 'conversation_id' | 'share_token' | 'created_at' | 'updated_at'>


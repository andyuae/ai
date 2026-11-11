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
}

export interface SettingsData {
  default_participants?: unknown[]
  baseUrls?: Record<string, string>
  relayModels?: Record<string, string[]>
}

/** 全局配置：Supabase 公开钥匙 + AI 服务商信息（与旧版 config.js 等价） */
export const SUPABASE_URL = 'https://dkmdttuwzaghiehvkfua.supabase.co'
export const SUPABASE_KEY = 'sb_publishable_NNxHIOFD-BeoXJG50C5c3g_kpKhKw9i'

export interface ProviderMeta {
  name: string
  baseUrl: string
  models: string[]
  modelLabel: Record<string, string>
  price: { in: number; out: number } // 每百万 token 人民币（估算）
  oversea?: boolean
  visionModel?: string
  visionModels?: string[]
}

export const PROVIDERS: Record<string, ProviderMeta> = {
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'],
    modelLabel: {
      'deepseek-flash': '快速版（日常够用）',
      'deepseek-v4-pro': '专业版（更强）',
      'deepseek-v4-flash-vision-exp': '视觉理解版（可看图）'
    },
    price: { in: 2, out: 8 },
    visionModel: 'deepseek-v4-flash-vision-exp',
    visionModels: ['deepseek-v4-flash-vision-exp']
  },
  kimi: {
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k3.1-pro', 'kimi-k3', 'kimi-k2.6'],
    modelLabel: {
      'kimi-k3.1-pro': 'K3.1 Pro（推荐·可看图）',
      'kimi-k3': 'K3',
      'kimi-k2.6': 'K2.6（部分密钥无权限）'
    },
    price: { in: 4, out: 21 },
    visionModel: 'kimi-k3.1-pro',
    visionModels: ['kimi-k3.1-pro', 'kimi-k3']
  },
  openai: {
    name: 'ChatGPT',
    baseUrl: 'https://4sapi.com/v1',
    models: ['gpt-5.6', 'gpt-5.6-mini', 'gpt-4o'],
    modelLabel: { 'gpt-5.6': 'GPT-5.6', 'gpt-5.6-mini': 'GPT-5.6 mini（快）', 'gpt-4o': 'GPT-4o' },
    price: { in: 20, out: 80 },
    visionModel: 'gpt-5.6',
    visionModels: ['gpt-5.6', 'gpt-5.6-mini', 'gpt-4o']
  },
  gemini: {
    name: 'Gemini',
    baseUrl: 'https://4sapi.com/v1',
    models: ['gemini-3.6-pro', 'gemini-3.6-flash', 'gemini-2.5-flash'],
    modelLabel: {
      'gemini-3.6-pro': 'Gemini 3.6 Pro（强）',
      'gemini-3.6-flash': 'Gemini 3.6 Flash（快）',
      'gemini-2.5-flash': 'Gemini 2.5 Flash'
    },
    price: { in: 10, out: 40 },
    visionModel: 'gemini-3.6-flash',
    visionModels: ['gemini-3.6-pro', 'gemini-3.6-flash', 'gemini-2.5-flash']
  },
  anthropic: {
    name: 'Anthropic',
    /* 走 4sapi 中转（OpenAI 兼容接口，与 ChatGPT/Gemini 同一个密钥地址） */
    baseUrl: 'https://4sapi.com/v1',
    models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    modelLabel: {
      'claude-opus-4-6': 'Claude Opus 4.6（最强）',
      'claude-sonnet-4-6': 'Claude Sonnet 4.6（推荐）',
      'claude-haiku-4-5': 'Claude Haiku 4.5（快）'
    },
    price: { in: 22, out: 110 },
    visionModel: 'claude-sonnet-4-6',
    visionModels: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5']
  }
}

/** 密钥前缀提示（保存时格式提醒，不强制） */
export const KEY_PREFIX_HINT: Record<string, { prefix: string; altPrefix?: string; name: string }> = {
  deepseek: { prefix: 'sk-', name: 'DeepSeek' },
  kimi: { prefix: 'sk-', name: 'Kimi（月之暗面）' },
  openai: { prefix: 'sk-', name: 'ChatGPT（中转站或 OpenAI 官方）' },
  gemini: { prefix: 'sk-', altPrefix: 'AIza', name: 'Gemini（中转站 sk- 开头；Google 官方 AIza 开头）' },
  anthropic: { prefix: 'sk-', altPrefix: 'sk-ant-', name: 'Anthropic（中转站 sk- 开头；官方 sk-ant- 开头）' }
}

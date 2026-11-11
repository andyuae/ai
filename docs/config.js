/**
 * config.js —— 前端配置
 *
 * Supabase 公开配置：这两项本来就设计为放在网页代码里（公开钥匙），
 * 安全性由云端数据库的"行级权限规则"保证 —— 每个用户只能读写自己的数据。
 */
window.SUPABASE_URL = 'https://dkmdttuwzaghiehvkfua.supabase.co';
window.SUPABASE_KEY = 'sb_publishable_NNxHIOFD-BeoXJG50C5c3g_kpKhKw9i';

/**
 * AI 服务商配置（原后端 providers.js 前移）
 * price: 每百万 token 人民币（估算用）；oversea: 国内网络可能无法直连
 */
window.PROVIDERS = {
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    modelLabel: { 'deepseek-chat': '普通对话版', 'deepseek-reasoner': '深度思考版' },
    price: { in: 2, out: 8 }
  },
  kimi: {
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2-0905-preview', 'moonshot-v1-8k'],
    modelLabel: { 'kimi-k2-0905-preview': 'K2 最新版', 'moonshot-v1-8k': '标准版' },
    price: { in: 4, out: 21 }
  },
  openai: {
    name: 'ChatGPT',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
    modelLabel: { 'gpt-4o': 'GPT-4o', 'gpt-4o-mini': 'GPT-4o mini', 'o3-mini': 'o3-mini' },
    price: { in: 20, out: 80 },
    oversea: true
  },
  gemini: {
    name: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    modelLabel: { 'gemini-2.5-pro': 'Pro（强）', 'gemini-2.5-flash': 'Flash（快）' },
    price: { in: 10, out: 40 },
    oversea: true
  }
};

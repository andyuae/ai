/**
 * config.js —— 前端配置
 *
 * Supabase 公开配置：这两项本来就设计为放在网页代码里（公开钥匙），
 * 安全性由云端数据库的"行级权限规则"保证 —— 每个用户只能读写自己的数据。
 */
window.SUPABASE_URL = 'https://dkmdttuwzaghiehvkfua.supabase.co';
window.SUPABASE_KEY = 'sb_publishable_NNxHIOFD-BeoXJG50C5c3g_kpKhKw9i';
// 备用公开钥匙（两把均可用于本项目的公开访问，由行级权限规则保证安全）
// window.SUPABASE_KEY = 'sb_publishable_hdxytdfwapk_TUcZQIGS-HkvIMK77R6z7n_dlCqYt4w';

/**
 * AI 服务商配置
 * price: 每百万 token 人民币（估算用）；oversea: 国内网络可能无法直连
 * webSearch: 支持联网搜索（AI 需要时自动搜索，无需手动开关）
 * searchPrice: 每次成功搜索的价格（人民币）
 */
window.PROVIDERS = {
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    modelLabel: { 'deepseek-flash': '快速版（日常够用）', 'deepseek-v4-pro': '专业版（更强）' },
    price: { in: 2, out: 8 },
    webSearch: true,
    searchPrice: 0.005
  },
  kimi: {
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2.6', 'kimi-k2.5', 'moonshot-v1-128k'],
    modelLabel: { 'kimi-k2.6': 'K2.6（推荐）', 'kimi-k2.5': 'K2.5', 'moonshot-v1-128k': '标准长文本版' },
    price: { in: 4, out: 21 },
    webSearch: true,
    searchPrice: 0.03
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

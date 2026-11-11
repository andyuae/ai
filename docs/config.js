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
    models: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'],
    modelLabel: { 'deepseek-flash': '快速版（日常够用）', 'deepseek-v4-pro': '专业版（更强）', 'deepseek-v4-flash-vision-exp': '视觉理解版（可看图）' },
    price: { in: 2, out: 8 },
    webSearch: true,
    searchPrice: 0.005,
    visionModel: 'deepseek-v4-flash-vision-exp',
    visionModels: ['deepseek-v4-flash-vision-exp']
  },
  kimi: {
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k3.1-pro', 'kimi-k3', 'kimi-k2.6'],
    modelLabel: { 'kimi-k3.1-pro': 'K3.1 Pro（推荐·可看图）', 'kimi-k3': 'K3', 'kimi-k2.6': 'K2.6（部分密钥无权限）' },
    price: { in: 4, out: 21 },
    webSearch: true,
    searchPrice: 0.03,
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
    modelLabel: { 'gemini-3.6-pro': 'Gemini 3.6 Pro（强）', 'gemini-3.6-flash': 'Gemini 3.6 Flash（快）', 'gemini-2.5-flash': 'Gemini 2.5 Flash' },
    price: { in: 10, out: 40 },
    visionModel: 'gemini-3.6-flash',
    visionModels: ['gemini-3.6-pro', 'gemini-3.6-flash', 'gemini-2.5-flash']
  }
};

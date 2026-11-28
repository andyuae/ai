import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 构建产物输出到 docs/，同时用于两个托管平台：
//   1) GitHub Pages：仓库 andyuae/ai，访问路径是 /ai/（子路径）
//   2) Cloudflare Pages：直接托管 docs/ 目录，访问路径是根 /（也能绑自定义域名）
//
// base 用相对路径 './'：产物里引用的是 ./assets/xxx.js，
// 浏览器按「当前页面所在路径」解析，所以两边都对：
//   https://andyuae.github.io/ai/  → /ai/assets/xxx.js   ✓
//   https://ai-xxx.pages.dev/      → /assets/xxx.js      ✓
// 一份产物两个平台通吃，不用为谁单独配置。
//
// 注意：本应用没有 vue-router（视图靠 store 切换、URL 不带路由），
// 所以相对 base 不会出现「刷新子路径 404」的问题。
// 将来若改成 history 路由，需要把 base 改回绝对路径。
export default defineConfig({
  plugins: [vue()],
  base: './',
  build: {
    outDir: 'docs',
    emptyOutDir: true
  }
})

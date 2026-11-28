import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 构建产物输出到 dist/（标准目录，不进 Git），由 GitHub Actions 上传为 Pages artifact。
//
// 历史说明：早期用 docs/ 是为了「提交产物 + GitHub Pages 分支发布」；现已改为 Actions，
// docs/ 已从仓库移除，新构建只写 dist/。
//
// base 用相对路径 './'：产物里引用的是 ./assets/xxx.js、./config.js，
// 浏览器按「当前页面所在路径」解析，所以同一份产物丢到任何目录、任何空间都能跑：
//   https://andyuae.github.io/ai/     → /ai/assets/xxx.js      ✓
//   https://host.com/some/deep/dir/   → /some/deep/dir/assets/xxx.js  ✓
//
// 配套的两处「可移植」处理：
//   · index.html 里有尾斜杠纠正脚本（宿主不自动跳 /abc/ 时补一次，避免 ./assets 解析错位）
//   · public/config.js 提供运行时配置，换数据库不用重新构建
//
// 注意：本应用没有 vue-router（视图靠 store 切换、URL 不带路由），
// 所以相对 base 不会出现「刷新子路径 404」的问题。
// 将来若引入路由，必须用 createWebHashHistory，否则整包迁移会失效。
export default defineConfig({
  plugins: [vue()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})

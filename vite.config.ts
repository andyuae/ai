import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// GitHub Pages：仓库 andyuae/ai 发布 main 分支的 docs/ 目录
// base 必须是 /ai/，构建产物输出到 docs/
export default defineConfig({
  plugins: [vue()],
  base: '/ai/',
  build: {
    outDir: 'docs',
    emptyOutDir: true
  }
})

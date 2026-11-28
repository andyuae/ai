/// <reference types="vite/client" />

/* .vue 单文件组件的类型声明。
   没有它时 `tsc --noEmit` 会报 TS2307: Cannot find module './App.vue'，
   CI 里的类型检查就没法跑。Vite 构建本身不需要它（esbuild 直接处理 .vue），
   但类型检查需要。 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

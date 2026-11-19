import { marked } from 'marked'
import DOMPurify from 'dompurify'

/* AI 回答统一按 GFM 渲染：表格、标题、列表、加粗、代码块、链接都还原成网页样子。
   breaks:true —— 模型常把一句话用单个换行断开，按聊天习惯应当换行而不是并成一段。 */
marked.setOptions({ gfm: true, breaks: true })

const CACHE_MAX = 120
const cache = new Map<string, string>()

function escHtml(s: string) {
  return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string))
}

/** Markdown 文本 → 可安全 v-html 的 HTML。解析失败时退回纯文本，绝不把原始标签注入页面。 */
export function mdToHtml(src: string): string {
  const text = String(src || '')
  if (!text) return ''
  const hit = cache.get(text)
  if (hit !== undefined) return hit

  let html = ''
  try {
    html = marked.parse(text, { async: false }) as string
  } catch {
    html = escHtml(text).replace(/\n/g, '<br>')
  }
  /* AI 输出属于不可信内容：先净化，再统一给外链加新窗口打开 */
  html = DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, ADD_ATTR: ['target', 'rel'] })
  html = html.replace(/<a\s/gi, '<a target="_blank" rel="noopener noreferrer" ')
  /* 表格套一层滚动容器：窄列里保持可读的列宽，而不是把文字压成一字一行 */
  html = html.replace(/<table>/gi, '<div class="md-table-wrap"><table>').replace(/<\/table>/gi, '</table></div>')

  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(text, html)
  return html
}

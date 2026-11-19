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

/* ================= 兼容中文的加粗修复 =================
   标准 Markdown 要求 ** 紧贴正文才能识别。中文场景下模型常写出
   `**“自然排名”**`（星号紧跟全角引号）或 `** “流量占比” **`（星号内侧带空格），
   按 CommonMark 规则都不构成强调，页面上就会露出 `**` 原文。
   这一步在交给 marked 之前把它们统一成 <strong>。 */
function repairEmphasis(src: string): string {
  /* 代码块 / 行内代码里的星号不能动，先占位保护 */
  const stash: string[] = []
  let text = src.replace(/```[\s\S]*?```|`[^`\n]*`/g, m => {
    stash.push(m)
    return `\u0000${stash.length - 1}\u0000`
  })

  /* 三星号（加粗 + 斜体）先处理，否则会被下面的双星号规则切歪 */
  text = text.replace(/\*\*\*([^\n]+?)\*\*\*/g, (whole, inner: string) => {
    const body = inner.trim()
    if (!body) return whole
    return `<strong><em>${body.replace(/</g, '&lt;')}</em></strong>`
  })

  /* 成对的 **：内侧允许空格与全角引号，内容不跨行 */
  text = text.replace(/\*\*([^\n]+?)\*\*/g, (whole, inner: string) => {
    const body = inner.trim()
    if (!body || /^[*_\s]+$/.test(body)) return whole
    /* 内容里还留着半个星号说明是并排的符号，不当作加粗 */
    if (/\*\*\*/.test(body)) return whole
    return `<strong>${body.replace(/</g, '&lt;')}</strong>`
  })

  /* 剩下没配对的 ** —— 中文句子里的残留只会显示成乱码，直接抹掉；
     但整行都是符号（分隔线之类）时保持原样 */
  text = text.replace(/^.*$/gm, line => {
    if (!/\*\*/.test(line)) return line
    if (/^[\s*_-]+$/.test(line)) return line
    return /[\u4e00-\u9fff]/.test(line) ? line.replace(/\*\*/g, '') : line
  })

  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[+i])
}

/* ================= 表格装饰：窄列里转成「键 - 值」卡片 =================
   五列并排时每列只有 300 多像素，真正的表格必然显示不全。
   这里把表头文字写进每个单元格的 data-label，配合 CSS 在窄容器里把每行
   摊成一张小卡片（放大查看时仍是正常表格）。 */
function decorateTables(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(`<div id="__root">${html}</div>`, 'text/html')
    const root = doc.getElementById('__root')
    if (!root) return html

    root.querySelectorAll('table').forEach(table => {
      const headCells = Array.from(table.querySelectorAll('thead th'))
      const firstRow = table.querySelector('tbody tr') || table.querySelector('tr')
      const headerTexts = headCells.length
        ? headCells.map(th => (th.textContent || '').trim())
        : Array.from(firstRow?.children || []).map(c => (c.textContent || '').trim())

      table.querySelectorAll('tbody tr, tr').forEach(tr => {
        Array.from(tr.children).forEach((cell, i) => {
          if (cell.tagName !== 'TD') return
          const label = headerTexts[i] || ''
          if (label) cell.setAttribute('data-label', label)
          if (i === 0) cell.setAttribute('data-rowhead', '1')
        })
      })

      const wrap = doc.createElement('div')
      wrap.className = 'md-table-wrap'
      table.parentNode?.insertBefore(wrap, table)
      wrap.appendChild(table)
    })

    return root.innerHTML
  } catch {
    return html
  }
}

/** Markdown 文本 → 可安全 v-html 的 HTML。解析失败时退回纯文本，绝不把原始标签注入页面。 */
export function mdToHtml(src: string): string {
  const text = String(src || '')
  if (!text) return ''
  const hit = cache.get(text)
  if (hit !== undefined) return hit

  let html = ''
  try {
    html = marked.parse(repairEmphasis(text), { async: false }) as string
  } catch {
    html = escHtml(text).replace(/\n/g, '<br>')
  }
  /* AI 输出属于不可信内容：先净化，再统一给外链加新窗口打开 */
  html = DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, ADD_ATTR: ['target', 'rel'] })
  html = html.replace(/<a\s/gi, '<a target="_blank" rel="noopener noreferrer" ')
  html = decorateTables(html)

  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(text, html)
  return html
}

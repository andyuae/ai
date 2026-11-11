import type { Attachment } from './types'

export const ATT_IMAGE_MAX = 4 * 1024 * 1024
export const ATT_TEXT_MAX = 60000
export const ATT_COUNT_MAX = 6

export function isImageFile(f: File) { return /^image\/(png|jpe?g|gif|webp|bmp)$/i.test(f.type) }
export function isTextLikeFile(f: File) {
  if (f.type && f.type.startsWith('text/')) return true
  return /\.(txt|md|markdown|csv|tsv|json|xml|yaml|yml|log|js|ts|jsx|tsx|py|java|c|cpp|h|cs|go|rs|rb|php|html|htm|css|sql|sh|bat|ini|conf|toml|env)$/i.test(f.name)
}

function readAsDataURL(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(r.result as string)
    r.onerror = () => rej(new Error('读取失败'))
    r.readAsDataURL(f)
  })
}
function readAsText(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(r.result as string)
    r.onerror = () => rej(new Error('读取失败'))
    r.readAsText(f)
  })
}

/* 懒加载 pdf.js（仅附 PDF 时才下载） */
let pdfjsReady: Promise<any> | null = null
function loadPdfJs(): Promise<any> {
  if (pdfjsReady) return pdfjsReady
  pdfjsReady = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
    s.onload = () => {
      ;(window as any).pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
      resolve((window as any).pdfjsLib)
    }
    s.onerror = () => reject(new Error('PDF 解析组件加载失败（网络问题）'))
    document.head.appendChild(s)
  })
  return pdfjsReady
}

/* 懒加载 mammoth.js（解析 Word .docx） */
let mammothReady: Promise<any> | null = null
function loadMammoth(): Promise<any> {
  if (mammothReady) return mammothReady
  mammothReady = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js'
    s.onload = () => resolve((window as any).mammoth)
    s.onerror = () => reject(new Error('Word 解析组件加载失败（网络问题）'))
    document.head.appendChild(s)
  })
  return mammothReady
}

async function extractPdfText(f: File): Promise<string> {
  const lib = await loadPdfJs()
  const buf = await f.arrayBuffer()
  const pdf = await lib.getDocument({ data: buf }).promise
  let out = ''
  const pages = Math.min(pdf.numPages, 50)
  for (let i = 1; i <= pages; i++) {
    const page = await pdf.getPage(i)
    const tc = await page.getTextContent()
    out += tc.items.map((it: any) => it.str).join(' ') + '\n'
    if (out.length > ATT_TEXT_MAX) break
  }
  return out.slice(0, ATT_TEXT_MAX)
}

/** 处理一个文件，成功则返回附件对象；失败抛错（调用方提示） */
export async function processFile(f: File): Promise<Attachment> {
  if (isImageFile(f)) {
    if (f.size > ATT_IMAGE_MAX) throw new Error(`图片 ${f.name} 超过 4MB，请压缩后再试`)
    return { kind: 'image', name: f.name, dataUrl: await readAsDataURL(f) }
  }
  if (/\.pdf$/i.test(f.name)) {
    const text = (await extractPdfText(f)).trim()
    if (!text) throw new Error(`PDF ${f.name} 中没有可提取的文字（可能是扫描件，暂不支持）`)
    return { kind: 'file', name: f.name, text }
  }
  if (/\.docx$/i.test(f.name)) {
    const mammoth = await loadMammoth()
    const { value } = await mammoth.extractRawText({ arrayBuffer: await f.arrayBuffer() })
    return { kind: 'file', name: f.name, text: String(value || '').slice(0, ATT_TEXT_MAX) }
  }
  if (isTextLikeFile(f)) {
    return { kind: 'file', name: f.name, text: (await readAsText(f)).slice(0, ATT_TEXT_MAX) }
  }
  throw new Error(`暂不支持文件类型：${f.name}\n支持：图片、PDF、Word(.docx)、文本和代码文件`)
}

/** 附件以标记形式随消息存入数据库 */
export function serializeAtts(text: string, atts: Attachment[]): string {
  const marks = (atts || []).map(a =>
    `[[附件:${a.kind === 'image' ? '图片' : '文件'}|${a.name}|${a.kind === 'image' ? a.dataUrl : a.text}]]`)
  return [text || '', ...marks].filter(Boolean).join('\n')
}

export function parseAtts(content: string): { text: string; atts: Attachment[] } {
  const atts: Attachment[] = []
  const text = String(content || '')
    .replace(/\[\[附件:(图片|文件)\|([^\]|]*)\|([\s\S]*?)\]\]/g, (_m, kind, name, payload) => {
      atts.push(kind === '图片'
        ? { kind: 'image', name, dataUrl: payload }
        : { kind: 'file', name, text: payload })
      return ''
    })
    .trim()
  return { text, atts }
}

/** 给 AI 看的历史消息：附件只留名字提示，不带大数据 */
export function attSummary(content: string): string {
  const { text, atts } = parseAtts(content)
  const notes = atts.map(a => (a.kind === 'image' ? `[图片：${a.name}]` : `[附件文件：${a.name}]`)).join(' ')
  return [text, notes].filter(Boolean).join(' ')
}

export function esc(s: string): string {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 用户消息气泡 HTML（含附件渲染），配合 v-html 使用 */
export function userBubbleHtml(content: string): string {
  const { text, atts } = parseAtts(content)
  let html = text ? esc(text) : ''
  atts.forEach(a => {
    if (a.kind === 'image') {
      html += `<a href="${esc(a.dataUrl!)}" target="_blank"><img class="att-thumb" src="${esc(a.dataUrl!)}" alt="${esc(a.name)}"></a>`
    } else {
      html += `<span class="att-file">📄 ${esc(a.name)}</span>`
    }
  })
  return html || '（空消息）'
}

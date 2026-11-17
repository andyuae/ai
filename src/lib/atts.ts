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

/* 懒加载 SheetJS（解析 Excel .xlsx / .xls） */
let xlsxReady: Promise<any> | null = null
function loadXlsx(): Promise<any> {
  if (xlsxReady) return xlsxReady
  xlsxReady = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
    s.onload = () => resolve((window as any).XLSX)
    s.onerror = () => reject(new Error('Excel 解析组件加载失败（网络问题）'))
    document.head.appendChild(s)
  })
  return xlsxReady
}

/* 懒加载 JSZip（解析 PowerPoint .pptx） */
let jszipReady: Promise<any> | null = null
function loadJSZip(): Promise<any> {
  if (jszipReady) return jszipReady
  jszipReady = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'
    s.onload = () => resolve((window as any).JSZip)
    s.onerror = () => reject(new Error('PPT 解析组件加载失败（网络问题）'))
    document.head.appendChild(s)
  })
  return jszipReady
}

/** Word 的 HTML 结果转纯文本：保留段落换行与表格的制表符分隔 */
export function htmlToText(html: string): string {
  return String(html || '')
    /* 表格单元格先拍平成一行，避免单元格内的段落把一格拆成两行 */
    .replace(/<t([dh])[^>]*>([\s\S]*?)<\/t\1>/gi, (_m, _k, inner) =>
      '\t' + String(inner).replace(/<\/(p|div)>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
    .replace(/<\/(p|div|h[1-6]|li|tr|table|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '· ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/^\t+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Excel：每个工作表转成 CSV 文本（限制行数与总长度，避免撑爆上下文） */
async function extractSheet(f: File): Promise<string> {
  const XLSX = await loadXlsx()
  const wb = XLSX.read(new Uint8Array(await f.arrayBuffer()), { type: 'array' })
  const names: string[] = (wb.SheetNames || []).slice(0, 12)
  const parts: string[] = []
  for (const name of names) {
    const ws = wb.Sheets[name]
    if (!ws) continue
    const ref = ws['!ref'] || ''
    let csv = String(XLSX.utils.sheet_to_csv(ws, { blankrows: false }) || '')
    const rows = csv.split('\n')
    if (rows.length > 400) csv = rows.slice(0, 400).join('\n') + `\n…（该表其余 ${rows.length - 400} 行已省略）`
    parts.push(`【工作表：${name}${ref ? '，范围 ' + ref : ''}】\n${csv}`)
    if (parts.join('\n').length > ATT_TEXT_MAX) break
  }
  return parts.join('\n\n').slice(0, ATT_TEXT_MAX)
}

/** PPT：按页提取文本框里的文字 */
async function extractPptx(f: File): Promise<string> {
  const JSZip = await loadJSZip()
  const zip = await JSZip.loadAsync(await f.arrayBuffer())
  const slideNo = (n: string) => parseInt((n.match(/(\d+)\.xml$/) || [])[1] || '0', 10)
  const names = Object.keys(zip.files)
    .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideNo(a) - slideNo(b))
  const parts: string[] = []
  for (let i = 0; i < names.length && i < 80; i++) {
    const xml = await zip.files[names[i]].async('string')
    const texts = [...String(xml).matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
      .map(m => m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim())
      .filter(Boolean)
    if (!texts.length) continue
    parts.push(`【第 ${slideNo(names[i])} 页】\n${texts.join('\n')}`)
    if (parts.join('\n').length > ATT_TEXT_MAX) break
  }
  return parts.join('\n\n').slice(0, ATT_TEXT_MAX)
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
  const out = (text: string, tip: string): Attachment => {
    const t = (text || '').trim()
    if (!t) throw new Error(`${f.name} 里没有可提取的文字（${tip}）`)
    return { kind: 'file', name: f.name, text: t.slice(0, ATT_TEXT_MAX) }
  }

  if (isImageFile(f)) {
    if (f.size > ATT_IMAGE_MAX) throw new Error(`图片 ${f.name} 超过 4MB，请压缩后再试`)
    return { kind: 'image', name: f.name, dataUrl: await readAsDataURL(f) }
  }

  /* Word 新版（.docx）：转 HTML 再取文本，表格/列表/标题都能保留 */
  if (/\.docx$/i.test(f.name)) {
    const mammoth = await loadMammoth()
    const buf = await f.arrayBuffer()
    let html = ''
    try { html = String((await mammoth.convertToHtml({ arrayBuffer: buf })).value || '') } catch { /* 降级到纯文本 */ }
    if (html.trim()) return out(htmlToText(html), '文档可能是空的')
    const raw = await mammoth.extractRawText({ arrayBuffer: buf })
    return out(String(raw.value || ''), '文档可能是空的')
  }

  /* Excel（.xlsx / .xlsm / .xls）：每个工作表转 CSV */
  if (/\.(xlsx|xlsm|xls)$/i.test(f.name)) {
    return out(await extractSheet(f), '表格可能是空的，或文件已加密')
  }

  /* PowerPoint 新版（.pptx）：逐页取文字 */
  if (/\.pptx$/i.test(f.name)) {
    return out(await extractPptx(f), 'PPT 可能是空的，或内容全是图片')
  }

  /* PDF：抽取文字层 */
  if (/\.pdf$/i.test(f.name)) {
    return out(await extractPdfText(f), '可能是扫描件，请把页面截图当图片发送')
  }

  /* 旧版二进制格式，浏览器里无法可靠解析 */
  if (/\.(doc|ppt)$/i.test(f.name)) {
    throw new Error(`${f.name} 是旧版 Office 格式，请在 Office/WPS 里「另存为」.docx / .pptx 后再上传`)
  }

  if (isTextLikeFile(f)) {
    return out(await readAsText(f), '文件是空的')
  }

  throw new Error(`暂不支持文件类型：${f.name}\n支持：图片、Word(.docx)、Excel(.xlsx/.xls)、PPT(.pptx)、PDF、文本与代码文件`)
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

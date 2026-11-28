/** 相对路径工具：所有对外链接都由「当前地址」推导，不写死任何域名或子目录。
 *  这样整站文件夹复制到任意空间（根目录 / 子目录 / 任意域名）都不用改代码。 */

/** 当前站点的路径部分，保证以 / 结尾：
 *    /            → /
 *    /ai/         → /ai/
 *    /ai          → /ai/          （访问时没带尾斜杠）
 *    /ai/index.html → /ai/
 *    /a/b/        → /a/b/
 */
export function sitePath(): string {
  const p = location.pathname
  if (p.endsWith('/')) return p
  const cut = p.lastIndexOf('/')
  const last = p.slice(cut + 1)
  return last.includes('.') ? p.slice(0, cut + 1) : p + '/'
}

/** 站点根地址（含协议域名），可选附带查询串，用于分享链接等 */
export function siteUrl(query = ''): string {
  const q = query.replace(/^\?/, '')
  return location.origin + sitePath() + (q ? '?' + q : '')
}

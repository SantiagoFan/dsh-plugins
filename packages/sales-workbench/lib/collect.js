/**
 * 数据采集器：抓取与解析。
 *
 * 四种渠道共用一套「抓 → 解析 → 归一化」流程：
 *  - rss     RSS 2.0 / Atom（无第三方依赖，正则取 item/entry）
 *  - json    JSON 接口（自动找数组；字段名可配，也可留空按常见命名猜）
 *  - html    网页列表（取 <a>，可用 linkPattern 只保留命中链接）
 *  - search  网页搜索（走 Host 的 ctx.web.search，用关键词查最新结果）
 *
 * 抓取优先用 Host 的 ctx.web.fetch（与 agent 的 web_fetch 同一个出口，带代理与超时），
 * 没有该服务时退回 Node 原生 fetch。两者都做 charset 识别，GBK 站点不会变乱码。
 */

const USER_AGENT = 'Mozilla/5.0 (compatible; DSH-DataCollector/1.0; +https://deepseek.com)'
const DEFAULT_TIMEOUT_MS = 15000

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…', mdash: '—', ndash: '–', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’' }

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** 数字实体转字符；超出 Unicode 范围时保留原样。 */
function safeChar(code) {
  if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

export function decodeEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => safeChar(Number.parseInt(hex, 16)) || match)
    .replace(/&#(\d+);/g, (match, num) => safeChar(Number.parseInt(num, 10)) || match)
    .replace(/&([a-z]+);/gi, (match, name) => {
      const found = ENTITIES[name.toLowerCase()]
      return found === undefined ? match : found
    })
}

/** 去标签、去脚本样式、合并空白。 */
export function stripTags(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

function unwrapCdata(value) {
  const text = String(value || '')
  const match = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(text)
  return match ? match[1] : text
}

/** 取 XML 里某个标签的文本（容忍属性、CDATA、自闭合）。 */
function tagText(block, tag) {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i')
  const match = pattern.exec(block)
  return match ? unwrapCdata(match[1]).trim() : ''
}

function absolutize(href, base) {
  const text = String(href || '').trim()
  if (!text) return ''
  try {
    return base ? new URL(text, base).toString() : new URL(text).toString()
  } catch {
    return /^https?:\/\//i.test(text) ? text : ''
  }
}

/** 摘要截断到指定长度，尽量落在句子边界。 */
function clip(text, max = 300) {
  const value = String(text || '').trim()
  if (value.length <= max) return value
  return `${value.slice(0, max).replace(/[，,、\s]+$/, '')}…`
}

// ------------------------------------------------------------------ 网络
function withTimeout(signal, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`请求超时（${timeoutMs}ms）`)), timeoutMs)
  timer.unref?.()
  const onAbort = () => controller.abort(signal.reason)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    },
  }
}

function charsetOf(contentType, head) {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(String(contentType || ''))
  if (fromHeader) return fromHeader[1].toLowerCase()
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(String(head || ''))
  if (fromMeta) return fromMeta[1].toLowerCase()
  return 'utf-8'
}

function decodeBody(buffer, contentType) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const head = Buffer.from(bytes.slice(0, 2048)).toString('latin1')
  const charset = charsetOf(contentType, head)
  for (const candidate of [charset, 'utf-8', 'gb18030']) {
    try {
      return new TextDecoder(candidate, { fatal: false }).decode(bytes)
    } catch {
      // 该编码不被当前运行时支持，换下一个
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

async function rawFetch(url, { signal, timeoutMs }) {
  const guard = withTimeout(signal, timeoutMs)
  try {
    const response = await globalThis.fetch(url, {
      signal: guard.signal,
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8' },
    })
    const bytes = new Uint8Array(await response.arrayBuffer())
    return { status: response.status, text: decodeBody(bytes, response.headers.get('content-type')), truncated: false }
  } finally {
    guard.done()
  }
}

/**
 * 抓一个 URL 的文本内容。
 * 优先 ctx.web.fetch（与 agent 的 web_fetch 同一条链路），不可用退回原生 fetch。
 */
export async function fetchText(ctx, url, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS
  const web = typeof ctx?.get === 'function' ? ctx.get('web') : undefined
  if (web && typeof web.fetch === 'function') {
    const guard = withTimeout(options.signal, timeoutMs)
    try {
      const result = await web.fetch({ url }, guard.signal)
      const status = Number(result && result.statusCode)
      if (!Number.isFinite(status)) throw new Error('抓取没有返回状态码')
      if (status >= 400) throw new Error(`HTTP ${status}`)
      const body = result && result.body && typeof result.body.content === 'string' ? result.body.content : ''
      return { status, text: body, truncated: Boolean(result.truncated) }
    } catch (error) {
      // ctx.web 的 provider 可能没配好（例如没有 fetch provider），退回原生 fetch 再试一次
      if (!options.disableFallback) {
        try {
          return await rawFetch(url, { signal: options.signal, timeoutMs })
        } catch {
          throw error
        }
      }
      throw error
    } finally {
      guard.done()
    }
  }
  return rawFetch(url, { signal: options.signal, timeoutMs })
}

// ------------------------------------------------------------------ 解析
function normalizeCandidate(item, baseUrl) {
  const title = clip(stripTags(item.title), 200)
  // 名录类条目可能没有标题（只有公司名），用公司名兜底
  const fallbackTitle = clip(stripTags(item.company), 200)
  if (!title && !fallbackTitle) return null
  let url = String(item.url || '').trim()
  if (url) url = absolutize(url, baseUrl)
  const summary = clip(stripTags(item.summary), 400)
  const publishedAt = String(item.publishedAt || '').trim()
  return {
    title: title || fallbackTitle,
    url: url && url !== baseUrl ? url : '',
    summary,
    publishedAt,
    company: String(item.company || '').trim(),
    contact: String(item.contact || '').trim(),
    phone: String(item.phone || '').trim(),
    region: String(item.region || '').trim(),
  }
}

function parseRss(text, channel) {
  const blocks = [...String(text || '').matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
  const items = []
  for (const match of blocks) {
    const block = match[2]
    const title = tagText(block, 'title')
    const linkTag = tagText(block, 'link')
    const linkAttr = /<link\b[^>]*href\s*=\s*["']([^"']+)["']/i.exec(block)
    const link = linkTag || (linkAttr ? linkAttr[1] : '') || tagText(block, 'guid')
    const date =
      tagText(block, 'pubDate') || tagText(block, 'published') || tagText(block, 'updated') || tagText(block, 'dc:date')
    const summary =
      tagText(block, 'description') || tagText(block, 'summary') || tagText(block, 'content:encoded') || tagText(block, 'content')
    items.push({ title, url: link, summary, publishedAt: date })
  }
  if (items.length === 0) throw new Error('没有解析到 RSS/Atom 条目，确认链接是 feed 地址')
  return items
}

function pickPath(root, path) {
  if (!path) return undefined
  let current = root
  for (const key of String(path).split('.').map((part) => part.trim()).filter(Boolean)) {
    if (current === null || current === undefined) return undefined
    if (Array.isArray(current)) {
      if (/^\d+$/.test(key)) current = current[Number(key)]
      else return undefined
    } else if (typeof current === 'object') {
      current = current[key]
    } else {
      return undefined
    }
  }
  return current
}

const ARRAY_KEYS = ['items', 'list', 'data', 'results', 'result', 'rows', 'articles', 'news', 'records', 'posts', 'content']

function findArray(root, depth = 0) {
  if (Array.isArray(root)) return root
  if (!isObject(root) || depth > 3) return undefined
  for (const key of ARRAY_KEYS) {
    if (Array.isArray(root[key])) return root[key]
  }
  for (const value of Object.values(root)) {
    if (Array.isArray(value) && value.some((entry) => isObject(entry))) return value
  }
  for (const value of Object.values(root)) {
    const found = findArray(value, depth + 1)
    if (found) return found
  }
  return undefined
}

function readField(entry, configured, candidates) {
  const keys = configured ? [configured] : candidates
  for (const key of keys) {
    if (entry[key] !== undefined && entry[key] !== null && entry[key] !== '') return entry[key]
  }
  const lower = new Map(Object.keys(entry).map((key) => [key.toLowerCase(), key]))
  for (const key of keys) {
    const real = lower.get(String(key).toLowerCase())
    if (real !== undefined && entry[real] !== undefined && entry[real] !== null && entry[real] !== '') return entry[real]
  }
  return undefined
}

function scalar(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value) && value.every((item) => typeof item === 'string' || typeof item === 'number')) return value.join(' ')
  return ''
}

/** 名录类 API 的字段映射结果：公司/联系人/电话/地区直接给，不走启发式。 */
function mapLeadFields(entry, channel) {
  const pick = (field, keys) => scalar(readField(entry, field, keys))
  return {
    company: pick(channel.fieldCompany, ['orgName', 'companyName', 'company', 'name', 'org', 'unit']),
    contact: pick(channel.fieldContact, ['contactPerson', 'contact', 'person', 'principal', 'linkman']),
    phone: pick(channel.fieldPhone, ['contactPhone', 'phone', 'telephone', 'mobile', 'tel']),
    region: pick(channel.fieldRegion, ['provinceCityArea', 'address', 'region', 'area', 'city']),
  }
}

/** 列表接口只给 ID 时，用模板拼出详情链接：{sourceDataKey} → 值。 */
function fillTemplate(template, entry) {
  const text = String(template || '')
  if (!text) return ''
  return text.replace(/\{([\w.-]+)\}/g, (_, key) => scalar(readField(entry, key, [key])))
}

function parseJson(text, channel) {
  let root
  try {
    root = JSON.parse(String(text || ''))
  } catch {
    throw new Error('返回内容不是合法 JSON')
  }
  const container = pickPath(root, channel.itemPath) ?? root
  const rows = findArray(container)
  if (!Array.isArray(rows)) throw new Error('JSON 里没有找到数组；可填「数组路径」指定位置')
  return rows
    .filter((entry) => isObject(entry))
    .slice(0, 400)
    .map((entry) => {
      const leadFields = mapLeadFields(entry, channel)
      const rawLink = scalar(readField(entry, channel.fieldLink, ['url', 'link', 'href', 'sourceUrl', 'detailUrl', 'webUrl']))
      return {
        // 接口常把关键词高亮成 <span>，标题里要剥掉标签
        title: stripTags(scalar(readField(entry, channel.fieldTitle, ['title', 'name', 'headline', 'subject', 'docTitle', 'titleText']))),
        url: rawLink || fillTemplate(channel.linkTemplate, entry),
        summary: stripTags(
          scalar(readField(entry, channel.fieldSummary, ['summary', 'description', 'desc', 'abstract', 'digest', 'snippet', 'content'])),
        ),
        publishedAt: scalar(
          readField(entry, channel.fieldDate, ['publishedAt', 'pubDate', 'publishTime', 'publishDate', 'date', 'time', 'createTime', 'updateTime']),
        ),
        company: leadFields.company,
        contact: leadFields.contact,
        phone: leadFields.phone,
        region: leadFields.region,
      }
    })
}

const NOISE_TITLES = new Set(['首页', '上一页', '下一页', '末尾', '更多', '查看更多', '登录', '注册', '设为首页', '加入收藏', '返回', '返回顶部', 'English'])

/** 列表页的链接文字常把日期缀在末尾（「……的通知 2026-11-18」），把它拆到 publishedAt。 */
const TRAILING_DATE = /[\s　]*((?:19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)[\s　]*$/

function splitTrailingDate(title) {
  const text = String(title || '').trim()
  const match = TRAILING_DATE.exec(text)
  if (!match) return { title: text, publishedAt: '' }
  const rest = text.slice(0, match.index).trim()
  if (rest.length < 3) return { title: text, publishedAt: '' }
  return { title: rest, publishedAt: match[1].trim() }
}

function parseHtml(text, channel) {
  const html = String(text || '')
  let pattern
  if (channel.linkPattern) {
    try {
      pattern = new RegExp(channel.linkPattern, 'i')
    } catch {
      throw new Error('链接过滤正则不合法')
    }
  }
  const items = []
  const seen = new Set()
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = match[1] || ''
    const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs)
    const rawHref = hrefMatch ? hrefMatch[1] || hrefMatch[2] || hrefMatch[3] || '' : ''
    const href = String(rawHref).trim()
    if (!href || /^(javascript:|mailto:|tel:|#)/i.test(href)) continue
    if (channel.linkPattern && pattern && !pattern.test(href)) continue
    const url = absolutize(href, channel.url)
    if (!url || !/^https?:/i.test(url)) continue
    const rawTitle = stripTags(match[2])
    if (!rawTitle || rawTitle.length < 3 || NOISE_TITLES.has(rawTitle)) continue
    if (seen.has(url)) continue
    seen.add(url)
    const { title, publishedAt } = splitTrailingDate(rawTitle)
    items.push({ title, url, summary: '', publishedAt })
    if (items.length >= 400) break
  }
  return items
}

async function parseSearch(ctx, channel, topic, options) {
  const web = typeof ctx?.get === 'function' ? ctx.get('web') : undefined
  if (!web || typeof web.search !== 'function') throw new Error('Host 没有可用的搜索服务（ctx.web.search）')
  const query = String(channel.query || (topic && topic.keywords ? topic.keywords.join(' ') : '')).trim()
  if (!query) throw new Error('搜索渠道需要填查询词，或在主题里填关键词')
  const result = await web.search({ query, maxResults: Math.max(1, Math.min(20, channel.limit || 10)) }, options.signal)
  const sources = Array.isArray(result && result.sources) ? result.sources : []
  return sources.map((source) => ({
    title: source.title || source.url || query,
    url: source.url || '',
    summary: source.snippet || source.summary || '',
    publishedAt: source.publishedAt || '',
  }))
}

/**
 * 抓取并解析一个渠道。
 * @returns {Promise<{ items: Array<object>, note: string }>}
 */
export async function fetchChannelItems(ctx, channel, options = {}) {
  const limit = Math.max(1, Math.min(200, Number(channel.limit) || 30))
  if (channel.type === 'search') {
    const items = (await parseSearch(ctx, channel, options.topic, options)).slice(0, limit)
    return { items: items.map((item) => normalizeCandidate(item, channel.url)).filter(Boolean), note: '搜索' }
  }
  const rawUrl = String(channel.url || '').trim()
  if (!rawUrl) throw new Error('渠道没有填 URL')
  if (!/^https?:\/\//i.test(rawUrl)) throw new Error('URL 需要以 http:// 或 https:// 开头')
  // 接口类渠道支持把查询词插进 URL：noticeName={query}
  const queryText = String(channel.query || (options.topic && options.topic.keywords ? options.topic.keywords.join(' ') : '')).trim()
  const url = rawUrl.replace(/\{query\}/gi, encodeURIComponent(queryText))
  const response = await fetchText(ctx, url, { signal: options.signal, timeoutMs: options.timeoutMs })
  let raw
  if (channel.type === 'rss') raw = parseRss(response.text, channel)
  else if (channel.type === 'json') raw = parseJson(response.text, channel)
  else if (channel.type === 'html') raw = parseHtml(response.text, channel)
  else throw new Error(`未知的渠道类型：${channel.type}`)
  const items = raw.map((item) => normalizeCandidate(item, url)).filter(Boolean).slice(0, limit)
  if (items.length === 0) throw new Error('页面能打开，但没有解析到条目（可用链接过滤正则缩小范围）')
  return { items, note: response.truncated ? '内容被截断，已只取前面部分' : '' }
}

/** 主题关键词过滤：主题没填关键词时全部保留。 */
export function matchTopic(item, topic) {
  const keywords = Array.isArray(topic && topic.keywords) ? topic.keywords.filter(Boolean) : []
  if (keywords.length === 0) return true
  const haystack = `${item.title || ''} ${item.summary || ''}`.toLowerCase()
  return keywords.some((keyword) => haystack.includes(String(keyword).toLowerCase()))
}

/** 给面板「测试渠道」用：解析结果 + 前几条样例。 */
export function describeSamples(items, count = 3) {
  return items.slice(0, count).map((item) => ({ title: item.title, url: item.url, publishedAt: item.publishedAt }))
}

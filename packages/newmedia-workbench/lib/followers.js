/**
 * 粉丝量采集器。
 *
 * 设计原则：
 *  - 每个平台一个 provider，明确声明「能不能自动取、需要什么凭证」；
 *  - 只从用户填写的 uid / homepage 里**解析出平台内部 ID**，绝不直接请求用户填的任意 URL；
 *  - 请求地址必须是平台域名白名单里的主机，Cookie 只发给对应平台；
 *  - 拿不到就明确失败（needs_cookie / unsupported / network_error），绝不猜测数字。
 *
 * 已验证的事实（见 README「粉丝量自动获取」）：
 *  - B站：公开接口，无需任何凭证；
 *  - 抖音 / 小红书 / 快手 / TikTok：需要浏览器登录后复制的 Cookie，且平台可能随时调整风控；
 *  - YouTube：配置 Data API Key 最稳，否则只能尝试页面解析；
 *  - 视频号 / 公众号：没有公开接口，只能手动填写。
 */
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'

import { DEFAULT_TIMEOUT_MS } from './settings.js'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const MAX_BODY_BYTES = 4 * 1024 * 1024
const SYNC_CONCURRENCY = 3

export class FollowersError extends Error {
  constructor(code, message, hint) {
    super(message)
    this.name = 'FollowersError'
    this.code = code
    this.hint = hint || ''
  }
}

// ------------------------------------------------------------------ 平台能力
/**
 * auto 取值：
 *  - 'free'   免配置即可自动获取；
 *  - 'cookie' 需要该平台的浏览器 Cookie；
 *  - 'apiKey' 需要官方 API Key（YouTube）；
 *  - 'manual' 暂无公开接口，只能手动填写。
 */
const PLATFORM_META = {
  douyin: {
    label: '抖音',
    autoLabel: '需 Cookie·可能风控',
    auto: 'cookie',
    needs: ['cookie'],
    uidLabel: '抖音号 / sec_uid',
    note: '抖音网页接口有签名风控（a_bogus/msToken），即使配了 Cookie 也常失败；建议手动填写粉丝量，或配置 Cookie 后点一次试试。',
  },
  shipinhao: {
    label: '视频号',
    autoLabel: '仅手动填写',
    auto: 'manual',
    needs: [],
    uidLabel: '视频号 ID',
    note: '视频号没有公开接口，粉丝量请手动填写（可配合微信后台截图自填）。',
  },
  xiaohongshu: {
    label: '小红书',
    autoLabel: '需 Cookie',
    auto: 'cookie',
    needs: ['cookie'],
    uidLabel: '小红书号 / user_id',
    note: '小红书全站登录墙：配置 Cookie（含 a1、web_session）后可能读到粉丝数；失败请手动填写。',
  },
  wechat: {
    label: '公众号',
    autoLabel: '仅手动填写',
    auto: 'manual',
    needs: [],
    uidLabel: '公众号原始 ID / 微信号',
    note: '公众号粉丝数只在后台可见，没有公开接口，请手动填写。',
  },
  bilibili: {
    label: 'B站',
    autoLabel: '免配置自动获取',
    auto: 'free',
    needs: [],
    uidLabel: 'B站 UID（数字）',
    note: '免配置：填数字 UID 或空间页链接即可自动获取粉丝数（公开接口，实测稳定）。',
  },
  kuaishou: {
    label: '快手',
    autoLabel: '免配置·需国内直连',
    auto: 'free',
    needs: [],
    uidLabel: '快手 ID',
    note: '免配置：快手主页 HTML 里自带粉丝数，但要求国内直连出口（走海外代理反而取不到）。',
  },
  youtube: {
    label: 'YouTube',
    autoLabel: '需 API Key 或代理',
    auto: 'apiKey',
    needs: ['apiKey'],
    uidLabel: '频道 ID / @handle',
    note: '推荐配置 YouTube Data API v3 Key（得精确数）；没 Key 时能解析页面缩写值（如 30.7M），但国内直连不可达、需要代理。',
  },
  tiktok: {
    label: 'TikTok',
    autoLabel: '免配置·需代理',
    auto: 'free',
    needs: [],
    uidLabel: 'TikTok 用户名',
    note: '免 Cookie：TikTok 页面里带精确粉丝数，但国内直连不可达，需要在凭证设置里填代理地址。',
  },
  other: {
    label: '其他',
    autoLabel: '仅手动填写',
    auto: 'manual',
    needs: [],
    uidLabel: '账号 ID',
    note: '其他平台暂不支持自动获取，请手动填写粉丝量。',
  },
}

export function capabilityOf(platform) {
  const meta = PLATFORM_META[platform] || PLATFORM_META.other
  return {
    key: platform in PLATFORM_META ? platform : 'other',
    label: meta.label,
    auto: meta.auto,
    needs: meta.needs.slice(),
    uidLabel: meta.uidLabel,
    note: meta.note,
    autoLabel:
      meta.autoLabel ||
      (meta.auto === 'free'
        ? '免配置自动获取'
        : meta.auto === 'cookie'
          ? '需配置 Cookie'
          : meta.auto === 'apiKey'
            ? '需配置 API Key'
            : '仅手动填写'),
  }
}

export function describeCapabilities() {
  return Object.entries(PLATFORM_META).map(([key, meta]) => ({ key, ...capabilityOf(key), ...meta }))
}

// ------------------------------------------------------------------ 计数解析
/** 把 12,345 / "1.2万" / "3.2w" / "1.5亿" 解析成整数；解析不出来返回 null。 */
export function parseCount(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, Math.round(value)) : null
  const raw = String(value).trim().replace(/[,\s，]/g, '')
  if (!raw) return null
  const match = raw.match(/^([\d.]+)(万|w|亿|千|k|m|b)?$/i)
  if (!match) return null
  const num = Number(match[1])
  if (!Number.isFinite(num)) return null
  const unit = String(match[2] || '').toLowerCase()
  const scale = unit === '万' || unit === 'w' ? 1e4 : unit === '亿' ? 1e8 : unit === '千' || unit === 'k' ? 1e3 : unit === 'm' ? 1e6 : unit === 'b' ? 1e9 : 1
  return Math.max(0, Math.round(num * scale))
}

/** 把数字格式化成中文习惯的展示值：1.2万 / 3亿 / 999。 */
export function formatCount(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return ''
  if (num >= 1e8) return `${trimZero((num / 1e8).toFixed(1))}亿`
  if (num >= 1e4) return `${trimZero((num / 1e4).toFixed(1))}万`
  return String(Math.max(0, Math.round(num)))
}

const trimZero = (text) => String(text).replace(/\.0$/, '')

// ------------------------------------------------------------------ 安全白名单
const HOST_ALLOWLIST = {
  bilibili: ['api.bilibili.com', 'space.bilibili.com', 'm.bilibili.com', 'www.bilibili.com', 'bilibili.com'],
  douyin: ['www.douyin.com', 'www.iesdouyin.com', 'iesdouyin.com', 'douyin.com'],
  xiaohongshu: ['www.xiaohongshu.com', 'xiaohongshu.com'],
  kuaishou: ['www.kuaishou.com', 'kuaishou.com'],
  youtube: ['www.googleapis.com', 'www.youtube.com', 'youtube.com', 'm.youtube.com'],
  tiktok: ['www.tiktok.com', 'tiktok.com'],
}

function assertAllowedHost(platform, url) {
  const allowed = HOST_ALLOWLIST[platform]
  if (!allowed) throw new FollowersError('unsupported', `平台 ${platform} 没有配置采集通道`, '')
  let host
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    throw new FollowersError('bad_target', `请求地址不合法：${url}`, '')
  }
  const ok = allowed.some((item) => host === item || host.endsWith(`.${item}`))
  if (!ok) {
    throw new FollowersError('bad_target', `拒绝请求非 ${platform} 平台的域名：${host}`, '这是安全限制：Cookie 只会发给对应平台。')
  }
}

// ------------------------------------------------------------------ HTTP
async function readLimited(res) {
  if (typeof res.text === 'function' && !res.body) return res.text()
  if (!res.body || typeof res.body.getReader !== 'function') return res.text()
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BODY_BYTES) {
      try {
        await reader.cancel()
      } catch {
        // ignore
      }
      throw new FollowersError('response_too_large', '平台返回内容过大，已放弃解析', '')
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function timeoutSignal(timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new FollowersError('timeout', `请求超时（${timeoutMs}ms）`, '平台响应过慢或网络不通；可在凭证设置里调整超时，或稍后重试。')), timeoutMs)
  timer.unref?.()
  return { signal: controller.signal, done: () => clearTimeout(timer) }
}

// ------------------------------------------------------------------ 代理（海外平台）
const agentCache = new Map()

/** 校验代理地址；允许空（不走代理）。 */
export function normalizeProxy(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new FollowersError('bad_proxy', `代理地址不是合法 URL：${raw}`, '格式例如 http://127.0.0.1:6696（必须带 http:// 或 https://）。')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FollowersError('bad_proxy', `代理只支持 http/https：${raw}`, '例如 http://127.0.0.1:6696。')
  }
  return url.toString()
}

/** 通过 HTTP CONNECT 隧道建立 TLS 连接的 Agent（不做任何第三方依赖）。 */
function tunnelAgent(proxyUrl) {
  const key = proxyUrl
  const cached = agentCache.get(key)
  if (cached) return cached
  const proxy = new URL(proxyUrl)
  const proxyTls = proxy.protocol === 'https:'
  const proxyHost = proxy.hostname
  const proxyPort = Number(proxy.port || (proxyTls ? 443 : 80))
  const proxyAuth = proxy.username
    ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}\r\n`
    : ''

  class TunnelAgent extends https.Agent {
    createConnection(options, callback) {
      const targetHost = options.host
      const targetPort = options.port || 443
      const socket = proxyTls ? tls.connect({ host: proxyHost, port: proxyPort, servername: proxyHost }) : net.connect({ host: proxyHost, port: proxyPort })
      let buffer = Buffer.alloc(0)
      let settled = false
      const fail = (error) => {
        if (settled) return
        settled = true
        socket.destroy()
        callback(error)
      }
      socket.once('error', fail)
      socket.on('data', (chunk) => {
        if (settled) return
        buffer = Buffer.concat([buffer, chunk])
        const headerEnd = buffer.indexOf('\r\n\r\n')
        if (headerEnd < 0) return
        const header = buffer.slice(0, headerEnd).toString('latin1')
        if (!/^HTTP\/1\.[01] 200/.test(header)) {
          fail(new FollowersError('proxy_error', `代理拒绝了 CONNECT：${header.split('\r\n')[0]}`, '检查代理是否可用、是否需要鉴权。'))
          return
        }
        settled = true
        socket.removeListener('error', fail)
        const rest = buffer.slice(headerEnd + 4)
        if (rest.length > 0) socket.unshift(rest)
        const tlsSocket = tls.connect({ socket, servername: targetHost })
        tlsSocket.once('secureConnect', () => callback(null, tlsSocket))
        tlsSocket.once('error', (error) => callback(error))
      })
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${proxyAuth}Proxy-Connection: keep-alive\r\n\r\n`)
    }
  }

  const agent = new TunnelAgent({ keepAlive: true, maxSockets: 4, maxCachedSessions: 0 })
  agentCache.set(key, agent)
  return agent
}

/** 经代理发 GET，返回与 fetch 响应形状兼容的对象。 */
function proxiedGet(url, headers, timeoutMs, proxy) {
  const target = new URL(url)
  if (target.protocol !== 'https:') {
    return Promise.reject(new FollowersError('bad_target', `代理模式只支持 https 请求：${url}`, ''))
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }
    const request = https.request(target, { method: 'GET', headers, agent: tunnelAgent(proxy) }, (response) => {
      const chunks = []
      let total = 0
      response.on('data', (chunk) => {
        total += chunk.length
        if (total > MAX_BODY_BYTES) {
          request.destroy()
          finish(new FollowersError('response_too_large', '平台返回内容过大，已放弃解析', ''))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => finish(null, { status: response.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }))
      response.on('error', (error) => finish(error))
    })
    const timer = setTimeout(() => {
      request.destroy()
      finish(new FollowersError('timeout', `请求超时（${timeoutMs}ms）`, '平台响应过慢或代理不通；可在凭证设置里调整超时。'))
    }, timeoutMs)
    request.on('error', (error) => finish(error))
    request.end()
  })
}

/**
 * 发一个 GET 请求，返回文本。
 * - 只允许平台白名单域名；
 * - 3xx 视为「需要登录 / 被风控」，不跟随跳转（避免 Cookie 跨域泄漏）；
 * - Cookie 只来自该平台自己的凭证；
 * - 配了代理时经 HTTP CONNECT 隧道访问（海外平台需要）。
 */
async function httpGet(url, env, options = {}) {
  const platform = env.platform
  assertAllowedHost(platform, url)
  const timeoutMs = Math.max(2000, Number(env.timeoutMs) || DEFAULT_TIMEOUT_MS)
  const headers = {
    'user-agent': UA,
    accept: options.accept || 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
    ...(options.headers || {}),
  }
  if (env.cookie) headers.cookie = env.cookie
  let res
  if (env.proxy) {
    try {
      const proxied = await proxiedGet(url, headers, timeoutMs, env.proxy)
      res = { ok: proxied.status >= 200 && proxied.status < 300, status: proxied.status, headers: new Map(), body: null, text: async () => proxied.text }
    } catch (error) {
      if (error instanceof FollowersError) {
        if (error.code === 'proxy_error') {
          throw new FollowersError('proxy_error', error.message, '检查「凭证设置 → 代理地址」是否可用、是否需要账号密码。')
        }
        throw error
      }
      throw new FollowersError(
        'network_error',
        `经代理 ${env.proxy} 无法连接 ${new URL(url).hostname}（${error && error.message ? error.message : error}）`,
        '检查代理是否在运行、地址是否正确（例如 http://127.0.0.1:6696）。',
      )
    }
  } else {
    const signal = timeoutSignal(timeoutMs)
    try {
      res = await env.fetchImpl(url, { method: 'GET', headers, redirect: 'manual', signal: signal.signal })
    } catch (error) {
      signal.done()
      if (error instanceof FollowersError) throw error
      const aborted = error && (error.name === 'AbortError' || String(error).includes('aborted'))
      throw new FollowersError(
        aborted ? 'timeout' : 'network_error',
        aborted ? `请求超时（${timeoutMs}ms）` : `无法连接 ${new URL(url).hostname}（${error && error.message ? error.message : error}）`,
        aborted ? '平台响应过慢；可稍后重试。' : '检查本机网络是否能访问该平台（海外平台需要在「凭证设置」里配代理）。',
      )
    }
    try {
      return await readResponse(res, env, platform)
    } finally {
      signal.done()
    }
  }
  return await readResponse(res, env, platform)
}

/** 把响应状态翻译成可操作的错误，或读出正文。 */
async function readResponse(res, env, platform) {
  if (res.status >= 300 && res.status < 400) {
    throw new FollowersError(
      env.cookie ? 'blocked' : 'needs_cookie',
      `平台要求登录或验证（HTTP ${res.status}，被重定向）`,
      env.cookie
        ? 'Cookie 可能已过期或被风控：请重新登录该平台、复制最新 Cookie 再试。'
        : `该平台需要登录态：请在「凭证设置」里配置 ${capabilityOf(platform).label} 的 Cookie。`,
    )
  }
  if (res.status === 403 || res.status === 401) {
    throw new FollowersError('blocked', `平台拒绝了请求（HTTP ${res.status}）`, '通常是 Cookie 失效或触发风控；重新登录后更新 Cookie 再试。')
  }
  if (!res.ok) throw new FollowersError('http_error', `平台返回 HTTP ${res.status}`, '确认账号 ID 是否正确；平台接口可能已调整。')
  return await readLimited(res)
}

async function httpJson(url, env, options = {}) {
  const text = await httpGet(url, env, { ...options, accept: 'application/json,text/plain,*/*' })
  try {
    return JSON.parse(text)
  } catch {
    throw new FollowersError('parse', '平台返回的不是 JSON（可能被风控页替换）', '稍后重试；若持续失败，请手动填写粉丝量。')
  }
}

// ------------------------------------------------------------------ HTML 解析工具
/** 从 start 位置（'{' 或 '['）开始截取一段括号配平的 JSON 文本。 */
function sliceBalanced(text, start) {
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') depth += 1
    else if (ch === '}' || ch === ']') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return ''
}

/** 找到 marker 之后的第一个 JSON 对象/数组并解析。 */
function extractJsonAfter(html, marker) {
  const at = html.indexOf(marker)
  if (at < 0) return null
  const rest = html.slice(at + marker.length)
  const brace = rest.search(/[{[]/)
  if (brace < 0) return null
  const raw = sliceBalanced(rest, brace)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** 有的页面把 JSON 做了 URI 编码（如抖音 RENDER_DATA）。 */
function extractUriJsonAfter(html, marker) {
  const at = html.indexOf(marker)
  if (at < 0) return null
  const rest = html.slice(at + marker.length)
  const quote = rest.indexOf('"')
  if (quote < 0) return null
  const end = rest.indexOf('"', quote + 1)
  if (end < 0) return null
  try {
    return JSON.parse(decodeURIComponent(rest.slice(quote + 1, end)))
  } catch {
    return null
  }
}

/** 在解析出来的对象里按字段名找第一个能解析成数字的值。 */
function findByKeys(node, keys, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return null
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findByKeys(item, keys, depth + 1)
      if (found !== null) return found
    }
    return null
  }
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(node, key)) {
      const parsed = parseCount(node[key])
      if (parsed !== null) return parsed
    }
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      const found = findByKeys(value, keys, depth + 1)
      if (found !== null) return found
    }
  }
  return null
}

/** 小红书主页的粉丝数藏在 interactions 数组里：{ name: '粉丝', count: '1.2万' }。 */
function findInteractionCount(interactions, keyword) {
  if (!Array.isArray(interactions)) return null
  for (const item of interactions) {
    if (!item || typeof item !== 'object') continue
    const name = String(item.name || '')
    if (!name || !name.includes(keyword)) continue
    const parsed = parseCount(item.count)
    if (parsed !== null) return parsed
  }
  return null
}

// ------------------------------------------------------------------ 目标解析
const stripAt = (value) => String(value || '').trim().replace(/^@+/, '')

function parseUrlOrNull(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (!/^https?:\/\//i.test(raw)) return null
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

/** 每个平台的「从平台账号里解析出平台内部 ID」规则；解析不出返回 null。 */
const TARGET_RESOLVERS = {
  bilibili(card) {
    for (const raw of [card.uid, card.handle]) {
      const text = String(raw || '').trim()
      if (/^\d+$/.test(text)) return { mid: text }
      const tail = text.match(/(?:^|\D)(\d+)$/)
      if (tail) return { mid: tail[1] }
    }
    const url = parseUrlOrNull(card.homepage)
    if (url && /(^|\.)bilibili\.com$/i.test(url.hostname)) {
      const match = url.pathname.match(/\/(?:space|u)?\/?(\d+)/) || String(url.search).match(/[?&]mid=(\d+)/)
      if (match) return { mid: match[1] }
    }
    return null
  },
  douyin(card) {
    for (const raw of [card.uid, card.handle]) {
      const text = String(raw || '').trim()
      if (/^MS4wLjAB[\w-]+$/.test(text)) return { secUid: text }
    }
    const url = parseUrlOrNull(card.homepage)
    if (url && /(^|\.)douyin\.com$/i.test(url.hostname)) {
      const match = url.pathname.match(/\/user\/([\w-]+)/)
      if (match) return { secUid: match[1] }
    }
    const uniqueId = stripAt(card.uid || card.handle)
    if (uniqueId && /^[\w.-]{2,64}$/.test(uniqueId)) return { uniqueId }
    return null
  },
  xiaohongshu(card) {
    for (const raw of [card.uid, card.handle]) {
      const text = String(raw || '').trim()
      if (/^[0-9a-f]{16,32}$/i.test(text)) return { userId: text }
    }
    const url = parseUrlOrNull(card.homepage)
    const match = (url && url.pathname.match(/\/user\/profile\/([0-9a-zA-Z]+)/)) || String(card.homepage || '').match(/\/user\/profile\/([0-9a-zA-Z]+)/)
    if (match) return { userId: match[1] }
    return null
  },
  kuaishou(card) {
    for (const raw of [card.uid, card.handle]) {
      const text = String(raw || '').trim()
      if (/^[\w-]{4,64}$/.test(text)) return { userId: text }
    }
    const match = String(card.homepage || '').match(/kuaishou\.com\/(?:profile|u)\/([\w-]+)/)
    if (match) return { userId: match[1] }
    return null
  },
  youtube(card) {
    for (const raw of [card.uid, card.handle]) {
      const text = String(raw || '').trim()
      if (/^UC[\w-]{22}$/.test(text)) return { channelId: text }
      if (/^@?[\w.-]{2,40}$/.test(text)) return { handle: stripAt(text) }
    }
    const match = String(card.homepage || '').match(/youtube\.com\/(?:@([\w.-]+)|channel\/(UC[\w-]{22}))/) || String(card.homepage || '').match(/youtube\.com\/c\/([\w.-]+)/)
    if (match) return match[2] ? { channelId: match[2] } : { handle: match[1] }
    return null
  },
  tiktok(card) {
    for (const raw of [card.uid, card.handle]) {
      const text = stripAt(raw)
      if (/^[\w.]{2,30}$/.test(text)) return { username: text }
    }
    const match = String(card.homepage || '').match(/tiktok\.com\/@([\w.]+)/)
    if (match) return { username: match[1] }
    return null
  },
}

// ------------------------------------------------------------------ 各平台采集器
const NOT_LINKED_HINT = (platform) => {
  const capability = capabilityOf(platform)
  return `在面板编辑该账号，填「${capability.uidLabel}」（或主页链接）后重试。`
}

async function bilibiliFetch(target, env) {
  const url = `https://api.bilibili.com/x/relation/stat?vmid=${encodeURIComponent(target.mid)}`
  const json = await httpJson(url, env, { headers: { referer: 'https://space.bilibili.com/' } })
  if (!json || typeof json !== 'object') throw new FollowersError('parse', 'B站返回格式异常', '稍后重试，或手动填写粉丝量。')
  if (json.code !== 0) {
    throw new FollowersError(
      'platform_error',
      `B站返回 code=${json.code}${json.message ? `（${json.message}）` : ''}`,
      json.code === -404 ? '这个 UID 不存在，检查是否填错。' : 'B站偶发风控，稍后重试；或在凭证设置里配置 B站 Cookie。',
    )
  }
  const count = parseCount(json.data && json.data.follower)
  if (count === null) throw new FollowersError('parse', 'B站返回里没有粉丝数字段', '稍后重试，或手动填写粉丝量。')
  return { count, source: 'bilibili:x/relation/stat', extra: { following: json.data.following } }
}

async function douyinFetch(target, env) {
  const attempts = []
  const query = target.secUid ? `sec_uid=${encodeURIComponent(target.secUid)}` : target.uniqueId ? `unique_id=${encodeURIComponent(target.uniqueId)}` : ''
  if (query) {
    try {
      const json = await httpJson(`https://www.iesdouyin.com/web/api/v2/user/info/?${query}`, env)
      const user = json && (json.user_info || json.user || json.data)
      const count = user ? findByKeys(user, ['follower_count', 'followerCount', 'fans_count']) : null
      if (count !== null) return { count, source: 'iesdouyin:user/info' }
      attempts.push('iesdouyin 无粉丝字段')
    } catch (error) {
      attempts.push(`iesdouyin：${error && error.message ? error.message : error}`)
    }
  }
  if (!target.secUid) {
    throw new FollowersError(
      'needs_sec_uid',
      '抖音需要 sec_uid 才能走网页通道（只填抖音号取不到）',
      '从抖音主页链接 https://www.douyin.com/user/MS4wLjAB... 里复制 sec_uid 填到「账号 ID」，并配置抖音 Cookie。',
    )
  }
  if (!env.cookie) {
    throw new FollowersError(
      'needs_cookie',
      `抖音网页接口需要登录态${attempts.length ? `（${attempts.join('；')}）` : ''}`,
      '在「凭证设置」里粘贴抖音 Cookie（浏览器登录 douyin.com 后从开发者工具复制 document.cookie）。',
    )
  }
  const html = await httpGet(`https://www.douyin.com/user/${encodeURIComponent(target.secUid)}`, env)
  const state = extractJsonAfter(html, 'window._SSR_HYDRATED_DATA') || extractUriJsonAfter(html, 'RENDER_DATA') || extractJsonAfter(html, '_SSR_HYDRATED_DATA')
  const count = state ? findByKeys(state, ['followerCount', 'follower_count', 'fansCount']) : null
  if (count === null) {
    const raw = html.match(/"follower_count"\s*:\s*(\d+)/) || html.match(/"followerCount"\s*:\s*(\d+)/)
    if (raw) return { count: Number(raw[1]), source: 'douyin:user-page' }
    throw new FollowersError('parse', '抖音页面里没找到粉丝数字段（Cookie 可能失效或触发验证）', '重新登录抖音并复制最新 Cookie；或手动填写粉丝量。')
  }
  return { count, source: 'douyin:user-page' }
}

async function xiaohongshuFetch(target, env) {
  if (!env.cookie) {
    throw new FollowersError('needs_cookie', '小红书主页需要登录态', '在「凭证设置」里粘贴小红书 Cookie（含 a1、web_session），再点获取粉丝量。')
  }
  const html = await httpGet(`https://www.xiaohongshu.com/user/profile/${encodeURIComponent(target.userId)}`, env)
  const state = extractJsonAfter(html, 'window.__INITIAL_STATE__')
  const userPage = state && state.user && state.user.userPageData
  let count = userPage ? findInteractionCount(userPage.interactions, '粉丝') : null
  if (count === null && userPage && userPage.basicInfo) count = findByKeys(userPage.basicInfo, ['fans', 'fansCount', 'followerCount'])
  if (count === null && state) count = findByKeys(state, ['fans', 'fansCount', 'followerCount'])
  if (count === null) {
    const raw = html.match(/"fans"\s*:\s*"?(\d+)"?/) || html.match(/粉丝[^0-9]{0,12}([\d,.]+[万亿]?)/)
    count = raw ? parseCount(raw[1]) : null
  }
  if (count === null) throw new FollowersError('parse', '小红书页面里没找到粉丝数', 'Cookie 可能失效；重新复制 Cookie 后重试，或手动填写。')
  return { count, source: 'xiaohongshu:user-page' }
}

async function kuaishouFetch(target, env) {
  // 实测：快手主页 SSR（window.INIT_STATE）免登录就带 ownerCount.fan；
  // 但走海外代理出口时 SSR 会被降级，拿不到 ownerCount。
  const html = await httpGet(`https://www.kuaishou.com/profile/${encodeURIComponent(target.userId)}`, env)
  const state =
    extractJsonAfter(html, 'window.INIT_STATE') ||
    extractJsonAfter(html, 'window.__APOLLO_STATE__') ||
    extractJsonAfter(html, '__APOLLO_STATE__')
  let count = state ? findByKeys(state, ['fan', 'fans', 'fanCount', 'fansCount']) : null
  if (count === null) {
    const raw = html.match(/"fan"\s*:\s*(\d+)/) || html.match(/"fanCount"\s*:\s*(\d+)/)
    count = raw ? parseCount(raw[1]) : null
  }
  if (count === null) {
    throw new FollowersError(
      'parse',
      '快手页面里没解析到粉丝数（SSR 可能被降级，例如走了海外代理出口）',
      '请用国内直连网络重试；仍失败就手动填写粉丝量。',
    )
  }
  return { count, source: 'kuaishou:profile-page' }
}

async function youtubeFetch(target, env) {
  if (env.apiKey) {
    const params = target.channelId ? `id=${encodeURIComponent(target.channelId)}` : `forHandle=${encodeURIComponent(`@${target.handle}`)}`
    const json = await httpJson(
      `https://www.googleapis.com/youtube/v3/channels?part=statistics&${params}&key=${encodeURIComponent(env.apiKey)}`,
      env,
    )
    const item = json && Array.isArray(json.items) ? json.items[0] : null
    const stats = item && item.statistics
    if (stats) {
      const count = parseCount(stats.subscriberCount ?? stats.hiddenSubscriberCount)
      if (count !== null && stats.hiddenSubscriberCount !== true) {
        return { count, source: 'youtube:data-api', extra: { viewCount: stats.viewCount, videoCount: stats.videoCount } }
      }
      if (stats.hiddenSubscriberCount === true) throw new FollowersError('hidden', '该频道隐藏了订阅数', 'YouTube 频道设置了不公开订阅数，无法获取。')
    }
    const reason = json && json.error && json.error.message ? json.error.message : '没有返回频道数据'
    throw new FollowersError('platform_error', `YouTube Data API：${reason}`, '检查 API Key 是否有效、配额是否用完，以及频道 ID / handle 是否正确。')
  }
  const path = target.channelId ? `channel/${encodeURIComponent(target.channelId)}` : `@${encodeURIComponent(target.handle)}`
  const html = await httpGet(`https://www.youtube.com/${path}`, env)
  const direct =
    html.match(/"subscriberCountText":\{"simpleText":"([^"]+)"/) ||
    html.match(/"subscriberCountText":\{[^}]*"simpleText":"([^"]+)"/) ||
    html.match(/([\d.,]+\s*[KkMmBb万亿]?)\s*(?:million|billion|thousand)?\s*(?:位订阅者|subscribers)/)
  const count = direct
    ? parseCount(String(direct[1]).replace(/[^0-9.万亿KkMmBb]/g, '')) || findByKeys(extractJsonAfter(html, 'ytInitialData'), ['subscriberCount'])
    : findByKeys(extractJsonAfter(html, 'ytInitialData'), ['subscriberCount', 'subscriberCountText'])
  if (count === null) {
    throw new FollowersError(
      'needs_api_key',
      'YouTube 页面里没解析到订阅数',
      '在「凭证设置」里填 YouTube Data API v3 Key（Google Cloud 免费开通）最稳；国内还需要代理；或手动填写。',
    )
  }
  return { count, source: 'youtube:page' }
}

async function tiktokFetch(target, env) {
  // 实测：TikTok 免 Cookie，页面 __UNIVERSAL_DATA_FOR_REHYDRATION__ 里就有精确 followerCount；
  // 前提是网络能访问 TikTok（国内需代理）。
  const html = await httpGet(`https://www.tiktok.com/@${encodeURIComponent(target.username)}`, env)
  const state = extractJsonAfter(html, 'id="__UNIVERSAL_DATA_FOR_REHYDRATION__"') || extractJsonAfter(html, '__UNIVERSAL_DATA_FOR_REHYDRATION__')
  let count = state ? findByKeys(state, ['followerCount']) : null
  if (count === null) {
    const raw = html.match(/"followerCount"\s*:\s*(\d+)/)
    count = raw ? parseCount(raw[1]) : null
  }
  if (count === null) throw new FollowersError('parse', 'TikTok 页面里没找到粉丝数', '页面结构可能变了，或返回了验证页；稍后重试，或手动填写。')
  return { count, source: 'tiktok:profile-page' }
}

const PROVIDERS = {
  bilibili: bilibiliFetch,
  douyin: douyinFetch,
  xiaohongshu: xiaohongshuFetch,
  kuaishou: kuaishouFetch,
  youtube: youtubeFetch,
  tiktok: tiktokFetch,
}

/** 解析一个账号的采集目标；不支持自动采集的平台返回 null。 */
export function resolveTarget(platform, card) {
  const resolver = TARGET_RESOLVERS[platform]
  if (!resolver) return null
  try {
    return resolver(card || {})
  } catch {
    return null
  }
}

/** 采集单个平台账号；永远返回结构化结果，不抛错。 */
export async function syncOneAccount(target, settings, options = {}) {
  const startedAt = Date.now()
  const platform = (target && target.platform) || 'other'
  const capability = capabilityOf(platform)
  const base = {
    targetId: (target && target.id) || '',
    targetName: (target && target.name) || '',
    platform,
    platformLabel: capability.label,
    cardId: (target && target.cardId) || '',
    cardName: (target && target.cardName) || '',
    target,
  }
  const durationMs = () => Date.now() - startedAt
  const fail = (code, message, hint) => ({ ok: false, ...base, error: code, message, hint, durationMs: durationMs() })
  try {
    if (capability.auto === 'manual') {
      return fail('unsupported', `${capability.label}没有公开接口，无法自动获取粉丝量`, '请在面板里手动填写粉丝量；填好后口播上下文同样会带上。')
    }
    const resolved = resolveTarget(platform, target || {})
    if (!resolved) return fail('not_linked', `还没关联${capability.label}账号，无法自动获取`, NOT_LINKED_HINT(platform))
    const credentials = (settings && settings.credentials && settings.credentials[platform]) || {}
    const env = {
      platform,
      cookie: String(credentials.cookie || ''),
      apiKey: String(credentials.apiKey || ''),
      proxy: (settings && settings.proxy) || '',
      timeoutMs: Number(settings && settings.timeoutMs) || DEFAULT_TIMEOUT_MS,
      fetchImpl: options.fetchImpl || globalThis.fetch,
    }
    if (env.proxy) env.proxy = normalizeProxy(env.proxy)
    if (typeof env.fetchImpl !== 'function') return fail('internal_error', '当前运行时没有可用的 fetch', '需要 Node 18+。')
    const result = await PROVIDERS[platform](resolved, env)
    const count = parseCount(result.count)
    if (count === null) return fail('parse', '返回的粉丝数无法解析', '稍后重试，或手动填写粉丝量。')
    return {
      ok: true,
      ...base,
      count,
      display: formatCount(count),
      source: result.source,
      extra: result.extra,
      at: new Date().toISOString(),
      message: `已获取粉丝量：${formatCount(count)}（${count.toLocaleString('zh-CN')}）`,
      durationMs: durationMs(),
    }
  } catch (error) {
    const known = error instanceof FollowersError
    const detail = known ? `${error.message}${error.hint ? `｜${error.hint}` : ''}` : String(error && error.message ? error.message : error)
    return fail(known ? error.code : 'internal_error', detail, known ? error.hint : '')
  }
}

/**
 * 批量采集。并发 3，避免同时打太多请求触发风控。
 * @returns {{ results: object[], summary: { total:number, ok:number, failed:number } }}
 */
export async function syncTargets({ targets = [], settings = {}, fetchImpl, logger } = {}) {
  const results = []
  for (let index = 0; index < targets.length; index += SYNC_CONCURRENCY) {
    const slice = targets.slice(index, index + SYNC_CONCURRENCY)
    const settled = await Promise.all(slice.map((target) => syncOneAccount(target, settings, { fetchImpl })))
    results.push(...settled)
  }
  const ok = results.filter((item) => item.ok).length
  if (typeof logger === 'function') {
    for (const item of results) {
      const label = `${item.cardName ? `${item.cardName}·` : ''}${item.platformLabel}${item.targetName && item.targetName !== item.cardName ? `（${item.targetName}）` : ''}`
      if (item.ok) logger('info', `粉丝量采集成功：${label} → ${item.display}，来源 ${item.source}`)
      else logger('info', `粉丝量采集失败：${label} → ${item.error}：${item.message}`)
    }
  }
  return { results, summary: { total: results.length, ok, failed: results.length - ok } }
}

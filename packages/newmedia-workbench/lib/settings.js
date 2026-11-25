/**
 * 凭证与采集设置的存储。
 *
 * 存放位置：~/.dsh/newmedia-workbench/settings.json（目录 0700、文件 0600），
 * 可用环境变量覆盖（只读覆盖，不写回磁盘）：
 *   DSH_NMW_COOKIE_DOUYIN / DSH_NMW_COOKIE_XIAOHONGSHU / DSH_NMW_COOKIE_BILIBILI /
 *   DSH_NMW_COOKIE_KUAISHOU / DSH_NMW_COOKIE_YOUTUBE / DSH_NMW_COOKIE_TIKTOK
 *   DSH_NMW_YOUTUBE_API_KEY
 *   DSH_NMW_PROXY          HTTP 代理（海外平台需要，例如 http://127.0.0.1:6696）
 *
 * 安全约定：
 *  - Cookie / API Key 只在 Host 内存与磁盘出现，面板只回显掩码；
 *  - 不写日志正文，不放进工具返回值；
 *  - 空字符串表示「保持原值不变」，要清除请显式传 clear。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DATA_DIR = process.env.DSH_NEWMEDIA_WORKBENCH_DIR || path.join(os.homedir(), '.dsh', 'newmedia-workbench')
export const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json')
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')

/** 允许保存凭证的平台（与 followers.js 的采集器能力对应）。 */
export const CREDENTIAL_PLATFORMS = ['douyin', 'xiaohongshu', 'bilibili', 'kuaishou', 'youtube', 'tiktok']

const ENV_COOKIE_KEYS = {
  douyin: 'DSH_NMW_COOKIE_DOUYIN',
  xiaohongshu: 'DSH_NMW_COOKIE_XIAOHONGSHU',
  bilibili: 'DSH_NMW_COOKIE_BILIBILI',
  kuaishou: 'DSH_NMW_COOKIE_KUAISHOU',
  youtube: 'DSH_NMW_COOKIE_YOUTUBE',
  tiktok: 'DSH_NMW_COOKIE_TIKTOK',
}

const ENV_API_KEY_KEYS = {
  youtube: 'DSH_NMW_YOUTUBE_API_KEY',
}

export const DEFAULT_TIMEOUT_MS = 12000
export const MIN_TIMEOUT_MS = 3000
export const MAX_TIMEOUT_MS = 60000

const textOf = (value) => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const emptyCredentials = () => {
  const out = {}
  for (const platform of CREDENTIAL_PLATFORMS) out[platform] = { cookie: '', apiKey: '' }
  return out
}

export function defaultSettings() {
  return { version: 1, timeoutMs: DEFAULT_TIMEOUT_MS, proxy: '', credentials: emptyCredentials(), lastSyncAt: '', updatedAt: '' }
}

const clampTimeout = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_MS
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.trunc(n)))
}

/**
 * 归一化设置。
 * @param {object} input 外部输入
 * @param {{ base?: object, keepEmpty?: boolean }} options
 *   keepEmpty=true 时，传入的空字符串表示「保持原值」（面板保存时的默认行为）。
 */
export function normalizeSettings(input = {}, options = {}) {
  const base = isObject(options.base) ? options.base : defaultSettings()
  const keepEmpty = options.keepEmpty !== false
  const merged = isObject(input) ? input : {}
  const credentials = emptyCredentials()
  const incomingCreds = isObject(merged.credentials) ? merged.credentials : {}
  for (const platform of CREDENTIAL_PLATFORMS) {
    const prev = isObject(base.credentials && base.credentials[platform]) ? base.credentials[platform] : { cookie: '', apiKey: '' }
    const next = isObject(incomingCreds[platform]) ? incomingCreds[platform] : {}
    for (const field of ['cookie', 'apiKey']) {
      let value = textOf(next[field])
      if (value === '' && keepEmpty) value = textOf(prev[field])
      credentials[platform][field] = value
    }
  }
  return {
    version: 1,
    timeoutMs: clampTimeout(merged.timeoutMs === undefined ? base.timeoutMs : merged.timeoutMs),
    proxy: textOf(merged.proxy === undefined ? base.proxy : merged.proxy),
    credentials,
    lastSyncAt: textOf(base.lastSyncAt),
    updatedAt: textOf(base.updatedAt),
  }
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 读磁盘设置 + 环境变量覆盖（环境变量优先，且不回写磁盘）。 */
export function loadSettings() {
  const stored = readJsonFile(SETTINGS_FILE)
  const settings = normalizeSettings(isObject(stored) ? stored : {}, { base: defaultSettings(), keepEmpty: false })
  let envOverride = false
  if (process.env.DSH_NMW_PROXY) {
    settings.proxy = textOf(process.env.DSH_NMW_PROXY)
    envOverride = true
  }
  for (const platform of CREDENTIAL_PLATFORMS) {
    const cookieKey = ENV_COOKIE_KEYS[platform]
    if (cookieKey && process.env[cookieKey]) {
      settings.credentials[platform].cookie = textOf(process.env[cookieKey])
      envOverride = true
    }
    const apiKeyKey = ENV_API_KEY_KEYS[platform]
    if (apiKeyKey && process.env[apiKeyKey]) {
      settings.credentials[platform].apiKey = textOf(process.env[apiKeyKey])
      envOverride = true
    }
  }
  settings.envOverride = envOverride
  return settings
}

/** 保存设置（只写磁盘，环境变量覆盖不落盘）。返回写入后的设置。 */
export function saveSettings(input, options = {}) {
  const base = (() => {
    const stored = readJsonFile(SETTINGS_FILE)
    return normalizeSettings(isObject(stored) ? stored : {}, { base: defaultSettings(), keepEmpty: false })
  })()
  const next = normalizeSettings(isObject(input) ? input : {}, { base, keepEmpty: true })
  // 显式清除：面板点「清除该平台凭证」时传 clear: ['douyin']，否则空字符串一律视为「不修改」。
  const clear = Array.isArray(options.clear) ? options.clear.map((item) => textOf(item)).filter(Boolean) : []
  for (const platform of clear) {
    if (next.credentials[platform]) {
      next.credentials[platform].cookie = ''
      next.credentials[platform].apiKey = ''
    }
  }
  next.updatedAt = new Date().toISOString()
  const payload = {
    version: 1,
    timeoutMs: next.timeoutMs,
    proxy: next.proxy,
    credentials: next.credentials,
    lastSyncAt: next.lastSyncAt,
    updatedAt: next.updatedAt,
  }
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  const tmp = `${SETTINGS_FILE}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, SETTINGS_FILE)
  return { ...next, envOverride: false }
}

/** 记录一次批量同步时间（不动凭证）。 */
export function touchLastSync(at) {
  try {
    const stored = readJsonFile(SETTINGS_FILE)
    const payload = { ...(isObject(stored) ? stored : {}), version: 1, lastSyncAt: textOf(at), updatedAt: new Date().toISOString() }
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
    const tmp = `${SETTINGS_FILE}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, SETTINGS_FILE)
  } catch {
    // 记录时间失败不影响同步结果
  }
}

/** 掩码：只回显长度与尾部 4 位，绝不回传明文。 */
export function maskSecret(secret) {
  const value = textOf(secret)
  if (!value) return ''
  const tail = value.length <= 4 ? value.slice(-1) : value.slice(-4)
  return `已保存（长度 ${value.length}，尾 ${tail}）`
}

/** 面板可读的凭证状态：只有 has* 与掩码。 */
export function describeSettings(settings = loadSettings()) {
  const credentials = {}
  for (const platform of CREDENTIAL_PLATFORMS) {
    const entry = isObject(settings.credentials && settings.credentials[platform]) ? settings.credentials[platform] : {}
    credentials[platform] = {
      hasCookie: Boolean(textOf(entry.cookie)),
      cookieMasked: maskSecret(entry.cookie),
      hasApiKey: Boolean(textOf(entry.apiKey)),
      apiKeyMasked: maskSecret(entry.apiKey),
    }
  }
  return {
    settingsFile: SETTINGS_FILE,
    timeoutMs: settings.timeoutMs,
    proxy: settings.proxy || '',
    lastSyncAt: settings.lastSyncAt || '',
    envOverride: Boolean(settings.envOverride),
    credentialPlatforms: CREDENTIAL_PLATFORMS,
    credentials,
  }
}

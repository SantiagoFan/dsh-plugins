/**
 * 内置 Cordys CRM 客户端（原独立 cordys-crm 插件的能力迁入本插件）。
 *
 * - 配置存在 ~/.dsh/data-collector/crm.json（0600），与线索库同目录；
 * - 首次使用时若本插件还没有配置，会自动读取旧插件
 *   ~/.dsh/cordys-crm/config.json 的 baseUrl / AccessKey / SecretKey / 只读开关，实现无感迁移；
 * - 鉴权：X-Access-Key / X-Secret-Key 请求头（Cordys 开放 API 约定），响应包络 code=100200 视为成功；
 * - 只读开关默认 true：不对 CRM 做任何写操作，UI 与工具都会拒绝写入。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { DATA_DIR } from './store.js'

export const CRM_CONFIG_FILE = path.join(DATA_DIR, 'crm.json')
export const LEGACY_CRM_CONFIG_FILE = path.join(os.homedir(), '.dsh', 'cordys-crm', 'config.json')
export const CRM_SUCCESS_CODE = 100200
const DEFAULT_TIMEOUT_MS = 15000

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const text = (value) => (value === null || value === undefined ? '' : String(value).trim())

/** 归一化配置；mask 只影响展示。 */
export function normalizeCrmConfig(input, base = {}) {
  const source = isObject(input) ? input : {}
  const fallback = isObject(base) ? base : {}
  const pick = (key, fallbackValue) => (source[key] === undefined ? text(fallback[key]) || text(fallbackValue) : text(source[key]))
  const baseUrl = pick('baseUrl').replace(/\/+$/, '')
  return {
    baseUrl,
    accessKey: pick('accessKey'),
    secretKey: pick('secretKey'),
    organizationId: pick('organizationId'),
    readOnly: source.readOnly === undefined ? (fallback.readOnly === undefined ? true : fallback.readOnly !== false) : Boolean(source.readOnly),
    timeoutMs: Math.max(3000, Math.min(120000, Number(source.timeoutMs || fallback.timeoutMs || DEFAULT_TIMEOUT_MS))),
  }
}

export function maskCrmConfig(config) {
  const crm = normalizeCrmConfig(config)
  const mask = (value) => (value ? `${value.slice(0, 3)}***${value.slice(-3)}` : '')
  return { ...crm, accessKey: mask(crm.accessKey), secretKey: mask(crm.secretKey) }
}

export function crmConfigured(config) {
  return Boolean(config && config.baseUrl && config.accessKey && config.secretKey)
}

/** 读配置；没有自己的配置时尝试从旧插件迁移一次。 */
export function loadCrmConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CRM_CONFIG_FILE, 'utf8'))
    return normalizeCrmConfig(raw)
  } catch {
    // 没有自己的配置：尝试迁移旧插件配置
    try {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_CRM_CONFIG_FILE, 'utf8'))
      const migrated = normalizeCrmConfig({
        baseUrl: legacy.baseUrl,
        accessKey: legacy.accessKey,
        secretKey: legacy.secretKey,
        organizationId: legacy.organizationId,
        readOnly: legacy.readOnly,
        timeoutMs: legacy.timeoutMs,
      })
      if (crmConfigured(migrated)) {
        try {
          saveCrmConfig(migrated)
        } catch {
          // 迁移写盘失败不阻塞使用
        }
        return migrated
      }
      return migrated
    } catch {
      return normalizeCrmConfig({})
    }
  }
}

/** 原子写配置文件（0600）。 */
export function saveCrmConfig(input) {
  const merged = normalizeCrmConfig(input, loadCrmConfig())
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  const tmp = `${CRM_CONFIG_FILE}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, CRM_CONFIG_FILE)
  return merged
}

function buildUrl(config, apiPath, query) {
  const base = String(config.baseUrl || '').replace(/\/+$/, '')
  if (!base) throw new Error('CRM 还没有配置服务器地址')
  if (!apiPath.startsWith('/') || apiPath.includes('://') || apiPath.includes('..')) throw new Error(`接口路径不合法：${apiPath}`)
  const url = new URL(`${base}${apiPath}`)
  if (isObject(query)) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
    }
  }
  return url.toString()
}

/**
 * 发起一次 Cordys 请求；返回解包后的 data。
 * @param {{ method?: string, path: string, body?: any, query?: any, config?: object, timeoutMs?: number }} options
 */
export async function crmRequest(options = {}) {
  const config = normalizeCrmConfig(options.config || loadCrmConfig())
  if (!crmConfigured(config)) {
    const error = new Error('CRM 尚未配置（服务器地址 / Access Key / Secret Key）')
    error.code = 'not_configured'
    throw error
  }
  const method = String(options.method || 'POST').toUpperCase()
  const url = buildUrl(config, String(options.path || ''), options.query)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs) || config.timeoutMs)
  timer.unref?.()
  let response
  try {
    response = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        'x-access-key': config.accessKey,
        'x-secret-key': config.secretKey,
        ...(config.organizationId ? { 'organization-id': config.organizationId } : {}),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
      redirect: 'manual',
    })
  } catch (error) {
    const wrapped = new Error(error && error.name === 'AbortError' ? '请求 CRM 超时' : `无法连接 CRM（${(error && error.message) || error}）`)
    wrapped.code = error && error.name === 'AbortError' ? 'timeout' : 'network_error'
    throw wrapped
  } finally {
    clearTimeout(timer)
  }
  const raw = await response.text()
  let parsed = null
  try {
    parsed = raw ? JSON.parse(raw) : null
  } catch {
    parsed = null
  }
  if (response.status === 401) {
    const error = new Error('CRM 鉴权失败（HTTP 401）：检查 Access Key / Secret Key')
    error.code = 'unauthorized'
    throw error
  }
  if (!response.ok) {
    const error = new Error((parsed && parsed.message) || `CRM 返回 HTTP ${response.status}`)
    error.code = 'http_error'
    error.status = response.status
    throw error
  }
  if (parsed && typeof parsed.code === 'number' && parsed.code !== CRM_SUCCESS_CODE) {
    const error = new Error(parsed.message ? `CRM 业务错误：${parsed.message}` : `CRM 业务错误（code=${parsed.code}）`)
    error.code = 'business_error'
    error.businessCode = parsed.code
    throw error
  }
  return parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed
}

/** 连通性 + 鉴权 + 当前身份。 */
export async function crmProbe() {
  const config = loadCrmConfig()
  const base = { configured: crmConfigured(config), baseUrl: config.baseUrl, readOnly: config.readOnly !== false, checkedAt: Date.now() }
  if (!base.configured) return { ok: false, ...base, reachable: false, authOk: false, message: '尚未配置 CRM' }
  try {
    await crmRequest({ method: 'POST', path: '/account/page', body: { current: 1, pageSize: 1 }, config })
  } catch (error) {
    return { ok: false, ...base, reachable: error.code === 'network_error' || error.code === 'timeout' ? false : true, authOk: false, message: String(error.message || error) }
  }
  let identity = null
  try {
    identity = await crmRequest({ method: 'GET', path: '/personal/center/info', config })
  } catch {
    identity = null
  }
  return { ok: true, ...base, reachable: true, authOk: true, identity }
}

/** 关键字搜索：线索/联系人/客户/商机各查一次，返回命中的模块与条数。 */
export async function crmSearch(keyword) {
  const textKeyword = String(keyword || '').trim()
  if (!textKeyword) return []
  const config = loadCrmConfig()
  if (!crmConfigured(config)) throw new Error('CRM 尚未配置')
  const results = []
  for (const target of ['lead', 'contact', 'account', 'opportunity']) {
    try {
      const data = await crmRequest({ method: 'POST', path: `/global/search/${target}`, body: { keyword: textKeyword }, config })
      const list = Array.isArray(data) ? data : (data && (data.list || data.records || data.data)) || []
      const total = Number((data && data.total) || list.length) || 0
      if (total > 0) results.push({ target, total, list: list.slice(0, 5) })
    } catch {
      // 单个模块失败不影响其它模块
    }
  }
  return results
}

/** 线索池里的线索（全局搜索看不到池内数据）。 */
export async function crmPoolPage(poolId, keyword, pageSize = 5) {
  const config = loadCrmConfig()
  const data = await crmRequest({ method: 'POST', path: '/pool/lead/page', body: { poolId, keyword, current: 1, pageSize }, config })
  const list = (data && (data.list || data.records || data.rows)) || []
  return { total: Number((data && data.total) || list.length) || 0, list }
}

/** 创建线索并移入线索池。 */
export async function crmCreateLead(payload, poolId) {
  const config = loadCrmConfig()
  if (config.readOnly !== false) {
    const error = new Error('CRM 当前是只读模式：在「CRM」页签关闭只读后才能写入')
    error.code = 'read_only'
    throw error
  }
  const created = await crmRequest({ method: 'POST', path: '/lead/add', body: payload, config })
  const id = String((created && (created.id || (created.data && created.data.id))) || '')
  if (poolId && id) {
    await crmRequest({ method: 'POST', path: '/lead/to-pool', body: { id, poolId }, config })
  }
  return { id, created }
}

/** 线索池 / 意向产品列表（配置页与写入前选择用）。 */
export async function crmOptions() {
  const config = loadCrmConfig()
  if (!crmConfigured(config)) return { ok: false, configured: false, pools: [], products: [] }
  const [poolsData, productsData] = await Promise.all([
    crmRequest({ method: 'POST', path: '/lead-pool/page', body: { current: 1, pageSize: 50 }, config }).catch(() => null),
    crmRequest({ method: 'POST', path: '/product/page', body: { current: 1, pageSize: 50 }, config }).catch(() => null),
  ])
  const listOf = (payload) => {
    if (!payload) return []
    if (Array.isArray(payload)) return payload
    for (const key of ['list', 'records', 'rows', 'data']) {
      if (Array.isArray(payload[key])) return payload[key]
    }
    return []
  }
  return {
    ok: true,
    configured: true,
    readOnly: config.readOnly !== false,
    pools: listOf(poolsData).map((pool) => ({ id: String(pool.id || ''), name: String(pool.name || '') })),
    products: listOf(productsData).map((product) => ({ id: String(product.id || ''), name: String(product.name || '') })),
  }
}

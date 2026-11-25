/**
 * 市场线索：配置存储（state.json）。
 *
 * v3 起 JSON 只放「配置」：主题、渠道、地区范围、定时任务。
 * 线索与运行记录已经搬到 SQLite（见 lib/db.js），这样：
 *  - JSON 保持小而可读，出错也好手改；
 *  - 大表（线索）交给数据库做分页/检索/去重。
 *
 * 位置：~/.dsh/data-collector/state.json（目录 0700、文件 0600），
 * 可用环境变量 DSH_DATA_COLLECTOR_DIR 覆盖目录。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { normalizeRegions } from './leads.js'
import { DEFAULT_TIME_ZONE, isValidTimeZone, parseClock } from './time.js'

export const DATA_DIR = process.env.DSH_DATA_COLLECTOR_DIR || path.join(os.homedir(), '.dsh', 'data-collector')
export const STATE_FILE = path.join(DATA_DIR, 'state.json')
export const DB_FILE = path.join(DATA_DIR, 'leads.db')

// v3：线索搬进 SQLite，state.json 只留配置
export const STATE_VERSION = 3
export const CHANNEL_TYPES = ['rss', 'json', 'html', 'search']
export const CHANNEL_TYPE_LABELS = { rss: 'RSS / Atom', json: 'JSON 接口', html: '网页列表', search: '网页搜索' }

export const MAX_TOPICS = 50
export const MAX_CHANNELS = 60
const MAX_TASKS_PER_RUN = 40

const MIN_RETAIN_DAYS = 1
const MAX_RETAIN_DAYS = 365
const MIN_MAX_ITEMS = 10
const MAX_MAX_ITEMS = 1000

// ------------------------------------------------------------------ 基础工具
export function textOf(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export function listOf(value) {
  if (Array.isArray(value)) return value.map((item) => textOf(item)).filter(Boolean)
  const text = textOf(value)
  if (!text) return []
  return text
    .split(/[\n\r、，,;；]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

export function clampInt(value, min, max, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(num)))
}

export function newId(prefix) {
  const stamp = Date.now().toString(36)
  const random = Math.random().toString(36).slice(2, 7)
  return `${prefix}_${stamp}${random}`
}

// ------------------------------------------------------------------ 默认值
export function emptySchedule() {
  return {
    enabled: true,
    time: '07:30',
    timeZone: DEFAULT_TIME_ZONE,
    catchUp: true,
    retainDays: 30,
    maxItemsPerRun: 200,
    lastRunAt: '',
    lastRunStatus: '',
    lastRunId: '',
    lastRunNew: 0,
  }
}

export function emptyChannel() {
  return {
    id: '',
    name: '',
    type: 'rss',
    url: '',
    query: '',
    itemPath: '',
    fieldTitle: '',
    fieldLink: '',
    fieldDate: '',
    fieldSummary: '',
    fieldCompany: '',
    fieldContact: '',
    fieldPhone: '',
    fieldRegion: '',
    linkTemplate: '',
    linkPattern: '',
    followDetail: true,
    detailLimit: 5,
    region: '',
    limit: 30,
    enabled: true,
    note: '',
    createdAt: '',
    updatedAt: '',
    lastRunAt: '',
    lastStatus: '',
    lastCount: 0,
    lastWithPhone: 0,
    lastError: '',
  }
}

export function emptyTopic() {
  return {
    id: '',
    name: '',
    keywords: [],
    channelIds: [],
    notes: '',
    enabled: true,
    createdAt: '',
    updatedAt: '',
    lastCount: 0,
  }
}

/** 采集范围：默认只收内蒙古自治区的线索；regions 清空=不限地区。 */
export function emptyScope() {
  // unknown：地区识别不出来时怎么处理（smart=看公司/标题里有没有范围内城市）
  return { regions: ['内蒙古'], unknown: 'smart' }
}

/** 写入 CRM 的配置：目标线索池 + 可选的意向产品/负责人。 */
export function emptyCrm() {
  return { poolId: '', poolName: '', productId: '', owner: '' }
}

export function emptyState() {
  return { version: STATE_VERSION, topics: [], channels: [], scope: emptyScope(), schedule: emptySchedule(), crm: emptyCrm() }
}

// ------------------------------------------------------------------ 归一化
export function normalizeScope(input, base) {
  const source = isObject(input) ? input : {}
  const fallback = isObject(base) ? base : emptyScope()
  const rawMode = textOf(source.unknown)
  const legacy = source.keepUnknown
  let unknown = ['smart', 'keep', 'drop'].includes(rawMode) ? rawMode : fallback.unknown || 'smart'
  // 兼容旧字段 keepUnknown：false 视为严格模式
  if (!rawMode && legacy !== undefined) unknown = legacy === false ? 'drop' : 'smart'
  return {
    regions: normalizeRegions(source.regions === undefined ? fallback.regions : source.regions),
    unknown,
  }
}

export function normalizeSchedule(input, base) {
  const source = isObject(input) ? input : {}
  const fallback = isObject(base) ? base : emptySchedule()
  const clock = parseClock(source.time === undefined ? fallback.time : source.time)
  const timeZone = textOf(source.timeZone === undefined ? fallback.timeZone : source.timeZone)
  return {
    enabled: source.enabled === undefined ? Boolean(fallback.enabled) : Boolean(source.enabled),
    time: clock ? `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}` : fallback.time,
    timeZone: isValidTimeZone(timeZone) ? timeZone : isValidTimeZone(fallback.timeZone) ? fallback.timeZone : DEFAULT_TIME_ZONE,
    catchUp: source.catchUp === undefined ? Boolean(fallback.catchUp) : Boolean(source.catchUp),
    retainDays: clampInt(
      source.retainDays === undefined ? fallback.retainDays : source.retainDays,
      MIN_RETAIN_DAYS,
      MAX_RETAIN_DAYS,
      emptySchedule().retainDays,
    ),
    maxItemsPerRun: clampInt(
      source.maxItemsPerRun === undefined ? fallback.maxItemsPerRun : source.maxItemsPerRun,
      MIN_MAX_ITEMS,
      MAX_MAX_ITEMS,
      emptySchedule().maxItemsPerRun,
    ),
    lastRunAt: textOf(source.lastRunAt === undefined ? fallback.lastRunAt : source.lastRunAt),
    lastRunStatus: textOf(source.lastRunStatus === undefined ? fallback.lastRunStatus : source.lastRunStatus),
    lastRunId: textOf(source.lastRunId === undefined ? fallback.lastRunId : source.lastRunId),
    lastRunNew: clampInt(source.lastRunNew === undefined ? fallback.lastRunNew : source.lastRunNew, 0, 1e6, 0),
  }
}

export function normalizeChannel(input, base) {
  const source = isObject(input) ? input : {}
  const fallback = isObject(base) ? { ...emptyChannel(), ...base } : emptyChannel()
  const type = CHANNEL_TYPES.includes(textOf(source.type)) ? textOf(source.type) : fallback.type
  return {
    id: textOf(source.id) || fallback.id || '',
    name: textOf(source.name === undefined ? fallback.name : source.name),
    type: CHANNEL_TYPES.includes(type) ? type : 'rss',
    url: textOf(source.url === undefined ? fallback.url : source.url),
    query: textOf(source.query === undefined ? fallback.query : source.query),
    itemPath: textOf(source.itemPath === undefined ? fallback.itemPath : source.itemPath),
    fieldTitle: textOf(source.fieldTitle === undefined ? fallback.fieldTitle : source.fieldTitle),
    fieldLink: textOf(source.fieldLink === undefined ? fallback.fieldLink : source.fieldLink),
    fieldDate: textOf(source.fieldDate === undefined ? fallback.fieldDate : source.fieldDate),
    fieldSummary: textOf(source.fieldSummary === undefined ? fallback.fieldSummary : source.fieldSummary),
    fieldCompany: textOf(source.fieldCompany === undefined ? fallback.fieldCompany : source.fieldCompany),
    fieldContact: textOf(source.fieldContact === undefined ? fallback.fieldContact : source.fieldContact),
    fieldPhone: textOf(source.fieldPhone === undefined ? fallback.fieldPhone : source.fieldPhone),
    fieldRegion: textOf(source.fieldRegion === undefined ? fallback.fieldRegion : source.fieldRegion),
    linkTemplate: textOf(source.linkTemplate === undefined ? fallback.linkTemplate : source.linkTemplate),
    linkPattern: textOf(source.linkPattern === undefined ? fallback.linkPattern : source.linkPattern),
    followDetail: source.followDetail === undefined ? fallback.followDetail !== false : Boolean(source.followDetail),
    detailLimit: clampInt(source.detailLimit === undefined ? fallback.detailLimit : source.detailLimit, 0, 20, 5),
    region: textOf(source.region === undefined ? fallback.region : source.region),
    limit: clampInt(source.limit === undefined ? fallback.limit : source.limit, 1, 200, 30),
    enabled: source.enabled === undefined ? Boolean(fallback.enabled) : Boolean(source.enabled),
    note: textOf(source.note === undefined ? fallback.note : source.note),
    // createdAt 只来自磁盘或已有对象：normalizeState 里没有 base，不能在这里丢时间戳
    createdAt: textOf(source.createdAt) || textOf(fallback.createdAt),
    updatedAt: textOf(source.updatedAt === undefined ? fallback.updatedAt : source.updatedAt) || new Date().toISOString(),
    lastRunAt: textOf(source.lastRunAt === undefined ? fallback.lastRunAt : source.lastRunAt),
    lastStatus: textOf(source.lastStatus === undefined ? fallback.lastStatus : source.lastStatus),
    lastCount: clampInt(source.lastCount === undefined ? fallback.lastCount : source.lastCount, 0, 1e6, 0),
    lastWithPhone: clampInt(source.lastWithPhone === undefined ? fallback.lastWithPhone : source.lastWithPhone, 0, 1e6, 0),
    lastError: textOf(source.lastError === undefined ? fallback.lastError : source.lastError),
  }
}

export function normalizeTopic(input, base) {
  const source = isObject(input) ? input : {}
  const fallback = isObject(base) ? { ...emptyTopic(), ...base } : emptyTopic()
  return {
    id: textOf(source.id) || fallback.id || '',
    name: textOf(source.name === undefined ? fallback.name : source.name),
    keywords: listOf(source.keywords === undefined ? fallback.keywords : source.keywords),
    channelIds: listOf(source.channelIds === undefined ? fallback.channelIds : source.channelIds),
    notes: textOf(source.notes === undefined ? fallback.notes : source.notes),
    enabled: source.enabled === undefined ? Boolean(fallback.enabled) : Boolean(source.enabled),
    createdAt: textOf(source.createdAt) || textOf(fallback.createdAt),
    updatedAt: textOf(source.updatedAt === undefined ? fallback.updatedAt : source.updatedAt) || new Date().toISOString(),
    lastCount: clampInt(source.lastCount === undefined ? fallback.lastCount : source.lastCount, 0, 1e6, 0),
  }
}

export function normalizeCrm(input, base) {
  const source = isObject(input) ? input : {}
  const fallback = isObject(base) ? base : emptyCrm()
  return {
    poolId: textOf(source.poolId === undefined ? fallback.poolId : source.poolId),
    poolName: textOf(source.poolName === undefined ? fallback.poolName : source.poolName),
    productId: textOf(source.productId === undefined ? fallback.productId : source.productId),
    owner: textOf(source.owner === undefined ? fallback.owner : source.owner),
  }
}

export function normalizeState(input) {
  const source = isObject(input) ? input : {}
  const topics = (Array.isArray(source.topics) ? source.topics : [])
    .map((topic) => normalizeTopic(topic))
    .filter((topic) => topic.id)
    .slice(0, MAX_TOPICS)
  const channels = (Array.isArray(source.channels) ? source.channels : [])
    .map((channel) => normalizeChannel(channel))
    .filter((channel) => channel.id)
    .slice(0, MAX_CHANNELS)
  return {
    version: STATE_VERSION,
    topics,
    channels,
    scope: normalizeScope(source.scope, emptyScope()),
    schedule: normalizeSchedule(source.schedule, emptySchedule()),
    crm: normalizeCrm(source.crm, emptyCrm()),
  }
}

// ------------------------------------------------------------------ 读写
export function readState() {
  let raw
  try {
    raw = fs.readFileSync(STATE_FILE, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyState()
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 磁盘损坏时不让插件起不来：返回空配置，下一次保存会覆盖它。
    return emptyState()
  }
  return normalizeState(parsed)
}

/** 读磁盘上的原始 JSON（迁移旧数据时用，能看到 items/runs 等旧字段）。 */
export function readRawState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    return isObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** 原子写：先写临时文件再 rename，避免进程中断留下半截 JSON。 */
export function writeState(state) {
  const payload = normalizeState(state)
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  const tmp = `${STATE_FILE}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, STATE_FILE)
  return payload
}

/** 本次运行最多处理多少个「主题 × 渠道」组合。 */
export const TASK_LIMIT = MAX_TASKS_PER_RUN

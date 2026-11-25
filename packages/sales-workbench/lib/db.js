/**
 * 市场线索：SQLite 存储（Node 内置 node:sqlite，无第三方依赖）。
 *
 * 为什么放数据库：线索要分页、全文检索、按日期/主题/渠道/地区筛选、导出，
 * 还要跨天去重——这些都交给 SQL（唯一索引 + LIMIT/OFFSET）比在内存里过滤更稳。
 *
 * 分工：
 *  - state.json  → 配置（主题、渠道、地区范围、定时任务），保持人类可读、可手改
 *  - leads.db    → 线索、运行记录（数量大、要查询）
 *
 * 去重：leads.key 建唯一索引（电话 → 公司名 → 网址），插入用 INSERT OR IGNORE，
 * 想去重窗口就是「保留天数」——老线索被裁剪后同一个电话才可能重新出现。
 */
import fs from 'node:fs'
import path from 'node:path'

import { normalizePhone } from './leads.js'

import { DatabaseSync } from 'node:sqlite'

export const DB_VERSION = 1

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    run_id TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL DEFAULT '',
    topic_id TEXT NOT NULL DEFAULT '',
    topic_name TEXT NOT NULL DEFAULT '',
    channel_id TEXT NOT NULL DEFAULT '',
    channel_name TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '',
    contact TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    phone_digits TEXT NOT NULL DEFAULT '',
    region TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    published_at TEXT NOT NULL DEFAULT '',
    fetched_at TEXT NOT NULL DEFAULT '',
    crm_id TEXT NOT NULL DEFAULT '',
    sync_state TEXT NOT NULL DEFAULT '',
    synced_at TEXT NOT NULL DEFAULT ''
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_key ON leads(key)',
  'CREATE INDEX IF NOT EXISTS idx_leads_date ON leads(date)',
  'CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone_digits)',
  'CREATE INDEX IF NOT EXISTS idx_leads_topic ON leads(topic_id)',
  'CREATE INDEX IF NOT EXISTS idx_leads_channel ON leads(channel_id)',
  'CREATE INDEX IF NOT EXISTS idx_leads_region ON leads(region)',
  'CREATE INDEX IF NOT EXISTS idx_leads_fetched ON leads(fetched_at)',
  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL DEFAULT '',
    finished_at TEXT NOT NULL DEFAULT '',
    trigger TEXT NOT NULL DEFAULT 'manual',
    status TEXT NOT NULL DEFAULT 'ok',
    fetched INTEGER NOT NULL DEFAULT 0,
    new_items INTEGER NOT NULL DEFAULT 0,
    with_phone INTEGER NOT NULL DEFAULT 0,
    duplicate INTEGER NOT NULL DEFAULT 0,
    filtered INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    out_of_region INTEGER NOT NULL DEFAULT 0,
    details INTEGER NOT NULL DEFAULT 0,
    errors TEXT NOT NULL DEFAULT '[]',
    tasks TEXT NOT NULL DEFAULT '[]'
  )`,
  'CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at)',
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
]

/** LIKE 里的通配符要转义，避免用户搜 `%` 时把全表捞出来。 */
function likePattern(text) {
  return `%${String(text).replace(/[\\%_]/g, (m) => `\\${m}`)}%`
}

/** 电话归一：电话原文缺 digits 时现算，保证「只看有电话」与号码检索可用。 */
function digitsOf(lead) {
  return String(lead.phoneDigits || '').trim() || normalizePhone(lead.phone)
}

function rowToLead(row) {
  return {
    id: row.id,
    key: row.key,
    runId: row.run_id,
    date: row.date,
    topicId: row.topic_id,
    topicName: row.topic_name,
    channelId: row.channel_id,
    channelName: row.channel_name,
    company: row.company,
    contact: row.contact,
    phone: row.phone,
    phoneDigits: row.phone_digits,
    region: row.region,
    note: row.note,
    title: row.title,
    sourceUrl: row.source_url,
    publishedAt: row.published_at,
    fetchedAt: row.fetched_at,
    crmId: row.crm_id || '',
    syncState: row.sync_state || '',
    syncedAt: row.synced_at || '',
  }
}

function rowToRun(row) {
  const parse = (value, fallback) => {
    try {
      return JSON.parse(value)
    } catch {
      return fallback
    }
  }
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    trigger: row.trigger,
    status: row.status,
    fetched: row.fetched,
    newItems: row.new_items,
    withPhone: row.with_phone,
    duplicate: row.duplicate,
    filtered: row.filtered,
    skipped: row.skipped,
    outOfRegion: row.out_of_region,
    details: row.details,
    errors: parse(row.errors, []),
    tasks: parse(row.tasks, []),
  }
}

/** 查询条件 → WHERE 子句 + 参数（分页、导出、计数共用同一套）。 */
function buildWhere(query = {}) {
  const where = []
  const params = []
  const date = String(query.date || '').trim()
  const dateFrom = String(query.dateFrom || '').trim()
  const dateTo = String(query.dateTo || '').trim()
  const q = String(query.q || query.keyword || '').trim()
  const topic = String(query.topic || '').trim()
  const channel = String(query.channel || '').trim()
  const region = String(query.region || '').trim()

  if (date) {
    where.push('date = ?')
    params.push(date)
  }
  if (dateFrom) {
    where.push('date >= ?')
    params.push(dateFrom)
  }
  if (dateTo) {
    where.push('date <= ?')
    params.push(dateTo)
  }
  if (topic) {
    where.push('(topic_id = ? OR topic_name = ?)')
    params.push(topic, topic)
  }
  if (channel) {
    where.push('(channel_id = ? OR channel_name = ?)')
    params.push(channel, channel)
  }
  if (region) {
    where.push('region LIKE ? ESCAPE \'\\\'')
    params.push(likePattern(region))
  }
  if (query.hasPhone === true || query.hasPhone === 'true' || query.hasPhone === 1 || query.hasPhone === '1') {
    where.push("phone_digits <> ''")
  }
  const sync = String(query.sync || '').trim()
  if (sync && sync !== 'all') {
    // 各状态互斥：未同步 = 有手机号且尚未写入/未失败；无手机号单列，不再混进未同步
    if (sync === 'unsynced') where.push("phone_digits <> '' AND sync_state NOT IN ('synced', 'failed')")
    else if (sync === 'synced') where.push("sync_state = 'synced'")
    else if (sync === 'failed') where.push("sync_state = 'failed'")
    else if (sync === 'no_phone') where.push("phone_digits = ''")
    else if (sync === 'has_phone') where.push("phone_digits <> ''")
    else if (sync === 'today') {
      where.push('date = ?')
      params.push(String(query.todayDate || ''))
    }
  }
  if (q) {
    const pattern = likePattern(q)
    where.push(
      "(company LIKE ? ESCAPE '\\' OR contact LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR phone_digits LIKE ? ESCAPE '\\' OR region LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR source_url LIKE ? ESCAPE '\\')",
    )
    params.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern)
  }
  return { clause: where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '', params }
}

const SORTS = {
  newest: 'fetched_at DESC, id DESC',
  oldest: 'fetched_at ASC, id ASC',
  company: "company = '' ASC, company ASC, fetched_at DESC",
}

export class LeadDatabase {
  constructor(file) {
    this.file = file
    this.statements = new Map()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    for (const sql of SCHEMA) this.db.exec(sql)
    this.migrateColumns()
    const version = this.getMeta('schemaVersion')
    if (!version) this.setMeta('schemaVersion', String(DB_VERSION))
    this.repairPhoneDigits()
  }

  /** 老库补列：CRM 同步状态（crm_id / sync_state / synced_at）。 */
  migrateColumns() {
    const existing = new Set(this.db.prepare('PRAGMA table_info(leads)').all().map((col) => col.name))
    const additions = [
      ['crm_id', "TEXT NOT NULL DEFAULT ''"],
      ['sync_state', "TEXT NOT NULL DEFAULT ''"],
      ['synced_at', "TEXT NOT NULL DEFAULT ''"],
    ]
    for (const [name, ddl] of additions) {
      if (!existing.has(name)) this.db.exec(`ALTER TABLE leads ADD COLUMN ${name} ${ddl}`)
    }
  }

  prepare(sql) {
    let statement = this.statements.get(sql)
    if (!statement) {
      statement = this.db.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  getMeta(key) {
    const row = this.prepare('SELECT value FROM meta WHERE key = ?').get(key)
    return row ? row.value : ''
  }

  setMeta(key, value) {
    this.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value))
  }

  close() {
    try {
      // 关库前把 WAL 合并回主文件，目录里只留一个干净的 leads.db
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      // checkpoint 失败不影响关闭
    }
    try {
      this.db.close()
    } catch {
      // 关闭失败不影响下次启动
    }
  }

  // ---------------------------------------------------------------- 线索写入
  /** 返回 true 表示这条是新线索（key 唯一索引挡住重复）。 */
  insertLead(lead) {
    const result = this.prepare(
      `INSERT OR IGNORE INTO leads (
        id, key, run_id, date, topic_id, topic_name, channel_id, channel_name,
        company, contact, phone, phone_digits, region, note, title, source_url, published_at, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      lead.id,
      lead.key,
      lead.runId || '',
      lead.date || '',
      lead.topicId || '',
      lead.topicName || '',
      lead.channelId || '',
      lead.channelName || '',
      lead.company || '',
      lead.contact || '',
      lead.phone || '',
      digitsOf(lead),
      lead.region || '',
      lead.note || '',
      lead.title || '',
      lead.sourceUrl || '',
      lead.publishedAt || '',
      lead.fetchedAt || new Date().toISOString(),
    )
    return Number(result.changes) > 0
  }

  /** 已有线索的 key（用于运行开始时预热去重集合，跨天判断）。 */
  existingKeys(keys) {
    const list = Array.isArray(keys) ? keys : []
    const found = new Set()
    const chunk = 200
    for (let i = 0; i < list.length; i += chunk) {
      const slice = list.slice(i, i + chunk)
      const placeholders = slice.map(() => '?').join(',')
      const rows = this.prepare(`SELECT key FROM leads WHERE key IN (${placeholders})`).all(...slice)
      for (const row of rows) found.add(row.key)
    }
    return found
  }

  // ---------------------------------------------------------------- 查询
  listLeads(query = {}) {
    const pageSize = Math.max(1, Math.min(200, Number(query.pageSize ?? query.limit) || 20))
    const total = Number(this.prepare(`SELECT COUNT(*) AS n FROM leads${buildWhere(query).clause}`).get(...buildWhere(query).params).n) || 0
    const pages = Math.max(1, Math.ceil(total / pageSize))
    const page = Math.max(1, Math.min(pages, Number(query.page) || 1))
    const { clause, params } = buildWhere(query)
    const order = SORTS[String(query.sort || 'newest')] || SORTS.newest
    const rows = this.prepare(`SELECT * FROM leads${clause} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize)
    return { items: rows.map(rowToLead), total, page, pageSize, pages }
  }

  /** 导出用：同样的筛选条件但不分页（上限 20000，避免一次导出把内存打爆）。 */
  exportLeads(query = {}, max = 20000) {
    const { clause, params } = buildWhere(query)
    const order = SORTS[String(query.sort || 'newest')] || SORTS.newest
    return this.prepare(`SELECT * FROM leads${clause} ORDER BY ${order} LIMIT ?`).all(...params, max).map(rowToLead)
  }

  /** 按天聚合（给日期筛选器用），可选带上当前筛选条件之外的全部。 */
  dates() {
    return this.prepare("SELECT date, COUNT(*) AS n FROM leads WHERE date <> '' GROUP BY date ORDER BY date DESC").all().map((row) => ({ date: row.date, count: row.n }))
  }

  /** 各同步状态的条数（线索页状态页签用）；四个状态互斥，加起来等于全部。 */
  countBySync(today = '') {
    const row = this.prepare(
      `SELECT COUNT(*) AS all_count,
              SUM(CASE WHEN phone_digits <> '' AND sync_state NOT IN ('synced', 'failed') THEN 1 ELSE 0 END) AS unsynced,
              SUM(CASE WHEN sync_state = 'synced' THEN 1 ELSE 0 END) AS synced,
              SUM(CASE WHEN sync_state = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN phone_digits = '' THEN 1 ELSE 0 END) AS no_phone,
              SUM(CASE WHEN date = ? THEN 1 ELSE 0 END) AS today_count
       FROM leads`,
    ).get(String(today || ''))
    return {
      all: Number(row.all_count) || 0,
      unsynced: Number(row.unsynced) || 0,
      synced: Number(row.synced) || 0,
      failed: Number(row.failed) || 0,
      noPhone: Number(row.no_phone) || 0,
      today: Number(row.today_count) || 0,
    }
  }

  stats(today) {
    const total = Number(this.prepare('SELECT COUNT(*) AS n FROM leads').get().n) || 0
    const withPhone = Number(this.prepare("SELECT COUNT(*) AS n FROM leads WHERE phone_digits <> ''").get().n) || 0
    const todayRows = today ? Number(this.prepare('SELECT COUNT(*) AS n FROM leads WHERE date = ?').get(today).n) || 0 : 0
    const todayWithPhone = today
      ? Number(this.prepare("SELECT COUNT(*) AS n FROM leads WHERE date = ? AND phone_digits <> ''").get(today).n) || 0
      : 0
    return { total, withPhone, today: todayRows, todayWithPhone }
  }

  // ---------------------------------------------------------------- 运行记录
  insertRun(run) {
    this.prepare(
      `INSERT OR REPLACE INTO runs (
        id, started_at, finished_at, trigger, status, fetched, new_items, with_phone,
        duplicate, filtered, skipped, out_of_region, details, errors, tasks
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      run.id,
      run.startedAt || '',
      run.finishedAt || '',
      run.trigger || 'manual',
      run.status || 'ok',
      Number(run.fetched) || 0,
      Number(run.newItems) || 0,
      Number(run.withPhone) || 0,
      Number(run.duplicate) || 0,
      Number(run.filtered) || 0,
      Number(run.skipped) || 0,
      Number(run.outOfRegion) || 0,
      Number(run.details) || 0,
      JSON.stringify(run.errors || []),
      JSON.stringify(run.tasks || []),
    )
  }

  listRuns(limit = 30) {
    return this.prepare(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`).all(Math.max(1, Math.min(200, Number(limit) || 30))).map(rowToRun)
  }

  lastRun() {
    const row = this.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 1').get()
    return row ? rowToRun(row) : null
  }

  // ---------------------------------------------------------------- 维护
  clearLeads() {
    const info = this.prepare('DELETE FROM leads').run()
    return Number(info.changes) || 0
  }

  /** 删除某个主题下的线索（删主题时连带清理）。 */
  deleteLeadsByTopic(topicId) {
    const info = this.prepare('DELETE FROM leads WHERE topic_id = ?').run(String(topicId || ''))
    return Number(info.changes) || 0
  }

  /** 删除单条线索（面板里的行内删除）。 */
  deleteLead(id) {
    const info = this.prepare('DELETE FROM leads WHERE id = ?').run(String(id || ''))
    return Number(info.changes) || 0
  }

  /** 按 id 取一条线索（写 CRM 前要读原始字段）。 */
  getLead(id) {
    const row = this.prepare('SELECT * FROM leads WHERE id = ?').get(String(id || ''))
    return row ? rowToLead(row) : null
  }

  /** 记录 CRM 同步结果。 */
  updateSync(id, { crmId = '', state = '', at = '' } = {}) {
    this.prepare('UPDATE leads SET crm_id = ?, sync_state = ?, synced_at = ? WHERE id = ?').run(String(crmId), String(state), String(at), String(id))
  }

  /** 按保留天数裁剪线索与运行记录；返回删掉的行数。 */
  prune(retainDays, now = new Date()) {
    const days = Math.max(1, Math.min(365, Number(retainDays) || 30))
    const cutoff = new Date(now.getTime() - days * 86400000).toISOString()
    const leads = Number(this.prepare('DELETE FROM leads WHERE fetched_at < ?').run(cutoff).changes) || 0
    const runs = Number(this.prepare('DELETE FROM runs WHERE started_at < ?').run(cutoff).changes) || 0
    // 运行记录另留最近 200 条，避免保留天数太大时表无限增长
    this.prepare('DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY started_at DESC LIMIT 200)').run()
    return { leads, runs }
  }

  /** 从旧版 state.json 迁移线索与运行记录（只做一次，返回导入条数）。 */
  importLegacy({ items, runs }) {
    let imported = 0
    const list = Array.isArray(items) ? items : []
    if (list.length > 0) {
      this.db.exec('BEGIN')
      try {
        for (const item of list) {
          const ok = this.insertLead({
            ...item,
            id: item.id || `legacy_${Math.random().toString(36).slice(2, 10)}`,
            fetchedAt: item.fetchedAt || new Date().toISOString(),
          })
          if (ok) imported += 1
        }
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    const runList = Array.isArray(runs) ? runs : []
    for (const run of runList) {
      if (run && run.id) this.insertRun(run)
    }
    return { leads: imported, runs: runList.length }
  }

  /** 修复 phone_digits 为空但有电话的旧行（老数据或外部导入的库）。 */
  repairPhoneDigits() {
    const rows = this.prepare("SELECT id, phone FROM leads WHERE phone <> '' AND phone_digits = ''").all()
    if (rows.length === 0) return 0
    const update = this.prepare('UPDATE leads SET phone_digits = ? WHERE id = ?')
    this.db.exec('BEGIN')
    try {
      for (const row of rows) update.run(normalizePhone(row.phone), row.id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return rows.length
  }

  fileInfo() {
    const size = (suffix) => {
      try {
        return fs.statSync(`${this.file}${suffix}`).size
      } catch {
        return 0
      }
    }
    // WAL 模式下数据可能还在 -wal 里，统计时一起算，关闭时再 checkpoint 合并
    return {
      file: this.file,
      bytes: size('') + size('-wal') + size('-shm'),
      updatedAt: new Date().toISOString(),
    }
  }
}

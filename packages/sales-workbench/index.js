/**
 * Host half of @mindlink-ai/dsh-sales-workbench.
 *
 * 市场线索（原「数据采集器」）：按「采集主题 × 渠道」定时（默认每天早上）把公开公告/页面抓下来，
 * 识别成线索（公司名称 / 联系人 / 联系电话 / 地区 / 备注+网址来源），
 * 供左侧边栏面板浏览、导出，也供 Agent 用 data_collector 工具查询与改配置。
 *
 * 三个出口共用同一份数据与同一套读写逻辑：
 *  - 左边栏面板：同源 HTTP 路由 /data-collector/*；
 *  - Agent 工具 data_collector；
 *  - Host 服务 dataCollector，供其他插件同进程调用。
 *
 * 数据只落本机 ~/.dsh/data-collector/（state.json + reports/*.md），不上传任何地方。
 * 定时任务是插件自己的计时器：不依赖会话、不唤醒 Agent，关掉 Harness 就不会跑，
 * 启动时如果错过了当天的时间点会按 catchUp 补采一次。
 */
import fs from 'node:fs'
import path from 'node:path'

import { fetchChannelItems, fetchText, matchTopic, stripTags } from './lib/collect.js'
import {
  CRM_CONFIG_FILE,
  LEGACY_CRM_CONFIG_FILE,
  crmConfigured,
  crmCreateLead,
  crmOptions as crmListOptions,
  crmPoolPage,
  crmProbe,
  crmRequest,
  crmSearch,
  loadCrmConfig,
  maskCrmConfig,
  saveCrmConfig as crmFileSave,
} from './lib/cordys.js'
import { dedupeKeys, leadPayload } from './lib/crm.js'
import { LeadDatabase } from './lib/db.js'
import { buildXlsx } from './lib/xlsx.js'
import { expandRegions, extractLead, isIncomplete, leadKeyOf, mergeLeads, normalizePhone, prettyPhone, scopeDecision } from './lib/leads.js'
import {
  CHANNEL_TYPE_LABELS,
  CHANNEL_TYPES,
  DATA_DIR,
  DB_FILE,
  STATE_FILE,
  TASK_LIMIT,
  emptySchedule,
  listOf,
  newId,
  normalizeChannel,
  normalizeCrm,
  normalizeSchedule,
  normalizeScope,
  normalizeState,
  normalizeTopic,
  readRawState,
  readState,
  textOf,
  writeState,
} from './lib/store.js'
import { DEFAULT_TIME_ZONE, dateKeyInZone, formatInZone, isValidTimeZone, lastDueAt, nextRunAt, parseClock } from './lib/time.js'

export const name = 'data-collector'
export const inject = ['tools']

const PLUGIN_VERSION = '3.0.0'
const ROUTE_PREFIX = '/data-collector'
const RUN_TASK_TIMEOUT_MS = 15000
const DETAIL_TIMEOUT_MS = 10000
const MAX_DETAILS_PER_RUN = 30
/** 标题里带这些词说明是有商业意图的公告：即使没识别出公司/电话也留下来让用户跟进。 */
const LEAD_INTENT = /采购|招标|中标|询价|磋商|比选|竞价|遴选|征集|招商|合作|服务外包|维保|外包/
const DEFAULT_PAGE_SIZE = 20
const MAX_RESULT_LIMIT = 200
const REPORT_DIR = path.join(DATA_DIR, 'reports')
const CATCH_UP_DELAY_MS = 20000

const SYSTEM_PROMPT_TEXT =
  '市场线索（左侧边栏「市场线索」）每天定时把主题相关的公告/页面抓下来，识别成「意向客户」线索：公司名称、联系人、联系电话、地区、备注（网址来源）、采集时间。' +
  '用户问「今天有哪些线索 / 采集到哪些客户 / 意向客户」→ data_collector(action="results"，date 留空按最新优先)；问「有多少条 / 有电话的多少」→ 用 results 的 total 与 items[].phone 判断，不要编造。' +
  '用户说「加一个主题」→ action="save_topic"（data.name、data.keywords 必填，关键词通常是采购/招标/演练/消防等业务词）；' +
  '「加一个渠道」→ action="save_channel"（data.name、data.type、data.url 或 data.query）；' +
  '「改成早上 8 点 / 关掉定时」→ action="set_schedule"（data.time、data.enabled）；' +
  '「只看某个地区 / 只收内蒙古」→ action="set_scope"（data.regions=["内蒙古"]，空数组=不限地区）；' +
  '「现在跑一次」→ action="run"。' +
  'CRM 已内置在本插件：写入前用 crm_precheck 查重（手机号/公司名，含线索池），crm_push 写入线索池；连接配置用 crm_connect（baseUrl/accessKey/secretKey/readOnly），crm_status 看连通，crm_search 按关键词查 CRM。' +
  '线索字段是启发式识别的，可能有误；汇报时标明来源网址，让用户自己核对。'

const TRIGGER_LABELS = { auto: '定时', manual: '手动', startup: '启动补采' }
const STATUS_LABELS = { ok: '成功', partial: '部分成功', failed: '失败', running: '进行中' }

// ------------------------------------------------------------------ 运行时状态
/** 当前正在进行的运行（内存态，不落盘）：面板用它显示进度。 */
let runtime = null
/** 正在跑的 Promise；同一时刻只允许一次采集。 */
let running = null
let timer = null
/** 线索库（SQLite）：首次使用时打开，并顺手把旧版 state.json 里的线索迁进来。 */
let database = null

function log(ctx, level, message) {
  const logger = ctx && ctx.logger
  const method = level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'info'
  if (logger && typeof logger[method] === 'function') logger[method](`[data-collector] ${message}`)
  else if (method === 'warn' || method === 'error') console.warn(`[data-collector] ${message}`)
}

function getDb(ctx) {
  if (database) return database
  const db = new LeadDatabase(DB_FILE)
  // 旧版把线索存在 state.json 里：首次启动数据库时导进来，然后从 JSON 里移除
  try {
    const raw = readRawState()
    const legacyItems = raw && Array.isArray(raw.items) ? raw.items : []
    const legacyRuns = raw && Array.isArray(raw.runs) ? raw.runs : []
    if (legacyItems.length > 0 || legacyRuns.length > 0) {
      const result = db.importLegacy({ items: legacyItems, runs: legacyRuns })
      writeState(readState())
      log(ctx, 'info', `已把 ${result.leads} 条线索、${result.runs} 条运行记录从 state.json 迁移到 SQLite`)
    }
  } catch (error) {
    log(ctx, 'warn', `迁移旧数据失败（数据库里的新数据不受影响）：${error && error.message ? error.message : error}`)
  }
  database = db
  return database
}

function readStateSafe(ctx) {
  try {
    return readState()
  } catch (error) {
    log(ctx, 'warn', `读取状态失败，按空配置继续：${error && error.message ? error.message : error}`)
    return normalizeState({})
  }
}

function saveStateSafe(ctx, state) {
  try {
    return writeState(state)
  } catch (error) {
    log(ctx, 'warn', `写入状态失败：${error && error.message ? error.message : error}`)
    throw error
  }
}

function snapshotRuntime() {
  if (!runtime) return null
  return { ...runtime }
}

// ------------------------------------------------------------------ 计划与执行
/**
 * 规划一次采集：每个启用的渠道只抓一次，再按主题的关键词分派。
 * 主题没选渠道时视为关注全部渠道；没有任何主题时全部结果归入「未分类」。
 */
export function planRun(state) {
  const channels = state.channels.filter((channel) => channel.enabled)
  const topics = state.topics.filter((topic) => topic.enabled)
  const fallback = { id: '', name: '未分类', keywords: [], channelIds: [], enabled: true }
  const plan = []
  for (const channel of channels) {
    const watchers =
      topics.length === 0 ? [fallback] : topics.filter((topic) => topic.channelIds.length === 0 || topic.channelIds.includes(channel.id))
    if (watchers.length === 0) continue
    plan.push({ channel, topics: watchers })
    if (plan.length >= TASK_LIMIT) break
  }
  return plan
}

/** 执行一次采集。调用方保证同一时刻只有一次运行。 */
async function executeRun(ctx, { runId, trigger }) {
  const state = readStateSafe(ctx)
  const plan = planRun(state)
  const timeZone = state.schedule.timeZone
  const date = dateKeyInZone(new Date(), timeZone)
  const maxItems = state.schedule.maxItemsPerRun
  const run = {
    id: runId,
    startedAt: runtime.startedAt,
    finishedAt: '',
    trigger,
    status: 'running',
    fetched: 0,
    newItems: 0,
    withPhone: 0,
    duplicate: 0,
    filtered: 0,
    skipped: 0,
    outOfRegion: 0,
    details: 0,
    tasks: [],
    errors: [],
  }
  runtime.total = plan.length
  const collected = []
  const channelUpdates = new Map()
  const scopeKeywords = expandRegions(state.scope.regions)
  let stopped = ''
  let detailBudget = MAX_DETAILS_PER_RUN

  for (const step of plan) {
    const { channel, topics } = step
    runtime.current = channel.name
    const task = {
      channelId: channel.id,
      channelName: channel.name,
      topicId: '',
      topicName: '',
      status: 'failed',
      count: 0,
      withPhone: 0,
      skipped: 0,
      outOfRegion: 0,
      details: 0,
      ms: 0,
      error: '',
    }
    const startedAt = Date.now()
    try {
      const parsed = await fetchChannelItems(ctx, channel, {
        topic: topics[0],
        timeoutMs: RUN_TASK_TIMEOUT_MS,
      })
      let kept = 0
      let withPhone = 0
      let skipped = 0
      let outOfRegion = 0
      let details = 0
      for (const raw of parsed.items) {
        run.fetched += 1
        const matched = topics.find((candidate) => matchTopic(raw, candidate))
        // 名录类接口（填了公司字段）是整份机构清单，不按关键词筛，只按地区范围筛
        const directoryMode = Boolean(channel.fieldCompany)
        const topic = matched || (directoryMode ? topics[0] : undefined)
        if (!topic) {
          run.filtered += 1
          continue
        }
        // ① 先从列表页的标题/摘要里识别线索
        let lead = extractLead({
          title: raw.title,
          summary: raw.summary,
          channelName: channel.name,
          defaultRegion: channel.region,
        })
        // 名录类接口直接给了公司/联系人/电话，优先用接口字段（不再猜）
        lead = withDirectFields(lead, raw)
        // ② 关键字段缺失时抓一次详情页正文补全（受渠道开关、每渠道条数与本次总量限制）
        const canFollow =
          channel.followDetail !== false &&
          Boolean(raw.url) &&
          detailBudget > 0 &&
          details < (Number(channel.detailLimit) || 0)
        if (canFollow && isIncomplete(lead)) {
          detailBudget -= 1
          details += 1
          runtime.current = `${channel.name} · 详情页`
          try {
            const response = await fetchText(ctx, raw.url, { timeoutMs: DETAIL_TIMEOUT_MS })
            const detailText = stripTags(response.text)
            lead = mergeLeads(
              lead,
              extractLead({ title: raw.title, detail: detailText, summary: raw.summary, defaultRegion: channel.region }),
            )
          } catch {
            // 详情页打不开不影响这条线索，留下列表页能识别到的信息
          }
        }
        // ③ 既没有公司名也没有电话/联系人、标题也不像采购/招标公告的，不算线索（只是资讯）
        const hasIntent = LEAD_INTENT.test(`${raw.title} ${lead.note}`)
        if (!lead.company && !lead.phone && !lead.contact && !hasIntent) {
          run.skipped += 1
          skipped += 1
          continue
        }
        // ④ 地区范围：只保留配置范围内的线索（地区识别不出来时按配置的 unknown 策略）
        if (scopeKeywords.length > 0 && scopeDecision(lead, scopeKeywords, state.scope.unknown) === 'drop') {
          run.outOfRegion += 1
          outOfRegion += 1
          continue
        }
        const key = leadKeyOf({ ...lead, sourceUrl: raw.url })
        if (!key) continue
        if (run.newItems >= maxItems) {
          stopped = `单次采集达到上限 ${maxItems} 条线索，剩余留到下次`
          break
        }
        const record = {
          id: newId('lead'),
          runId,
          date,
          topicId: topic.id,
          topicName: topic.name,
          channelId: channel.id,
          channelName: channel.name,
          company: lead.company,
          contact: lead.contact,
          phone: lead.phone,
          phoneDigits: normalizePhone(lead.phone),
          region: lead.region,
          note: lead.note,
          title: raw.title,
          sourceUrl: raw.url,
          publishedAt: raw.publishedAt,
          key,
          fetchedAt: new Date().toISOString(),
        }
        // 去重交给数据库：key 有唯一索引，INSERT OR IGNORE 返回 0 行说明这条已经有了
        if (!getDb(ctx).insertLead(record)) {
          run.duplicate += 1
          continue
        }
        collected.push(record)
        kept += 1
        if (lead.phone) withPhone += 1
      }
      task.status = 'ok'
      task.count = kept
      task.withPhone = withPhone
      task.skipped = skipped
      task.outOfRegion = outOfRegion
      task.details = details
      run.newItems += kept
      run.withPhone += withPhone
      run.details += details
      task.topicName = topics.map((topic) => topic.name).join('、')
      channelUpdates.set(channel.id, {
        lastRunAt: new Date().toISOString(),
        lastStatus: 'ok',
        lastCount: kept,
        lastWithPhone: withPhone,
        lastError: '',
      })
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      task.error = message
      run.errors.push(`${channel.name}：${message}`)
      channelUpdates.set(channel.id, { lastRunAt: new Date().toISOString(), lastStatus: 'failed', lastError: message })
    } finally {
      task.ms = Date.now() - startedAt
      run.tasks.push(task)
      runtime.done += 1
      runtime.newItems = run.newItems
    }
    if (stopped) break
  }

  const finishedAt = new Date().toISOString()
  run.finishedAt = finishedAt
  const failed = run.tasks.filter((task) => task.status === 'failed').length
  run.status = failed === 0 ? 'ok' : run.newItems > 0 || failed < run.tasks.length ? 'partial' : 'failed'
  if (stopped) run.errors.push(stopped)
  runtime.status = run.status
  runtime.current = ''

  // 用最新的盘上状态收尾：采集期间用户在面板里改的主题/渠道不会被覆盖。
  const db = getDb(ctx)
  db.insertRun(run)
  const pruned = db.prune(state.schedule.retainDays)
  const fresh = readStateSafe(ctx)
  for (const [channelId, patch] of channelUpdates) {
    const channel = fresh.channels.find((item) => item.id === channelId)
    if (channel) Object.assign(channel, patch)
  }
  fresh.schedule.lastRunAt = finishedAt
  fresh.schedule.lastRunStatus = run.status
  fresh.schedule.lastRunId = run.id
  fresh.schedule.lastRunNew = run.newItems
  for (const topic of fresh.topics) {
    const count = collected.filter((item) => item.topicId === topic.id).length
    if (count > 0) topic.lastCount = count
  }
  saveStateSafe(ctx, fresh)

  const reportFile = writeReport(fresh, date)
  log(
    ctx,
    'info',
    `采集结束（${TRIGGER_LABELS[trigger] || trigger}）：新 ${run.newItems} 条 / 去重 ${run.duplicate} / 过滤 ${run.filtered}${reportFile ? `，报告 ${reportFile}` : ''}` +
      `${pruned.leads > 0 ? `；按保留天数清理 ${pruned.leads} 条旧线索` : ''}`,
  )
  return run
}

/** 启动一次采集；已有运行在跑时返回 started=false。 */
export function startRun(ctx, trigger = 'manual') {
  if (running) return { started: false, runId: runtime ? runtime.runId : '', progress: snapshotRuntime() }
  // 没有任何可采集的渠道时不要留下一条「成功、0 条」的空运行记录。
  const plan = planRun(readStateSafe(ctx))
  if (plan.length === 0) {
    return { started: false, skipped: true, reason: '没有可采集的渠道（确认渠道已启用，且主题关联了它们）', runId: '', progress: null }
  }
  const runId = newId('run')
  runtime = {
    runId,
    startedAt: new Date().toISOString(),
    trigger,
    total: 0,
    done: 0,
    newItems: 0,
    status: 'running',
    current: '',
  }
  running = executeRun(ctx, { runId, trigger })
    .catch((error) => {
      log(ctx, 'warn', `采集失败：${error && error.message ? error.message : error}`)
      return null
    })
    .finally(() => {
      running = null
      runtime = null
      armTimer(ctx)
    })
  return { started: true, runId, progress: snapshotRuntime() }
}

/** 等一次采集结束：最多等 timeoutMs，超时按「仍在跑」返回。 */
async function runAndWait(ctx, trigger, timeoutMs) {
  const started = startRun(ctx, trigger)
  if (!started.started) return { started: false, skipped: Boolean(started.skipped), reason: started.reason, progress: started.progress }
  const deadline = Date.now() + Math.max(1000, timeoutMs)
  while (running && Date.now() < deadline) {
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 300)
      t.unref?.()
    })
  }
  return { started: true, runId: started.runId, finished: !running, run: getDb(ctx).lastRun(), progress: snapshotRuntime() }
}

// ------------------------------------------------------------------ 定时器
function clearTimer() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

/** 按当前配置重新安排下一次采集。每次只睡最多 30 分钟，避免休眠/改时钟后错过整点。 */
export function armTimer(ctx) {
  clearTimer()
  const state = readStateSafe(ctx)
  if (!state.schedule.enabled) return
  const next = nextRunAt(state.schedule, new Date())
  if (!next) return
  const delay = Math.max(1000, Math.min(next.getTime() - Date.now(), 30 * 60 * 1000))
  timer = setTimeout(() => {
    timer = null
    if (Date.now() >= next.getTime() - 60000) {
      if (!running) startRun(ctx, 'auto')
      else armTimer(ctx)
    } else {
      armTimer(ctx)
    }
  }, delay)
  timer.unref?.()
}

/** 启动补采：错过当天的时间点（含首次安装）时补一次。 */
function scheduleCatchUp(ctx) {
  const state = readStateSafe(ctx)
  if (!state.schedule.enabled || !state.schedule.catchUp) return null
  if (state.channels.filter((channel) => channel.enabled).length === 0) return null
  const due = lastDueAt(state.schedule, new Date())
  if (!due) return null
  const last = Date.parse(state.schedule.lastRunAt || '')
  if (Number.isFinite(last) && last >= due.getTime()) return null
  const handle = setTimeout(() => {
    if (!running) startRun(ctx, 'startup')
  }, CATCH_UP_DELAY_MS)
  handle.unref?.()
  return handle
}

// ------------------------------------------------------------------ 结果与展示
/** 把 HTTP/工具参数归一成数据库查询条件，保证列表、分页、导出用同一套筛选。 */
function queryOf(options = {}) {
  return {
    page: options.page,
    pageSize: options.pageSize || options.limit,
    q: options.q || options.keyword,
    date: options.date,
    dateFrom: options.dateFrom,
    dateTo: options.dateTo,
    topic: options.topic,
    channel: options.channel,
    region: options.region,
    hasPhone: options.hasPhone,
    sync: options.sync,
    todayDate: options.todayDate,
    sort: options.sort,
  }
}

/** 线索的展示形态：电话加空格更好读，来源链接固定挂在 sourceUrl。 */
function presentLead(item) {
  return {
    id: item.id,
    company: item.company,
    contact: item.contact,
    phone: prettyPhone(item.phone),
    phoneDigits: normalizePhone(item.phone),
    region: item.region,
    note: item.note,
    title: item.title,
    sourceUrl: item.sourceUrl,
    sourceName: item.channelName,
    channelId: item.channelId,
    topicId: item.topicId,
    topicName: item.topicName,
    date: item.date,
    publishedAt: item.publishedAt,
    fetchedAt: item.fetchedAt,
    crmId: item.crmId || '',
    syncState: item.syncState || '',
  }
}

const SCOPE_UNKNOWN_LABELS = {
  smart: '地区识别不出来时，按公司/标题里的城市智能判断',
  keep: '地区识别不出来时也保留（更全，可能混入外地）',
  drop: '地区识别不出来时丢弃（最严）',
}

/** 采集范围展示：地区列表 + 展开后的匹配关键词（内蒙古会展开成 12 盟市与旗县）。 */
function presentScope(scope) {
  const keywords = expandRegions(scope.regions)
  const mode = ['smart', 'keep', 'drop'].includes(scope.unknown) ? scope.unknown : 'smart'
  return {
    regions: scope.regions,
    unknown: mode,
    unknownLabel: SCOPE_UNKNOWN_LABELS[mode],
    keywords,
    label: scope.regions.length > 0 ? scope.regions.join('、') : '不限地区',
    summary:
      scope.regions.length > 0
        ? `${scope.regions.join('、')}（共 ${keywords.length} 个城市/地区关键词）；${SCOPE_UNKNOWN_LABELS[mode]}`
        : '不限地区（所有城市的线索都会收录）',
  }
}

function presentSchedule(schedule) {
  const next = nextRunAt(schedule, new Date())
  return {
    ...schedule,
    nextRunAt: next ? next.toISOString() : '',
    nextRunLabel: next ? formatInZone(next, schedule.timeZone) : '',
    lastRunLabel: schedule.lastRunAt ? formatInZone(new Date(schedule.lastRunAt), schedule.timeZone) : '',
    lastRunStatusLabel: schedule.lastRunStatus ? STATUS_LABELS[schedule.lastRunStatus] || schedule.lastRunStatus : '',
    timeZoneLabel: schedule.timeZone === DEFAULT_TIME_ZONE ? '北京时间' : schedule.timeZone,
  }
}

function presentChannel(channel, topics, timeZone = DEFAULT_TIME_ZONE) {
  const watchers = topics.filter((topic) => topic.channelIds.length === 0 || topic.channelIds.includes(channel.id))
  return {
    ...channel,
    typeLabel: CHANNEL_TYPE_LABELS[channel.type] || channel.type,
    topicIds: watchers.map((topic) => topic.id),
    topicNames: watchers.map((topic) => topic.name),
    lastRunLabel: channel.lastRunAt ? formatInZone(new Date(channel.lastRunAt), timeZone) : '',
    statusLabel: channel.lastStatus ? STATUS_LABELS[channel.lastStatus] || channel.lastStatus : '',
    lastLeadsLabel: channel.lastStatus ? `${channel.lastCount} 条线索 · ${channel.lastWithPhone || 0} 条有电话` : '',
  }
}

function presentTopic(topic, channels) {
  const names = topic.channelIds.map((id) => {
    const found = channels.find((channel) => channel.id === id)
    return found ? found.name : ''
  })
  return {
    ...topic,
    channelNames: names.filter(Boolean),
    scopeLabel: topic.channelIds.length === 0 ? '全部渠道' : names.filter(Boolean).join('、') || '（渠道已删除）',
  }
}

function describeState(ctx, state = readStateSafe(ctx)) {
  const today = dateKeyInZone(new Date(), state.schedule.timeZone)
  const db = getDb(ctx)
  const topics = state.topics.map((topic) => presentTopic(topic, state.channels))
  const channels = state.channels.map((channel) => presentChannel(channel, state.topics, state.schedule.timeZone))
  const counts = db.stats(today)
  const runs = db.listRuns(12)
  const fileInfo = db.fileInfo()
  return {
    ok: true,
    version: PLUGIN_VERSION,
    dataDir: DATA_DIR,
    dataFile: STATE_FILE,
    dbFile: DB_FILE,
    dbBytes: fileInfo.bytes,
    reportDir: REPORT_DIR,
    topics,
    channels,
    scope: presentScope(state.scope),
    schedule: presentSchedule(state.schedule),
    stats: {
      topics: state.topics.length,
      channels: state.channels.length,
      enabledChannels: state.channels.filter((channel) => channel.enabled).length,
      itemsTotal: counts.total,
      itemsToday: counts.today,
      withPhoneTotal: counts.withPhone,
      withPhoneToday: counts.todayWithPhone,
      today,
      dates: db.dates().slice(0, 60),
      lastRun: runs[0] || null,
    },
    runs,
    pageSize: DEFAULT_PAGE_SIZE,
    crm: state.crm,
    crmAvailable: crmReady(),
    runtime: snapshotRuntime(),
    limits: {
      taskLimit: TASK_LIMIT,
      maxResultLimit: MAX_RESULT_LIMIT,
      channelTypes: CHANNEL_TYPES,
      maxDetailsPerRun: MAX_DETAILS_PER_RUN,
      pageSizes: [20, 50, 100],
    },
  }
}

// ------------------------------------------------------------------ 报告与导出
/** 采集时间统一按配置时区展示（Excel / Markdown / 面板一致）。 */
function whenText(state, value) {
  const date = new Date(String(value || ''))
  if (Number.isNaN(date.getTime())) return String(value || '')
  const timeZone = state && state.schedule ? state.schedule.timeZone : DEFAULT_TIME_ZONE
  return formatInZone(date, timeZone)
}

/** 导出列（Excel 表头 → 取值）。 */
const EXPORT_COLUMNS = [
  { header: '公司名称', width: 34 },
  { header: '联系人', width: 12 },
  { header: '联系电话', width: 16 },
  { header: '地区', width: 20 },
  { header: '备注', width: 46 },
  { header: '来源网址', width: 46 },
  { header: '采集时间', width: 18 },
  { header: '主题', width: 16 },
  { header: '渠道', width: 20 },
]

function exportRows(state, rows) {
  return rows.map((item) => [
    item.company,
    item.contact,
    prettyPhone(item.phone),
    item.region,
    item.note,
    item.sourceUrl,
    whenText(state, item.fetchedAt),
    item.topicName,
    item.channelName,
  ])
}

/** Excel（.xlsx）：真正的 xlsx 文件，表头加粗、冻结首行、带自动筛选。 */
function xlsxFor(state, rows) {
  return buildXlsx({
    sheetName: '线索',
    columns: EXPORT_COLUMNS.map((col) => ({ header: col.header, width: col.width })),
    rows: exportRows(state, rows),
  })
}

/** Markdown（人看）：按主题分组列线索表格。 */
function markdownFor(state, rows, options = {}) {
  const date = textOf(options.date)
  const scope = date || '全部日期'
  const filters = []
  if (options.topic) {
    const found = state.topics.find((topic) => topic.id === options.topic)
    filters.push(`主题：${found ? found.name : options.topic}`)
  }
  const keyword = textOf(options.keyword || options.q)
  if (keyword) filters.push(`关键词：${keyword}`)
  if (textOf(options.channel)) filters.push(`渠道：${options.channel}`)
  const groups = new Map()
  for (const item of rows) {
    const key = item.topicName || '未分类'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }
  const withPhone = rows.filter((item) => item.phone).length
  const lines = []
  lines.push(`# 意向客户 · ${scope}`)
  lines.push('')
  lines.push(
    `> 共 ${rows.length} 条线索（${withPhone} 条有电话）${filters.length > 0 ? `（${filters.join(' / ')}）` : ''} · 由 DSH「市场线索」生成（${formatInZone(new Date(), state.schedule.timeZone)}）`,
  )
  lines.push('')
  if (rows.length === 0) {
    lines.push('没有符合条件的线索。')
    lines.push('')
  }
  for (const [topicName, items] of groups) {
    lines.push(`## ${topicName}（${items.length} 条）`)
    lines.push('')
    lines.push('| 公司名称 | 联系人 | 联系电话 | 地区 | 备注（网址来源） | 采集时间 |')
    lines.push('| --- | --- | --- | --- | --- | --- |')
    for (const item of items) {
      const note = [item.note, item.sourceUrl].filter(Boolean).join(' — ').replace(/\|/g, '｜')
      const when = whenText(state, item.fetchedAt)
      lines.push(
        `| ${(item.company || item.title || '').replace(/\|/g, '｜')} | ${item.contact || ''} | ${prettyPhone(item.phone) || ''} | ${item.region || ''} | ${note} | ${when} |`,
      )
    }
    lines.push('')
  }
  return lines.join('\n')
}

function writeReport(state, date) {
  try {
    const rows = getDb({}).exportLeads({ date })
    fs.mkdirSync(REPORT_DIR, { recursive: true, mode: 0o700 })
    const file = path.join(REPORT_DIR, `${date}.md`)
    fs.writeFileSync(file, `${markdownFor(state, rows, { date })}\n`, { encoding: 'utf8', mode: 0o600 })
    return file
  } catch {
    return ''
  }
}

// ------------------------------------------------------------------ 写操作
class CollectorError extends Error {
  constructor(code, message, hint) {
    super(message)
    this.code = code
    this.hint = hint
  }
}

function findTopic(state, ref) {
  const text = textOf(ref)
  if (!text) return undefined
  return state.topics.find((topic) => topic.id === text) || state.topics.find((topic) => topic.name === text)
}

function findChannel(state, ref) {
  const text = textOf(ref)
  if (!text) return undefined
  return state.channels.find((channel) => channel.id === text) || state.channels.find((channel) => channel.name === text)
}

function saveTopic(ctx, input) {
  const state = readStateSafe(ctx)
  const patch = input && typeof input === 'object' ? input : {}
  const reference = textOf(patch.id) || textOf(patch.ref)
  const existing = reference
    ? findTopic(state, reference)
    : state.topics.find((topic) => topic.name === textOf(patch.name))
  if (reference && !existing) throw new CollectorError('not_found', `没有找到主题「${reference}」`, '用 action="list" 看现有主题名。')
  const topic = normalizeTopic(patch, existing)
  topic.name = textOf(topic.name)
  if (!topic.name) throw new CollectorError('bad_args', '主题需要一个名字', '至少填 data.name。')
  if (!topic.keywords.length) throw new CollectorError('bad_args', '主题需要至少一个关键词', '关键词决定哪些采集条目算这个主题，例如「应急演练、消防、预案」。')
  // 允许用渠道名来指定 channelIds（Agent 与面板都方便）
  if (patch.channels !== undefined) {
    const names = listOf(patch.channels)
    const resolved = names.map((item) => {
      const found = findChannel(state, item)
      if (!found) throw new CollectorError('not_found', `没有找到渠道「${item}」`, '先用 action="list" 看现有渠道名。')
      return found.id
    })
    topic.channelIds = resolved
  }
  for (const id of topic.channelIds) {
    if (!state.channels.some((channel) => channel.id === id)) {
      throw new CollectorError('not_found', `主题引用了不存在的渠道 ${id}`, '刷新面板后重试，或先创建渠道。')
    }
  }
  const duplicated = state.topics.find((item) => item.name === topic.name && item.id !== (existing ? existing.id : ''))
  if (duplicated) throw new CollectorError('duplicated', `已经有一个叫「${topic.name}」的主题`, '换个名字，或直接编辑那一个。')
  if (existing) {
    topic.id = existing.id
    topic.createdAt = existing.createdAt || new Date().toISOString()
    topic.updatedAt = new Date().toISOString()
    const index = state.topics.findIndex((item) => item.id === existing.id)
    state.topics[index] = topic
  } else {
    topic.id = newId('topic')
    topic.createdAt = new Date().toISOString()
    topic.updatedAt = topic.createdAt
    if (state.topics.length >= 50) throw new CollectorError('too_many', '主题数量已达上限 50 个', '删掉不用的主题再试。')
    state.topics.push(topic)
  }
  return { topic, state: saveStateSafe(ctx, state), created: !existing }
}

function deleteTopic(ctx, ref) {
  const state = readStateSafe(ctx)
  const topic = findTopic(state, ref)
  if (!topic) throw new CollectorError('not_found', `没有找到主题「${textOf(ref)}」`, '用 action="list" 看现有主题名。')
  state.topics = state.topics.filter((item) => item.id !== topic.id)
  const removedLeads = getDb(ctx).deleteLeadsByTopic(topic.id)
  return { topic, removedLeads, state: saveStateSafe(ctx, state) }
}

function saveChannel(ctx, input) {
  const state = readStateSafe(ctx)
  const patch = input && typeof input === 'object' ? input : {}
  const reference = textOf(patch.id) || textOf(patch.ref)
  const existing = reference
    ? findChannel(state, reference)
    : state.channels.find((channel) => channel.name === textOf(patch.name))
  if (reference && !existing) throw new CollectorError('not_found', `没有找到渠道「${reference}」`, '用 action="list" 看现有渠道名。')
  const channel = normalizeChannel(patch, existing)
  channel.name = textOf(channel.name)
  if (!channel.name) throw new CollectorError('bad_args', '渠道需要一个名字', '至少填 data.name。')
  if (!CHANNEL_TYPES.includes(channel.type)) {
    throw new CollectorError('bad_args', `不支持的渠道类型：${channel.type}`, `可选：${CHANNEL_TYPES.join(' / ')}。`)
  }
  // 搜索渠道不强制填查询词：留空时用主题关键词去搜（本次运行没有主题关键词才会失败）。
  if (channel.type !== 'search') {
    if (!channel.url) {
      throw new CollectorError('bad_args', '这个渠道需要一个 URL', '填 data.url，例如 https://www.example.com/feed.xml。')
    }
    if (!/^https?:\/\//i.test(channel.url)) {
      throw new CollectorError('bad_args', 'URL 需要以 http:// 或 https:// 开头', `收到的是「${channel.url}」。`)
    }
  }
  if (channel.type === 'html' && channel.linkPattern) {
    try {
      new RegExp(channel.linkPattern)
    } catch {
      throw new CollectorError('bad_args', '链接过滤正则不合法', '例如 /tzgg/ 或 news\\.html。')
    }
  }
  const duplicated = state.channels.find((item) => item.name === channel.name && item.id !== (existing ? existing.id : ''))
  if (duplicated) throw new CollectorError('duplicated', `已经有一个叫「${channel.name}」的渠道`, '换个名字，或直接编辑那一个。')
  if (existing) {
    channel.id = existing.id
    channel.createdAt = existing.createdAt || new Date().toISOString()
    channel.updatedAt = new Date().toISOString()
    const index = state.channels.findIndex((item) => item.id === existing.id)
    state.channels[index] = channel
  } else {
    channel.id = newId('channel')
    channel.createdAt = new Date().toISOString()
    channel.updatedAt = channel.createdAt
    if (state.channels.length >= 60) throw new CollectorError('too_many', '渠道数量已达上限 60 个', '删掉不用的渠道再试。')
    state.channels.push(channel)
  }
  return { channel, state: saveStateSafe(ctx, state), created: !existing }
}

function deleteChannel(ctx, ref) {
  const state = readStateSafe(ctx)
  const channel = findChannel(state, ref)
  if (!channel) throw new CollectorError('not_found', `没有找到渠道「${textOf(ref)}」`, '用 action="list" 看现有渠道名。')
  state.channels = state.channels.filter((item) => item.id !== channel.id)
  for (const topic of state.topics) topic.channelIds = topic.channelIds.filter((id) => id !== channel.id)
  return { channel, state: saveStateSafe(ctx, state) }
}

/** 删除单条线索。 */
function deleteLead(ctx, id) {
  const reference = textOf(id)
  if (!reference) throw new CollectorError('bad_args', '缺少要删除的线索 id', '面板里每行都有删除按钮；工具调用传 id。')
  const removed = getDb(ctx).deleteLead(reference)
  if (removed === 0) throw new CollectorError('not_found', `没有找到线索 ${reference}`, '刷新列表后再试。')
  return { removed, id: reference }
}

/** 清空线索（配置、运行记录保留）：改完关键词想重新采一遍时用。 */
function clearResults(ctx) {
  const db = getDb(ctx)
  const removed = db.clearLeads()
  return { removed, state: readStateSafe(ctx) }
}

// ------------------------------------------------------------------ 写入 CRM（内置 Cordys 客户端）
/** 是否已配置 CRM（内置客户端，不再依赖独立 Cordys 插件）。 */
function crmReady() {
  try {
    return crmConfigured(loadCrmConfig())
  } catch {
    return false
  }
}

function crmUnavailable() {
  return new CollectorError('crm_unavailable', 'CRM 还没有配置', '在「市场线索 → CRM」页填服务器地址与 Access Key / Secret Key 并保存。')
}

/** 从 /lead-pool/page 或 /product/page 的返回里取列表（兼容不同包装）。 */
function arrayOf(payload, depth = 0) {
  if (!payload || depth > 3) return []
  if (Array.isArray(payload)) return payload
  const data = payload.data !== undefined ? payload.data : payload
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object') {
    for (const key of ['records', 'list', 'rows', 'items', 'data']) {
      if (Array.isArray(data[key])) return data[key]
    }
    for (const key of ['records', 'list', 'rows', 'items', 'data']) {
      if (data[key] && typeof data[key] === 'object') {
        const nested = arrayOf(data[key], depth + 1)
        if (nested.length > 0) return nested
      }
    }
    return []
  }
  return []
}

function pickId(payload) {
  if (!payload) return ''
  const data = payload.data !== undefined ? payload.data : payload
  if (Array.isArray(data)) return data[0] && data[0].id ? String(data[0].id) : ''
  return String(data.id || (data.clue && data.clue.id) || '')
}

async function crmOptions(ctx) {
  const state = readStateSafe(ctx)
  const listed = await crmListOptions()
  const config = loadCrmConfig()
  return {
    ok: true,
    configured: listed.configured,
    writable: listed.configured && listed.readOnly === false,
    baseUrl: config.baseUrl || '',
    readOnly: listed.readOnly !== false,
    pools: listed.pools || [],
    products: listed.products || [],
    crm: state.crm,
    hint: listed.configured ? '' : 'CRM 还没有配置：到「CRM」页填服务器地址与 API Key。',
  }
}

/** 关键字在 CRM 里查一遍：全局搜索 + 每个线索池（池里的线索全局搜索看不到）。 */
async function crmSearchHits(keyword, pools = []) {
  const text = textOf(keyword)
  if (!text) return []
  const hits = []
  const groups = await crmSearch(text)
  for (const group of groups) {
    const first = (group.list && group.list[0]) || {}
    hits.push({ target: group.target, total: Number(group.total) || 0, id: String(first.id || ''), sample: first.name || first.companyName || '' })
  }
  for (const pool of pools) {
    if (!pool || !pool.id) continue
    try {
      const page = await crmPoolPage(pool.id, text, 5)
      if (page.total > 0) {
        const sample = page.list[0] || {}
        hits.push({ target: 'pool-lead', total: page.total, id: String(sample.id || ''), sample: sample.name || pool.name })
      }
    } catch {
      // 单个池查询失败不影响其它池
    }
  }
  return hits
}

/**
 * 逐条预检：无手机号 / 手机号命中 / 公司名命中 / 可写入。
 * 规则：任意一次查询有记录即视为重复，不允许导入。
 * 重复的线索会顺手在本地标记为「已同步」（CRM 里已有），避免以后反复勾选/写入。
 */
async function crmPrecheck(ctx, ids) {
  if (!crmReady()) throw crmUnavailable()
  const db = getDb(ctx)
  const list = Array.isArray(ids) ? ids.map((id) => textOf(id)).filter(Boolean) : []
  if (list.length === 0) throw new CollectorError('bad_args', '没有选中线索', '先在「线索」页勾选要写入的线索。')
  if (list.length > 100) throw new CollectorError('bad_args', '一次最多预检 100 条', '分批勾选。')
  // 线索池里的线索全局搜索查不到，必须单独按池查
  let pools = []
  try {
    pools = (await crmListOptions()).pools || []
  } catch {
    pools = []
  }
  const items = []
  for (const id of list) {
    const lead = db.getLead(id)
    if (!lead) {
      items.push({ id, status: 'missing', name: '', phone: '', hits: [] })
      continue
    }
    const { phone, name } = dedupeKeys(lead)
    const label = lead.company || lead.title || ''
    if (!phone) {
      items.push({ id, name: label, phone: '', status: 'no_phone', hits: [] })
      continue
    }
    if (lead.syncState === 'synced') {
      items.push({ id, name: label, phone, status: 'synced', hits: [], crmId: lead.crmId })
      continue
    }
    const phoneHits = await crmSearchHits(phone, pools)
    const nameHits = phoneHits.length > 0 ? [] : name ? await crmSearchHits(name, pools) : []
    if (phoneHits.length > 0 || nameHits.length > 0) {
      const hits = phoneHits.length > 0 ? phoneHits : nameHits
      // CRM 里已存在：本地标记已同步，后续不再出现在可勾选/可写入范围里
      db.updateSync(id, { crmId: hits[0].id || '', state: 'synced', at: new Date().toISOString() })
      items.push({ id, name: label, phone, status: phoneHits.length > 0 ? 'dup_phone' : 'dup_name', hits, marked: true })
      continue
    }
    items.push({ id, name: label, phone, status: 'ok', hits: [] })
  }
  const count = (status) => items.filter((item) => item.status === status).length
  return {
    ok: true,
    items,
    total: items.length,
    ready: count('ok'),
    duplicated: count('dup_phone') + count('dup_name') + count('synced'),
    noPhone: count('no_phone'),
    missing: count('missing'),
  }
}

/** 逐条写入：/lead/add 建线索 → 移入指定线索池 → 回写同步状态。 */
async function crmPush(ctx, ids) {
  if (!crmReady()) throw crmUnavailable()
  const state = readStateSafe(ctx)
  if (!state.crm.poolId) {
    throw new CollectorError('bad_args', '还没有选择线索池', '在「线索」页的 CRM 面板里选一个线索池并保存。')
  }
  const precheck = await crmPrecheck(ctx, ids)
  const db = getDb(ctx)
  const results = []
  let created = 0
  for (const item of precheck.items) {
    if (item.status !== 'ok') {
      results.push(item)
      continue
    }
    const lead = db.getLead(item.id)
    const payload = leadPayload(lead, {
      products: state.crm.productId ? [state.crm.productId] : [],
      owner: state.crm.owner || undefined,
    })
    try {
      const outcome = await crmCreateLead(payload, state.crm.poolId)
      const crmId = outcome.id
      if (!crmId) {
        db.updateSync(item.id, { state: 'failed' })
        results.push({ ...item, status: 'failed', error: '创建线索失败：CRM 未返回 id' })
        continue
      }
      db.updateSync(item.id, { crmId, state: 'synced', at: new Date().toISOString() })
      created += 1
      results.push({ ...item, status: 'synced', crmId, error: '' })
    } catch (error) {
      db.updateSync(item.id, { state: 'failed' })
      results.push({ ...item, status: 'failed', error: String((error && error.message) || error) })
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 250)
      timer.unref?.()
    })
  }
  return { ok: true, items: results, created, failed: results.filter((item) => item.status === 'failed').length, state: describeState(ctx) }
}

/** 保存 CRM 写入默认值（线索池 / 产品 / 负责人）。 */
function saveCrmConfig(ctx, input) {
  const state = readStateSafe(ctx)
  state.crm = normalizeCrm(input || {}, state.crm)
  const saved = saveStateSafe(ctx, state)
  return { crm: saved.crm, state: saved }
}

/** 保存 CRM 连接配置（地址 / Key / 只读）；Key 留空表示保持不变。 */
function saveCrmConnection(ctx, input) {
  const source = input && typeof input === 'object' ? input : {}
  const current = loadCrmConfig()
  const next = {
    baseUrl: textOf(source.baseUrl) || current.baseUrl,
    accessKey: textOf(source.accessKey) || current.accessKey,
    secretKey: textOf(source.secretKey) || current.secretKey,
    organizationId: source.organizationId === undefined ? current.organizationId : textOf(source.organizationId),
    readOnly: source.readOnly === undefined ? current.readOnly : source.readOnly === true || source.readOnly === 'true',
    timeoutMs: source.timeoutMs || current.timeoutMs,
  }
  const saved = crmFileSave(next)
  return { crm: maskCrmConfig(saved), state: describeState(ctx) }
}

/** 保存采集范围（地区）。regions 为空 = 不限地区。 */
function saveScope(ctx, input) {
  const state = readStateSafe(ctx)
  const source = input && typeof input === 'object' ? input : {}
  const next = normalizeScope(source, state.scope)
  if (next.regions.length > 20) throw new CollectorError('bad_args', '地区最多 20 个', '用省/市名称，多个用顿号分隔。')
  state.scope = next
  const saved = saveStateSafe(ctx, state)
  return { scope: saved.scope, state: saved }
}

function saveSchedule(ctx, input) {
  const state = readStateSafe(ctx)
  const patch = input && typeof input === 'object' ? input : {}
  if (patch.time !== undefined && !parseClock(patch.time)) {
    throw new CollectorError('bad_args', `时间格式不对：${textOf(patch.time)}`, '用 HH:mm（24 小时制），例如 07:30。')
  }
  if (patch.timeZone !== undefined && !isValidTimeZone(textOf(patch.timeZone))) {
    throw new CollectorError('bad_args', `不认识的时区：${textOf(patch.timeZone)}`, '用 IANA 名称，例如 Asia/Shanghai。')
  }
  state.schedule = normalizeSchedule(patch, state.schedule)
  const saved = saveStateSafe(ctx, state)
  armTimer(ctx)
  return { schedule: saved.schedule, state: saved }
}

function assertChannelRunnable(channel) {
  if (channel.type === 'search') return
  if (!channel.url) throw new CollectorError('bad_args', '渠道没有填 URL', '填上链接再测试。')
  if (!/^https?:\/\//i.test(channel.url)) throw new CollectorError('bad_args', 'URL 需要以 http:// 或 https:// 开头', `收到的是「${channel.url}」。`)
}

/** 名录类接口直接给了公司/联系人/电话/地区时，用它覆盖启发式结果。 */
function withDirectFields(lead, raw) {
  if (!raw || (!raw.company && !raw.phone && !raw.contact)) return lead
  return {
    ...lead,
    company: textOf(raw.company) || lead.company,
    contact: textOf(raw.contact) || lead.contact,
    phone: normalizePhone(raw.phone) || lead.phone,
    region: textOf(raw.region).replace(/[-–—]/g, '') || lead.region,
  }
}

/** 测试一个渠道（已保存的用 id，未保存的直接传草稿）：抓一次并识别成线索样例。 */
async function testChannel(ctx, input) {
  const state = readStateSafe(ctx)
  const ref = textOf(input && (input.id || input.ref || input.name))
  const existing = ref ? findChannel(state, ref) : undefined
  const channel = normalizeChannel({ ...(existing || {}), ...(input && input.channel ? input.channel : input || {}) }, existing)
  assertChannelRunnable(channel)
  const startedAt = Date.now()
  try {
    const parsed = await fetchChannelItems(ctx, channel, { timeoutMs: RUN_TASK_TIMEOUT_MS })
    const leads = []
    let details = 0
    const detailLimit = Math.min(Number(channel.detailLimit) || 0, 2)
    for (const raw of parsed.items.slice(0, 20)) {
      let lead = extractLead({ title: raw.title, summary: raw.summary, defaultRegion: channel.region })
      lead = withDirectFields(lead, raw)
      if (channel.followDetail !== false && raw.url && details < detailLimit && isIncomplete(lead)) {
        details += 1
        try {
          const response = await fetchText(ctx, raw.url, { timeoutMs: DETAIL_TIMEOUT_MS })
          lead = mergeLeads(lead, extractLead({ title: raw.title, detail: stripTags(response.text), defaultRegion: channel.region }))
        } catch {
          // 详情页打不开就只用列表页信息
        }
      }
      leads.push({ ...lead, title: raw.title, sourceUrl: raw.url, publishedAt: raw.publishedAt })
    }
    return {
      success: true,
      channelId: channel.id,
      name: channel.name,
      type: channel.type,
      count: parsed.items.length,
      leadCount: leads.length,
      withPhone: leads.filter((lead) => lead.phone).length,
      details,
      ms: Date.now() - startedAt,
      samples: leads.slice(0, 5).map((lead) => ({
        company: lead.company,
        contact: lead.contact,
        phone: prettyPhone(lead.phone),
        region: lead.region,
        sourceUrl: lead.sourceUrl,
        title: lead.title,
        publishedAt: lead.publishedAt || '',
      })),
      note: parsed.note,
    }
  } catch (error) {
    return {
      success: false,
      channelId: channel.id,
      name: channel.name,
      type: channel.type,
      ms: Date.now() - startedAt,
      message: String(error && error.message ? error.message : error),
    }
  }
}

// ------------------------------------------------------------------ Agent 工具
function summarizeForAgent(ctx, state = readStateSafe(ctx)) {
  const db = getDb(ctx)
  const today = dateKeyInZone(new Date(), state.schedule.timeZone)
  const counts = db.stats(today)
  const fileInfo = db.fileInfo()
  return {
    ok: true,
    topics: state.topics.map((topic) => presentTopic(topic, state.channels)),
    channels: state.channels.map((channel) => ({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      typeLabel: CHANNEL_TYPE_LABELS[channel.type] || channel.type,
      url: channel.url,
      query: channel.query,
      enabled: channel.enabled,
      lastStatus: channel.lastStatus,
      lastCount: channel.lastCount,
      lastError: channel.lastError,
      topicNames: presentChannel(channel, state.topics, state.schedule.timeZone).topicNames,
    })),
    schedule: presentSchedule(state.schedule),
    scope: presentScope(state.scope),
    stats: {
      itemsTotal: counts.total,
      itemsToday: counts.today,
      withPhoneTotal: counts.withPhone,
      lastRun: db.lastRun(),
      dates: db.dates().slice(0, 14),
    },
    storage: { engine: 'sqlite', file: DB_FILE, bytes: fileInfo.bytes },
    runtime: snapshotRuntime(),
    dataFile: STATE_FILE,
    reportDir: REPORT_DIR,
  }
}

/** 工具参数里的 data 可能被序列化成字符串传进来（不同调用方行为不同），这里统一解析。 */
function readDataArg(args) {
  const raw = args ? args.data : undefined
  if (raw === null || raw === undefined) return {}
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  return typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
}

/** 顶层扁平字段与 data 合并：两种写法都支持，扁平字段优先。 */
const FLAT_FIELDS = [
  'type',
  'url',
  'query',
  'keywords',
  'channels',
  'regions',
  'unknown',
  'keepUnknown',
  'notes',
  'time',
  'timeZone',
  'enabled',
  'catchUp',
  'retainDays',
  'maxItemsPerRun',
  'detailLimit',
  'followDetail',
  'region',
  'linkPattern',
  'itemPath',
  'note',
]

function collectData(args) {
  const merged = { ...readDataArg(args) }
  for (const key of FLAT_FIELDS) {
    if (args && args[key] !== undefined) merged[key] = args[key]
  }
  // limit 在 results 里是返回条数，在渠道里是每次取多少条
  if (args && args.limit !== undefined && merged.limit === undefined && textOf(args.action) !== 'results') merged.limit = args.limit
  return merged
}

async function runTool(ctx, args) {
  const action = textOf(args && args.action)
  const data = collectData(args)
  if (action === 'status' || action === 'list') {
    return summarizeForAgent(ctx)
  }
  if (action === 'save_topic') {
    const result = saveTopic(ctx, { ...data, id: args.id || data.id, name: args.name || data.name, keywords: data.keywords ?? args.keywords, channels: data.channels })
    const state = result.state
    return {
      ok: true,
      created: result.created,
      topic: presentTopic(result.topic, state.channels),
      hint: result.created ? '主题已创建。下一步可以 action="run" 立刻跑一次看看能采到什么。' : '主题已更新。',
    }
  }
  if (action === 'delete_topic') {
    const result = deleteTopic(ctx, args.id || args.name || data.id || data.name)
    return { ok: true, deleted: result.topic.name, topics: result.state.topics.length }
  }
  if (action === 'save_channel') {
    const result = saveChannel(ctx, { ...data, id: args.id || data.id, name: args.name || data.name, url: data.url || args.url, type: data.type || args.type, query: data.query || args.query })
    const state = result.state
    return {
      ok: true,
      created: result.created,
      channel: presentChannel(result.channel, state.topics, state.schedule.timeZone),
      hint: '渠道已保存。可用 action="test_channel" 先验证能不能解析出条目。',
    }
  }
  if (action === 'delete_channel') {
    const result = deleteChannel(ctx, args.id || args.name || data.id || data.name)
    return { ok: true, deleted: result.channel.name, channels: result.state.channels.length }
  }
  if (action === 'set_schedule') {
    const result = saveSchedule(ctx, { ...data })
    return { ok: true, schedule: presentSchedule(result.schedule), hint: '定时任务已更新，下一次触发时间见 nextRunLabel。' }
  }
  if (action === 'set_scope') {
    const patch = {}
    if (data.regions !== undefined) patch.regions = data.regions
    if (args.regions !== undefined) patch.regions = args.regions
    if (data.unknown !== undefined) patch.unknown = data.unknown
    if (args.unknown !== undefined) patch.unknown = args.unknown
    if (data.keepUnknown !== undefined) patch.keepUnknown = data.keepUnknown
    const result = saveScope(ctx, patch)
    return {
      ok: true,
      scope: presentScope(result.scope),
      hint: '采集范围已更新：只有地区命中范围的线索会入库；regions 为空表示不限地区。',
    }
  }
  if (action === 'test_channel') {
    return testChannel(ctx, { ...data, id: args.id || data.id, name: args.name || data.name })
  }
  if (action === 'clear_results') {
    const outcome = clearResults(ctx)
    return { ok: true, removed: outcome.removed, hint: `已清空 ${outcome.removed} 条线索与去重记录（配置与运行记录保留）。下次采集会重新收录当前页面上的线索。` }
  }
  if (action === 'delete_lead') {
    const outcome = deleteLead(ctx, args.id || data.id)
    return { ok: true, removed: outcome.removed, id: outcome.id, hint: '已删除这条线索；同名/同电话的线索以后再次被抓到时仍会重新入库（因为去重记录随线索一起删除）。' }
  }
  if (action === 'run') {
    const wait = args.wait !== false
    if (!wait) {
      const started = startRun(ctx, 'manual')
      return { ok: true, started: started.started, runId: started.runId, hint: '已开始采集，稍后用 action="status" 看进度。' }
    }
    const state = readStateSafe(ctx)
    if (planRun(state).length === 0) {
      throw new CollectorError('nothing_to_do', '没有可采集的渠道', '先在面板「渠道」页签添加启用的渠道，或确认主题关联了渠道。')
    }
    const outcome = await runAndWait(ctx, 'manual', 90000)
    return {
      ok: true,
      finished: outcome.finished,
      run: outcome.run,
      progress: outcome.progress,
      hint: outcome.finished ? '采集完成，线索可在 action="results" 或面板「线索」页签里看，CSV 导出也在那里。' : '采集还在进行，稍后用 action="status" 看进度，或直接 action="results"。',
    }
  }
  if (action === 'results') {
    const db = getDb(ctx)
    const stateForToday = readStateSafe(ctx)
    const query = queryOf({
      date: args.date || data.date,
      dateFrom: args.dateFrom || data.dateFrom,
      dateTo: args.dateTo || data.dateTo,
      topic: args.topic || data.topic,
      channel: args.channel || data.channel,
      q: args.keyword || args.q || data.keyword,
      hasPhone: args.hasPhone ?? data.hasPhone,
      sync: args.sync || data.sync,
      todayDate: dateKeyInZone(new Date(), stateForToday.schedule.timeZone),
      page: args.page || data.page,
      pageSize: args.pageSize || args.limit || data.pageSize || data.limit,
      sort: args.sort || data.sort,
    })
    const outcome = db.listLeads(query)
    return {
      ok: true,
      total: outcome.total,
      page: outcome.page,
      pageSize: outcome.pageSize,
      pages: outcome.pages,
      withPhone: outcome.items.filter((item) => item.phone).length,
      dates: db.dates().slice(0, 30),
      statusCounts: db.countBySync(),
      items: outcome.items.map((item) => ({
        company: item.company,
        contact: item.contact,
        phone: prettyPhone(item.phone),
        region: item.region,
        note: item.note,
        sourceUrl: item.sourceUrl,
        topic: item.topicName,
        channel: item.channelName,
        publishedAt: item.publishedAt,
        fetchedAt: item.fetchedAt,
        syncState: item.syncState,
      })),
      hint: '线索按采集时间倒序分页返回；page/pageSize 控制翻页，q 做全文检索（公司/联系人/电话/地区/备注/标题/来源），date/dateFrom/dateTo/topic/channel/hasPhone/sync 过滤（sync=unsynced/synced/failed/no_phone）。字段是自动识别的，可能有误，汇报时保留 sourceUrl 让用户核对。',
    }
  }
  if (action === 'crm_options') {
    return crmOptions(ctx)
  }
  if (action === 'crm_precheck' || action === 'crm_push') {
    const ids = Array.isArray(data.ids) ? data.ids : Array.isArray(args.ids) ? args.ids : []
    if (action === 'crm_precheck') return crmPrecheck(ctx, ids)
    const outcome = await crmPush(ctx, ids)
    return {
      ok: true,
      created: outcome.created,
      failed: outcome.failed,
      items: outcome.items.map((item) => ({ id: item.id, name: item.name, status: item.status, crmId: item.crmId || '', error: item.error || '' })),
      hint: '逐条写入线索池：ok 的行已写入并移入线索池；dup_phone / dup_name / synced 表示 CRM 已有记录，被拦截；failed 可重试。',
    }
  }
  if (action === 'set_crm') {
    const result = saveCrmConfig(ctx, data)
    return { ok: true, crm: result.crm, hint: 'CRM 写入配置已保存（线索池 / 意向产品 / 负责人）。' }
  }
  if (action === 'crm_status') {
    const config = loadCrmConfig()
    const probe = await crmProbe()
    return { ok: true, configured: crmConfigured(config), crm: maskCrmConfig(config), probe, configFile: CRM_CONFIG_FILE }
  }
  if (action === 'crm_connect') {
    const source = data && typeof data === 'object' ? data : {}
    const current = loadCrmConfig()
    const next = {
      baseUrl: textOf(source.baseUrl) || current.baseUrl,
      accessKey: textOf(source.accessKey) || current.accessKey,
      secretKey: textOf(source.secretKey) || current.secretKey,
      organizationId: source.organizationId === undefined ? current.organizationId : textOf(source.organizationId),
      readOnly: source.readOnly === undefined ? current.readOnly : source.readOnly === true || source.readOnly === 'true',
    }
    const probe = crmConfigured(next) ? await crmProbe() : null
    const saved = crmFileSave(next)
    return { ok: true, crm: maskCrmConfig(saved), probe, hint: 'CRM 连接配置已保存；probe.ok=true 表示连通且鉴权通过。' }
  }
  if (action === 'crm_search') {
    const keyword = textOf(args.keyword || data.keyword || data.q)
    if (!keyword) throw new CollectorError('bad_args', '缺少关键词', '传 keyword，例如公司名或手机号。')
    if (!crmReady()) throw crmUnavailable()
    return { ok: true, keyword, results: await crmSearch(keyword), hint: '命中条数按模块返回；池内线索不在全局搜索里，判重时会另行按池查。' }
  }
  throw new CollectorError('bad_action', `不认识的 action：${action}`, '支持 status / list / results / delete_lead / crm_options / crm_precheck / crm_push / crm_status / crm_connect / crm_search / set_crm / save_topic / delete_topic / save_channel / delete_channel / set_schedule / set_scope / test_channel / run / clear_results。')
}

// ------------------------------------------------------------------ HTTP 出口
function mountWebRoutes(ctx) {
  const web = ctx.get('webServer')
  if (!web || typeof web.register !== 'function') return false

  const sendJson = (res, value, status = 200) => {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }
  const sendText = (res, value, headers = {}) => {
    const body = String(value)
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
      ...headers,
    })
    res.end(body)
  }
  /** 二进制下载（xlsx 等）。 */
  const sendBinary = (res, buffer, headers = {}) => {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      'content-length': buffer.length,
      ...headers,
    })
    res.end(buffer)
  }
  const fail = (res, error) => {
    const known = error instanceof CollectorError
    sendJson(
      res,
      {
        ok: false,
        error: known ? error.code : 'internal_error',
        message: String(error && error.message ? error.message : error),
        hint: known ? error.hint : undefined,
      },
      known ? 400 : 500,
    )
  }
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let raw = ''
      let settled = false
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        if (settled) return
        raw += chunk
        if (raw.length > 512 * 1024) {
          settled = true
          raw = ''
          reject(new CollectorError('bad_args', '请求体过大', '单次保存的数据不能超过 512KB。'))
          req.resume()
        }
      })
      req.on('end', () => {
        if (settled) return
        settled = true
        if (!raw.trim()) return resolve({})
        try {
          resolve(JSON.parse(raw))
        } catch {
          reject(new CollectorError('bad_args', '请求体不是合法 JSON', '刷新页面后重试。'))
        }
      })
      req.on('error', (error) => {
        if (settled) return
        settled = true
        reject(error)
      })
    })

  const route = (handler) => async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname
      const method = (req.method || 'GET').toUpperCase()
      if (method === 'POST') {
        const contentType = String(req.headers['content-type'] || '').toLowerCase()
        if (!contentType.includes('application/json')) {
          throw new CollectorError('unsupported_media_type', '请求体需要 application/json', '面板会自动使用 JSON。')
        }
      }
      await handler({ method, pathname, url, req, res })
    } catch (error) {
      log(ctx, 'warn', `HTTP 处理失败：${error && error.message ? error.message : error}`)
      fail(res, error)
    }
  }

  ctx.effect(() =>
    web.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: route(async ({ method, pathname, url, req, res }) => {
        const body = method === 'POST' ? await readBody(req) : {}
        if (method === 'GET' && pathname === ROUTE_PREFIX) {
          return sendJson(res, {
            ok: true,
            plugin: 'data-collector',
            version: PLUGIN_VERSION,
            dataFile: STATE_FILE,
            reportDir: REPORT_DIR,
            usage: '左侧边栏「数据采集器」：主题 / 渠道 / 定时任务 / 结果数据。Agent 侧用 data_collector 工具。',
          })
        }
        if (method === 'GET' && pathname === `${ROUTE_PREFIX}/state`) {
          return sendJson(res, describeState(ctx))
        }
        if (method === 'POST' && pathname === `${ROUTE_PREFIX}/topics/save`) {
          const result = saveTopic(ctx, body.topic || body)
          return sendJson(res, { ok: true, created: result.created, topic: presentTopic(result.topic, result.state.channels), state: describeState(ctx, result.state) })
        }
        if (method === 'POST' && pathname === `${ROUTE_PREFIX}/topics/delete`) {
          const result = deleteTopic(ctx, body.id || body.name)
          return sendJson(res, { ok: true, deleted: result.topic.name, state: describeState(ctx, result.state) })
        }
        if (method === 'POST' && pathname === `${ROUTE_PREFIX}/channels/save`) {
          const result = saveChannel(ctx, body.channel || body)
          return sendJson(res, { ok: true, created: result.created, channel: presentChannel(result.channel, result.state.topics, result.state.schedule.timeZone), state: describeState(ctx, result.state) })
        }
        if (method === 'POST' && pathname === `${ROUTE_PREFIX}/channels/delete`) {
          const result = deleteChannel(ctx, body.id || body.name)
          return sendJson(res, { ok: true, deleted: result.channel.name, state: describeState(ctx, result.state) })
        }
        if (method === 'POST' && pathname === `${ROUTE_PREFIX}/channels/test`) {
          const outcome = await testChannel(ctx, body.channel || body)
          return sendJson(res, { ok: true, ...outcome })
        }
        if (method === 'POST' && pathname === `${ROUTE_PREFIX}/schedule`) {
          const result = saveSchedule(ctx, body.schedule || body)
          return sendJson(res, { ok: true, schedule: presentSchedule(result.schedule), state: describeState(ctx, result.state) })
        }
        if (method === 'POST' && pathname === `${ROUTE_PREFIX}/scope`) {
          const input = body.scope || body
          const result = saveScope(ctx, input)
          return sendJson(res, { ok: true, scope: presentScope(result.scope), state: describeState(ctx, result.state) })
        }
        if (method === 'POST' && pathname === `${ROUTE_PREFIX}/run`) {
          const state = readStateSafe(ctx)
          if (planRun(state).length === 0) {
            throw new CollectorError('nothing_to_do', '没有可采集的渠道', '先在「渠道」页签添加并启用至少一个渠道。')
          }
          const started = startRun(ctx, 'manual')
          return sendJson(res, { ok: true, started: started.started, runId: started.runId, runtime: snapshotRuntime(), state: describeState(ctx) })
        }
        if (method === 'GET' && pathname === `${ROUTE_PREFIX}/results`) {
          const params = url.searchParams
          const db = getDb(ctx)
          const stateNow = readStateSafe(ctx)
          const today = dateKeyInZone(new Date(), stateNow.schedule.timeZone)
          const outcome = db.listLeads(
            queryOf({
              date: params.get('date') || '',
              dateFrom: params.get('dateFrom') || '',
              dateTo: params.get('dateTo') || '',
              topic: params.get('topic') || '',
              channel: params.get('channel') || '',
              q: params.get('q') || '',
              hasPhone: params.get('hasPhone') || '',
              sync: params.get('sync') || '',
              todayDate: today,
              page: params.get('page') || '',
              pageSize: params.get('pageSize') || params.get('limit') || '',
              sort: params.get('sort') || '',
            }),
          )
          return sendJson(res, {
            ok: true,
            total: outcome.total,
            page: outcome.page,
            pageSize: outcome.pageSize,
            pages: outcome.pages,
            withPhone: outcome.items.filter((item) => item.phone).length,
            dates: db.dates(),
            statusCounts: db.countBySync(today),
            items: outcome.items.map(presentLead),
          })
        }
        if (method === 'POST' && pathname === `${ROUTE_PREFIX}/results/clear`) {
          const outcome = clearResults(ctx)
          return sendJson(res, { ok: true, removed: outcome.removed, state: describeState(ctx, outcome.state) })
        }
        if (method === 'POST' && pathname === `${ROUTE_PREFIX}/results/delete`) {
          const outcome = deleteLead(ctx, body.id)
          return sendJson(res, { ok: true, removed: outcome.removed, deleted: outcome.id, state: describeState(ctx) })
        }
        if (method === 'GET' && pathname === `${ROUTE_PREFIX}/crm/options`) {
          return sendJson(res, await crmOptions(ctx))
        }
        if (method === 'GET' && pathname === `${ROUTE_PREFIX}/crm/status`) {
          const config = loadCrmConfig()
          return sendJson(res, {
            ok: true,
            configured: crmConfigured(config),
            crm: maskCrmConfig(config),
            configFile: CRM_CONFIG_FILE,
            legacyConfigFile: LEGACY_CRM_CONFIG_FILE,
            state: describeState(ctx),
          })
        }
        if (method === 'POST' && pathname === `${ROUTE_PREFIX}/crm/connect`) {
          const result = saveCrmConnection(ctx, body)
          return sendJson(res, { ok: true, crm: result.crm })
        }
        if (method === 'POST' && pathname === `${ROUTE_PREFIX}/crm/test`) {
          return sendJson(res, await crmProbe())
        }
        if (method === 'POST' && pathname === `${ROUTE_PREFIX}/crm/precheck`) {
          return sendJson(res, await crmPrecheck(ctx, body.ids))
        }
        if (method === 'POST' && pathname === `${ROUTE_PREFIX}/crm/push`) {
          return sendJson(res, await crmPush(ctx, body.ids))
        }
        if (method === 'POST' && pathname === `${ROUTE_PREFIX}/crm/config`) {
          const result = saveCrmConfig(ctx, body.crm || body)
          return sendJson(res, { ok: true, crm: result.crm, state: describeState(ctx, result.state) })
        }
        if (method === 'GET' && pathname === `${ROUTE_PREFIX}/results/export`) {
          const state = readStateSafe(ctx)
          const params = url.searchParams
          const format = textOf(params.get('format') || 'xlsx').toLowerCase()
          if (format !== 'xlsx') {
            throw new CollectorError('bad_args', '只支持 Excel（xlsx）导出', '用 format=xlsx；CSV / Markdown 导出已移除。')
          }
          const filters = queryOf({
            date: params.get('date') || '',
            dateFrom: params.get('dateFrom') || '',
            dateTo: params.get('dateTo') || '',
            topic: params.get('topic') || '',
            channel: params.get('channel') || '',
            q: params.get('q') || '',
            hasPhone: params.get('hasPhone') || '',
            sync: params.get('sync') || '',
            todayDate: dateKeyInZone(new Date(), state.schedule.timeZone),
            sort: params.get('sort') || '',
          })
          const rows = getDb(ctx).exportLeads(filters)
          const stamp = filters.date || 'all'
          return sendBinary(res, xlsxFor(state, rows), {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition': `attachment; filename="leads-${stamp}.xlsx"`,
          })
        }
        if (method === 'GET' && pathname === `${ROUTE_PREFIX}/runs`) {
          return sendJson(res, { ok: true, runs: getDb(ctx).listRuns(30) })
        }
        return sendJson(res, { ok: false, error: 'not_found', message: `未知路由 ${method} ${pathname}` }, 404)
      }),
    }),
  )
  return true
}

// ------------------------------------------------------------------ 插件入口
export function apply(ctx) {
  // Agent 工具：读配置、改主题/渠道/定时、立刻采集、查结果。
  const outputSchema = {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  }
  ctx.effect(() =>
    ctx.tools.register({
      name: 'data_collector',
      description:
        '市场线索（左侧边栏同名面板）：按「采集主题」的关键词，从「采集渠道」（RSS / JSON 接口 / 网页列表 / 网页搜索）每天定时抓取公开公告/页面，并识别成「意向客户」线索（公司名称、联系人、联系电话、地区、备注+网址来源、采集时间）。' +
        '查线索用 action="results"（支持 page/pageSize 分页、keyword 检索、date/dateFrom/dateTo/topic/channel/hasPhone 过滤）；改配置用 save_topic / save_channel / set_schedule / set_scope；立刻跑一次用 run；验证某个渠道能不能识别出线索用 test_channel；status/list 看全部配置与上次运行情况。' +
        '线索字段由关键词与正则启发式识别，可能不准（例如把代理机构当成客户、电话识别成传真）；汇报时保留 sourceUrl 并提醒用户核对，不要把这些字段当成已核实的事实，也不要编造电话或联系人。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'list', 'results', 'delete_lead', 'crm_options', 'crm_precheck', 'crm_push', 'crm_status', 'crm_connect', 'crm_search', 'set_crm', 'save_topic', 'delete_topic', 'save_channel', 'delete_channel', 'set_schedule', 'set_scope', 'test_channel', 'run', 'clear_results'],
            description:
              'status / list：配置摘要 + 上次运行 + 下次运行时间；results：查线索（分页/检索/筛选）；delete_lead：删除单条线索（传 id）；crm_options：查看 CRM 可选线索池/产品与写权限；crm_status：CRM 连接状态（配置/连通/鉴权/身份）；crm_connect：保存 CRM 连接配置（baseUrl/accessKey/secretKey/readOnly），并测试连通；crm_search：按 keyword 在 CRM 里搜线索/联系人/客户/商机；crm_precheck：预检选中线索能否写入（手机号+公司名查重，传 ids）；crm_push：把预检通过的线索写入 CRM 线索池（传 ids）；set_crm：保存 CRM 写入配置（线索池/产品/负责人）；save_topic：新建或更新主题；delete_topic：删除主题；save_channel：新建或更新渠道；delete_channel：删除渠道；set_schedule：改定时（时间/开关/时区/保留天数）；set_scope：改采集范围（地区，例如只收内蒙古）；test_channel：抓一次看能识别出几条线索；run：立刻采集一次；clear_results：清空已采线索与去重记录（配置保留，用于改完关键词后重新采）。',
          },
          ids: { type: 'array', items: { type: 'string' }, description: '仅 crm_precheck / crm_push：要处理的线索 id 数组（来自 results 的 items[].id）。' },
          id: { type: 'string', description: '要操作的对象 id（delete_topic / delete_channel / test_channel / save_* 更新时用）；也可以直接用 name。' },
          name: { type: 'string', description: '主题或渠道的名字（删除/测试时可按名字定位；save_* 时等价于 data.name）。' },
          date: { type: 'string', description: '仅 results：按采集日期过滤，格式 YYYY-MM-DD。' },
          dateFrom: { type: 'string', description: '仅 results：采集日期起（含），YYYY-MM-DD。' },
          dateTo: { type: 'string', description: '仅 results：采集日期止（含），YYYY-MM-DD。' },
          topic: { type: 'string', description: '仅 results：按主题过滤（主题名或 id）。' },
          channel: { type: 'string', description: '仅 results：按渠道过滤（渠道名或 id）。' },
          hasPhone: { type: 'boolean', description: '仅 results：只返回有电话的线索。' },
          page: { type: 'number', description: '仅 results：页码，从 1 开始，默认 1。' },
          pageSize: { type: 'number', description: '仅 results：每页条数，默认 20，上限 200。' },
          keyword: { type: 'string', description: '仅 results：全文检索（公司/联系人/电话/地区/备注/标题/来源）。' },
          limit: { type: 'number', description: '仅 results：每页条数（等价 pageSize），默认 20，上限 200；save_channel 时表示每个渠道每次最多看多少个页面（1-200）。' },
          wait: { type: 'boolean', description: '仅 run：是否等采集结束（默认 true，最多等 90 秒；false 立即返回 runId）。' },
          // 下面这些也可以直接当顶层参数传（等价于放在 data 里）
          type: { type: 'string', description: '仅 save_channel：渠道类型 rss / json / html / search。' },
          url: { type: 'string', description: '仅 save_channel：RSS/JSON/网页 的地址（search 不用）。' },
          query: { type: 'string', description: '仅 save_channel：search 渠道的搜索词。' },
          keywords: { type: 'string', description: '仅 save_topic：关键词，顿号分隔。' },
          regions: { type: 'array', items: { type: 'string' }, description: '仅 set_scope：采集范围地区数组，例如 ["内蒙古"]（可加城市）；空数组=不限地区。' },
          unknown: { type: 'string', enum: ['smart', 'keep', 'drop'], description: '仅 set_scope：地区识别不出来时怎么办——smart 按公司/标题里的城市智能判断（默认）、keep 保留、drop 丢弃。' },
          channels: { type: 'array', items: { type: 'string' }, description: '仅 save_topic：关注的渠道名数组，空数组=全部渠道。' },
          notes: { type: 'string', description: '仅 save_topic：备注。' },
          detailLimit: { type: 'number', description: '仅 save_channel：每个渠道每次最多抓几个详情页（0-20）。' },
          followDetail: { type: 'boolean', description: '仅 save_channel：是否抓详情页补全联系人/电话。' },
          region: { type: 'string', description: '仅 save_channel：识别不出地区时的默认地区。' },
          linkPattern: { type: 'string', description: '仅 save_channel：网页列表的链接过滤正则。' },
          itemPath: { type: 'string', description: '仅 save_channel：JSON 渠道的数组路径。' },
          time: { type: 'string', description: '仅 set_schedule：每天几点，HH:mm。' },
          timeZone: { type: 'string', description: '仅 set_schedule：IANA 时区，默认 Asia/Shanghai。' },
          retainDays: { type: 'number', description: '仅 set_schedule：保留天数（1-365）。' },
          maxItemsPerRun: { type: 'number', description: '仅 set_schedule：单次最多收录多少条线索（10-1000）。' },
          data: {
            type: 'object',
            additionalProperties: true,
            description:
              'save_topic 字段：name、keywords（数组或「顿号分隔字符串」，建议填采购/招标/演练/消防等业务词）、channels（渠道名数组，空数组=关注全部渠道）、notes、enabled。' +
              'save_channel 字段：name、type（rss / json / html / search）、url（search 不需要）、query（search 用，留空则用主题关键词）、limit（1-200）、enabled、note；' +
              'followDetail（是否抓详情页补全联系人/电话，默认 true）、detailLimit（每个渠道每次最多抓几个详情页，0-20）、region（识别不出地区时的默认地区，如「呼和浩特」）；' +
              'json 渠道可选 itemPath（数组路径，如 data.list）、fieldTitle/fieldLink/fieldDate/fieldSummary（字段名）；' +
              'html 渠道可选 linkPattern（只保留命中该正则的链接，如 /tzgg/ 或 t\\d{8}_\\d+）。' +
              'set_schedule 字段：time（HH:mm）、enabled、timeZone（默认 Asia/Shanghai）、catchUp（启动补采）、retainDays（保留天数 1-365）、maxItemsPerRun（单次上限 10-1000）。' +
              'set_scope 字段：regions（地区数组，如 ["内蒙古"] 或 ["内蒙古","呼和浩特"]；空数组=不限地区）、unknown（地区识别不出来时的策略：smart / keep / drop，默认 smart）。',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: outputSchema,
      timeoutMs: 120000,
      isConcurrencySafe: () => false,
      async execute(args) {
        try {
          return await runTool(ctx, args || {})
        } catch (error) {
          return {
            ok: false,
            error: error instanceof CollectorError ? error.code : 'internal_error',
            message: String(error && error.message ? error.message : error),
            hint: error instanceof CollectorError ? error.hint : undefined,
          }
        }
      },
    }),
  )

  // 全局提示：让 Agent 知道什么时候该用采集结果、怎么改配置。
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    ctx.effect(() => systemPrompt.section({ name: 'data-collector', order: 860, text: SYSTEM_PROMPT_TEXT }))
  }

  // Host 服务：同进程的其他插件直接复用同一套读写与运行逻辑。
  if (typeof ctx.provide === 'function') {
    ctx.effect(() =>
      ctx.provide('dataCollector', {
        version: PLUGIN_VERSION,
        state: () => describeState(ctx),
        topics: () => readStateSafe(ctx).topics,
        channels: () => readStateSafe(ctx).channels,
        saveTopic: (input) => saveTopic(ctx, input).topic,
        deleteTopic: (ref) => deleteTopic(ctx, ref).topic,
        saveChannel: (input) => saveChannel(ctx, input).channel,
        deleteChannel: (ref) => deleteChannel(ctx, ref).channel,
        setSchedule: (input) => saveSchedule(ctx, input).schedule,
        setScope: (input) => saveScope(ctx, input).scope,
        run: (trigger) => startRun(ctx, trigger || 'manual'),
        results: (options) => getDb(ctx).listLeads(queryOf(options || {})),
        exportLeads: (options) => getDb(ctx).exportLeads(queryOf(options || {})),
        clearResults: () => clearResults(ctx),
        deleteLead: (id) => deleteLead(ctx, id),
        dataFile: STATE_FILE,
        dbFile: DB_FILE,
        reportDir: REPORT_DIR,
      }),
    )
  }

  // 同源 HTTP：webServer 由其他行提供，激活顺序不保证，拿不到就短暂重试。
  const webState = { registered: false, attempts: 0, error: '', retry: null }
  const registerWebRoutes = () => {
    webState.attempts += 1
    if (webState.registered) return true
    try {
      if (!mountWebRoutes(ctx)) {
        webState.error = 'webServer 服务尚不可用'
        return false
      }
      webState.registered = true
      webState.error = ''
      log(ctx, 'info', `已挂载 ${ROUTE_PREFIX} 路由（第 ${webState.attempts} 次尝试）`)
      return true
    } catch (error) {
      webState.error = String(error && error.message ? error.message : error)
      log(ctx, 'warn', `挂载 ${ROUTE_PREFIX} 路由失败（第 ${webState.attempts} 次）：${webState.error}`)
      return false
    }
  }
  const scheduleWebRetry = () => {
    if (webState.registered || webState.retry) return
    if (webState.attempts >= 40) {
      log(ctx, 'warn', `webServer 重试 ${webState.attempts} 次仍不可用，面板接口未启用：${webState.error}（Agent 工具不受影响）`)
      return
    }
    webState.retry = setTimeout(() => {
      webState.retry = null
      if (!webState.registered && !registerWebRoutes()) scheduleWebRetry()
    }, 500)
    webState.retry.unref?.()
  }
  if (!registerWebRoutes()) scheduleWebRetry()

  // 定时任务 + 启动补采
  armTimer(ctx)
  const catchUpHandle = scheduleCatchUp(ctx)

  ctx.effect(() => () => {
    clearTimer()
    if (webState.retry) clearTimeout(webState.retry)
    if (catchUpHandle) clearTimeout(catchUpHandle)
    if (database) {
      database.close()
      database = null
    }
  })

  // 提前打开数据库（顺手完成旧数据迁移），面板第一次请求就很快
  const dbInfo = getDb(ctx).fileInfo()
  const state = readStateSafe(ctx)
  log(
    ctx,
    'info',
    `已加载：${state.topics.length} 个主题 / ${state.channels.length} 个渠道，` +
      `${state.schedule.enabled ? `每天 ${state.schedule.time}（${state.schedule.timeZone}）采集` : '定时任务已关闭'}，` +
      `配置 ${STATE_FILE}，线索库 ${dbInfo.file}（${dbInfo.bytes} 字节）`,
  )
}

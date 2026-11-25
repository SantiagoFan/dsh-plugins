/**
 * Host half of @mindlink-ai/dsh-newmedia-workbench.
 *
 * 新媒体工作台：管理账号的「定位卡」（赛道、受众、人设、语气、内容支柱、禁忌……），
 * 一张定位卡可以关联多个平台账号（例如「老板IP」定位卡 → 抖音的老板账号 + 视频号的老板IP账号），
 * 每个平台账号可以一键获取粉丝量。
 *
 * 三个出口共用同一份数据与同一套读写逻辑：
 *  - Agent 工具 newmedia_workbench（list / get / context / upsert / link / sync_followers / status / delete）；
 *  - 同源 HTTP 路由 /newmedia-workbench/*，供左侧边栏面板读取与编辑；
 *  - Host 服务 newmediaWorkbench，供其他插件同进程调用。
 *
 * 数据只保存在本机 ~/.dsh/newmedia-workbench/accounts.json，不上传、不写日志正文；
 * 平台 Cookie / API Key / 代理存在 settings.json（0600），只用于采集粉丝量，面板只回显掩码。
 */
import fs from 'node:fs'

import { capabilityOf, describeCapabilities, formatCount, parseCount, syncTargets } from './lib/followers.js'
import {
  ACCOUNTS_FILE,
  DATA_DIR,
  describeSettings,
  loadSettings,
  saveSettings,
  SETTINGS_FILE,
  touchLastSync,
} from './lib/settings.js'
import {
  collectHotMaterial,
  deleteTopic,
  deleteTopicsForCard,
  generateWithLlm,
  markRun,
  normalizeDate,
  nowHHMM,
  pickTopic,
  presentTopic,
  readTopics,
  saveTopics,
  todayKey,
  TOPICS_FILE,
  TopicsError,
  updateTopicConfig,
  writeTopics,
} from './lib/topics.js'

export const name = 'newmedia-workbench'
export const inject = ['tools']

const PLUGIN_VERSION = '0.6.0'
const ROUTE_PREFIX = '/newmedia-workbench'
const DATA_FILE = ACCOUNTS_FILE
const MAX_SYNC_ACCOUNTS = 20
const STORE_VERSION = 4
const TOPIC_SCHEDULER_INTERVAL_MS = 30000
const TOPIC_SCHEDULER_STARTUP_MS = 20000
const TOPIC_RETRY_MS = 30 * 60 * 1000

/**
 * 选题生成是「后台一轮」，面板、Agent 工具和每日定时共用同一份运行状态：
 * 面板显示进度，Agent 等这一轮结束拿结果，定时任务据此避免重复触发。
 */
const GENERATION_STATE = {
  running: false,
  startedAt: '',
  finishedAt: '',
  card: '',
  done: 0,
  total: 0,
  reason: '',
  errors: [],
  promise: null,
}
/** 整轮失败（例如模型暂不可用）后的重试闸门，避免定时器每 30 秒重试一次。 */
let topicRetryAt = 0

/** 平台顺序按用户实际账号排列：抖音、视频号、小红书、公众号在前。 */
const PLATFORMS = [
  { key: 'douyin', label: '抖音' },
  { key: 'shipinhao', label: '视频号' },
  { key: 'xiaohongshu', label: '小红书' },
  { key: 'wechat', label: '公众号' },
  { key: 'bilibili', label: 'B站' },
  { key: 'kuaishou', label: '快手' },
  { key: 'youtube', label: 'YouTube' },
  { key: 'tiktok', label: 'TikTok' },
  { key: 'other', label: '其他' },
]

const STAGES = ['冷启动', '成长期', '成熟期', '转型期', '矩阵号']

/** 定位卡里除「平台账号」外的人设字段。 */
const POSITIONING_TEXT_FIELDS = [
  'stage',
  'niche',
  'audience',
  'persona',
  'value',
  'tone',
  'hookStyle',
  'differentiator',
  'goal',
  'monetization',
  'references',
  'notes',
]
const POSITIONING_LIST_FIELDS = ['pillars', 'taboo', 'keywords']

/** 平台账号里允许 Agent / 面板写入的字段。 */
const PLATFORM_ACCOUNT_FIELDS = ['platform', 'name', 'uid', 'homepage', 'handle', 'note', 'followers', 'followersCount']

/** 全局系统提示：让 Agent 在写口播文案时自动取卡、多账号时自动弹选择。 */
const SYSTEM_PROMPT_TEXT =
  '新媒体工作台：本机存有两类数据——「定位卡」（账号人设：赛道/受众/人设/语气/内容支柱/禁忌）和「平台账号」（抖音/视频号/小红书/公众号等，可关联到某张定位卡）。' +
  '写口播文案 / 短视频脚本 / 账号内容策划前先处理账号上下文：' +
  '用户点名定位卡（或平台账号）→ 调 newmedia_workbench(action="context", account=名称) 读卡再写；' +
  '未点名 → 先调 newmedia_workbench(action="list")，只有一张卡就直接用，有多张卡时用 ask_user_question 让用户选择' +
  '（每个定位卡一个选项，label 用「定位卡名（关联平台）」，description 写阶段与赛道，另给「不指定账号，按通用风格写」），选完再读卡。' +
  '用户说「获取/更新粉丝量」→ action="sync_followers"；说「把某个平台账号关联到定位卡」→ action="link"（card 定位卡 + data.platform/name/uid）。' +
  '定位卡没写的信息视为未知，不要编造。'

/** 各平台「账号关联」字段的填写提示（面板与 Agent 共用）。 */
const PLATFORM_FIELD_HINTS = {
  douyin: {
    uidLabel: '抖音号 / sec_uid',
    uidHint: '优先填 sec_uid（MS4wLjAB 开头，从主页链接里取）；抖音有签名风控，自动获取常失败，可直接手填粉丝量',
    homepageHint: 'https://www.douyin.com/user/MS4wLjAB...',
  },
  shipinhao: {
    uidLabel: '视频号 ID（可留空）',
    uidHint: '视频号没有公开接口，粉丝量请手动填写；这里只作备注，可留空',
    homepageHint: '视频号主页链接（可选）',
  },
  xiaohongshu: {
    uidLabel: '小红书号 / user_id',
    uidHint: '填 user_id（主页链接 /user/profile/ 后面那串）；需要配小红书 Cookie，失败可手填',
    homepageHint: 'https://www.xiaohongshu.com/user/profile/...',
  },
  wechat: {
    uidLabel: '公众号原始 ID（可留空）',
    uidHint: '公众号没有公开接口，粉丝量请手动填写；这里只作备注，可留空',
    homepageHint: '公众号主页或文章链接（可选）',
  },
  bilibili: {
    uidLabel: 'B站 UID（数字）',
    uidHint: '填空间页数字 UID，例如 2；B站免配置即可自动获取粉丝数',
    homepageHint: 'https://space.bilibili.com/2',
  },
  kuaishou: {
    uidLabel: '快手 ID',
    uidHint: '填快手用户 ID（主页链接里 /profile/ 后面那串）；免配置，但需国内直连网络',
    homepageHint: 'https://www.kuaishou.com/profile/...',
  },
  youtube: {
    uidLabel: '频道 ID / @handle',
    uidHint: '@handle 或 UC 开头的频道 ID；配 YouTube Data API Key 可得精确数，页面解析需代理',
    homepageHint: 'https://www.youtube.com/@handle',
  },
  tiktok: {
    uidLabel: 'TikTok 用户名',
    uidHint: '不带 @ 的用户名；免 Cookie，但国内直连不可达，需要配代理',
    homepageHint: 'https://www.tiktok.com/@username',
  },
  other: {
    uidLabel: '账号 ID',
    uidHint: '其他平台暂不支持自动获取，请手动填写粉丝量',
    homepageHint: '主页链接（可选）',
  },
}

class WorkbenchError extends Error {
  constructor(code, message, hint) {
    super(message)
    this.code = code
    this.hint = hint
  }
}

const textOf = (value) => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** 把「数组或换行/顿号/逗号分隔的字符串」统一成字符串数组。 */
const listOf = (value) => {
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean)
  return String(value ?? '')
    .split(/[\n、，,;；]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

/** 平台别名：Agent / 用户常用叫法，统一映射到平台 key。 */
const PLATFORM_ALIASES = {
  douyin: ['抖音', 'douyin', 'dy'],
  shipinhao: ['视频号', '微信视频号', 'weixin视频号', 'channels', 'shipinhao'],
  xiaohongshu: ['小红书', '红书', 'xhs', 'xiaohongshu', 'red'],
  wechat: ['公众号', '微信公众号', '微信', 'wechat', 'gzh'],
  bilibili: ['b站', 'b 站', '哔哩哔哩', '哔哩', 'bili', 'bilibili'],
  kuaishou: ['快手', 'ks', 'kuaishou'],
  youtube: ['youtube', '油管', 'yt'],
  tiktok: ['tiktok', '海外抖音'],
  other: ['其他', '其它', 'other'],
}

const platformKeyOf = (value) => {
  const raw = textOf(value)
  if (!raw) return 'other'
  const lower = raw.toLowerCase()
  const byKey = PLATFORMS.find((item) => item.key === lower)
  if (byKey) return byKey.key
  const byLabel = PLATFORMS.find((item) => item.label === raw || item.label.toLowerCase() === lower)
  if (byLabel) return byLabel.key
  for (const [key, aliases] of Object.entries(PLATFORM_ALIASES)) {
    if (aliases.some((alias) => alias.toLowerCase() === lower)) return key
  }
  return 'other'
}

const platformLabelOf = (key) => {
  const found = PLATFORMS.find((item) => item.key === key)
  return found ? found.label : '其他'
}

const newId = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

/** 旧版/手改数据没有 id 时，用稳定哈希生成 id，保证多次读取一致、还能按 id 删除。 */
const hashId = (prefix, seed) => {
  let hash = 5381
  for (let i = 0; i < seed.length; i += 1) hash = ((hash * 33) ^ seed.charCodeAt(i)) >>> 0
  return `${prefix}_${hash.toString(36)}`
}

const legacyCardId = (input) => hashId('acc', `${textOf(input.name)}|${textOf(input.createdAt)}|${textOf(input.platform)}`)

/** 旧数据结构：平台/账号/粉丝量直接挂在定位卡上 → 迁移成一个平台账号。 */
function legacyPlatformsOf(input) {
  const platform = textOf(input.platform)
  const keys = ['handle', 'uid', 'homepage', 'followers', 'followersCount', 'followersUpdatedAt', 'followersSource']
  const hasLegacy = Boolean(platform) || keys.some((key) => input[key] !== undefined && textOf(input[key]) !== '')
  if (!hasLegacy) return []
  return [
    {
      platform: platform || 'other',
      name: textOf(input.name),
      handle: input.handle,
      uid: input.uid,
      homepage: input.homepage,
      followers: input.followers,
      followersCount: input.followersCount,
      followersUpdatedAt: input.followersUpdatedAt,
      followersSource: input.followersSource,
    },
  ]
}

/** 完全空的平台账号行（用户点了「添加」但没填任何东西）应当被丢弃。 */
function isBlankPlatformAccount(account) {
  return (
    !textOf(account.name) &&
    !textOf(account.uid) &&
    !textOf(account.homepage) &&
    !textOf(account.handle) &&
    !textOf(account.note) &&
    !textOf(account.followers) &&
    account.followersCount === null
  )
}

/** 平台账号：独立实体，可关联到某张定位卡（cardId 为空 = 未关联）。 */
function normalizeAccount(input = {}, fallbackCardId = '') {
  const now = new Date().toISOString()
  const cardId = textOf(input.cardId) || textOf(fallbackCardId)
  const platform = platformKeyOf(input.platform)
  const account = {
    // 旧数据没有 id 时用稳定哈希，保证多次读取一致、还能按 id 删除
    id:
      textOf(input.id) ||
      hashId('pa', `${cardId}|${platform}|${textOf(input.name)}|${textOf(input.uid)}|${textOf(input.homepage)}`),
    cardId,
    platform,
    name: textOf(input.name),
    uid: textOf(input.uid),
    homepage: textOf(input.homepage),
    handle: textOf(input.handle),
    note: textOf(input.note),
    followers: textOf(input.followers),
    followersCount: null,
    followersUpdatedAt: textOf(input.followersUpdatedAt),
    followersSource: '',
    createdAt: textOf(input.createdAt) || now,
    updatedAt: textOf(input.updatedAt) || now,
  }
  const explicitCount = parseCount(input.followersCount)
  const textCount = parseCount(input.followers)
  const count = explicitCount !== null ? explicitCount : textCount
  account.followersCount = count === null ? null : Math.max(0, Math.trunc(count))
  const source = textOf(input.followersSource)
  account.followersSource = source === 'auto' || source === 'manual' ? source : account.followersCount !== null ? 'manual' : ''
  if (account.followersCount !== null && !account.followers) account.followers = formatCount(account.followersCount)
  return account
}

/** 定位卡：只有人设字段，不再包含平台账号。 */
function normalizeCard(input = {}) {
  const now = new Date().toISOString()
  const card = {
    id: textOf(input.id) || legacyCardId(input),
    name: textOf(input.name),
    createdAt: textOf(input.createdAt) || now,
    updatedAt: textOf(input.updatedAt) || now,
  }
  for (const field of POSITIONING_TEXT_FIELDS) card[field] = textOf(input[field])
  for (const field of POSITIONING_LIST_FIELDS) card[field] = listOf(input[field]).join('\n')
  return card
}

/** 某张定位卡关联的平台账号。 */
const platformsOfCard = (card, accounts) => (Array.isArray(accounts) ? accounts : []).filter((item) => item && item.cardId === card.id)

/** 工具/接口输出：定位卡 + 它关联的平台账号（保留旧的 account.platforms 读法）。 */
const presentCard = (card, accounts) => ({ ...card, platforms: platformsOfCard(card, accounts) })

/** 会话里可读的定位卡摘要（不含长文本）。platforms 来自独立存储的平台账号。 */
function summarize(card, accounts) {
  const platforms = platformsOfCard(card, accounts).map((account) => {
    const capability = capabilityOf(account.platform)
    return {
      id: account.id,
      platform: account.platform,
      platformLabel: platformLabelOf(account.platform),
      name: account.name,
      uid: account.uid,
      homepage: account.homepage,
      handle: account.handle,
      linked: Boolean(account.uid || account.homepage),
      followers: account.followers,
      followersCount: account.followersCount,
      followersUpdatedAt: account.followersUpdatedAt,
      followersSource: account.followersSource,
      followerAuto: capability.auto !== 'manual',
    }
  })
  const counts = platforms.map((item) => item.followersCount).filter((value) => typeof value === 'number')
  return {
    id: card.id,
    name: card.name,
    stage: card.stage,
    niche: card.niche,
    platforms,
    platformKeys: Array.from(new Set(platforms.map((item) => item.platform))),
    linkedCount: platforms.filter((item) => item.linked).length,
    followersTotal: counts.length > 0 ? counts.reduce((sum, value) => sum + value, 0) : null,
    updatedAt: card.updatedAt,
  }
}

const fmtDate = (iso) => {
  const date = new Date(iso)
  if (!iso || Number.isNaN(date.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 一个平台账号的「粉丝量」文本：精确数 + 采集时间 + 来源。 */
function describeFollowers(account) {
  if (account.followersCount === null) return account.followers
  const exact = Number(account.followersCount).toLocaleString('zh-CN')
  const summarized = account.followers && account.followers !== formatCount(account.followersCount) ? `${account.followers}（${exact}）` : exact
  const when = account.followersUpdatedAt ? `，${fmtDate(account.followersUpdatedAt)} 采集` : ''
  const source = account.followersSource === 'auto' ? '自动采集' : account.followersSource === 'manual' ? '手动填写' : ''
  return `${summarized}${when}${source ? `，${source}` : ''}`
}

/** 一行平台账号：抖音｜账号 老板账号｜ID xxx｜主页 xxx｜粉丝量 xxx */
function describePlatformAccount(account) {
  const parts = [platformLabelOf(account.platform)]
  if (account.name) parts.push(`账号 ${account.name}`)
  if (account.handle) parts.push(account.handle)
  if (account.uid) parts.push(`ID ${account.uid}`)
  if (account.homepage) parts.push(`主页 ${account.homepage}`)
  const followerText = describeFollowers(account)
  if (followerText) parts.push(`粉丝量 ${followerText}`)
  if (account.note) parts.push(`备注 ${account.note}`)
  return parts.join('｜')
}

/** 把定位卡渲染成可直接当上下文用的 Markdown（口播文案生成用）。 */
function buildBrief(card, accounts) {
  const linked = platformsOfCard(card, accounts)
  const lines = []
  lines.push(`# 账号定位卡：${card.name}`)
  lines.push('')
  lines.push('> 以下为该定位卡的信息，用于生成口播文案 / 短视频脚本。请严格遵循；未填写的信息视为未知，不要编造。')
  lines.push('')
  lines.push(`- 定位卡：${card.name}`)
  if (card.stage) lines.push(`- 账号阶段：${card.stage}`)
  if (linked.length === 0) {
    lines.push('- 关联平台账号：未关联')
  } else {
    lines.push('- 关联平台账号：')
    linked.forEach((account, index) => lines.push(`  ${index + 1}. ${describePlatformAccount(account)}`))
  }
  if (card.niche) lines.push(`- 内容赛道：${card.niche}`)
  if (card.audience) lines.push(`- 目标受众：${card.audience}`)
  if (card.persona) lines.push(`- 人设标签：${card.persona}`)
  if (card.value) lines.push(`- 核心价值主张：${card.value}`)
  const pillars = listOf(card.pillars)
  if (pillars.length > 0) {
    lines.push('- 内容支柱：')
    pillars.forEach((item, index) => lines.push(`  ${index + 1}. ${item}`))
  }
  if (card.tone) lines.push(`- 语气风格：${card.tone}`)
  if (card.hookStyle) lines.push(`- 开场钩子偏好：${card.hookStyle}`)
  if (card.differentiator) lines.push(`- 差异化记忆点：${card.differentiator}`)
  if (card.goal) lines.push(`- 当前阶段目标：${card.goal}`)
  if (card.monetization) lines.push(`- 变现方式：${card.monetization}`)
  const taboo = listOf(card.taboo)
  if (taboo.length > 0) lines.push(`- 禁忌与红线：${taboo.join('；')}`)
  const keywords = listOf(card.keywords)
  if (keywords.length > 0) lines.push(`- 关键词 / 标签：${keywords.join('、')}`)
  if (card.references) lines.push(`- 对标账号：${card.references}`)
  if (card.notes) lines.push(`- 补充说明：${card.notes}`)
  return lines.join('\n')
}

// ------------------------------------------------------------------ 磁盘存储
function log(ctx, level, message) {
  const fn = ctx.logger ? ctx.logger[level] : undefined
  if (typeof fn === 'function') fn.call(ctx.logger, `[newmedia-workbench] ${message}`)
}

function readStore(ctx) {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    const sourceCards = Array.isArray(parsed.cards)
      ? parsed.cards
      : Array.isArray(parsed.accounts)
        ? parsed.accounts
        : []
    const normalized = sourceCards
      .filter(isObject)
      .map((item) => ({ raw: item, card: normalizeCard(item) }))
      .filter((entry) => Boolean(entry.card.name))
    const cards = normalized.map((entry) => entry.card)
    let accounts = []
    if (Array.isArray(parsed.cards)) {
      // v4：cards 与 accounts 分开存
      accounts = (Array.isArray(parsed.accounts) ? parsed.accounts : [])
        .filter(isObject)
        .map((item) => normalizeAccount(item))
        .filter((account) => !isBlankPlatformAccount(account))
    } else {
      // v1–v3：定位卡里嵌着平台账号（或旧字段直接挂在卡上）→ 拆成独立的平台账号
      for (const { raw: original, card } of normalized) {
        const rawPlatforms = Array.isArray(original.platforms)
          ? original.platforms
          : Array.isArray(original.accounts)
            ? original.accounts
            : legacyPlatformsOf(original)
        for (const item of rawPlatforms.filter(isObject)) {
          const account = normalizeAccount(item, card.id)
          if (!isBlankPlatformAccount(account)) accounts.push(account)
        }
      }
    }
    return { version: STORE_VERSION, updatedAt: textOf(parsed.updatedAt), cards, accounts }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') log(ctx, 'warn', `读取账号数据失败：${error && error.message ? error.message : error}`)
    return { version: STORE_VERSION, updatedAt: '', cards: [], accounts: [] }
  }
}

function writeStore(ctx, store) {
  const payload = {
    version: STORE_VERSION,
    updatedAt: store.updatedAt || new Date().toISOString(),
    cards: store.cards,
    accounts: store.accounts,
  }
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  const tmp = `${DATA_FILE}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, DATA_FILE)
}

function describeStore(ctx) {
  const store = readStore(ctx)
  return {
    ok: true,
    version: PLUGIN_VERSION,
    cards: store.cards,
    accounts: store.accounts,
    updatedAt: store.updatedAt,
    platforms: PLATFORMS,
    stages: STAGES,
    capabilities: describeCapabilities(),
    platformFields: PLATFORM_FIELD_HINTS,
    settings: describeSettings(loadSettings()),
    topics: describeTopicsState(ctx),
    dataFile: DATA_FILE,
    dataDir: DATA_DIR,
    settingsFile: SETTINGS_FILE,
    maxSyncAccounts: MAX_SYNC_ACCOUNTS,
    hint: '定位卡只放人设（赛道/受众/人设/语气/支柱/禁忌）；平台账号单独维护，可以关联到任意一张定位卡，关联后可一键获取粉丝量。',
  }
}

function findCard(store, ref) {
  const target = textOf(ref)
  if (!target) return undefined
  const lower = target.toLowerCase()
  const direct =
    store.cards.find((card) => card.id === target) || store.cards.find((card) => card.name.toLowerCase() === lower)
  if (direct) return direct
  // 也接受「平台账号名 / 账号 ID」：反查到它关联的定位卡
  const account = findAccount(store, target)
  if (!account || !account.cardId) return undefined
  return store.cards.find((card) => card.id === account.cardId)
}

function requireCard(store, ref) {
  const card = findCard(store, ref)
  if (card) return card
  const names = store.cards.map((item) => item.name)
  const preview = names.slice(0, 12).join('、')
  throw new WorkbenchError(
    'account_not_found',
    `没有找到「${textOf(ref) || '(空)'}」对应的定位卡。`,
    names.length > 0
      ? `现有定位卡：${preview}${names.length > 12 ? ` 等 ${names.length} 张` : ''}。`
      : '当前还没有任何定位卡，可先用 action="upsert" 新建，或让用户在「新媒体工作台」面板里新建。',
  )
}

/** 按 id / 账号名 / 账号 ID 找一个平台账号。 */
function findAccount(store, ref) {
  const target = textOf(ref)
  if (!target) return undefined
  const lower = target.toLowerCase()
  return (
    store.accounts.find((account) => account.id === target) ||
    store.accounts.find((account) => textOf(account.name).toLowerCase() === lower) ||
    store.accounts.find((account) => textOf(account.uid).toLowerCase() === lower)
  )
}

function requireAccount(store, ref) {
  const account = findAccount(store, ref)
  if (account) return account
  throw new WorkbenchError(
    'account_not_found',
    `没有找到平台账号「${textOf(ref) || '(空)'}」。`,
    store.accounts.length > 0 ? '可以在面板「平台账号」页签里新增或先关联到定位卡。' : '当前还没有任何平台账号。',
  )
}

/** 把一张定位卡下的平台账号整体替换成 incoming（用于兼容旧的 platforms 写法）。 */
function replaceCardPlatforms(store, card, rawPlatforms) {
  const previous = store.accounts.filter((account) => account.cardId === card.id)
  const incoming = rawPlatforms
    .filter(isObject)
    .map((item) => normalizeAccount({ ...item, cardId: card.id }, card.id))
    .filter((account) => !isBlankPlatformAccount(account))
  for (const account of incoming) {
    const match = previous.find(
      (old) =>
        (textOf(account.uid) && old.platform === account.platform && textOf(old.uid) === textOf(account.uid)) ||
        (textOf(account.name) && old.platform === account.platform && textOf(old.name).toLowerCase() === textOf(account.name).toLowerCase()),
    )
    if (match) {
      account.id = match.id
      account.createdAt = match.createdAt
    }
  }
  store.accounts = [...store.accounts.filter((account) => account.cardId !== card.id), ...incoming]
}

/**
 * 新建或更新一张定位卡（只写人设字段）。
 * - input.id 命中已有 id（或 ref 命中 id / 定位卡名 / 平台账号名）时做增量更新；
 * - 否则新建，name 必填；
 * - 定位卡名不允许重复；
 * - 兼容：input.platforms 仍会被接受，用来一次性替换这张卡关联的平台账号（旧工具调用方式）。
 */
function saveCard(ctx, input = {}, options = {}) {
  const store = readStore(ctx)
  const ref = textOf(options.ref)
  let index = -1
  if (ref) {
    index = store.cards.findIndex((card) => card.id === ref)
    if (index < 0) index = store.cards.findIndex((card) => card.name.toLowerCase() === ref.toLowerCase())
  }
  if (index < 0 && textOf(input.id)) index = store.cards.findIndex((card) => card.id === textOf(input.id))
  const previous = index >= 0 ? store.cards[index] : undefined
  const now = new Date().toISOString()
  const merged = previous ? { ...previous, ...input } : { ...input }
  delete merged.platforms
  delete merged.accounts
  if (!textOf(merged.name) && ref) merged.name = ref
  if (!textOf(merged.name)) {
    throw new WorkbenchError('bad_args', '定位卡名不能为空。', '新建定位卡时请在 data.name 写入定位卡名（例如「老板IP」），或用 account 直接传名称。')
  }
  if (!textOf(merged.id)) merged.id = newId('acc')
  merged.updatedAt = now
  const card = normalizeCard(merged)
  const duplicate = store.cards.find((item, itemIndex) => itemIndex !== index && item.name.toLowerCase() === card.name.toLowerCase())
  if (duplicate) {
    throw new WorkbenchError(
      'duplicate_name',
      `已存在同名定位卡「${card.name}」。`,
      `用 account="${duplicate.id}" 更新已有那张卡，或换一个名字。`,
    )
  }
  const created = index < 0
  if (created) store.cards.push(card)
  else store.cards[index] = card
  const incomingPlatforms = Array.isArray(input.platforms) ? input.platforms : Array.isArray(input.accounts) ? input.accounts : null
  if (incomingPlatforms) replaceCardPlatforms(store, card, incomingPlatforms)
  store.updatedAt = now
  writeStore(ctx, store)
  return { card, created, store }
}

/** 删除定位卡：卡删除，关联的平台账号保留但变成「未关联」；选题库里的选题一并清掉。 */
function deleteCard(ctx, ref) {
  const store = readStore(ctx)
  const card = requireCard(store, ref)
  store.cards = store.cards.filter((item) => item.id !== card.id)
  const now = new Date().toISOString()
  for (const account of store.accounts) {
    if (account.cardId === card.id) {
      account.cardId = ''
      account.updatedAt = now
    }
  }
  store.updatedAt = now
  writeStore(ctx, store)
  try {
    deleteTopicsForCard(ctx, card.id)
  } catch (error) {
    log(ctx, 'warn', `删除定位卡「${card.name}」的选题失败：${error && error.message ? error.message : error}`)
  }
  return { card, store }
}

/** 新增或更新一个平台账号；cardId 可以随时改（这就是「关联定位卡」）。 */
function saveAccount(ctx, input = {}) {
  const store = readStore(ctx)
  const now = new Date().toISOString()
  const id = textOf(input.id)
  const index = id ? store.accounts.findIndex((item) => item.id === id) : -1
  const previous = index >= 0 ? store.accounts[index] : undefined
  const merged = previous ? { ...previous, ...input } : { ...input }
  if (!textOf(merged.platform)) {
    throw new WorkbenchError('bad_args', '要选择平台（抖音 / 视频号 / 小红书 / 公众号…）。', 'platform 传平台 key 或中文名都可以。')
  }
  if (!textOf(merged.name) && !textOf(merged.uid) && !textOf(merged.homepage) && !textOf(merged.handle)) {
    throw new WorkbenchError('bad_args', '平台账号至少填「账号名 / 账号 ID / 主页」之一。', '只填粉丝量没法区分是哪个账号。')
  }
  const cardId = textOf(merged.cardId)
  if (cardId && !store.cards.some((card) => card.id === cardId)) merged.cardId = ''
  if (!textOf(merged.id)) merged.id = newId('pa')
  merged.updatedAt = now
  const account = normalizeAccount(merged)
  if (index < 0) store.accounts.push(account)
  else store.accounts[index] = account
  store.updatedAt = now
  writeStore(ctx, store)
  return { account, created: index < 0, store }
}

function deleteAccount(ctx, ref) {
  const store = readStore(ctx)
  const account = requireAccount(store, ref)
  store.accounts = store.accounts.filter((item) => item.id !== account.id)
  store.updatedAt = new Date().toISOString()
  writeStore(ctx, store)
  return { account, store }
}

/** 去掉值为 undefined 的字段，保证工具返回值是可无损 JSON 化的。 */
function clean(value) {
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item
  }
  return out
}

// ------------------------------------------------------------------ 粉丝量采集
/**
 * 跑一次粉丝量采集并把成功结果写回平台账号。
 * @param {object} ctx
 * @param {string[]} refs 平台账号（id / 账号名 / 账号 ID）或定位卡（id / 名称）；
 *                        空数组表示同步全部平台账号
 */
async function syncAndPersist(ctx, refs = []) {
  const store = readStore(ctx)
  const settings = loadSettings()
  const wanted = refs.map((ref) => textOf(ref)).filter(Boolean)
  const accounts = []
  if (wanted.length === 0) {
    accounts.push(...store.accounts)
  } else {
    const seen = new Set()
    for (const ref of wanted) {
      const account = findAccount(store, ref)
      if (account) {
        if (!seen.has(account.id)) {
          seen.add(account.id)
          accounts.push(account)
        }
        continue
      }
      const card = requireCard(store, ref)
      for (const item of platformsOfCard(card, store.accounts)) {
        if (!seen.has(item.id)) {
          seen.add(item.id)
          accounts.push(item)
        }
      }
    }
  }
  if (accounts.length === 0) return { results: [], summary: { total: 0, ok: 0, failed: 0 }, store }
  if (accounts.length > MAX_SYNC_ACCOUNTS) {
    throw new WorkbenchError(
      'too_many_accounts',
      `一次最多同步 ${MAX_SYNC_ACCOUNTS} 个平台账号（本次 ${accounts.length} 个）。`,
      '分批同步：先按定位卡逐个获取，或减少关联的平台账号。',
    )
  }
  const targets = accounts.map((account) => {
    const card = store.cards.find((item) => item.id === account.cardId)
    return { ...account, cardId: account.cardId || '', cardName: card ? card.name : '' }
  })
  const run = await syncTargets({ targets, settings, logger: (level, message) => log(ctx, level, message) })
  const now = new Date().toISOString()
  let changed = false
  for (const result of run.results) {
    if (!result.ok) continue
    const account = store.accounts.find((item) => item.id === result.targetId)
    if (!account) continue
    account.followersCount = result.count
    account.followers = result.display
    account.followersUpdatedAt = result.at || now
    account.followersSource = 'auto'
    account.updatedAt = now
    changed = true
  }
  if (changed) {
    store.updatedAt = now
    writeStore(ctx, store)
  }
  touchLastSync(now)
  return { results: run.results, summary: run.summary, store }
}

/**
 * 把采集结果整理成 Agent / 面板都好读的形状（不含 undefined，保证无损 JSON）。
 * 把「设计上只能手动填写」的平台与「真失败」分开：视频号/公众号不是故障，不该整段标红。
 */
function presentSync(run) {
  const results = run.results.map((item) =>
    clean({
      card: item.cardName,
      cardId: item.cardId,
      platform: item.platform,
      platformLabel: item.platformLabel,
      account: item.targetName,
      ok: Boolean(item.ok),
      followers: item.ok ? item.display : undefined,
      count: item.ok ? item.count : undefined,
      error: item.ok ? undefined : item.error,
      message: item.message,
      hint: item.hint,
    }),
  )
  const manualResults = results.filter((item) => !item.ok && item.error === 'unsupported')
  const failedResults = results.filter((item) => !item.ok && item.error !== 'unsupported')
  const parts = []
  if (run.summary.ok > 0) parts.push(`已更新 ${run.summary.ok} 个平台账号`)
  if (manualResults.length > 0) parts.push(`${manualResults.length} 个需手动填写（${manualResults.map((item) => item.platformLabel).join('、')}没有公开接口）`)
  if (failedResults.length > 0) {
    parts.push(
      `${failedResults.length} 个没取到（${failedResults
        .map((item) => `${item.platformLabel}：${item.message}`)
        .join('；')}）`,
    )
  }
  if (parts.length === 0) parts.push('没有可同步的平台账号')
  return clean({
    total: run.summary.total,
    synced: run.summary.ok,
    manual: manualResults.length,
    failed: failedResults.length,
    results,
    hint: `${parts.join('；')}。${
      failedResults.length > 0 ? '需要 Cookie / 代理的到「凭证设置」配置；也可以直接在定位卡里手动填写粉丝量。' : ''
    }`,
  })
}

// ------------------------------------------------------------------ 选题库
/**
 * 选题库在顶栏/页签里用到的轻量状态（不把全部选题塞进每次 /state 轮询）。
 * 具体某天的选题走 GET /newmedia-workbench/topics?date=YYYY-MM-DD。
 */
function describeTopicsState(ctx) {
  const store = readTopics(ctx)
  const today = todayKey()
  const todayCounts = {}
  for (const topic of store.topics) {
    if (topic.date !== today) continue
    todayCounts[topic.cardId] = (todayCounts[topic.cardId] || 0) + 1
  }
  return clean({
    config: store.config,
    running: GENERATION_STATE.running,
    startedAt: GENERATION_STATE.startedAt || undefined,
    progress: GENERATION_STATE.running
      ? { card: GENERATION_STATE.card, done: GENERATION_STATE.done, total: GENERATION_STATE.total, reason: GENERATION_STATE.reason }
      : undefined,
    lastRunAt: store.lastRunAt || undefined,
    lastRunDate: store.lastRunDate || undefined,
    lastError: store.lastError || undefined,
    total: store.topics.length,
    today,
    todayCounts,
  })
}

/** 某一天的选题，按定位卡分组（没有选题的卡也返回，面板才好放「生成本卡选题」按钮）。 */
function describeTopicsForDate(ctx, date) {
  const store = readStore(ctx)
  const topicsStore = readTopics(ctx)
  const groups = store.cards.map((card) => ({
    cardId: card.id,
    cardName: card.name,
    stage: card.stage,
    niche: card.niche,
    platforms: platformsOfCard(card, store.accounts).map((account) => platformLabelOf(account.platform)),
    topics: topicsStore.topics
      .filter((topic) => topic.cardId === card.id && topic.date === date)
      .sort((a, b) => {
        const left = String(a.createdAt || '')
        const right = String(b.createdAt || '')
        if (left !== right) return right.localeCompare(left)
        return String(a.title).localeCompare(String(b.title), 'zh-CN')
      })
      .map(presentTopic),
  }))
  const total = groups.reduce((sum, group) => sum + group.topics.length, 0)
  return clean({
    ok: true,
    date,
    total,
    groups,
    config: topicsStore.config,
    running: GENERATION_STATE.running,
    progress: GENERATION_STATE.running
      ? { card: GENERATION_STATE.card, done: GENERATION_STATE.done, total: GENERATION_STATE.total, reason: GENERATION_STATE.reason }
      : undefined,
    lastRunAt: topicsStore.lastRunAt || undefined,
    lastRunDate: topicsStore.lastRunDate || undefined,
    lastError: topicsStore.lastError || undefined,
    topicsFile: TOPICS_FILE,
  })
}

/**
 * 为一张定位卡生成当天选题（热点检索 + 默认模型），结果直接写入选题库。
 * force=false 时，当天已有选题就跳过（每日定时用这个），不重复生成。
 */
async function generateCardTopics(ctx, card, options = {}) {
  const date = normalizeDate(options.date) || todayKey()
  const topicsStore = readTopics(ctx)
  const existing = topicsStore.topics.filter((topic) => topic.cardId === card.id && topic.date === date)
  if (!options.force && existing.length > 0) {
    return { skipped: true, date, existing: existing.length, added: [], hotAvailable: true, hotReason: '' }
  }
  const hot = await collectHotMaterial(ctx, card, { date })
  const limit = Math.max(1, Math.min(8, Math.trunc(Number(options.limit) || topicsStore.config.perDay)))
  const items = await generateWithLlm(ctx, card, {
    date,
    limit,
    hot,
    existingTitles: existing.map((topic) => topic.title),
    signal: options.signal,
  })
  const saved = saveTopics(ctx, card, items, { date, source: 'auto' })
  return {
    skipped: false,
    date,
    added: saved.added.map(presentTopic),
    skippedDuplicate: saved.skippedDuplicate,
    skippedLimit: saved.skippedLimit,
    hotAvailable: hot.available,
    hotReason: hot.available ? '' : hot.reason || '',
  }
}

/**
 * 启动一轮后台生成（不会 await 完成）。已有生成在跑时返回 null。
 * 面板、Agent 工具、每日定时都走这里，保证同一时间只有一轮。
 */
function startGeneration(ctx, cards, options = {}) {
  if (GENERATION_STATE.running) return null
  const list = (Array.isArray(cards) ? cards : []).filter((card) => card && card.id)
  if (list.length === 0) {
    throw new WorkbenchError('no_cards', '还没有定位卡，无法生成选题。', '先到「定位卡」页签新建一张。')
  }
  const reason = textOf(options.reason) || 'manual'
  GENERATION_STATE.running = true
  GENERATION_STATE.startedAt = new Date().toISOString()
  GENERATION_STATE.finishedAt = ''
  GENERATION_STATE.card = ''
  GENERATION_STATE.done = 0
  GENERATION_STATE.total = list.length
  GENERATION_STATE.reason = reason
  GENERATION_STATE.errors = []
  const promise = (async () => {
    const results = []
    for (const card of list) {
      GENERATION_STATE.card = card.name
      try {
        const result = await generateCardTopics(ctx, card, options)
        results.push(clean({ card: card.name, cardId: card.id, ...result }))
      } catch (error) {
        const message = String(error && error.message ? error.message : error)
        const code = error instanceof TopicsError ? error.code : 'generation_failed'
        GENERATION_STATE.errors.push(`${card.name}：${message}`)
        results.push(
          clean({
            card: card.name,
            cardId: card.id,
            error: code,
            message,
            hint: error instanceof TopicsError ? error.hint : undefined,
          }),
        )
      }
      GENERATION_STATE.done += 1
    }
    const at = new Date().toISOString()
    const failed = GENERATION_STATE.errors.length
    markRun(ctx, {
      at,
      date: todayKey(),
      complete: options.markComplete !== false && failed === 0,
      error: GENERATION_STATE.errors.join('；'),
    })
    topicRetryAt = failed > 0 ? Date.now() + TOPIC_RETRY_MS : 0
    return { reason, date: todayKey(), results, errors: GENERATION_STATE.errors.slice(), complete: failed === 0 }
  })().finally(() => {
    GENERATION_STATE.running = false
    GENERATION_STATE.card = ''
    GENERATION_STATE.finishedAt = new Date().toISOString()
  })
  GENERATION_STATE.promise = promise
  promise.catch((error) => log(ctx, 'warn', `生成选题失败：${error && error.message ? error.message : error}`))
  return promise
}

/** 每天到点（默认 07:30）为所有定位卡生成当天选题；错过会补生成。 */
function startTopicScheduler(ctx) {
  const tick = () => {
    try {
      if (GENERATION_STATE.running) return
      const store = readStore(ctx)
      if (store.cards.length === 0) return
      const topicsStore = readTopics(ctx)
      const config = topicsStore.config
      if (!config.enabled) return
      const now = new Date()
      const today = todayKey(now)
      if (topicsStore.lastRunDate === today) return
      if (nowHHMM(now) < config.time) return
      if (Date.now() < topicRetryAt) return
      const pending = store.cards.filter(
        (card) => !topicsStore.topics.some((topic) => topic.cardId === card.id && topic.date === today),
      )
      if (pending.length === 0) return
      log(ctx, 'info', `开始每日选题生成（${pending.length} 张定位卡）`)
      startGeneration(ctx, pending, { reason: 'schedule', limit: config.perDay, force: false, markComplete: true })
    } catch (error) {
      log(ctx, 'warn', `每日选题生成检查失败：${error && error.message ? error.message : error}`)
    }
  }
  const interval = setInterval(tick, TOPIC_SCHEDULER_INTERVAL_MS)
  interval.unref?.()
  const startup = setTimeout(tick, TOPIC_SCHEDULER_STARTUP_MS)
  startup.unref?.()
  return () => {
    clearInterval(interval)
    clearTimeout(startup)
  }
}

// ------------------------------------------------------------------ 工具动作
async function runAction(ctx, args = {}) {
  const action = textOf(args.action) || 'list'
  if (action === 'list') {
    const store = readStore(ctx)
    const wanted = textOf(args.platform) ? platformKeyOf(args.platform) : ''
    const cards = store.cards
      .filter((card) => !wanted || platformsOfCard(card, store.accounts).some((item) => item.platform === wanted))
      .map((card) => summarize(card, store.accounts))
    return {
      ok: true,
      total: cards.length,
      accounts: cards,
      hint:
        cards.length > 0
          ? '用 action="context" 取口播上下文（传 account 指定定位卡；不传时单卡自动使用、多卡返回候选）。'
          : '还没有定位卡：可用 action="upsert" 新建，或让用户在左侧「新媒体工作台」面板新建。',
    }
  }
  if (action === 'get') {
    const store = readStore(ctx)
    const card = requireCard(store, args.account)
    return { ok: true, account: presentCard(card, store.accounts), summary: summarize(card, store.accounts) }
  }
  if (action === 'context') {
    const store = readStore(ctx)
    const ref = textOf(args.account)
    if (!ref) {
      if (store.cards.length === 0) {
        return {
          ok: false,
          error: 'no_accounts',
          hint: '当前还没有定位卡。先引导用户到左侧「新媒体工作台」新建一张，或直接按通用风格写并在回复里说明没有读到定位卡。',
        }
      }
      if (store.cards.length === 1) {
        const only = store.cards[0]
        return {
          ok: true,
          account: { id: only.id, name: only.name, stage: only.stage, updatedAt: only.updatedAt },
          context: buildBrief(only, store.accounts),
          auto_selected: true,
          usage: `只有一张定位卡，已自动使用「${only.name}」。把 context 作为生成口播文案的账号上下文，缺失字段视为未知，不要编造。`,
        }
      }
      return {
        ok: false,
        needs_account: true,
        candidates: store.cards.map((item) => ({
          id: item.id,
          name: item.name,
          platforms: platformsOfCard(item, store.accounts).map((account) => platformLabelOf(account.platform)),
          stage: item.stage,
          niche: item.niche,
          persona: item.persona,
        })),
        hint: '有多张定位卡：先用 ask_user_question（multi_select=false）让用户选一张——每个候选一个选项，label 用「定位卡名（关联平台）」，description 写阶段与赛道，并加一个「不指定账号，按通用风格写」；选完再调用 action="context" 并传 account。',
      }
    }
    const card = requireCard(store, ref)
    return {
      ok: true,
      account: { id: card.id, name: card.name, stage: card.stage, updatedAt: card.updatedAt },
      context: buildBrief(card, store.accounts),
      usage: '把 context 作为生成口播文案的账号上下文，严格贴合其中的赛道、受众、人设、语气与禁忌；缺失字段视为未知，不要编造，必要时提醒用户到「新媒体工作台」补充。',
    }
  }
  if (action === 'upsert') {
    if (!isObject(args.data) && !textOf(args.account)) {
      throw new WorkbenchError('bad_args', 'upsert 需要 data 对象（定位卡字段）。', '例如 {"action":"upsert","data":{"name":"老板IP","niche":"企业管理"}}。')
    }
    const data = isObject(args.data) ? args.data : {}
    const result = saveCard(ctx, data, { ref: textOf(args.account) })
    return {
      ok: true,
      created: result.created,
      account: presentCard(result.card, result.store.accounts),
      summary: summarize(result.card, result.store.accounts),
      total: result.store.cards.length,
      hint: result.created ? '定位卡已创建。平台账号请在面板「平台账号」页签里新增并关联，或用 action="link"。' : '定位卡已更新。',
    }
  }
  if (action === 'link') {
    const data = isObject(args.data) ? args.data : {}
    const store = readStore(ctx)
    const card = requireCard(store, args.account)
    const patch = {}
    for (const field of PLATFORM_ACCOUNT_FIELDS) if (data[field] !== undefined) patch[field] = data[field]
    const hasTarget = textOf(patch.platform) || textOf(data.id)
    if (!hasTarget) {
      throw new WorkbenchError('bad_args', 'link 需要 data.platform（平台）或 data.id（已有平台账号 id）。', '例如 {"action":"link","account":"老板IP","data":{"platform":"抖音","uid":"MS4wLjAB...","name":"老板账号"}}。')
    }
    let index = -1
    if (textOf(data.id)) index = store.accounts.findIndex((item) => item.id === textOf(data.id))
    if (index < 0 && textOf(patch.platform)) {
      const key = platformKeyOf(patch.platform)
      index = store.accounts.findIndex((item) => {
        if (item.platform !== key) return false
        if (textOf(patch.uid) && item.uid === textOf(patch.uid)) return true
        if (textOf(patch.homepage) && item.homepage === textOf(patch.homepage)) return true
        return Boolean(textOf(patch.name)) && item.name === textOf(patch.name)
      })
    }
    const previous = index >= 0 ? store.accounts[index] : undefined
    const saved = saveAccount(ctx, {
      ...(previous || {}),
      ...patch,
      cardId: card.id,
      id: previous ? previous.id : undefined,
    })
    let sync = null
    if (args.sync !== false) sync = presentSync(await syncAndPersist(ctx, [card.id]))
    return {
      ok: true,
      account: summarize(card, saved.store.accounts),
      platformAccount: saved.account,
      sync,
      hint: sync ? '平台账号已关联，并已尝试获取粉丝量（看 sync.results）。' : '平台账号已关联到这张定位卡。',
    }
  }
  if (action === 'sync_followers') {
    const refs = textOf(args.account) ? [textOf(args.account)] : []
    if (refs.length === 0 && args.all === false) {
      throw new WorkbenchError('bad_args', 'sync_followers 需要指定定位卡或 all=true。', '传 account 同步一张定位卡下的所有平台账号，或 all=true 同步全部。')
    }
    const run = await syncAndPersist(ctx, refs)
    return clean({ ok: true, ...presentSync(run) })
  }
  if (action === 'topics_list') {
    const store = readStore(ctx)
    const date = normalizeDate(args.date) || todayKey()
    const ref = textOf(args.account)
    const cards = ref ? [requireCard(store, ref)] : store.cards
    if (cards.length === 0) {
      return { ok: true, date, total: 0, groups: [], hint: '还没有定位卡：先让用户在「新媒体工作台 → 定位卡」新建一张，再来生成选题。' }
    }
    const payload = describeTopicsForDate(ctx, date)
    const wanted = new Set(cards.map((card) => card.id))
    const groups = payload.groups.filter((group) => wanted.has(group.cardId))
    const total = groups.reduce((sum, group) => sum + group.topics.length, 0)
    return clean({
      ok: true,
      date,
      total,
      groups,
      config: payload.config,
      hint:
        total > 0
          ? '这些选题只有标题和简介。用户选中某个后，用 action="topics_pick"（topicId）拿定位上下文，再写口播文案 / 脚本正文；正文要重新创作，不要只复述简介。'
          : `「${date}」还没有选题：可以 action="topics_generate"（account 指定定位卡）生成，或按定位卡自己策划后用 action="topics_save" 写入。`,
    })
  }
  if (action === 'topics_generate') {
    const store = readStore(ctx)
    const ref = textOf(args.account)
    const cards = ref ? [requireCard(store, ref)] : store.cards
    if (cards.length === 0) {
      throw new WorkbenchError('no_cards', '还没有定位卡，无法生成选题。', '先让用户在「新媒体工作台 → 定位卡」新建一张。')
    }
    if (GENERATION_STATE.running) {
      throw new WorkbenchError(
        'generation_running',
        `正在生成选题（${GENERATION_STATE.done}/${GENERATION_STATE.total}：${GENERATION_STATE.card || '准备中'}），等这一轮结束再试。`,
        '面板「选题库」页签能看到进度；通常几十秒。',
      )
    }
    const limit = Math.max(1, Math.min(8, Math.trunc(Number(args.limit) || readTopics(ctx).config.perDay)))
    const run = await startGeneration(ctx, cards, { reason: 'tool', force: true, limit, markComplete: false })
    const payload = describeTopicsForDate(ctx, run.date)
    const wanted = new Set(cards.map((card) => card.id))
    const groups = payload.groups.filter((group) => wanted.has(group.cardId))
    const added = run.results.reduce((sum, item) => sum + (Array.isArray(item.added) ? item.added.length : 0), 0)
    return clean({
      ok: run.errors.length === 0,
      date: run.date,
      added,
      results: run.results,
      groups,
      errors: run.errors,
      hint:
        added > 0
          ? '已生成并写入选题库（标题 + 简介）。挑中哪个再用 action="topics_pick" 深化正文。'
          : run.errors.length > 0
            ? '这次没生成成功，看 results 里的错误与 hint；也可以由你按定位卡直接策划，再用 action="topics_save" 写入。'
            : '今天这些卡已有选题，本次没有新增；如需追加可以再生成一次（同标题会自动去重）。',
    })
  }
  if (action === 'topics_save') {
    const data = isObject(args.data) ? args.data : {}
    const items = Array.isArray(data.topics) ? data.topics : Array.isArray(args.topics) ? args.topics : []
    if (items.length === 0) {
      throw new WorkbenchError('bad_args', 'topics_save 需要 data.topics 数组。', '每项传 { title, summary, hot }；summary 是简介，不是正文。')
    }
    const store = readStore(ctx)
    const card = requireCard(store, args.account)
    const date = normalizeDate(args.date) || todayKey()
    const saved = saveTopics(ctx, card, items, { date, source: 'agent' })
    return clean({
      ok: true,
      card: { id: card.id, name: card.name },
      date,
      added: saved.added.map(presentTopic),
      skippedDuplicate: saved.skippedDuplicate,
      skippedLimit: saved.skippedLimit,
      hint:
        saved.added.length > 0
          ? '选题已写入选题库。用户选中后，再按定位卡把标题与简介深化成正文。'
          : '没有新增：标题与当天已有选题重复，或该卡当天已满 8 条。',
    })
  }
  if (action === 'topics_delete') {
    if (textOf(args.topicId)) {
      const topic = deleteTopic(ctx, args.topicId)
      return { ok: true, deleted: presentTopic(topic), hint: `已删除选题《${topic.title}》。` }
    }
    if (args.all === true) {
      const store = readStore(ctx)
      const card = requireCard(store, args.account)
      const removed = deleteTopicsForCard(ctx, card.id, args.date === 'all' ? '' : normalizeDate(args.date) || todayKey())
      return { ok: true, removed, card: { id: card.id, name: card.name }, hint: `已删除「${card.name}」的 ${removed} 条选题。` }
    }
    throw new WorkbenchError('bad_args', 'topics_delete 需要 topicId，或 account + all=true。', '删单条传 topicId；清空一张卡的选题传 account 和 all=true。')
  }
  if (action === 'topics_pick') {
    const topic = pickTopic(ctx, args.topicId)
    const store = readStore(ctx)
    const card = store.cards.find((item) => item.id === topic.cardId)
    return clean({
      ok: true,
      topic: presentTopic(topic),
      context: card ? buildBrief(card, store.accounts) : '',
      hint: card
        ? '用户选中的选题已标记。写正文时把 context 当账号上下文、topic 当选题方向，输出完整口播文案 / 脚本；标题和简介只是选题，不要当成终稿。'
        : '选题已标记，但它所属的定位卡已被删除；按通用风格写，并在回复里说明。',
    })
  }
  if (action === 'status') {
    const store = readStore(ctx)
    const settings = loadSettings()
    return {
      ok: true,
      version: PLUGIN_VERSION,
      total: store.cards.length,
      cards: store.cards.length,
      platformAccounts: store.accounts.length,
      linked: store.accounts.filter((item) => item.uid || item.homepage).length,
      linkedCards: store.accounts.filter((item) => item.cardId).length,
      capabilities: describeCapabilities(),
      settings: describeSettings(settings),
      dataFile: DATA_FILE,
      settingsFile: SETTINGS_FILE,
      hint: 'capabilities 说明每个平台能不能自动取粉丝量、需要什么凭证；凭证与代理在「新媒体工作台 → 凭证设置」里填（只存本机，面板只显示掩码）。',
    }
  }
  if (action === 'delete') {
    const result = deleteCard(ctx, args.account)
    return {
      ok: true,
      deleted: { id: result.card.id, name: result.card.name },
      total: result.store.cards.length,
      hint: `已删除定位卡「${result.card.name}」。它关联的平台账号已保留，可在「平台账号」页签重新关联。`,
    }
  }
  throw new WorkbenchError('bad_action', `不认识的 action：${action}`, '支持 list / get / context / upsert / link / sync_followers / status / delete。')
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
  const fail = (res, error) => {
    const known = error instanceof WorkbenchError
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
        if (raw.length > 1024 * 1024) {
          settled = true
          raw = ''
          reject(new WorkbenchError('bad_args', '请求体过大', '单次保存的数据不能超过 1MB。'))
          // 先拒绝并排空剩余请求体，让响应能正常发出，而不是直接断开连接。
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
          reject(new WorkbenchError('bad_args', '请求体不是合法 JSON', '请刷新页面后重试。'))
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
          throw new WorkbenchError('unsupported_media_type', '请求体需要 application/json。', '面板会自动使用 JSON；不要用表单或纯文本提交。')
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
        if (method === 'GET' && pathname === ROUTE_PREFIX) {
          const store = readStore(ctx)
          return sendJson(res, {
            ok: true,
            plugin: 'newmedia-workbench',
            version: PLUGIN_VERSION,
            total: store.cards.length,
            cards: store.cards.length,
            platformAccounts: store.accounts.length,
            dataFile: DATA_FILE,
            settingsFile: SETTINGS_FILE,
            usage: '在会话里说「按 XX 的定位写一条口播文案」，Agent 会用 newmedia_workbench 工具读取定位卡；一键获取粉丝量见 /followers/sync。',
          })
        }
        if (method === 'GET' && pathname === `${ROUTE_PREFIX}/state`) {
          return sendJson(res, describeStore(ctx))
        }
        if (method === 'POST' && pathname === `${ROUTE_PREFIX}/save`) {
          const body = await readBody(req)
          const input = isObject(body.account) ? body.account : body
          const result = saveCard(ctx, input)
          return sendJson(res, {
            ok: true,
            created: result.created,
            account: presentCard(result.card, result.store.accounts),
            state: describeStore(ctx),
          })
        }
        if (method === 'POST' && pathname === `${ROUTE_PREFIX}/accounts/save`) {
          const body = await readBody(req)
          const input = isObject(body.account) ? body.account : body
          const result = saveAccount(ctx, input)
          return sendJson(res, { ok: true, created: result.created, account: result.account, state: describeStore(ctx) })
        }
        if (method === 'POST' && pathname === `${ROUTE_PREFIX}/accounts/delete`) {
          const body = await readBody(req)
          const ref = textOf(body.id) || textOf(body.account) || textOf(body.name)
          const result = deleteAccount(ctx, ref)
          return sendJson(res, {
            ok: true,
            deleted: { id: result.account.id, name: result.account.name },
            state: describeStore(ctx),
          })
        }
        if (method === 'POST' && pathname === `${ROUTE_PREFIX}/delete`) {
          const body = await readBody(req)
          const ref = textOf(body.id) || textOf(body.account) || textOf(body.name)
          const result = deleteCard(ctx, ref)
          return sendJson(res, { ok: true, deleted: { id: result.card.id, name: result.card.name }, state: describeStore(ctx) })
        }
        if (method === 'GET' && pathname === `${ROUTE_PREFIX}/context`) {
          const ref = url.searchParams.get('id') || url.searchParams.get('account') || ''
          const store = readStore(ctx)
          const card = requireCard(store, ref)
          return sendJson(res, {
            ok: true,
            account: { id: card.id, name: card.name, stage: card.stage, updatedAt: card.updatedAt },
            context: buildBrief(card, store.accounts),
          })
        }
        if (method === 'GET' && pathname === `${ROUTE_PREFIX}/settings`) {
          return sendJson(res, { ok: true, settings: describeSettings(loadSettings()), capabilities: describeCapabilities() })
        }
        if (method === 'POST' && pathname === `${ROUTE_PREFIX}/settings`) {
          const body = await readBody(req)
          const input = isObject(body.settings) ? body.settings : body
          const clear = Array.isArray(body.clear) ? body.clear : []
          saveSettings(input, { clear })
          return sendJson(res, { ok: true, settings: describeSettings(loadSettings()), state: describeStore(ctx) })
        }
        if (method === 'POST' && pathname === `${ROUTE_PREFIX}/followers/sync`) {
          const body = await readBody(req)
          const ref = textOf(body.id) || textOf(body.account)
          const run = await syncAndPersist(ctx, ref ? [ref] : [])
          return sendJson(res, { ok: true, ...presentSync(run), state: describeStore(ctx) })
        }
        return sendJson(res, { ok: false, error: 'not_found', message: `未知路由 ${method} ${pathname}` }, 404)
      }),
    }),
  )
  return true
}

// ------------------------------------------------------------------ 插件入口
export function apply(ctx) {
  // 一次性迁移：v1–v3 的「卡内嵌平台账号」在启动时写成 v4 的 cards + accounts，
  // 保证磁盘结构和面板读到的结构一致（幂等：已经是 v4 就不再写）。
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
      if (!Array.isArray(parsed.cards) || parsed.version !== STORE_VERSION) {
        const migrated = readStore(ctx)
        writeStore(ctx, migrated)
        log(ctx, 'info', `已迁移账号数据到 v${STORE_VERSION}：${migrated.cards.length} 张定位卡 / ${migrated.accounts.length} 个平台账号`)
      }
    }
  } catch (error) {
    log(ctx, 'warn', `迁移账号数据失败（继续用内存结构运行）：${error && error.message ? error.message : error}`)
  }

  // Agent 工具：口播文案前取定位上下文、定位卡增删改查、平台账号关联与粉丝量采集。
  const outputSchema = {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  }
  ctx.effect(() =>
    ctx.tools.register({
      name: 'newmedia_workbench',
      description:
        '新媒体工作台：本机存两类数据——「定位卡」（账号人设：赛道/受众/人设/语气/内容支柱/禁忌）和「平台账号」（抖音/视频号/小红书/公众号等，可关联到某张定位卡）。写口播文案、短视频脚本或账号内容策划前，先用 action="context" 取目标定位卡的上下文（含它关联的平台账号与粉丝量），按其中信息生成内容；定位卡没写的字段视为未知，不要编造。用户没指定时 context 不要传 account：只有一张卡会自动使用，多张卡会返回候选，此时先用 ask_user_question 让用户选一个再重试。'
        + '平台账号与定位卡是分开的：用户要求「把某个平台账号关联到定位卡」时用 action="link"（account 定位卡 + data.platform/data.name/data.uid）；要求「更新/获取粉丝量」时用 action="sync_followers"（不传 account 即全部平台账号），失败时按 hint 引导用户手动填写或到面板「凭证设置」配置 Cookie/代理。'
        + 'action="status" 可查各平台采集能力与凭证状态（只返回掩码）。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'get', 'context', 'upsert', 'link', 'sync_followers', 'status', 'delete'],
            description: 'list 列定位卡摘要；get 读一张完整定位卡（含关联的平台账号）；context 取口播文案用上下文（写文案时用这个）；upsert 新建/更新定位卡的人设字段；link 把平台账号关联到定位卡（默认顺带取一次粉丝量）；sync_followers 获取粉丝量（account 指定平台账号或定位卡，不传则全部）；status 查采集能力与凭证配置状态；delete 删除定位卡（关联的平台账号保留）。',
          },
          account: {
            type: 'string',
            description: '定位卡 id 或名称（也接受平台账号名 / 账号 ID，会反查它关联的定位卡）。get / context / delete / link / sync_followers 用它指定对象。context 不传时：只有一张卡会自动使用，多张卡返回候选。',
          },
          platform: {
            type: 'string',
            description: '仅 list 使用：按平台过滤，取值为 douyin、shipinhao、xiaohongshu、wechat、bilibili、kuaishou、youtube、tiktok、other 之一；一张卡关联多个平台时任一平台命中即返回。',
          },
          all: {
            type: 'boolean',
            description: '仅 sync_followers 使用：true 表示同步全部平台账号（默认行为也是全部；传 false 时必须指定 account）。',
          },
          sync: {
            type: 'boolean',
            description: '仅 link 使用：关联完是否立刻获取粉丝量，默认 true；传 false 只保存关联信息。',
          },
          data: {
            type: 'object',
            additionalProperties: true,
            description:
              'upsert 的定位卡字段（增量合并，不含平台账号）：name 定位卡名、stage 账号阶段、niche 内容赛道、audience 目标受众、persona 人设标签、value 核心价值主张、pillars 内容支柱、tone 语气风格、hookStyle 开场钩子偏好、differentiator 差异化记忆点、goal 阶段目标、monetization 变现方式、taboo 禁忌与红线、keywords 关键词/标签、references 对标账号、notes 补充说明。'
              + 'upsert 仍兼容传 platforms 数组（会把这张卡关联的平台账号整体替换）；'
              + 'link 只取单平台字段：platform、name、uid、homepage、handle、followers、followersCount、note。'
              + 'pillars/taboo/keywords 可传数组或换行/顿号分隔的字符串。',
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
          return await runAction(ctx, args)
        } catch (error) {
          return clean({
            ok: false,
            error: error instanceof WorkbenchError ? error.code : 'internal_error',
            message: String(error && error.message ? error.message : error),
            hint: error instanceof WorkbenchError ? error.hint : undefined,
          })
        }
      },
    }),
  )

  // 全局提示：写口播文案时先取定位卡；多卡时自动弹 ask_user_question 让用户选卡。
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    ctx.effect(() => systemPrompt.section({ name: 'newmedia-workbench', order: 850, text: SYSTEM_PROMPT_TEXT }))
  } else {
    log(ctx, 'warn', 'systemPrompt 服务不可用：不会提示 Agent 自动读取定位卡（工具本身不受影响）')
  }

  // Host 服务：同进程的其他插件直接复用同一套数据读写。
  if (typeof ctx.provide === 'function') {
    ctx.effect(() =>
      ctx.provide('newmediaWorkbench', {
        version: PLUGIN_VERSION,
        list: () => {
          const store = readStore(ctx)
          return store.cards.map((card) => summarize(card, store.accounts))
        },
        get: (ref) => {
          const store = readStore(ctx)
          return presentCard(requireCard(store, ref), store.accounts)
        },
        context: (ref) => {
          const store = readStore(ctx)
          return buildBrief(requireCard(store, ref), store.accounts)
        },
        upsert: (input) => saveCard(ctx, input).card,
        remove: (ref) => deleteCard(ctx, ref).card,
        accounts: () => readStore(ctx).accounts,
        saveAccount: (input) => saveAccount(ctx, input).account,
        deleteAccount: (ref) => deleteAccount(ctx, ref).account,
        link: (ref, patch) => {
          const store = readStore(ctx)
          const card = requireCard(store, ref)
          const saved = saveAccount(ctx, { ...(patch || {}), cardId: card.id })
          return presentCard(card, saved.store.accounts)
        },
        syncFollowers: (ref) => syncAndPersist(ctx, ref ? [textOf(ref)] : []),
        status: () => describeSettings(loadSettings()),
        dataFile: DATA_FILE,
        settingsFile: SETTINGS_FILE,
      }),
    )
  }

  // 同源 HTTP：webServer 由其他行提供，激活顺序不保证，拿不到就短暂重试。
  const webState = { registered: false, attempts: 0, error: '', timer: null }
  const registerWebRoutes = () => {
    webState.attempts += 1
    if (webState.registered) return true
    try {
      const mounted = mountWebRoutes(ctx)
      if (!mounted) {
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
    if (webState.registered || webState.timer) return
    if (webState.attempts >= 40) {
      log(ctx, 'warn', `webServer 重试 ${webState.attempts} 次仍不可用，面板接口未启用：${webState.error || '未知原因'}（Agent 工具不受影响）`)
      return
    }
    webState.timer = setTimeout(() => {
      webState.timer = null
      if (webState.registered) return
      if (registerWebRoutes()) return
      scheduleWebRetry()
    }, 500)
    webState.timer.unref?.()
  }
  if (!registerWebRoutes()) scheduleWebRetry()
  ctx.effect(() => () => {
    if (webState.timer) {
      clearTimeout(webState.timer)
      webState.timer = null
    }
  })

  log(ctx, 'info', `已加载，数据文件：${DATA_FILE}`)
}

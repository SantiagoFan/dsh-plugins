/**
 * 选题库：按定位卡每天生成「标题 + 一句话简介」的选题，只存选题本身，不存正文。
 *
 * 存放位置：~/.dsh/newmedia-workbench/topics.json（目录 0700、文件 0600）。
 * 生成链路：Host 的 ctx.web.search 取当天热点素材 → ctx.llm.stream 用默认模型
 * 结合定位卡（赛道/受众/人设/支柱/禁忌）生成 → 解析 JSON → 落盘。
 * 定时任务在 index.js 里驱动，本模块只负责数据、检索与一次生成。
 *
 * 设计约定：
 *  - 一条选题 = { title, summary, hot }，summary 是简介不是正文；
 *  - 同一张卡同一天按标题去重，重复生成只追加新选题；
 *  - 删除是真删除（用户要求「我可以删除」）；
 *  - 旧数据按 retainDays 自动清理，避免文件无限增长。
 */
import fs from 'node:fs'
import path from 'node:path'

import { DATA_DIR } from './settings.js'

export const TOPICS_FILE = path.join(DATA_DIR, 'topics.json')
export const TOPICS_VERSION = 1
export const TOPIC_MAX_LIMIT = 8
export const TOPIC_MIN_LIMIT = 1
export const DEFAULT_TOPIC_CONFIG = Object.freeze({
  enabled: true,
  time: '07:30',
  perDay: 5,
  retainDays: 60,
})

const MAX_TITLE = 120
const MAX_SUMMARY = 400
const MAX_HOT = 240
const MIN_RETAIN_DAYS = 7
const MAX_RETAIN_DAYS = 365
const SEARCH_MAX_RESULTS = 6
const SEARCH_TIMEOUT_MS = 15000
const LLM_TIMEOUT_MS = 90000

export class TopicsError extends Error {
  constructor(code, message, hint) {
    super(message)
    this.name = 'TopicsError'
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

const clampText = (value, max) => {
  const text = textOf(value).replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const pad2 = (n) => String(n).padStart(2, '0')

/** 本地日期 YYYY-MM-DD。 */
export function todayKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** 本地时间 HH:MM。 */
export function nowHHMM(date = new Date()) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** 接受 YYYY-MM-DD / 今天 / today / Date，返回合法日期串，非法返回 ''。 */
export function normalizeDate(value) {
  const raw = textOf(value)
  if (!raw) return ''
  if (raw === '今天' || raw.toLowerCase() === 'today') return todayKey()
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (!match) return ''
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return ''
  return raw
}

const hashId = (prefix, seed) => {
  let hash = 5381
  for (let i = 0; i < seed.length; i += 1) hash = ((hash * 33) ^ seed.charCodeAt(i)) >>> 0
  return `${prefix}_${hash.toString(36)}_${seed.length.toString(36)}`
}

const newId = () => `tp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

function log(ctx, level, message) {
  const fn = ctx && ctx.logger ? ctx.logger[level] : undefined
  if (typeof fn === 'function') fn.call(ctx.logger, `[newmedia-workbench] ${message}`)
}

/** 该选题的归一化标题（去空白与标点），用于同一天去重。 */
const titleKey = (title) => textOf(title).toLowerCase().replace(/[\s、，,。.!！?？:：;；"'“”‘’（）()【】\[\]-]/g, '')

export function normalizeConfig(input, base = DEFAULT_TOPIC_CONFIG) {
  const previous = isObject(base) ? base : DEFAULT_TOPIC_CONFIG
  const merged = isObject(input) ? input : {}
  const enabled = merged.enabled === undefined ? previous.enabled : Boolean(merged.enabled)
  let time = textOf(merged.time) || previous.time || DEFAULT_TOPIC_CONFIG.time
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(time)
  if (timeMatch) {
    const hour = Math.max(0, Math.min(23, Number(timeMatch[1])))
    const minute = Math.max(0, Math.min(59, Number(timeMatch[2])))
    time = `${pad2(hour)}:${pad2(minute)}`
  } else {
    time = DEFAULT_TOPIC_CONFIG.time
  }
  const perDayRaw = Number(merged.perDay === undefined ? previous.perDay : merged.perDay)
  const perDay = Number.isFinite(perDayRaw) ? Math.max(TOPIC_MIN_LIMIT, Math.min(TOPIC_MAX_LIMIT, Math.trunc(perDayRaw))) : DEFAULT_TOPIC_CONFIG.perDay
  const retainRaw = Number(merged.retainDays === undefined ? previous.retainDays : merged.retainDays)
  const retainDays = Number.isFinite(retainRaw)
    ? Math.max(MIN_RETAIN_DAYS, Math.min(MAX_RETAIN_DAYS, Math.trunc(retainRaw)))
    : DEFAULT_TOPIC_CONFIG.retainDays
  return { enabled, time, perDay, retainDays }
}

function normalizeTopic(input, fallback = {}) {
  const source = isObject(input) ? input : {}
  const cardId = textOf(source.cardId) || textOf(fallback.cardId)
  const date = normalizeDate(source.date) || normalizeDate(fallback.date) || todayKey()
  const title = clampText(source.title, MAX_TITLE)
  if (!cardId || !title) return null
  const createdAt = textOf(source.createdAt) || textOf(fallback.createdAt) || new Date().toISOString()
  const status = textOf(source.status) === 'picked' ? 'picked' : 'new'
  const sourceTag = ['auto', 'agent', 'manual'].includes(textOf(source.source)) ? textOf(source.source) : 'auto'
  return {
    id: textOf(source.id) || hashId('tp', `${cardId}|${date}|${titleKey(title)}|${createdAt}`),
    cardId,
    cardName: clampText(source.cardName || fallback.cardName, 80),
    date,
    title,
    summary: clampText(source.summary, MAX_SUMMARY),
    hot: clampText(source.hot, MAX_HOT),
    source: sourceTag,
    status,
    pickedAt: textOf(source.pickedAt),
    createdAt,
    updatedAt: textOf(source.updatedAt) || createdAt,
  }
}

export function emptyTopicsStore() {
  return {
    version: TOPICS_VERSION,
    updatedAt: '',
    config: { ...DEFAULT_TOPIC_CONFIG },
    lastRunAt: '',
    lastRunDate: '',
    lastError: '',
    topics: [],
  }
}

export function readTopics(ctx) {
  try {
    const parsed = JSON.parse(fs.readFileSync(TOPICS_FILE, 'utf8'))
    const store = emptyTopicsStore()
    store.updatedAt = textOf(parsed.updatedAt)
    store.config = normalizeConfig(parsed.config)
    store.lastRunAt = textOf(parsed.lastRunAt)
    store.lastRunDate = normalizeDate(parsed.lastRunDate)
    store.lastError = clampText(parsed.lastError, 500)
    const seen = new Set()
    store.topics = (Array.isArray(parsed.topics) ? parsed.topics : [])
      .map((item) => normalizeTopic(item))
      .filter((item) => {
        if (!item || seen.has(item.id)) return false
        seen.add(item.id)
        return true
      })
    return store
  } catch (error) {
    if (!error || error.code !== 'ENOENT') log(ctx, 'warn', `读取选题库失败：${error && error.message ? error.message : error}`)
    return emptyTopicsStore()
  }
}

/** 按 retainDays 只保留最近 N 天（含今天）。 */
function pruneTopics(topics, retainDays) {
  const now = new Date()
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (retainDays - 1))
  const cutoffKey = todayKey(cutoff)
  return topics.filter((item) => item.date >= cutoffKey)
}

export function writeTopics(ctx, store) {
  const config = normalizeConfig(store.config)
  const payload = {
    version: TOPICS_VERSION,
    updatedAt: new Date().toISOString(),
    config,
    lastRunAt: textOf(store.lastRunAt),
    lastRunDate: normalizeDate(store.lastRunDate),
    lastError: clampText(store.lastError, 500),
    topics: pruneTopics(Array.isArray(store.topics) ? store.topics : [], config.retainDays),
  }
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  const tmp = `${TOPICS_FILE}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, TOPICS_FILE)
  return payload
}

/** 面板 / Agent 可读的一条选题。 */
export function presentTopic(topic) {
  return {
    id: topic.id,
    cardId: topic.cardId,
    cardName: topic.cardName,
    date: topic.date,
    title: topic.title,
    summary: topic.summary,
    hot: topic.hot,
    source: topic.source,
    status: topic.status,
    pickedAt: topic.pickedAt,
    createdAt: topic.createdAt,
  }
}

/** 同一天同一张卡按标题去重后追加；最多保留 MAX_TOPIC_LIMIT 条/天。 */
export function saveTopics(ctx, card, items, options = {}) {
  const date = normalizeDate(options.date) || todayKey()
  const source = ['auto', 'agent', 'manual'].includes(textOf(options.source)) ? textOf(options.source) : 'auto'
  const store = readTopics(ctx)
  const existing = store.topics.filter((item) => item.cardId === card.id && item.date === date)
  const seen = new Set(existing.map((item) => titleKey(item.title)))
  const added = []
  let skippedDuplicate = 0
  let skippedLimit = 0
  const incoming = Array.isArray(items) ? items : []
  for (const item of incoming) {
    const topic = normalizeTopic(
      { ...item, cardId: card.id, cardName: card.name, date, source },
      { cardId: card.id, cardName: card.name, date },
    )
    if (!topic) continue
    const key = titleKey(topic.title)
    if (seen.has(key)) {
      skippedDuplicate += 1
      continue
    }
    if (existing.length + added.length >= TOPIC_MAX_LIMIT) {
      skippedLimit += 1
      continue
    }
    seen.add(key)
    added.push(topic)
  }
  if (added.length > 0) {
    store.topics.push(...added)
    writeTopics(ctx, store)
  }
  return { added, skippedDuplicate, skippedLimit, date }
}

export function deleteTopic(ctx, id) {
  const target = textOf(id)
  const store = readTopics(ctx)
  const topic = store.topics.find((item) => item.id === target)
  if (!topic) {
    throw new TopicsError('topic_not_found', `没有找到选题「${target || '(空)'}」。`, '刷新选题库后再试。')
  }
  store.topics = store.topics.filter((item) => item.id !== target)
  writeTopics(ctx, store)
  return topic
}

/** 删除某张卡某天（date 为空 = 全部日期）的选题。 */
export function deleteTopicsForCard(ctx, cardId, date = '') {
  const day = normalizeDate(date)
  const store = readTopics(ctx)
  const before = store.topics.length
  store.topics = store.topics.filter((item) => {
    if (item.cardId !== cardId) return true
    if (day && item.date !== day) return true
    return false
  })
  const removed = before - store.topics.length
  if (removed > 0) writeTopics(ctx, store)
  return removed
}

export function pickTopic(ctx, id) {
  const target = textOf(id)
  const store = readTopics(ctx)
  const topic = store.topics.find((item) => item.id === target)
  if (!topic) {
    throw new TopicsError('topic_not_found', `没有找到选题「${target || '(空)'}」。`, '刷新选题库后再试。')
  }
  topic.status = 'picked'
  topic.pickedAt = new Date().toISOString()
  topic.updatedAt = topic.pickedAt
  writeTopics(ctx, store)
  return topic
}

export function updateTopicConfig(ctx, patch = {}) {
  const store = readTopics(ctx)
  const config = normalizeConfig({ ...store.config, ...(isObject(patch) ? patch : {}) })
  store.config = config
  writeTopics(ctx, store)
  return config
}

/** 记录一次生成运行；只有整轮跑完（options.complete）才更新 lastRunDate。 */
export function markRun(ctx, options = {}) {
  const store = readTopics(ctx)
  const at = textOf(options.at) || new Date().toISOString()
  store.lastRunAt = at
  if (options.complete) store.lastRunDate = normalizeDate(options.date) || todayKey()
  store.lastError = clampText(options.error, 500)
  writeTopics(ctx, store)
}

export function touchRun(ctx, at = new Date().toISOString()) {
  const store = readTopics(ctx)
  store.lastRunAt = at
  store.lastError = ''
  writeTopics(ctx, store)
}

// ------------------------------------------------------------------ 生成

/**
 * 用 Host 的 web 服务检索当天热点素材（取不到不报错，返回 available:false）。
 * 查询词由赛道 + 关键词 + 年月组成，尽量让结果落在账号赛道内。
 */
export async function collectHotMaterial(ctx, card, options = {}) {
  const web = ctx && typeof ctx.get === 'function' ? ctx.get('web') : undefined
  if (!web || typeof web.search !== 'function') {
    return { available: false, reason: '当前没有可用的联网搜索服务', items: [], query: '' }
  }
  const date = normalizeDate(options.date) || todayKey()
  const year = date.slice(0, 4)
  const month = Number(date.slice(5, 7))
  const keys = [textOf(card.niche)]
    .concat(textOf(card.keywords) ? textOf(card.keywords).split(/[\n、，,;；]+/).map(textOf).filter(Boolean).slice(0, 3) : [])
    .concat(textOf(card.pillars) ? textOf(card.pillars).split(/[\n、，,;；]+/).map(textOf).filter(Boolean).slice(0, 2) : [])
    .filter(Boolean)
    .join(' ')
  const query = `${keys || textOf(card.name)} ${year}年${month}月 热点 话题 趋势`.replace(/\s+/g, ' ').trim()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
  timer.unref?.()
  try {
    const result = await web.search(
      { query, maxResults: SEARCH_MAX_RESULTS, llmProvider: options.llmProvider },
      controller.signal,
    )
    const items = (Array.isArray(result && result.sources) ? result.sources : [])
      .map((item) => ({
        title: clampText(item && item.title, 120),
        snippet: clampText((item && (item.snippet || item.summary)) || '', 240),
        url: textOf(item && item.url),
        publishedAt: textOf(item && item.publishedAt),
      }))
      .filter((item) => item.title || item.snippet)
      .slice(0, SEARCH_MAX_RESULTS)
    const summary = clampText(result && result.content, 1200)
    return { available: items.length > 0, reason: items.length > 0 ? '' : '搜索没有返回可用结果', items, summary, query }
  } catch (error) {
    return {
      available: false,
      reason: clampText(error && error.message ? error.message : error, 200),
      items: [],
      summary: '',
      query,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 把检索结果压成提示词里的「今日热点素材」。 */
function hotMaterialText(hot) {
  if (!hot) return ''
  const lines = []
  if (hot.summary) lines.push(`- 摘要：${hot.summary}`)
  for (const item of Array.isArray(hot.items) ? hot.items : []) {
    const parts = [item.title || item.snippet]
    if (item.snippet && item.snippet !== item.title) parts.push(item.snippet)
    lines.push(`- ${parts.join('：')}`)
  }
  return lines.join('\n')
}

function systemPromptForTop() {
  return [
    '你是资深新媒体选题策划，服务对象是中文短视频 / 图文账号的运营者。',
    '你的任务：结合账号定位与当天热点素材，为这个账号设计选题。',
    '硬性要求：',
    '1. 只输出「标题 + 一句话简介」，绝不写正文、脚本、分镜或拍摄建议。',
    '2. 标题具体、有钩子、口语化，30 字以内；不要「震惊」「必看」「速看」这类标题党词。',
    '3. 优先用热点素材里与账号赛道真正相关的部分；热点不相关就不要硬蹭，改从赛道当下的真实议题选题，并把 hot 留空。',
    '4. 严格遵守账号的禁忌与红线；不编造政策、数据、案例、资质，不确定的事实不要写进标题或简介。',
    '5. 简介 40-80 字，说清楚「讲什么、给谁看、看点在哪」，不要写成正文。',
    '6. 输出严格的 JSON 数组，不要 markdown 代码块，不要任何解释文字：',
    '[{"title":"标题","summary":"一句话简介","hot":"用到的热点或依据（没有就空字符串）"}]',
  ].join('\n')
}

function buildUserPrompt(card, hot, { date, limit, existingTitles }) {
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(`${date}T12:00:00`).getDay()]
  const lines = []
  lines.push(`今天是 ${date}（${weekday}）。请为下面这个账号生成 ${limit} 个选题。`)
  lines.push('')
  lines.push('## 账号定位')
  lines.push(`- 定位卡名：${card.name}`)
  if (card.stage) lines.push(`- 账号阶段：${card.stage}`)
  if (card.niche) lines.push(`- 内容赛道：${card.niche}`)
  if (card.audience) lines.push(`- 目标受众：${card.audience}`)
  if (card.persona) lines.push(`- 人设标签：${card.persona}`)
  if (card.value) lines.push(`- 核心价值主张：${card.value}`)
  if (card.pillars) lines.push(`- 内容支柱：${textOf(card.pillars).replace(/\n/g, '；')}`)
  if (card.tone) lines.push(`- 语气风格：${card.tone}`)
  if (card.hookStyle) lines.push(`- 开场钩子偏好：${card.hookStyle}`)
  if (card.differentiator) lines.push(`- 差异化记忆点：${card.differentiator}`)
  if (card.goal) lines.push(`- 当前阶段目标：${card.goal}`)
  if (card.taboo) lines.push(`- 禁忌与红线：${textOf(card.taboo).replace(/\n/g, '；')}`)
  if (card.keywords) lines.push(`- 关键词 / 标签：${textOf(card.keywords).replace(/\n/g, '、')}`)
  lines.push('')
  const material = hotMaterialText(hot)
  if (material) {
    lines.push('## 今日热点素材（来自联网搜索，可能不完全准确，不要直接引用未核实的事实）')
    lines.push(material)
  } else {
    lines.push('## 今日热点素材')
    lines.push('- 本次没有取到可用的实时热点：不要编造热点，改为从该赛道的常青议题和当下真实痛点里选题，hot 留空。')
  }
  if (existingTitles.length > 0) {
    lines.push('')
    lines.push('## 今天已生成的选题（不要重复）')
    for (const title of existingTitles) lines.push(`- ${title}`)
  }
  lines.push('')
  lines.push(`现在输出 ${limit} 个选题的 JSON 数组。`)
  return lines.join('\n')
}

/** 从模型输出里提取 JSON 选题数组（容忍 ```json 代码块与前后解释文字）。 */
export function parseTopicItems(raw) {
  const text = String(raw || '').replace(/```json/gi, '```').replace(/```/g, '').trim()
  if (!text) throw new TopicsError('empty_output', '模型没有返回内容。', '稍后重试，或在对话里让 AI 直接生成选题。')
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  let parsed = null
  if (start >= 0 && end > start) {
    try {
      parsed = JSON.parse(text.slice(start, end + 1))
    } catch {
      parsed = null
    }
  }
  if (!parsed) {
    // 少数模型会输出 {"topics":[...]} 或单个对象，兼容一下。
    try {
      const object = JSON.parse(text)
      if (Array.isArray(object)) parsed = object
      else if (isObject(object) && Array.isArray(object.topics)) parsed = object.topics
      else if (Array.isArray(object && object.items)) parsed = object.items
      else if (isObject(object) && textOf(object.title)) parsed = [object]
    } catch {
      parsed = null
    }
  }
  if (!Array.isArray(parsed)) {
    throw new TopicsError('bad_output', '模型返回的不是选题 JSON 数组。', '可以重试一次；连续失败时在对话里让 AI 直接出选题。')
  }
  const items = parsed
    .filter(isObject)
    .map((item) => ({
      title: clampText(item.title, MAX_TITLE),
      summary: clampText(item.summary || item.intro || item.description, MAX_SUMMARY),
      hot: clampText(item.hot || item.reason || item.basis, MAX_HOT),
    }))
    .filter((item) => item.title)
  if (items.length === 0) {
    throw new TopicsError('bad_output', '模型返回的选题里没有有效标题。', '重试一次；仍失败就改用对话里生成。')
  }
  return items
}

/**
 * 一次模型调用生成选题。
 * @param {object} ctx Host context（用 ctx.get('llm') / ctx.get('agentDefaultModel')）
 * @param {object} card 定位卡
 * @param {{ date?: string, limit?: number, hot?: object, existingTitles?: string[], signal?: AbortSignal }} options
 */
export async function generateWithLlm(ctx, card, options = {}) {
  const llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm') : undefined
  if (!llm || typeof llm.stream !== 'function') {
    throw new TopicsError(
      'llm_unavailable',
      '当前没有可用的模型服务，无法自动生成选题。',
      '可以在对话里说「按某张定位卡出 5 个选题」，让 AI 生成后用 topics_save 写入；或检查 DSH 的模型配置。',
    )
  }
  const defaults = ctx && typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined
  const selection = defaults && typeof defaults.currentSelection === 'function' ? defaults.currentSelection() : null
  const provider = textOf(selection && selection.provider)
  const model = textOf(selection && selection.model)
  if (!provider || !model) {
    throw new TopicsError('llm_unavailable', '没有读到默认模型（provider / model 为空）。', '在 DSH 设置里选择一个默认模型后重试。')
  }
  const date = normalizeDate(options.date) || todayKey()
  const limit = Math.max(TOPIC_MIN_LIMIT, Math.min(TOPIC_MAX_LIMIT, Math.trunc(Number(options.limit) || DEFAULT_TOPIC_CONFIG.perDay)))
  const existingTitles = (Array.isArray(options.existingTitles) ? options.existingTitles : []).map(textOf).filter(Boolean).slice(0, 8)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)
  timer.unref?.()
  const onAbort = () => controller.abort()
  if (options.signal) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', onAbort, { once: true })
  }
  let raw = ''
  let failure = null
  try {
    const request = {
      provider,
      model,
      system: systemPromptForTop(),
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: buildUserPrompt(card, options.hot, { date, limit, existingTitles }) }],
        },
      ],
      temperature: 0.85,
      maxTokens: 2200,
      signal: controller.signal,
    }
    if (textOf(selection && selection.reasoningEffort)) request.reasoningEffort = selection.reasoningEffort
    for await (const chunk of llm.stream(request)) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta') raw += chunk.text || ''
      else if (chunk.type === 'finish') {
        const kind = chunk.reason && chunk.reason.kind
        if (kind === 'error' || kind === 'aborted') failure = (chunk.reason && chunk.reason.failure) || { message: kind }
      }
    }
  } catch (error) {
    throw new TopicsError(
      'llm_failed',
      `生成选题失败：${error && error.message ? error.message : error}`,
      '稍后重试；也可以在对话里让 AI 直接生成选题。',
    )
  } finally {
    clearTimeout(timer)
    if (options.signal) options.signal.removeEventListener?.('abort', onAbort)
  }
  if (failure) {
    throw new TopicsError(
      'llm_failed',
      `生成选题失败：${failure.message || '模型返回错误'}`,
      failure.code === 'RATE_LIMIT' ? '触发限流，稍等几分钟再试。' : '稍后重试；也可以在对话里让 AI 直接生成选题。',
    )
  }
  return parseTopicItems(raw)
}

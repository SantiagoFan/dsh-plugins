/**
 * 待办数据的读写与校验。
 *
 * 数据只保存在本机 ~/.dsh/todo-workbench/todos.json（目录 0700、文件 0600）。
 * 可以用环境变量 DSH_TODO_WORKBENCH_DIR 覆盖目录（测试用）。
 *
 * 这里的函数都不依赖 Cordis Context：Host 的 Agent 工具、HTTP 路由和测试脚本
 * 共用同一套逻辑，避免两条入口写出不同的数据。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DATA_DIR = process.env.DSH_TODO_WORKBENCH_DIR || path.join(os.homedir(), '.dsh', 'todo-workbench')
export const DATA_FILE = path.join(DATA_DIR, 'todos.json')
export const STORE_VERSION = 1

export const PRIORITIES = [
  { key: 'high', label: '高' },
  { key: 'medium', label: '中' },
  { key: 'low', label: '低' },
]
export const PRIORITY_KEYS = PRIORITIES.map((item) => item.key)
export const DEFAULT_CATEGORIES = ['工作', '生活', '学习', '其他']

const MAX_TODOS = 2000
const MAX_TITLE = 200
const MAX_NOTE = 4000
const MAX_TAGS = 12
const MAX_TAG_LEN = 24
const MAX_CATEGORY = 20

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 }
const BUCKET_RANK = { overdue: 0, today: 1, week: 2, later: 3, none: 4 }

/** 带提示语的可预期错误：Agent 工具与面板都把它翻译成 { error, message, hint }。 */
export class TodoError extends Error {
  constructor(code, message, hint) {
    super(message)
    this.name = 'TodoError'
    this.code = code
    this.hint = hint || ''
  }
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const textOf = (value) => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim()
  return ''
}

const nowIso = () => new Date().toISOString()

const newId = () =>
  `td_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

const pad2 = (value) => String(value).padStart(2, '0')

/** 本地日期键 YYYY-MM-DD（用户看到的「今天」按本机时区算）。 */
export function dateKeyOf(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

export function todayKey() {
  return dateKeyOf(new Date())
}

/** 严格校验 YYYY-MM-DD，不合法返回 ''。 */
export function dateKey(value) {
  const text = textOf(value)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return ''
  const [y, m, d] = text.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return ''
  return text
}

const addDays = (key, days) => {
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  date.setDate(date.getDate() + days)
  return dateKeyOf(date)
}

/** 本周日（周一为一周第一天）。 */
export function endOfWeek(today = todayKey()) {
  const [y, m, d] = today.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const weekday = (date.getDay() + 6) % 7 // 周一=0 … 周日=6
  return addDays(today, 6 - weekday)
}

/** 两个日期键之间相差的天数（to - from）。 */
export function daysBetween(from, to) {
  if (!from || !to) return 0
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  const a = Date.UTC(fy, fm - 1, fd)
  const b = Date.UTC(ty, tm - 1, td)
  return Math.round((b - a) / 86400000)
}

/** 截止日期的分组：overdue / today / week / later / none。 */
export function dueBucket(dueDate, today = todayKey()) {
  const key = dateKey(dueDate)
  if (!key) return 'none'
  if (key < today) return 'overdue'
  if (key === today) return 'today'
  if (key <= endOfWeek(today)) return 'week'
  return 'later'
}

function normalizeTags(value) {
  const source = Array.isArray(value)
    ? value
    : String(value === null || value === undefined ? '' : value).split(/[\n、,，;；]+/)
  const out = []
  for (const item of source) {
    const tag = textOf(item).replace(/^#+/, '').slice(0, MAX_TAG_LEN)
    if (!tag) continue
    if (!out.includes(tag)) out.push(tag)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

function normalizePriority(value) {
  const key = textOf(value).toLowerCase()
  if (PRIORITY_KEYS.includes(key)) return key
  if (key === '高' || key === '紧急' || key === 'urgent') return 'high'
  if (key === '中' || key === '普通' || key === 'normal') return 'medium'
  if (key === '低' || key === '不急' || key === 'low') return 'low'
  return 'medium'
}

/** 把任意来源的一条记录归一化；标题为空返回 null。 */
export function normalizeTodo(raw) {
  if (!isObject(raw)) return null
  const title = textOf(raw.title !== undefined ? raw.title : raw.name)
  if (!title) return null
  const createdAt = textOf(raw.createdAt) || nowIso()
  const status = textOf(raw.status).toLowerCase() === 'done' || raw.done === true ? 'done' : 'open'
  const updatedAt = textOf(raw.updatedAt) || createdAt
  return {
    id: textOf(raw.id) || newId(),
    title: title.slice(0, MAX_TITLE),
    note: textOf(raw.note).slice(0, MAX_NOTE),
    category: textOf(raw.category).slice(0, MAX_CATEGORY),
    priority: normalizePriority(raw.priority),
    status,
    dueDate: dateKey(raw.dueDate),
    tags: normalizeTags(raw.tags),
    source: textOf(raw.source) === 'agent' ? 'agent' : 'panel',
    createdAt,
    updatedAt,
    completedAt: status === 'done' ? textOf(raw.completedAt) || updatedAt : '',
  }
}

function emptyStore(warning) {
  return { version: STORE_VERSION, updatedAt: '', todos: [], warning: warning || '' }
}

/** 读取磁盘；解析失败时把坏文件备份到旁边并返回空库，避免整个面板打不开。 */
export function readStore() {
  let raw
  try {
    raw = fs.readFileSync(DATA_FILE, 'utf8')
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      return emptyStore(`读取待办数据失败：${error && error.message ? error.message : error}`)
    }
    return emptyStore()
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    let backup = ''
    try {
      backup = `${DATA_FILE}.corrupt-${Date.now()}`
      fs.renameSync(DATA_FILE, backup)
    } catch {
      backup = ''
    }
    return emptyStore(
      backup
        ? `数据文件解析失败，已备份为 ${path.basename(backup)}，现在从空列表开始。`
        : '数据文件解析失败，暂时从空列表开始（原文件未改动）。',
    )
  }
  const source = Array.isArray(parsed) ? parsed : Array.isArray(parsed.todos) ? parsed.todos : []
  const todos = source.map(normalizeTodo).filter(Boolean)
  return {
    version: STORE_VERSION,
    updatedAt: isObject(parsed) ? textOf(parsed.updatedAt) : '',
    todos,
    warning: '',
  }
}

export function writeStore(store) {
  const payload = {
    version: STORE_VERSION,
    updatedAt: nowIso(),
    todos: store.todos.map(normalizeTodo).filter(Boolean),
  }
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  const tmp = `${DATA_FILE}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, DATA_FILE)
  return { ...payload, warning: '' }
}

/** 统计：待办中 / 今天 / 本周 / 逾期 / 已完成 / 今天完成。 */
export function statsOf(todos, today = todayKey()) {
  const stats = { total: todos.length, open: 0, done: 0, today: 0, week: 0, overdue: 0, doneToday: 0 }
  const weekEnd = endOfWeek(today)
  for (const todo of todos) {
    if (todo.status === 'done') {
      stats.done += 1
      if (todo.completedAt && dateKeyOf(new Date(todo.completedAt)) === today) stats.doneToday += 1
      continue
    }
    stats.open += 1
    if (!todo.dueDate) continue
    if (todo.dueDate < today) stats.overdue += 1
    else if (todo.dueDate === today) stats.today += 1
    else if (todo.dueDate <= weekEnd) stats.week += 1
  }
  return stats
}

/** 未完成在前，再按逾期 → 今天 → 本周 → 以后 → 无日期、优先级、创建时间排序。 */
export function sortTodos(todos, today = todayKey()) {
  return todos.slice().sort((a, b) => {
    if (a.status !== b.status) return a.status === 'open' ? -1 : 1
    if (a.status === 'done') {
      return String(b.completedAt || b.updatedAt).localeCompare(String(a.completedAt || a.updatedAt))
    }
    const ba = dueBucket(a.dueDate, today)
    const bb = dueBucket(b.dueDate, today)
    if (ba !== bb) return BUCKET_RANK[ba] - BUCKET_RANK[bb]
    if (a.dueDate !== b.dueDate) {
      if (!a.dueDate) return 1
      if (!b.dueDate) return -1
      return a.dueDate.localeCompare(b.dueDate)
    }
    // 都没有截止日期时，新加的排在前面，避免新建条目落到列表最底部看不见。
    if (!a.dueDate && !b.dueDate) return String(b.createdAt).localeCompare(String(a.createdAt))
    const pa = PRIORITY_RANK[a.priority] ?? 1
    const pb = PRIORITY_RANK[b.priority] ?? 1
    if (pa !== pb) return pa - pb
    return String(a.createdAt).localeCompare(String(b.createdAt))
  })
}

/** 按 id / 完整标题 / 唯一包含匹配找待办；匹配到多条时返回候选，不擅自挑一个。 */
export function findTodos(todos, ref) {
  const target = textOf(ref)
  if (!target) return { todo: undefined, matches: [] }
  const lower = target.toLowerCase()
  const exact =
    todos.find((todo) => todo.id === target) ||
    todos.find((todo) => todo.title.toLowerCase() === lower)
  if (exact) return { todo: exact, matches: [] }
  const matches = todos.filter((todo) => todo.title.toLowerCase().includes(lower))
  if (matches.length === 1) return { todo: matches[0], matches: [] }
  return { todo: undefined, matches }
}

export function requireTodo(store, ref) {
  const found = findTodos(store.todos, ref)
  if (found.todo) return found.todo
  if (found.matches.length > 1) {
    throw new TodoError(
      'ambiguous',
      `「${textOf(ref)}」匹配到 ${found.matches.length} 条待办，请提供更完整的标题或 id。`,
      `候选：${found.matches.slice(0, 8).map((item) => `「${item.title}」`).join('、')}`,
    )
  }
  throw new TodoError(
    'not_found',
    `没有找到待办「${textOf(ref) || '(空)'}」。`,
    store.todos.length > 0 ? '可以先用 action="list" 查看现有待办。' : '当前还没有任何待办。',
  )
}

function normalizeCategory(value) {
  return textOf(value).slice(0, MAX_CATEGORY)
}

/** 新增一条待办；同名的未完成待办已存在时返回 duplicate，不重复创建。 */
export function addTodo(input = {}) {
  const store = readStore()
  const title = textOf(input.title)
  if (!title) throw new TodoError('title_required', '待办内容不能为空。', '请提供一句话说明要做什么。')
  if (title.length > MAX_TITLE) throw new TodoError('title_too_long', `待办内容不能超过 ${MAX_TITLE} 个字符。`)
  if (store.todos.length >= MAX_TODOS) {
    throw new TodoError('too_many', `待办数量达到上限（${MAX_TODOS} 条）。`, '请先清理已完成的待办。')
  }
  const note = textOf(input.note)
  if (note.length > MAX_NOTE) throw new TodoError('note_too_long', `备注不能超过 ${MAX_NOTE} 个字符。`)
  const dueDate = dateKey(input.dueDate)
  if (textOf(input.dueDate) && !dueDate) {
    throw new TodoError('bad_date', `截止日期「${textOf(input.dueDate)}」不是 YYYY-MM-DD。`, '例如 2026-11-30。')
  }

  const lower = title.toLowerCase()
  const duplicate = store.todos.find((todo) => todo.status === 'open' && todo.title.toLowerCase() === lower)
  if (duplicate) {
    return { created: false, duplicate: true, todo: duplicate, store }
  }

  const todo = normalizeTodo({
    title,
    note,
    category: normalizeCategory(input.category) || '其他',
    priority: input.priority,
    dueDate,
    tags: input.tags,
    status: 'open',
    source: input.source,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  })
  store.todos.push(todo)
  const saved = writeStore(store)
  return { created: true, duplicate: false, todo, store: saved }
}

function applyPatch(todo, patch) {
  const next = { ...todo }
  if (patch.title !== undefined) {
    const title = textOf(patch.title)
    if (!title) throw new TodoError('title_required', '待办内容不能为空。')
    if (title.length > MAX_TITLE) throw new TodoError('title_too_long', `待办内容不能超过 ${MAX_TITLE} 个字符。`)
    next.title = title
  }
  if (patch.note !== undefined) {
    const note = textOf(patch.note)
    if (note.length > MAX_NOTE) throw new TodoError('note_too_long', `备注不能超过 ${MAX_NOTE} 个字符。`)
    next.note = note
  }
  if (patch.category !== undefined) next.category = normalizeCategory(patch.category) || '其他'
  if (patch.priority !== undefined) next.priority = normalizePriority(patch.priority)
  if (patch.tags !== undefined) next.tags = normalizeTags(patch.tags)
  if (patch.dueDate !== undefined) {
    const raw = textOf(patch.dueDate)
    const due = dateKey(raw)
    if (raw && !due) {
      throw new TodoError('bad_date', `截止日期「${raw}」不是 YYYY-MM-DD。`, '例如 2026-11-30。')
    }
    next.dueDate = due
  }
  if (patch.status !== undefined) {
    const status = textOf(patch.status).toLowerCase()
    if (status !== 'open' && status !== 'done') {
      throw new TodoError('bad_status', 'status 只能是 open 或 done。')
    }
    next.status = status
  }
  next.updatedAt = nowIso()
  if (next.status === 'done') {
    next.completedAt = todo.status === 'done' ? todo.completedAt || next.updatedAt : next.updatedAt
  } else {
    next.completedAt = ''
  }
  return next
}

export function updateTodo(ref, patch = {}) {
  const store = readStore()
  const todo = requireTodo(store, ref)
  const next = applyPatch(todo, isObject(patch) ? patch : {})
  store.todos = store.todos.map((item) => (item.id === todo.id ? next : item))
  const saved = writeStore(store)
  return { todo: next, store: saved }
}

export function setStatus(ref, done) {
  return updateTodo(ref, { status: done ? 'done' : 'open' })
}

export function deleteTodo(ref) {
  const store = readStore()
  const todo = requireTodo(store, ref)
  store.todos = store.todos.filter((item) => item.id !== todo.id)
  const saved = writeStore(store)
  return { todo, store: saved }
}

export function clearCompleted() {
  const store = readStore()
  const removed = store.todos.filter((todo) => todo.status === 'done')
  if (removed.length === 0) return { removed: 0, store }
  store.todos = store.todos.filter((todo) => todo.status !== 'done')
  const saved = writeStore(store)
  return { removed: removed.length, store: saved }
}

/**
 * 过滤 + 排序。options：
 *   status  open(默认) / done / all
 *   due     overdue / today / week / ''（不限）
 *   category 分类精确匹配
 *   query   标题 / 备注 / 分类 / 标签模糊匹配
 *   limit   默认 100，上限 500
 */
export function listTodos(options = {}) {
  const store = readStore()
  const today = todayKey()
  const status = ['open', 'done', 'all'].includes(textOf(options.status)) ? textOf(options.status) : 'open'
  const due = textOf(options.due)
  const category = textOf(options.category)
  const query = textOf(options.query).toLowerCase()
  const limit = Math.max(1, Math.min(500, Number(options.limit) || 100))
  const weekEnd = endOfWeek(today)

  const filtered = store.todos.filter((todo) => {
    if (status !== 'all' && todo.status !== status) return false
    if (due === 'overdue' && !(todo.status === 'open' && todo.dueDate && todo.dueDate < today)) return false
    if (due === 'today' && !(todo.status === 'open' && todo.dueDate === today)) return false
    if (due === 'week' && !(todo.status === 'open' && todo.dueDate && todo.dueDate >= today && todo.dueDate <= weekEnd)) {
      return false
    }
    if (category && todo.category !== category) return false
    if (query) {
      const haystack = [todo.title, todo.note, todo.category, ...(todo.tags || [])].join('\n').toLowerCase()
      if (!haystack.includes(query)) return false
    }
    return true
  })

  const sorted = sortTodos(filtered, today)
  return {
    today,
    total: sorted.length,
    items: sorted.slice(0, limit).map((todo) => presentTodo(todo, today)),
    store,
  }
}

/** 给 Agent / 面板的展示字段：分组、逾期天数、是否今天到期。 */
export function presentTodo(todo, today = todayKey()) {
  const bucket = todo.status === 'done' ? 'done' : dueBucket(todo.dueDate, today)
  return {
    ...todo,
    bucket,
    overdueDays: bucket === 'overdue' ? daysBetween(todo.dueDate, today) : 0,
    priorityLabel: (PRIORITIES.find((item) => item.key === todo.priority) || {}).label || '中',
  }
}

export function describeState(warning = '') {
  const store = readStore()
  const today = todayKey()
  const categories = [...DEFAULT_CATEGORIES]
  for (const todo of store.todos) {
    if (todo.category && !categories.includes(todo.category)) categories.push(todo.category)
  }
  return {
    ok: true,
    version: STORE_VERSION,
    today,
    todos: sortTodos(store.todos, today).map((todo) => presentTodo(todo, today)),
    stats: statsOf(store.todos, today),
    categories,
    priorities: PRIORITIES,
    updatedAt: store.updatedAt,
    dataFile: DATA_FILE,
    warning: store.warning || warning || '',
    hint: '面板上的修改与对话里让 Agent 记录的待办共用同一份数据。',
  }
}

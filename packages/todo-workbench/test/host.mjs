/**
 * Host 测试：用假 ctx 驱动 index.js，覆盖 Agent 工具、同源 HTTP 路由、
 * 系统提示与 Host 服务，不需要启动 Harness。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-host-'))
process.env.DSH_TODO_WORKBENCH_DIR = dataDir

const { apply } = await import('../index.js')

const routes = []
const tools = []
const services = {}
const promptSections = []
const disposers = []
const ctx = {
  effect(fn) {
    const disposer = fn()
    const wrapped = typeof disposer === 'function' ? disposer : () => {}
    disposers.push(wrapped)
    return wrapped
  },
  get(name) {
    if (name === 'webServer') {
      return {
        register(options) {
          routes.push(options)
          return () => {}
        },
      }
    }
    if (name === 'systemPrompt') {
      return {
        section(definition) {
          promptSections.push(definition)
          return () => {}
        },
      }
    }
    return undefined
  },
  provide(name, service) {
    services[name] = service
    return () => {}
  },
  tools: {
    register(definition) {
      tools.push(definition)
      return () => {}
    },
  },
  logger: { info() {}, warn() {} },
}

apply(ctx)

const failures = []
const check = (label, condition, detail) => {
  if (condition) console.log(`ok - ${label}`)
  else {
    failures.push(label)
    console.log(`FAIL - ${label}${detail ? ` :: ${detail}` : ''}`)
  }
}
const offsetKey = (days) => {
  const now = new Date()
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  date.setDate(date.getDate() + days)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

// 注册面
const tool = tools.find((item) => item.name === 'todo_workbench')
check('注册了 todo_workbench 工具', Boolean(tool))
check('工具参数含 add/list/update/complete/delete', ['add', 'list', 'update', 'complete', 'delete'].every((action) => tool.parameters.properties.action.enum.includes(action)))
check('注册了系统提示', promptSections.some((item) => item.name === 'todo-workbench' && item.text.includes('todo_workbench')))
check('提供了 todoWorkbench 服务', Boolean(services.todoWorkbench && typeof services.todoWorkbench.state === 'function'))
check('挂载了 1 个 HTTP 前缀', routes.length === 1 && routes[0].kind === 'prefix' && routes[0].path === '/todo-workbench', JSON.stringify(routes.map((item) => item.path)))

const call = (args) => tool.execute(args)

// 工具：空列表
let result = await call({ action: 'list' })
check('list 空库', result.ok === true && result.total === 0, JSON.stringify(result))
check('list 带统计', result.stats && result.stats.open === 0)

// 工具：新增
result = await call({
  action: 'add',
  title: '周五前把报价单发给王总',
  note: '先确认折扣',
  category: '工作',
  priority: 'high',
  dueDate: offsetKey(-1),
  tags: ['客户', '报价'],
})
check('add 成功', result.ok === true && result.created === true && result.duplicate === false, JSON.stringify(result).slice(0, 240))
check('add 标记来源为对话', result.todo.source === 'agent' && result.todo.priority === 'high', JSON.stringify(result.todo))
check('add 带优先级标签与逾期天数', result.todo.priorityLabel === '高' && result.todo.overdueDays === 1, JSON.stringify(result.todo))
const id = result.todo.id

result = await call({ action: 'add', title: '周五前把报价单发给王总' })
check('add 同名去重', result.created === false && result.duplicate === true && result.hint.includes('未重复创建'), JSON.stringify(result))
result = await call({ action: 'add', title: '先列个清单' })
const secondId = result.todo.id
check('add 第二条', result.created === true)

// 工具：错误
result = await call({ action: 'add', title: '日期错', dueDate: '2026-02-30' })
check('add 非法日期', result.ok === false && result.error === 'bad_date', JSON.stringify(result))
result = await call({ action: 'nope' })
check('未知 action', result.ok === false && result.error === 'bad_action', JSON.stringify(result))

// 工具：列表过滤
result = await call({ action: 'list', due: 'overdue' })
check('list 逾期过滤', result.total === 1 && result.items[0].id === id, JSON.stringify(result.items))
result = await call({ action: 'list', query: '报价' })
check('list 关键词', result.total === 1)
result = await call({ action: 'list', category: '工作' })
check('list 分类', result.total === 1)

// 工具：更新
result = await call({ action: 'update', id, data: { title: '周四前把报价单发给王总', dueDate: offsetKey(0), priority: 'medium' } })
check('update 改标题/日期/优先级', result.ok === true && result.todo.title === '周四前把报价单发给王总' && result.todo.dueDate === offsetKey(0) && result.todo.priority === 'medium', JSON.stringify(result.todo))
result = await call({ action: 'update', id, data: {} })
check('update 空 patch 报错', result.ok === false && result.error === 'nothing_to_update', JSON.stringify(result))

// 工具：完成 / 恢复 / 统计
result = await call({ action: 'complete', id })
check('complete', result.ok === true && result.todo.status === 'done' && Boolean(result.todo.completedAt), JSON.stringify(result.todo))
result = await call({ action: 'stats' })
check('stats 统计', result.stats.done === 1 && result.stats.open === 1, JSON.stringify(result.stats))
result = await call({ action: 'reopen', id })
check('reopen', result.todo.status === 'open' && result.todo.completedAt === '')

// 工具：删除
result = await call({ action: 'delete', id: secondId })
check('delete', result.ok === true && result.deleted.title === '先列个清单', JSON.stringify(result))
result = await call({ action: 'delete', id: '不存在的待办' })
check('delete 不存在', result.ok === false && result.error === 'not_found')

// HTTP 路由
const request = async (pathname, method = 'GET', body, contentType = 'application/json') => {
  const headers = body === undefined ? {} : { 'content-type': contentType }
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = pathname
  req.headers = headers
  const res = {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, responseHeaders) {
      this.status = status
      this.headers = responseHeaders
    },
    end(chunk) {
      this.body = String(chunk || '')
    },
  }
  await routes[0].handler(req, res)
  let json = null
  try {
    json = JSON.parse(res.body)
  } catch {
    json = null
  }
  return { status: res.status, json, raw: res.body }
}

let http = await request('/todo-workbench/state')
check('HTTP state 200', http.status === 200 && http.json.ok === true, http.raw.slice(0, 200))
check('HTTP state 带 categories/priorities/dataFile', Array.isArray(http.json.categories) && http.json.priorities.length === 3 && Boolean(http.json.dataFile))

http = await request('/todo-workbench/add', 'POST', { title: '面板添加的待办', category: '生活', priority: 'low', dueDate: offsetKey(0) })
check('HTTP add 成功', http.status === 200 && http.json.created === true && http.json.todo.source === 'panel', http.raw.slice(0, 240))
const panelId = http.json.todo.id
check('HTTP add 返回完整 state', http.json.state && http.json.state.stats.open === 2, JSON.stringify(http.json.state && http.json.state.stats))

http = await request('/todo-workbench/add', 'POST', { title: '面板添加的待办' })
check('HTTP add 同名去重', http.json.created === false && http.json.duplicate === true)

http = await request('/todo-workbench/update', 'POST', { id: panelId, data: { title: '面板改过的待办', priority: 'high' } })
check('HTTP update', http.status === 200 && http.json.todo.title === '面板改过的待办' && http.json.todo.priority === 'high', http.raw.slice(0, 240))

http = await request('/todo-workbench/complete', 'POST', { id: panelId, done: true })
check('HTTP complete', http.json.todo.status === 'done' && http.json.state.stats.done === 1)

http = await request('/todo-workbench/complete', 'POST', { id: panelId, done: false })
check(
  'HTTP 恢复为未完成',
  http.json.ok === true && http.json.todo.status === 'open' && http.json.todo.completedAt === '' && http.json.state.stats.done === 0,
  http.raw.slice(0, 240),
)

http = await request('/todo-workbench/complete', 'POST', { id: panelId, done: true })
check('HTTP 再次完成', http.json.todo.status === 'done' && http.json.state.stats.done === 1)

http = await request('/todo-workbench/state')
check('HTTP state 能看到完成', http.json.todos.some((item) => item.id === panelId && item.status === 'done'))

http = await request('/todo-workbench/clear-completed', 'POST', {})
check('HTTP clear-completed', http.json.ok === true && http.json.removed === 1 && http.json.state.stats.done === 0)

http = await request('/todo-workbench/add', 'POST', { title: '会被删掉的待办' })
const deleteId = http.json.todo.id
http = await request('/todo-workbench/delete', 'POST', { id: deleteId })
check('HTTP delete', http.json.ok === true && http.json.deleted.id === deleteId && !http.json.state.todos.some((item) => item.id === deleteId))

http = await request('/todo-workbench/add', 'POST', { title: '错误 content-type' }, 'text/plain')
check('HTTP 拒绝非 JSON', http.status === 400 && http.json.error === 'unsupported_media_type', http.raw)

http = await request('/todo-workbench/unknown')
check('HTTP 未知路由 404', http.status === 404 && http.json.error === 'not_found')

// Host 服务
const finalState = await request('/todo-workbench/state')
const serviceState = services.todoWorkbench.state()
check('服务 state 与 HTTP 同源', serviceState.stats.open === finalState.json.stats.open, JSON.stringify(serviceState.stats))
check('服务 add 可用', services.todoWorkbench.add({ title: '服务添加' }).created === true)

// 数据落盘
check('数据文件存在', fs.existsSync(path.join(dataDir, 'todos.json')))

// 清理 effect
for (const dispose of disposers) {
  try {
    dispose()
  } catch {
    /* ignore */
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败：${failures.join('、')}`)
  process.exitCode = 1
} else {
  console.log('\nhost 全部通过')
}

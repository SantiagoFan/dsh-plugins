/**
 * Host half of @mindlink-ai/dsh-todo-workbench.
 *
 * 个人待办事项工作台：左侧边栏面板 + Agent 工具 + 同源 HTTP 接口共用一份数据。
 *  - Agent 工具 todo_workbench：对话里说「记一下」时记录待办，也能查询、完成、修改、删除；
 *  - 同源 HTTP 路由 /todo-workbench/*：供侧边栏面板读取和编辑；
 *  - Host 服务 todoWorkbench：供同进程的其他插件复用。
 *
 * 数据只保存在本机 ~/.dsh/todo-workbench/todos.json，不上传、不写日志正文。
 */
import {
  addTodo,
  clearCompleted,
  DATA_FILE,
  dateKey,
  DEFAULT_CATEGORIES,
  deleteTodo,
  describeState,
  listTodos,
  presentTodo,
  readStore,
  requireTodo,
  setStatus,
  statsOf,
  TodoError,
  todayKey,
  updateTodo,
} from './lib/store.js'

export const name = 'todo-workbench'
export const inject = ['tools']

const PLUGIN_VERSION = '1.0.0'
const ROUTE_PREFIX = '/todo-workbench'

/** 全局提示：让 Agent 把对话里需要跟进的事真正落到待办清单。 */
const SYSTEM_PROMPT_TEXT =
  '个人待办事项工作台：用户说「记一下 / 帮我记个待办 / 提醒我 / 别忘了 / 回头跟进」等，或对话里出现需要用户后续完成的动作时，' +
  '调用 todo_workbench(action="add", title=..., dueDate=..., priority=..., category=...) 记录到本机待办清单，不要只在回复里答应。' +
  '用户问「我有哪些待办 / 今天要做什么 / 这周还有什么 / 完成了哪些」时，先调 action="list"（可按 due、category、query 过滤）或 action="stats"，再据实回答，不要编造。' +
  '用户说某件事做完了 → action="complete"；说「恢复 / 撤回 / 还没做完 / 标回未完成」→ action="complete"（done=false）或 action="reopen"；' +
  '说要改内容或日期 → action="update"；说删掉 → action="delete"（删除前先确认是哪一条）。' +
  '待办内容用用户的原话精简成一句可执行的事；用户没说截止日期就不要编造 dueDate。'

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const textOf = (value) => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim()
  return ''
}

function log(ctx, level, message) {
  const fn = ctx.logger ? ctx.logger[level] : undefined
  if (typeof fn === 'function') fn.call(ctx.logger, `[todo-workbench] ${message}`)
}

function failure(error) {
  const known = error instanceof TodoError
  return {
    ok: false,
    error: known ? error.code : 'internal_error',
    message: String(error && error.message ? error.message : error),
    hint: known ? error.hint || undefined : undefined,
  }
}

/** 工具与 HTTP 共用的 action 分发。 */
async function runAction(ctx, args = {}) {
  const action = textOf(args.action)
  switch (action) {
    case 'list': {
      const result = listTodos({
        status: args.status,
        due: args.due,
        category: args.category,
        query: args.query,
        limit: args.limit,
      })
      return {
        ok: true,
        today: result.today,
        total: result.total,
        returned: result.items.length,
        stats: statsOf(result.store.todos, result.today),
        items: result.items,
        hint:
          result.total === 0
            ? '没有符合条件的待办。'
            : result.total > result.items.length
              ? `共 ${result.total} 条，只返回前 ${result.items.length} 条；可以加 due/category/query 缩小范围。`
              : '',
      }
    }
    case 'add': {
      const result = addTodo({
        title: args.title,
        note: args.note,
        category: args.category,
        priority: args.priority,
        dueDate: args.dueDate,
        tags: args.tags,
        source: 'agent',
      })
      return {
        ok: true,
        created: result.created,
        duplicate: result.duplicate,
        todo: result.created || result.duplicate ? presentOne(result.todo) : undefined,
        stats: statsOf(result.store.todos),
        hint: result.duplicate
          ? '已有同名未完成待办，未重复创建；需要修改可用 action="update"。'
          : '已记录到待办清单。回复用户时用一句话确认，不要重复整条列表。',
      }
    }
    case 'update': {
      const patch = isObject(args.data) ? args.data : {}
      if (Object.keys(patch).length === 0) {
        throw new TodoError('nothing_to_update', '没有提供要修改的字段。', '把新值放进 data，例如 data={"dueDate":"2026-11-30"}。')
      }
      const result = updateTodo(textOf(args.id) || textOf(args.title), patch)
      return { ok: true, todo: presentOne(result.todo), stats: statsOf(result.store.todos) }
    }
    case 'complete': {
      const done = args.done !== false
      const result = setStatus(textOf(args.id) || textOf(args.title), done)
      return {
        ok: true,
        todo: presentOne(result.todo),
        stats: statsOf(result.store.todos),
        hint: done ? '已标记完成。' : '已恢复为未完成。',
      }
    }
    case 'reopen': {
      const result = setStatus(textOf(args.id) || textOf(args.title), false)
      return { ok: true, todo: presentOne(result.todo), stats: statsOf(result.store.todos) }
    }
    case 'delete': {
      const result = deleteTodo(textOf(args.id) || textOf(args.title))
      return {
        ok: true,
        deleted: { id: result.todo.id, title: result.todo.title },
        stats: statsOf(result.store.todos),
        hint: `已删除「${result.todo.title}」。`,
      }
    }
    case 'stats': {
      const store = readStore()
      const today = todayKey()
      return {
        ok: true,
        today,
        stats: statsOf(store.todos, today),
        categories: categoriesOf(store.todos),
        dataFile: DATA_FILE,
      }
    }
    case 'clear_completed': {
      const result = clearCompleted()
      return {
        ok: true,
        removed: result.removed,
        stats: statsOf(result.store.todos),
        hint: result.removed > 0 ? `已清理 ${result.removed} 条已完成待办。` : '没有已完成的待办需要清理。',
      }
    }
    default:
      throw new TodoError(
        'bad_action',
        `不认识的 action：「${action || '(空)'}」`,
        '支持 list / add / update / complete / reopen / delete / stats / clear_completed。',
      )
  }
}

function presentOne(todo) {
  return presentTodo(todo, todayKey())
}

function categoriesOf(todos) {
  const out = [...DEFAULT_CATEGORIES]
  for (const todo of todos) {
    if (todo.category && !out.includes(todo.category)) out.push(todo.category)
  }
  return out
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
    const known = error instanceof TodoError
    sendJson(
      res,
      {
        ok: false,
        error: known ? error.code : 'internal_error',
        message: String(error && error.message ? error.message : error),
        hint: known ? error.hint || undefined : undefined,
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
          reject(new TodoError('bad_args', '请求体过大', '单次请求不能超过 1MB。'))
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
          reject(new TodoError('bad_args', '请求体不是合法 JSON', '请刷新页面后重试。'))
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
          throw new TodoError('unsupported_media_type', '请求体需要 application/json。', '面板会自动使用 JSON。')
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
      handler: route(async ({ method, pathname, req, res }) => {
        if (method === 'GET' && pathname === `${ROUTE_PREFIX}/state`) {
          return sendJson(res, describeState())
        }
        if (method === 'POST' && pathname === `${ROUTE_PREFIX}/add`) {
          const body = await readBody(req)
          const input = isObject(body.todo) ? body.todo : body
          const result = addTodo({
            title: input.title,
            note: input.note,
            category: input.category,
            priority: input.priority,
            dueDate: input.dueDate,
            tags: input.tags,
            source: 'panel',
          })
          return sendJson(res, {
            ok: true,
            created: result.created,
            duplicate: result.duplicate,
            todo: result.created ? presentOne(result.todo) : undefined,
            state: describeState(),
          })
        }
        if (method === 'POST' && pathname === `${ROUTE_PREFIX}/update`) {
          const body = await readBody(req)
          const id = textOf(body.id)
          const patch = isObject(body.data) ? body.data : body.patch && isObject(body.patch) ? body.patch : body
          const result = updateTodo(id, patch)
          return sendJson(res, { ok: true, todo: presentOne(result.todo), state: describeState() })
        }
        if (method === 'POST' && pathname === `${ROUTE_PREFIX}/complete`) {
          const body = await readBody(req)
          const result = setStatus(textOf(body.id), body.done !== false)
          return sendJson(res, { ok: true, todo: presentOne(result.todo), state: describeState() })
        }
        if (method === 'POST' && pathname === `${ROUTE_PREFIX}/delete`) {
          const body = await readBody(req)
          const result = deleteTodo(textOf(body.id))
          return sendJson(res, {
            ok: true,
            deleted: { id: result.todo.id, title: result.todo.title },
            state: describeState(),
          })
        }
        if (method === 'POST' && pathname === `${ROUTE_PREFIX}/clear-completed`) {
          const result = clearCompleted()
          return sendJson(res, { ok: true, removed: result.removed, state: describeState() })
        }
        return sendJson(res, { ok: false, error: 'not_found', message: `未知路由 ${method} ${pathname}` }, 404)
      }),
    }),
  )
  return true
}

// ------------------------------------------------------------------ 插件入口
export function apply(ctx) {
  const outputSchema = {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  }

  ctx.effect(() =>
    ctx.tools.register({
      name: 'todo_workbench',
      description:
        '个人待办事项工作台（本机持久保存）。当用户让你「记一下 / 帮我记个待办 / 提醒我 / 别忘了 / 回头跟进」或对话里出现需要用户后续完成的动作时，' +
        '用 action="add" 把这件事记进清单，然后用一句话确认；不要只在回复里答应而不记录。' +
        '用户问有哪些待办、今天/本周要做什么、完成了什么时，用 action="list"（可按 status、due、category、query 过滤）或 action="stats" 读取真实数据再回答。' +
        '用户说做完了用 action="complete"；说恢复 / 撤回 / 还没做完用 action="complete"（done=false）或 action="reopen"；改内容/日期用 action="update"（新值放 data）；删除用 action="delete"；清理已完成用 action="clear_completed"。' +
        '标题用一句可执行的话；用户没说截止日期就不要编造 dueDate。面板上的修改与这里的记录是同一份数据。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'add', 'update', 'complete', 'reopen', 'delete', 'stats', 'clear_completed'],
            description:
              'list 查看待办；add 新增；update 修改（id + data）；complete 标记完成（done=false 可反向）；reopen 恢复未完成；delete 删除；stats 只看统计；clear_completed 清理所有已完成。',
          },
          id: {
            type: 'string',
            description: '要操作的待办 id 或完整标题（update / complete / reopen / delete 必填；匹配到多条时会返回候选）。',
          },
          title: {
            type: 'string',
            description: 'add 的待办内容，一句话，例如「周五前把报价单发给王总」。',
          },
          note: { type: 'string', description: '备注（可选），放补充细节、链接或上下文。' },
          category: {
            type: 'string',
            description: '分类，例如 工作 / 生活 / 学习 / 其他；也可以传用户自己的分类。默认「其他」。',
          },
          priority: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description: '优先级：high 高 / medium 中 / low 低，默认 medium。',
          },
          dueDate: {
            type: 'string',
            description: '截止日期 YYYY-MM-DD（本地时区）。用户没明确说日期就不要传。',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: '标签数组（可选），例如 ["客户","报价"]。',
          },
          status: {
            type: 'string',
            enum: ['open', 'done'],
            description: '仅 list 使用：open 未完成（默认）/ done 已完成 / all 全部。',
          },
          due: {
            type: 'string',
            enum: ['overdue', 'today', 'week'],
            description: '仅 list 使用：按截止时间过滤——overdue 逾期 / today 今天 / week 本周内。',
          },
          query: { type: 'string', description: '仅 list 使用：在标题、备注、分类、标签里搜索。' },
          limit: { type: 'number', description: '仅 list 使用：最多返回多少条，默认 100，上限 500。' },
          data: {
            type: 'object',
            additionalProperties: true,
            description:
              '仅 update 使用：要修改的字段，可包含 title、note、category、priority、dueDate、tags、status。不传的字段保持不变；dueDate 传空字符串可清空截止日期。',
          },
          done: {
            type: 'boolean',
            description: '仅 complete 使用：true（默认）标记完成，false 恢复未完成。',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: outputSchema,
      timeoutMs: 30000,
      isConcurrencySafe: () => false,
      async execute(args) {
        try {
          return await runAction(ctx, args)
        } catch (error) {
          return failure(error)
        }
      },
    }),
  )

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    ctx.effect(() => systemPrompt.section({ name: 'todo-workbench', order: 860, text: SYSTEM_PROMPT_TEXT }))
  } else {
    log(ctx, 'warn', 'systemPrompt 服务不可用：不会提示 Agent 主动记录待办（工具本身不受影响）')
  }

  if (typeof ctx.provide === 'function') {
    ctx.effect(() =>
      ctx.provide('todoWorkbench', {
        version: PLUGIN_VERSION,
        state: () => describeState(),
        list: (options) => listTodos(options).items,
        stats: () => statsOf(readStore().todos),
        add: (input) => addTodo({ ...(input || {}), source: 'agent' }),
        update: (ref, patch) => updateTodo(ref, patch),
        complete: (ref) => setStatus(ref, true),
        reopen: (ref) => setStatus(ref, false),
        remove: (ref) => deleteTodo(ref),
        clearCompleted: () => clearCompleted(),
        resolve: (ref) => requireTodo(readStore(), ref),
        today: () => todayKey(),
        isDate: (value) => Boolean(dateKey(value)),
      }),
    )
  }

  // webServer 由其他行提供，激活顺序不保证：拿不到就短暂重试。
  const webState = { registered: false, attempts: 0, error: '', timer: null }
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

  log(ctx, 'info', `已加载 v${PLUGIN_VERSION}`)
}

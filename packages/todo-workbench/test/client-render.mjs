/**
 * 面板渲染冒烟测试：用 vm 加载 client.js，喂假 React 和假 Host state，
 * 不需要浏览器、不需要安装 React。检查侧边栏/主面板注册、主要文案、分组与编辑态。
 */
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

let definition = null
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(candidate) {
        definition = candidate
      },
    },
  },
  document: { visibilityState: 'visible' },
  fetch: async () => {
    throw new Error('渲染测试不应该发请求')
  },
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  console,
}
vm.runInNewContext(source, sandbox)

const failures = []
const check = (label, condition, detail) => {
  if (condition) console.log(`ok - ${label}`)
  else {
    failures.push(label)
    console.log(`FAIL - ${label}${detail ? ` :: ${detail}` : ''}`)
  }
}

check('模块 id 正确', definition && definition.id === '@mindlink-ai/dsh-todo-workbench', definition && definition.id)

const FRAGMENT = Symbol('Fragment')
let stateCallIndex = 0
let stateOverrides = {}
const fakeReact = {
  Fragment: FRAGMENT,
  createElement(type, props, ...children) {
    const merged = { ...(props || {}) }
    const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
    if (flat.length) merged.children = flat.length === 1 ? flat[0] : flat
    return { type, props: merged }
  },
  useState(initial) {
    const index = stateCallIndex
    stateCallIndex += 1
    if (Object.prototype.hasOwnProperty.call(stateOverrides, index)) return [stateOverrides[index], () => {}]
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useRef(value) {
    return { current: value }
  },
  useEffect() {},
  useMemo(fn) {
    return fn()
  },
  useCallback(fn) {
    return fn
  },
}

const client = definition.factory((id) => {
  if (id === 'react') return fakeReact
  throw new Error(`意外的依赖：${id}`)
})

const registrations = []
const injections = []
const ctx = {
  slots: {
    inject(key, callback) {
      injections.push(key)
      callback()
      return () => {}
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
}
client.apply(ctx)

check('inject slots', Array.isArray(client.inject) && client.inject.includes('slots'))
check('注入 sidebar.panellist 与 main', injections.includes('sidebar.panellist') && injections.includes('main'), injections.join(','))
const sidebar = registrations.find((item) => item.options.name === 'sidebar.panellist')
const main = registrations.find((item) => item.options.name === 'main')
check('侧边栏 id/order/label 正确', sidebar && sidebar.options.id === 'todo-workbench' && sidebar.options.order === 8.5 && sidebar.options.label() === '待办事项', JSON.stringify(sidebar && sidebar.options))
check('主面板 key 与侧边栏 id 一致', main && main.options.key === 'todo-workbench', JSON.stringify(main && main.options))

const icon = sidebar.component({ size: 18, active: true })
check('侧边栏图标是 svg', icon && icon.type === 'svg' && icon.props.width === 18 && icon.props.height === 18)

const fixture = {
  ok: true,
  version: 1,
  today: '2026-11-23',
  todos: [
    {
      id: 'td-1',
      title: '周五前把报价单发给王总',
      note: '先确认折扣再发',
      category: '工作',
      priority: 'high',
      status: 'open',
      dueDate: '2026-11-21',
      tags: ['客户', '报价'],
      source: 'agent',
      createdAt: '2026-11-20T02:00:00.000Z',
      updatedAt: '2026-11-20T02:00:00.000Z',
      completedAt: '',
      bucket: 'overdue',
      overdueDays: 2,
      priorityLabel: '高',
    },
    {
      id: 'td-2',
      title: '准备周会材料',
      note: '',
      category: '工作',
      priority: 'medium',
      status: 'open',
      dueDate: '2026-11-23',
      tags: [],
      source: 'panel',
      createdAt: '2026-11-21T02:00:00.000Z',
      updatedAt: '2026-11-21T02:00:00.000Z',
      completedAt: '',
      bucket: 'today',
      overdueDays: 0,
      priorityLabel: '中',
    },
    {
      id: 'td-3',
      title: '整理书桌',
      note: '',
      category: '生活',
      priority: 'low',
      status: 'open',
      dueDate: '',
      tags: ['家务'],
      source: 'panel',
      createdAt: '2026-11-22T02:00:00.000Z',
      updatedAt: '2026-11-22T02:00:00.000Z',
      completedAt: '',
      bucket: 'none',
      overdueDays: 0,
      priorityLabel: '低',
    },
    {
      id: 'td-4',
      title: '已完成的旧事',
      note: '',
      category: '工作',
      priority: 'medium',
      status: 'done',
      dueDate: '',
      tags: [],
      source: 'panel',
      createdAt: '2026-11-19T02:00:00.000Z',
      updatedAt: '2026-11-22T02:00:00.000Z',
      completedAt: '2026-11-22T02:30:00.000Z',
      bucket: 'done',
      overdueDays: 0,
      priorityLabel: '中',
    },
  ],
  stats: { total: 4, open: 3, done: 1, today: 1, week: 0, overdue: 1, doneToday: 0 },
  categories: ['工作', '生活', '学习', '其他'],
  priorities: [
    { key: 'high', label: '高' },
    { key: 'medium', label: '中' },
    { key: 'low', label: '低' },
  ],
  dataFile: 'C:\\Users\\Administrator\\.dsh\\todo-workbench\\todos.json',
  warning: '',
  hint: '',
}

const expand = (node) => {
  let current = node
  while (current && typeof current === 'object' && typeof current.type === 'function') {
    current = current.type(current.props || {})
  }
  return current
}

const textOf = (input, out = []) => {
  const node = expand(input)
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const item of node) textOf(item, out)
    return out
  }
  if (node.props && node.props.children !== undefined) textOf(node.props.children, out)
  return out
}
const collect = (input, predicate, out = []) => {
  const node = expand(input)
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) collect(item, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  if (node.props) collect(node.props.children, predicate, out)
  return out
}
const inputByPlaceholder = (root, placeholder) =>
  collect(root, (node) => node.props && node.props.placeholder === placeholder)[0]
const buttonsWithText = (root) =>
  collect(root, (node) => node.type === 'button').map((node) => textOf(node.props.children).join(''))

const renderWith = (overrides) => {
  stateCallIndex = 0
  stateOverrides = { 0: fixture, ...(overrides || {}) }
  return main.component()
}

// 第一屏：全部页签
const first = renderWith()
const text = textOf(first).join('\n')
check('标题「待办事项」', text.includes('待办事项'))
check('日期行', text.includes('11月23日'))
check('四个统计卡', ['待办中', '今天', '逾期', '已完成'].every((label) => text.includes(label)))
check('快速添加占位文字', Boolean(inputByPlaceholder(first, '要做什么？例如：周五前把报价单发给王总')))
check('搜索框存在', Boolean(inputByPlaceholder(first, '搜索待办')))
check('五个页签', ['未完成', '今天', '本周', '日历', '已完成'].every((label) => text.includes(label)))
check('未完成行有明确的完成按钮', buttonsWithText(first).includes('完成'))
check('逾期分组标题', text.includes('逾期'))
check('今天分组标题', text.includes('今天'))
check('待办标题渲染', text.includes('周五前把报价单发给王总'))
check('逾期天数文案', text.includes('逾期 2 天'))
check('对话来源标记', text.includes('对话'))
check('分类文案', text.includes('工作') && text.includes('生活'))
check('标签渲染', text.includes('#客户') && text.includes('#报价'))
check('删除按钮默认不确认', text.includes('删除') && !text.includes('确认删除'))
check('未完成列表不显示恢复按钮', !text.includes('恢复'))
check('数据文件路径', text.includes('todos.json'))
check('无截止日期分组', text.includes('无截止日期'))
check('空状态未误显示', !text.includes('还没有待办'))

// 已完成页签
const done = renderWith({ 4: 'done' })
const doneText = textOf(done).join('\n')
check('已完成页签显示完成项', doneText.includes('已完成的旧事'))
check('已完成页签不显示未完成项', !doneText.includes('整理书桌'))
check('已完成页签显示清理按钮', doneText.includes('清理全部已完成'))
check('已完成页签提供恢复入口', doneText.includes('恢复') && doneText.includes('撤回为未完成'))
check('已完成行有恢复按钮', buttonsWithText(done).includes('恢复'))

// 日历页签
const calendar = renderWith({ 4: 'calendar', 14: '2026-11', 15: '2026-11-23' })
const calendarText = textOf(calendar).join('\n')
check('日历显示年月标题', calendarText.includes('2026年11月'))
check('日历显示本月统计', calendarText.includes('本月 2 条未完成'))
check('日历显示当天待办', calendarText.includes('准备周会材料'))
check('日历显示其他日期的待办', calendarText.includes('周五前把报价单发给王总'))
check('日历提供在这天添加', buttonsWithText(calendar).includes('在这天添加'))
check('日历选中日待办有完成按钮', buttonsWithText(calendar).includes('完成'))
check('日历有月切换按钮', buttonsWithText(calendar).includes('回到今天'))
check('日历列出未安排日期的待办', calendarText.includes('未安排日期') && calendarText.includes('整理书桌') && calendarText.includes('还有 1 条没设截止日期'))

// 编辑态
const draft = { title: '周五前把报价单发给王总', note: '先确认折扣再发', category: '工作', priority: 'high', dueDate: '2026-11-21', tags: '客户、报价' }
const edit = renderWith({ 9: 'td-1', 10: draft })
const editText = textOf(edit).join('\n')
check('编辑态显示保存快捷键提示', editText.includes('Ctrl / ⌘ + Enter 保存'))
check('编辑态显示保存按钮', editText.includes('保存'))
const editTitleInput = inputByPlaceholder(edit, '要做什么？')
check('编辑态标题输入框带原内容', Boolean(editTitleInput) && editTitleInput.props.value === '周五前把报价单发给王总', editTitleInput && editTitleInput.props.value)

// 空列表
const empty = renderWith({ 0: { ...fixture, todos: [], stats: { total: 0, open: 0, done: 0, today: 0, week: 0, overdue: 0, doneToday: 0 } } })
const emptyText = textOf(empty).join('\n')
check('空列表显示引导', emptyText.includes('还没有待办') && emptyText.includes('记一条待办'))

// 只有已完成：未完成页签应引导去「已完成」
const onlyDone = renderWith({
  0: {
    ...fixture,
    todos: fixture.todos.filter((todo) => todo.status === 'done'),
    stats: { total: 1, open: 0, done: 1, today: 0, week: 0, overdue: 0, doneToday: 0 },
  },
})
const onlyDoneText = textOf(onlyDone).join('\n')
check('只剩已完成时提示查看已完成页签', onlyDoneText.includes('没有未完成的待办') && onlyDoneText.includes('已完成 1 条'))

if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败：${failures.join('、')}`)
  process.exitCode = 1
} else {
  console.log('\nclient-render 全部通过')
}

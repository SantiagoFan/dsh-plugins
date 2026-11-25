/**
 * 存储与日期逻辑测试（不启动 Harness）。
 * 覆盖：新增 / 去重 / 日期分组 / 统计 / 排序 / 过滤 / 更新 / 完成 / 恢复 /
 *       歧义匹配 / 删除 / 清理已完成 / 落盘 / 坏文件备份。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-store-'))
process.env.DSH_TODO_WORKBENCH_DIR = dataDir

const {
  addTodo,
  clearCompleted,
  DATA_FILE,
  dateKey,
  daysBetween,
  deleteTodo,
  describeState,
  dueBucket,
  endOfWeek,
  listTodos,
  readStore,
  setStatus,
  statsOf,
  todayKey,
  TodoError,
  updateTodo,
} = await import('../lib/store.js')

const failures = []
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`ok - ${label}`)
  } else {
    failures.push(label)
    console.log(`FAIL - ${label}${detail ? ` :: ${detail}` : ''}`)
  }
}
const throwsCode = (fn, code) => {
  try {
    fn()
    return false
  } catch (error) {
    return error instanceof TodoError && error.code === code
  }
}
const offsetKey = (days) => {
  const [y, m, d] = todayKey().split('-').map(Number)
  const date = new Date(y, m - 1, d)
  date.setDate(date.getDate() + days)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const today = todayKey()
const weekEnd = endOfWeek(today)
const tomorrow = offsetKey(1)

// 空库
let state = describeState()
check('空库 stats 全 0', state.stats.total === 0 && state.stats.open === 0 && state.stats.done === 0, JSON.stringify(state.stats))
check('空库默认分类', state.categories.join(',') === '工作,生活,学习,其他', JSON.stringify(state.categories))

// 日期工具
check('dateKey 接受合法日期', dateKey('2026-02-28') === '2026-02-28')
check('dateKey 拒绝 2 月 30 日', dateKey('2026-02-30') === '')
check('daysBetween 跨月', daysBetween('2026-01-30', '2026-02-02') === 3)
check('dueBucket 逾期', dueBucket(offsetKey(-1), today) === 'overdue')
check('dueBucket 今天', dueBucket(today, today) === 'today')
check('dueBucket 无日期', dueBucket('', today) === 'none')
check('dueBucket 本周日算本周', dueBucket(weekEnd, today) === (weekEnd === today ? 'today' : 'week'), `${weekEnd} / ${today}`)

// 新增
let result = addTodo({ title: '  写周报  ', priority: 'high', category: '工作', dueDate: today, tags: '汇报, 周五,汇报' })
check('新增成功', result.created === true && result.duplicate === false, JSON.stringify(result).slice(0, 160))
check('标题去除首尾空格', result.todo.title === '写周报')
check('标签去重', result.todo.tags.join(',') === '汇报,周五', JSON.stringify(result.todo.tags))
check('默认来源 panel', result.todo.source === 'panel')
const mainId = result.todo.id

result = addTodo({ title: '写周报', priority: 'low' })
check('同名未完成不重复创建', result.created === false && result.duplicate === true && result.todo.id === mainId)

const overdue = addTodo({ title: '交水电费', dueDate: offsetKey(-2), category: '生活' }).todo
const inWeek = addTodo({ title: '准备周会材料', dueDate: tomorrow, category: '工作' }).todo
const later = addTodo({ title: '预订机票', dueDate: offsetKey(40), category: '生活' }).todo
const noDate = addTodo({ title: '整理书桌', category: '生活', tags: ['家务'] }).todo

check('空标题报错', throwsCode(() => addTodo({ title: '   ' }), 'title_required'))
check('非法日期报错', throwsCode(() => addTodo({ title: '错误日期', dueDate: '2026-13-01' }), 'bad_date'))
check('超长标题报错', throwsCode(() => addTodo({ title: 'x'.repeat(201) }), 'title_too_long'))

// 统计
let stats = statsOf(readStore().todos, today)
check('统计 open', stats.open === 5 && stats.total === 5, JSON.stringify(stats))
check('统计 今天', stats.today === 1, JSON.stringify(stats))
check('统计 逾期', stats.overdue === 1, JSON.stringify(stats))
check(
  '统计 本周（不含今天）',
  stats.week === (weekEnd > today ? 1 : 0),
  JSON.stringify({ week: stats.week, weekEnd, today }),
)

// 顺序：逾期最先，无日期最后
const sorted = listTodos({ status: 'open' }).items
check('未完成按逾期优先排序', sorted[0].id === overdue.id, sorted.map((item) => item.title).join(' / '))
check('无日期排在最后', sorted[sorted.length - 1].id === noDate.id, sorted.map((item) => item.title).join(' / '))
check('呈现字段带 bucket', sorted[0].bucket === 'overdue' && sorted[0].overdueDays === 2, JSON.stringify(sorted[0]))

// 过滤
check('list 默认只看未完成', listTodos({}).total === 5)
check('due=today 只到今天', listTodos({ due: 'today' }).items.every((item) => item.dueDate === today))
check('due=overdue 只看逾期', listTodos({ due: 'overdue' }).total === 1)
check('category 过滤', listTodos({ category: '生活' }).total === 3)
check('query 搜索标题', listTodos({ query: '周报' }).total === 1)
check('query 搜索标签', listTodos({ query: '家务' }).total === 1)
check('limit 截断但 total 完整', listTodos({ limit: 2 }).total === 5 && listTodos({ limit: 2 }).items.length === 2)

// 更新
let updated = updateTodo(mainId, { title: '写周报并发给领导', priority: 'low', dueDate: offsetKey(3), tags: ['汇报'] })
check('更新标题/优先级/日期', updated.todo.title === '写周报并发给领导' && updated.todo.priority === 'low' && updated.todo.dueDate === offsetKey(3), JSON.stringify(updated.todo))
updated = updateTodo(mainId, { dueDate: '' })
check('清空截止日期', updated.todo.dueDate === '')
const noDateOrder = listTodos({ status: 'open' }).items.filter((item) => !item.dueDate).map((item) => item.id)
check('无日期的按新建在前排序', noDateOrder[0] === noDate.id && noDateOrder[1] === mainId, noDateOrder.join(','))
check('更新非法日期报错', throwsCode(() => updateTodo(mainId, { dueDate: '2026-02-30' }), 'bad_date'))

// 歧义
addTodo({ title: '给客户 A 回电话' })
addTodo({ title: '给客户 B 回电话' })
check('模糊匹配多条时报歧义', throwsCode(() => updateTodo('回电话', { note: 'x' }), 'ambiguous'))
updated = updateTodo('给客户 A 回电话', { note: '确认合同' })
check('完整标题可以定位', updated.todo.note === '确认合同')

// 完成 / 恢复
const completed = setStatus(overdue.id, true)
check('完成写入 completedAt', completed.todo.status === 'done' && Boolean(completed.todo.completedAt), JSON.stringify(completed.todo))
stats = statsOf(readStore().todos, today)
check('完成后统计更新', stats.done === 1 && stats.open === 6, JSON.stringify(stats))
check('list done 能查到', listTodos({ status: 'done' }).total === 1)
const reopened = setStatus(overdue.id, false)
check('恢复清除 completedAt', reopened.todo.status === 'open' && reopened.todo.completedAt === '')

// 删除
const deleted = deleteTodo(later.id)
check('删除返回标题', deleted.todo.title === '预订机票')
check('删除后不存在', !readStore().todos.some((todo) => todo.id === later.id))

// 清理已完成
setStatus(overdue.id, true)
setStatus(noDate.id, true)
const cleared = clearCompleted()
check('清理已完成返回数量', cleared.removed === 2 && statsOf(cleared.store.todos).done === 0, JSON.stringify({ removed: cleared.removed }))

// 描述状态
state = describeState()
check('describeState 带今天与数据文件', state.today === today && state.dataFile === DATA_FILE, `${state.today} ${state.dataFile}`)
check('describeState 带提醒', state.hint.includes('同一份数据'))

// 落盘 + 坏文件备份
check('数据文件存在', fs.existsSync(DATA_FILE))
const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
check('文件结构带 version 与 todos', raw.version === 1 && Array.isArray(raw.todos), Object.keys(raw).join(','))
fs.writeFileSync(DATA_FILE, '{ 不是 JSON', 'utf8')
const recovered = readStore()
check('坏文件返回警告', recovered.warning.includes('解析失败') && recovered.todos.length === 0, recovered.warning)
const backups = fs.readdirSync(dataDir).filter((name) => name.includes('.corrupt-'))
check('坏文件已备份', backups.length === 1, fs.readdirSync(dataDir).join(','))
check('坏文件后可继续新增', addTodo({ title: '恢复后第一条' }).created === true)

if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败：${failures.join('、')}`)
  process.exitCode = 1
} else {
  console.log('\nstore 全部通过')
}

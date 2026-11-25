/**
 * 客户端渲染冒烟测试（不需要浏览器、不需要装 React）。
 *
 * 用 vm 加载 client.js，喂假 React + 假 Host state，检查：
 *   1. 左侧边栏入口与主面板的注册 id 一致
 *   2. 顶栏固定统计 + 五个页签
 *   3. 总览：运行进度、立即采集、上次采集、最近运行
 *   4. 采集主题页：左列表 + 右编辑（关键词 / 关注渠道 / 保存 / 删除）
 *   5. 采集渠道页：类型、链接、高级字段、测试结果展示
 *   6. 定时任务页：时间 / 时区 / 保留天数 / 单次上限 / 保存
 *   7. 结果数据页：按主题分组、日期筛选、导出
 *   8. 只依赖主题 token，不引用任何 @deepseek-ai Client 包
 *
 * 运行：node test/client-render.mjs
 */
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const run = {
  id: 'run_1',
  startedAt: '2026-11-19T02:30:00.000Z',
  finishedAt: '2026-11-19T02:30:02.000Z',
  trigger: 'manual',
  status: 'ok',
  fetched: 4,
  newItems: 2,
  withPhone: 1,
  duplicate: 1,
  filtered: 1,
  details: 2,
  tasks: [
    { channelId: 'channel_1', channelName: '应急管理部', topicName: '应急演练', status: 'ok', count: 2, withPhone: 1, details: 2, ms: 900, error: '' },
  ],
  errors: [],
}

const topic = {
  id: 'topic_1',
  name: '应急演练',
  keywords: ['演练', '应急'],
  channelIds: [],
  notes: '只看演练相关',
  enabled: true,
  channelNames: [],
  scopeLabel: '全部渠道',
  createdAt: '2026-11-18T00:00:00.000Z',
  updatedAt: '2026-11-18T00:00:00.000Z',
  lastCount: 2,
}

const channel = {
  id: 'channel_1',
  name: '应急管理部',
  type: 'rss',
  typeLabel: 'RSS / Atom',
  url: 'https://www.mem.gov.cn/feed.xml',
  query: '',
  itemPath: '',
  fieldTitle: '',
  fieldLink: '',
  fieldDate: '',
  fieldSummary: '',
  linkPattern: '',
  followDetail: true,
  detailLimit: 5,
  region: '',
  limit: 30,
  enabled: true,
  note: '',
  createdAt: '2026-11-18T00:00:00.000Z',
  updatedAt: '2026-11-18T00:00:00.000Z',
  lastRunAt: '2026-11-19T02:30:00.000Z',
  lastRunLabel: '2026-11-19 10:30',
  lastStatus: 'ok',
  statusLabel: '成功',
  lastCount: 2,
  lastWithPhone: 1,
  lastLeadsLabel: '2 条线索 · 1 条有电话',
  lastError: '',
  topicIds: ['topic_1'],
  topicNames: ['应急演练'],
}

const fixture = {
  ok: true,
  version: '2.0.0',
  dataDir: 'C:\\Users\\Administrator\\.dsh\\data-collector',
  dataFile: 'C:\\Users\\Administrator\\.dsh\\data-collector\\state.json',
  reportDir: 'C:\\Users\\Administrator\\.dsh\\data-collector\\reports',
  dbFile: 'C:\\Users\\Administrator\\.dsh\\data-collector\\leads.db',
  dbBytes: 32768,
  topics: [topic],
  channels: [channel],
  scope: {
    regions: ['内蒙古'],
    unknown: 'smart',
    keywords: ['内蒙古', '呼和浩特', '包头', '鄂尔多斯'],
    label: '内蒙古',
    summary: '内蒙古（共 4 个城市/地区关键词）；smart',
  },
  schedule: {
    enabled: true,
    time: '07:30',
    timeZone: 'Asia/Shanghai',
    catchUp: true,
    retainDays: 30,
    maxItemsPerRun: 200,
    lastRunAt: '2026-11-19T02:30:00.000Z',
    lastRunLabel: '2026-11-19 10:30',
    lastRunStatus: 'ok',
    lastRunStatusLabel: '成功',
    lastRunNew: 2,
    lastRunId: 'run_1',
    nextRunAt: '2026-11-19T23:30:00.000Z',
    nextRunLabel: '2026-11-20 07:30',
    timeZoneLabel: '北京时间',
  },
  stats: {
    topics: 1,
    channels: 1,
    enabledChannels: 1,
    itemsTotal: 2,
    itemsToday: 2,
    withPhoneTotal: 1,
    withPhoneToday: 1,
    today: '2026-11-19',
    dates: [{ date: '2026-11-19', count: 2 }],
    lastRun: run,
  },
  runs: [run],
  runtime: null,
  limits: { taskLimit: 40, maxResultLimit: 200, channelTypes: ['rss', 'json', 'html', 'search'], pageSizes: [20, 50, 100] },
}

const resultsFixture = {
  ok: true,
  total: 2,
  page: 1,
  pageSize: 20,
  pages: 1,
  statusCounts: { all: 2, unsynced: 2, synced: 0, failed: 0, noPhone: 1, today: 1 },
  items: [
    {
      id: 'lead_1',
      runId: 'run_1',
      date: '2026-11-19',
      topicId: 'topic_1',
      topicName: '应急演练',
      channelId: 'channel_1',
      channelName: '应急管理部',
      company: '内蒙古安泰实业有限责任公司',
      contact: '王工',
      phone: '138 0013 8000',
      phoneDigits: '13800138000',
      region: '呼和浩特市新城区',
      note: '联系人：王工 联系电话：13800138000',
      title: '关于2026年消防演练服务采购项目的公告',
      sourceUrl: 'https://www.mem.gov.cn/news/a.html',
      sourceName: '应急管理部',
      publishedAt: '2026-11-18',
      fetchedAt: '2026-11-19T02:30:00.000Z',
    },
    {
      id: 'lead_2',
      runId: 'run_1',
      date: '2026-11-19',
      topicId: 'topic_1',
      topicName: '应急演练',
      channelId: 'channel_1',
      channelName: '应急管理部',
      company: '',
      contact: '',
      phone: '',
      phoneDigits: '',
      region: '',
      note: '',
      title: '消防安全演练工作提示',
      sourceUrl: 'https://www.mem.gov.cn/news/b.html',
      sourceName: '应急管理部',
      publishedAt: '',
      fetchedAt: '2026-11-19T02:30:00.000Z',
    },
  ],
  dates: [{ date: '2026-11-19', count: 2 }],
}

const FRAGMENT = Symbol('Fragment')
const stateQueue = []

const fakeReact = {
  Fragment: FRAGMENT,
  createElement(type, props, ...children) {
    const merged = { ...(props || {}) }
    const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
    if (flat.length) merged.children = flat.length === 1 ? flat[0] : flat
    return { type, props: merged }
  },
  useState(initial) {
    const value = stateQueue.length ? stateQueue.shift() : initial
    return [value, () => {}]
  },
  useEffect() {},
  useMemo(fn) {
    return fn()
  },
  useCallback(fn) {
    return fn
  },
}

const registered = []
let panelComponent = null

const fakeCtx = {
  effect() {},
  slots: {
    inject(name, callback) {
      callback()
    },
    register(options, component) {
      registered.push(`${options.name}:${options.id || options.key}`)
      if (options.name === 'main') panelComponent = component
      return () => {}
    },
  },
}

const sandbox = {
  window: {
    __ModuleLoader__: {
      load(definition) {
        sandbox.__def = definition
      },
    },
  },
  console,
  navigator: {},
  document: { createElement: () => ({ style: {}, select() {}, setAttribute() {}, click() {} }), body: { appendChild() {}, removeChild() {} } },
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  fetch: async () => ({ ok: false, json: async () => null, status: 0, statusText: 'offline' }),
  URL,
  URLSearchParams,
}
sandbox.globalThis = sandbox

vm.createContext(sandbox)
vm.runInContext(source, sandbox)

const definition = sandbox.__def
if (!definition || definition.id !== '@mindlink-ai/dsh-sales-workbench') throw new Error('module id mismatch or not loaded')
const mod = definition.factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error(`unexpected require(${name})`)
})
mod.apply(fakeCtx)
if (!panelComponent) throw new Error('main panel was not registered')

function collect(tree) {
  const texts = []
  const tags = []
  const styles = []
  const nodes = []
  function walk(node) {
    if (node === null || node === undefined || node === false) return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (typeof node === 'string' || typeof node === 'number') {
      texts.push(String(node))
      return
    }
    if (!node || typeof node !== 'object') return
    nodes.push(node)
    const { type, props } = node
    if (type === FRAGMENT) {
      walk(props ? props.children : undefined)
      return
    }
    if (typeof type === 'function') {
      walk(type(props || {}))
      return
    }
    if (typeof type === 'string') tags.push(type)
    if (props && props.style) styles.push(props.style)
    walk(props ? props.children : undefined)
  }
  walk(tree)
  return { text: texts.join('\n'), texts, tags, styles, nodes, tree }
}

/** 只收集一棵子树里的文本（用来区分「顶栏」「页签条」「内容区」） */
function textsOf(node) {
  const out = []
  function walk(n) {
    if (n === null || n === undefined || n === false) return
    if (Array.isArray(n)) {
      n.forEach(walk)
      return
    }
    if (typeof n === 'string' || typeof n === 'number') {
      out.push(String(n))
      return
    }
    if (!n || typeof n !== 'object') return
    const { type, props } = n
    if (type === FRAGMENT) {
      walk(props ? props.children : undefined)
      return
    }
    if (typeof type === 'function') {
      walk(type(props || {}))
      return
    }
    walk(props ? props.children : undefined)
  }
  walk(node)
  return out.join('\n')
}

function countButtons(node) {
  let count = 0
  function walk(n) {
    if (n === null || n === undefined || n === false) return
    if (Array.isArray(n)) {
      n.forEach(walk)
      return
    }
    if (typeof n !== 'object') return
    const { type, props } = n
    if (type === FRAGMENT) {
      walk(props ? props.children : undefined)
      return
    }
    if (typeof type === 'function') {
      walk(type(props || {}))
      return
    }
    if (type === 'button') count += 1
    walk(props ? props.children : undefined)
  }
  walk(node)
  return count
}

function regions(view) {
  const children = view.tree && view.tree.props ? view.tree.props.children : []
  const list = Array.isArray(children) ? children : [children]
  return {
    headerNode: list[0],
    tabstripNode: list[1],
    scrollNode: list[2],
    header: textsOf(list[0]),
    tabstrip: textsOf(list[1]),
    scroll: textsOf(list[2]),
  }
}

const EMPTY_TOPIC = { id: '', name: '', keywords: '', channelIds: [], notes: '', enabled: true }
const EMPTY_CHANNEL = {
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
  linkPattern: '',
  limit: 30,
  enabled: true,
  note: '',
}
const SCHEDULE_DRAFT = { enabled: true, time: '07:30', timeZone: 'Asia/Shanghai', catchUp: true, retainDays: '30', maxItemsPerRun: '200' }
const SCOPE_DRAFT = { regions: ['内蒙古'], input: '', unknown: 'smart' }
const FILTERS = { date: '', topic: '', q: '', hasPhone: false, sync: 'all', page: 1, pageSize: 20 }
const DETAIL = null
const TOPIC_FORM = { id: 'topic_1', name: '应急演练', keywords: '演练、应急', channelIds: [], notes: '', enabled: true }
const CHANNEL_FORM = { ...EMPTY_CHANNEL, id: 'channel_1', name: '应急管理部', url: 'https://www.mem.gov.cn/feed.xml' }

/**
 * 父组件 useState 顺序：
 * data / loadError / notice / busy / tab / topicSel / topicForm /
 * channelSel / channelForm / testResult / scheduleDraft / scopeDraft / filters / results / detail /
 * selected / crmOptions / crmPre / crmStatus / crmProbe
 */
function render(options = {}) {
  const {
    data = fixture,
    loadError = '',
    notice = null,
    busy = '',
    tab = 'overview',
    topicSel = '',
    topicForm = EMPTY_TOPIC,
    channelSel = '',
    channelForm = EMPTY_CHANNEL,
    testResult = null,
    scheduleDraft = SCHEDULE_DRAFT,
    scopeDraft = SCOPE_DRAFT,
    filters = FILTERS,
    results = null,
    detail = DETAIL,
    selected = [],
    crmOptions = null,
    crmPre = null,
    crmStatus = null,
    crmProbe = null,
    toast = null,
    crmResult = null,
  } = options
  stateQueue.length = 0
  stateQueue.push(
    data,
    loadError,
    notice,
    busy,
    tab,
    topicSel,
    topicForm,
    channelSel,
    channelForm,
    testResult,
    scheduleDraft,
    scopeDraft,
    filters,
    results,
    detail,
    selected,
    crmOptions,
    crmPre,
    crmStatus,
    crmProbe,
    toast,
    crmResult,
  )
  return collect(panelComponent())
}

let failed = 0
function check(label, ok) {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
}
function checkText(view, label, needle) {
  check(`${label}: ${needle}`, view.text.includes(needle))
}
/** 占位符不是 children，直接看 props。 */
function hasPlaceholder(view, text) {
  return view.nodes.some((node) => node.props && node.props.placeholder === text)
}

// ---- 注册
check('侧边栏与主面板 id 一致', registered.join(',') === 'sidebar.panellist:data-collector,main:data-collector', registered.join(','))
check('client 声明了 slots 依赖', Array.isArray(mod.inject) && mod.inject.includes('slots'))

// ---- 总览
const overview = render()
checkText(overview, '标题', '市场线索')
checkText(overview, '统计·主题', '采集主题')
checkText(overview, '统计·渠道', '采集渠道')
checkText(overview, '统计·今日线索', '线索（2026-11-19，含电话 1）')
checkText(overview, '统计·下次采集', '2026-11-20 07:30')
check('工作台第一页不再放「立即采集」按钮', !overview.text.includes('立即采集'))
check('工作台第一页不再放「查看意向客户」按钮', !overview.text.includes('查看意向客户'))
check('工作台第一页不再放「调整定时任务」按钮', !overview.text.includes('调整定时任务'))
checkText(overview, '总览·定时任务卡', '定时任务')
checkText(overview, '总览·上次采集', '上次采集')
checkText(overview, '总览·运行统计·新增线索', '新增线索')
checkText(overview, '总览·运行统计·含电话', '其中含电话')
checkText(overview, '总览·运行统计·无联系方式跳过', '无联系方式跳过')
checkText(overview, '总览·运行统计·地区外跳过', '地区外跳过')
checkText(overview, '总览·当前范围', '当前范围：内蒙古')
checkText(overview, '总览·渠道情况', '应急管理部 · 2 条线索（1 有电话），2 详情页')
checkText(overview, '总览·最近运行', '最近运行')
checkText(overview, '总览·最近每天条目数', '最近每天的条目数')
check('总览不渲染主题编辑器', !overview.text.includes('关注渠道'))

// ---- 加载中 / 错误态
const loading = render({ data: null })
checkText(loading, '加载中', '加载中…')
const broken = render({ data: null, loadError: '连接失败' })
checkText(broken, '错误提示', '面板数据加载失败：连接失败')

// ---- 顶部结构：固定顶栏 + 5 个页签 + 仅内容区滚动
const layoutRegions = regions(overview)
check('顶栏只有刷新一个按钮', countButtons(layoutRegions.headerNode) === 1 && layoutRegions.header.includes('刷新'), layoutRegions.header)
check('页签条正好 6 个按钮', countButtons(layoutRegions.tabstripNode) === 6)
check('页签条包含全部页签', ['总览', '采集主题', '采集渠道', '定时任务', '线索', 'CRM'].every((label) => layoutRegions.tabstrip.includes(label)))
check(
  '外层自撑满且不溢出',
  Boolean(overview.styles.find((s) => s.height === '100%' && s.overflow === 'hidden' && s.flexDirection === 'column')),
)
check('顶部固定', Boolean(overview.styles.find((s) => s.padding === '18px 28px 0')))
check('页签条固定', Boolean(overview.styles.find((s) => s.padding === '8px 28px 0' && typeof s.borderBottom === 'string')))
check('只有内容区滚动', Boolean(overview.styles.find((s) => s.overflowY === 'auto' && s.minHeight === 0)))

// ---- 采集主题页
const topicsList = render({ tab: 'topics' })
checkText(topicsList, '主题页·新建', '＋ 新建主题')
checkText(topicsList, '主题页·采集范围卡', '采集范围（地区）')
checkText(topicsList, '主题页·采集范围说明', '只保留地区命中范围的线索')
checkText(topicsList, '主题页·添加地区按钮', '添加')
checkText(topicsList, '主题页·快捷添加', '快捷添加')
checkText(topicsList, '主题页·快捷城市', '呼和浩特市')
checkText(topicsList, '主题页·保存范围', '保存范围')
checkText(topicsList, '主题页·用内蒙古全省', '用内蒙古全省')
checkText(topicsList, '主题页·不限地区', '不限地区')
checkText(topicsList, '主题页·当前范围摘要', '内蒙古（共 4 个城市/地区关键词）')
check(
  '主题页·地区标签可移除',
  topicsList.nodes.some((node) => node.props && node.props['aria-label'] === '移除 内蒙古'),
)
check(
  '主题页·地区输入框为空',
  topicsList.nodes.some((node) => node.props && node.props.placeholder === '输入城市或省份，例如：呼和浩特市'),
)
checkText(topicsList, '主题页·地区不明策略选项', '智能判断（推荐）')
check(
  '主题页·地区不明策略选中 smart',
  topicsList.nodes.some((node) => node.props && node.props.value === 'smart'),
)
checkText(topicsList, '主题页·左列表名称', '应急演练')
checkText(topicsList, '主题页·关键词', '演练、应急')
checkText(topicsList, '主题页·范围', '全部渠道')
checkText(topicsList, '主题页·右空态', '新建采集主题')
check(
  '主题页是左右两栏 + 吸顶左栏',
  Boolean(topicsList.styles.find((s) => s.display === 'flex' && s.flexWrap === 'wrap' && s.gap === 16)) &&
    Boolean(topicsList.styles.find((s) => s.flex === '0 0 320px' && s.position === 'sticky')),
)
const topicsEdit = render({ tab: 'topics', topicSel: 'topic_1', topicForm: TOPIC_FORM })
checkText(topicsEdit, '主题编辑·标题', '编辑主题：应急演练')
checkText(topicsEdit, '主题编辑·关键词字段', '关键词')
checkText(topicsEdit, '主题编辑·关注渠道', '关注渠道')
checkText(topicsEdit, '主题编辑·渠道选项', 'RSS / Atom')
checkText(topicsEdit, '主题编辑·保存', '保存主题')
checkText(topicsEdit, '主题编辑·删除', '删除主题')
check('主题编辑不再显示空态', !topicsEdit.text.includes('新建采集主题'))

// ---- 采集渠道页
const channelsList = render({ tab: 'channels' })
checkText(channelsList, '渠道页·新建', '＋ 新建渠道')
checkText(channelsList, '渠道页·常用平台', '常用平台（一键添加）')
checkText(channelsList, '渠道页·预置数量', '内置 15 个')
checkText(channelsList, '渠道页·预置平台名', '中国政府采购网·地方公告')
checkText(channelsList, '渠道页·服务商渠道', '演练服务商（搜索）')
checkText(channelsList, '渠道页·名录接口', '内蒙古安责险·技术服务机构（API）')
checkText(channelsList, '渠道页·一键全部添加', '一键添加全部（15 个）')
checkText(channelsList, '渠道页·预置平台说明', '中国政府采购网是服务端渲染')
checkText(channelsList, '渠道页·名称', '应急管理部')
checkText(channelsList, '渠道页·域名', 'www.mem.gov.cn')
checkText(channelsList, '渠道页·上次状态', '成功 · 2 条线索 · 1 条有电话')
checkText(channelsList, '渠道页·右空态', '新建采集渠道')
const channelsEdit = render({ tab: 'channels', channelSel: 'channel_1', channelForm: CHANNEL_FORM })
checkText(channelsEdit, '渠道编辑·标题', '编辑渠道：应急管理部')
checkText(channelsEdit, '渠道编辑·类型', '渠道类型')
checkText(channelsEdit, '渠道编辑·链接', '链接')
checkText(channelsEdit, '渠道编辑·保存', '保存渠道')
checkText(channelsEdit, '渠道编辑·测试', '测试渠道')
checkText(channelsEdit, '渠道编辑·删除', '删除渠道')
checkText(channelsEdit, '渠道编辑·条数上限', '每次最多取多少条')
check('RSS 渠道不显示链接过滤', !channelsEdit.text.includes('链接过滤'))
const htmlForm = { ...EMPTY_CHANNEL, name: '网页列表', type: 'html', url: 'https://www.mem.gov.cn/news/' }
const htmlEdit = render({ tab: 'channels', channelForm: htmlForm })
checkText(htmlEdit, '网页渠道·链接过滤', '链接过滤')
const jsonEdit = render({ tab: 'channels', channelForm: { ...EMPTY_CHANNEL, name: '接口', type: 'json', url: 'https://x.test/api' } })
checkText(jsonEdit, 'JSON 渠道·数组路径', '数组路径')
checkText(jsonEdit, 'JSON 渠道·字段映射', '标题字段')
const searchEdit = render({ tab: 'channels', channelForm: { ...EMPTY_CHANNEL, name: '搜索', type: 'search', query: '应急演练' } })
checkText(searchEdit, '搜索渠道·搜索词', '搜索词')
check('搜索渠道不需要链接', !searchEdit.text.includes('链接 *'))
const testOk = render({
  tab: 'channels',
  channelSel: 'channel_1',
  channelForm: CHANNEL_FORM,
  testResult: {
    success: true,
    count: 2,
    leadCount: 2,
    withPhone: 1,
    details: 1,
    ms: 320,
    samples: [{ company: '内蒙古安泰实业有限责任公司', contact: '王工', phone: '138 0013 8000', region: '呼和浩特市新城区', title: '样例标题', sourceUrl: 'https://www.mem.gov.cn/news/a.html' }],
  },
})
checkText(testOk, '测试结果·成功标签', '可以识别')
checkText(testOk, '测试结果·公司', '内蒙古安泰实业有限责任公司')
checkText(testOk, '测试结果·联系人', '联系人：王工')
checkText(testOk, '测试结果·电话', '电话：138 0013 8000')
checkText(testOk, '测试结果·线索计数', '2 条线索（1 条有电话）')
const testFail = render({
  tab: 'channels',
  channelSel: 'channel_1',
  channelForm: CHANNEL_FORM,
  testResult: { success: false, message: 'HTTP 404' },
})
checkText(testFail, '测试结果·失败', 'HTTP 404')

// ---- 定时任务页
const schedule = render({ tab: 'schedule' })
checkText(schedule, '定时·启用开关', '启用每日定时采集')
checkText(schedule, '定时·时间字段', '每天几点')
checkText(schedule, '定时·时区', '时区')
checkText(schedule, '定时·保留天数', '结果保留天数')
checkText(schedule, '定时·单次上限', '单次采集上限（条）')
checkText(schedule, '定时·补采', '启动时补采错过的时间点')
checkText(schedule, '定时·保存', '保存定时')
checkText(schedule, '定时·立即采集', '立即采集')
checkText(schedule, '定时·当前状态', '当前状态')
checkText(schedule, '定时·下次采集值', '2026-11-20 07:30')
checkText(schedule, '定时·上次结果', '成功 · 2 条')

// ---- 线索页
const resultsView = render({ tab: 'results', results: resultsFixture })
checkText(resultsView, '客户·分组标题', '应急演练（2 条 · 1 条有电话）')
checkText(resultsView, '客户·表头公司', '公司名称')
checkText(resultsView, '客户·表头联系人', '联系人')
checkText(resultsView, '客户·表头电话', '联系电话')
checkText(resultsView, '客户·表头地区', '地区')
check('客户·表头不再有备注列', !resultsView.nodes.some((node) => node.type === 'th' && node.props && node.props.children === '备注（网址来源）'))
const detailButtons = resultsView.nodes.filter((node) => node.type === 'button' && node.props && node.props.children === '详情')
check('每行都有详情按钮', detailButtons.length === 2, detailButtons.length)
const rowCrmButtons = resultsView.nodes.filter(
  (node) => node.type === 'button' && node.props && typeof node.props.title === 'string' && node.props.title.includes('线索池'),
)
check('单条写入 CRM：只有可写的行有按钮', rowCrmButtons.length === 1, rowCrmButtons.length)
const pushingView = render({ tab: 'results', results: resultsFixture, busy: 'crm-one:lead_1' })
checkText(pushingView, '单条写入中提示', '写入中…')
const detailView = render({ tab: 'results', results: resultsFixture, detail: resultsFixture.items[0] })
checkText(detailView, '详情弹窗·标题', '线索详情')
checkText(detailView, '详情弹窗·备注', '联系人：王工 联系电话：13800138000')
checkText(detailView, '详情弹窗·来源网址', 'https://www.mem.gov.cn/news/a.html')
checkText(detailView, '详情弹窗·主题', '应急演练')
checkText(detailView, '详情弹窗·渠道', '应急管理部')

// ---- CRM 写入：勾选 / 线索池 / 预检弹窗
const CRM_OPTIONS = {
  ok: true,
  writable: true,
  baseUrl: 'https://crm.znmg.cn',
  pools: [{ id: 'pool_1', name: 'EvSim线索公海' }],
  products: [{ id: 'product_1', name: 'EvSim' }],
  crm: { poolId: 'pool_1', poolName: 'EvSim线索公海', productId: '', owner: '' },
}
const crmView = render({ tab: 'results', results: resultsFixture, crmOptions: CRM_OPTIONS })
checkText(crmView, 'CRM·可写提示', 'CRM：可写')
checkText(crmView, 'CRM·线索池选项', 'EvSim线索公海')
checkText(crmView, 'CRM·写入按钮', '写入 CRM')
const checkboxes = crmView.nodes.filter((node) => node.type === 'input' && node.props && node.props.type === 'checkbox')
check('CRM·每行都有勾选框（含表头）', checkboxes.length >= 3, checkboxes.length)
check('CRM·无手机号的行不能勾选', checkboxes.some((node) => node.props.disabled === true))
const readonlyView = render({ tab: 'results', results: resultsFixture, crmOptions: { ...CRM_OPTIONS, writable: false } })
checkText(readonlyView, 'CRM·只读提示', 'CRM：只读')

// 权限不足：清单接口 403 时界面要给出明确提示，而不是只显示一个空下拉框
const CRM_DENIED = {
  ok: true,
  configured: true,
  writable: true,
  baseUrl: 'https://crm.znmg.cn',
  pools: [],
  products: [],
  warnings: [
    { source: '线索池', message: 'CRM 业务错误：Subject does not have permission [MODULE_SETTING:UPDATE]' },
    { source: '产品', message: 'CRM 业务错误：Subject does not have permission [PRODUCT_MANAGEMENT:READ]' },
  ],
  crm: { poolId: '494107004965494784', poolName: 'EvSim线索公海' },
}
const deniedResults = render({ tab: 'results', results: resultsFixture, crmOptions: CRM_DENIED })
checkText(deniedResults, 'CRM 权限不足·线索页提示', 'CRM 清单拉取失败')
checkText(deniedResults, 'CRM 权限不足·线索页权限名', 'MODULE_SETTING:UPDATE')
const deniedCrmTab = render({ tab: 'crm', crmStatus: { ok: true, configured: true, crm: { baseUrl: 'https://crm.znmg.cn', readOnly: false } }, crmOptions: CRM_DENIED })
checkText(deniedCrmTab, 'CRM 权限不足·配置页提示', 'API Key 权限不足')
checkText(deniedCrmTab, 'CRM 权限不足·解决办法', '模块设置-更新')
checkText(deniedCrmTab, 'CRM 权限不足·手动填写提示', '手动填写线索池 ID')
check('CRM 权限不足·线索池 ID 输入框', hasPlaceholder(deniedCrmTab, '手动填写线索池 ID（清单拉不到时用）'))
check('CRM 权限不足·产品 ID 输入框', hasPlaceholder(deniedCrmTab, '手动填写产品 ID（可选）'))

// ---------------------------------------------------------------- CRM 页签（连接配置）
const CRM_STATUS = {
  ok: true,
  configured: true,
  crm: { baseUrl: 'https://crm.example.com', accessKey: 'tst***key', secretKey: 'tst***sec', organizationId: '', readOnly: false },
  configFile: 'C:\\Users\\x\\.dsh\\data-collector\\crm.json',
}
const CRM_PROBE = { ok: true, configured: true, reachable: true, authOk: true, identity: { name: 'admin', phone: '4000520755' } }
const crmTabView = render({ tab: 'crm', crmStatus: CRM_STATUS, crmProbe: CRM_PROBE, crmOptions: CRM_OPTIONS })
checkText(crmTabView, 'CRM 页·标题', 'CRM 连接')
checkText(crmTabView, 'CRM 页·已配置', '已配置')
checkText(crmTabView, 'CRM 页·可写提示', '可写：会写入 CRM')
checkText(crmTabView, 'CRM 页·连接正常', '连接正常')
checkText(crmTabView, 'CRM 页·身份', 'admin')
checkText(crmTabView, 'CRM 页·服务器', 'crm.example.com')
checkText(crmTabView, 'CRM 页·保存按钮', '保存并测试连接')
checkText(crmTabView, 'CRM 页·测试按钮', '测试连接')
checkText(crmTabView, 'CRM 页·写入默认值', '写入默认值')
checkText(crmTabView, 'CRM 页·线索池选项', 'EvSim线索公海')
checkText(crmTabView, 'CRM 页·配置路径', 'crm.json')
check('CRM 页·Access Key 输入框', crmTabView.nodes.some((node) => node.type === 'input' && node.props && node.props.type === 'password'))
const crmReadonlyTab = render({ tab: 'crm', crmStatus: { ...CRM_STATUS, crm: { ...CRM_STATUS.crm, readOnly: true } } })
checkText(crmReadonlyTab, 'CRM 页·只读提示', '只读：拒绝写入')
const crmEmpty = render({ tab: 'crm', crmStatus: { ok: true, configured: false, crm: {} }, crmOptions: { ok: true, configured: false, pools: [], products: [] } })
checkText(crmEmpty, 'CRM 页·未配置', '未配置')
check('CRM 页·未配置时测试按钮禁用', crmEmpty.nodes.some((node) => node.type === 'button' && node.props && node.props.disabled === true && node.props.children === '测试连接'))
const preFixture = {
  ok: true,
  total: 2,
  ready: 1,
  duplicated: 1,
  noPhone: 0,
  items: [
    { id: 'lead_1', name: '内蒙古安泰实业有限责任公司', phone: '13800138000', status: 'ok', hits: [] },
    { id: 'lead_2', name: '内蒙古某某安全技术有限公司', phone: '13900000000', status: 'dup_phone', hits: [{ target: 'lead', total: 1 }] },
  ],
}
const preView = render({ tab: 'results', results: resultsFixture, crmOptions: CRM_OPTIONS, crmPre: preFixture })
checkText(preView, '预检·标题', '写入 CRM 预检')
checkText(preView, '预检·统计', '可写入 1 条')
checkText(preView, '预检·重复标记', '手机号已存在')
checkText(preView, '预检·重复项标记已同步', '已标记同步')
checkText(preView, '预检·确认按钮', '确认写入 1 条')

// 写入结果弹窗 + 浮动提示（成功/失败都要看得见）
const toastOk = render({ tab: 'results', results: resultsFixture, toast: { tone: 'ok', title: '写入成功：1 条', detail: '已标记为已同步' } })
checkText(toastOk, '提示·成功标题', '写入成功：1 条')
checkText(toastOk, '提示·成功详情', '已标记为已同步')
const toastFail = render({ tab: 'results', results: resultsFixture, toast: { tone: 'danger', title: 'CRM 写入失败', detail: '只读模式：写操作被拒绝' } })
checkText(toastFail, '提示·失败标题', 'CRM 写入失败')
checkText(toastFail, '提示·失败详情', '只读模式')
const crmResult = { ok: true, created: 1, failed: 1, items: [
  { id: 'lead_1', name: '内蒙古安泰实业有限责任公司', phone: '13800138000', status: 'synced', error: '' },
  { id: 'lead_2', name: '内蒙古某某安全技术有限公司', phone: '13900000000', status: 'failed', error: '只读模式：写操作被拒绝' },
] }
const resultView = render({ tab: 'results', results: resultsFixture, crmResult })
checkText(resultView, '写入结果·标题', 'CRM 写入结果')
checkText(resultView, '写入结果·成功数', '成功 1 条')
checkText(resultView, '写入结果·失败数', '失败 1 条')
checkText(resultView, '写入结果·失败原因', '只读模式')
checkText(resultView, '写入结果·关闭', '关闭')
checkText(resultsView, '客户·表头采集时间', '采集时间')
checkText(resultsView, '客户·表头操作', '操作')
const deleteButtons = resultsView.nodes.filter((node) => node.type === 'button' && node.props && node.props.children === '删除')
check('每行都有删除按钮', deleteButtons.length === 2, deleteButtons.length)
const confirmView = render({ tab: 'results', results: resultsFixture, busy: 'lead-confirm:lead_1' })
checkText(confirmView, '删除需要二次确认', '确认删除')
check(
  '确认只想删那一条',
  confirmView.nodes.filter((node) => node.type === 'button' && node.props && node.props.children === '确认删除').length === 1,
)
checkText(resultsView, '客户·采集时间值', '2026-11-19 10:30')
checkText(resultsView, '客户·公司值', '内蒙古安泰实业有限责任公司')
checkText(resultsView, '客户·联系人值', '王工')
checkText(resultsView, '客户·电话值', '138 0013 8000')
checkText(resultsView, '客户·地区值', '呼和浩特市新城区')
checkText(resultsView, '客户·来源渠道', '应急管理部')
checkText(resultsView, '客户·未识别公司时退回标题', '消防安全演练工作提示')
checkText(resultsView, '客户·全部日期', '全部日期')
checkText(resultsView, '状态页签·全部', '全部（2）')
checkText(resultsView, '状态页签·今日采集', '今日采集（1）')
checkText(resultsView, '状态页签·未同步', '未同步（2）')
checkText(resultsView, '状态页签·已同步', '已同步（0）')
checkText(resultsView, '状态页签·写入失败', '写入失败（0）')
checkText(resultsView, '状态页签·无手机号', '无手机号（1）')
checkText(resultsView, '客户·日期筛选', '11-19（2）')
checkText(resultsView, '客户·主题筛选', '全部主题')
check('客户·搜索框占位符', hasPlaceholder(resultsView, '搜索公司 / 联系人 / 电话 / 地区 / 来源'))
checkText(resultsView, '客户·导出 Excel', '导出 Excel')
check('客户·不再提供 CSV 导出', !resultsView.text.includes('导出 CSV'))
check('客户·不再提供 Markdown 导出', !resultsView.text.includes('导出 Markdown'))
checkText(resultsView, '客户·复制本页', '复制本页')
checkText(resultsView, '客户·只看有电话', '只看有电话')
checkText(resultsView, '客户·清空线索按钮', '清空线索')
// 分页控件
checkText(resultsView, '分页·每页条数', '每页')
checkText(resultsView, '分页·上一页', '上一页')
checkText(resultsView, '分页·下一页', '下一页')
checkText(resultsView, '分页·页码说明', '第 1 / 1 页')
const page2View = render({
  tab: 'results',
  results: { ...resultsFixture, total: 45, page: 2, pageSize: 20, pages: 3, items: [resultsFixture.items[0]] },
})
checkText(page2View, '分页·第 2 页说明', '第 2 / 3 页')
const findButton = (view, label) => view.nodes.find((node) => node.props && node.props.children === label && node.type === 'button')
check('分页·第 2 页时上一页可点', Boolean(findButton(page2View, '‹ 上一页')) && findButton(page2View, '‹ 上一页').props.disabled === false)
check('分页·第 2 页时下一页可点', Boolean(findButton(page2View, '下一页 ›')) && findButton(page2View, '下一页 ›').props.disabled === false)
const lastPageView = render({
  tab: 'results',
  results: { ...resultsFixture, total: 45, page: 3, pageSize: 20, pages: 3, items: [resultsFixture.items[0]] },
})
check('分页·最后一页时下一页禁用', Boolean(findButton(lastPageView, '下一页 ›')) && findButton(lastPageView, '下一页 ›').props.disabled === true)
const firstPageView = render({ tab: 'results', results: { ...resultsFixture, total: 45, page: 1, pageSize: 20, pages: 3 } })
check('分页·第 1 页时上一页禁用', Boolean(findButton(firstPageView, '‹ 上一页')) && findButton(firstPageView, '‹ 上一页').props.disabled === true)
const noPhoneView = render({
  tab: 'results',
  results: { ok: true, total: 1, page: 1, pageSize: 20, pages: 1, items: [resultsFixture.items[1]], dates: resultsFixture.dates },
  filters: { ...FILTERS, hasPhone: true },
})
checkText(noPhoneView, '只看有电话时仍显示条数说明', '共 1 条线索')
checkText(render({ tab: 'results', results: resultsFixture, busy: 'clear-confirm' }), '客户·清空需要二次确认', '确认清空线索')
checkText(
  render({ tab: 'topics', topicSel: 'topic_1', topicForm: TOPIC_FORM, busy: 'topic-confirm' }),
  '主题·删除需要二次确认',
  '确认删除主题',
)
checkText(
  render({ tab: 'channels', channelSel: 'channel_1', channelForm: CHANNEL_FORM, busy: 'channel-confirm' }),
  '渠道·删除需要二次确认',
  '确认删除渠道',
)
checkText(resultsView, '客户·条数说明', '共 2 条线索 · 第 1 / 1 页 · 本页 2 条（1 条有电话）')
const resultsEmpty = render({ tab: 'results', results: { ok: true, total: 0, items: [], dates: [] } })
checkText(resultsEmpty, '客户·空态', '当前筛选下没有线索')
const resultsNever = render({
  tab: 'results',
  data: { ...fixture, stats: { ...fixture.stats, itemsTotal: 0, itemsToday: 0, withPhoneToday: 0, dates: [], lastRun: null }, runs: [] },
  results: { ok: true, total: 0, items: [], dates: [] },
})
checkText(resultsNever, '客户·从未采集引导', '还没有任何线索')

// ---- 首次使用引导
const firstRun = render({
  data: { ...fixture, topics: [], channels: [], stats: { ...fixture.stats, topics: 0, channels: 0, enabledChannels: 0, dates: [], lastRun: null, itemsTotal: 0, itemsToday: 0 }, runs: [] },
  results: { ok: true, total: 0, items: [], dates: [] },
})
checkText(firstRun, '引导·三步开始', '三步开始采集')
checkText(firstRun, '引导·去加渠道', '① 去添加渠道')
checkText(firstRun, '引导·去加主题', '② 去添加主题与地区')
checkText(
  render({
    tab: 'results',
    data: { ...fixture, channels: [], stats: { ...fixture.stats, channels: 0, enabledChannels: 0, itemsTotal: 0, itemsToday: 0, dates: [], lastRun: null }, runs: [] },
    results: { ok: true, total: 0, items: [], dates: [] },
  }),
  '无渠道时结果空态指向渠道',
  '还没有采集渠道',
)

// ---- 未保存标记
checkText(
  render({ tab: 'topics', topicSel: 'topic_1', topicForm: { ...TOPIC_FORM, keywords: '演练、应急、消防' } }),
  '主题·未保存标记',
  '未保存',
)
checkText(
  render({ tab: 'channels', channelSel: 'channel_1', channelForm: { ...CHANNEL_FORM, url: 'https://www.mem.gov.cn/other/' } }),
  '渠道·未保存标记',
  '未保存',
)

// ---- 采集进行中
const running = render({ runtime: null, tab: 'overview', data: { ...fixture, runtime: { runId: 'run_2', startedAt: '2026-11-19T03:00:00.000Z', total: 4, done: 1, newItems: 3, current: '应急管理部' } } })
checkText(running, '进度·标题', '正在采集…')
checkText(running, '进度·计数', '1/4 个渠道')
checkText(running, '进度·当前渠道', '当前：应急管理部')
check('第一页没有采集按钮，进度只读', !running.text.includes('采集中…'))

// ---- 静态约束：不引用 Host/Client 包，不用 iframe，不往 body 插 DOM
check('不 require 任何 @deepseek-ai Client 包', !/require\(['"]@deepseek-ai\//.test(source))
check('不用 iframe 承载页面', !/<iframe/i.test(source))
check('不往 document.body 里插节点', !/document\.body\.(appendChild|insertBefore)/.test(source))
check('只用 --dsw-alias-* 主题 token 取色', !/#[0-9a-fA-F]{6}/.test(source) || !/color:\s*['"]#/.test(source))

console.log(`\n渲染节点: ${overview.tags.length} 个原生元素 / ${overview.texts.length} 段文本`)
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)

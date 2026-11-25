/**
 * 新媒体工作台客户端渲染冒烟测试（不需要浏览器、不需要装 React）。
 *
 * 用 vm 加载 client.js，喂假 React + 假 Host state（v4：cards + accounts 分开），检查：
 *   1. 顶部固定区（标题 + 四个统计卡）与三个页签
 *   2. 定位卡页签：左列表 + 右编辑（人设字段），关联账号只读区
 *   3. 平台账号页签：左账号列表 + 右账号编辑（含「关联定位卡」下拉）
 *   4. 凭证设置页签
 *   5. 只有页签内容区滚动
 */

import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const fixture = {
  version: '0.6.0',
  cards: [
    {
      id: 'card-1',
      name: '老板IP',
      stage: '成长期',
      niche: '应急演练',
      audience: 'ToB 客户',
      persona: '行业专家',
      value: 'AI + 应急',
      pillars: '政策解读、案例拆解',
      tone: '专业',
      hookStyle: '反问开场',
      differentiator: '懂演练',
      goal: '线索',
      monetization: '咨询',
      taboo: '不承诺资质',
      keywords: '应急,演练',
      references: '',
      notes: '',
      createdAt: '2026-11-17T09:00:00.000Z',
      updatedAt: '2026-11-17T10:00:00.000Z',
    },
  ],
  accounts: [
    {
      id: 'pa-1',
      cardId: 'card-1',
      platform: 'douyin',
      name: '安思链',
      uid: 'dy-123',
      homepage: '',
      handle: '',
      note: '',
      followers: '1.2万',
      followersCount: 12000,
      followersSource: 'manual',
      followersUpdatedAt: '2026-11-17T09:00:00.000Z',
      createdAt: '2026-11-17T09:00:00.000Z',
      updatedAt: '2026-11-17T10:00:00.000Z',
    },
  ],
  capabilities: [
    { key: 'douyin', label: '抖音', auto: 'cookie', autoLabel: '需要 Cookie', note: '有签名风控', needs: ['cookie'] },
    { key: 'shipinhao', label: '视频号', auto: 'manual', autoLabel: '仅手动填写', note: '', needs: [] },
  ],
  platformFields: {},
  settings: { timeoutMs: 12000, proxy: '', lastSyncAt: '2026-11-17T10:00:00.000Z', credentials: { douyin: { hasCookie: true, cookieMasked: 'xxxx' } } },
  dataFile: 'C:\\Users\\Administrator\\.dsh\\newmedia-workbench\\accounts.json',
  settingsFile: 'C:\\Users\\Administrator\\.dsh\\newmedia-workbench\\settings.json',
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

const registered = []
let panelComponent = null

const fakeCtx = {
  effect() {},
  locale: { register: () => () => {}, bind: () => (key) => key },
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
  window: { __ModuleLoader__: { load(def) { sandbox.__def = def } } },
  console,
  navigator: {},
  document: { createElement: () => ({ style: {}, select() {}, setAttribute() {} }), body: { appendChild() {}, removeChild() {} } },
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  fetch: async () => ({ ok: false, json: async () => null, status: 0, statusText: 'offline' }),
}
sandbox.globalThis = sandbox

vm.createContext(sandbox)
vm.runInContext(source, sandbox)

const def = sandbox.__def
if (!def || def.id !== '@mindlink-ai/dsh-newmedia-workbench') throw new Error('module id mismatch or not loaded')
const mod = def.factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error(`unexpected require(${name})`)
})
mod.apply(fakeCtx)
if (!panelComponent) throw new Error('main panel was not registered')
console.log('registered slots:', registered.join(', '))

function collect(tree) {
  const texts = []
  const tags = []
  const styles = []
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
  return { text: texts.join('\n'), texts, tags, styles, tree }
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

/** 数一棵子树里的原生 button 元素 */
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

/** 拆出 ROOT 的三段：顶栏 / 页签条 / 滚动内容区 */
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

// 父组件 useState 顺序：
// data / loadError / notice / busy / selected / form / accountSelected / accountForm /
// query / platformFilter / confirmId / accountConfirmId / syncingId / syncingAll / settingsDraft / tab
const SETTINGS_DRAFT = { timeoutMs: '12000', proxy: '', credentials: {} }
const EMPTY_FORM = { id: '', name: '', stage: '冷启动', platforms: undefined }
const EMPTY_ACCOUNT = { id: '', cardId: '', platform: 'douyin', name: '', uid: '', homepage: '', handle: '', note: '', followers: '' }

function renderTab(tab, options = {}) {
  const { selected = '', form = EMPTY_FORM, accountSelected = '', accountForm = EMPTY_ACCOUNT } = options
  stateQueue.length = 0
  stateQueue.push(fixture, '', null, '', selected, form, accountSelected, accountForm, '', 'all', '', '', '', false, SETTINGS_DRAFT, tab)
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

// ---- 顶部固定区 + 三个页签（默认定位卡页签）
const cardsView = renderTab('cards')
checkText(cardsView, '标题', '新媒体工作台')
checkText(cardsView, '统计·定位卡', '定位卡')
checkText(cardsView, '统计·平台账号', '平台账号')
checkText(cardsView, '统计·粉丝合计', '粉丝合计')
checkText(cardsView, '统计·粉丝合计值', '1.2万')
checkText(cardsView, '统计·上次获取', '上次获取')
checkText(cardsView, 'tab·平台账号页签', '平台账号')
checkText(cardsView, 'tab·凭证设置页签', '凭证设置')
checkText(cardsView, '左列表·定位卡名', '老板IP')
checkText(cardsView, '左列表·关联账号数', '1 个平台账号')
checkText(cardsView, '左列表·粉丝数', '粉丝 1.2万')
checkText(cardsView, '右侧空态', '从左侧选一张定位卡')
check('默认页签不渲染别的页签内容', !cardsView.text.includes('采集设置'))

// ---- 定位卡选中：右侧人设编辑 + 关联账号只读区，不含平台账号编辑
const editingView = renderTab('cards', { selected: 'card-1', form: fixture.cards[0] })
checkText(editingView, '右侧·编辑标题', '编辑：老板IP')
checkText(editingView, '右侧·保存', '保存')
checkText(editingView, '右侧·保存并获取', '保存并获取')
checkText(editingView, '右侧·复制上下文', '复制上下文')
checkText(editingView, '右侧·删除', '删除')
checkText(editingView, '右侧·人设字段', '内容赛道')
checkText(editingView, '关联账号区', '关联的平台账号')
checkText(editingView, '关联账号名', '安思链')
checkText(editingView, '解除关联按钮', '解除关联')
checkText(editingView, '定位卡里不再有平台账号编辑', '定位卡只放人设')
check('定位卡编辑区不出现「新增平台账号」', !editingView.text.includes('新增平台账号'))
check('选中后不再显示空态', !editingView.text.includes('从左侧选一张定位卡'))

// ---- 新建定位卡
const newView = renderTab('cards', { selected: 'new' })
checkText(newView, '新建·填入示例', '填入示例')
check('新建时不显示空态', !newView.text.includes('从左侧选一张定位卡'))

// ---- 平台账号页签：左列表 + 右账号编辑
const accountsView = renderTab('accounts')
checkText(accountsView, '账号页·左列表账号名', '安思链')
checkText(accountsView, '账号页·所属定位卡', '定位卡：老板IP')
checkText(accountsView, '账号页·右空态', '从左侧选一个平台账号')
check('账号页不渲染定位卡编辑', !accountsView.text.includes('内容赛道'))

const accountEditing = renderTab('accounts', { accountSelected: 'pa-1', accountForm: fixture.accounts[0] })
checkText(accountEditing, '账号编辑·标题', '账号：安思链')
checkText(accountEditing, '账号编辑·关联定位卡', '关联定位卡')
checkText(accountEditing, '账号编辑·平台字段', '平台 *')
checkText(accountEditing, '账号编辑·保存账号', '保存账号')
checkText(accountEditing, '账号编辑·获取粉丝量', '获取粉丝量')
checkText(accountEditing, '账号编辑·删除', '删除')
checkText(accountEditing, '账号编辑·定位卡下拉项', '老板IP')
check('账号编辑不再显示右空态', !accountEditing.text.includes('从左侧选一个平台账号'))

// ---- 凭证设置页签
const settingsView = renderTab('settings')
checkText(settingsView, '设置·采集设置', '采集设置')
checkText(settingsView, '设置·超时字段', '请求超时（毫秒）')
checkText(settingsView, '设置·代理字段', 'HTTP 代理（可选）')
check('设置页签不渲染定位卡列表', !settingsView.text.includes('老板IP'))

// ---- 布局：顶部与页签条固定，只有内容区滚动
const outer = cardsView.styles.find((s) => s.overflow === 'hidden' && s.flexDirection === 'column')
const header = cardsView.styles.find((s) => s.padding === '18px 28px 0')
const tabstrip = cardsView.styles.find((s) => s.padding === '8px 28px 0' && typeof s.borderBottom === 'string')
const scroller = cardsView.styles.find((s) => s.overflowY === 'auto' && s.minHeight === 0)
check('外层自撑满且不溢出', Boolean(outer))
check('顶部信息固定', Boolean(header))
check('tab 条固定', Boolean(tabstrip))
check('只有内容区滚动', Boolean(scroller))

// ---- 左右两栏布局（定位卡与平台账号都是主从布局）
const twoColumn = cardsView.styles.find((s) => s.display === 'flex' && s.flexWrap === 'wrap' && s.gap === 16)
const leftList = cardsView.styles.find((s) => s.flex === '0 0 320px' && s.position === 'sticky')
check('定位卡页签是左右两栏', Boolean(twoColumn))
check('左栏固定宽度且随滚动吸顶', Boolean(leftList))
const accountsTwoColumn = accountsView.styles.find((s) => s.display === 'flex' && s.flexWrap === 'wrap' && s.gap === 16)
check('平台账号页签也是左右两栏', Boolean(accountsTwoColumn))

// ---- 页签独有的按钮放在页签内容区，顶栏没有按钮
const cardsRegions = regions(cardsView)
check('定位卡页签按钮在内容区', cardsRegions.scroll.includes('新建定位卡') && cardsRegions.scroll.includes('一键获取粉丝量'))
check('全局顶栏没有按钮', countButtons(cardsRegions.headerNode) === 0)
check('页签条只有页签按钮', countButtons(cardsRegions.tabstripNode) === 3)

const accountsRegions = regions(accountsView)
check('平台账号页签按钮在内容区', accountsRegions.scroll.includes('新增平台账号'))
check('平台账号页签时顶栏仍无按钮', countButtons(accountsRegions.headerNode) === 0)

const settingsRegions = regions(settingsView)
check('凭证页签按钮在内容区', settingsRegions.scroll.includes('保存设置') && settingsRegions.scroll.includes('返回定位卡'))
check('凭证页签时顶栏仍无按钮', countButtons(settingsRegions.headerNode) === 0)

console.log(`\n渲染节点: ${cardsView.tags.length} 个元素 / ${cardsView.texts.length} 段文本`)
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)

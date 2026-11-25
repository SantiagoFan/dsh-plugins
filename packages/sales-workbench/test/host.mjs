/**
 * Host 端到端测试：假 ctx + 本地 HTTP 源站，跑通「配渠道 → 配主题 → 采集 → 去重 → 查结果 → 导出」。
 * 不碰真实网络，也不写用户目录（DSH_DATA_COLLECTOR_DIR 指向临时目录）。
 *
 * 运行：node test/host.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import zlib from 'node:zlib'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcollector-'))
process.env.DSH_DATA_COLLECTOR_DIR = dataDir

const { apply } = await import('../index.js')

// ------------------------------------------------------------------ 源站
const feedXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>测试源</title>
  <item><title>应急演练新规出台</title><link>/news/1</link><pubDate>Wed, 18 Nov 2026 09:00:00 +0800</pubDate>
    <description><![CDATA[<p>采购人：内蒙古安泰实业有限责任公司 联系人：王工 联系电话：13800138000 项目地点：呼和浩特市新城区</p>]]></description></item>
  <item><title>消防安全检查通知</title><link>/news/2</link><pubDate>2026-11-17</pubDate><description>开展消防检查</description></item>
  <item><title>公司年会通知</title><link>/news/3</link><pubDate>2026-11-16</pubDate><description>与业务无关</description></item>
</channel></rss>`

const apiJson = JSON.stringify({
  code: 0,
  data: {
    list: [
      {
        title: '某市应急演练采购公告',
        link: '/bid/1',
        publishTime: '2026-11-18 10:00',
        abstract: '预算 120 万 联系人：李经理 联系电话：0471-6688999 项目地点：呼和浩特市赛罕区',
      },
      { title: '办公楼保洁服务招标', link: '/bid/2', publishTime: '2026-11-18', abstract: '与业务无关' },
    ],
  },
})

// 名录类接口：直接给公司/联系人/电话/地区
const directoryJson = JSON.stringify({
  total: 1,
  rows: [
    {
      orgName: '内蒙古示例安全技术服务有限公司',
      contactPerson: '赵工',
      contactPhone: '13800138888',
      provinceCityArea: '内蒙古自治区-呼和浩特市-赛罕区',
    },
  ],
})

// 接口搜索：URL 带 {query}，列表只给 ID，详情用 linkTemplate 拼
const searchJson = JSON.stringify({
  data: {
    total: 1,
    data: [{ noticeName: '2026年应急演练服务项目招标公告', sourceDataKey: 'key-123' }],
  },
})

const listHtml = `<!doctype html><html><body><ul>
  <li><a href="/tzgg/2026/a.html">关于印发应急演练预案的通知</a></li>
  <li><a href="/tzgg/2026/b.html">关于开展消防演练的通知</a></li>
  <li><a href="/about.html">关于我们</a></li>
  <li><a href="javascript:void(0)">打印</a></li>
  <li><a href="/tzgg/2026/a.html">重复链接</a></li>
</ul></body></html>`

const listDatedHtml = `<!doctype html><html><body>
<ul><li><a href="/tzgg/2026/d.html">关于开展年度消防演练的通知 2026-11-18 09:30</a></li></ul>
</body></html>`

// 详情页：联系人/电话/采购人/地点只在正文里，用来验证「跟进详情页」补全线索
const detailHtml = `<!doctype html><html><body>
<h1>关于印发应急演练预案的通知</h1>
<p>采购人：内蒙古蓝海物业服务有限公司</p>
<p>联系人：张三</p>
<p>联系电话：13911112222</p>
<p>项目地点：呼和浩特市赛罕区</p>
</body></html>`

const server = http.createServer((req, res) => {
  const url = req.url || '/'
  if (url === '/tzgg/2026/a.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(detailHtml)
    return
  }
  if (url === '/tzgg/2026/b.html') {
    // 详情页打不开：这条线索只靠列表页标题
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('boom')
    return
  }
  if (url === '/feed.xml') {
    res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' })
    res.end(feedXml)
    return
  }
  if (url === '/api.json') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(apiJson)
    return
  }
  if (url.startsWith('/api-directory.json')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(directoryJson)
    return
  }
  if (url.startsWith('/api-search.json')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(searchJson)
    return
  }
  if (url.startsWith('/detail')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<html><body><p>详情</p></body></html>')
    return
  }
  if (url === '/list.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(listHtml)
    return
  }
  if (url === '/list-dated.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(listDatedHtml)
    return
  }
  if (url === '/broken.xml') {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('boom')
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

// ------------------------------------------------------------------ 假 ctx
const routes = []
const tools = []
const services = {}
const prompts = []
let webEnabled = true
// ---- 假 Cordys CRM 服务（真实 HTTP）：验证插件内置的 CRM 客户端
const crmState = { calls: [], searchHits: () => [] }
const crmServer = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  let body = {}
  try {
    body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
  } catch {
    body = {}
  }
  const url = new URL(req.url, 'http://crm.test')
  const send = (data) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 100200, message: null, data }))
  }
  crmState.calls.push({ method: req.method, path: url.pathname, body })
  if (url.pathname === '/personal/center/info') return send({ userId: 'admin', name: '管理员', phone: '4000000000' })
  if (url.pathname === '/account/page') return send({ records: [], total: 0 })
  if (url.pathname === '/lead-pool/page') return send({ records: [{ id: 'pool_1', name: 'EvSim线索公海' }], total: 1 })
  if (url.pathname === '/product/page') return send({ records: [{ id: 'product_1', name: 'EvSim' }], total: 1 })
  if (url.pathname.startsWith('/global/search/')) {
    const target = url.pathname.slice('/global/search/'.length)
    const hits = crmState.searchHits(body.keyword, target) || []
    return send({ list: hits, total: hits.length })
  }
  if (url.pathname === '/pool/lead/page') {
    if (body.keyword === '池内已存在安全技术有限公司') return send({ list: [{ id: 'pool_lead_1', name: body.keyword }], total: 1 })
    return send({ list: [], total: 0 })
  }
  if (url.pathname === '/lead/add') return send({ id: `crm_${crmState.calls.length}` })
  if (url.pathname === '/lead/to-pool') return send({ success: 1 })
  send({})
})
await new Promise((resolve) => crmServer.listen(0, '127.0.0.1', resolve))
const crmBaseUrl = `http://127.0.0.1:${crmServer.address().port}`
const fakeWeb = {
  async fetch(request) {
    const response = await fetch(request.url)
    return { url: request.url, statusCode: response.status, body: { kind: 'text', content: await response.text() }, truncated: false }
  },
  async search(request) {
    return {
      sources: [
        { title: `搜索结果：${request.query}`, url: 'https://example.com/search/1', snippet: '关于演练的搜索结果摘要' },
        { title: '公告：应急演练服务采购', url: 'https://example.com/search/2', snippet: '预算 80 万' },
      ],
      truncated: false,
    }
  },
}
const ctx = {
  effect(fn) {
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
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
    if (name === 'web') return webEnabled ? fakeWeb : undefined
    if (name === 'systemPrompt') {
      return {
        section(section) {
          prompts.push(section)
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

// ------------------------------------------------------------------ 断言工具
let failed = 0
const check = (label, condition, detail) => {
  if (condition) console.log(`ok - ${label}`)
  else {
    failed += 1
    console.log(`FAIL - ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 400)}`}`)
  }
}

check('挂载了 1 个前缀路由', routes.length === 1 && routes[0].kind === 'prefix' && routes[0].path === '/data-collector', routes.map((r) => r.path))
check('注册了 data_collector 工具', tools.length === 1 && tools[0].name === 'data_collector', tools.map((t) => t.name))
check('注册了系统提示', prompts.length === 1 && prompts[0].name === 'data-collector')
check('提供了 Host 服务', Boolean(services.dataCollector))

const request = async (pathname, method = 'GET', body) => {
  const headers = body === undefined ? {} : { 'content-type': 'application/json' }
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
      this.raw = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ''), 'utf8')
      this.body = this.raw.toString('utf8')
    },
  }
  await routes[0].handler(req, res)
  let json = null
  try {
    json = JSON.parse(res.body)
  } catch {
    json = null
  }
  return { status: res.status, headers: res.headers, body: res.body, raw: res.raw, json }
}

/** 从 zip（xlsx）里取出一个文件的内容，用来验证导出的表头与行数。 */
function zipEntry(buffer, name) {
  let offset = 0
  while (offset + 30 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) return null
    const method = buffer.readUInt16LE(offset + 8)
    const size = buffer.readUInt32LE(offset + 18)
    const nameLen = buffer.readUInt16LE(offset + 26)
    const extraLen = buffer.readUInt16LE(offset + 28)
    const entryName = buffer.slice(offset + 30, offset + 30 + nameLen).toString('utf8')
    const dataStart = offset + 30 + nameLen + extraLen
    const data = buffer.slice(dataStart, dataStart + size)
    if (entryName === name) return method === 8 ? zlib.inflateRawSync(data) : data
    offset = dataStart + size
  }
  return null
}

/** 导出的 xlsx 里数据行数（不含表头）。 */
function sheetRowCount(raw) {
  const sheet = zipEntry(raw, 'xl/worksheets/sheet1.xml')
  if (!sheet) return -1
  const rows = sheet.toString('utf8').match(/<row r="\d+"/g) || []
  return Math.max(0, rows.length - 1)
}

const state = async () => (await request('/data-collector/state')).json

/** 等一次采集跑完（面板也是靠轮询 /state 的 runtime 判断）。 */
async function waitRun(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const current = await state()
    if (!current.runtime) return current
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  throw new Error('采集超时')
}

// ------------------------------------------------------------------ 1. 初始状态
const initial = await state()
check('初始没有主题和渠道', initial.topics.length === 0 && initial.channels.length === 0)
check('默认每天 07:30 北京时间', initial.schedule.time === '07:30' && initial.schedule.timeZone === 'Asia/Shanghai' && initial.schedule.enabled === true)
check('返回了下次运行时间', /^\d{4}-\d{2}-\d{2} 07:30$/.test(initial.schedule.nextRunLabel), initial.schedule.nextRunLabel)
check('数据文件在临时目录', String(initial.dataFile).startsWith(dataDir), initial.dataFile)
check('配置与线索分开存（SQLite）', initial.storage === undefined && String(initial.dbFile || '').endsWith('leads.db'), initial.dbFile)
check('线索库文件已创建', fs.existsSync(String(initial.dbFile)), String(initial.dbFile))
check('默认采集范围是内蒙古', initial.scope.regions.join() === '内蒙古' && initial.scope.keywords.length > 10, initial.scope)
check('默认「地区不明」策略是智能判断', initial.scope.unknown === 'smart', initial.scope.unknown)
check('范围摘要可读', String(initial.scope.summary).includes('内蒙古'), initial.scope.summary)
// 后续用例主要在验证「识别」，先把地区范围放开；范围过滤单独在最后一段验证
const unlimitedForTests = await request('/data-collector/scope', 'POST', { scope: { regions: [] } })
check('可以放开地区范围做识别测试', unlimitedForTests.json.scope.label === '不限地区', unlimitedForTests.json.scope)

const emptyRun = await request('/data-collector/run', 'POST', {})
check('没有渠道时拒绝采集', emptyRun.status === 400 && emptyRun.json.error === 'nothing_to_do', emptyRun.json)

// ------------------------------------------------------------------ 2. 配渠道
const post = (pathname, body) => request(pathname, 'POST', body)
const rssSaved = await post('/data-collector/channels/save', {
  channel: { name: '测试RSS', type: 'rss', url: `${origin}/feed.xml`, limit: 10 },
})
check('保存 RSS 渠道', rssSaved.status === 200 && rssSaved.json.created === true, rssSaved.json)
const jsonSaved = await post('/data-collector/channels/save', {
  channel: {
    name: '测试JSON',
    type: 'json',
    url: `${origin}/api.json`,
    itemPath: 'data.list',
    fieldTitle: 'title',
    fieldLink: 'link',
    fieldDate: 'publishTime',
    fieldSummary: 'abstract',
  },
})
check('保存 JSON 渠道', jsonSaved.status === 200 && jsonSaved.json.created === true, jsonSaved.json)
const htmlSaved = await post('/data-collector/channels/save', {
  channel: { name: '测试网页', type: 'html', url: `${origin}/list.html`, linkPattern: '/tzgg/' },
})
check('保存网页渠道', htmlSaved.status === 200 && htmlSaved.json.created === true, htmlSaved.json)
const searchSaved = await post('/data-collector/channels/save', {
  channel: { name: '测试搜索', type: 'search', query: '应急演练', limit: 5 },
})
check('保存搜索渠道', searchSaved.status === 200 && searchSaved.json.created === true, searchSaved.json)

check('渠道总数 4', (await state()).channels.length === 4)
check('渠道缺少 URL 时拒绝', (await post('/data-collector/channels/save', { channel: { name: '空渠道', type: 'rss' } })).json.error === 'bad_args')
const badRegex = await post('/data-collector/channels/save', {
  channel: { name: '坏正则', type: 'html', url: `${origin}/list.html`, linkPattern: '([' },
})
check('非法链接过滤正则被拒', badRegex.json.error === 'bad_args', badRegex.json)

// 测试渠道：相对链接要补成绝对地址
const tested = await post('/data-collector/channels/test', {
  channel: { name: '测试JSON', type: 'json', url: `${origin}/api.json`, itemPath: 'data.list' },
})
check('测试 JSON 渠道成功', tested.json.success === true && tested.json.count === 2, tested.json)
check('测试结果把相对链接补成绝对地址', String(tested.json.samples[0].sourceUrl).startsWith(origin), tested.json.samples && tested.json.samples[0])
const testedFail = await post('/data-collector/channels/test', { channel: { name: '坏源', type: 'rss', url: `${origin}/broken.xml` } })
check('测试失败返回错误而不是抛异常', testedFail.status === 200 && testedFail.json.success === false, testedFail.json)

// 名录类接口：字段直映射（公司/联系人/电话/地区），不靠关键词抽
const directoryTested = await post('/data-collector/channels/test', {
  channel: {
    name: '测试名录',
    type: 'json',
    url: `${origin}/api-directory.json`,
    itemPath: 'rows',
    fieldCompany: 'orgName',
    fieldContact: 'contactPerson',
    fieldPhone: 'contactPhone',
    fieldRegion: 'provinceCityArea',
    followDetail: false,
  },
})
check('名录接口能直映射公司/电话', directoryTested.json.success === true && directoryTested.json.count === 1, directoryTested.json)
check(
  '名录线索带联系人电话地区',
  directoryTested.json.samples[0].company === '内蒙古示例安全技术服务有限公司' &&
    directoryTested.json.samples[0].contact === '赵工' &&
    directoryTested.json.samples[0].phone === '138 0013 8888',
  directoryTested.json.samples[0],
)
const queryTested = await post('/data-collector/channels/test', {
  channel: {
    name: '测试接口查询',
    type: 'json',
    url: `${origin}/api-search.json?noticeName={query}`,
    itemPath: 'data.data',
    fieldTitle: 'noticeName',
    linkTemplate: `${origin}/detail?id={sourceDataKey}`,
    query: '应急演练',
    followDetail: false,
  },
})
check('URL 里的 {query} 被替换', queryTested.json.success === true, queryTested.json)
check('链接模板用字段拼出详情地址', queryTested.json.samples[0].sourceUrl === `${origin}/detail?id=key-123`, queryTested.json.samples[0])
const datedHtml = await post('/data-collector/channels/test', {
  channel: { name: '带日期的列表', type: 'html', url: `${origin}/list-dated.html`, linkPattern: '/tzgg/' },
})
const datedSample = datedHtml.json && datedHtml.json.samples ? datedHtml.json.samples[0] : null
check(
  '网页标题末尾的日期被拆成发布时间',
  Boolean(datedSample) && datedSample.title === '关于开展年度消防演练的通知' && datedSample.publishedAt === '2026-11-18 09:30',
  datedSample,
)
// ------------------------------------------------------------------ 3. 配主题
const topicSaved = await post('/data-collector/topics/save', { topic: { name: '应急演练', keywords: '演练、应急', notes: '只看演练相关' } })
check('保存主题', topicSaved.status === 200 && topicSaved.json.created === true, topicSaved.json)
check('主题没填关键词时拒绝', (await post('/data-collector/topics/save', { topic: { name: '空关键词' } })).json.error === 'bad_args')
const sameName = await post('/data-collector/topics/save', { topic: { name: '应急演练', keywords: '演练、应急' } })
check('同名主题视为更新而不是新建', sameName.status === 200 && sameName.json.created === false, sameName.json)
check(
  '更新主题保留 createdAt',
  Boolean(topicSaved.json.topic.createdAt) && sameName.json.topic.createdAt === topicSaved.json.topic.createdAt,
  { before: topicSaved.json.topic.createdAt, after: sameName.json.topic.createdAt },
)

// ------------------------------------------------------------------ 4. 采集
const runStart = await post('/data-collector/run', {})
check('手动采集已开始', runStart.status === 200 && runStart.json.started === true, runStart.json)

const afterFirst = await waitRun()
const firstRun = afterFirst.stats.lastRun
check('第一次采集成功', firstRun && firstRun.status === 'ok', firstRun)
check('共采到 4 条线索（RSS 1 + JSON 1 + 网页 1 + 搜索 1）', firstRun.newItems === 4, firstRun && firstRun.newItems)
check('其中 3 条识别出电话', firstRun.withPhone === 3, firstRun && firstRun.withPhone)
check('没有联系方式也没有采购意图的页面被跳过', firstRun.skipped >= 2, firstRun && firstRun.skipped)
check('跟进过详情页', firstRun.details >= 1, firstRun && firstRun.details)
check('主题关键词过滤掉了不相关页面', firstRun.filtered >= 2, firstRun && firstRun.filtered)
check('今日线索数 = 4', afterFirst.stats.itemsToday === 4, afterFirst.stats.itemsToday)
check('今日有电话的线索数 = 3', afterFirst.stats.withPhoneToday === 3, afterFirst.stats.withPhoneToday)
const reportFile = path.join(dataDir, 'reports', `${afterFirst.stats.today}.md`)
const reportText = fs.existsSync(reportFile) ? fs.readFileSync(reportFile, 'utf8') : ''
check(
  '当天报告是线索表格',
  reportText.includes('# 意向客户') && reportText.includes('| 公司名称 | 联系人 | 联系电话 | 地区 | 备注（网址来源） |'),
  reportText.slice(0, 200),
)

// ------------------------------------------------------------------ 5. 线索查询与导出
const results = await request('/data-collector/results?limit=50')
check('线索总数 4', results.json.total === 4, results.json.total)
check('线索按日期归档', Array.isArray(results.json.dates) && results.json.dates[0].count === 4, results.json.dates)
check('线索带主题与来源', results.json.items[0].topicName === '应急演练' && Boolean(results.json.items[0].sourceUrl), results.json.items[0])
const rssLead = results.json.items.find((item) => (item.sourceUrl || '').endsWith('/news/1'))
check(
  'RSS 摘要里的线索字段被识别',
  rssLead && rssLead.company === '内蒙古安泰实业有限责任公司' && rssLead.contact === '王工' && rssLead.phone === '138 0013 8000' && rssLead.region === '呼和浩特市新城区',
  rssLead,
)
const detailLead = results.json.items.find((item) => (item.sourceUrl || '').endsWith('/tzgg/2026/a.html'))
check(
  '详情页补全了公司/联系人/电话/地区',
  detailLead && detailLead.company === '内蒙古蓝海物业服务有限公司' && detailLead.contact === '张三' && detailLead.phoneDigits === '13911112222' && detailLead.region === '呼和浩特市赛罕区',
  detailLead,
)
const brokenDetailLead = results.json.items.find((item) => (item.sourceUrl || '').endsWith('/tzgg/2026/b.html'))
check('详情页打不开、也没有联系方式的页面被跳过', !brokenDetailLead && firstRun.skipped >= 2, brokenDetailLead)

const searched = await request('/data-collector/results?q=%E5%BA%94%E6%80%A5')
check('关键词过滤同样作用于线索字段', searched.json.total === 4, searched.json.items.map((item) => item.title))

// ---- 5b. 分页 / 检索（SQLite）
const paged1 = await request('/data-collector/results?pageSize=2&page=1')
check('分页：第 1 页返回 2 条', paged1.json.items.length === 2 && paged1.json.total === 4, paged1.json)
check('分页：页数正确', paged1.json.pages === 2 && paged1.json.page === 1 && paged1.json.pageSize === 2, paged1.json)
const paged2 = await request('/data-collector/results?pageSize=2&page=2')
check('分页：第 2 页返回剩下的 2 条', paged2.json.items.length === 2 && paged2.json.page === 2)
check('分页：两页不重复', paged1.json.items[0].id !== paged2.json.items[0].id)
const pagedOver = await request('/data-collector/results?pageSize=2&page=99')
check('分页：超出页码收敛到最后一页', pagedOver.json.page === 2 && pagedOver.json.items.length === 2, pagedOver.json)
const byContact = await request(`/data-collector/results?q=${encodeURIComponent('王工')}`)
check('检索：按联系人命中', byContact.json.total === 1 && byContact.json.items[0].contact === '王工', byContact.json.total)
const byPhone = await request(`/data-collector/results?q=${encodeURIComponent('13800138000')}`)
check('检索：按电话命中', byPhone.json.total === 1, byPhone.json.total)
const byCompany = await request(`/data-collector/results?q=${encodeURIComponent('安泰实业')}`)
check('检索：按公司名命中', byCompany.json.total === 1, byCompany.json.total)
const byRegion = await request(`/data-collector/results?q=${encodeURIComponent('赛罕区')}`)
check('检索：按地区命中（两条都在赛罕区）', byRegion.json.total === 2 && byRegion.json.items.every((item) => item.region.includes('赛罕区')), byRegion.json.total)
const onlyPhone = await request('/data-collector/results?hasPhone=1')
check('筛选：只看有电话', onlyPhone.json.total === 3 && onlyPhone.json.items.every((item) => item.phone), onlyPhone.json.total)
const byRange = await request(`/data-collector/results?dateFrom=${afterFirst.stats.today}&dateTo=${afterFirst.stats.today}`)
check('筛选：日期区间', byRange.json.total === 4, byRange.json.total)
const oldest = await request('/data-collector/results?sort=oldest&pageSize=1')
check('排序：最旧优先可取到', oldest.json.items.length === 1, oldest.json.items[0])
const phoneExport = await request('/data-collector/results/export?hasPhone=1')
check('导出跟随筛选（只看有电话）', sheetRowCount(phoneExport.raw) === 3, sheetRowCount(phoneExport.raw))

const exported = await request(`/data-collector/results/export?date=${afterFirst.stats.today}`)
check('不传 format 默认 Excel', String(exported.headers['content-type'] || '').includes('spreadsheetml'), exported.headers)
check('导出是 xlsx 附件', String(exported.headers['content-disposition'] || '').includes('.xlsx'), exported.headers)
check('导出内容是 ZIP（xlsx）', exported.raw.subarray(0, 2).toString('latin1') === 'PK', exported.raw.subarray(0, 8))
const sheetXml = zipEntry(exported.raw, 'xl/worksheets/sheet1.xml').toString('utf8')
check('xlsx 表头正确', sheetXml.includes('公司名称') && sheetXml.includes('联系电话') && sheetXml.includes('采集时间'), sheetXml.slice(0, 300))
check('xlsx 含 4 行线索', sheetRowCount(exported.raw) === 4, sheetRowCount(exported.raw))
check('xlsx 电话可读', sheetXml.includes('138 0013 8000'), sheetXml.slice(0, 400))
const csvRejected = await request('/data-collector/results/export?format=csv')
check('CSV 导出已移除', csvRejected.status === 400 && csvRejected.json.error === 'bad_args', csvRejected.json)
const markdownExport = await request('/data-collector/results/export?format=md')
check('Markdown 导出已移除', markdownExport.status === 400 && markdownExport.json.error === 'bad_args', markdownExport.json)

// ------------------------------------------------------------------ 6. 去重
await post('/data-collector/run', {})
const afterSecond = await waitRun()
const secondRun = afterSecond.stats.lastRun
check('第二次采集没有新线索', secondRun.newItems === 0, secondRun && secondRun.newItems)
check('第二次全部判为重复', secondRun.duplicate >= 4, secondRun && secondRun.duplicate)
check('线索总数没有膨胀', afterSecond.stats.itemsTotal === 4, afterSecond.stats.itemsTotal)

// ------------------------------------------------------------------ 7. 第二个主题（指定渠道）
const secondTopic = await post('/data-collector/topics/save', {
  topic: { name: '招标信息', keywords: '招标', channels: ['测试JSON'] },
})
check('按渠道名关联主题', secondTopic.status === 200 && secondTopic.json.topic.channelNames.includes('测试JSON'), secondTopic.json)
await post('/data-collector/run', {})
const afterThird = await waitRun()
check('第二个主题采到自己关心的线索', afterThird.stats.lastRun.newItems === 1, afterThird.stats.lastRun)
const bidItems = await request(`/data-collector/results?topic=${encodeURIComponent('招标信息')}`)
check('按主题过滤只看到招标线索', bidItems.json.total === 1 && bidItems.json.items[0].topicName === '招标信息', bidItems.json.items)

// ------------------------------------------------------------------ 8. 定时配置
const scheduleSaved = await post('/data-collector/schedule', { schedule: { time: '06:45', enabled: true, catchUp: false, retainDays: 7 } })
check('保存定时配置', scheduleSaved.status === 200 && scheduleSaved.json.schedule.time === '06:45', scheduleSaved.json.schedule)
check('下次运行时间按新时间算', / 06:45$/.test(scheduleSaved.json.schedule.nextRunLabel), scheduleSaved.json.schedule.nextRunLabel)
check('非法时间被拒', (await post('/data-collector/schedule', { schedule: { time: '25:00' } })).json.error === 'bad_args')
check('非法时区被拒', (await post('/data-collector/schedule', { schedule: { timeZone: 'Mars/Base' } })).json.error === 'bad_args')
const disabled = await post('/data-collector/schedule', { schedule: { enabled: false } })
check('可以关掉定时', disabled.json.schedule.enabled === false, disabled.json.schedule)

// ------------------------------------------------------------------ 9. Agent 工具
const toolResult = await tools[0].execute({ action: 'status' })
check('工具 status 返回配置', toolResult.ok === true && toolResult.channels.length === 4, toolResult && toolResult.channels && toolResult.channels.length)
const toolResults = await tools[0].execute({ action: 'results', limit: 3 })
check('工具 results 返回条目', toolResults.ok === true && toolResults.items.length === 3 && toolResults.total >= 5, toolResults && toolResults.total)
const toolSave = await tools[0].execute({ action: 'save_channel', data: { name: '工具加的渠道', type: 'search', query: '应急' } })
check('工具能加搜索渠道', toolSave.ok === true && toolSave.created === true, toolSave)
const toolBad = await tools[0].execute({ action: 'save_channel', data: { name: '无链接', type: 'rss' } })
check('工具返回可读错误', toolBad.ok === false && toolBad.error === 'bad_args' && Boolean(toolBad.hint), toolBad)
const toolStringData = await tools[0].execute({ action: 'save_channel', data: JSON.stringify({ name: '字符串参数的渠道', type: 'search', query: '应急' }) })
check('工具能接受被序列化成字符串的 data', toolStringData.ok === true && toolStringData.created === true, toolStringData)
const flatSave = await tools[0].execute({ action: 'save_channel', name: '扁平参数的渠道', type: 'search', query: '消防' })
check('工具能接受扁平字段参数', flatSave.ok === true && flatSave.created === true && flatSave.channel.type === 'search', flatSave)
const flatTopic = await tools[0].execute({ action: 'save_topic', name: '扁平主题', keywords: ['消防', '维保'], notes: '扁平参数' })
check('主题也支持扁平字段', flatTopic.ok === true && flatTopic.topic.keywords.length === 2, flatTopic)
const toolSchedule = await tools[0].execute({ action: 'set_schedule', data: { time: '07:30', enabled: true } })
check('工具能改定时', toolSchedule.ok === true && toolSchedule.schedule.time === '07:30', toolSchedule)
const toolTopic = await tools[0].execute({ action: 'save_topic', data: { name: '政策', keywords: '政策、通知', channels: [] } })
check('工具能加主题（关注全部渠道）', toolTopic.ok === true && toolTopic.topic.scopeLabel === '全部渠道', toolTopic)

// ------------------------------------------------------------------ 10. 删除
const removedTopic = await post('/data-collector/topics/delete', { name: '招标信息' })
check('删除主题', removedTopic.status === 200 && removedTopic.json.deleted === '招标信息', removedTopic.json)
const afterDelete = await state()
check('删主题连带删它的结果', afterDelete.stats.itemsTotal === 4, afterDelete.stats.itemsTotal)
const removedChannel = await post('/data-collector/channels/delete', { name: '测试网页' })
check('删除渠道', removedChannel.status === 200 && removedChannel.json.deleted === '测试网页', removedChannel.json)

// ------------------------------------------------------------------ 11. 没有 web 服务时退回原生 fetch
webEnabled = false
const noWebRun = await post('/data-collector/run', {})
check('没有 ctx.web 也能启动采集', noWebRun.status === 200 && noWebRun.json.started === true, noWebRun.json)
const afterNoWeb = await waitRun()
check('退回原生 fetch 也能抓到条目', afterNoWeb.stats.lastRun.tasks.some((task) => task.status === 'ok'), afterNoWeb.stats.lastRun.tasks)

// ------------------------------------------------------------------ 12. 导出跟随筛选（只有 xlsx）
const topicResults = await request(`/data-collector/results?date=${afterFirst.stats.today}&topic=${encodeURIComponent('应急演练')}`)
const topicExport = await request(`/data-collector/results/export?date=${afterFirst.stats.today}&topic=${encodeURIComponent('应急演练')}`)
check('按主题导出只含该主题', sheetRowCount(topicExport.raw) === topicResults.json.total, `${sheetRowCount(topicExport.raw)} vs ${topicResults.json.total}`)
const keywordExport = await request(`/data-collector/results/export?q=${encodeURIComponent('应急')}`)
check('按关键词导出条数与结果页一致', sheetRowCount(keywordExport.raw) === searched.json.total, `${sheetRowCount(keywordExport.raw)} vs ${searched.json.total}`)
const allExport = await request('/data-collector/results/export')
const allResults = await request('/data-collector/results?pageSize=200')
check('不传日期时导出全部日期', sheetRowCount(allExport.raw) === allResults.json.total, `${sheetRowCount(allExport.raw)} vs ${allResults.json.total}`)

// ------------------------------------------------------------------ 13. 没有启用渠道时不产生空运行
const beforeRuns = (await state()).runs.length
for (const item of (await state()).channels) await post('/data-collector/channels/save', { channel: { ...item, enabled: false } })
const afterDisable = await state()
check('全部渠道已停用', afterDisable.stats.enabledChannels === 0, afterDisable.channels.map((item) => [item.name, item.enabled]))
const blocked = await post('/data-collector/run', {})
check('没有启用渠道时拒绝采集', blocked.status === 400 && blocked.json.error === 'nothing_to_do', blocked.json)
check('不会留下「成功 0 条」的空运行记录', (await state()).runs.length === beforeRuns)
const toolBlocked = await tools[0].execute({ action: 'run' })
check('工具同样拒绝空采集', toolBlocked.ok === false && toolBlocked.error === 'nothing_to_do', toolBlocked)
for (const item of (await state()).channels) await post('/data-collector/channels/save', { channel: { ...item, enabled: true } })
check('恢复渠道启用状态', (await state()).stats.enabledChannels === 6, (await state()).stats.enabledChannels)

// ------------------------------------------------------------------ 14. 清空结果（配置保留）
const cleared = await tools[0].execute({ action: 'clear_results' })
check('工具能清空结果', cleared.ok === true && cleared.removed > 0, cleared)
check('清空后结果归零', (await state()).stats.itemsTotal === 0)
const clearedRoute = await post('/data-collector/results/clear', {})
check('路由清空空结果不报错', clearedRoute.status === 200 && clearedRoute.json.removed === 0, clearedRoute.json)
check('清空不影响主题与渠道', (await state()).topics.length === 3 && (await state()).channels.length === 6)
await post('/data-collector/run', {})
const afterClear = await waitRun()
check('清空后能重新采到条目', afterClear.stats.lastRun.newItems >= 2, afterClear.stats.lastRun)

// ------------------------------------------------------------------ 15. 采集范围（地区）
const strictScope = await post('/data-collector/scope', { scope: { regions: ['广东'], unknown: 'drop' } })
check(
  '可以改成其他地区并切换严格模式',
  strictScope.status === 200 && strictScope.json.scope.label === '广东' && strictScope.json.scope.unknown === 'drop',
  strictScope.json.scope,
)
await post('/data-collector/results/clear', {})
await post('/data-collector/run', {})
const outOfScope = await waitRun()
check('范围外的线索全部被排除', outOfScope.stats.lastRun.newItems === 0, outOfScope.stats.lastRun)
check('排除数量记在「地区外跳过」', outOfScope.stats.lastRun.outOfRegion > 0, outOfScope.stats.lastRun.outOfRegion)
const backToNeimenggu = await post('/data-collector/scope', { scope: { regions: ['内蒙古'], unknown: 'smart' } })
check('可以改回内蒙古', backToNeimenggu.json.scope.regions[0] === '内蒙古' && backToNeimenggu.json.scope.unknown === 'smart')
await post('/data-collector/results/clear', {})
await post('/data-collector/run', {})
const backInScope = await waitRun()
check('恢复内蒙古范围后能采到线索', backInScope.stats.lastRun.newItems > 0, backInScope.stats.lastRun)
const toolScope = await tools[0].execute({ action: 'set_scope', regions: ['内蒙古', '呼和浩特'], unknown: 'keep' })
check('工具能改采集范围', toolScope.ok === true && toolScope.scope.regions.length === 2 && toolScope.scope.unknown === 'keep', toolScope)
const unlimited = await post('/data-collector/scope', { scope: { regions: [] } })
check('清空地区=不限地区', unlimited.json.scope.label === '不限地区', unlimited.json.scope)

// ------------------------------------------------------------------ 16. 删除单条线索
const beforeDelete = (await state()).stats.itemsTotal
const pageNow = await request('/data-collector/results?pageSize=50')
const target = pageNow.json.items[0]
const deleted = await post('/data-collector/results/delete', { id: target.id })
check('删除单条线索返回 200', deleted.status === 200 && deleted.json.removed === 1, deleted.json)
check('删除后总数减 1', deleted.json.state.stats.itemsTotal === beforeDelete - 1, deleted.json.state.stats.itemsTotal)
const missingDelete = await post('/data-collector/results/delete', { id: 'lead_not_exist' })
check('删除不存在的线索返回 not_found', missingDelete.status === 400 && missingDelete.json.error === 'not_found', missingDelete.json)
const toolDeleteMissing = await tools[0].execute({ action: 'delete_lead', id: 'lead_not_exist' })
check('工具删除不存在的线索有可读错误', toolDeleteMissing.ok === false && toolDeleteMissing.error === 'not_found', toolDeleteMissing)
const afterDeleteList = await request('/data-collector/results?pageSize=50')
check('删除的线索不再出现在列表里', !afterDeleteList.json.items.some((item) => item.id === target.id))

// ------------------------------------------------------------------ 17. 内置 CRM：连接配置 → 查重 → 写入
const crmConn = await post('/data-collector/crm/connect', { baseUrl: crmBaseUrl, accessKey: 'test-ak', secretKey: 'test-sk', readOnly: false })
check('保存 CRM 连接配置', crmConn.status === 200 && crmConn.json.crm.baseUrl === crmBaseUrl && crmConn.json.crm.readOnly === false, crmConn.json)
const crmStatus = await request('/data-collector/crm/status')
check('CRM 状态：已配置 + Key 掩码', crmStatus.json.configured === true && crmStatus.json.crm.accessKey.includes('***'), crmStatus.json)
const crmProbe1 = await post('/data-collector/crm/test', {})
check('CRM 连接测试通过', crmProbe1.json.ok === true && crmProbe1.json.authOk === true && crmProbe1.json.identity.userId === 'admin', crmProbe1.json)
const toolCrmStatus = await tools[0].execute({ action: 'crm_status' })
check('工具 crm_status 返回连通信息', toolCrmStatus.ok === true && toolCrmStatus.probe.ok === true, toolCrmStatus)

const crmOpts = await request('/data-collector/crm/options')
check('CRM 选项：可写', crmOpts.status === 200 && crmOpts.json.writable === true, crmOpts.json)
check('CRM 选项：线索池', crmOpts.json.pools.some((pool) => pool.name === 'EvSim线索公海'), crmOpts.json.pools)
check('CRM 选项：产品', crmOpts.json.products.some((product) => product.name === 'EvSim'), crmOpts.json.products)
const crmConfig = await post('/data-collector/crm/config', { crm: { poolId: 'pool_1', poolName: 'EvSim线索公海' } })
check('保存线索池', crmConfig.status === 200 && crmConfig.json.crm.poolId === 'pool_1', crmConfig.json)

// 补采一轮，确保有足够「有电话」的线索
await post('/data-collector/run', {})
await waitRun()
// 测试库只有 2 个不重复手机号，这里手工补线索用于各分支
const { LeadDatabase } = await import('../lib/db.js')
const crmDb = new LeadDatabase(path.join(dataDir, 'leads.db'))
crmDb.insertLead({
  id: 'lead_crm_ok',
  key: 'p:crmtest13900001111',
  runId: 'run_test',
  date: (await state()).stats.today,
  topicId: 'topic_1',
  topicName: '应急演练行业',
  channelId: 'channel_1',
  channelName: '测试RSS',
  company: '内蒙古测试安全技术有限公司',
  contact: '测试联系人',
  phone: '13900001111',
  phoneDigits: '13900001111',
  region: '呼和浩特市新城区',
  note: '测试线索',
  title: '测试线索',
  sourceUrl: 'https://example.com/crm-test',
  publishedAt: '',
  fetchedAt: new Date().toISOString(),
})
crmDb.insertLead({
  id: 'lead_crm_pool',
  key: 'p:crmtest13900002222',
  runId: 'run_test',
  date: (await state()).stats.today,
  topicId: 'topic_1',
  topicName: '应急演练行业',
  channelId: 'channel_1',
  channelName: '测试RSS',
  company: '池内已存在安全技术有限公司',
  contact: '池内联系人',
  phone: '13900002222',
  phoneDigits: '13900002222',
  region: '包头市昆都仑区',
  note: '池内重复线索',
  title: '池内重复线索',
  sourceUrl: 'https://example.com/crm-pool',
  publishedAt: '',
  fetchedAt: new Date().toISOString(),
})
crmDb.insertLead({
  id: 'lead_crm_fail',
  key: 'p:crmtest13900003333',
  runId: 'run_test',
  date: (await state()).stats.today,
  topicId: 'topic_1',
  topicName: '应急演练行业',
  channelId: 'channel_1',
  channelName: '测试RSS',
  company: '写入失败可重试有限公司',
  contact: '失败联系人',
  phone: '13900003333',
  phoneDigits: '13900003333',
  region: '鄂尔多斯市东胜区',
  note: '失败分支',
  title: '失败分支',
  sourceUrl: 'https://example.com/crm-fail',
  publishedAt: '',
  fetchedAt: new Date().toISOString(),
})
crmDb.close()
const crmList = (await request('/data-collector/results?pageSize=100')).json.items
const phoneLeads = crmList.filter((item) => item.phoneDigits)
check('有 3 条以上可写线索', phoneLeads.length >= 3, phoneLeads.length)
const skipIds = new Set(['lead_crm_ok', 'lead_crm_pool', 'lead_crm_fail'])
const leadA = phoneLeads.find((item) => !skipIds.has(item.id))
const leadB = phoneLeads.filter((item) => !skipIds.has(item.id) && item.id !== leadA.id)[0]
const leadC = phoneLeads.find((item) => item.id === 'lead_crm_ok')
// A 手机号命中（线索模块）、B 公司名命中（客户模块）、C 干净
crmState.searchHits = (keyword, target) => {
  if (keyword === leadA.phoneDigits && target === 'lead') return [{ id: 'lead_hit_1', name: '已存在的线索' }]
  if (keyword === leadB.company && target === 'account') return [{ id: 'account_hit_1', name: '已存在的客户' }]
  return []
}
const precheck = await post('/data-collector/crm/precheck', { ids: [leadA.id, leadB.id, leadC.id] })
check('预检返回 3 条', precheck.status === 200 && precheck.json.total === 3, precheck.json)
check('手机号命中判重', precheck.json.items.find((item) => item.id === leadA.id).status === 'dup_phone', precheck.json.items)
check('公司名命中判重', precheck.json.items.find((item) => item.id === leadB.id).status === 'dup_name', precheck.json.items)
check('干净线索可写入', precheck.json.items.find((item) => item.id === leadC.id).status === 'ok', precheck.json.items)
check('预检统计', precheck.json.ready === 1 && precheck.json.duplicated === 2, precheck.json)
const afterPrecheck = (await request('/data-collector/results?pageSize=100')).json.items
check(
  'CRM 已存在的线索被标记已同步',
  afterPrecheck.find((item) => item.id === leadA.id).syncState === 'synced' && afterPrecheck.find((item) => item.id === leadB.id).syncState === 'synced',
  afterPrecheck.filter((item) => [leadA.id, leadB.id].includes(item.id)).map((item) => item.syncState),
)
check('命中的线索记录了 CRM 记录 id', afterPrecheck.find((item) => item.id === leadB.id).crmId === 'account_hit_1', afterPrecheck.find((item) => item.id === leadB.id))
check('预检命中的行带 marked 标记', precheck.json.items.find((item) => item.id === leadA.id).marked === true, precheck.json.items)
const poolLead = crmList.find((item) => item.id === 'lead_crm_pool')
const poolPrecheck = await post('/data-collector/crm/precheck', { ids: [poolLead.id] })
check('线索池里已存在的公司名也判重', poolPrecheck.json.items[0].status === 'dup_name' && poolPrecheck.json.items[0].hits.some((hit) => hit.target === 'pool-lead'), poolPrecheck.json.items)

// 写入失败分支：只读模式下写入会被拒绝并记到「写入失败」
const failLead = crmList.find((item) => item.id === 'lead_crm_fail')
const push = await post('/data-collector/crm/push', { ids: [leadC.id] })
check('写入只创建干净线索', push.json.created === 1 && push.json.failed === 0, push.json)
const addCall = crmState.calls.find((call) => call.path === '/lead/add')
check('写入字段：公司名/电话', Boolean(addCall) && addCall.body.name === leadC.company && addCall.body.phone === leadC.phoneDigits, addCall && addCall.body)
check('写入字段：备注含来源 URL', Boolean(addCall) && addCall.body.moduleFields.some((field) => field.fieldId === '179323998745600000' && String(field.fieldValue).includes('http')), addCall && addCall.body.moduleFields)
check('写入字段：地区编码', Boolean(addCall) && addCall.body.moduleFields.some((field) => field.fieldId === '494089249570693208' && /^\d{4}-$/.test(String(field.fieldValue))), addCall && addCall.body.moduleFields)
check('写入后移入线索池', crmState.calls.some((call) => call.path === '/lead/to-pool' && call.body.poolId === 'pool_1'), crmState.calls.filter((call) => call.path === '/lead/to-pool'))
const afterPush = (await request('/data-collector/results?pageSize=50')).json.items
check('写入后本地标记已同步', afterPush.find((item) => item.id === leadC.id).syncState === 'synced', afterPush.find((item) => item.id === leadC.id))
const pushes = crmState.calls.filter((call) => call.path === '/lead/add').length
const pushAgain = await post('/data-collector/crm/push', { ids: [leadC.id] })
check('已同步的不再重复写入', pushAgain.json.created === 0 && crmState.calls.filter((call) => call.path === '/lead/add').length === pushes, pushAgain.json)

// 只读模式：写入被拒绝
await post('/data-collector/crm/connect', { readOnly: true })
const readonlyOptions = await request('/data-collector/crm/options')
check('只读模式选项', readonlyOptions.json.writable === false, readonlyOptions.json)
const readonlyBefore = crmState.calls.filter((call) => call.path === '/lead/add').length
const blockedPush = await post('/data-collector/crm/push', { ids: [failLead.id] })
check('只读模式不创建线索', blockedPush.json.created === 0 && crmState.calls.filter((call) => call.path === '/lead/add').length === readonlyBefore, blockedPush.json)
check('只读失败会记到写入失败', (await request('/data-collector/results?sync=failed')).json.items.some((item) => item.id === failLead.id), (await request('/data-collector/results?sync=failed')).json.total)
await post('/data-collector/crm/connect', { readOnly: false })

// 没有线索池时拒绝写入
await post('/data-collector/crm/config', { crm: { poolId: '', poolName: '' } })
const noPool = await post('/data-collector/crm/push', { ids: [leadC.id] })
check('没有线索池时拒绝写入', noPool.status === 400 && noPool.json.error === 'bad_args', noPool.json)

// 工具入口
const toolCrm = await tools[0].execute({ action: 'crm_precheck', ids: [leadC.id] })
check('工具能预检 CRM 写入', toolCrm.ok === true && toolCrm.total === 1, toolCrm)
const toolSearch = await tools[0].execute({ action: 'crm_search', keyword: leadB.company })
check('工具 crm_search 返回命中', toolSearch.ok === true && toolSearch.results.some((group) => group.target === 'account' && group.total > 0), toolSearch)

// 同步状态筛选（线索页状态页签）
const syncedPage = await request('/data-collector/results?sync=synced&pageSize=100')
const unsyncedPage = await request('/data-collector/results?sync=unsynced&pageSize=100')
const failedPage = await request('/data-collector/results?sync=failed&pageSize=100')
const noPhonePage = await request('/data-collector/results?sync=no_phone&pageSize=100')
const allPage = await request('/data-collector/results?pageSize=1')
check('状态筛选：已同步只返回已同步行', syncedPage.json.items.every((item) => item.syncState === 'synced') && syncedPage.json.total >= 3, syncedPage.json.total)
check('状态筛选：未同步只返回未同步行', unsyncedPage.json.items.every((item) => item.syncState !== 'synced'), unsyncedPage.json.items.map((item) => item.syncState))
check('状态筛选：未同步不含无手机号', unsyncedPage.json.items.every((item) => Boolean(item.phoneDigits)), unsyncedPage.json.items.map((item) => item.phoneDigits))
check(
  '状态筛选：四个状态加起来等于全部',
  syncedPage.json.total + unsyncedPage.json.total + failedPage.json.total + noPhonePage.json.total === allPage.json.total,
  [syncedPage.json.total, unsyncedPage.json.total, failedPage.json.total, noPhonePage.json.total, allPage.json.total],
)
check(
  '状态计数与列表一致',
  allPage.json.statusCounts.all === allPage.json.total && allPage.json.statusCounts.synced === syncedPage.json.total && allPage.json.statusCounts.unsynced === unsyncedPage.json.total,
  allPage.json.statusCounts,
)
check('状态筛选：无手机号', noPhonePage.json.items.every((item) => !item.phoneDigits), noPhonePage.json.total)
const todayPage = await request('/data-collector/results?sync=today&pageSize=100')
const todayKey = (await state()).stats.today
check('状态筛选：今日采集', todayPage.json.items.every((item) => item.date === todayKey) && todayPage.json.total === todayPage.json.statusCounts.today, [todayPage.json.total, todayPage.json.statusCounts.today])

// ------------------------------------------------------------------ 收尾
server.close()
crmServer.close()
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)

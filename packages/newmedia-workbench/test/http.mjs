/**
 * Host HTTP 路由测试：用假 ctx 驱动 index.js，直接向挂载的 handler 发请求。
 * 覆盖：state 结构、保存/删除（含多平台关联）、凭证保存与清除（掩码且不泄漏明文）、
 *       粉丝量同步的失败分支、错误响应。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nmw-http-'))
process.env.DSH_NEWMEDIA_WORKBENCH_DIR = dataDir

const { apply } = await import('../index.js')

const routes = []
const tools = []
const services = {}
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

check('挂载了 1 个路由前缀', routes.length === 1 && routes[0].kind === 'prefix' && routes[0].path === '/newmedia-workbench', JSON.stringify(routes.map((item) => item.path)))

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

// 空库 state
let result = await request('/newmedia-workbench/state')
check('state 返回 200', result.status === 200 && result.json && result.json.ok === true, result.raw.slice(0, 200))
check('state 带平台能力表', Array.isArray(result.json.capabilities) && result.json.capabilities.length === 9, JSON.stringify(result.json.capabilities && result.json.capabilities.length))
check('平台顺序按用户账号：抖音/视频号/小红书/公众号在前', result.json.capabilities.slice(0, 4).map((item) => item.key).join(',') === 'douyin,shipinhao,xiaohongshu,wechat', JSON.stringify(result.json.capabilities.map((item) => item.key)))
check('state 的 B站能力=免配置', (result.json.capabilities.find((item) => item.key === 'bilibili') || {}).auto === 'free')
check('state 带凭证掩码结构', result.json.settings && result.json.settings.credentials.douyin.hasCookie === false, JSON.stringify(result.json.settings))
check('state 带账号字段提示', Boolean(result.json.platformFields.douyin.uidLabel), JSON.stringify(result.json.platformFields && Object.keys(result.json.platformFields)))
check('state 不含任何 cookie 明文', !/cookie"\s*:\s*"[^"]+"/.test(result.raw), result.raw.slice(0, 400))

// 新建：一张定位卡关联抖音 + 视频号
result = await request('/newmedia-workbench/save', 'POST', {
  account: {
    name: '老板IP',
    niche: '企业管理',
    platforms: [
      { platform: '抖音', name: '老板账号', uid: 'MS4wLjABAAAAxyz', homepage: 'https://www.douyin.com/user/MS4wLjABAAAAxyz' },
      { platform: '视频号', name: '老板IP', followers: '1.1万' },
    ],
  },
})
check('save 新建成功', result.status === 200 && result.json.created === true, result.raw.slice(0, 300))
check('save 保存 2 个平台账号', result.json.account.platforms.length === 2, JSON.stringify(result.json.account.platforms))
check('save 解析手填粉丝量', result.json.account.platforms[1].followersCount === 11000 && result.json.account.platforms[1].followersSource === 'manual', JSON.stringify(result.json.account.platforms[1]))
check('save 保留关联字段', result.json.account.platforms[0].uid === 'MS4wLjABAAAAxyz', JSON.stringify(result.json.account.platforms[0]))
const cardId = result.json.account.id

// 新建只能手动获取的平台卡（用于同步失败分支）
result = await request('/newmedia-workbench/save', 'POST', { account: { name: '手动卡', platforms: [{ platform: '视频号', name: '思链视频号', uid: 'sph-001' }, { platform: '公众号', name: '思链公众号' }] } })
check('save 手动卡成功', result.status === 200 && result.json.account.platforms.length === 2, result.raw.slice(0, 200))
const manualId = result.json.account.id

// 未关联账号（有账号名但没有账号 ID，不联网）
result = await request('/newmedia-workbench/save', 'POST', { account: { name: '未关联卡', platforms: [{ platform: '抖音', name: '老板抖音号' }] } })
const emptyId = result.json.account.id

// 凭证保存 + 掩码 + 代理
result = await request('/newmedia-workbench/settings', 'POST', {
  proxy: 'http://127.0.0.1:6696',
  credentials: { douyin: { cookie: 'ttwid=douyinsecret5678' }, xiaohongshu: { cookie: 'web_session=xhssecret9999' } },
})
check('settings 保存成功', result.status === 200 && result.json.ok === true, result.raw.slice(0, 200))
check('settings 回显 hasCookie', result.json.settings.credentials.douyin.hasCookie === true, JSON.stringify(result.json.settings.credentials.douyin))
check('settings 只回显掩码', result.json.settings.credentials.douyin.cookieMasked.includes('尾') && !result.json.settings.credentials.douyin.cookieMasked.includes('verysecret'), result.json.settings.credentials.douyin.cookieMasked)
check('settings 保存代理', result.json.settings.proxy === 'http://127.0.0.1:6696', result.json.settings.proxy)
check('响应不泄漏 cookie 明文', !result.raw.includes('douyinsecret5678') && !result.raw.includes('xhssecret9999'), result.raw.slice(0, 400))

// 再存一次只改超时：不能把已保存的 Cookie 清空
result = await request('/newmedia-workbench/settings', 'POST', { timeoutMs: 15000 })
check('空字段不会清空已有凭证', result.json.settings.credentials.douyin.hasCookie === true && result.json.settings.timeoutMs === 15000, JSON.stringify(result.json.settings.credentials.douyin))
check('settings.json 落盘且含凭证与代理', (() => {
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'))
  return stored.credentials.douyin.cookie === 'ttwid=douyinsecret5678' && stored.proxy === 'http://127.0.0.1:6696'
})(), fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8').slice(0, 300))

// 显式清除某个平台凭证
result = await request('/newmedia-workbench/settings', 'POST', { clear: ['douyin'] })
check('clear 清除指定平台凭证', result.json.settings.credentials.douyin.hasCookie === false && result.json.settings.credentials.xiaohongshu.hasCookie === true, JSON.stringify(result.json.settings.credentials))

// 非法代理不会被用于请求（保存时原样保存，采集时报 bad_proxy）
result = await request('/newmedia-workbench/settings', 'POST', { proxy: '127.0.0.1:6696' })
check('非法代理原样保存（采集时会报错）', result.json.settings.proxy === '127.0.0.1:6696', result.json.settings.proxy)
result = await request('/newmedia-workbench/settings', 'POST', { proxy: '' })
check('空代理可以清空', result.json.settings.proxy === '', result.json.settings.proxy)

// 同步：视频号/公众号只能手动 → 归入 manual，不算失败
result = await request('/newmedia-workbench/followers/sync', 'POST', { id: manualId })
check('视频号/公众号归入手动填写', result.status === 200 && result.json.total === 2 && result.json.manual === 2 && result.json.failed === 0 && result.json.results.every((item) => item.error === 'unsupported'), result.raw.slice(0, 500))
check('同步失败不写入粉丝数', (() => {
  const cardAccounts = result.json.state.accounts.filter((item) => item.cardId === manualId)
  return cardAccounts.length === 2 && cardAccounts.every((item) => item.followers === '')
})(), result.raw.slice(0, 300))
check('同步结果带定位卡名', result.json.results[0].card === '手动卡', JSON.stringify(result.json.results[0]))

// 同步：未填账号 ID → not_linked（不发起网络请求）
result = await request('/newmedia-workbench/followers/sync', 'POST', { id: emptyId })
check('未关联账号同步返回 not_linked', result.json.failed === 1 && result.json.results[0].error === 'not_linked', result.raw.slice(0, 400))

// 未知路由 / 错误方法
result = await request('/newmedia-workbench/nope')
check('未知路由 404', result.status === 404 && result.json.error === 'not_found', result.raw.slice(0, 200))

// POST 非 JSON
result = await request('/newmedia-workbench/save', 'POST', { account: { name: 'x' } }, 'text/plain')
check('非 JSON 请求被拒 415', result.status === 400 && result.json.error === 'unsupported_media_type', result.raw.slice(0, 200))

// 删除
result = await request('/newmedia-workbench/delete', 'POST', { id: emptyId })
check('delete 成功', result.status === 200 && result.json.ok === true, result.raw.slice(0, 200))

// context 路由
result = await request(`/newmedia-workbench/context?id=${encodeURIComponent(cardId)}`)
check('context 路由返回 Markdown', result.status === 200 && result.json.context.includes('关联平台账号') && result.json.context.includes('老板账号'), result.raw.slice(0, 400))

// Host 服务
check('Host 服务暴露 syncFollowers', services.newmediaWorkbench && typeof services.newmediaWorkbench.syncFollowers === 'function')
check('Host 服务 status 不泄漏明文', !JSON.stringify(services.newmediaWorkbench.status()).includes('douyinsecret5678'))

fs.rmSync(dataDir, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nall http checks passed')

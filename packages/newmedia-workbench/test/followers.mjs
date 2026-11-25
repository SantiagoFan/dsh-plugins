/**
 * 粉丝量采集器单测：不联网，用假 fetch 验证各平台解析、凭证要求、错误映射与安全白名单行为。
 */
import { capabilityOf, formatCount, parseCount, resolveTarget, syncOneAccount, syncTargets } from '../lib/followers.js'
import { DEFAULT_TIMEOUT_MS } from '../lib/settings.js'

const failures = []
const check = (label, condition, detail) => {
  if (condition) console.log(`ok - ${label}`)
  else {
    failures.push(label)
    console.log(`FAIL - ${label}${detail ? ` :: ${detail}` : ''}`)
  }
}

// ---------------------------------------------------------------- 计数解析
check('parseCount 千分位', parseCount('12,345') === 12345)
check('parseCount 万', parseCount('1.2万') === 12000)
check('parseCount w', parseCount('3.2w') === 32000)
check('parseCount 亿', parseCount('1.5亿') === 150000000)
check('parseCount 数字', parseCount(9876) === 9876)
check('parseCount 空值', parseCount('') === null && parseCount(null) === null && parseCount('abc') === null)
check('formatCount 万', formatCount(32000) === '3.2万')
check('formatCount 整数', formatCount(999) === '999')
check('formatCount 亿', formatCount(150000000) === '1.5亿')

// ---------------------------------------------------------------- 能力声明（按本机实测）
check('B站免配置', capabilityOf('bilibili').auto === 'free' && capabilityOf('bilibili').needs.length === 0)
check('快手免配置', capabilityOf('kuaishou').auto === 'free' && capabilityOf('kuaishou').needs.length === 0)
check('抖音需要 Cookie', capabilityOf('douyin').auto === 'cookie' && capabilityOf('douyin').needs.includes('cookie'))
check('小红书需要 Cookie', capabilityOf('xiaohongshu').auto === 'cookie')
check('视频号只能手动', capabilityOf('shipinhao').auto === 'manual')
check('公众号只能手动', capabilityOf('wechat').auto === 'manual')
check('TikTok 免 Cookie', capabilityOf('tiktok').auto === 'free' && capabilityOf('tiktok').needs.length === 0)
check('YouTube 需要 API Key', capabilityOf('youtube').auto === 'apiKey' && capabilityOf('youtube').needs.includes('apiKey'))
check('未知平台按手动处理', capabilityOf('nope').auto === 'manual' && capabilityOf('nope').key === 'other')

// ---------------------------------------------------------------- 目标解析
check('B站 UID 数字', JSON.stringify(resolveTarget('bilibili', { uid: '2' })) === '{"mid":"2"}')
check('B站空间链接', (resolveTarget('bilibili', { homepage: 'https://space.bilibili.com/2' }) || {}).mid === '2')
check('抖音 sec_uid', (resolveTarget('douyin', { uid: 'MS4wLjABAAAAxyz' }) || {}).secUid === 'MS4wLjABAAAAxyz')
check('抖音主页链接取 sec_uid', (resolveTarget('douyin', { homepage: 'https://www.douyin.com/user/MS4wLjABAAAAxyz' }) || {}).secUid === 'MS4wLjABAAAAxyz')
check('小红书 user_id', (resolveTarget('xiaohongshu', { uid: '5f3a1b2c9d8e7f6a5b4c3d2e' }) || {}).userId === '5f3a1b2c9d8e7f6a5b4c3d2e')
check('YouTube @handle', (resolveTarget('youtube', { uid: '@mkbhd' }) || {}).handle === 'mkbhd')
check('YouTube 频道 ID', (resolveTarget('youtube', { uid: 'UCBJycsmduvYEL83R_U4JriQ' }) || {}).channelId === 'UCBJycsmduvYEL83R_U4JriQ')
check('TikTok 用户名', (resolveTarget('tiktok', { uid: '@charlie' }) || {}).username === 'charlie')
check('白名单外主页不解析', resolveTarget('bilibili', { homepage: 'https://evil.example.com/2' }) === null)

// ---------------------------------------------------------------- 假 fetch 工具
const textResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Map(),
  body: null,
  text: async () => body,
})
const jsonResponse = (status, value) => textResponse(status, JSON.stringify(value))
const settingsOf = (overrides = {}) => ({
  timeoutMs: DEFAULT_TIMEOUT_MS,
  proxy: '',
  credentials: {
    douyin: { cookie: '', apiKey: '' },
    xiaohongshu: { cookie: '', apiKey: '' },
    bilibili: { cookie: '', apiKey: '' },
    kuaishou: { cookie: '', apiKey: '' },
    youtube: { cookie: '', apiKey: '' },
    tiktok: { cookie: '', apiKey: '' },
    ...overrides,
  },
})
const targetOf = (overrides = {}) => ({ id: 'pa_1', name: '测试账号', platform: 'bilibili', ...overrides })

// B站：免配置自动
{
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    return jsonResponse(200, { code: 0, data: { mid: 2, following: 1, follower: 3210000 } })
  }
  const result = await syncOneAccount(targetOf({ platform: 'bilibili', uid: '2' }), settingsOf(), { fetchImpl })
  check('B站采集成功', result.ok === true && result.count === 3210000, JSON.stringify(result))
  check('B站走 relation/stat 且带 vmid', calls.length === 1 && calls[0].includes('api.bilibili.com/x/relation/stat') && calls[0].includes('vmid=2'), calls.join(','))
  check('B站展示值', result.display === '321万', result.display)
  check('结果带目标信息', result.targetId === 'pa_1' && result.platformLabel === 'B站', JSON.stringify(result))
}

// B站：接口 code 非 0
{
  const fetchImpl = async () => jsonResponse(200, { code: -404, message: '啥都木有' })
  const result = await syncOneAccount(targetOf({ platform: 'bilibili', uid: '999' }), settingsOf(), { fetchImpl })
  check('B站平台错误被识别', result.ok === false && result.error === 'platform_error' && result.message.includes('-404'), JSON.stringify(result))
}

// B站：被重定向（风控）→ 视为需要登录
{
  const fetchImpl = async () => textResponse(302, '')
  const result = await syncOneAccount(targetOf({ platform: 'bilibili', uid: '2' }), settingsOf(), { fetchImpl })
  check('302 映射为需要 Cookie', result.ok === false && result.error === 'needs_cookie', JSON.stringify(result))
}

// 网络错误
{
  const fetchImpl = async () => {
    throw new Error('getaddrinfo ENOTFOUND')
  }
  const result = await syncOneAccount(targetOf({ platform: 'bilibili', uid: '2' }), settingsOf(), { fetchImpl })
  check('网络错误有清晰提示', result.ok === false && result.error === 'network_error', JSON.stringify(result))
}

// 代理地址非法
{
  const result = await syncOneAccount(targetOf({ platform: 'bilibili', uid: '2' }), settingsOf(), { fetchImpl: async () => jsonResponse(200, {}) })
  check('空代理走直连', result.ok === false && result.error === 'platform_error', JSON.stringify(result))
  const bad = await syncOneAccount(
    targetOf({ platform: 'bilibili', uid: '2' }),
    { ...settingsOf(), proxy: '127.0.0.1:6696' },
    { fetchImpl: async () => jsonResponse(200, {}) },
  )
  check('非法代理地址被拒绝', bad.ok === false && bad.error === 'bad_proxy', JSON.stringify(bad))
}

// 抖音：iesdouyin 通道成功
{
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    return jsonResponse(200, { user_info: { follower_count: 230000 } })
  }
  const result = await syncOneAccount(targetOf({ platform: 'douyin', uid: 'MS4wLjABAAAAxyz' }), settingsOf(), { fetchImpl })
  check('抖音走 iesdouyin 成功', result.ok === true && result.count === 230000, JSON.stringify(result))
  check('抖音请求 iesdouyin 域名', calls[0].includes('iesdouyin.com') && calls[0].includes('sec_uid='), calls.join(','))
}

// 抖音：无 Cookie 且 iesdouyin 无数据 → needs_cookie
{
  const fetchImpl = async () => jsonResponse(200, { user_info: {} })
  const result = await syncOneAccount(targetOf({ platform: 'douyin', uid: 'MS4wLjABAAAAxyz' }), settingsOf(), { fetchImpl })
  check('抖音无 Cookie 时提示配置 Cookie', result.ok === false && result.error === 'needs_cookie', JSON.stringify(result))
}

// 抖音：只有抖音号（无 sec_uid）→ 明确提示要 sec_uid
{
  const fetchImpl = async () => jsonResponse(200, {})
  const result = await syncOneAccount(targetOf({ platform: 'douyin', uid: 'zhichang' }), settingsOf(), { fetchImpl })
  check('抖音只填抖音号时提示要 sec_uid', result.ok === false && ['needs_sec_uid', 'needs_cookie'].includes(result.error), JSON.stringify(result))
}

// 小红书：无 Cookie
{
  const result = await syncOneAccount(targetOf({ platform: 'xiaohongshu', uid: '5f3a1b2c9d8e7f6a5b4c3d2e' }), settingsOf(), { fetchImpl: async () => jsonResponse(200, {}) })
  check('小红书无 Cookie 时提示配置', result.ok === false && result.error === 'needs_cookie', JSON.stringify(result))
}

// 小红书：有 Cookie，从 __INITIAL_STATE__ 的 interactions 里取粉丝
{
  const html =
    '<html><script>window.__INITIAL_STATE__={"user":{"userPageData":{"interactions":[{"name":"关注","count":"6"},{"name":"粉丝","count":"1.2万"}]}}}</script></html>'
  const fetchImpl = async (url) => {
    if (!String(url).includes('xiaohongshu.com/user/profile/')) throw new Error(`unexpected url ${url}`)
    return textResponse(200, html)
  }
  const result = await syncOneAccount(
    targetOf({ platform: 'xiaohongshu', uid: '5f3a1b2c9d8e7f6a5b4c3d2e' }),
    settingsOf({ xiaohongshu: { cookie: 'a1=xxx; web_session=yyy', apiKey: '' } }),
    { fetchImpl },
  )
  check('小红书解析 interactions 粉丝数', result.ok === true && result.count === 12000, JSON.stringify(result))
}

// YouTube：Data API Key 通道
{
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    return jsonResponse(200, { items: [{ statistics: { subscriberCount: '18500000', videoCount: '1200' } }] })
  }
  const result = await syncOneAccount(
    targetOf({ platform: 'youtube', uid: '@mkbhd' }),
    settingsOf({ youtube: { cookie: '', apiKey: 'AIza-test' } }),
    { fetchImpl },
  )
  check('YouTube Data API 通道', result.ok === true && result.count === 18500000, JSON.stringify(result))
  check('YouTube 带上 forHandle 与 key', calls[0].includes('forHandle=%40mkbhd') && calls[0].includes('key=AIza-test'), calls.join(','))
}

// YouTube：频道隐藏订阅数
{
  const fetchImpl = async () => jsonResponse(200, { items: [{ statistics: { subscriberCount: '0', hiddenSubscriberCount: true } }] })
  const result = await syncOneAccount(
    targetOf({ platform: 'youtube', uid: 'UCBJycsmduvYEL83R_U4JriQ' }),
    settingsOf({ youtube: { cookie: '', apiKey: 'AIza-test' } }),
    { fetchImpl },
  )
  check('YouTube 隐藏订阅数被识别', result.ok === false && result.error === 'hidden', JSON.stringify(result))
}

// YouTube：没有 API Key 时解析页面缩写值（30.7M subscribers）
{
  const html = '<script>var ytInitialData = {"header":{"pageHeaderRenderer":{"metadata":{"metadataParts":[{"text":{"content":"30.7M subscribers"}}]}}}}</script>'
  const result = await syncOneAccount(targetOf({ platform: 'youtube', uid: '@MrBeast' }), settingsOf(), { fetchImpl: async () => textResponse(200, html) })
  check('YouTube 无 Key 时页面解析缩写值', result.ok === true && result.count === 30700000, JSON.stringify(result))
}

// TikTok：免 Cookie，从 __UNIVERSAL_DATA_FOR_REHYDRATION__ 取 followerCount
{
  const html =
    '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">{"__DEFAULT_SCOPE__":{"webapp.user-detail":{"userInfo":{"stats":{"followerCount":9876}}}}}</script>'
  const result = await syncOneAccount(targetOf({ platform: 'tiktok', uid: '@charlie' }), settingsOf(), { fetchImpl: async () => textResponse(200, html) })
  check('TikTok 免 Cookie 解析 followerCount', result.ok === true && result.count === 9876, JSON.stringify(result))
}

// 快手：SSR INIT_STATE 里的 ownerCount.fan（免 Cookie）
{
  const html = '<script>window.INIT_STATE={"kuaishou":{"web":"x"},"userProfile":{"ownerCount":{"fan":1279173,"like":693559,"follow":526}}}</script>'
  const result = await syncOneAccount(
    targetOf({ platform: 'kuaishou', uid: '3xgx4ky26jmq4ms' }),
    settingsOf(),
    { fetchImpl: async (url) => (String(url).includes('kuaishou.com/profile/3xgx4ky26jmq4ms') ? textResponse(200, html) : textResponse(404, '')) },
  )
  check('快手免 Cookie 解析 ownerCount.fan', result.ok === true && result.count === 1279173, JSON.stringify(result))
}

// 快手：SSR 被降级（无 ownerCount）时给出可操作提示
{
  const result = await syncOneAccount(
    targetOf({ platform: 'kuaishou', uid: '3xgx4ky26jmq4ms' }),
    settingsOf(),
    { fetchImpl: async () => textResponse(200, '<html><body>验证</body></html>') },
  )
  check('快手 SSR 降级有提示', result.ok === false && result.error === 'parse' && String(result.hint).includes('国内直连'), JSON.stringify(result))
}

// 视频号/公众号：只能手动
{
  for (const platform of ['shipinhao', 'wechat']) {
    const result = await syncOneAccount(targetOf({ platform, uid: 'x1' }), settingsOf(), { fetchImpl: async () => jsonResponse(200, {}) })
    check(`${capabilityOf(platform).label}返回 unsupported`, result.ok === false && result.error === 'unsupported', JSON.stringify(result))
  }
}

// 未关联账号
{
  const result = await syncOneAccount(targetOf({ platform: 'bilibili', uid: '', homepage: '' }), settingsOf(), { fetchImpl: async () => jsonResponse(200, {}) })
  check('未关联时返回 not_linked', result.ok === false && result.error === 'not_linked' && String(result.hint).includes('B站 UID'), JSON.stringify(result))
}

// 白名单外的主页不会被请求
{
  const calls = []
  const result = await syncOneAccount(
    targetOf({ platform: 'bilibili', uid: '', homepage: 'https://evil.example.com/?mid=2' }),
    settingsOf(),
    { fetchImpl: async (url) => (calls.push(String(url)), jsonResponse(200, { code: 0, data: { follower: 1 } })) },
  )
  check('白名单外主页不发起请求', result.ok === false && result.error === 'not_linked' && calls.length === 0, `${JSON.stringify(result)} calls=${calls.join(',')}`)
}

// 批量采集汇总
{
  const fetchImpl = async (url) => {
    if (String(url).includes('api.bilibili.com')) return jsonResponse(200, { code: 0, data: { follower: 1000 } })
    return jsonResponse(200, {})
  }
  const run = await syncTargets({
    targets: [
      targetOf({ id: 'pa_b', name: 'B站号', platform: 'bilibili', uid: '2', cardId: 'acc_1', cardName: '老板IP' }),
      targetOf({ id: 'pa_s', name: '视频号', platform: 'shipinhao', uid: 'x', cardId: 'acc_1', cardName: '老板IP' }),
    ],
    settings: settingsOf(),
    fetchImpl,
  })
  check('批量采集统计', run.summary.total === 2 && run.summary.ok === 1 && run.summary.failed === 1, JSON.stringify(run.summary))
  check('批量采集结果带定位卡与账号', run.results[0].cardName === '老板IP' && run.results[1].targetName === '视频号', JSON.stringify(run.results.map((item) => item.targetName)))
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nall follower checks passed')

/**
 * Host 逻辑冒烟测试：不需要启动 Harness，用假的 ctx 驱动 index.js。
 * 覆盖：新建 / 列表 / 按名读取 / 口播上下文 / 增量更新 / 重名拒绝 / 平台账号关联 /
 *       link / status / sync_followers（不联网的失败分支）/ 旧数据迁移 / 落盘 / 删除。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nmw-smoke-'))
process.env.DSH_NEWMEDIA_WORKBENCH_DIR = dataDir

const { apply } = await import('../index.js')

const tools = []
const services = {}
const ctx = {
  effect(fn) {
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  get() {
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

const tool = tools.find((item) => item.name === 'newmedia_workbench')
if (!tool) throw new Error('tool newmedia_workbench 未注册')
const call = async (args) => await tool.execute(args)

const failures = []
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`ok - ${label}`)
  } else {
    failures.push(label)
    console.log(`FAIL - ${label}${detail ? ` :: ${detail}` : ''}`)
  }
}

// 空列表
let result = await call({ action: 'list' })
check('list 空数据', result.ok === true && result.total === 0, JSON.stringify(result))

// 空库时未指定账号
result = await call({ action: 'context' })
check('无账号时 context 提示新建', result.ok === false && result.error === 'no_accounts', JSON.stringify(result))

// 新建：一张定位卡关联两个平台账号（抖音 + 视频号）
result = await call({
  action: 'upsert',
  data: {
    name: '老板IP',
    stage: '成长期',
    niche: '企业管理 / 老板心法',
    audience: '30-45 岁中小企业老板',
    persona: '干了 15 年实业的老板',
    value: '用踩过的坑讲管理',
    pillars: ['招人用人', '现金流'],
    tone: '口语化、直接',
    taboo: '不承诺保过、不贩卖焦虑',
    keywords: '管理、现金流',
    platforms: [
      { platform: '抖音', name: '老板账号', uid: 'MS4wLjABAAAAxyz', homepage: 'https://www.douyin.com/user/MS4wLjABAAAAxyz' },
      { platform: '视频号', name: '老板IP', followers: '1.1万' },
    ],
  },
})
check('upsert 新建定位卡', result.ok === true && result.created === true, JSON.stringify(result).slice(0, 200))
check('关联了 2 个平台账号', result.account.platforms.length === 2, JSON.stringify(result.account.platforms))
check('平台别名映射（抖音/视频号）', result.account.platforms[0].platform === 'douyin' && result.account.platforms[1].platform === 'shipinhao', JSON.stringify(result.account.platforms.map((p) => p.platform)))
check('关联字段已保存', result.account.platforms[0].uid === 'MS4wLjABAAAAxyz' && result.account.platforms[0].homepage.includes('douyin.com'), JSON.stringify(result.account.platforms[0]))
check('手填粉丝量被解析成精确数', result.account.platforms[1].followersCount === 11000 && result.account.platforms[1].followersSource === 'manual', JSON.stringify(result.account.platforms[1]))
const cardId = result.account.id
const douyinPaId = result.account.platforms[0].id

// 只有一张卡时，不传 account 也能自动选中
result = await call({ action: 'context' })
check('单卡时 context 自动选卡', result.ok === true && result.auto_selected === true && result.context.includes('老板IP'), String(result.context).slice(0, 120))
check('context 列出关联平台账号', result.context.includes('1. 抖音｜账号 老板账号') && result.context.includes('2. 视频号｜账号 老板IP'), result.context)
check('context 带粉丝量与来源', result.context.includes('粉丝量 11,000，手动填写'), result.context)

// 重复创建重名 → 报错
result = await call({ action: 'upsert', data: { name: '老板IP', niche: '别的赛道' } })
check('重名被拒绝', result.ok === false && result.error === 'duplicate_name', JSON.stringify(result))

// 列表
result = await call({ action: 'list' })
check('list 有 1 张定位卡', result.ok === true && result.total === 1 && result.accounts[0].name === '老板IP', JSON.stringify(result))
check('list 摘要含平台与粉丝合计', result.accounts[0].platformKeys.length === 2 && result.accounts[0].followersTotal === 11000 && result.accounts[0].linkedCount === 1, JSON.stringify(result.accounts[0]))
check('list 摘要不含长文本', result.accounts[0].audience === undefined, JSON.stringify(result.accounts[0]))

// 按平台过滤：任一平台命中即可
result = await call({ action: 'list', platform: '视频号' })
check('list 按平台过滤命中多平台卡', result.ok === true && result.total === 1, JSON.stringify(result))
result = await call({ action: 'list', platform: '小红书' })
check('list 按平台过滤不命中', result.ok === true && result.total === 0, JSON.stringify(result))

// 按平台账号名也能找到定位卡
result = await call({ action: 'get', account: '老板账号' })
check('get 按平台账号名找到定位卡', result.ok === true && result.account.name === '老板IP', JSON.stringify(result).slice(0, 160))

// 口播上下文（按 id）
result = await call({ action: 'context', account: cardId })
check('context 返回 Markdown', result.ok === true && result.context.includes('# 账号定位卡：老板IP'), String(result.context).slice(0, 120))
check('context 含内容支柱编号', result.context.includes('1. 招人用人'), result.context)
check('context 含禁忌', result.context.includes('禁忌与红线：不承诺保过；不贩卖焦虑'), result.context)

// 增量更新（只传 tone）：不能丢平台账号
result = await call({ action: 'upsert', account: '老板IP', data: { tone: '更犀利一点' } })
check('upsert 增量更新', result.ok === true && result.created === false && result.account.tone === '更犀利一点', JSON.stringify(result).slice(0, 160))
check('增量更新保留平台账号', result.account.platforms.length === 2 && result.account.platforms[0].uid === 'MS4wLjABAAAAxyz', JSON.stringify(result.account.platforms))
check('增量更新保留其它字段', result.account.niche === '企业管理 / 老板心法' && result.account.pillars === '招人用人\n现金流', JSON.stringify(result.account))

// link：新增一个平台账号（不联网）
result = await call({ action: 'link', account: '老板IP', data: { platform: '小红书', name: '老板IP小红书', uid: '5f3a1b2c9d8e7f6a5b4c3d2e' }, sync: false })
check('link 新增平台账号', result.ok === true && result.account.platforms.length === 3 && result.sync === null, JSON.stringify(result).slice(0, 240))
check('link 新增的账号平台正确', result.account.platforms[2].platform === 'xiaohongshu', JSON.stringify(result.account.platforms[2]))

// link：按 platform+uid 更新已有账号，不重复添加
result = await call({ action: 'link', account: '老板IP', data: { platform: '抖音', uid: 'MS4wLjABAAAAxyz', handle: '@老板账号' }, sync: false })
check('link 更新而不重复', result.ok === true && result.account.platforms.length === 3 && result.account.platforms[0].handle === '@老板账号', JSON.stringify(result.account.platforms.map((p) => p.handle)))

// link 缺字段
result = await call({ action: 'link', account: '老板IP', data: { name: '没有平台' } })
check('link 缺 platform 被拒绝', result.ok === false && result.error === 'bad_args', JSON.stringify(result))

// status：能力 + 凭证状态
result = await call({ action: 'status' })
check('status 返回能力表', result.ok === true && result.capabilities.length === 9, JSON.stringify(result).slice(0, 200))
check('status 的平台账号计数', result.platformAccounts === 3 && result.linked === 2, JSON.stringify({ total: result.platformAccounts, linked: result.linked }))
check('status 未配置时 hasCookie=false', result.settings.credentials.douyin.hasCookie === false, JSON.stringify(result.settings))

// sync_followers：视频号/公众号只能手动（不联网）——算「需手动填写」而不是失败
await call({ action: 'upsert', data: { name: '手动卡', platforms: [{ platform: '视频号', name: '思链视频号', uid: 'sph-1' }, { platform: '公众号', name: '思链公众号' }] } })
result = await call({ action: 'sync_followers', account: '手动卡' })
check('sync_followers 视频号/公众号归入手动', result.ok === true && result.total === 2 && result.manual === 2 && result.failed === 0 && result.results.every((item) => item.error === 'unsupported'), JSON.stringify(result))
check('sync_followers 结果带定位卡与平台', result.results[0].card === '手动卡' && result.results.map((item) => item.platformLabel).sort().join(',') === '公众号,视频号', JSON.stringify(result.results))
check('sync_followers 有可操作 hint', String(result.hint).includes('手动填写'), result.hint)

// 空平台账号行不落库（避免在用户没关联时生成假账号）
result = await call({ action: 'upsert', data: { name: '空行卡', platforms: [{ platform: '抖音' }] } })
check('空平台行被丢弃', result.ok === true && result.account.platforms.length === 0, JSON.stringify(result.account.platforms))
check('空行卡摘要显示 0 平台', result.summary.platforms.length === 0, JSON.stringify(result.summary))
await call({ action: 'delete', account: '空行卡' })

// sync_followers：填了账号名但没填账号 ID → not_linked（不联网）
await call({ action: 'upsert', data: { name: '未关联卡', platforms: [{ platform: '抖音', name: '老板抖音号' }, { platform: '小红书', name: '老板小红书' }] } })
result = await call({ action: 'sync_followers', account: '未关联卡' })
check('sync_followers 未关联返回 not_linked', result.failed === 2 && result.results.every((item) => item.error === 'not_linked'), JSON.stringify(result))
await call({ action: 'delete', account: '手动卡' })
await call({ action: 'delete', account: '未关联卡' })

// 不存在的定位卡
result = await call({ action: 'context', account: '不存在' })
check('未知定位卡有可操作提示', result.ok === false && result.error === 'account_not_found' && String(result.hint).includes('老板IP'), JSON.stringify(result))

// 坏 action
result = await call({ action: 'nope' })
check('未知 action 被拒绝', result.ok === false && result.error === 'bad_action', JSON.stringify(result))

// Host 服务
check('Host 服务可读上下文', services.newmediaWorkbench && services.newmediaWorkbench.context('老板IP').includes('账号定位卡'), 'service missing')

// 落盘：v4 起定位卡与平台账号分开存
const file = path.join(dataDir, 'accounts.json')
const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
check('数据已落盘为 v4', stored.version === 4 && stored.cards.length === 1, JSON.stringify(stored).slice(0, 120))
const linkedToCard = stored.accounts.filter((item) => item.cardId === cardId)
check(
  '平台账号独立落盘并关联到定位卡',
  stored.accounts.length === 7 && linkedToCard.length === 3,
  JSON.stringify({ total: stored.accounts.length, linked: linkedToCard.length }),
)
check(
  '删卡后账号保留但未关联',
  stored.accounts.filter((item) => !item.cardId).length === 4,
  JSON.stringify(stored.accounts.map((item) => item.cardId)),
)
check('定位卡不再内嵌 platforms', stored.cards[0].platforms === undefined, JSON.stringify(Object.keys(stored.cards[0])))
check('旧字段不再落盘', stored.cards[0].platform === undefined && stored.cards[0].followers === undefined, JSON.stringify(Object.keys(stored.cards[0])))

// 删除定位卡：卡没了，平台账号保留但变成未关联
result = await call({ action: 'delete', account: cardId })
check('delete 删除定位卡', result.ok === true && result.total === 0, JSON.stringify(result))
const afterDelete = JSON.parse(fs.readFileSync(file, 'utf8'))
check(
  '删除后平台账号全部未关联',
  afterDelete.cards.length === 0 && afterDelete.accounts.length === 7 && afterDelete.accounts.every((item) => !item.cardId),
  JSON.stringify({ cards: afterDelete.cards.length, accounts: afterDelete.accounts.length }),
)

// 旧数据（v1：平台/粉丝量直接挂在卡上）读取时迁移成平台账号
fs.writeFileSync(
  file,
  JSON.stringify({
    version: 1,
    updatedAt: '',
    accounts: [{ name: '旧数据号', platform: 'xiaohongshu', handle: '@old', followers: '3.2w', createdAt: '2025-01-01T00:00:00.000Z' }],
  }),
)
const legacyList = await call({ action: 'list' })
check('旧数据可读', legacyList.ok === true && legacyList.total === 1, JSON.stringify(legacyList))
check('旧数据迁移成平台账号', legacyList.accounts[0].platforms.length === 1 && legacyList.accounts[0].platforms[0].platform === 'xiaohongshu', JSON.stringify(legacyList.accounts[0]))
check('旧数据粉丝量被解析', legacyList.accounts[0].platforms[0].followersCount === 32000, JSON.stringify(legacyList.accounts[0].platforms[0]))
const legacyId = legacyList.accounts[0].id
const legacyListAgain = await call({ action: 'list' })
check('旧数据 id 稳定', legacyListAgain.accounts[0].id === legacyId, `${legacyId} vs ${legacyListAgain.accounts[0].id}`)
check('旧数据平台账号 id 稳定', legacyListAgain.accounts[0].platforms[0].id === legacyList.accounts[0].platforms[0].id, 'platform account id changed')
const legacyGet = await call({ action: 'get', account: legacyId })
check('旧数据可按 id 读取', legacyGet.ok === true && legacyGet.account.name === '旧数据号', JSON.stringify(legacyGet))
const legacyDeleted = await call({ action: 'delete', account: legacyId })
check('旧数据可按 id 删除', legacyDeleted.ok === true && legacyDeleted.total === 0, JSON.stringify(legacyDeleted))
fs.rmSync(dataDir, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nall checks passed')

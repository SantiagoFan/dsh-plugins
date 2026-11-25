/**
 * SQLite 存储层测试：去重、分页、检索、筛选、导出、裁剪。
 * 需要 DSH 运行时自带的 Node（≥22.5，含 node:sqlite），系统 Node 20 会加载失败。
 *
 * 运行：ELECTRON_RUN_AS_NODE=1 "<DSH_NODE_EXECUTABLE>" test/db.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leads-db-'))
const file = path.join(dir, 'leads.db')

const { LeadDatabase } = await import('../lib/db.js')
const db = new LeadDatabase(file)

let failed = 0
const check = (label, ok, detail) => {
  if (ok) console.log(`ok - ${label}`)
  else {
    failed += 1
    console.log(`FAIL - ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 200)}`}`)
  }
}

const makeLead = (index, patch = {}) => ({
  id: `lead_${index}`,
  key: `k_${index}`,
  runId: 'run_1',
  date: '2026-11-20',
  topicId: 'topic_1',
  topicName: '应急演练行业',
  channelId: 'channel_1',
  channelName: '采购线索搜索',
  company: `测试公司${index}`,
  contact: index % 2 === 0 ? '王工' : '',
  phone: index % 2 === 0 ? '13800138000' : '0471-6688999',
  region: index % 2 === 0 ? '呼和浩特市新城区' : '包头市昆都仑区',
  note: `备注${index}`,
  title: `公告${index}`,
  sourceUrl: `https://example.com/${index}`,
  publishedAt: '',
  fetchedAt: `2026-11-20T0${index}:00:00.000Z`,
  ...patch,
})

check('数据库文件已创建', fs.existsSync(file))

// 插入 + key 唯一
check('插入第一条', db.insertLead(makeLead(1)) === true)
check('同一个 key 再插被忽略', db.insertLead(makeLead(1)) === false)
for (let i = 2; i <= 5; i += 1) db.insertLead(makeLead(i))
check('总条数 5', db.stats('2026-11-20').total === 5, db.stats('2026-11-20'))
check('有电话 5 条（phone_digits 自动补）', db.stats('2026-11-20').withPhone === 5, db.stats('2026-11-20'))

// 分页
const page1 = db.listLeads({ pageSize: 2, page: 1 })
const page3 = db.listLeads({ pageSize: 2, page: 3 })
check('分页第 1 页 2 条', page1.items.length === 2 && page1.total === 5 && page1.pages === 3, page1)
check('分页第 3 页 1 条', page3.items.length === 1 && page3.page === 3)
check('页码超界收敛', db.listLeads({ pageSize: 2, page: 99 }).page === 3)
check('每页上限 200', db.listLeads({ pageSize: 999 }).pageSize === 200)

// 检索
check('按公司检索', db.listLeads({ q: '测试公司3' }).total === 1)
check('按联系人检索', db.listLeads({ q: '王工' }).total === 2)
check('按电话检索', db.listLeads({ q: '13800138000' }).total === 2)
check('按地区检索', db.listLeads({ q: '包头' }).total === 3)
check('LIKE 通配符被转义', db.listLeads({ q: '%' }).total === 0)
check('只看有电话', db.listLeads({ hasPhone: true }).total === 5)
check('按主题过滤', db.listLeads({ topic: '应急演练行业' }).total === 5)
check('按不存在主题过滤', db.listLeads({ topic: '不存在' }).total === 0)
check('按日期区间过滤', db.listLeads({ dateFrom: '2026-11-20', dateTo: '2026-11-20' }).total === 5)
check('按日期区间排除', db.listLeads({ dateFrom: '2026-11-21' }).total === 0)

// 排序与导出
const oldest = db.listLeads({ sort: 'oldest', pageSize: 1 })
check('最旧优先', oldest.items[0].id === 'lead_1', oldest.items[0] && oldest.items[0].id)
check('导出不分页', db.exportLeads({}).length === 5)
check('导出跟随筛选', db.exportLeads({ hasPhone: true }).length === 5)
check('按日期聚合', db.dates().length === 1 && db.dates()[0].count === 5, db.dates())

// 运行记录
db.insertRun({
  id: 'run_1',
  startedAt: '2026-11-20T00:00:00.000Z',
  finishedAt: '2026-11-20T00:00:05.000Z',
  trigger: 'auto',
  status: 'ok',
  fetched: 10,
  newItems: 5,
  withPhone: 5,
  duplicate: 1,
  filtered: 2,
  skipped: 1,
  outOfRegion: 1,
  details: 3,
  errors: ['渠道A：超时'],
  tasks: [{ channelName: '采购线索搜索', status: 'ok', count: 5, withPhone: 5, details: 3, ms: 100, error: '' }],
})
const lastRun = db.lastRun()
check('运行记录可读回', lastRun && lastRun.id === 'run_1' && lastRun.tasks[0].channelName === '采购线索搜索', lastRun)
check('运行记录错误可读回', lastRun.errors[0].includes('超时'))

// 主题删除、单条删除、清空、裁剪
check('删除单条线索', db.deleteLead('lead_5') === 1)
check('再删同一条返回 0', db.deleteLead('lead_5') === 0)
check('删除后总数 4', db.stats('2026-11-20').total === 4, db.stats('2026-11-20'))
check('删除主题连带删线索', db.deleteLeadsByTopic('topic_1') === 4)
check('清空后为 0', db.stats('2026-11-20').total === 0)
for (let i = 1; i <= 3; i += 1) db.insertLead(makeLead(i))
db.insertLead(makeLead(9, { fetchedAt: '2020-01-01T00:00:00.000Z' }))
const pruned = db.prune(30, new Date('2026-11-20T12:00:00.000Z'))
check('裁剪掉过期线索', pruned.leads === 1, pruned)
check('裁剪后剩 3 条', db.stats('2026-11-20').total === 3)

// 旧数据修复：模拟「phone 有值但 phone_digits 为空」的历史行（v3 之前的库）
db.db.exec(`INSERT INTO leads (id, key, run_id, date, topic_id, topic_name, channel_id, channel_name,
  company, contact, phone, phone_digits, region, note, title, source_url, published_at, fetched_at)
  VALUES ('lead_legacy', 'k_legacy', 'run_1', '2026-11-20', 'topic_1', '应急演练行业', 'channel_1', '采购线索搜索',
  '旧数据公司', '', '13911112222', '', '呼和浩特市', '', '', '', '', '2026-11-20T05:00:00.000Z')`)
check('模拟旧数据 phone_digits 为空', db.listLeads({ hasPhone: true }).total === 3, db.listLeads({ hasPhone: true }).total)
const fixed = db.repairPhoneDigits()
check('补齐 phone_digits', fixed === 1, fixed)
check('补齐后可按电话筛选', db.listLeads({ hasPhone: true }).total === 4)
check('补齐后可按电话检索', db.listLeads({ q: '13911112222' }).total === 1)

// 同步状态统计与筛选
db.updateSync('lead_1', { crmId: 'crm_1', state: 'synced', at: '2026-11-20T08:00:00.000Z' })
db.updateSync('lead_2', { state: 'failed' })
const syncCounts = db.countBySync()
check('状态计数：全部', syncCounts.all === db.stats('2026-11-20').total, syncCounts)
check('状态计数：已同步 1 条', syncCounts.synced === 1, syncCounts)
check('状态计数：失败 1 条', syncCounts.failed === 1, syncCounts)
check('状态计数：未同步不含失败/已同步', syncCounts.unsynced === syncCounts.all - syncCounts.synced - syncCounts.failed - syncCounts.noPhone, syncCounts)
check('状态筛选：已同步', db.listLeads({ sync: 'synced' }).total === 1)
check('状态筛选：未同步排除已同步', db.listLeads({ sync: 'unsynced' }).items.every((item) => item.syncState !== 'synced'))
check('状态筛选：未同步必须有手机号', db.listLeads({ sync: 'unsynced' }).items.every((item) => Boolean(item.phoneDigits)))
check('状态筛选：失败', db.listLeads({ sync: 'failed' }).total === 1)
check('状态筛选：无手机号', db.listLeads({ sync: 'no_phone' }).items.every((row) => !row.phoneDigits))
check(
  '四个状态加起来等于全部',
  db.listLeads({ sync: 'synced' }).total + db.listLeads({ sync: 'unsynced' }).total + db.listLeads({ sync: 'failed' }).total + db.listLeads({ sync: 'no_phone' }).total === syncCounts.all,
  syncCounts,
)

check('库文件大小可读', db.fileInfo().bytes > 0, db.fileInfo())
db.close()
check('关闭后文件仍在', fs.existsSync(file))

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)

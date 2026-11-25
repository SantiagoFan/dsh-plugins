/**
 * 定时计算测试：每日固定时刻、时区换算、启动补采的时间点。
 * 不联网、不装依赖：node test/time.mjs
 */
import { dateKeyInZone, formatInZone, lastDueAt, nextRunAt, parseClock, zonedWallToInstant } from '../lib/time.js'

let failed = 0
const check = (label, condition, detail) => {
  if (condition) console.log(`ok - ${label}`)
  else {
    failed += 1
    console.log(`FAIL - ${label}${detail === undefined ? '' : ` :: ${detail}`}`)
  }
}
const iso = (date) => (date instanceof Date ? date.toISOString() : String(date))

const schedule = { time: '07:30', timeZone: 'Asia/Shanghai', enabled: true }

// 2026-11-19 10:20 +08:00 → 02:20Z（07:30 已经过了）
const nowMorning = new Date('2026-11-19T02:20:00.000Z')
check('北京时间 10:20 的下一次是明天 07:30', iso(nextRunAt(schedule, nowMorning)) === '2026-11-19T23:30:00.000Z', iso(nextRunAt(schedule, nowMorning)))

const nowBeforeClock = new Date('2026-11-18T22:00:00.000Z') // 11-19 06:00 +08:00
check('早上 6 点的下一次是当天 07:30', iso(nextRunAt(schedule, nowBeforeClock)) === '2026-11-18T23:30:00.000Z', iso(nextRunAt(schedule, nowBeforeClock)))

const nowAfterClock = new Date('2026-11-19T04:00:00.000Z') // 11-19 12:00 +08:00
check('中午 12 点的下一次是明天 07:30', iso(nextRunAt(schedule, nowAfterClock)) === '2026-11-19T23:30:00.000Z', iso(nextRunAt(schedule, nowAfterClock)))

check('最近一次到点是今天 07:30', iso(lastDueAt(schedule, nowAfterClock)) === '2026-11-18T23:30:00.000Z', iso(lastDueAt(schedule, nowAfterClock)))
check('早上 6 点前最近一次是昨天 07:30', iso(lastDueAt(schedule, nowBeforeClock)) === '2026-11-17T23:30:00.000Z', iso(lastDueAt(schedule, nowBeforeClock)))

check('UTC 时区下 07:30 = 07:30Z', iso(nextRunAt({ time: '07:30', timeZone: 'UTC' }, new Date('2026-11-19T00:00:00.000Z'))) === '2026-11-19T07:30:00.000Z')

// 非法输入
check('非法时间返回 null', nextRunAt({ time: '25:99', timeZone: 'Asia/Shanghai' }, nowMorning) === null)
check('parseClock 接受 7:05', JSON.stringify(parseClock('7:05')) === '{"hour":7,"minute":5}')
check('parseClock 拒绝空值', parseClock('') === null)

// 时区边界：纽约夏令时切换当天不抛错，且落在合理的绝对时刻
const nyNext = nextRunAt({ time: '07:30', timeZone: 'America/New_York' }, new Date('2026-03-07T12:00:00.000Z'))
check('纽约夏令时切换日可计算', nyNext instanceof Date && !Number.isNaN(nyNext.getTime()), iso(nyNext))
check('纽约 3-07 的 07:30 是 12:30Z（EST）', iso(nyNext) === '2026-03-07T12:30:00.000Z', iso(nyNext))

// 日期归档按配置时区
const lateNightUtc = new Date('2026-11-19T17:00:00.000Z') // 北京时间 11-20 01:00
check('dateKeyInZone 用指定时区', dateKeyInZone(lateNightUtc, 'Asia/Shanghai') === '2026-11-20', dateKeyInZone(lateNightUtc, 'Asia/Shanghai'))
check('dateKeyInZone 用 UTC', dateKeyInZone(lateNightUtc, 'UTC') === '2026-11-19')
check('formatInZone 输出 HH:mm', formatInZone(new Date('2026-11-18T23:30:00.000Z'), 'Asia/Shanghai') === '2026-11-19 07:30')

// 墙上时间换算：不存在的 02:30（纽约 3-08）也不能崩
const missing = zonedWallToInstant({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, 'America/New_York')
check('不存在的墙上时间有兜底', missing instanceof Date && !Number.isNaN(missing.getTime()), iso(missing))

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)

/**
 * 时区与定时计算。
 *
 * 只依赖 Intl，不引入第三方库：
 *  - partsInZone / zonedWallToInstant：在指定时区里读写「墙上时间」；
 *  - nextRunAt / lastDueAt：每日固定时刻的下一次 / 最近一次触发点；
 *  - dateKeyInZone / formatInZone：结果数据按日归档与展示用的日期字符串。
 */

export const DEFAULT_TIME_ZONE = 'Asia/Shanghai'

/** 时钟字符串（HH:mm）解析；非法返回 null。 */
export function parseClock(value) {
  const text = String(value === null || value === undefined ? '' : value).trim()
  const match = /^(\d{1,2}):(\d{2})$/.exec(text)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return { hour, minute }
}

/** 合法时区名返回 true（Intl 认识它），否则 false。 */
export function isValidTimeZone(timeZone) {
  const text = String(timeZone || '').trim()
  if (!text) return false
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: text }).format(new Date())
    return true
  } catch {
    return false
  }
}

/** 指定时区里的年月日时分秒。 */
export function partsInZone(date, timeZone) {
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const out = { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 }
  for (const part of formatter.formatToParts(date)) {
    const key = part.type
    if (key === 'year' || key === 'month' || key === 'day' || key === 'hour' || key === 'minute' || key === 'second') {
      out[key] = Number(part.value)
    }
  }
  if (out.hour === 24) out.hour = 0
  return out
}

/** 某时刻在指定时区的偏移（毫秒，东为正）。 */
function offsetMs(date, timeZone) {
  const parts = partsInZone(date, timeZone)
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return asUtc - Math.floor(date.getTime() / 1000) * 1000
}

/**
 * 把「某时区的墙上时间」换算成绝对时刻。
 * 传入的 day 允许越界（例如 32 号），Date.UTC 会自然进位。
 */
export function zonedWallToInstant(wall, timeZone) {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour || 0, wall.minute || 0, 0)
  const first = naive - offsetMs(new Date(naive), timeZone)
  const second = naive - offsetMs(new Date(first), timeZone)
  return new Date(second === first ? first : second)
}

/** 该时刻落在指定时区的哪一天（YYYY-MM-DD），结果数据按这个分组。 */
export function dateKeyInZone(date, timeZone) {
  const parts = partsInZone(date, timeZone)
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

/** 展示用：YYYY-MM-DD HH:mm（指定时区）。 */
export function formatInZone(date, timeZone) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return ''
  const parts = partsInZone(date, timeZone)
  return `${dateKeyInZone(date, timeZone)} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`
}

/** 每日固定时刻的下一次触发点；配置不合法返回 null。 */
export function nextRunAt(schedule, from = new Date()) {
  const clock = parseClock(schedule && schedule.time)
  if (!clock) return null
  const timeZone = isValidTimeZone(schedule && schedule.timeZone) ? schedule.timeZone : DEFAULT_TIME_ZONE
  const now = from instanceof Date ? from : new Date(from)
  const today = partsInZone(now, timeZone)
  const wall = { year: today.year, month: today.month, day: today.day, hour: clock.hour, minute: clock.minute }
  const candidate = zonedWallToInstant(wall, timeZone)
  if (candidate.getTime() - now.getTime() > 1000) return candidate
  return zonedWallToInstant({ ...wall, day: wall.day + 1 }, timeZone)
}

/** 最近一次已经到点的触发时刻（用于启动补采）。 */
export function lastDueAt(schedule, from = new Date()) {
  const clock = parseClock(schedule && schedule.time)
  if (!clock) return null
  const timeZone = isValidTimeZone(schedule && schedule.timeZone) ? schedule.timeZone : DEFAULT_TIME_ZONE
  const now = from instanceof Date ? from : new Date(from)
  const today = partsInZone(now, timeZone)
  const wall = { year: today.year, month: today.month, day: today.day, hour: clock.hour, minute: clock.minute }
  const candidate = zonedWallToInstant(wall, timeZone)
  if (candidate.getTime() <= now.getTime()) return candidate
  return zonedWallToInstant({ ...wall, day: wall.day - 1 }, timeZone)
}

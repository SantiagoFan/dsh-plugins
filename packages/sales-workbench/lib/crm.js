/**
 * 线索写入 Cordys CRM 的适配层。
 *
 * 规则（用户 2026-11-23 定）：
 *  - 只写「线索」，不写客户；写完移入指定线索池。
 *  - 只允许手机号非空的线索。
 *  - 写入前做两次查重：手机号查一次、公司名称查一次；任一命中即拒绝。
 *  - 写入字段：公司名称、联系人名称、联系人电话、地区、备注（来源信息 + 来源 URL）。
 *
 * Cordys 线索表单（实测）：name / contact / phone 是基础字段；
 * 备注 fieldId=179323998745600000，地区 fieldId=494089249570693208（值形如 "1522-"），
 * 线索来源 fieldId=494089249570693201（8=其他）。意向产品非必填（products 可传空数组）。
 */

/** 内蒙古 12 盟市 → 地区编码前缀（CRM 地区字段形如 "1522-"）。 */
const REGION_CODES = [
  ['呼和浩特', '1501'],
  ['包头', '1502'],
  ['乌海', '1503'],
  ['赤峰', '1504'],
  ['通辽', '1505'],
  ['鄂尔多斯', '1506'],
  ['呼伦贝尔', '1507'],
  ['巴彦淖尔', '1508'],
  ['乌兰察布', '1509'],
  ['兴安盟', '1522'],
  ['锡林郭勒', '1525'],
  ['阿拉善', '1529'],
]

export const LEAD_FIELD_IDS = {
  region: '494089249570693208',
  note: '179323998745600000',
  source: '494089249570693201',
}

export const SOURCE_VALUE_OTHER = '8'

/** 从地区文本里推断 CRM 地区编码；识别不出来返回 ''。 */
export function regionCodeFor(region) {
  const text = String(region || '')
  if (!text) return ''
  for (const [name, code] of REGION_CODES) {
    if (text.includes(name)) return `${code}-`
  }
  return ''
}

/** 备注：来源信息 + 来源 URL 拼接。 */
export function noteFor(lead) {
  const parts = []
  const source = [lead.sourceName, lead.topicName].filter(Boolean).join(' · ')
  if (source) parts.push(`来源：${source}`)
  if (lead.fetchedAt) parts.push(`采集：${String(lead.fetchedAt).replace('T', ' ').slice(0, 16)}`)
  if (lead.region) parts.push(`地区：${lead.region}`)
  if (lead.sourceUrl) parts.push(lead.sourceUrl)
  return parts.join('｜')
}

/** 组装 /lead/add 的请求体。 */
export function leadPayload(lead, options = {}) {
  const fields = []
  const regionCode = regionCodeFor(lead.region)
  if (regionCode) fields.push({ fieldId: LEAD_FIELD_IDS.region, fieldValue: regionCode })
  const note = noteFor(lead)
  if (note) fields.push({ fieldId: LEAD_FIELD_IDS.note, fieldValue: note })
  fields.push({ fieldId: LEAD_FIELD_IDS.source, fieldValue: SOURCE_VALUE_OTHER })
  const payload = {
    name: String(lead.company || lead.title || '').trim(),
    contact: String(lead.contact || '').trim(),
    phone: String(lead.phoneDigits || lead.phone || '').replace(/\D/g, ''),
    products: Array.isArray(options.products) ? options.products : [],
    moduleFields: fields,
  }
  if (options.owner) payload.owner = options.owner
  return payload
}

/** 查重用的两个关键词：手机号（纯数字）、公司名称。 */
export function dedupeKeys(lead) {
  const phone = String(lead.phoneDigits || lead.phone || '').replace(/\D/g, '')
  const name = String(lead.company || '').trim()
  return { phone, name }
}

/**
 * 数据采集器：把抓到的公告/页面识别成「意向客户」线索。
 *
 * 线索字段（面板与导出都用这一套）：
 *   公司名称 company｜联系人 contact｜联系电话 phone｜地区 region｜备注 note
 * 另外保留 title（原文标题）与 sourceUrl（网址来源）。
 *
 * 识别顺序：先看列表页标题与摘要，缺关键字段（电话/联系人/公司）时再由调用方
 * 抓一次详情页正文，两段文本合并取更可信的字段（标注来源标记 companyLabeled）。
 *
 * 全部是启发式规则：中文公告的写法五花八门，识别结果可能不准，需要人工核对。
 */

const PROVINCES = [
  '北京',
  '天津',
  '上海',
  '重庆',
  '河北',
  '山西',
  '辽宁',
  '吉林',
  '黑龙江',
  '江苏',
  '浙江',
  '安徽',
  '福建',
  '江西',
  '山东',
  '河南',
  '湖北',
  '湖南',
  '广东',
  '海南',
  '四川',
  '贵州',
  '云南',
  '陕西',
  '甘肃',
  '青海',
  '台湾',
  '内蒙古',
  '广西',
  '西藏',
  '宁夏',
  '新疆',
  '香港',
  '澳门',
]

/** 去掉不可见字符、全角空格，合并空白。 */
export function cleanText(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\u3000/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

/** 电话归一成纯数字（便于去重与拨号）；识别不出有效号码返回 ''。 */
export function normalizePhone(value) {
  const digits = String(value || '').replace(/[^\d]/g, '')
  if (!digits) return ''
  if (/^1[3-9]\d{9}$/.test(digits)) return digits
  if (/^[48]00\d{7}$/.test(digits)) return digits
  // 座机要校验区号：010 / 020-029（三位区号，026 未分配），03x-09x 是四位区号
  if (/^0(?:10|2[0-5]|2[7-9])\d{7,8}$/.test(digits)) return digits
  if (/^0[3-9]\d{2}\d{7,8}$/.test(digits)) return digits
  return ''
}

/** 可读的电话写法：手机 3-4-4，座机按区号位数分隔。 */
const THREE_DIGIT_AREA = new Set(['010', '020', '021', '022', '023', '024', '025', '027', '028', '029'])

export function prettyPhone(value) {
  const digits = normalizePhone(value)
  if (!digits) return String(value || '').trim()
  if (/^1[3-9]\d{9}$/.test(digits)) return `${digits.slice(0, 3)} ${digits.slice(3, 7)} ${digits.slice(7)}`
  if (/^[48]00\d{7}$/.test(digits)) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
  // 座机：010/02x 是三位区号，其余按四位；长度 11 时用区号表判断，10 位按三位
  let area = 4
  if (digits.length === 11) area = THREE_DIGIT_AREA.has(digits.slice(0, 3)) ? 3 : 4
  else if (digits.length === 10) area = 3
  return `${digits.slice(0, area)}-${digits.slice(area)}`
}

const PHONE_PATTERNS = [
  // 手机号（允许 +86 / 86- 前缀与空格分隔）
  /(?:\+?86[-\s]?)?(1[3-9]\d{9})/g,
  // 400 / 800 热线
  /([48]00[-\s]?\d{3}[-\s]?\d{4})/g,
  // 带区号的座机：010-88886666 / 0471-1234567 / (0471)8888666
  /(\(?0\d{2,3}\)?[-\s]?\d{7,8})/g,
]

const PHONE_HINTS = /(电话|联系方式|手机|致电|咨询|热线|传真)/
/** 网站自身的服务热线/投诉举报电话不是客户联系方式。 */
const PHONE_BAD_CONTEXT = /(服务热线|客服热线|客服电话|投诉|举报|技术支持|违法和不良|网站地图|主办单位|天眼查|企查查|爱企查|工商信息)/
/** 平台客服号（天眼查 400-608-0000）这种固定误识别，直接排除。 */
const PHONE_BLOCKLIST = new Set(['4006080000', '4006668985', '4006080000'])

/** 从文本里取一个最可能的电话；优先靠近「电话/联系方式」字样的号码。 */
export function findPhone(text) {
  const source = cleanText(text)
  if (!source) return ''
  const normalizedSource = source.replace(/\s{2,}/g, ' ')
  const candidates = []
  for (const pattern of PHONE_PATTERNS) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(normalizedSource)) !== null) {
      const raw = match[1] || match[0]
      const digits = normalizePhone(raw)
      if (!digits || PHONE_BLOCKLIST.has(digits)) continue
      const start = Math.max(0, match.index - 24)
      const nearby = normalizedSource.slice(start, match.index + raw.length + 8)
      if (PHONE_BAD_CONTEXT.test(nearby)) continue
      candidates.push({ digits, raw, hinted: PHONE_HINTS.test(nearby) })
    }
  }
  if (candidates.length === 0) return ''
  // 带「电话」提示的优先；同为提示时，手机号优先于座机（更容易直接联系到人）。
  const hinted = candidates.filter((item) => item.hinted)
  const pool = hinted.length > 0 ? hinted : candidates
  const mobile = pool.find((item) => /^1[3-9]\d{9}$/.test(item.digits))
  if (mobile) return mobile.raw.trim()
  return pool[0].raw.trim()
}

const CONTACT_PATTERNS = [
  /(?:项目|报名|采购)?联系人(?:姓名)?\s*[:：]\s*([\u4e00-\u9fa5·]{2,6}(?:先生|女士|经理|老师|工)?)/,
  /(?:项目|报名|采购)?联系人\s+([\u4e00-\u9fa5·]{2,4})(?=\s|，|,|。|；|;|电话|$)/,
  /(?:负责人|经办人|联系人)\s*[:：]\s*([\u4e00-\u9fa5·]{2,6}(?:先生|女士|经理|老师|工)?)/,
]

/** 联系人姓名（2-6 个汉字，可带先生/女士/工等后缀）。 */
export function findContact(text) {
  const source = cleanText(text)
  if (!source) return ''
  for (const pattern of CONTACT_PATTERNS) {
    const match = pattern.exec(source)
    if (!match) continue
    const name = cleanText(match[1])
    // 「联系电话」「联系地址」这类不是人名
    if (!name || /(电话|地址|方式|单位|部门|邮箱|传真|时间|地点)/.test(name)) continue
    return name
  }
  return ''
}

const COMPANY_LABEL =
  /(?:采购人|采购单位|招标人|招标单位|建设单位|采购方|需求单位|业主单位|业主|项目单位|使用单位|承租方|发包人|采购代理机构|代理机构|委托单位)\s*[:：]\s*([^\n，,。；;、]{4,50})/

/**
 * 中标/成交公告里的「供应商」才是提供演练服务的公司——对做演练系统的我们来说
 * 这是主要客户，所以发现供应商标注时优先于采购人。
 */
const SUPPLIER_LABEL =
  /(?:中标供应商|成交供应商|中标（成交）供应商|中标\(成交\)供应商|供应商名称|中标人|成交人|中标单位|成交单位|中标供应商名称)\s*[:：]\s*([^\n，,。；;、]{4,50})/

const COMPANY_SUFFIX =
  /([\u4e00-\u9fa5A-Za-z0-9（）()·]{2,30}?(?:有限责任公司|股份有限公司|有限公司|集团公司|集团|公司|医院|妇幼保健院|学校|小学|中学|大学|学院|研究院|研究所|事务所|银行|酒店|物业公司|管理处|管理局|管理委员会|委员会|服务中心|集团股份|厅|局))/

function cleanCompany(value) {
  let text = cleanText(value)
  text = text.replace(/^(?:关于|对于|致|对)/, '').replace(/[（(]\s*$/g, '')
  text = text.replace(/^[：:，,、\s]+/, '').replace(/[，,。；;、\s]+$/, '')
  // 公司名后面常紧跟「地址：/联系人：」，一起截掉
  text = text.split(/(?:地址|联系人|电话|手机|传真|邮箱|邮编|联系地址|项目地点)/)[0]
  // 再截断到第一个明显的分隔（例如「XX公司 XX部门」）
  text = text.split(/[\s，,。；;]/)[0]
  // 表格里的报价/数量常粘在公司名后面（「XX有限公司1.2」），去掉尾部数字
  text = text.replace(/[\d０-９.．%％]+\s*$/, '')
  if (text.length > 40) text = text.slice(0, 40)
  return text
}

function companyUsable(company) {
  return company.length >= 4 && company.length <= 40 && !COMPANY_REJECT.test(company) && !COMPANY_REJECT_PREFIX.test(company)
}

/** 「A 联合 B」「关于…开展…」这类不是公司名，宁可不填也不要填错。 */
const COMPANY_REJECT = /(联合|关于|开展|组织|进行|举行|参加|部署|推动|要求|通知|公告|采购项目|招标项目|相关财产保险|招标代理|代理公司|党群服务)/
const COMPANY_REJECT_PREFIX = /^(?:为|关于|通过|进一步|深入|切实|认真|积极|全面|严格|持续|努力|不断|各|有关|相关|其他|上述|该|本|贵)/

/** 「内蒙古电力（集团」这种被截断的名字，后面紧跟「）有限责任公司」时补全。 */
const COMPANY_EXTEND = /^[）)]?\s*(?:有限责任公司|股份有限公司|有限公司|集团公司|分公司|公司)/

/**
 * 公司名称：优先「中标供应商/成交供应商」（服务商=主要客户），
 * 其次「采购人/招标人」这类标注，最后标题里的公司全称。
 * role 用来区分线索性质：supplier（中标服务商）/ buyer（采购方）/ ''（未识别）。
 */
export function findCompany(text) {
  const source = cleanText(text)
  if (!source) return { company: '', labeled: false, role: '' }
  const supplier = SUPPLIER_LABEL.exec(source)
  if (supplier) {
    const company = cleanCompany(supplier[1])
    if (companyUsable(company)) return { company, labeled: true, role: 'supplier' }
  }
  const labeled = COMPANY_LABEL.exec(source)
  if (labeled) {
    const company = cleanCompany(labeled[1])
    if (companyUsable(company)) return { company, labeled: true, role: 'buyer' }
  }
  const suffix = COMPANY_SUFFIX.exec(source)
  if (suffix) {
    let raw = suffix[1]
    const rest = source.slice(suffix.index + raw.length)
    const extend = COMPANY_EXTEND.exec(rest)
    if (extend) raw += extend[0]
    const company = cleanCompany(raw)
    if (companyUsable(company) && company.length <= 30) return { company, labeled: false, role: '' }
  }
  return { company: '', labeled: false, role: '' }
}

const REGION_LABEL = /(?:项目地点|服务地点|工程地点|交货地点|实施地点|所在地|地址|地区|地点|实施地)\s*[:：]\s*([^\n，,。；;]{2,20})/

/** 去掉「服务地点为 / 位于 / 地址：」这类前缀，只留地名本身。 */
function stripPlacePrefix(value) {
  return cleanText(value)
    .replace(/^\d{4}\s*年\s*/, '')
    .replace(/^(?:位于|坐落于|地处|在|地址为)/, '')
    .replace(/^(?:服务|项目|工程|交货|实施|建设|采购)?(?:地点|地址|所在地|实施地)(?:为|是|在)?\s*[:：]?\s*/, '')
    .replace(/^(?:位于|在|为|是)\s*/, '')
    .trim()
}

const PLACE_SUFFIX = /(?:省|市|区|县|旗|盟|自治州|地区|自治区)$/
const REGION_REJECT_PREFIX = /^(?:近日|日前|今日|昨日|本次|目前|今年|全年|全市|全区|全县|本|该|我|贵|各)/

/** 只接受看起来像地名的值：带省/市/区/县等后缀、且不含编号或邮箱。 */
function cleanRegion(value) {
  let text = stripPlacePrefix(value)
  text = text.replace(/^[“”"'‘’「」\s:：]+/, '')
  text = text.replace(/[“”"'‘’「」、，,。；;\s].*$/, '')
  text = text.replace(/[（(].*?[）)]/g, '')
  if (!text || text.length > 20) return ''
  if (/[0-9A-Za-z]/.test(text)) return ''
  if (REGION_REJECT_PREFIX.test(text)) return ''
  if (!PLACE_SUFFIX.test(text) && !PROVINCES.some((province) => text.startsWith(province))) return ''
  return text
}

/** 地区：优先「项目地点/地址：」标注，其次省份，再其次「XX市（XX区）」；都取不到用渠道默认地区。 */
export function findRegion(text) {
  const source = cleanText(text)
  if (!source) return ''
  const labeled = REGION_LABEL.exec(source)
  if (labeled) {
    const value = cleanRegion(labeled[1])
    if (value) return value
  }
  for (const province of PROVINCES) {
    if (!source.includes(province)) continue
    const match = new RegExp(`(${province}省?[\\u4e00-\\u9fa5]{2,6}?(?:市|自治州|地区|盟))(?!场)([\\u4e00-\\u9fa5]{2,6}?(?:区|县|旗))?`).exec(source)
    if (match) {
      const value = cleanRegion(`${match[1]}${match[2] || ''}`)
      if (value) return value
    }
    return province
  }
  // 「XX市场」不是地名；城市名控制在 2-6 字
  const city = /([\u4e00-\u9fa5]{2,6}?(?:市|自治州|地区|盟))(?!场)([\u4e00-\u9fa5]{2,6}?(?:区|县|旗))?/.exec(stripPlacePrefix(source))
  if (city) {
    const value = cleanRegion(`${city[1]}${city[2] || ''}`)
    if (value) return value
  }
  return ''
}

/** 备注：取一段与联系方式相关的原文，方便人工核对。 */
export function findNote(text) {
  const source = cleanText(text).replace(/\n+/g, ' ')
  if (!source) return ''
  const around = /.{0,24}(?:联系人|电话|联系方式).{0,40}/.exec(source)
  const value = around ? around[0] : source
  return value.replace(/\s+/g, ' ').slice(0, 120)
}

// 页脚/导航里的电话（技术支持、主办单位…）不是客户联系方式，识别前先裁掉正文之后的部分。
// 只用强特征词：正文里偶尔出现「联系我们」不算页脚，避免误裁。
const FOOTER_STRONG = /(主办单位\s*[:：]|网站标识码|版权所有|网站地图|ICP备|ICP证|京公网安备|技术支持电话|举报电话|违法和不良信息)/

export function trimFooter(text) {
  const source = cleanText(text)
  if (!source) return ''
  const match = FOOTER_STRONG.exec(source)
  if (match && match.index > 20) return source.slice(0, match.index).trim()
  return source
}

// 地区范围过滤用的城市别名：内蒙古按 12 盟市 + 主要旗县列，其他省份先用省名。
export const PROVINCE_CITIES = {
  内蒙古: [
    '内蒙古',
    '呼和浩特',
    '包头',
    '乌海',
    '赤峰',
    '通辽',
    '鄂尔多斯',
    '呼伦贝尔',
    '巴彦淖尔',
    '乌兰察布',
    '兴安盟',
    '兴安',
    '锡林郭勒',
    '阿拉善',
    '满洲里',
    '二连浩特',
    '准格尔',
    '达拉特',
    '伊金霍洛',
    '土默特',
    '托克托',
    '和林格尔',
    '清水河',
    '武川',
    '固阳',
    '达尔罕',
    '白云鄂博',
    '五原',
    '磴口',
    '杭锦后旗',
    '乌拉特',
    '察哈尔',
    '四子王旗',
    '卓资',
    '凉城',
    '兴和',
    '商都',
    '化德',
    '丰镇',
    '宁城',
    '林西',
    '克什克腾',
    '翁牛特',
    '喀喇沁',
    '敖汉',
    '巴林',
    '阿鲁科尔沁',
    '库伦',
    '奈曼',
    '扎鲁特',
    '科尔沁',
    '霍林郭勒',
    '开鲁',
    '牙克石',
    '扎兰屯',
    '额尔古纳',
    '根河',
    '阿荣旗',
    '莫力达瓦',
    '鄂伦春',
    '鄂温克',
    '陈巴尔虎',
    '新巴尔虎',
    '阿尔山',
    '突泉',
    '扎赉特',
    '多伦',
    '正蓝旗',
    '正镶白旗',
    '镶黄旗',
    '太仆寺',
    '苏尼特',
    '阿巴嘎',
    '东乌珠穆沁',
    '西乌珠穆沁',
    '乌拉盖',
    '额济纳',
    '阿拉善右旗',
    '阿拉善左旗',
  ],
}

/** 把「地区范围」展开成可匹配的关键词：省份 + 该省城市别名。 */
export function expandRegions(regions) {
  const list = Array.isArray(regions) ? regions : []
  const keywords = new Set()
  for (const raw of list) {
    const name = cleanText(raw)
    if (!name) continue
    // 「呼和浩特市」→「呼和浩特」，「锡林郭勒盟」→「锡林郭勒」，页面里只写城市名也能命中
    keywords.add(name.replace(/(?:特别行政区|自治区|省|市|盟|地区|自治州|区|县)$/, ''))
    keywords.add(name)
    for (const [province, cities] of Object.entries(PROVINCE_CITIES)) {
      if (name === province || name.startsWith(province) || province.startsWith(name)) {
        for (const city of cities) keywords.add(city)
      }
    }
  }
  return [...keywords].filter(Boolean)
}

/** 一条线索的地区是否在范围内；地区为空时按 keepUnknown 决定。 */
export function regionInScope(region, keywords, keepUnknown = true) {
  const list = Array.isArray(keywords) ? keywords : []
  if (list.length === 0) return true
  const text = cleanText(region)
  if (!text) return Boolean(keepUnknown)
  return list.some((keyword) => text.includes(keyword))
}

/**
 * 地区范围的综合判断（返回 'keep' | 'drop'）。
 *  mode:
 *   - 'smart'（默认）：地区识别不出来时，看公司/标题/备注里有没有范围内城市，有才留
 *   - 'keep'：地区识别不出来时一律保留（更全，可能混入外地）
 *   - 'drop'：地区识别不出来时一律丢弃（最严）
 */
export function scopeDecision(lead, keywords, mode = 'smart') {
  const list = Array.isArray(keywords) ? keywords : []
  if (list.length === 0) return 'keep'
  const region = cleanText(lead && lead.region)
  if (region) return list.some((keyword) => region.includes(keyword)) ? 'keep' : 'drop'
  if (mode === 'keep') return 'keep'
  if (mode === 'drop') return 'drop'
  // smart：从公司名/标题/备注里找地区线索
  const text = `${cleanText(lead && lead.company)} ${cleanText(lead && lead.title)} ${cleanText(lead && lead.note)}`
  return list.some((keyword) => text.includes(keyword)) ? 'keep' : 'drop'
}

/** 地区列表归一化：支持数组或「顿号/逗号/换行分隔」，去重去空。 */
export function normalizeRegions(value) {
  const list = Array.isArray(value) ? value : cleanText(value).split(/[\n、，,;；]+/)
  const out = []
  for (const item of list) {
    const name = cleanText(item)
    if (name && !out.includes(name)) out.push(name)
  }
  return out.slice(0, 20)
}

/**
 * 从一段文本里识别线索字段。
 * role：supplier 表示这条是中标服务商（做演练服务的公司，我们的主要客户），
 *       buyer 表示采购方，'' 表示没识别出来。
 * @returns {{ company: string, companyLabeled: boolean, role: string, contact: string, phone: string, region: string, note: string }}
 */
export function extractLead(input = {}) {
  const title = cleanText(input.title)
  const summary = cleanText(input.summary)
  const detail = trimFooter(input.detail)
  const body = [title, summary, detail].filter(Boolean).join('\n')
  const companyFromTitle = findCompany(title)
  const companyFromBody = findCompany(body)
  // 中标供应商（服务商）优先：即使标题里先出现了采购方，也要让服务商当线索主体
  const supplier = companyFromBody.role === 'supplier' ? companyFromBody : companyFromTitle.role === 'supplier' ? companyFromTitle : null
  const company = supplier ? supplier.company : companyFromTitle.company || companyFromBody.company
  const role = supplier ? 'supplier' : companyFromBody.role || companyFromTitle.role || ''
  const note = findNote(detail || summary || title)
  return {
    company,
    companyLabeled: Boolean(supplier || companyFromTitle.labeled || companyFromBody.labeled),
    role,
    contact: findContact(body),
    phone: findPhone(body),
    region: findRegion(body) || cleanText(input.defaultRegion),
    // 中标服务商在备注里点明角色，方便在「线索」表里一眼看出这类客户
    note: role === 'supplier' ? `中标服务商${note ? ` · ${note}` : ''}` : note,
  }
}

/**
 * 合并「列表页识别结果」与「详情页识别结果」。
 * 公司名优先取标注来源（供应商/采购人 …），因为标题里的公司常常是无关的第三方。
 */
export function mergeLeads(listLead, detailLead) {
  const list = listLead || {}
  const detail = detailLead || {}
  const preferDetail = detail.companyLabeled || detail.role === 'supplier'
  const company = preferDetail ? detail.company : list.company || detail.company
  return {
    company: company || '',
    companyLabeled: Boolean(detail.companyLabeled || list.companyLabeled),
    role: detail.role || list.role || '',
    contact: detail.contact || list.contact || '',
    phone: detail.phone || list.phone || '',
    region: detail.region || list.region || '',
    note: detail.note || list.note || '',
  }
}

/** 线索去重键：有电话按电话，没电话按公司，再没有按网址。 */
export function leadKeyOf(lead) {
  const phone = normalizePhone(lead && lead.phone)
  if (phone) return `p:${phone}`
  const company = cleanText(lead && lead.company).toLowerCase()
  if (company) return `c:${company}`
  const url = String((lead && (lead.sourceUrl || lead.url)) || '').trim()
  return url ? `u:${url}` : ''
}

/** 这条线索是否还缺关键信息（缺就值得再抓一次详情页）。 */
export function isIncomplete(lead) {
  return !lead || !lead.phone || !lead.company || !lead.contact
}

/**
 * 线索识别测试：从中文公告文本里抽取 公司名称 / 联系人 / 联系电话 / 地区。
 * 不联网：node test/leads.mjs
 */
import {
  expandRegions,
  extractLead,
  findCompany,
  findContact,
  findPhone,
  findRegion,
  isIncomplete,
  leadKeyOf,
  mergeLeads,
  normalizePhone,
  normalizeRegions,
  prettyPhone,
  regionInScope,
  scopeDecision,
} from '../lib/leads.js'

let failed = 0
const check = (label, condition, detail) => {
  if (condition) console.log(`ok - ${label}`)
  else {
    failed += 1
    console.log(`FAIL - ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`)
  }
}

// ------------------------------------------------------------------ 电话
check('识别手机号并归一', normalizePhone('138 0013 8000') === '13800138000')
check('识别带区号座机', normalizePhone('0471-6688999') === '04716688999')
check('识别括号区号座机', normalizePhone('(010)88886666') === '01088886666')
check('识别 400 热线', normalizePhone('400-123-4567') === '4001234567')
check('打码号码不算有效电话', normalizePhone('138****8000') === '')
check('8 位数字不是电话', normalizePhone('12345678') === '')
check('区号 012 不是有效座机', normalizePhone('012-0170001') === '', normalizePhone('012-0170001'))
check('区号 026 未分配', normalizePhone('0260-6260024') === '', normalizePhone('0260-6260024'))
check('4 位区号 + 8 位也能识别', normalizePhone('0755-88888888') === '075588888888', normalizePhone('0755-88888888'))
check('手机号美化分组', prettyPhone('13800138000') === '138 0013 8000')
check('座机美化保留区号', prettyPhone('04716688999') === '0471-6688999')
check('三位区号按 3+8 分组', prettyPhone('01064463685') === '010-64463685', prettyPhone('01064463685'))

// 页脚里的「技术支持电话」不算客户联系方式
const footerPage = `关于印发应急演练预案的通知
正文内容：本项目要求各单位每年组织一次演练。
相关链接 网站地图 | 联系我们 网站技术支持电话: 010-64463685 主办单位：应急管理部 网站标识码bm34000001`
const footerLead = extractLead({ title: '关于印发应急演练预案的通知', detail: footerPage })
check('裁掉页脚后不识别技术支持电话', footerLead.phone === '', footerLead.phone)
check('页脚电话不会混进正文备注', !footerLead.note.includes('技术支持'), footerLead.note)

// 正文里同时出现传真与电话：取带「电话」提示的、手机优先
const phoneText = '传真：010-12345678 联系人：李四 联系电话：0471-6688999 手机：13911112222'
check('优先取手机号', findPhone(phoneText) === '13911112222', findPhone(phoneText))
const landlineOnly = '联系电话：0471-6688999，邮箱 a@b.com'
check('没有手机时取座机', findPhone(landlineOnly) === '0471-6688999', findPhone(landlineOnly))
check('网站服务热线不算客户电话', findPhone('服务热线：400-810-1996 投诉：010-63819289') === '', findPhone('服务热线：400-810-1996 投诉：010-63819289'))
check('举报电话不算客户电话', findPhone('违法和不良信息举报电话：010-88828271') === '', findPhone('违法和不良信息举报电话：010-88828271'))
check('天眼查客服号不算客户电话', findPhone('电话：400-608-0000') === '', findPhone('电话：400-608-0000'))
check('未分配区号 030 不算电话', normalizePhone('030-4286001') === '', normalizePhone('030-4286001'))
check('四位区号座机有效', normalizePhone('0471-6688999') === '04716688999', normalizePhone('0471-6688999'))
check('公司名尾部的报价数字被去掉', findCompany('中标供应商：内蒙古众安工程技术研究有限公司1.2').company === '内蒙古众安工程技术研究有限公司', findCompany('中标供应商：内蒙古众安工程技术研究有限公司1.2').company)

// ---- 中标服务商（演练服务公司 = 主要客户）
const awardText = [
  '内蒙古自治区应急管理厅内蒙古自治区防汛抢险救援综合演练',
  '中标（成交）结果公告',
  '采购人：内蒙古自治区应急管理厅',
  '中标供应商：内蒙古安泰安全技术有限公司',
  '联系人：王工 联系电话：13800138000',
  '地址：呼和浩特市赛罕区',
].join('\n')
const awardLead = extractLead({ title: awardText.split('\n')[0], detail: awardText })
check('中标公告优先取中标供应商', awardLead.company === '内蒙古安泰安全技术有限公司', awardLead.company)
check('中标服务商标记为 supplier', awardLead.role === 'supplier', awardLead.role)
check('中标服务商备注里带角色', awardLead.note.startsWith('中标服务商'), awardLead.note)
const mergeSupplier = mergeLeads({ company: '内蒙古自治区应急管理厅', companyLabeled: true, role: 'buyer' }, awardLead)
check('详情页的供应商覆盖列表页的采购人', mergeSupplier.company === '内蒙古安泰安全技术有限公司', mergeSupplier.company)
check('合并后角色仍是 supplier', mergeSupplier.role === 'supplier', mergeSupplier.role)
const tenderOnly = extractLead({ title: '呼和浩特市机关事务管理局消防维保采购公告', detail: '采购人：呼和浩特市机关事务管理局\n联系人：李四 电话：13911112222' })
check('普通招标公告仍是采购方', tenderOnly.role === 'buyer' && tenderOnly.company === '呼和浩特市机关事务管理局', `${tenderOnly.role} ${tenderOnly.company}`)

// ------------------------------------------------------------------ 联系人
check('识别「联系人：」', findContact('联系人：王工 电话：13800138000') === '王工', findContact('联系人：王工 电话：13800138000'))
check('识别「项目联系人：」', findContact('项目联系人：张小明，联系电话 13800138000') === '张小明', findContact('项目联系人：张小明，联系电话 13800138000'))
check('不把「联系电话」当人名', findContact('联系人：联系电话 13800138000') === '')

// ------------------------------------------------------------------ 公司
const labeled = findCompany('采购人：内蒙古安泰实业有限责任公司 联系人：王工')
check('按「采购人：」取公司', labeled.company === '内蒙古安泰实业有限责任公司' && labeled.labeled === true, labeled)
const fromTitle = findCompany('呼和浩特市蓝海物业服务有限公司关于消防设施维保的采购公告')
check('标题里的公司全称', fromTitle.company === '呼和浩特市蓝海物业服务有限公司', fromTitle.company)
check('「关于」不被算进公司名', !fromTitle.company.startsWith('关于'))
const noCompany = findCompany('关于开展2026年度消防演练的通知')
check('没有公司时不硬凑', noCompany.company === '', noCompany.company)

// ------------------------------------------------------------------ 地区
check('按「项目地点：」取地区', findRegion('项目地点：呼和浩特市新城区') === '呼和浩特市新城区', findRegion('项目地点：呼和浩特市新城区'))
check('从省份推断', findRegion('本项目位于内蒙古自治区包头市昆都仑区') .startsWith('内蒙古'), findRegion('本项目位于内蒙古自治区包头市昆都仑区'))
check('只有市名也能取', findRegion('服务地点为太原市小店区') === '太原市小店区', findRegion('服务地点为太原市小店区'))
check('地址里的信箱编号不当地名', findRegion('地址：北京市东城区 A01302 邮政信箱收') === '北京市东城区', findRegion('地址：北京市东城区 A01302 邮政信箱收'))
check('「近日市」这类不算地区', findRegion('近日市政养护中心组织消防演练') === '', findRegion('近日市政养护中心组织消防演练'))
check('多个地区只取第一个', findRegion('项目地点：内蒙古自治区包头市、河南省南阳市') === '内蒙古自治区包头市', findRegion('项目地点：内蒙古自治区包头市、河南省南阳市'))
const joint = findCompany('自治区应急管理厅联合国家能源集团煤制油公司开展演练')
check('「A 联合 B」只取第一个机构名', joint.company === '自治区应急管理厅' && !joint.company.includes('联合'), joint)
check('纯通知标题不硬凑公司名', findCompany('关于组织开展消防演练的通知').company === '')
check('「有关中央企业集团」这类泛称不算公司', findCompany('有关中央企业集团：').company === '', findCompany('有关中央企业集团：'))
check('「各相关财产保险公司」不算公司', findCompany('各相关财产保险公司：').company === '')
check('公司名后面跟「地址：」时截断', findCompany('鄂尔多斯市应急管理局地址：鄂尔多斯市国泰商务广场CBD办公区T6').company === '鄂尔多斯市应急管理局', findCompany('鄂尔多斯市应急管理局地址：鄂尔多斯市国泰商务广场CBD办公区T6').company)
check('政府机关（局/厅）也算客户', findCompany('湖北省应急管理厅').company === '湖北省应急管理厅', findCompany('湖北省应急管理厅').company)
check('「招标代理公司」不算具体客户', findCompany('招标代理公司：').company === '')
check('「2026年台山市」去掉年份', findRegion('2026年台山市森林防灭火演练') === '台山市', findRegion('2026年台山市森林防灭火演练'))
check(
  '括号里的集团名能补全',
  findCompany('内蒙古电力（集团）有限责任公司乌兰察布供电分公司2026年应急演练技术服务项目').company === '内蒙古电力（集团）有限责任公司',
  findCompany('内蒙古电力（集团）有限责任公司乌兰察布供电分公司2026年应急演练技术服务项目').company,
)
check('「XX市场」不算城市', findRegion('内蒙古产权交易市场') !== '内蒙古产权交易市', findRegion('内蒙古产权交易市场'))

// ------------------------------------------------------------------ 整体
const full = extractLead({
  title: '关于2026年消防演练服务采购项目的公告',
  detail: '采购人：内蒙古安泰实业有限责任公司 联系人：王工 联系电话：0471-6688999 手机：13800138000 项目地点：呼和浩特市新城区',
})
check('整体：公司', full.company === '内蒙古安泰实业有限责任公司', full.company)
check('整体：联系人', full.contact === '王工', full.contact)
check('整体：手机优先', full.phone === '13800138000', full.phone)
check('整体：地区', full.region === '呼和浩特市新城区', full.region)
check('整体：备注含联系信息片段', full.note.includes('联系人'), full.note)
check('整体：不缺字段', isIncomplete(full) === false)

const bare = extractLead({ title: '关于开展2026年度消防演练的通知' })
check('只有标题时缺电话', isIncomplete(bare) === true)
check('只有标题时没有电话', bare.phone === '', bare.phone)

// 详情页的公司标注优先于标题里的公司
const merged = mergeLeads(
  { company: '呼和浩特市蓝海物业服务有限公司', companyLabeled: false, contact: '', phone: '', region: '', note: '' },
  { company: '内蒙古安泰实业有限责任公司', companyLabeled: true, contact: '王工', phone: '13800138000', region: '呼和浩特市新城区', note: '联系人：王工' },
)
check('合并：详情页标注的公司优先', merged.company === '内蒙古安泰实业有限责任公司', merged.company)
check('合并：电话来自详情页', merged.phone === '13800138000')
check('合并：列表页有联系人时也保留', mergeLeads({ contact: '李四' }, {}).contact === '李四')

// ------------------------------------------------------------------ 去重键
check('有电话按电话去重', leadKeyOf({ phone: '13800138000', company: 'A 公司' }) === 'p:13800138000')
check('无电话按公司去重', leadKeyOf({ company: '内蒙古安泰实业有限责任公司' }) === 'c:内蒙古安泰实业有限责任公司')
check('都没用按网址去重', leadKeyOf({ sourceUrl: 'https://example.com/a' }) === 'u:https://example.com/a')

// ------------------------------------------------------------------ 地区范围
const neimenggu = expandRegions(['内蒙古'])
check('内蒙古展开出盟市关键词', neimenggu.includes('呼和浩特') && neimenggu.includes('包头') && neimenggu.includes('锡林郭勒'), neimenggu.slice(0, 8))
check('内蒙古也包含省名本身', neimenggu.includes('内蒙古'))
check('只写城市也能命中', regionInScope('呼和浩特市新城区', neimenggu) === true, '呼和浩特市新城区')
check('盟名也能命中', regionInScope('锡林郭勒盟', neimenggu) === true)
check('范围外的城市被排除', regionInScope('北京市东城区', neimenggu) === false)
check('范围外的省份被排除', regionInScope('湖北省武汉市', neimenggu) === false)
check('地区为空时默认保留', regionInScope('', neimenggu, true) === true)
check('地区为空且严格模式时排除', regionInScope('', neimenggu, false) === false)
check('不限地区时全部保留', regionInScope('北京市', expandRegions([])) === true)
check('地区列表可去重', JSON.stringify(normalizeRegions('内蒙古、内蒙古、呼和浩特')) === '["内蒙古","呼和浩特"]')
check('自治区后缀也能识别', expandRegions(['内蒙古自治区']).includes('鄂尔多斯'))

// 逐个添加城市（用户点「＋呼和浩特市」这种）
const twoCities = expandRegions(['呼和浩特市', '包头市'])
check('添加「呼和浩特市」同时得到城市名', twoCities.includes('呼和浩特'), twoCities)
check('添加「包头市」同时得到城市名', twoCities.includes('包头'))
check('只写城市名也能命中', regionInScope('呼和浩特新城区', twoCities) === true)
check('城市范围外的盟市被排除', regionInScope('锡林郭勒盟', twoCities) === false)
check('多个城市都能命中', regionInScope('包头市昆都仑区', twoCities) === true)
check('盟级输入也能匹配', expandRegions(['锡林郭勒盟']).includes('锡林郭勒'))

// 地区识别不出来时的三种策略
const unknownLead = { company: '郴州华润燃气有限公司', title: '2026年应急演练采购项目公告', note: '', region: '' }
const localLead = { company: '呼和浩特市蓝海物业服务有限公司', title: '消防演练采购公告', note: '', region: '' }
check('smart：公司带外地城市就丢弃', scopeDecision(unknownLead, neimenggu, 'smart') === 'drop')
check('smart：公司带范围内城市就保留', scopeDecision(localLead, neimenggu, 'smart') === 'keep')
check('keep：地区不明一律保留', scopeDecision(unknownLead, neimenggu, 'keep') === 'keep')
check('drop：地区不明一律丢弃', scopeDecision(localLead, neimenggu, 'drop') === 'drop')
check('地区明确时与策略无关', scopeDecision({ company: 'X', title: '', note: '', region: '包头市昆都仑区' }, neimenggu, 'drop') === 'keep')

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)

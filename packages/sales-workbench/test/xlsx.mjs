/**
 * XLSX 生成器测试：ZIP 结构、表头、转义、空单元格、行数。
 * 纯 Node 内置模块（zlib），系统 Node 20 也能跑：node test/xlsx.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leads-xlsx-'))

const { buildXlsx } = await import('../lib/xlsx.js')

let failed = 0
const check = (label, ok, detail) => {
  if (ok) console.log(`ok - ${label}`)
  else {
    failed += 1
    console.log(`FAIL - ${label}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 200)}`}`)
  }
}

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

const buffer = buildXlsx({
  sheetName: '线索',
  columns: [{ header: '公司名称', width: 30 }, { header: '联系电话' }, { header: '备注' }],
  rows: [
    ['内蒙古安泰实业有限责任公司', '138 0013 8000', '含 <xml> & "引号"'],
    ['', '0471-3261784', ''],
  ],
})

check('输出是 ZIP（PK 头）', buffer.subarray(0, 2).toString('latin1') === 'PK', buffer.subarray(0, 8))
check('包含必填部件', ['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/styles.xml'].every((name) => zipEntry(buffer, name)), '')
const sheet = zipEntry(buffer, 'xl/worksheets/sheet1.xml').toString('utf8')
const workbook = zipEntry(buffer, 'xl/workbook.xml').toString('utf8')
check('工作表名正确', workbook.includes('name="线索"'), workbook.slice(0, 200))
check('表头是 inlineStr', sheet.includes('公司名称') && sheet.includes('联系电话'))
check('XML 特殊字符被转义', sheet.includes('&lt;xml&gt;') && sheet.includes('&amp;') && sheet.includes('&quot;'), sheet.slice(0, 400))
check('空单元格不写文本', /<c r="A3" s="0"\/>/.test(sheet) && /<c r="C3" s="0"\/>/.test(sheet), sheet.slice(0, 400))
check('行数正确（表头+2 行）', (sheet.match(/<row r="\d+"/g) || []).length === 3, (sheet.match(/<row r="\d+"/g) || []).length)
check('冻结首行 + 自动筛选', sheet.includes('state="frozen"') && sheet.includes('<autoFilter ref="A1:C3"/>'), sheet.slice(-200))
fs.writeFileSync(path.join(dir, 'ok.xlsx'), buffer)
check('文件可落盘', fs.statSync(path.join(dir, 'ok.xlsx')).size === buffer.length)

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)

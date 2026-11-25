// 推送失败记录：用假的 Cordis ctx + 假 webServer 驱动插件 apply()，验证
//   1) 推送失败（未登录 / 无会话凭证）会写入 push-failures.json；
//   2) 记录里有「哪个智能体（预设名 + 会话标题）、发送内容、发送时间、失败原因」；
//   3) GET /wechat-bot/failures 能读回记录，POST /wechat-bot/failures/clear 能清空；
//   4) 面板手动推送（无 Agent）记为「面板手动推送」。
// 不触碰真实 DSH、不联网。

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-bot-failures-'))
process.env.DSH_WECHAT_BOT_DIR = dataDir

const tools = []
const routes = []

const services = {
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
    getOrigin() {
      return 'http://127.0.0.1:1234'
    },
  },
  agentPresets: {
    async remoteExportList() {
      return {
        presets: [
          { id: 'standard', name: '标准助手', isDefault: true },
          { id: 'strategy-lead', name: '战略企划部负责人' },
        ],
      }
    },
    async list() {
      return [{ id: 'standard' }, { id: 'strategy-lead' }]
    },
  },
  sessionProjections: {
    snapshot() {
      return { values: { title: '每日政策情报' } }
    },
  },
}

function makeCtx() {
  return {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) {
      fn()
      return () => {}
    },
    on() {
      return () => {}
    },
    get(name) {
      return services[name]
    },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
    provide() {
      return () => {}
    },
  }
}

function fakeRes() {
  return {
    code: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(code, headers) {
      this.code = code
      this.headers = headers
    },
    end(body) {
      this.body = body
    },
  }
}

function fakeReq(method, url, payload) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = {}
  req.setEncoding = () => {}
  const body = payload === undefined ? '' : JSON.stringify(payload)
  process.nextTick(() => {
    if (body) req.emit('data', body)
    req.emit('end')
  })
  return req
}

const agentOf = (preset) => ({ id: 'session-a1', session: { header: { agentPreset: preset, cwd: 'E:\\Administrator\\Documents' } } })

test('推送失败自动落盘，面板接口可读、可清空', async (t) => {
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  const plugin = await import('../index.js')
  plugin.apply(makeCtx())

  assert.equal(routes.length, 1, '应注册 /wechat-bot 路由')
  const route = routes[0]
  const send = tools.find((tool) => tool.name === 'wechat_send')
  assert.ok(send, '应注册 wechat_send 工具')

  // 1) 未登录时推送：失败并记录，且记录里带 Agent 归属
  const failed = await send.execute(
    { text: '今天的日报：应急行业 3 条' },
    { agent: agentOf('strategy-lead') },
  )
  assert.equal(failed.ok, false)
  assert.equal(failed.error, 'not_logged_in')

  // 2) 面板接口能读回记录
  const listRes = fakeRes()
  await route.handler({ url: '/wechat-bot/failures', method: 'GET', headers: {} }, listRes)
  assert.equal(listRes.code, 200)
  const listed = JSON.parse(listRes.body)
  assert.equal(listed.ok, true)
  assert.equal(listed.total, 1)
  const first = listed.items[0]
  assert.match(first.agent.label, /战略企划部负责人（strategy-lead）/, '记录应包含预设名与会话标题')
  assert.match(first.agent.label, /每日政策情报/)
  assert.equal(first.agent.presetId, 'strategy-lead')
  assert.equal(first.content, '今天的日报：应急行业 3 条', '应记录发送内容全文')
  assert.equal(first.error, 'not_logged_in')
  assert.equal(first.source, 'tool')
  assert.ok(Number(first.at) > 0, '应记录发送时间')
  assert.equal(first.chars, '今天的日报：应急行业 3 条'.length)

  // 3) 记录已持久化到 push-failures.json
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'push-failures.json'), 'utf8'))
  assert.equal(saved.length, 1)
  assert.equal(saved[0].content, '今天的日报：应急行业 3 条')

  // 4) 面板手动推送（无 Agent）失败也同样记录，来源标 panel
  const panelRes = fakeRes()
  await route.handler(fakeReq('POST', '/wechat-bot/send', { text: '面板测试消息' }), panelRes)
  assert.equal(panelRes.code, 200)
  assert.equal(JSON.parse(panelRes.body).ok, false)

  const listRes2 = fakeRes()
  await route.handler({ url: '/wechat-bot/failures', method: 'GET', headers: {} }, listRes2)
  const afterPanel = JSON.parse(listRes2.body)
  assert.equal(afterPanel.total, 2)
  assert.equal(afterPanel.items[0].source, 'panel')
  assert.equal(afterPanel.items[0].agent.label, '面板手动推送')
  assert.equal(afterPanel.items[0].content, '面板测试消息')

  // 5) 清空记录
  const clearRes = fakeRes()
  await route.handler(fakeReq('POST', '/wechat-bot/failures/clear', {}), clearRes)
  assert.equal(clearRes.code, 200)
  assert.equal(JSON.parse(clearRes.body).total, 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'push-failures.json'), 'utf8')), [])
})

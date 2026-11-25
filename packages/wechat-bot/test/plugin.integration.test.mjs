// 用一个假的 Cordis ctx + 假的 fetch 驱动插件 apply()，验证：
//  1) 旧会话迁移解绑；新会话按 settings 显式传入预设/模型/权限预设；
//  2) 微信入站消息 → DSH 会话 prompt；回合内文本即时回传；
//  3) 静默时回进度、整轮无文本回兜底。
// 不触碰真实 DSH、不联网。

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-bot-test-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---- 假 iLink ---------------------------------------------------------------
const sentMessages = []
const sentTokens = []
const inboundQueue = [
  {
    from_user_id: 'user@im.wechat',
    context_token: 'ctx-token-1',
    message_type: 1,
    item_list: [{ type: 1, text_item: { text: '帮我看一下今天的安排' } }],
  },
]

globalThis.fetch = async (url, init = {}) => {
  const target = String(url)
  if (target.includes('/ilink/bot/getupdates')) {
    const next = inboundQueue.shift()
    if (next) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({ ret: 0, msgs: [next], get_updates_buf: 'cursor-1' })
        },
      }
    }
    await sleep(15)
    return { ok: true, async text() { return JSON.stringify({ ret: 0, msgs: [], get_updates_buf: 'cursor-1' }) } }
  }
  if (target.includes('/ilink/bot/sendmessage')) {
    const body = JSON.parse(init.body)
    sentMessages.push(body.msg.item_list[0].text_item.text)
    sentTokens.push(body.msg.context_token)
    return { ok: true, async text() { return JSON.stringify({ ret: 0 }) } }
  }
  throw new Error(`unexpected fetch: ${target}`)
}

// ---- 假 Cordis ctx ----------------------------------------------------------
const disposers = []
const handlers = new Map()
const calls = { create: [], prompt: [], selectModel: [], rename: [], permission: [] }
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
  sessionController: {
    async create(request) {
      calls.create.push(request)
      return { sessionId: `session-wx-${calls.create.length}`, agentPreset: request.agentPreset }
    },
    async prompt(request) {
      calls.prompt.push(request)
      return { accepted: true }
    },
    async selectModel(request) {
      calls.selectModel.push(request)
      return { selected: request }
    },
    async rename(request) {
      calls.rename.push(request)
      return { title: request.title, seq: 1 }
    },
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' }) },
  agentPresets: {
    async remoteExportList() {
      return {
        presets: [
          { id: 'standard', name: 'Standard', description: '标准工具集', isDefault: true },
          { id: 'minimal', name: 'Minimal', description: '精简工具集' },
          { id: 'broken-one', name: 'Broken', broken: 'activation failed' },
        ],
      }
    },
    async list() {
      return [{ id: 'standard' }, { id: 'minimal' }]
    },
  },
  permissionPresets: {
    resolve(name) { return name === 'read-only' || name === 'workspace-write' ? { name } : undefined },
    optionOf(name) { return name === 'read-only' || name === 'workspace-write' ? { name } : undefined },
    set(agent, name) { calls.permission.push({ agent, name }) },
  },
  agents: { get: (id) => ({ id, ctx: {} }) },
}

function makeCtx() {
  return {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(fn)
      return () => {}
    },
    get(name) {
      return services[name]
    },
    tools: { register() { return () => {} } },
    provide() { return () => {} },
  }
}

function emit(name, ...args) {
  for (const fn of handlers.get(name) || []) fn(...args)
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

test('插件端到端：迁移绑定 → 建专用会话 → 入站转交 → 回合内即时回传', async (t) => {
  t.after(async () => {
    for (const dispose of disposers.reverse()) {
      try {
        await dispose()
      } catch {
        /* ignore */
      }
    }
    await sleep(40)
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  // 预置：旧版 settings（无 bindingVersion、绑定着旧会话）+ 已登录凭证
  fs.writeFileSync(
    path.join(dataDir, 'settings.json'),
    JSON.stringify({
      mode: 'direct',
      chatForward: true,
      chatSessionId: 'session-legacy',
      workspaceCwd: 'E:\\Administrator\\Documents',
      maxChars: 1900,
    }),
  )
  fs.writeFileSync(
    path.join(dataDir, 'credentials.json'),
    JSON.stringify({ version: 1, token: 'tok', accountId: 'bot-1', userId: 'me', baseUrl: 'https://ilink.example', savedAt: '' }),
  )
  process.env.DSH_WECHAT_BOT_DIR = dataDir

  const plugin = await import('../index.js')
  plugin.apply(makeCtx())

  // 迁移：旧绑定被解除，版本落盘
  let saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'))
  assert.equal(saved.bindingVersion, 2)
  assert.equal(saved.chatSessionId, '')
  assert.equal(saved.agentPreset, 'standard')
  assert.equal(saved.permissionPreset, 'read-only')
  assert.equal(saved.stream.enabled, true)

  // 等入站消息被转发（第一轮 getupdates 即返回一条文本消息）
  const deadline = Date.now() + 3000
  while (!calls.create.length && Date.now() < deadline) await sleep(10)
  assert.equal(calls.create.length, 1, '应创建专用会话')
  assert.equal(calls.create[0].agentPreset, 'standard', '显式传入预设')
  assert.equal(calls.create[0].cwd, 'E:\\Administrator\\Documents')
  assert.equal(calls.prompt.length, 1, '入站文本应转交给会话')
  assert.equal(calls.prompt[0].sessionId, 'session-wx-1')
  assert.equal(calls.prompt[0].mode, 'queue')
  assert.equal(calls.prompt[0].content[0].text, '帮我看一下今天的安排')

  // 建会话后套用模型（settings.model 为空时固化部署默认）与标题
  assert.deepEqual(calls.selectModel[0], {
    sessionId: 'session-wx-1',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'high',
  })
  assert.equal(calls.rename[0].title, '微信 bot（专用会话）')

  // 新 settings 已持久化
  saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'))
  assert.equal(saved.chatSessionId, 'session-wx-1')
  assert.equal(saved.model.provider, 'deepseek-official')

  // agent 起来时套用低权限预设
  emit('agent/created', { agent: { id: 'session-wx-1' } })
  assert.equal(calls.permission.length, 1)
  assert.equal(calls.permission[0].name, 'read-only')

  // web 路由：注册成功，且 /wechat-bot/state 能返回带新字段的状态
  assert.equal(routes.length, 1, '应注册 /wechat-bot 路由')
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/wechat-bot')
  const res = fakeRes()
  await routes[0].handler({ url: '/wechat-bot/state', method: 'GET', headers: {} }, res)
  assert.equal(res.code, 200)
  const panelState = JSON.parse(res.body)
  assert.equal(panelState.ok, true)
  assert.equal(panelState.web.registered, true, '状态里应报告路由已挂载')
  assert.equal(panelState.session.agentPreset, 'standard')
  assert.equal(panelState.settings.stream.enabled, true)
  assert.equal(panelState.preset.configured, 'standard')
  assert.equal(panelState.preset.followDefault, false)
  assert.deepEqual(
    panelState.presets.map((item) => item.id),
    ['standard', 'minimal', 'broken-one'],
    'state 应带回预设名册（含 isDefault/broken）',
  )
  assert.equal(panelState.presets[0].isDefault, true)

  // 回合：第一段文本足够长 → 立刻发出；第二段短 → 收尾补发
  emit('session/event', 'session-wx-1', { type: 'turn/start' })
  emit('session/event', 'session-wx-1', {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '今天上午 10 点有客户例会，下午需要出一版报价。' }] } },
  })
  await sleep(30)
  assert.equal(sentMessages.length, 1, '回合内文本应即时回传')
  assert.match(sentMessages[0], /客户例会/)

  emit('session/event', 'session-wx-1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '收到' }] } } })
  emit('session/event', 'session-wx-1', { type: 'turn/end' })
  await sleep(30)
  assert.equal(sentMessages.length, 2, '收尾应补发剩余短文本')
  assert.equal(sentMessages[1], '收到')

  // 没有微信来源的回合（例如用户直接在 GUI 里说话）不应外发；兜底逻辑由 relay 单测覆盖
  emit('session/event', 'session-wx-1', { type: 'turn/start' })
  emit('session/event', 'session-wx-1', { type: 'turn/end' })
  await sleep(30)
  assert.equal(sentMessages.length, 2)

  // 面板切换预设：更新 settings + 解绑旧会话
  const switchRes = fakeRes()
  await routes[0].handler(fakeReq('POST', '/wechat-bot/preset', { id: 'minimal' }), switchRes)
  assert.equal(switchRes.code, 200)
  const switched = JSON.parse(switchRes.body)
  assert.equal(switched.ok, true)
  assert.equal(switched.state.settings.agentPreset, 'minimal')
  assert.equal(switched.state.settings.chatSessionId, '', '切换预设应解绑旧会话')

  // 未知 / 加载失败的预设被拒绝
  const badRes = fakeRes()
  await routes[0].handler(fakeReq('POST', '/wechat-bot/preset', { id: 'nope' }), badRes)
  assert.equal(badRes.code, 400)
  assert.equal(JSON.parse(badRes.body).error, 'unknown_preset')

  const brokenRes = fakeRes()
  await routes[0].handler(fakeReq('POST', '/wechat-bot/preset', { id: 'broken-one' }), brokenRes)
  assert.equal(brokenRes.code, 400)
  assert.equal(JSON.parse(brokenRes.body).error, 'broken_preset')

  // 下一条微信消息按新预设重建会话
  inboundQueue.push({
    from_user_id: 'user@im.wechat',
    context_token: 'ctx-token-2',
    message_type: 1,
    item_list: [{ type: 1, text_item: { text: '换个预设再来一句' } }],
  })
  const deadline2 = Date.now() + 3000
  while (calls.create.length < 2 && Date.now() < deadline2) await sleep(10)
  assert.equal(calls.create.length, 2, '切换后应重建会话')
  assert.equal(calls.create[1].agentPreset, 'minimal')
  assert.equal(calls.prompt.length, 2)
  assert.equal(calls.prompt[1].content[0].text, '换个预设再来一句')

  // 新会话的回合回传到最近一次入站消息的 context_token
  emit('session/event', 'session-wx-2', { type: 'turn/start' })
  emit('session/event', 'session-wx-2', {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '新预设已经接手，这是第二条回复。' }] } },
  })
  emit('session/event', 'session-wx-2', { type: 'turn/end' })
  await sleep(30)
  assert.equal(sentTokens.at(-1), 'ctx-token-2')
})

test('非微信来源的会话事件不会外发', async () => {
  const before = sentMessages.length
  emit('session/event', 'session-other', { type: 'turn/start' })
  emit('session/event', 'session-other', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '这段不该发到微信' }] } } })
  emit('session/event', 'session-other', { type: 'turn/end' })
  await sleep(20)
  assert.equal(sentMessages.length, before)
})

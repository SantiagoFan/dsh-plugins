import assert from 'node:assert/strict'
import test from 'node:test'
import { createTurnRelay } from '../bridge/relay.js'

const TARGET = { uid: 'user@im.wechat', token: 'tok-1' }

function harness(options = {}) {
  const sent = []
  const errors = []
  let clock = 1000
  let timers = []
  const relay = createTurnRelay({
    minChars: 1,
    send: (text, target) => {
      sent.push({ text, target })
      return Promise.resolve()
    },
    now: () => clock,
    setInterval: (callback, ms) => {
      const handle = { callback, ms, unref() {} }
      timers.push(handle)
      return handle
    },
    clearInterval: (handle) => {
      timers = timers.filter((item) => item !== handle)
    },
    onError: (error) => errors.push(error),
    ...options,
  })
  return {
    relay,
    sent,
    errors,
    advance(ms) {
      clock += ms
      for (const timer of [...timers]) timer.callback()
    },
    get timerCount() {
      return timers.length
    },
  }
}

test('stream 模式：每个步骤的文本即时回传，结束不重复发送', async () => {
  const h = harness()
  h.relay.begin(TARGET)
  h.relay.push('我先看一下目录结构。')
  h.relay.push('找到了，共 3 个文件。')
  await h.relay.settle()
  assert.deepEqual(h.sent.map((item) => item.text), ['我先看一下目录结构。', '找到了，共 3 个文件。'])
  h.relay.end()
  await h.relay.settle()
  assert.equal(h.sent.length, 2)
  assert.equal(h.sent[0].target.uid, TARGET.uid)
})

test('增量不足 minChars 时并到下一条，收尾时补发剩余', async () => {
  const h = harness({ minChars: 12 })
  h.relay.begin(TARGET)
  h.relay.push('好的') // 2 字 < 12，暂存
  await h.relay.settle()
  assert.equal(h.sent.length, 0)
  h.relay.push('，我先把今天的新闻简报跑一遍再回复你。') // 合并后远超 12 字
  await h.relay.settle()
  assert.equal(h.sent.length, 1)
  assert.ok(h.sent[0].text.startsWith('好的，我先把今天的新闻简报'))
  h.relay.end()
  await h.relay.settle()
  assert.equal(h.sent.length, 1)
})

test('非 stream 模式：整轮结束后一次性回传', async () => {
  const h = harness({ stream: false })
  h.relay.begin(TARGET)
  h.relay.push('第一段。')
  h.relay.push('第二段。')
  await h.relay.settle()
  assert.equal(h.sent.length, 0)
  h.relay.end()
  await h.relay.settle()
  assert.deepEqual(h.sent.map((item) => item.text), ['第一段。第二段。'])
})

test('stream 模式最后一段不足 minChars 时，在回合结束补发', async () => {
  const h = harness({ minChars: 12 })
  h.relay.begin(TARGET)
  h.relay.push('这是足够长的一段内容，会立刻发出。')
  h.relay.push('尾巴') // 2 字，不足阈值
  await h.relay.settle()
  assert.equal(h.sent.length, 1)
  h.relay.end()
  await h.relay.settle()
  assert.deepEqual(h.sent.map((item) => item.text), ['这是足够长的一段内容，会立刻发出。', '尾巴'])
})

test('整轮没有任何文本时回兜底说明', async () => {
  const h = harness()
  h.relay.begin(TARGET)
  h.relay.end()
  await h.relay.settle()
  assert.equal(h.sent.length, 1)
  assert.match(h.sent[0].text, /本轮没有文本回复/)
})

test('静默超过 progressEveryMs 时回一条进度，随后正常发正文', async () => {
  const h = harness({ progressEveryMs: 25000 })
  h.relay.begin(TARGET)
  h.advance(30000)
  await h.relay.settle()
  assert.equal(h.sent.length, 1)
  assert.match(h.sent[0].text, /仍在处理/)
  h.relay.push('跑完了，结果如下：今天一共 12 条。')
  await h.relay.settle()
  assert.equal(h.sent.length, 2)
  h.relay.end()
  await h.relay.settle()
  assert.equal(h.sent.length, 2)
})

test('进度定时器随回合结束释放', async () => {
  const h = harness({ progressEveryMs: 25000 })
  h.relay.begin(TARGET)
  assert.equal(h.timerCount, 1)
  h.relay.end()
  assert.equal(h.timerCount, 0)
  assert.equal(h.relay.active(), false)
})

test('没有微信来源的回合被忽略，不产生任何发送', async () => {
  const h = harness()
  assert.equal(h.relay.begin(null), false)
  assert.equal(h.relay.push('这段不该发出去'), false)
  assert.equal(h.relay.end(), false)
  await h.relay.settle()
  assert.equal(h.sent.length, 0)
})

test('abort 丢弃回合且不发送兜底', async () => {
  const h = harness({ minChars: 12 }) // 未达阈值，仍在缓冲里
  h.relay.begin(TARGET)
  h.relay.push('未发送的中间内容')
  h.relay.abort()
  await h.relay.settle()
  assert.equal(h.sent.length, 0)
  assert.equal(h.relay.active(), false)
})

test('连续入队保持顺序', async () => {
  const h = harness({ minChars: 1 })
  h.relay.begin(TARGET)
  h.relay.push('一')
  h.relay.push('二')
  h.relay.end()
  await h.relay.settle()
  assert.deepEqual(h.sent.map((item) => item.text), ['一', '二'])
})

test('发送失败进入 onError，不打断后续消息', async () => {
  const sent = []
  const errors = []
  let fail = true
  const relay = createTurnRelay({
    send: async (text) => {
      if (fail) throw new Error('network down')
      sent.push(text)
    },
    minChars: 1,
    progressEveryMs: 0,
    onError: (error) => errors.push(error),
  })
  relay.begin(TARGET)
  relay.push('会失败的一条')
  await relay.settle()
  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /network down/)
  fail = false
  relay.push('后面这条应该成功')
  relay.end()
  await relay.settle()
  assert.deepEqual(sent, ['后面这条应该成功'])
})

test('ack 配置后，回合开始立刻回确认语，且不再补兜底', async () => {
  const h = harness({ ack: '收到，正在处理…' })
  h.relay.begin(TARGET)
  await h.relay.settle()
  assert.deepEqual(h.sent.map((item) => item.text), ['收到，正在处理…'])
  h.relay.end()
  await h.relay.settle()
  assert.equal(h.sent.length, 1)
})

test('缺少 context_token 的目标不被接受', async () => {
  const h = harness()
  assert.equal(h.relay.begin({ uid: TARGET.uid, token: '' }), false)
  h.relay.end()
  await h.relay.settle()
  assert.equal(h.sent.length, 0)
})

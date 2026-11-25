// 一个 DSH 回合 ⇄ 微信消息的转发状态机。
//
// 职责：
//  - 把一轮里陆续产生的助手文本，边产生边（或在回合结束时一次性）推回微信；
//  - 回合跑得久时，周期性回一条「仍在处理」进度，避免微信端一直沉默；
//  - 整轮没有任何文本时，回一条兜底说明。
//
// 纯逻辑：不依赖 DSH、不依赖网络，发送动作与定时器都由调用方注入，便于单测。

const DEFAULT_FALLBACK = '（本轮没有文本回复，完整过程见 DSH 会话）'

/**
 * @param {object} options
 * @param {(text: string, turn: { uid: string, token: string }) => Promise<unknown>} options.send 发送一条文本到微信
 * @param {boolean} [options.stream] true=每个模型步骤的文本即时回传；false=回合结束一次性回传
 * @param {string} [options.ack] 回合开始时立刻回的确认语（空串=不回）
 * @param {string} [options.fallback] 整轮无文本时的兜底话术
 * @param {number} [options.progressEveryMs] 静默多久后回一条进度（<=0 关闭）
 * @param {number} [options.minChars] 增量文本达到多少字符才单独发一条（其余并入下一条/收尾）
 * @param {() => number} [options.now] 时钟
 * @param {typeof setInterval} [options.setInterval] 定时器
 * @param {typeof clearInterval} [options.clearInterval] 定时器
 * @param {(error: unknown) => void} [options.onError] 发送失败回调
 */
export function createTurnRelay({
  send,
  stream = true,
  ack = '',
  fallback = DEFAULT_FALLBACK,
  progressEveryMs = 25000,
  minChars = 12,
  now = () => Date.now(),
  setInterval: setInt = globalThis.setInterval,
  clearInterval: clearInt = globalThis.clearInterval,
  onError = () => {},
} = {}) {
  if (typeof send !== 'function') throw new TypeError('createTurnRelay: send must be a function')

  let turn = null
  let full = ''
  let cursor = 0
  let sentAny = false
  /** 串行化发送，保证微信端消息顺序与产生顺序一致 */
  let chain = Promise.resolve()

  const enqueue = (text, target) => {
    chain = chain.then(() => send(text, target)).catch((error) => {
      try {
        onError(error)
      } catch {
        /* 错误回调本身不再抛出 */
      }
    })
    return chain
  }

  const stopTimer = () => {
    if (turn?.timer != null) {
      if (turn.timer.unref) turn.timer.unref()
      clearInt(turn.timer)
      turn.timer = null
    }
  }

  const reset = () => {
    stopTimer()
    turn = null
    full = ''
    cursor = 0
    sentAny = false
  }

  function heartbeat() {
    if (!turn) return
    if (progressEveryMs <= 0) return
    if (now() - turn.lastSendAt < progressEveryMs) return
    const seconds = Math.max(1, Math.round((now() - turn.startedAt) / 1000))
    turn.lastSendAt = now()
    enqueue(`⏳ 仍在处理…（已 ${seconds}s）`, turn.target)
  }

  /** 开始一个回合；target 为空表示这一轮与微信无关，直接忽略。 */
  function begin(target) {
    reset()
    if (!target || !target.uid || !target.token) return false
    turn = { target: { uid: target.uid, token: target.token }, startedAt: now(), lastSendAt: now(), timer: null }
    if (ack) {
      // 已经回过确认语，整轮无正文时不再补兜底，避免重复打扰
      sentAny = true
      enqueue(ack, turn.target)
    }
    if (progressEveryMs > 0) {
      turn.timer = setInt(() => heartbeat(), progressEveryMs)
      if (turn.timer?.unref) turn.timer.unref()
    }
    return true
  }

  /** 追加一段助手文本；stream 模式下按增量即时回传。 */
  function push(text) {
    if (!turn) return false
    const chunk = String(text ?? '')
    if (!chunk) return false
    full += chunk
    if (!stream) return true
    const delta = full.slice(cursor)
    if (!delta.trim()) return true
    if (delta.trim().length < minChars) return true
    cursor = full.length
    sentAny = true
    turn.lastSendAt = now()
    enqueue(delta, turn.target)
    return true
  }

  /** 结束当前回合：回传剩余文本，或整轮无文本时的兜底。 */
  function end() {
    if (!turn) return false
    const target = turn.target
    const rest = full.slice(cursor).trim()
    const hadSent = sentAny
    reset()
    if (rest) enqueue(rest, target)
    else if (!hadSent) enqueue(fallback, target)
    return true
  }

  /** 丢弃当前回合，不发送任何内容（重置会话、插件卸载时用）。 */
  function abort() {
    reset()
  }

  /** 等待已排队的发送全部落盘（测试与卸载时用）。 */
  function settle() {
    return chain
  }

  return { begin, push, end, abort, settle, active: () => Boolean(turn) }
}

/**
 * Host half of @local/wechat-bot.
 *
 * 通过微信官方 iLink（ClawBot）通道把个人微信桥接进 DSH：
 *  - 扫码登录（二维码链接在侧边栏面板里）；长轮询保持会话、刷新 context_token；
 *  - Agent 工具：wechat_status / wechat_login / wechat_send / wechat_recent；
 *  - 同源 HTTP 路由 /wechat-bot/* 供侧边栏面板读取状态、触发登录与测试推送；
 *  - 入站消息：`/` 开头由插件自己处理，其余转交给「微信专用会话」——该会话的
 *    预设/模型/权限预设都来自 settings（不再随部署默认值漂移），回合内助手文本
 *    逐段回传，长时间静默时回一条进度，整轮结束收尾。
 *
 * 状态与凭证保存在 ~/.dsh/wechat-bot/（可用环境变量 DSH_WECHAT_BOT_DIR 覆盖）；
 * 首次启动会尝试从旧版 daily-news/wechat 目录迁移凭证与群/私聊上下文。
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getBotQrcode, pollQrcodeStatus, getUpdates, sendText, ILinkError } from './bridge/ilink.js'
import { renderDigest, chunkByBytes } from './bridge/render.js'
import { createTurnRelay } from './bridge/relay.js'

export const name = 'wechat-bot'
// webServer 承载侧边栏面板的状态/登录/推送接口：把它列为依赖，Cordis 会等它就绪后再激活，
// 否则插件先激活时拿不到 webServer，路由缺失（面板报 404 Not Found）。
export const inject = ['tools', 'webServer']

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.DSH_WECHAT_BOT_DIR || path.join(os.homedir(), '.dsh', 'wechat-bot')
const TEXT_LIMIT = 1900
const RECENT_MAX = 100
/** 推送失败记录：保留条数与单条内容上限（面板可读，足够容纳一次 3 片推送） */
const FAILURE_MAX = 50
const FAILURE_CONTENT_MAX = 4000
/** settings 结构版本：升级后一次性把旧会话解绑，换成显式配置的专用会话 */
const BINDING_VERSION = 2
const DEFAULT_PRESET = 'standard'
const DEFAULT_PERMISSION_PRESET = 'read-only'

export function apply(ctx) {
  const settingsFile = path.join(DATA_DIR, 'settings.json')
  const credFile = path.join(DATA_DIR, 'credentials.json')
  const stateFile = path.join(DATA_DIR, 'state.json')
  const pushLogFile = path.join(DATA_DIR, 'push.log')
  const failureFile = path.join(DATA_DIR, 'push-failures.json')
  const dirs = [DATA_DIR]

  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })

  const readJson = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  }
  const writeJson = (file, value, mode) => {
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode })
    fs.renameSync(tmp, file)
  }

  // --------------------------------------------------------------- QR 渲染（纯 JS）
  // 登录二维码内容是一个 liteapp 链接；用随插件打包的 qrcode-generator（MIT）在本地生成
  // GIF data URL，不依赖 Python、不访问网络。
  let qrcodeLib = null
  try {
    qrcodeLib = createRequire(import.meta.url)('./vendor/qrcode.cjs')
  } catch (error) {
    qrcodeLib = null
    ctx.logger?.warn?.(`[wechat-bot] qrcode vendor unavailable: ${error?.message ?? error}`)
  }

  /** 返回 data:image/gif;base64,... 或空串 */
  function renderQrDataUrl(text) {
    try {
      if (!qrcodeLib) return ''
      const qr = qrcodeLib(0, 'M')
      qr.addData(String(text))
      qr.make()
      return qr.createDataURL(6, 2)
    } catch (error) {
      ctx.logger?.warn?.(`[wechat-bot] qr render failed: ${error?.message ?? error}`)
      return ''
    }
  }

  // ---------------------------------------------------------------- settings
  const savedSettings = readJson(settingsFile) || {}
  const settings = {
    mode: 'direct',
    targetUserId: '',
    maxChars: TEXT_LIMIT,
    autoStart: true,
    legacyDir: '',
    chatForward: true,
    chatSessionId: '',
    workspaceCwd: os.homedir(),
    // 微信专用会话：显式钉住预设 / 模型 / 权限预设，不随部署默认值漂移
    agentPreset: DEFAULT_PRESET,
    model: { provider: '', model: '', reasoningEffort: '' },
    permissionPreset: DEFAULT_PERMISSION_PRESET,
    sessionTitle: '微信 bot（专用会话）',
    bindingVersion: 0,
    // 回合内进度回传：stream=每个步骤即时回传；progressEveryMs=静默多久回一条进度
    stream: { enabled: true, progressEveryMs: 25000, minChars: 12, ack: '' },
    ...savedSettings,
  }
  // 新增字段用浅合并补齐，老 settings.json 不需要手改
  settings.model = { provider: '', model: '', reasoningEffort: '', ...(savedSettings.model || {}) }
  settings.stream = { enabled: true, progressEveryMs: 25000, minChars: 12, ack: '', ...(savedSettings.stream || {}) }
  const saveSettings = () => {
    try {
      writeJson(settingsFile, settings)
    } catch (error) {
      ctx.logger?.warn?.(`[wechat-bot] cannot save settings: ${error?.message ?? error}`)
    }
  }

  // 一次性迁移：把旧版随意新建的会话解绑，下一条微信消息将新建专用会话
  const migrateBinding = () => {
    if ((Number(settings.bindingVersion) || 0) >= BINDING_VERSION) return
    const previous = settings.chatSessionId
    settings.chatSessionId = ''
    settings.bindingVersion = BINDING_VERSION
    saveSettings()
    ctx.logger?.info?.(
      `[wechat-bot] 会话绑定已迁移（v${BINDING_VERSION}）：${previous ? `旧会话 ${previous} 不再接收微信消息` : '尚无绑定会话'}，下一条微信消息将新建专用会话`,
    )
  }
  migrateBinding()

  // ---------------------------------------------------------- credentials/state
  const saved = readJson(credFile)
  let creds = saved && saved.token ? saved : null
  const persisted = readJson(stateFile) || {}
  const rt = {
    creds,
    conn: { state: creds ? 'connecting' : 'unpaired', error: '', since: Date.now() },
    account: creds
      ? { botId: creds.accountId || '', userId: creds.userId || '', baseUrl: creds.baseUrl || '', savedAt: creds.savedAt || '' }
      : { botId: '', userId: '', baseUrl: '', savedAt: '' },
    qr: { url: '', ts: 0, active: false, dataUrl: '' },
    cursor: typeof persisted.cursor === 'string' ? persisted.cursor : '',
    directs: persisted.directs && typeof persisted.directs === 'object' ? persisted.directs : {},
    loginGen: 0,
    counters: { received: 0, sent: 0, failed: 0, drops: 0 },
    lastPush: persisted.lastPush || { at: 0, ok: false, error: '', chunks: 0, chars: 0 },
    recent: [],
    pushLog: [],
    /** 推送失败记录（持久化到 push-failures.json，面板可读） */
    failures: [],
    /** 专用会话实际生效的配置（供面板/排查用） */
    sessionProfile: { sessionId: '', agentPreset: '', model: '', permission: '' },
    permissionPreset: '',
    /** /wechat-bot/* 路由挂载状态（供 /status 与 wechat_status 排查 404） */
    web: { registered: false, attempts: 0, error: '', at: 0 },
  }
  let stops = { poll: new AbortController(), login: 0 }
  let disposed = false

  // 失败记录跨重启保留：读不到或格式不对时按空列表处理，不影响主流程
  try {
    const persistedFailures = readJson(failureFile)
    if (Array.isArray(persistedFailures)) {
      rt.failures = persistedFailures
        .filter((item) => item && typeof item === 'object' && Number(item.at) > 0)
        .slice(0, FAILURE_MAX)
    }
  } catch (error) {
    ctx.logger?.warn?.(`[wechat-bot] cannot load push failures: ${error?.message ?? error}`)
  }

  const saveState = () => {
    try {
      writeJson(stateFile, {
        version: 1,
        cursor: rt.cursor,
        directs: rt.directs,
        lastPush: rt.lastPush,
        updatedAt: Date.now(),
      })
    } catch (error) {
      ctx.logger?.warn?.(`[wechat-bot] cannot save state: ${error?.message ?? error}`)
    }
  }

  const pushAudit = (entry) => {
    try {
      fs.appendFileSync(pushLogFile, `${JSON.stringify({ ts: Date.now(), ...entry })}\n`)
    } catch {
      /* 审计写入失败不影响主流程 */
    }
  }

  // ------------------------------------------------- 推送失败记录（面板可读）
  // 只要一次推送失败（未登录 / 连接失效 / 无会话凭证 / 内容为空 / 分片发送失败 /
  // 日报读取失败），就把「哪个智能体、发送内容、发送时间、失败原因」写进本地文件，
  // 侧边栏「微信bot」面板直接展示，不再依赖巡检脚本或自动补推。
  const clipContent = (value) => {
    const text = String(value ?? '')
    if (text.length <= FAILURE_CONTENT_MAX) return { content: text, truncated: false }
    return { content: text.slice(0, FAILURE_CONTENT_MAX), truncated: true }
  }

  const saveFailures = () => {
    try {
      writeJson(failureFile, rt.failures)
    } catch (error) {
      ctx.logger?.warn?.(`[wechat-bot] cannot save push failures: ${error?.message ?? error}`)
    }
  }

  const recordFailure = (entry) => {
    try {
      const { content, truncated } = clipContent(entry.content)
      const record = {
        id: randomUUID(),
        /** 失败发生时间（用户要看的「发送时间」） */
        at: Date.now(),
        startedAt: entry.startedAt || Date.now(),
        source: entry.source || 'tool',
        agent: entry.agent || { label: '未识别来源' },
        content,
        truncated,
        chars: String(entry.content ?? '').length,
        file: entry.file ? String(entry.file) : '',
        error: entry.error || 'send_failed',
        message: entry.message || '',
        target: entry.target || '',
        chunksSent: Number(entry.chunksSent) || 0,
      }
      rt.failures.unshift(record)
      if (rt.failures.length > FAILURE_MAX) rt.failures.length = FAILURE_MAX
      saveFailures()
      return record
    } catch (error) {
      ctx.logger?.warn?.(`[wechat-bot] cannot record push failure: ${error?.message ?? error}`)
      return null
    }
  }

  /** 从工具执行的 Agent 句柄里提取「哪个智能体」：预设、会话与标题 */
  function describeAgent(agent) {
    if (!agent || typeof agent !== 'object') return null
    try {
      const session = agent.session
      const header = session?.header || {}
      let sessionTitle = ''
      try {
        const projections = ctx.get('sessionProjections')
        const snapshot = projections?.snapshot?.(session, ['title'])
        sessionTitle = String(snapshot?.values?.title || '')
      } catch {
        /* 标题只是辅助信息，取不到就留空 */
      }
      return {
        sessionId: String(agent.id || ''),
        presetId: String(header.agentPreset || ''),
        sessionTitle,
        subagent: Boolean(header.parentSession) || header.origin === 'subagent',
      }
    } catch {
      return null
    }
  }

  /** 把调用来源解析成面板上可读的「智能体」标签 */
  async function describeOrigin(source, agent) {
    const info = describeAgent(agent)
    if (!info) {
      const fallback =
        source === 'panel' ? '面板手动推送' : source === 'service' ? '其他插件（Host 服务调用）' : '未识别的调用方'
      return { label: fallback, presetId: '', presetName: '', sessionId: '', sessionTitle: '', subagent: false }
    }
    let presetName = ''
    if (info.presetId) {
      try {
        const rows = await listAgentPresets()
        presetName = rows.find((row) => row.id === info.presetId)?.name || ''
      } catch {
        presetName = ''
      }
    }
    const parts = []
    if (presetName && presetName !== info.presetId) parts.push(`${presetName}（${info.presetId}）`)
    else if (info.presetId === 'standard') parts.push('默认智能体（standard）')
    else if (info.presetId) parts.push(info.presetId)
    else parts.push('默认智能体')
    if (info.subagent) parts.push('子智能体')
    if (info.sessionTitle) parts.push(`「${info.sessionTitle}」`)
    return {
      label: parts.join(' · '),
      presetId: info.presetId,
      presetName,
      sessionId: info.sessionId,
      sessionTitle: info.sessionTitle,
      subagent: info.subagent,
    }
  }

  /** 设置当前登录二维码，并生成 GIF data URL（渲染失败则面板回退为链接） */
  function setQr(qr) {
    rt.qr = { url: qr.url, ts: Date.now(), active: true, base: qr.base, dataUrl: renderQrDataUrl(qr.url) }
    return rt.qr
  }

  // ------------------------------------------------------------- legacy import
  try {
    const legacy = settings.legacyDir
    const legacyCred = legacy ? path.join(legacy, 'secrets', 'credentials.json') : ''
    const legacyState = legacy ? path.join(legacy, 'state.json') : ''
    if (!creds && legacyCred && fs.existsSync(legacyCred)) {
      const value = JSON.parse(fs.readFileSync(legacyCred, 'utf8'))
      if (value?.token) {
        creds = {
          version: 1,
          token: value.token,
          accountId: value.accountId || '',
          userId: value.userId || '',
          baseUrl: value.baseUrl || 'https://ilinkai.weixin.qq.com',
          savedAt: value.savedAt || new Date().toISOString(),
        }
        rt.creds = creds
        rt.account = { botId: creds.accountId, userId: creds.userId, baseUrl: creds.baseUrl, savedAt: creds.savedAt }
        writeJson(credFile, creds, 0o600)
        rt.conn = { state: 'connecting', error: '', since: Date.now() }
        ctx.logger?.info?.('[wechat-bot] imported legacy credentials')
      }
    }
    const legacyCtx = legacyState && fs.existsSync(legacyState) ? JSON.parse(fs.readFileSync(legacyState, 'utf8')) : null
    if (legacyCtx) {
      if (!rt.cursor && typeof legacyCtx.cursor === 'string') rt.cursor = legacyCtx.cursor
      const directs = legacyCtx.directs && typeof legacyCtx.directs === 'object' ? legacyCtx.directs : {}
      for (const [uid, value] of Object.entries(directs)) {
        if (!rt.directs[uid] && value?.contextToken) rt.directs[uid] = value
      }
      if (!settings.targetUserId) {
        const ids = Object.keys(rt.directs)
        if (ids.length) settings.targetUserId = ids[0]
      }
      if (rt.cursor || Object.keys(directs).length) saveState()
      ctx.logger?.info?.('[wechat-bot] imported legacy cursor/context tokens')
    }
  } catch (error) {
    ctx.logger?.warn?.(`[wechat-bot] legacy import skipped: ${error?.message ?? error}`)
  }

  // ------------------------------------------------------------------ runtime
  const setConn = (state, error = '') => {
    if (rt.conn.state !== state) rt.conn = { ...rt.conn, state, error, since: Date.now() }
    else rt.conn.error = error
  }

  let polling = false
  async function pollLoop() {
    if (polling || disposed || !rt.creds) return
    polling = true
    const controller = stops.poll
    let failures = 0
    setConn('online')
    try {
      while (!disposed && !controller.signal.aborted) {
        try {
          const { msgs, cursor } = await getUpdates(rt.creds, rt.cursor, controller.signal, 35000)
          failures = 0
          if (cursor) rt.cursor = cursor
          let changed = Boolean(cursor)
          for (const msg of Array.isArray(msgs) ? msgs : []) {
            rt.counters.received += 1
            rt.recent.push({
              at: Date.now(),
              from: msg?.from_user_id || '',
              group: typeof msg?.group_id === 'string' ? msg.group_id : '',
              text: (msg?.item_list || []).map((i) => i?.text_item?.text).filter(Boolean).join(' ').slice(0, 300),
            })
            if (rt.recent.length > RECENT_MAX) rt.recent.splice(0, rt.recent.length - RECENT_MAX)
            const uid = msg?.from_user_id
            const isGroup = typeof msg?.group_id === 'string' && msg.group_id
            if (isGroup) {
              rt.counters.drops += 1
              continue
            }
            if (msg?.message_type === 2) {
              /* 机器人回显 */
              continue
            }
            const text = (msg?.item_list || []).map((i) => i?.text_item?.text).filter(Boolean).join(' ').trim()
            if (typeof uid === 'string' && uid.endsWith('@im.wechat') && msg?.context_token) {
              const token = String(msg.context_token)
              rt.directs[uid] = { contextToken: token, updatedAt: Date.now(), text: '' }
              changed = true
              if (text.startsWith('/')) void handleCommand(text, uid, token)
              else if (text && settings.chatForward) void forwardToChat(text, uid, token)
            }
          }
          if (changed) saveState()
          if (rt.conn.state !== 'online') setConn('online')
        } catch (error) {
          if (error?.code === 'session-expired') {
            setConn('expired', '微信连接已失效（-14），请重新扫码登录')
            saveState()
            break
          }
          failures += 1
          setConn(failures >= 3 ? 'error' : rt.conn.state, error?.message || String(error))
          await new Promise((resolve) => setTimeout(resolve, failures >= 3 ? 30000 : 2000))
        }
      }
    } finally {
      polling = false
    }
  }

  // 登录：beginLogin 立即返回当前二维码（非阻塞），runLogin 在后台轮询扫码结果
  async function beginLogin() {
    const gen = ++rt.loginGen
    const qr = await getBotQrcode(creds?.baseUrl || undefined)
    await setQr(qr)
    setConn(creds ? 'connecting' : 'unpaired', '等待手机微信扫码确认')
    void runLogin(gen, qr)
    return { ok: true, online: false, url: rt.qr.url, hasQr: Boolean(rt.qr.dataUrl) }
  }

  async function runLogin(gen, qr) {
    try {
      while (!disposed && rt.loginGen === gen) {
        const status = await pollQrcodeStatus(qr.qrcode, qr.base)
        if (rt.loginGen !== gen) return
        if (status.status === 'expired') {
          const next = await getBotQrcode(creds?.baseUrl || undefined)
          qr = next
          await setQr(next)
          setConn(creds ? 'connecting' : 'unpaired', '二维码已刷新，等待手机微信扫码确认')
          continue
        }
        if (status.status === 'scaned') {
          setConn('connecting', '已扫码，等待手机端确认')
          continue
        }
        if (status.status === 'confirmed') {
          if (!status.bot_token || !status.ilink_bot_id) throw new Error('登录确认但未返回完整凭证')
          creds = {
            version: 1,
            token: status.bot_token,
            accountId: status.ilink_bot_id,
            userId: status.ilink_user_id || '',
            baseUrl: status.baseurl || qr.base || 'https://ilinkai.weixin.qq.com',
            savedAt: new Date().toISOString(),
          }
          rt.creds = creds
          rt.account = { botId: creds.accountId, userId: creds.userId, baseUrl: creds.baseUrl, savedAt: creds.savedAt }
          writeJson(credFile, creds, 0o600)
          rt.qr = { url: '', ts: 0, active: false, dataUrl: '' }
          rt.cursor = ''
          rt.directs = {}
          rt.loginGen = 0
          saveState()
          setConn('online')
          pollLoop()
          return
        }
      }
    } catch (error) {
      setConn('error', error?.message || String(error))
      rt.qr = { ...rt.qr, active: false }
    }
  }

  function logout() {
    rt.loginGen = 0
    rt.qr = { url: '', ts: 0, active: false, dataUrl: '' }
    stops.poll.abort()
    stops.poll = new AbortController()
    rt.creds = null
    creds = null
    try {
      fs.rmSync(credFile, { force: true })
    } catch {
      /* ignore */
    }
    rt.cursor = ''
    saveState()
    setConn('unpaired', '')
    return { ok: true, online: false }
  }

  // -------------------------------------------------------------------- push
  function pickTarget() {
    const uid = settings.targetUserId && rt.directs[settings.targetUserId] ? settings.targetUserId : null
    if (uid) return { uid, token: rt.directs[uid]?.contextToken || '' }
    const ids = Object.keys(rt.directs)
    if (!ids.length) return null
    ids.sort((a, b) => (rt.directs[b]?.updatedAt || 0) - (rt.directs[a]?.updatedAt || 0))
    return { uid: ids[0], token: rt.directs[ids[0]]?.contextToken || '' }
  }

  async function pushText(rawText, { source = 'tool', agent = null, file = '' } = {}) {
    const content = String(rawText ?? '').trim()
    const startedAt = Date.now()
    const origin = await describeOrigin(source, agent)
    const fail = (error, message, extra = {}) => {
      recordFailure({ source, agent: origin, content, startedAt, file, error, message, ...extra })
      return { ok: false, error, message, ...extra }
    }
    if (!rt.creds) return fail('not_logged_in', '微信 bot 尚未登录，请先在面板中扫码登录')
    if (rt.conn.state !== 'online') return fail('not_online', `连接状态：${rt.conn.state}（${rt.conn.error || '未就绪'}）`)
    const target = pickTarget()
    if (!target?.token) {
      return fail('no_context', '还没有可推送的会话凭证：请在微信里给机器人发一条任意消息，让 bot 记录 context_token')
    }
    const maxChars = Math.max(200, Number(settings.maxChars) || TEXT_LIMIT)
    const chunks = chunkByBytes(content, maxChars).slice(0, 3)
    if (!chunks[0]) return fail('empty', '没有可发送的内容')
    const sent = []
    for (const chunk of chunks) {
      try {
        await sendText(rt.creds, { toUserId: target.uid, contextToken: target.token, text: chunk })
        sent.push(chunk.length)
        rt.counters.sent += 1
      } catch (error) {
        rt.counters.failed += 1
        const message = error?.message || String(error)
        rt.lastPush = { at: Date.now(), ok: false, error: message, chunks: sent.length, chars: sent.reduce((a, b) => a + b, 0) }
        if (error?.code === 'session-expired') setConn('expired', '微信连接已失效（-14），请重新扫码登录')
        saveState()
        pushAudit({ ok: false, source, target: target.uid, error: message })
        recordFailure({
          source,
          agent: origin,
          content,
          startedAt,
          file,
          error: error?.code || 'send_failed',
          message,
          target: target.uid,
          chunksSent: sent.length,
        })
        return { ok: false, error: error?.code || 'send_failed', message, chunks: sent.length }
      }
      if (chunk !== chunks[chunks.length - 1]) await new Promise((resolve) => setTimeout(resolve, 1200))
    }
    rt.lastPush = { at: Date.now(), ok: true, error: '', chunks: sent.length, chars: sent.reduce((a, b) => a + b, 0) }
    saveState()
    pushAudit({ ok: true, source, target: target.uid, chunks: sent.length, chars: rt.lastPush.chars })
    return { ok: true, chunks: sent.length, chars: rt.lastPush.chars, target: target.uid }
  }

  // ------------------------------------------------------- 微信 ⇄ DSH 会话转发
  const chatPending = []

  /** 直接回复到当前微信会话（使用入站消息带来的最新 context_token） */
  async function sendToWeChat(uid, token, body) {
    if (!rt.creds) return { ok: false, error: 'not_logged_in' }
    const chunks = chunkByBytes(String(body ?? '').trim(), Math.max(200, Number(settings.maxChars) || TEXT_LIMIT)).slice(0, 3)
    if (!chunks[0]) return { ok: false, error: 'empty' }
    for (let i = 0; i < chunks.length; i += 1) {
      await sendText(rt.creds, { toUserId: uid, contextToken: token, text: chunks[i] })
      rt.counters.sent += 1
      if (i < chunks.length - 1) await new Promise((resolve) => setTimeout(resolve, 1200))
    }
    return { ok: true, chunks: chunks.length }
  }

  // 回合内进度回传：每个模型步骤的文本即时发；长时间静默时回一条「仍在处理」
  const chatRelay = createTurnRelay({
    send: (text, target) => sendToWeChat(target.uid, target.token, text),
    stream: Boolean(settings.stream.enabled),
    ack: String(settings.stream.ack || ''),
    progressEveryMs: Math.max(0, Number(settings.stream.progressEveryMs) || 0),
    minChars: Math.max(1, Number(settings.stream.minChars) || 1),
    onError: (error) => ctx.logger?.warn?.(`[wechat-bot] chat reply failed: ${error?.message ?? error}`),
  })

  const helpText = () =>
    [
      '可用指令：',
      '/help    查看指令',
      '/status  连接与账号状态',
      '/login   扫码登录（返回二维码链接）',
      '/logout  退出登录',
      '/recent  最近收到的消息',
      '/news    让 DSH 跑今天的新闻简报',
      '/new     重置对话会话（下一条消息新建 DSH 会话）',
      '',
      '其余消息会转交给 DSH 会话处理，处理结果自动回传到微信。',
    ].join('\n')

  // ---- Agent 预设：名册读取 + 面板切换 --------------------------------------
  const presetCache = { at: 0, rows: [] }

  /** 读取部署已注册的 Agent 预设名册（5s 缓存，供面板轮询复用） */
  async function listAgentPresets(force = false) {
    const now = Date.now()
    if (!force && presetCache.at && now - presetCache.at < 5000) return presetCache.rows
    const registry = ctx.get('agentPresets')
    if (!registry) return presetCache.rows
    let rows = []
    try {
      const roster = (await registry.remoteExportList?.())?.presets
      if (Array.isArray(roster)) {
        rows = roster.map((item) => ({
          id: String(item?.id ?? ''),
          name: String(item?.name ?? ''),
          description: String(item?.description ?? ''),
          isDefault: Boolean(item?.isDefault),
          broken: String(item?.broken ?? ''),
        }))
      } else {
        const list = (await registry.list?.()) || []
        rows = list.map((item) => ({
          id: String(item?.id ?? ''),
          name: String(item?.name ?? ''),
          description: String(item?.description ?? ''),
          isDefault: false,
          broken: String(item?.broken ?? ''),
        }))
      }
    } catch (error) {
      ctx.logger?.warn?.(`[wechat-bot] 读取 Agent 预设名册失败：${error?.message ?? error}`)
      return presetCache.rows
    }
    presetCache.at = now
    presetCache.rows = rows.filter((row) => row.id)
    return presetCache.rows
  }

  /** 校验预设 id：不存在或加载失败时回退到默认预设，避免建会话直接失败 */
  async function resolveAgentPreset(preferred) {
    if (!preferred) return ''
    const rows = await listAgentPresets()
    const usable = rows.filter((row) => !row.broken)
    if (usable.length && !usable.some((row) => row.id === preferred)) {
      const fallback = usable.find((row) => row.id === DEFAULT_PRESET)?.id || ''
      ctx.logger?.warn?.(
        `[wechat-bot] 预设 ${preferred} 不可用（可用：${usable.map((row) => row.id).join(', ')}），回退为 ${fallback || '部署默认'}`,
      )
      return fallback
    }
    return preferred
  }

  /** 面板切换回答预设：更新 settings 并解绑旧会话，下一条微信消息按新预设重建 */
  async function switchAgentPreset(requested) {
    const id = String(requested ?? '').trim()
    const rows = await listAgentPresets(true)
    if (id) {
      const row = rows.find((item) => item.id === id)
      if (!row) return { ok: false, error: 'unknown_preset', message: `未知预设：${id}`, presets: rows }
      if (row.broken) return { ok: false, error: 'broken_preset', message: `预设 ${id} 加载失败：${row.broken}`, presets: rows }
    }
    const previous = settings.agentPreset || ''
    if (previous === id && !settings.chatSessionId) return { ok: true, preset: id, previous, rebind: false, unchanged: true }
    settings.agentPreset = id
    const rebind = Boolean(settings.chatSessionId)
    settings.chatSessionId = ''
    rt.sessionProfile = { sessionId: '', agentPreset: id, model: '', permission: '' }
    rt.permissionPreset = ''
    saveSettings()
    ctx.logger?.info?.(
      `[wechat-bot] 回答预设切换：${id || '跟随部署默认'}（原 ${previous || '跟随默认'}${rebind ? '，旧会话已解绑，下一条微信消息重建' : ''}）`,
    )
    return { ok: true, preset: id, previous, rebind }
  }

  /** 从部署已注册的权限预设里挑一个可用的；都没有就沿用部署默认 */
  function resolvePermissionPreset() {
    const wanted = String(settings.permissionPreset || '').trim()
    if (!wanted) return ''
    const pp = ctx.get('permissionPresets')
    if (!pp) return ''
    for (const name of [wanted, 'workspace-write']) {
      try {
        const known = pp.resolve?.(name) ?? pp.optionOf?.(name)
        if (known) return name
      } catch {
        /* 该名称未注册，试下一个 */
      }
    }
    ctx.logger?.warn?.(`[wechat-bot] 权限预设 ${wanted} 不可用，沿用部署默认权限`)
    return ''
  }

  /** 把权限预设套到这个会话的 agent 上（需要 agent 已经存在） */
  function applyPermissionPreset(agent) {
    if (!agent) return ''
    const name = rt.permissionPreset || resolvePermissionPreset()
    if (!name) return ''
    const pp = ctx.get('permissionPresets')
    if (!pp || typeof pp.set !== 'function') return ''
    try {
      pp.set(agent, name)
      rt.permissionPreset = name
      rt.sessionProfile.permission = name
      ctx.logger?.info?.(`[wechat-bot] 微信专用会话权限预设：${name}`)
      return name
    } catch (error) {
      ctx.logger?.warn?.(`[wechat-bot] 设置权限预设 ${name} 失败：${error?.message ?? error}`)
      return ''
    }
  }

  /** 新建会话后套用模型与标题；失败只告警，不阻断消息流转 */
  async function applySessionProfile(sessionId) {
    const sessions = ctx.get('sessionController')
    if (!sessions || !sessionId) return
    const model = settings.model || {}
    if (model.provider && model.model && typeof sessions.selectModel === 'function') {
      try {
        const request = { sessionId, provider: model.provider, model: model.model }
        if (model.reasoningEffort) request.reasoningEffort = model.reasoningEffort
        await sessions.selectModel(request)
        rt.sessionProfile.model = `${model.provider}/${model.model}${model.reasoningEffort ? `@${model.reasoningEffort}` : ''}`
        ctx.logger?.info?.(`[wechat-bot] 微信专用会话模型：${rt.sessionProfile.model}`)
      } catch (error) {
        ctx.logger?.warn?.(`[wechat-bot] 指定模型失败，沿用会话默认：${error?.message ?? error}`)
      }
    }
    if (settings.sessionTitle && typeof sessions.rename === 'function') {
      try {
        await sessions.rename({ sessionId, title: String(settings.sessionTitle) })
      } catch (error) {
        ctx.logger?.warn?.(`[wechat-bot] 重命名会话失败：${error?.message ?? error}`)
      }
    }
  }

  /** 首次需要时创建微信专用会话（预设/模型/权限都来自 settings） */
  async function ensureChatSession() {
    if (settings.chatSessionId) return settings.chatSessionId
    const sessions = ctx.get('sessionController')
    if (!sessions) return ''
    // 模型未显式配置时，固化当前部署默认值，之后不随默认值漂移
    if (!settings.model.provider || !settings.model.model) {
      try {
        const current = ctx.get('agentDefaultModel')?.currentSelection?.()
        if (current?.provider && current?.model) {
          settings.model = {
            provider: current.provider,
            model: current.model,
            reasoningEffort: current.reasoningEffort || '',
          }
        }
      } catch (error) {
        ctx.logger?.warn?.(`[wechat-bot] 读取默认模型失败：${error?.message ?? error}`)
      }
    }
    // 未指定预设时跟随部署默认（不传 agentPreset）；指定时先在名册里校验
    const configuredPreset = String(settings.agentPreset || '')
    const preset = configuredPreset ? await resolveAgentPreset(configuredPreset) : ''
    const request = { cwd: settings.workspaceCwd }
    if (preset) request.agentPreset = preset
    let created = null
    try {
      created = await sessions.create(request)
    } catch (error) {
      if (!preset) throw error
      ctx.logger?.warn?.(`[wechat-bot] 用预设 ${preset} 建会话失败，回退默认预设：${error?.message ?? error}`)
      created = await sessions.create({ cwd: settings.workspaceCwd })
    }
    settings.chatSessionId = created?.sessionId || ''
    if (!settings.chatSessionId) return ''
    rt.sessionProfile = {
      sessionId: settings.chatSessionId,
      agentPreset: created?.agentPreset || preset || 'default',
      model: '',
      permission: '',
    }
    saveSettings()
    await applySessionProfile(settings.chatSessionId)
    ctx.logger?.info?.(
      `[wechat-bot] 已创建微信专用会话 ${settings.chatSessionId}（preset=${rt.sessionProfile.agentPreset}）`,
    )
    return settings.chatSessionId
  }

  /** 把一条微信消息转交给 DSH 会话；回合内的回传由 chatRelay 负责 */
  async function forwardToChat(text, uid, token) {
    const sessions = ctx.get('sessionController')
    if (!sessions) {
      await sendToWeChat(uid, token, 'DSH 会话服务不可用，消息未转交').catch(() => {})
      return { ok: false, error: 'no_session_service' }
    }
    try {
      const sessionId = await ensureChatSession()
      if (!sessionId) {
        await sendToWeChat(uid, token, '无法创建 DSH 会话，消息未转交').catch(() => {})
        return { ok: false, error: 'no_session' }
      }
      chatPending.push({ uid, token, at: Date.now() })
      if (chatPending.length > 20) chatPending.shift()
      await sessions.prompt(
        { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }] },
        new AbortController().signal,
      )
      return { ok: true, sessionId }
    } catch (error) {
      chatPending.pop()
      await sendToWeChat(uid, token, `转交 DSH 会话失败：${error?.message || error}`).catch(() => {})
      return { ok: false, error: 'prompt_failed', message: error?.message || String(error) }
    }
  }

  async function handleCommand(text, uid, token) {
    const [cmd] = String(text).split(/\s+/)
    const name = (cmd || '').toLowerCase()
    try {
      if (name === '/help') return await sendToWeChat(uid, token, helpText())
      if (name === '/status') {
        const presetRows = await listAgentPresets()
        const body = [
          `连接：${rt.conn.state}${rt.conn.error ? `（${rt.conn.error}）` : ''}`,
          `bot：${rt.account.botId || '—'}`,
          `计数：收 ${rt.counters.received} / 发 ${rt.counters.sent} / 失败 ${rt.counters.failed}`,
          `最近推送：${rt.lastPush.at ? `${new Date(rt.lastPush.at).toLocaleString()} ${rt.lastPush.ok ? '成功' : '失败'}` : '无'}`,
          `专用会话：${settings.chatSessionId || '未建立（下一条消息创建）'}`,
          `预设 ${rt.sessionProfile.agentPreset || settings.agentPreset || '跟随部署默认'} · 模型 ${rt.sessionProfile.model || '会话默认'} · 权限 ${rt.sessionProfile.permission || rt.permissionPreset || '部署默认'}`,
          `可用预设：${presetRows.length ? presetRows.map((row) => `${row.id}${row.isDefault ? '*' : ''}`).join(' / ') : '不可用'}`,
          `进度回传：${settings.stream.enabled ? '按步骤流式' : '整轮一次性'}${Number(settings.stream.progressEveryMs) > 0 ? `（静默 ${Math.round(Number(settings.stream.progressEveryMs) / 1000)}s 回进度）` : ''}`,
        ].join('\n')
        return await sendToWeChat(uid, token, body)
      }
      if (name === '/login') {
        const result = await beginLogin()
        return await sendToWeChat(uid, token, result.url ? `请用手机微信打开链接并确认登录：\n${result.url}` : '二维码获取失败，请稍后重试')
      }
      if (name === '/logout') {
        logout()
        return await sendToWeChat(uid, token, '已退出登录，可在 DSH 侧边栏「微信bot」重新扫码')
      }
      if (name === '/recent') {
        const list = rt.recent.slice(-8).map((item) => `- ${new Date(item.at).toLocaleTimeString()} ${item.text || '[非文本]'}`)
        return await sendToWeChat(uid, token, list.length ? `最近消息：\n${list.join('\n')}` : '暂无消息')
      }
      if (name === '/news') return await forwardToChat('跑今天的新闻简报', uid, token)
      if (name === '/new') {
        settings.chatSessionId = ''
        saveSettings()
        chatRelay.abort()
        chatPending.length = 0
        rt.sessionProfile = { sessionId: '', agentPreset: '', model: '', permission: '' }
        rt.permissionPreset = ''
        return await sendToWeChat(uid, token, '已重置对话会话，下一条消息将新建 DSH 专用会话')
      }
      return await sendToWeChat(uid, token, `未知指令：${cmd}\n\n${helpText()}`)
    } catch (error) {
      await sendToWeChat(uid, token, `指令执行失败：${error?.message || error}`).catch(() => {})
      return { ok: false, error: 'command_failed' }
    }
  }

  function buildState() {
    return {
      ok: true,
      connection: { state: rt.conn.state, error: rt.conn.error, since: rt.conn.since },
      account: { ...rt.account, userIdConfigured: settings.targetUserId === rt.account.userId },
      qr: { url: rt.qr.url, ts: rt.qr.ts, active: rt.qr.active, hasQr: Boolean(rt.qr.dataUrl), dataUrl: rt.qr.dataUrl },
      counters: { ...rt.counters },
      /** 推送失败记录条数（完整记录走 GET /wechat-bot/failures） */
      failureCount: rt.failures.length,
      lastPush: { ...rt.lastPush },
      recent: rt.recent.slice(-20),
      service: { name: 'wechatBot', methods: ['status', 'send', 'sendFile', 'sendDigest', 'login', 'recent'] },
      settings: {
        mode: settings.mode,
        maxChars: settings.maxChars,
        autoStart: settings.autoStart,
        targetUserId: settings.targetUserId,
        chatForward: Boolean(settings.chatForward),
        chatSessionId: settings.chatSessionId,
        agentPreset: settings.agentPreset,
        permissionPreset: settings.permissionPreset,
        model: settings.model,
        stream: settings.stream,
        bindingVersion: settings.bindingVersion,
      },
      // 专用会话：实际生效的预设/模型/权限（建会话后才有值）
      session: {
        id: settings.chatSessionId,
        agentPreset: rt.sessionProfile.agentPreset,
        model: rt.sessionProfile.model,
        permission: rt.sessionProfile.permission || rt.permissionPreset || '',
        cwd: settings.workspaceCwd,
      },
      // 回答预设：configured 为空表示跟随 DSH 部署默认
      preset: {
        configured: settings.agentPreset || '',
        resolved: rt.sessionProfile.agentPreset || '',
        followDefault: !settings.agentPreset,
      },
      // 部署当前注册的 Agent 预设名册（面板下拉用；服务不可用时为空数组）
      presets: presetCache.rows,
      // 面板状态接口挂载情况：registered=false 时侧边栏会报 404
      web: { ...rt.web },
      updatedAt: Date.now(),
    }
  }

  async function pushFromFile(filePath, { agent = null } = {}) {
    const file = String(filePath ?? '')
    let raw
    try {
      raw = renderDigest(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      const message = `读取日报失败：${error?.message ?? error}`
      const origin = await describeOrigin('file', agent)
      recordFailure({ source: 'file', agent: origin, content: file, file, startedAt: Date.now(), error: 'read_failed', message })
      return { ok: false, error: 'read_failed', message }
    }
    return pushText(raw, { source: 'file', agent, file })
  }

  // -------------------------------------------------------------------- tools
  const textResult = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  const tools = [
    {
      name: 'wechat_status',
      description:
        '查看本机微信 bot 的连接状态与账号信息：是否已登录、在线/失效、bot 与用户 ID、是否有待扫码的二维码、最近一次推送结果。推送前或连接异常时先调用。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => textResult(value) },
      async execute() {
        await listAgentPresets()
        return buildState()
      },
    },
    {
      name: 'wechat_login',
      description:
        '微信 bot 扫码登录控制。action=start 生成/轮询登录二维码，返回 qrUrl 供用户在手机微信中打开确认；action=refresh 重新生成二维码；action=logout 退出登录并删除本地凭证。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'refresh', 'logout', 'cancel'], description: '登录动作' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => textResult(value) },
      timeoutMs: 30000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const action = String(args?.action ?? 'start')
        if (action === 'logout') return logout()
        if (action === 'cancel') {
          rt.loginGen += 1
          rt.qr = { url: '', ts: 0, active: false, dataUrl: '' }
          setConn(rt.creds ? 'online' : 'unpaired', '')
          return { ok: true, action, online: rt.conn.state === 'online', qrUrl: '' }
        }
        if (action === 'refresh') {
          rt.loginGen += 1
          rt.qr = { url: '', ts: 0, active: false, dataUrl: '' }
        }
        const value = await beginLogin()
        return { ok: value.ok !== false, action, online: rt.conn.state === 'online', qrUrl: rt.qr.url, connection: rt.conn.state, hint: rt.qr.url ? '在手机微信中打开 qrUrl 确认登录' : '' }
      },
    },
    {
      name: 'wechat_send',
      description:
        '把文本推送到你本人的微信（1:1 会话）。text 直接给内容；file 给工作区里日报 Markdown 的绝对路径，会自动压缩成“今日速览 + 每主题 1 条 + 链接”的短消息并按 1900 字节分片。推送前会自动检查登录与最近会话凭证。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要推送的文本（与 file 二选一）' },
          file: { type: 'string', description: '日报 Markdown 绝对路径（与 text 二选一）' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => textResult(value) },
      timeoutMs: 40000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const agent = exec?.agent || null
        const file = String(args?.file ?? '').trim()
        if (file) return pushFromFile(file, { agent })
        return pushText(String(args?.text ?? '').trim(), { source: 'tool', agent })
      },
    },
    {
      name: 'wechat_recent',
      description: '读取微信 bot 最近收到的消息（仅元数据，最多 100 条），用于确认 context_token 是否新鲜、排查收不到消息的原因。',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: '返回条数，默认 20，最大 100' } },
        additionalProperties: false,
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => textResult(value) },
      async execute(args) {
        const limit = Math.max(1, Math.min(100, Number(args?.limit ?? 20) || 20))
        return { ok: true, count: rt.recent.length, messages: rt.recent.slice(-limit) }
      },
    },
  ]

  for (const tool of tools) ctx.effect(() => ctx.tools.register(tool))

  // ------------------------------------------------- Host service（供其他插件调用）
  // 其他插件声明 inject: ['wechatBot'] 后即可 ctx.get('wechatBot') 使用：
  //   api.status() / api.send(text) / api.sendFile(mdPath) / api.sendDigest(mdPath) / api.login(action) / api.recent(limit)
  const api = {
    version: '1.3.0',
    status: () => buildState(),
    send: (text, options = {}) =>
      pushText(String(text ?? ''), { source: options.source || 'service', agent: options.agent || null }),
    sendFile: (filePath, options = {}) => pushFromFile(filePath, { agent: options?.agent || null }),
    sendDigest: (filePath, options = {}) => pushFromFile(filePath, { agent: options?.agent || null }),
    /** 推送失败记录（面板同源，最近 FAILURE_MAX 条） */
    failures: (limit = FAILURE_MAX) => rt.failures.slice(0, Math.max(1, Math.min(FAILURE_MAX, Number(limit) || FAILURE_MAX))),
    login: async (action = 'start') => {
      if (action === 'logout') return logout()
      if (action === 'cancel') {
        rt.loginGen += 1
        rt.qr = { url: '', ts: 0, active: false, dataUrl: '' }
        setConn(rt.creds ? 'online' : 'unpaired', '')
        return { ok: true, online: rt.conn.state === 'online' }
      }
      if (action === 'refresh') {
        rt.loginGen += 1
        rt.qr = { url: '', ts: 0, active: false, dataUrl: '' }
      }
      return beginLogin()
    },
    recent: (limit = 20) => rt.recent.slice(-Math.max(1, Math.min(100, Number(limit) || 20))),
  }
  if (typeof ctx.provide === 'function') {
    ctx.effect(() => ctx.provide('wechatBot', api))
  } else {
    ctx.logger?.warn?.('[wechat-bot] ctx.provide unavailable: wechatBot service not exposed')
  }

  // ---------------------------------------------------------------- web routes
  // webServer 由 web-startup 行提供，插件激活顺序并不保证；除了在 inject 里声明依赖，
  // 这里再做一次兜底重试，避免插件先于 webServer 激活时路由永久缺失（面板会报 404）。
  function mountWebRoutes(web) {
    const origin = () => {
      try {
        return web.getOrigin?.() || ''
      } catch {
        return ''
      }
    }
    const sendJson = (res, value, status = 200) => {
      const body = JSON.stringify(value)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
    }
    const readBody = (req) =>
      new Promise((resolve, reject) => {
        let raw = ''
        req.setEncoding('utf8')
        req.on('data', (chunk) => {
          raw += chunk
          if (raw.length > 1024 * 1024) {
            reject(new Error('request body too large'))
            req.destroy()
          }
        })
        req.on('end', () => resolve(raw))
        req.on('error', reject)
      })
    const page = () => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>微信 bot</title>
<style>body{font:14px/1.6 system-ui,sans-serif;max-width:760px;margin:32px auto;padding:0 16px;color:#111}
pre{background:#f5f5f5;padding:10px;border-radius:8px;overflow:auto;max-height:420px}</style></head>
<body><h2>微信 bot（调试页）</h2><p>正式界面在左侧边栏的「微信bot」按钮里。</p><pre id="s">加载中…</pre>
<script>fetch('/wechat-bot/state').then(r=>r.json()).then(s=>{document.getElementById('s').textContent=JSON.stringify(s,null,2)})</script></body></html>`

    // 注意：webServer 的 resource 形式只接受 GET/HEAD；面板需要 POST，必须用 handler 形式。
    ctx.effect(() =>
      web.register({
        kind: 'prefix',
        path: '/wechat-bot',
        handler: async (req, res) => {
          try {
            const url = new URL(req.url || '/', 'http://127.0.0.1')
            const method = (req.method || 'GET').toUpperCase()
            if (method === 'GET' && url.pathname === '/wechat-bot/state') {
              await listAgentPresets()
              return sendJson(res, buildState())
            }
            if (method === 'GET' && url.pathname === '/wechat-bot/failures') {
              const requested = Number(url.searchParams.get('limit'))
              const limit = Math.max(1, Math.min(FAILURE_MAX, Number.isFinite(requested) && requested > 0 ? requested : FAILURE_MAX))
              return sendJson(res, { ok: true, total: rt.failures.length, items: rt.failures.slice(0, limit) })
            }
            if (method === 'GET' && url.pathname === '/wechat-bot/qr.png') {
              if (!rt.qr.dataUrl) {
                res.writeHead(404, { 'cache-control': 'no-store' })
                return res.end('no qr')
              }
              const comma = rt.qr.dataUrl.indexOf(',')
              const meta = rt.qr.dataUrl.slice(5, comma) // e.g. image/gif;base64
              const mime = meta.split(';')[0] || 'image/gif'
              const bytes = Buffer.from(rt.qr.dataUrl.slice(comma + 1), 'base64')
              res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store', 'content-length': bytes.length })
              return res.end(bytes)
            }
            if (method === 'GET' && url.pathname === '/wechat-bot/') {
              const html = page()
              res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
              return res.end(html)
            }
            if (method === 'POST') {
              const originHeader = req.headers.origin || ''
              const own = origin()
              if (originHeader && own && !originHeader.startsWith(own) && !originHeader.startsWith('http://127.0.0.1')) {
                return sendJson(res, { ok: false, error: 'cross-origin request refused' }, 403)
              }
              let body = {}
              try {
                body = JSON.parse((await readBody(req)) || '{}')
              } catch {
                return sendJson(res, { ok: false, error: 'invalid json' }, 400)
              }
              const action = String(body.action || '')
              if (url.pathname === '/wechat-bot/login') {
                if (action === 'logout') {
                  logout()
                  return sendJson(res, { ok: true, state: buildState() })
                }
                if (action === 'cancel') {
                  rt.loginGen += 1
                  rt.qr = { url: '', ts: 0, active: false, dataUrl: '' }
                  setConn(rt.creds ? 'online' : 'unpaired', '')
                  return sendJson(res, { ok: true, state: buildState() })
                }
                const result = await beginLogin()
                return sendJson(res, { ...result, state: buildState() })
              }
              if (url.pathname === '/wechat-bot/preset') {
                const result = await switchAgentPreset(body.id)
                return sendJson(res, { ...result, state: buildState() }, result.ok === false ? 400 : 200)
              }
              if (url.pathname === '/wechat-bot/send') {
                const text = String(body.text || '').trim()
                if (!text) return sendJson(res, { ok: false, error: 'text required' }, 400)
                return sendJson(res, await pushText(text, { source: 'panel' }))
              }
              if (url.pathname === '/wechat-bot/failures/clear') {
                rt.failures = []
                saveFailures()
                return sendJson(res, { ok: true, total: 0, state: buildState() })
              }
              if (url.pathname === '/wechat-bot/failures/delete') {
                const id = String(body.id || '')
                const before = rt.failures.length
                rt.failures = rt.failures.filter((item) => item.id !== id)
                if (rt.failures.length === before) return sendJson(res, { ok: false, error: 'not_found' }, 404)
                saveFailures()
                return sendJson(res, { ok: true, total: rt.failures.length, state: buildState() })
              }
              return sendJson(res, { ok: false, error: 'unknown route' }, 404)
            }
            res.writeHead(405, { allow: 'GET, POST', 'content-type': 'text/plain; charset=utf-8' })
            res.end('method not allowed')
          } catch (error) {
            ctx.logger?.warn?.(`[wechat-bot] http handler failed: ${error?.message ?? error}`)
            if (res.headersSent) {
              res.destroy()
              return
            }
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('internal error')
          }
        },
      }),
    )
  }

  /** 注册 /wechat-bot/* ；返回是否成功挂载 */
  function registerWebRoutes() {
    const attempt = rt.web.attempts + 1
    const web = ctx.get('webServer')
    if (!web || typeof web.register !== 'function') {
      rt.web = { registered: false, attempts: attempt, error: 'webServer 服务尚不可用', at: Date.now() }
      return false
    }
    try {
      mountWebRoutes(web)
      rt.web = { registered: true, attempts: attempt, error: '', at: Date.now() }
      ctx.logger?.info?.('[wechat-bot] 已注册 /wechat-bot 路由')
      return true
    } catch (error) {
      rt.web = { registered: false, attempts: attempt, error: error?.message || String(error), at: Date.now() }
      ctx.logger?.warn?.(`[wechat-bot] 注册 web 路由失败：${rt.web.error}`)
      return false
    }
  }

  let webRetryTimer = null
  const stopWebRetry = () => {
    if (webRetryTimer) {
      clearTimeout(webRetryTimer)
      webRetryTimer = null
    }
  }
  const scheduleWebRetry = () => {
    if (disposed || rt.web.registered) return
    if (rt.web.attempts >= 20) {
      ctx.logger?.warn?.(
        `[wechat-bot] webServer 重试 ${rt.web.attempts} 次仍不可用，面板状态接口未启用（${rt.web.error || '未知原因'}）`,
      )
      return
    }
    webRetryTimer = setTimeout(() => {
      webRetryTimer = null
      if (disposed || rt.web.registered) return
      if (registerWebRoutes()) return
      scheduleWebRetry()
    }, 500)
    if (webRetryTimer.unref) webRetryTimer.unref()
  }
  if (!registerWebRoutes()) scheduleWebRetry()

  // ------------------------------------------------------------------ lifecycle
  // 会话事件：turn/start 取出发起消息的目标，assistant/message 增量回传，turn/end 收尾
  const onSessionEvent = (session, event) => {
    try {
      const sid = typeof session === 'string' ? session : session?.id
      if (!settings.chatSessionId || sid !== settings.chatSessionId) return
      if (event?.type === 'turn/start') {
        chatRelay.begin(chatPending.shift() || null)
        return
      }
      if (event?.type === 'assistant/message') {
        const content = event?.data?.message?.content
        if (!Array.isArray(content)) return
        const text = content
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('')
        if (text) chatRelay.push(text)
        return
      }
      if (event?.type === 'turn/end') chatRelay.end()
    } catch (error) {
      ctx.logger?.warn?.(`[wechat-bot] session event handler failed: ${error?.message ?? error}`)
    }
  }
  try {
    ctx.effect(() => ctx.on('session/event', onSessionEvent))
  } catch (error) {
    ctx.logger?.warn?.(`[wechat-bot] session/event subscription unavailable: ${error?.message ?? error}`)
  }

  // 专用会话的 agent 起来时套用权限预设（权限 API 需要活的 agent 句柄）
  const onAgentCreated = (payload) => {
    try {
      const agent = payload?.agent
      if (!agent || !settings.chatSessionId || agent.id !== settings.chatSessionId) return
      applyPermissionPreset(agent)
    } catch (error) {
      ctx.logger?.warn?.(`[wechat-bot] agent/created handler failed: ${error?.message ?? error}`)
    }
  }
  try {
    ctx.effect(() => ctx.on('agent/created', onAgentCreated))
  } catch (error) {
    ctx.logger?.warn?.(`[wechat-bot] agent/created subscription unavailable: ${error?.message ?? error}`)
  }

  ctx.effect(() => {
    if (settings.autoStart && rt.creds) pollLoop()
    return () => {
      disposed = true
      rt.loginGen = 0
      stops.poll.abort()
      stopWebRetry()
      chatRelay.abort()
      for (const tool of tools) void tool
      saveState()
    }
  })

  ctx.logger?.info?.(`[wechat-bot] ready (data=${DATA_DIR}, state=${rt.conn.state})`)
}

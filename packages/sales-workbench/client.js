/**
 * Client half of @mindlink-ai/dsh-sales-workbench（市场线索面板）。
 *
 * 左侧边栏注册「市场线索」入口（sidebar.panellist），主面板挂同名页面
 * （main，key 必须与侧边栏 id 一致）：
 *
 *   GET  /data-collector/state                 全部配置 + 统计 + 上次运行
 *   POST /data-collector/topics/save|delete    采集主题
 *   POST /data-collector/channels/save|delete  采集渠道
 *   POST /data-collector/channels/test         试抓一个渠道
 *   POST /data-collector/schedule              定时任务
 *   POST /data-collector/scope                 采集范围（地区）
 *   POST /data-collector/run                   立刻采集
 *   GET  /data-collector/results              线索（分页/检索/筛选）
 *   GET  /data-collector/results/export       导出 Excel（xlsx）
 *   POST /data-collector/results/clear        清空线索
 *   POST /data-collector/results/delete       删除单条线索
 *
 * 面板只通过同源 HTTP 路由与 Host 通信，不依赖 @deepseek-ai 任何 Client 包；
 * 颜色只用 --dsw-alias-* 主题 token（暗色主题自动适配）。
 */
window.__ModuleLoader__.load({
  id: '@mindlink-ai/dsh-sales-workbench',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    // ------------------------------------------------------------------ 常量
    const CHANNEL_TYPES = [
      { key: 'rss', label: 'RSS / Atom', hint: '订阅源地址，例如网站底部的 feed 链接' },
      { key: 'json', label: 'JSON 接口', hint: '返回 JSON 的开放接口；可指定数组路径与字段映射' },
      { key: 'html', label: '网页列表', hint: '普通网页里的链接列表；建议填「链接过滤」缩小范围' },
      { key: 'search', label: '网页搜索', hint: '用关键词搜最新结果，不需要 URL' },
    ]

    const MUTED = 'var(--dsw-alias-label-secondary, #6b7280)'
    const TEXT = 'var(--dsw-alias-label-primary, #111827)'
    const BORDER = 'var(--dsw-alias-border-l2, #d1d5db)'
    const BORDER_SUBTLE = 'var(--dsw-alias-border-l1, #e5e7eb)'
    const PANEL = 'var(--dsw-alias-bg-layer-1, #ffffff)'
    const NESTED = 'var(--dsw-alias-bg-layer-2, #f9fafb)'
    const BASE = 'var(--dsw-alias-bg-base, #f5f6f8)'
    const OVERLAY = 'var(--dsw-alias-bg-overlay, #ffffff)'
    const ACCENT = 'var(--dsw-alias-brand-primary, #2563eb)'
    const DANGER = 'var(--dsw-alias-state-error-primary, #b91c1c)'
    const OK = 'var(--dsw-alias-state-success-primary, #15803d)'
    const WARN = 'var(--dsw-alias-state-warn-primary, #b45309)'
    const IDLE = 'var(--dsw-alias-state-idle-primary, #6b7280)'
    // 彩色底纹：用 color-mix 从主题色派生，暗色主题会自动跟着变
    const mix = (color, percent) => `color-mix(in srgb, ${color} ${percent}%, transparent)`
    const ACCENT_SOFT = mix(ACCENT, 12)
    const ACCENT_TINT = mix(ACCENT, 7)
    const OK_SOFT = mix(OK, 13)
    const WARN_SOFT = mix(WARN, 14)
    const DANGER_SOFT = mix(DANGER, 12)
    const BRAND_GRADIENT = `linear-gradient(90deg, ${ACCENT}, ${OK})`

    const ROOT = { height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxSizing: 'border-box' }
    const HEADER = { padding: '18px 28px 0', flex: '0 0 auto' }
    const TABSTRIP = { padding: '8px 28px 0', display: 'flex', gap: 4, borderBottom: `1px solid ${BORDER_SUBTLE}`, flex: '0 0 auto' }
    const CONTENT = { padding: '16px 28px 24px', overflowY: 'auto', minHeight: 0, flex: '1 1 auto' }
    const TWO_COL = { display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }
    const LEFT_COL = { flex: '0 0 320px', position: 'sticky', top: 0, maxHeight: 'calc(100vh - 220px)', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }
    const RIGHT_COL = { flex: '1 1 420px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }
    const row = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }
    const card = { boxSizing: 'border-box', border: `1px solid ${BORDER_SUBTLE}`, borderRadius: 10, padding: '14px 16px', background: PANEL }
    const cardTitle = { fontSize: 13, fontWeight: 600, marginBottom: 8 }
    const hint = { fontSize: 12, color: MUTED, lineHeight: 1.5, marginTop: 0 }
    const input = { boxSizing: 'border-box', padding: '6px 9px', borderRadius: 7, border: `1px solid ${BORDER}`, background: PANEL, color: TEXT, fontSize: 12, outline: 'none', minWidth: 120 }
    const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }
    const clamp2 = { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }
    const sectionGrid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }
    const button = { boxSizing: 'border-box', padding: '6px 12px', borderRadius: 7, border: `1px solid ${BORDER}`, background: PANEL, color: TEXT, fontSize: 12, cursor: 'pointer' }
    const smallButton = { ...button, padding: '4px 9px', fontSize: 12 }
    const primaryButton = { ...button, background: ACCENT, borderColor: ACCENT, color: 'var(--dsw-alias-bg-layer-1, #ffffff)' }
    const dangerButton = { ...button, color: DANGER, borderColor: DANGER, background: DANGER_SOFT }
    const withDisabled = (style, disabled) => (disabled ? { ...style, opacity: 0.55, cursor: 'not-allowed' } : style)

    /** 状态色：成功/警告/失败/中性，用于标签、状态页签和统计卡。 */
    const TODAY_COLOR = `color-mix(in srgb, ${ACCENT} 55%, ${OK})`
    const TONES = {
      brand: { color: ACCENT, soft: ACCENT_SOFT },
      today: { color: TODAY_COLOR, soft: mix(TODAY_COLOR, 12) },
      ok: { color: OK, soft: OK_SOFT },
      warn: { color: WARN, soft: WARN_SOFT },
      danger: { color: DANGER, soft: DANGER_SOFT },
      idle: { color: IDLE, soft: mix(IDLE, 12) },
    }
    const toneOf = (tone) => TONES[tone] || TONES.idle

    // ------------------------------------------------------------------ 工具
    const msg = (error) => String((error && error.message) || error || '未知错误')
    const errText = (error) => (error && error.hint ? `${msg(error)}（${error.hint}）` : msg(error))

    const getJson = async (path) => {
      const response = await fetch(path, { headers: { accept: 'application/json' } })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data || data.ok === false) {
        const error = new Error((data && data.message) || `HTTP ${response.status}`)
        if (data && data.hint) error.hint = data.hint
        throw error
      }
      return data
    }
    const postJson = async (path, body) => {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body === undefined ? {} : body),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data || data.ok === false) {
        const error = new Error((data && data.message) || `HTTP ${response.status}`)
        if (data && data.hint) error.hint = data.hint
        throw error
      }
      return data
    }

    const fmtDateTime = (value) => {
      const text = String(value || '').trim()
      if (!text) return ''
      const date = new Date(text)
      if (Number.isNaN(date.getTime())) return text
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }
    const fmtDay = (value) => {
      const text = String(value || '').trim()
      if (!text) return ''
      const date = new Date(text)
      if (Number.isNaN(date.getTime())) return text
      return `${date.getMonth() + 1}月${date.getDate()}日`
    }
    const hostOf = (url) => {
      const text = String(url || '')
      try {
        return new URL(text).host
      } catch {
        return text
      }
    }
    const downloadFile = (url) => {
      if (typeof document === 'undefined') return
      const link = document.createElement('a')
      link.href = url
      link.rel = 'noreferrer'
      link.click()
    }

    const emptyTopicForm = () => ({ id: '', name: '', keywords: '', channelIds: [], notes: '', enabled: true })
    const topicFormOf = (topic) => ({
      id: topic ? topic.id : '',
      name: topic ? topic.name : '',
      keywords: topic ? (Array.isArray(topic.keywords) ? topic.keywords.join('、') : String(topic.keywords || '')) : '',
      channelIds: topic && Array.isArray(topic.channelIds) ? [...topic.channelIds] : [],
      notes: topic ? topic.notes || '' : '',
      enabled: topic ? Boolean(topic.enabled) : true,
    })

    const emptyChannelForm = () => ({
      id: '',
      name: '',
      type: 'rss',
      url: '',
      query: '',
      itemPath: '',
      fieldTitle: '',
      fieldLink: '',
      fieldDate: '',
      fieldSummary: '',
      fieldCompany: '',
      fieldContact: '',
      fieldPhone: '',
      fieldRegion: '',
      linkTemplate: '',
      linkPattern: '',
      followDetail: true,
      detailLimit: 5,
      region: '',
      limit: 30,
      enabled: true,
      note: '',
    })
    const channelFormOf = (channel) => {
      const next = emptyChannelForm()
      if (!channel) return next
      for (const key of Object.keys(next)) {
        if (channel[key] !== undefined && channel[key] !== null) next[key] = key === 'followDetail' ? channel[key] !== false : String(channel[key])
      }
      next.followDetail = channel.followDetail !== false
      next.detailLimit = channel.detailLimit === undefined ? 5 : Number(channel.detailLimit) || 0
      next.limit = Number(channel.limit) || 30
      next.enabled = channel.enabled !== false
      if (!CHANNEL_TYPES.some((item) => item.key === next.type)) next.type = 'rss'
      return next
    }

    const scheduleDraftOf = (schedule) => ({
      enabled: schedule ? schedule.enabled !== false : true,
      time: (schedule && schedule.time) || '07:30',
      timeZone: (schedule && schedule.timeZone) || 'Asia/Shanghai',
      catchUp: schedule ? schedule.catchUp !== false : true,
      retainDays: String((schedule && schedule.retainDays) || 30),
      maxItemsPerRun: String((schedule && schedule.maxItemsPerRun) || 200),
    })

    const scopeDraftOf = (scope) => ({
      regions: scope && Array.isArray(scope.regions) ? [...scope.regions] : ['内蒙古'],
      input: '',
      unknown: (scope && scope.unknown) || 'smart',
    })

    const REGION_QUICK = ['呼和浩特市', '包头市', '鄂尔多斯市', '赤峰市', '通辽市', '锡林郭勒盟', '乌兰察布市', '巴彦淖尔市', '呼伦贝尔市', '兴安盟', '乌海市', '阿拉善盟']

    const CHANNEL_PRESETS = [
      {
        name: '中国政府采购网·地方公告',
        type: 'html',
        url: 'http://www.ccgp.gov.cn/cggg/dfgg/',
        linkPattern: 't\\d{8}_\\d+\\.htm',
        detailLimit: 5,
        limit: 20,
        note: '全国政府采购公告（含内蒙古），中国政府采购网是服务端渲染，已验证可采集',
      },
      {
        name: '中国政府采购网·中央公告',
        type: 'html',
        url: 'http://www.ccgp.gov.cn/cggg/zygg/',
        linkPattern: 't\\d{8}_\\d+\\.htm',
        detailLimit: 5,
        limit: 20,
        note: '中央单位/部委采购公告，含消防救援、应急类项目',
      },
      {
        name: '内蒙古政府采购（搜索）',
        type: 'search',
        query: '内蒙古 政府采购 应急演练 招标公告',
        limit: 10,
        detailLimit: 4,
        note: '覆盖 JS 渲染的政府采购云平台',
      },
      {
        name: '内蒙古消防维保（搜索）',
        type: 'search',
        query: '内蒙古 消防 维保 采购 招标',
        limit: 10,
        detailLimit: 4,
        note: '消防维保/消防设施采购，常有联系人和电话',
      },
      {
        name: '内蒙古公共资源交易（搜索）',
        type: 'search',
        query: '内蒙古 公共资源交易 招标公告 演练',
        limit: 10,
        detailLimit: 4,
        note: '覆盖内蒙古及各盟市公共资源交易中心',
      },
      {
        name: '内蒙古应急预案（搜索）',
        type: 'search',
        query: '内蒙古 应急预案 编制 采购',
        limit: 10,
        detailLimit: 4,
        note: '预案编制/修订类服务采购',
      },
      {
        name: '内蒙古演练培训（搜索）',
        type: 'search',
        query: '内蒙古 应急演练 培训 服务 采购',
        limit: 10,
        detailLimit: 4,
        note: '演练/培训服务采购，最贴近演练业务',
      },
      {
        name: '演练服务商（搜索）',
        type: 'search',
        query: '内蒙古 应急演练服务 公司 联系电话',
        limit: 10,
        detailLimit: 3,
        note: '直接找提供应急演练服务的公司（主要客户），常带电话',
      },
      {
        name: '演练服务中标（搜索）',
        type: 'search',
        query: '内蒙古 应急演练 中标 结果公告 供应商',
        limit: 10,
        detailLimit: 4,
        note: '中标公告里的「中标供应商」就是做演练服务的公司，会被识别为服务商线索',
      },
      {
        name: '安全技术咨询（搜索）',
        type: 'search',
        query: '内蒙古 消防技术服务机构 安全评价 演练',
        limit: 10,
        detailLimit: 3,
        note: '安全评价/消防技术咨询机构，演练服务的外包方',
      },
      {
        name: '消防培训机构（搜索）',
        type: 'search',
        query: '内蒙古 消防培训 机构 演练 公司',
        limit: 10,
        detailLimit: 3,
        note: '消防培训机构/宣传中心，需要演练系统做培训演示',
      },
      {
        name: '应急预案编制公司（搜索）',
        type: 'search',
        query: '内蒙古 应急预案编制 公司 技术服务',
        limit: 10,
        detailLimit: 3,
        note: '预案编制/安全技术服务公司，演练是它们的配套业务',
      },
      {
        name: '内蒙古安责险·技术服务机构（API）',
        type: 'json',
        url: 'https://www.nmganzx.com/prod-api/anonymity/organization/list/page?pageNum=1&pageSize=50',
        itemPath: 'rows',
        fieldCompany: 'orgName',
        fieldContact: 'contactPerson',
        fieldPhone: 'contactPhone',
        fieldRegion: 'provinceCityArea',
        followDetail: false,
        limit: 50,
        note: '安责险平台入驻的安全技术服务机构名录，直接带联系人和电话（主要客户）',
      },
      {
        name: '内蒙古安责险·保险机构（API）',
        type: 'json',
        url: 'https://www.nmganzx.com/prod-api/anonymity/insurance/list/page?pageNum=1&pageSize=50',
        itemPath: 'rows',
        fieldCompany: 'companyName',
        fieldContact: 'contactPerson',
        fieldPhone: 'contactPhone',
        fieldRegion: 'provinceCityArea',
        followDetail: false,
        limit: 50,
        note: '安责险承保机构名录，是演练服务的渠道合作方',
      },
      {
        name: '内蒙古公共资源交易平台（API）',
        type: 'json',
        url: 'https://ggzyjy.nmg.gov.cn/trssearch/openSearch/searchPublishResource?noticeName={query}&pageSize=20&pageNum=1&regionCode=150000',
        query: '应急演练',
        itemPath: 'data.data',
        fieldTitle: 'noticeName',
        linkTemplate: 'https://ggzyjy.nmg.gov.cn/jyxx/index_39.html?id={sourceDataKey}',
        followDetail: false,
        limit: 20,
        note: '自治区公共资源交易平台官方接口（结构化 JSON），regionCode 可换盟市码：150100 呼和浩特、150200 包头、150600 鄂尔多斯',
      },
    ]

    // ------------------------------------------------------------------ 小组件
    function Tag({ tone = 'neutral', children }) {
      const palette = toneOf(tone)
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', padding: '0 7px', borderRadius: 999, border: `1px solid ${mix(palette.color, 45)}`, background: palette.soft, color: palette.color, fontSize: 11, lineHeight: '18px', whiteSpace: 'nowrap', fontWeight: 500 } }, children)
    }

    function Stat({ label, value, accent, tone = 'brand' }) {
      const palette = toneOf(tone)
      const color = accent || palette.color
      return h(
        'div',
        { style: { ...card, padding: '10px 12px 10px 14px', display: 'flex', flexDirection: 'column', gap: 4, borderColor: mix(palette.color, 25), background: mix(palette.color, 5), borderLeft: `3px solid ${color}` } },
        h('div', { style: { ...hint, marginTop: 0 } }, label),
        h('div', { style: { fontSize: 16, fontWeight: 700, color } }, value),
      )
    }

    function Field({ label, hint: fieldHint, children }) {
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
        h('div', { style: { fontSize: 12, color: MUTED } }, label),
        children,
        fieldHint ? h('div', { style: hint }, fieldHint) : null,
      )
    }

    function Check({ checked, onChange, children }) {
      return h(
        'label',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' } },
        h('input', { type: 'checkbox', checked, onChange: (event) => onChange(event.target.checked) }),
        h('span', null, children),
      )
    }

    function Progress({ runtime }) {
      if (!runtime || !runtime.runId) return null
      const done = Number(runtime.done) || 0
      const total = Number(runtime.total) || 0
      const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
      return h(
        'div',
        { style: { ...card, marginBottom: 12, borderColor: mix(ACCENT, 30), background: ACCENT_TINT } },
        h(
          'div',
          { style: { ...row, justifyContent: 'space-between', marginBottom: 6 } },
          h('span', { style: { fontWeight: 600, color: ACCENT } }, '正在采集…'),
          h('span', { style: hint }, `${done}/${total} 个渠道`),
        ),
        h('div', { style: { height: 6, borderRadius: 999, background: mix(ACCENT, 16), overflow: 'hidden' } }, h('div', { style: { height: '100%', width: `${percent}%`, background: BRAND_GRADIENT } })),
        runtime.current ? h('div', { style: { ...hint, marginTop: 6 } }, `当前：${runtime.current}`) : null,
      )
    }

    function EmptyHint({ title, text, children }) {
      return h(
        'div',
        { style: { ...card, background: NESTED, borderStyle: 'dashed' } },
        h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, title),
        text ? h('div', { style: { ...hint, marginBottom: 10 } }, text) : null,
        h('div', { style: row }, children),
      )
    }

    // ------------------------------------------------------------------ 总览
    function RunSummary({ run }) {
      if (!run) return null
      const statusColor = run.status === 'failed' ? DANGER : run.status === 'partial' ? WARN : OK
      const statusLabel = run.status === 'failed' ? '失败' : run.status === 'partial' ? '部分成功' : '成功'
      const tasks = Array.isArray(run.tasks) ? run.tasks : []
      return h(
        'div',
        { style: card },
        h('div', { style: { ...cardTitle, display: 'flex', gap: 8, alignItems: 'center' } }, '最近运行', h('span', { style: { color: statusColor } }, statusLabel)),
        h('div', { style: { ...hint, marginBottom: 8 } }, `${fmtDateTime(run.startedAt)} · ${run.trigger === 'auto' ? '定时' : run.trigger === 'startup' ? '启动补采' : '手动'}`),
        h(
          'div',
          { style: sectionGrid },
          h(Stat, { label: '新增线索', value: String(run.newItems || 0) }),
          h(Stat, { label: '其中含电话', value: String(run.withPhone || 0) }),
          h(Stat, { label: '已存在跳过', value: String(run.duplicate || 0) }),
          h(Stat, { label: '无联系方式跳过', value: String(run.skipped || 0) }),
          h(Stat, { label: '地区外跳过', value: String(run.outOfRegion || 0) }),
        ),
        h(
          'div',
          { style: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 } },
          tasks.map((task, index) =>
            h(
              'div',
              { key: `${task.channelName}-${index}`, style: { ...row, ...hint, gap: 6, marginTop: 0 } },
              h('span', { style: { color: task.status === 'failed' ? DANGER : OK } }, task.status === 'failed' ? '✕' : '✓'),
              h('span', { style: { color: TEXT } }, task.channelName),
              h('span', null, `${task.count || 0} 条线索（${task.withPhone || 0} 有电话）${task.details ? `，${task.details} 详情页` : ''}`),
              task.error ? h('span', { style: { color: DANGER } }, task.error) : null,
            ),
          ),
        ),
      )
    }

    function OverviewTab({ data, onSelectTab }) {
      const stats = data.stats || {}
      const schedule = data.schedule || {}
      const run = stats.lastRun || null
      const topics = data.topics || []
      const channels = data.channels || []
      const onboarding = topics.length === 0 || channels.length === 0
      const lastRunAt = run && run.startedAt ? fmtDateTime(run.startedAt) : '—'
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h(Progress, { runtime: data.runtime }),
        onboarding
          ? h(
              'div',
              { style: { ...card, borderColor: mix(ACCENT, 45), background: ACCENT_TINT } },
              h('div', { style: { ...cardTitle, color: ACCENT } }, '三步开始采集'),
              h('div', { style: hint }, '先加渠道（从哪里抓），再加主题与地区（关注什么、收哪里），之后每天定时自动采集；也可以随时在「线索」页点「立即采集」。'),
              h(
                'div',
                { style: { ...row, marginTop: 10 } },
                h('button', { type: 'button', style: primaryButton, onClick: () => onSelectTab('channels') }, '① 去添加渠道'),
                h('button', { type: 'button', style: smallButton, onClick: () => onSelectTab('topics') }, '② 去添加主题与地区'),
              ),
            )
          : null,
        h(
          'div',
          { style: sectionGrid },
          h(Stat, { label: '采集主题', value: `${stats.topics || 0} 个`, tone: 'brand' }),
          h(Stat, { label: '采集渠道', value: `${stats.enabledChannels || 0} / ${stats.channels || 0} 个启用`, tone: 'ok' }),
          h(Stat, { label: `线索（${stats.today || '—'}，含电话 ${stats.withPhoneToday || 0}）`, value: `${stats.itemsTotal || 0} 条`, tone: 'warn' }),
          h(Stat, { label: '下次采集', value: schedule.enabled ? schedule.nextRunLabel || '—' : '已关闭', tone: 'idle' }),
        ),
        h(
          'div',
          { style: card },
          h('div', { style: cardTitle }, '定时任务'),
          h('div', { style: { ...row, gap: 16 } }, h('span', { style: hint }, `每天 ${schedule.time || '07:30'}（${schedule.timeZone || 'Asia/Shanghai'}）`), h('span', { style: hint }, `上次采集：${lastRunAt}`)),
          h('div', { style: { ...hint, marginTop: 6 } }, `当前范围：${(data.scope && data.scope.label) || '不限地区'}`),
        ),
        run ? h(RunSummary, { run }) : h('div', { style: { ...card, ...hint } }, '还没有运行过。'),
        run && Array.isArray(run.tasks) && run.tasks.length > 0
          ? h(
              'div',
              { style: card },
              h('div', { style: cardTitle }, '渠道情况'),
              run.tasks.map((task, index) =>
                h(
                  'div',
                  { key: `${task.channelName}-${index}`, style: { ...hint, marginTop: 2 } },
                  `${task.channelName} · ${task.count || 0} 条线索（${task.withPhone || 0} 有电话）${task.details ? `，${task.details} 详情页` : ''}`,
                ),
              ),
            )
          : null,
        (stats.dates || []).length > 0
          ? h(
              'div',
              { style: card },
              h('div', { style: cardTitle }, '最近每天的条目数'),
              h(
                'div',
                { style: { ...row, gap: 6 } },
                stats.dates.slice(0, 10).map((bucket) =>
                  h(
                    'button',
                    { key: bucket.date, type: 'button', style: smallButton, onClick: () => onSelectTab('results', bucket.date) },
                    `${bucket.date.slice(5)}（${bucket.count}）`,
                  ),
                ),
              ),
            )
          : null,
      )
    }

    // ------------------------------------------------------------------ 采集范围
    function ScopeCard({ data, draft, setDraft, onSave, busy }) {
      const scope = data.scope || {}
      const addRegion = (value) => {
        const text = String(value || '').trim()
        if (!text) return
        if (draft.regions.includes(text)) return
        setDraft({ ...draft, regions: [...draft.regions, text], input: '' })
      }
      const removeRegion = (value) => setDraft({ ...draft, regions: draft.regions.filter((item) => item !== value) })
      return h(
        'div',
        { style: card },
        h('div', { style: { ...cardTitle, display: 'flex', gap: 8, alignItems: 'center' } }, '采集范围（地区）', h(Tag, { tone: 'warn' }, '只保留地区命中范围的线索')),
        h(
          'div',
          { style: { ...hint, marginBottom: 8 } },
          `当前范围：${scope.label || '不限地区'}（${(scope.keywords || []).length} 个匹配关键词）。地区可以逐个添加城市，例如呼和浩特市、包头市；也可直接用「内蒙古」覆盖全区。`,
        ),
        h(
          'div',
          { style: { ...row, marginBottom: 8 } },
          draft.regions.map((region) =>
            h(
              'span',
              { key: region, style: { ...row, gap: 4, padding: '2px 4px 2px 8px', border: `1px solid ${BORDER}`, borderRadius: 999, fontSize: 12 } },
              region,
              h(
                'button',
                {
                  type: 'button',
                  'aria-label': `移除 ${region}`,
                  style: { ...smallButton, border: 'none', padding: '0 4px', lineHeight: '16px', background: 'transparent', color: MUTED },
                  onClick: () => removeRegion(region),
                },
                '×',
              ),
            ),
          ),
          draft.regions.length === 0 ? h('span', { style: hint }, '未设置：不限地区') : null,
        ),
        h(
          'div',
          { style: { ...row, marginBottom: 8 } },
          h('input', {
            style: { ...input, flex: '1 1 200px' },
            value: draft.input,
            placeholder: '输入城市或省份，例如：呼和浩特市',
            onChange: (event) => setDraft({ ...draft, input: event.target.value }),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                addRegion(draft.input)
              }
            },
          }),
          h('button', { type: 'button', style: smallButton, onClick: () => addRegion(draft.input) }, '添加'),
          h('button', { type: 'button', style: smallButton, onClick: () => setDraft({ ...draft, regions: [] }) }, '不限地区'),
          h('button', { type: 'button', style: smallButton, onClick: () => setDraft({ ...draft, regions: ['内蒙古'] }) }, '用内蒙古全省'),
        ),
        h(
          'div',
          { style: { ...row, marginBottom: 8 } },
          h('span', { style: hint }, '快捷添加：'),
          REGION_QUICK.filter((city) => !draft.regions.includes(city)).map((city) =>
            h('button', { key: city, type: 'button', style: smallButton, onClick: () => addRegion(city) }, `＋${city}`),
          ),
        ),
        h(
          'div',
          { style: { ...row, marginBottom: 8 } },
          h(Field, { label: '地区识别不出来时' }, h(
            'select',
            { style: { ...input, width: 'auto' }, value: draft.unknown, onChange: (event) => setDraft({ ...draft, unknown: event.target.value }) },
            h('option', { value: 'smart' }, '智能判断（推荐）'),
            h('option', { value: 'keep' }, '保留：地区不明也留下（更全，可能混入外地）'),
            h('option', { value: 'drop' }, '丢弃：只留明确命中地区的'),
          )),
        ),
        h(
          'div',
          { style: { ...row, justifyContent: 'space-between' } },
          h('div', { style: hint }, `当前：${scope.summary || '不限地区'}`),
          h('button', { type: 'button', style: withDisabled(primaryButton, busy === 'scope'), disabled: busy === 'scope', onClick: onSave }, '保存范围'),
        ),
      )
    }

    // ------------------------------------------------------------------ 主题页
    function TopicsTab(props) {
      const { data, topicSel, form, setForm, onSelect, onNew, onSave, onDelete, busy, dirty, scopeDraft, setScopeDraft, onSaveScope } = props
      const topics = data.topics || []
      const channels = data.channels || []
      const selected = topics.find((topic) => topic.id === form.id) || null
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h(ScopeCard, { data, draft: scopeDraft, setDraft: setScopeDraft, onSave: onSaveScope, busy }),
        h(
          'div',
          { style: TWO_COL },
          h(
            'div',
            { style: LEFT_COL },
            h('button', { type: 'button', style: { ...button, width: '100%', textAlign: 'center', marginBottom: 4 }, onClick: onNew }, '＋ 新建主题'),
            topics.length === 0
              ? h('div', { style: { ...card, ...hint } }, '还没有采集主题。主题决定「关注什么」：标题或摘要命中关键词的页面才会进入线索识别。')
              : topics.map((topic) =>
                  h(
                    'button',
                    {
                      key: topic.id,
                      type: 'button',
                      style: { ...card, textAlign: 'left', cursor: 'pointer', borderColor: topic.id === form.id ? ACCENT : BORDER_SUBTLE, borderLeft: `3px solid ${topic.id === form.id ? ACCENT : 'transparent'}`, background: topic.id === form.id ? ACCENT_TINT : PANEL },
                      onClick: () => onSelect(topic.id),
                    },
                    h('div', { style: { ...cardTitle, marginBottom: 4 } }, topic.name || '未命名主题'),
                    h('div', { style: { ...hint, marginTop: 0 } }, `${(topic.keywords || []).join('、') || '无关键词'}`),
                    h('div', { style: hint }, topic.channelIds && topic.channelIds.length > 0 ? `${topic.channelIds.length} 个渠道` : '全部渠道'),
                  ),
                ),
          ),
          h(
            'div',
            { style: RIGHT_COL },
            h(
              'div',
              { style: card },
              h('div', { style: { ...cardTitle, display: 'flex', gap: 8, alignItems: 'center' } }, form.id ? `编辑主题：${form.name || '未命名'}` : '新建采集主题', dirty ? h(Tag, { tone: 'warn' }, '未保存') : null),
              h(Field, { label: '主题名称' }, h('input', { style: input, value: form.name, placeholder: '例如：应急演练行业', onChange: (event) => setForm({ ...form, name: event.target.value }) })),
              h(Field, { label: '关键词', hint: '标题或摘要命中任一关键词即视为相关，多个用顿号分隔。' }, h('input', { style: input, value: form.keywords, placeholder: '应急演练、消防、预案、招标', onChange: (event) => setForm({ ...form, keywords: event.target.value }) })),
              h(Field, { label: '备注' }, h('input', { style: input, value: form.notes, placeholder: '可选', onChange: (event) => setForm({ ...form, notes: event.target.value }) })),
              h(
                'div',
                { style: { marginTop: 10 } },
                h('div', { style: { ...hint, marginBottom: 4 } }, '关注渠道（不选=全部渠道）'),
                channels.map((channel) =>
                  h(
                    'label',
                    { key: channel.id, style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, marginBottom: 2 } },
                    h('input', {
                      type: 'checkbox',
                      checked: form.channelIds.includes(channel.id),
                      onChange: (event) => {
                        const checked = event.target.checked
                        setForm({ ...form, channelIds: checked ? [...form.channelIds, channel.id] : form.channelIds.filter((id) => id !== channel.id) })
                      },
                    }),
                    `${channel.name} · ${channel.typeLabel || channel.type}`,
                  ),
                ),
              ),
              h(
                'div',
                { style: { ...row, marginTop: 12 } },
                h('button', { type: 'button', style: withDisabled(primaryButton, busy === 'topic-save'), disabled: busy === 'topic-save', onClick: onSave }, '保存主题'),
                form.id
                  ? h('button', { type: 'button', style: busy === 'topic-confirm' ? dangerButton : smallButton, onClick: onDelete }, busy === 'topic-confirm' ? '确认删除主题' : '删除主题')
                  : null,
                selected ? h('span', { style: hint }, `创建于 ${fmtDateTime(selected.createdAt)}`) : null,
              ),
            ),
          ),
        ),
      )
    }

    // ------------------------------------------------------------------ 渠道页
    function PresetCard({ presets, channels, onAdd, onAddAll, busy }) {
      const existing = new Set((channels || []).map((channel) => channel.name))
      const missing = presets.filter((preset) => !existing.has(preset.name))
      return h(
        'div',
        { style: { ...card, marginBottom: 12 } },
        h('div', { style: { ...row, justifyContent: 'space-between', marginBottom: 4 } }, h('span', { style: cardTitle }, '常用平台（一键添加）'), h(Tag, { tone: 'brand' }, `内置 ${presets.length} 个`)),
        h('div', { style: { ...hint, marginBottom: 8 } }, '已实测过的平台清单：中国政府采购网是服务端渲染、能直接抓；内蒙古各级公共资源交易网站多是 JS 渲染或接口加密，抓不到列表，改用定向搜索覆盖（搜索结果里常有产权交易、政府采购云平台的公告）。'),
        h(
          'div',
          { style: { ...row, gap: 6 } },
          presets.map((preset) => {
            const has = existing.has(preset.name)
            return h(
              'button',
              { key: preset.name, type: 'button', title: preset.note || '', style: has ? { ...smallButton, opacity: 0.55 } : smallButton, disabled: has || Boolean(busy), onClick: () => onAdd(preset) },
              `${has ? '✓ ' : '＋'}${preset.name}`,
            )
          }),
        ),
        missing.length > 0
          ? h('button', { type: 'button', style: { ...primaryButton, marginTop: 8 }, disabled: Boolean(busy), onClick: onAddAll }, `一键添加全部（${missing.length} 个）`)
          : h('div', { style: { ...hint, marginTop: 6 } }, '预置平台都已添加，可直接采集。'),
      )
    }

    function ChannelEditor({ form, setForm, onSave, onDelete, onTest, busy, testResult, dirty }) {
      const set = (patch) => setForm({ ...form, ...patch })
      const isSearch = form.type === 'search'
      const typeHint = (CHANNEL_TYPES.find((item) => item.key === form.type) || {}).hint || ''
      return h(
        'div',
        { style: card },
        h('div', { style: { ...cardTitle, display: 'flex', gap: 8, alignItems: 'center' } }, form.id ? `编辑渠道：${form.name || '未命名'}` : '新建采集渠道', dirty ? h(Tag, { tone: 'warn' }, '未保存') : null),
        h(Field, { label: '名称' }, h('input', { style: input, value: form.name, placeholder: '例如：应急管理部·通知公告', onChange: (event) => set({ name: event.target.value }) })),
        h(
          Field,
          { label: '渠道类型' },
          h(
            'select',
            { style: input, value: form.type, onChange: (event) => set({ type: event.target.value }) },
            CHANNEL_TYPES.map((item) => h('option', { key: item.key, value: item.key }, item.label)),
          ),
        ),
        h('div', { style: hint }, typeHint),
        isSearch
          ? h(Field, { label: '搜索词', hint: '留空则用主题关键词搜索。' }, h('input', { style: input, value: form.query, placeholder: '应急演练 内蒙古 招标', onChange: (event) => set({ query: event.target.value }) }))
          : h(Field, { label: '链接 *' }, h('input', { style: input, value: form.url, placeholder: form.type === 'json' ? 'https://api.example.com/list?page=1' : 'https://www.example.com/news/', onChange: (event) => set({ url: event.target.value }) })),
        form.type === 'html'
          ? h(Field, { label: '链接过滤（可选）', hint: '只保留命中该正则的链接，例如 /tzgg/ 或 t\\d{8}_\\d+。' }, h('input', { style: input, value: form.linkPattern, placeholder: '/tzgg/|t\\d{8}_\\d+\\.htm', onChange: (event) => set({ linkPattern: event.target.value }) }))
          : null,
        form.type === 'json'
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              h(Field, { label: '数组路径（可选）', hint: '例如 data.list；不填会自动找第一个数组。' }, h('input', { style: input, value: form.itemPath, placeholder: 'data.list', onChange: (event) => set({ itemPath: event.target.value }) })),
              h(
                'div',
                { style: sectionGrid },
                h(Field, { label: '标题字段' }, h('input', { style: input, value: form.fieldTitle, placeholder: 'title', onChange: (event) => set({ fieldTitle: event.target.value }) })),
                h(Field, { label: '链接字段' }, h('input', { style: input, value: form.fieldLink, placeholder: 'link', onChange: (event) => set({ fieldLink: event.target.value }) })),
                h(Field, { label: '时间字段' }, h('input', { style: input, value: form.fieldDate, placeholder: 'publishTime', onChange: (event) => set({ fieldDate: event.target.value }) })),
                h(Field, { label: '摘要字段' }, h('input', { style: input, value: form.fieldSummary, placeholder: 'abstract', onChange: (event) => set({ fieldSummary: event.target.value }) })),
              ),
              h(
                'div',
                { style: sectionGrid },
                h(Field, { label: '公司字段（名录）' }, h('input', { style: input, value: form.fieldCompany, placeholder: 'orgName', onChange: (event) => set({ fieldCompany: event.target.value }) })),
                h(Field, { label: '联系人字段' }, h('input', { style: input, value: form.fieldContact, placeholder: 'contactPerson', onChange: (event) => set({ fieldContact: event.target.value }) })),
                h(Field, { label: '电话字段' }, h('input', { style: input, value: form.fieldPhone, placeholder: 'contactPhone', onChange: (event) => set({ fieldPhone: event.target.value }) })),
                h(Field, { label: '地区字段' }, h('input', { style: input, value: form.fieldRegion, placeholder: 'provinceCityArea', onChange: (event) => set({ fieldRegion: event.target.value }) })),
              ),
              h(Field, { label: '链接模板（列表只给 ID 时用）', hint: '例如 https://site/detail?id={sourceDataKey}' }, h('input', { style: input, value: form.linkTemplate, placeholder: 'https://site/detail?id={sourceDataKey}', onChange: (event) => set({ linkTemplate: event.target.value }) })),
              h('div', { style: hint }, '填了公司/电话字段就按「名录」处理：字段直映射，不按关键词筛；URL 里可用 {query} 插入查询词。'),
            )
          : null,
        h(
          'div',
          { style: sectionGrid },
          h(Field, { label: '每次最多取多少条', hint: '单个渠道一次最多产出多少条线索（1-200）。' }, h('input', { style: input, type: 'number', min: 1, max: 200, value: form.limit, onChange: (event) => set({ limit: event.target.value }) })),
          h(Field, { label: '每个渠道最多抓几个详情页', hint: '0 表示不抓详情页（更快）。' }, h('input', { style: input, type: 'number', min: 0, max: 20, value: form.detailLimit, onChange: (event) => set({ detailLimit: event.target.value }) })),
          h(Field, { label: '地区兜底', hint: '页面里识别不出地区时用。' }, h('input', { style: input, value: form.region, placeholder: '呼和浩特市', onChange: (event) => set({ region: event.target.value }) })),
        ),
        h('div', { style: { marginTop: 8 } }, h(Check, { checked: form.followDetail, onChange: (value) => set({ followDetail: value }) }, '缺字段时跟进详情页补全联系人/电话')),
        h(Field, { label: '备注' }, h('input', { style: input, value: form.note, placeholder: '可选，说明这个渠道的用途', onChange: (event) => set({ note: event.target.value }) })),
        h(
          'div',
          { style: { ...row, marginTop: 12 } },
          h('button', { type: 'button', style: withDisabled(primaryButton, busy === 'channel-save'), disabled: busy === 'channel-save', onClick: onSave }, '保存渠道'),
          h('button', { type: 'button', style: withDisabled(smallButton, busy === 'channel-test'), disabled: busy === 'channel-test', onClick: onTest }, '测试渠道'),
          form.id ? h('button', { type: 'button', style: busy === 'channel-confirm' ? dangerButton : smallButton, onClick: onDelete }, busy === 'channel-confirm' ? '确认删除渠道' : '删除渠道') : null,
        ),
        testResult
          ? h(
              'div',
              { style: { ...card, marginTop: 10, background: NESTED } },
              testResult.success
                ? h(
                    'div',
                    null,
                    h('div', { style: { ...row, marginBottom: 6 } }, h(Tag, { tone: 'ok' }, '可以识别'), h('span', { style: hint }, `${testResult.ms || 0} ms`)),
                    h('div', { style: hint }, `${testResult.leadCount || 0} 条线索（${testResult.withPhone || 0} 条有电话）`),
                    (testResult.samples || []).map((sample, index) =>
                      h(
                        'div',
                        { key: index, style: { marginTop: 6, fontSize: 12, lineHeight: 1.6 } },
                        h('div', { style: { fontWeight: 600 } }, sample.company || sample.title || '（未识别公司）'),
                        h('div', { style: hint }, `${sample.contact ? `联系人：${sample.contact} ` : ''}${sample.phone ? `电话：${sample.phone} ` : ''}${sample.region || ''}`),
                      ),
                    ),
                  )
                : h('div', { style: { color: DANGER, fontSize: 12 } }, testResult.message || '测试失败'),
            )
          : null,
      )
    }

    function ChannelsTab(props) {
      const { data, channelSel, form, setForm, onSelect, onNew, onSave, onDelete, onTest, busy, testResult, dirty, onAddPreset, onAddAllPresets } = props
      const channels = data.channels || []
      return h(
        'div',
        null,
        h(PresetCard, { presets: CHANNEL_PRESETS, channels, onAdd: onAddPreset, onAddAll: onAddAllPresets, busy }),
        h(
          'div',
          { style: TWO_COL },
          h(
            'div',
            { style: LEFT_COL },
            h('button', { type: 'button', style: { ...button, width: '100%', textAlign: 'center', marginBottom: 4 }, onClick: onNew }, '＋ 新建渠道'),
            channels.length === 0
              ? h('div', { style: { ...card, ...hint } }, '还没有渠道。支持 RSS、JSON 接口、网页列表和网页搜索。')
              : channels.map((channel) =>
                  h(
                    'button',
                    {
                      key: channel.id,
                      type: 'button',
                      style: { ...card, textAlign: 'left', cursor: 'pointer', borderColor: channel.id === channelSel ? ACCENT : BORDER_SUBTLE, borderLeft: `3px solid ${channel.id === channelSel ? ACCENT : 'transparent'}`, background: channel.id === channelSel ? ACCENT_TINT : PANEL },
                      onClick: () => onSelect(channel.id),
                    },
                    h('div', { style: { ...row, justifyContent: 'space-between', marginBottom: 4 } }, h('span', { style: { fontWeight: 600, fontSize: 13 } }, channel.name || '未命名渠道'), h(Tag, { tone: channel.enabled ? 'neutral' : 'warn' }, channel.enabled ? channel.typeLabel || channel.type : '已停用')),
                    h('div', { style: { ...hint, marginTop: 0 } }, channel.url || channel.query || '—'),
                    channel.lastStatus
                      ? h('div', { style: hint }, `${channel.lastStatus === 'ok' ? '成功' : '失败'} · ${channel.lastCount || 0} 条线索 · ${channel.lastWithPhone || 0} 条有电话${channel.lastError ? ` · ${channel.lastError}` : ''}`)
                      : h('div', { style: hint }, '还未运行'),
                  ),
                ),
          ),
          h('div', { style: RIGHT_COL }, h(ChannelEditor, { form, setForm, onSave, onDelete, onTest, busy, testResult, dirty })),
        ),
      )
    }

    // ------------------------------------------------------------------ 定时页
    function ScheduleTab({ data, draft, setDraft, onSave, onRun, busy }) {
      const schedule = data.schedule || {}
      const set = (patch) => setDraft({ ...draft, ...patch })
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h(
          'div',
          { style: card },
          h('div', { style: cardTitle }, '定时任务'),
          h(Check, { checked: draft.enabled, onChange: (value) => set({ enabled: value }) }, '启用每日定时采集'),
          h('div', { style: { ...row, marginTop: 10 } },
            h(Field, { label: '每天几点' }, h('input', { style: { ...input, width: 90 }, value: draft.time, placeholder: '07:30', onChange: (event) => set({ time: event.target.value }) })),
            h(Field, { label: '时区' }, h('input', { style: { ...input, width: 180 }, value: draft.timeZone, onChange: (event) => set({ timeZone: event.target.value }) })),
          ),
          h('div', { style: { ...row, marginTop: 10 } },
            h(Field, { label: '结果保留天数', hint: '超过天数的条目与去重记录会被清理（1-365）。' }, h('input', { style: { ...input, width: 90 }, type: 'number', min: 1, max: 365, value: draft.retainDays, onChange: (event) => set({ retainDays: event.target.value }) })),
            h(Field, { label: '单次采集上限（条）', hint: '一次最多收录多少条，避免首次采集把库撑满（10-1000）。' }, h('input', { style: { ...input, width: 100 }, type: 'number', min: 10, max: 1000, value: draft.maxItemsPerRun, onChange: (event) => set({ maxItemsPerRun: event.target.value }) })),
          ),
          h('div', { style: { marginTop: 10 } }, h(Check, { checked: draft.catchUp, onChange: (value) => set({ catchUp: value }) }, '启动时补采错过的时间点')),
          h('div', { style: { ...row, marginTop: 12 } },
            h('button', { type: 'button', style: withDisabled(primaryButton, busy === 'schedule-save'), disabled: busy === 'schedule-save', onClick: onSave }, '保存定时'),
            h('button', { type: 'button', style: withDisabled(button, busy === 'run' || Boolean(data.runtime)), disabled: busy === 'run' || Boolean(data.runtime), onClick: onRun }, '立即采集'),
          ),
        ),
        h(
          'div',
          { style: card },
          h('div', { style: cardTitle }, '当前状态'),
          h('div', { style: sectionGrid },
            h(Stat, { label: '下次采集', value: schedule.enabled ? schedule.nextRunLabel || '—' : '已关闭', accent: ACCENT }),
            h(Stat, { label: '上次采集', value: schedule.lastRunLabel || '—' }),
            h(Stat, { label: '上次结果', value: schedule.lastRunStatusLabel ? `${schedule.lastRunStatusLabel} · ${schedule.lastRunNew || 0} 条` : '—' }),
          ),
          h('div', { style: { ...hint, marginTop: 8 } }, '采集是插件自己的计时器：Harness 关闭时不采集，重新打开后如果错过了当天时间点，会在启动约 20 秒后补采一次。'),
        ),
      )
    }

    // ------------------------------------------------------------------ 线索页
    const LEAD_COLUMNS = ['公司名称', '联系人', '联系电话', '地区', '采集时间', '操作']

    const leadLine = (lead) => [lead.company || lead.title || '', lead.contact || '', lead.phone || '', lead.region || '', lead.sourceUrl || ''].join('\t')

    /** 这条线索能不能勾选写入 CRM：必须有电话，且还没同步过。 */
    const selectable = (item) => Boolean(item && item.phone) && item.syncState !== 'synced'

    function LeadRow({ item, onDelete, onShowDetail, busy, selected, onToggleSelect, onCrmPushOne }) {
      const muted = (text) => (text ? text : '—')
      const confirming = busy === `lead-confirm:${item.id}`
      const canSelect = selectable(item)
      const pushing = busy === `crm-one:${item.id}`
      return h(
        'tr',
        { style: { borderTop: `1px solid ${BORDER_SUBTLE}`, background: selected ? NESTED : 'transparent' } },
        h(
          'td',
          { style: { padding: '8px 6px 8px 0', verticalAlign: 'top' } },
          h('input', { type: 'checkbox', checked: selected, disabled: !canSelect, title: canSelect ? '勾选后可写入 CRM' : item.syncState === 'synced' ? '已同步' : '没有手机号，不能写入 CRM', onChange: () => onToggleSelect(item) }),
        ),
        h(
          'td',
          { style: { padding: '8px 8px 8px 0', verticalAlign: 'top', fontWeight: 500, ...clamp2 } },
          item.company || item.title || '（未识别公司）',
          item.syncState === 'synced' ? h('span', { style: { marginLeft: 6, fontSize: 11, color: OK, fontWeight: 600 } }, '● 已同步') : null,
          item.sourceName ? h('div', { style: { ...hint, marginTop: 2, fontWeight: 400 } }, item.sourceName) : null,
        ),
        h('td', { style: { padding: '8px 8px 8px 0', verticalAlign: 'top', whiteSpace: 'nowrap' } }, muted(item.contact)),
        h('td', { style: { padding: '8px 8px 8px 0', verticalAlign: 'top', whiteSpace: 'nowrap', ...mono } }, item.phone ? h('span', { style: { color: ACCENT, fontWeight: 600 } }, item.phone) : h('span', { style: { color: WARN } }, '无手机号')),
        h('td', { style: { padding: '8px 8px 8px 0', verticalAlign: 'top', whiteSpace: 'nowrap' } }, muted(item.region)),
        h('td', { style: { padding: '8px 0 8px 8px', verticalAlign: 'top', whiteSpace: 'nowrap', ...mono, color: MUTED } }, fmtDateTime(item.fetchedAt) || '—'),
        h(
          'td',
          { style: { padding: '8px 0 8px 8px', verticalAlign: 'top', whiteSpace: 'nowrap' } },
          item.syncState === 'synced'
            ? null
            : h('button', { type: 'button', style: withDisabled(smallButton, !canSelect || pushing), disabled: !canSelect || pushing, title: canSelect ? '把这条线索写入 CRM 线索池' : '没有手机号，不能写入 CRM', onClick: () => onCrmPushOne(item) }, pushing ? '写入中…' : '写入 CRM'),
          h('button', { type: 'button', style: { ...smallButton, marginLeft: 6 }, onClick: () => onShowDetail(item) }, '详情'),
          h('button', { type: 'button', style: { ...(confirming ? dangerButton : smallButton), marginLeft: 6 }, title: confirming ? '再点一次确认删除' : '删除这条线索', onClick: () => onDelete(item) }, confirming ? '确认删除' : '删除'),
        ),
      )
    }

    function LeadTable({ items, onDelete, onShowDetail, busy, selected, onToggleSelect, onSelectAll, onCrmPushOne }) {
      const selectableItems = items.filter(selectable)
      const allSelected = selectableItems.length > 0 && selectableItems.every((item) => selected.includes(item.id))
      return h(
        'table',
        { style: { width: '100%', borderCollapse: 'collapse', fontSize: 12, tableLayout: 'auto' } },
        h(
          'thead',
          null,
          h(
            'tr',
            { style: { background: NESTED } },
            h('th', { style: { width: 26, padding: '6px 6px 6px 0', borderBottom: `1px solid ${BORDER_SUBTLE}` } }, h('input', { type: 'checkbox', checked: allSelected, disabled: selectableItems.length === 0, title: '全选本页可写线索', onChange: () => onSelectAll(allSelected ? [] : selectableItems.map((item) => item.id)) })),
            LEAD_COLUMNS.map((label) =>
              h('th', { key: label, style: { textAlign: 'left', padding: '6px 8px 6px 0', fontSize: 11, fontWeight: 600, color: MUTED, whiteSpace: 'nowrap', borderBottom: `1px solid ${BORDER_SUBTLE}` } }, label),
            ),
          ),
        ),
        h('tbody', null, items.map((item) => h(LeadRow, { key: item.id, item, onDelete, onShowDetail, busy, selected: selected.includes(item.id), onToggleSelect, onCrmPushOne }))),
      )
    }

    function LeadDetail({ item, onClose, onCopy }) {
      if (!item) return null
      const rowOf = (label, value) =>
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: '84px 1fr', gap: 8, padding: '6px 0', borderTop: `1px solid ${BORDER_SUBTLE}` } },
          h('div', { style: hint }, label),
          h('div', { style: { fontSize: 12, lineHeight: 1.6, wordBreak: 'break-word' } }, value || '—'),
        )
      return h(
        'div',
        {
          style: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: 16 },
          onClick: (event) => {
            if (event && event.target === event.currentTarget) onClose()
          },
        },
        h(
          'div',
          { style: { width: 'min(560px, 100%)', maxHeight: '80vh', overflow: 'auto', background: PANEL, color: TEXT, borderRadius: 10, border: `1px solid ${BORDER}`, padding: 16, boxShadow: '0 12px 40px rgba(0,0,0,0.25)' } },
          h(
            'div',
            { style: { ...row, justifyContent: 'space-between', marginBottom: 8, padding: '8px 10px', borderRadius: 8, background: ACCENT_TINT, border: `1px solid ${mix(ACCENT, 18)}` } },
            h('div', { style: { ...cardTitle, marginBottom: 0, color: ACCENT, display: 'flex', alignItems: 'center', gap: 6 } }, h('span', { style: { width: 3, height: 14, borderRadius: 2, background: ACCENT } }), '线索详情'),
            h('div', { style: row }, h('button', { type: 'button', style: smallButton, onClick: () => onCopy(item) }, '复制'), h('button', { type: 'button', style: smallButton, onClick: onClose }, '关闭')),
          ),
          rowOf('公司名称', item.company || item.title),
          rowOf('联系人', item.contact),
          rowOf('联系电话', item.phone),
          rowOf('地区', item.region),
          rowOf('主题', item.topicName),
          rowOf('渠道', item.sourceName),
          rowOf('采集时间', fmtDateTime(item.fetchedAt)),
          rowOf('发布时间', item.publishedAt),
          rowOf('备注', item.note),
          rowOf('来源网址', item.sourceUrl ? h('a', { href: item.sourceUrl, target: '_blank', rel: 'noreferrer', style: { color: ACCENT, textDecoration: 'none', overflowWrap: 'anywhere' } }, item.sourceUrl) : '—'),
        ),
      )
    }

    /** CRM 预检弹窗：逐条显示能不能写入，确认后只写入 ok 的行。 */
    /** 预检/写入结果里每种状态的文案与颜色。 */
    function crmStatusLabel(item) {
      switch (item.status) {
        case 'ok':
          return { label: '可写入', color: OK }
        case 'no_phone':
          return { label: '无手机号，跳过', color: WARN }
        case 'dup_phone':
          return { label: '手机号已存在（线索/联系人/客户），已标记同步', color: DANGER }
        case 'dup_name':
          return { label: '公司名已存在（线索/客户），已标记同步', color: DANGER }
        case 'synced':
          return { label: '已同步过', color: MUTED }
        case 'missing':
          return { label: '线索已被删除', color: MUTED }
        case 'failed':
          return { label: `写入失败${item.error ? `：${item.error}` : ''}`, color: DANGER }
        case 'created_no_pool':
          return { label: `已建线索但移入池失败${item.error ? `：${item.error}` : ''}`, color: WARN }
        default:
          return { label: String(item.status || ''), color: MUTED }
      }
    }

    function CrmPrecheck({ result, onClose, onConfirm, busy }) {
      if (!result) return null
      const labelOf = crmStatusLabel
      const ready = (result.items || []).filter((item) => item.status === 'ok')
      return h(
        'div',
        {
          style: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: 16 },
          onClick: (event) => {
            if (event && event.target === event.currentTarget) onClose()
          },
        },
        h(
          'div',
          { style: { width: 'min(620px, 100%)', maxHeight: '80vh', overflow: 'auto', background: PANEL, color: TEXT, borderRadius: 10, border: `1px solid ${BORDER}`, padding: 16, boxShadow: '0 12px 40px rgba(0,0,0,0.25)' } },
          h(
            'div',
            { style: { ...row, justifyContent: 'space-between', marginBottom: 8, padding: '8px 10px', borderRadius: 8, background: ACCENT_TINT, border: `1px solid ${mix(ACCENT, 18)}` } },
            h('div', { style: { ...cardTitle, marginBottom: 0, color: ACCENT, display: 'flex', alignItems: 'center', gap: 6 } }, h('span', { style: { width: 3, height: 14, borderRadius: 2, background: ACCENT } }), '写入 CRM 预检'),
            h('div', { style: row }, h('button', { type: 'button', style: smallButton, onClick: onClose }, '关闭')),
          ),
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 } },
            h(Tag, { tone: 'ok' }, `可写入 ${result.ready || 0} 条`),
            h(Tag, { tone: 'danger' }, `已存在 ${result.duplicated || 0} 条（已标记同步）`),
            h(Tag, { tone: 'warn' }, `无手机号 ${result.noPhone || 0} 条`),
          ),
          (result.items || []).map((item) =>
            h(
              'div',
              { key: item.id, style: { display: 'flex', gap: 8, justifyContent: 'space-between', padding: '6px 0', borderTop: `1px solid ${BORDER_SUBTLE}`, fontSize: 12 } },
              h('div', { style: { minWidth: 0 } }, h('div', { style: { fontWeight: 500 } }, item.name || item.id), h('div', { style: hint }, item.phone || '—')),
              h('div', { style: { color: labelOf(item).color, whiteSpace: 'nowrap' } }, labelOf(item).label),
            ),
          ),
          h(
            'div',
            { style: { ...row, marginTop: 12, justifyContent: 'flex-end' } },
            h('button', { type: 'button', style: withDisabled(primaryButton, ready.length === 0 || busy === 'crm-push'), disabled: ready.length === 0 || busy === 'crm-push', onClick: () => onConfirm(ready.map((item) => item.id)) }, busy === 'crm-push' ? '写入中…' : `确认写入 ${ready.length} 条`),
          ),
        ),
      )
    }

    /** 写入完成后的结果弹窗：成功/失败条数 + 每条原因。 */
    function CrmResult({ result, onClose }) {
      if (!result) return null
      const created = Number(result.created) || 0
      const failed = Number(result.failed) || 0
      const items = result.items || []
      const okTone = failed > 0 ? (created > 0 ? 'warn' : 'danger') : 'ok'
      return h(
        'div',
        {
          style: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: 16 },
          onClick: (event) => {
            if (event && event.target === event.currentTarget) onClose()
          },
        },
        h(
          'div',
          { style: { width: 'min(620px, 100%)', maxHeight: '80vh', overflow: 'auto', background: PANEL, color: TEXT, borderRadius: 10, border: `1px solid ${BORDER}`, padding: 16, boxShadow: '0 12px 40px rgba(0,0,0,0.25)' } },
          h(
            'div',
            { style: { ...row, justifyContent: 'space-between', marginBottom: 10, padding: '8px 10px', borderRadius: 8, background: mix(toneOf(okTone).color, 8), border: `1px solid ${mix(toneOf(okTone).color, 20)}` } },
            h('div', { style: { ...cardTitle, marginBottom: 0, color: toneOf(okTone).color, display: 'flex', alignItems: 'center', gap: 6 } }, h('span', { style: { width: 3, height: 14, borderRadius: 2, background: toneOf(okTone).color } }), 'CRM 写入结果'),
            h('div', { style: row }, h('button', { type: 'button', style: smallButton, onClick: onClose }, '关闭')),
          ),
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 } },
            h(Tag, { tone: 'ok' }, `成功 ${created} 条`),
            failed > 0 ? h(Tag, { tone: 'danger' }, `失败 ${failed} 条`) : null,
            items.length > created + failed ? h(Tag, { tone: 'idle' }, `跳过 ${items.length - created - failed} 条`) : null,
          ),
          items.map((item) => {
            const meta = crmStatusLabel(item)
            return h(
              'div',
              { key: item.id, style: { display: 'flex', gap: 8, justifyContent: 'space-between', padding: '6px 0', borderTop: `1px solid ${BORDER_SUBTLE}`, fontSize: 12 } },
              h('div', { style: { minWidth: 0 } }, h('div', { style: { fontWeight: 500 } }, item.name || item.id), h('div', { style: hint }, item.phone || '—')),
              h('div', { style: { color: meta.color, whiteSpace: 'nowrap' } }, meta.label),
            )
          }),
        ),
      )
    }

    /** 右下角浮动提示（成功/失败都看得见），6 秒后自动消失。 */
    function Toast({ toast, onClose }) {
      const palette = toneOf(toast.tone || 'ok')
      return h(
        'div',
        {
          style: {
            position: 'fixed',
            right: 24,
            bottom: 24,
            zIndex: 10000,
            width: 'min(420px, calc(100vw - 48px))',
            background: PANEL,
            color: TEXT,
            border: `1px solid ${mix(palette.color, 45)}`,
            borderLeft: `4px solid ${palette.color}`,
            borderRadius: 10,
            padding: '10px 12px',
            boxShadow: '0 16px 40px rgba(0,0,0,0.22)',
            display: 'flex',
            gap: 10,
            alignItems: 'flex-start',
          },
        },
        h(
          'div',
          { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { fontSize: 13, fontWeight: 700, color: palette.color, marginBottom: 2 } }, toast.title || (toast.tone === 'danger' ? '操作失败' : '操作成功')),
          toast.detail ? h('div', { style: { ...hint, marginTop: 0, color: TEXT, wordBreak: 'break-word' } }, toast.detail) : null,
        ),
        h('button', { type: 'button', style: smallButton, onClick: onClose }, '关闭'),
      )
    }

    function ResultsTab(props) {
      const { data, filters, setFilters, results, onLoad, busy, onRun, onClear, onNotice, onDelete, detail, onShowDetail, onCloseDetail, onCopyDetail, crmOptions, crmBusy, selected, onToggleSelect, onSelectAll, onCrmPrecheck, onCrmConfig, crmPre, onCrmClose, onCrmConfirm, onCrmPushOne } = props
      const dates = (results && results.dates) || (data.stats && data.stats.dates) || []
      const items = (results && results.items) || []
      const total = results ? Number(results.total) || 0 : 0
      const page = results ? Number(results.page) || 1 : 1
      const pages = results ? Math.max(1, Number(results.pages) || 1) : 1
      const pageSize = results ? Number(results.pageSize) || 20 : Number(filters.pageSize) || 20
      const pageSizes = (data.limits && data.limits.pageSizes) || [20, 50, 100]
      const withPhone = items.filter((item) => item.phone).length
      const groups = useMemo(() => {
        const map = new Map()
        for (const item of items) {
          const key = item.topicName || '未分类'
          if (!map.has(key)) map.set(key, [])
          map.get(key).push(item)
        }
        return [...map.entries()]
      }, [results])
      const exportParams = new URLSearchParams()
      if (filters.date) exportParams.set('date', filters.date)
      if (filters.topic) exportParams.set('topic', filters.topic)
      if (filters.q) exportParams.set('q', filters.q)
      if (filters.hasPhone) exportParams.set('hasPhone', '1')
      if (filters.sync && filters.sync !== 'all') exportParams.set('sync', filters.sync)
      const exportUrl = `/data-collector/results/export?${exportParams.toString()}&format=xlsx`
      const apply = (patch) => {
        const next = { ...filters, page: 1, ...patch }
        setFilters(next)
        onLoad(next)
      }
      const goPage = (target) => {
        const next = Math.max(1, Math.min(pages, Number(target) || 1))
        const value = { ...filters, page: next }
        setFilters(value)
        onLoad(value)
      }
      const changePageSize = (size) => {
        const value = { ...filters, page: 1, pageSize: Number(size) || 20 }
        setFilters(value)
        onLoad(value)
      }
      const copyVisible = async () => {
        const lines = items.map(leadLine)
        try {
          if (typeof navigator === 'undefined' || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('当前浏览器不支持自动复制')
          await navigator.clipboard.writeText(lines.join('\n'))
          if (typeof onNotice === 'function') onNotice({ tone: 'ok', text: `已复制本页 ${lines.length} 条线索（制表符分隔，可直接粘到 Excel）。` })
        } catch (error) {
          if (typeof onNotice === 'function') onNotice({ tone: 'danger', text: `复制失败：${msg(error)}` })
        }
      }
      const chip = (active, tone) => {
        const palette = toneOf(tone || 'brand')
        return active
          ? { ...smallButton, borderColor: palette.color, background: palette.soft, color: palette.color, fontWeight: 600 }
          : { ...smallButton, borderColor: BORDER_SUBTLE, color: MUTED }
      }
      return h(
        'div',
        null,
        h(Progress, { runtime: data.runtime }),
        h(
          'div',
          { style: { ...card, padding: '10px 12px' } },
          h(
            'div',
            { style: { ...row, marginBottom: 8 } },
            h(
              'div',
              { style: { ...row, marginBottom: 8, flex: '1 1 100%', paddingBottom: 6, borderBottom: `1px dashed ${BORDER_SUBTLE}` } },
              [
                { key: 'all', label: '全部', tone: 'brand' },
                { key: 'today', label: '今日采集', tone: 'today' },
                { key: 'unsynced', label: '未同步', tone: 'warn' },
                { key: 'synced', label: '已同步', tone: 'ok' },
                { key: 'failed', label: '写入失败', tone: 'danger' },
                { key: 'no_phone', label: '无手机号', tone: 'idle' },
              ].map((item) => {
                const counts = (results && results.statusCounts) || {}
                const count = item.key === 'all' ? counts.all : item.key === 'no_phone' ? counts.noPhone : counts[item.key]
                const palette = toneOf(item.tone)
                return h(
                  'button',
                  {
                    key: item.key,
                    type: 'button',
                    style: {
                      ...chip((filters.sync || 'all') === item.key, item.tone),
                      borderLeft: `3px solid ${palette.color}`,
                    },
                    onClick: () => apply({ sync: item.key }),
                  },
                  `${item.label}${typeof count === 'number' ? `（${count}）` : ''}`,
                )
              }),
            ),
            h('button', { type: 'button', style: chip(filters.date === ''), onClick: () => apply({ date: '' }) }, '全部日期'),
            dates.slice(0, 8).map((bucket) =>
              h('button', { key: bucket.date, type: 'button', style: chip(filters.date === bucket.date), onClick: () => apply({ date: bucket.date }) }, `${bucket.date.slice(5)}（${bucket.count}）`),
            ),
          ),
          h(
            'div',
            { style: { ...row, marginBottom: 8 } },
            h('select', { style: { ...input, width: 'auto', minWidth: 130 }, value: filters.topic, onChange: (event) => apply({ topic: event.target.value }) }, h('option', { value: '' }, '全部主题'), (data.topics || []).map((topic) => h('option', { key: topic.id, value: topic.id }, topic.name))),
            h('input', { style: { ...input, flex: '1 1 180px', width: 'auto' }, value: filters.q, placeholder: '搜索公司 / 联系人 / 电话 / 地区 / 来源', onChange: (event) => setFilters({ ...filters, q: event.target.value }), onKeyDown: (event) => { if (event.key === 'Enter') apply({}) } }),
            h('button', { type: 'button', style: smallButton, onClick: () => apply({}) }, '搜索'),
            h('button', { type: 'button', style: chip(Boolean(filters.hasPhone)), onClick: () => apply({ hasPhone: !filters.hasPhone }) }, '只看有电话'),
          ),
          h(
            'div',
            { style: row },
            h('button', { type: 'button', style: smallButton, onClick: () => downloadFile(exportUrl) }, '导出 Excel'),
            h('button', { type: 'button', style: smallButton, onClick: copyVisible }, '复制本页'),
            h('button', { type: 'button', style: smallButton, onClick: () => onClear() }, busy === 'clear-confirm' ? '确认清空线索' : '清空线索'),
            h('button', { type: 'button', style: withDisabled(smallButton, Boolean(data.runtime)), disabled: Boolean(data.runtime), onClick: onRun }, '立即采集'),
          ),
          h(
            'div',
            { style: { ...row, marginTop: 8, padding: '8px 10px', borderRadius: 8, border: `1px solid ${mix(ACCENT, 22)}`, background: ACCENT_TINT } },
            crmOptions
              ? crmOptions.configured === false
                ? h(Tag, { tone: 'idle' }, 'CRM：未配置')
                : h(Tag, { tone: crmOptions.writable ? 'ok' : 'danger' }, crmOptions.writable ? 'CRM：可写' : 'CRM：只读')
              : h(Tag, { tone: 'idle' }, 'CRM：未接入'),
            crmOptions && crmOptions.pools && crmOptions.pools.length > 0
              ? h(
                  'select',
                  {
                    style: { ...input, width: 'auto', minWidth: 150 },
                    value: (crmOptions.crm && crmOptions.crm.poolId) || '',
                    onChange: (event) => onCrmConfig(event.target.value),
                  },
                  h('option', { value: '' }, '选择线索池'),
                  crmOptions.pools.map((pool) => h('option', { key: pool.id, value: pool.id }, pool.name)),
                )
              : null,
            h('button', { type: 'button', style: withDisabled(primaryButton, selected.length === 0 || crmBusy === 'precheck'), disabled: selected.length === 0 || crmBusy === 'precheck', onClick: onCrmPrecheck }, crmBusy === 'precheck' ? '预检中…' : '写入 CRM'),
            h('span', { style: hint }, `已选 ${selected.length} 条`),
          ),
          crmOptions && crmOptions.warnings && crmOptions.warnings.length > 0
            ? h('div', { style: { ...hint, color: DANGER, marginTop: 6 } }, `CRM 清单拉取失败：${crmOptions.warnings.map((item) => `${item.source}：${item.message}`).join('；')}。可在「CRM」页手动填写 ID。`)
            : null,
        ),
        results === null
          ? h('div', { style: { ...card, ...hint } }, busy === 'results' ? '加载中…' : '还没有加载线索。')
          : total === 0
            ? h(
                'div',
                { style: { ...card, ...hint } },
                h('div', { style: { ...cardTitle, marginBottom: 6 } }, '当前筛选下没有线索'),
                data.stats && data.stats.channels === 0
                  ? '还没有采集渠道：先到「采集渠道」页签添加一个（RSS / 网页列表 / 网页搜索都可以）。'
                  : data.stats && data.stats.itemsTotal === 0
                    ? '还没有任何线索：点「立即采集」跑一次，或等下次定时采集。'
                    : '换个日期、换个主题，或清空搜索词再试。',
              )
            : h(
                'div',
                null,
                h(
                  'div',
                  { style: { ...row, justifyContent: 'space-between', marginBottom: 6 } },
                  h('span', { style: hint }, `共 ${total} 条线索 · 第 ${page} / ${pages} 页 · 本页 ${items.length} 条（${withPhone} 条有电话）`),
                  h(
                    'div',
                    { style: { ...row, marginLeft: 'auto' } },
                    h('span', { style: hint }, '每页'),
                    h('select', { style: { ...input, width: 'auto' }, value: String(pageSize), onChange: (event) => changePageSize(event.target.value) }, pageSizes.map((size) => h('option', { key: size, value: String(size) }, `${size} 条`))),
                    h('button', { type: 'button', style: withDisabled(smallButton, page <= 1), disabled: page <= 1, onClick: () => goPage(page - 1) }, '‹ 上一页'),
                    h('button', { type: 'button', style: withDisabled(smallButton, page >= pages), disabled: page >= pages, onClick: () => goPage(page + 1) }, '下一页 ›'),
                  ),
                ),
                groups.map(([topicName, rows]) =>
                  h(
                    'div',
                    { key: topicName, style: card },
                    h('div', { style: { ...cardTitle, marginBottom: 8 } }, `${topicName}（${rows.length} 条 · ${rows.filter((item) => item.phone).length} 条有电话）`),
                    h(LeadTable, { items: rows, onDelete, onShowDetail, busy, selected, onToggleSelect, onSelectAll, onCrmPushOne }),
                  ),
                ),
              ),
        detail ? h(LeadDetail, { item: detail, onClose: onCloseDetail, onCopy: onCopyDetail }) : null,
        crmPre ? h(CrmPrecheck, { result: crmPre, onClose: onCrmClose, onConfirm: onCrmConfirm, busy: crmBusy }) : null,
      )
    }

    // ------------------------------------------------------------------ CRM 页
    function CrmTab({ data, crmStatus, crmProbe, crmOptions, busy, onSaveConnection, onTest, onCrmConfig, onRefresh }) {
      const saved = (crmStatus && crmStatus.crm) || {}
      const [form, setForm] = useState({
        baseUrl: saved.baseUrl || '',
        accessKey: '',
        secretKey: '',
        organizationId: saved.organizationId || '',
        readOnly: saved.readOnly !== false,
      })
      const [loadedAt, setLoadedAt] = useState(saved.baseUrl || '')
      const [manualPoolId, setManualPoolId] = useState('')
      const [manualProductId, setManualProductId] = useState('')
      if ((saved.baseUrl || '') !== loadedAt) {
        // 服务端配置变化（首次加载 / 保存后）时同步表单
        setLoadedAt(saved.baseUrl || '')
        setForm({ baseUrl: saved.baseUrl || '', accessKey: '', secretKey: '', organizationId: saved.organizationId || '', readOnly: saved.readOnly !== false })
      }
      const configured = Boolean(crmStatus && crmStatus.configured)
      const writable = saved.readOnly === false
      const probing = busy === 'crm-test'
      const saving = busy === 'crm-connect'
      const set = (patch) => setForm((prev) => ({ ...prev, ...patch }))
      const probe = crmProbe
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h(
          'div',
          { style: { ...card, borderColor: mix(configured ? OK : WARN, 30), background: configured ? OK_SOFT : WARN_SOFT } },
          h(
            'div',
            { style: { ...row, justifyContent: 'space-between' } },
            h('div', { style: { ...cardTitle, marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 } }, h('span', { style: { width: 3, height: 14, borderRadius: 2, background: configured ? OK : WARN } }), 'CRM 连接'),
            h(Tag, { tone: configured ? 'ok' : 'warn' }, configured ? '已配置' : '未配置'),
          ),
          h(
            'div',
            { style: { ...row, marginTop: 8, gap: 6 } },
            h(Tag, { tone: writable ? 'danger' : 'ok' }, writable ? '可写：会写入 CRM' : '只读：拒绝写入'),
            saved.baseUrl ? h('span', { style: { ...hint, marginTop: 0, ...mono } }, saved.baseUrl) : h('span', { style: hint }, '还没有服务器地址'),
            saved.accessKey ? h('span', { style: hint }, `Key：${saved.accessKey}`) : null,
          ),
          probe
            ? h(
                'div',
                { style: { ...row, marginTop: 8, gap: 6, fontSize: 12, color: probe.ok ? OK : DANGER } },
                h(
                  'span',
                  null,
                  probe.ok
                    ? `连接正常${(() => {
                        const who = probe.identity || {}
                        const name = who.name || who.userName || who.userId || who.id || ''
                        const phone = who.phone || ''
                        return name || phone ? `：${name}${phone ? ` / ${phone}` : ''}` : ''
                      })()}`
                    : `连接失败：${probe.message || '未知错误'}`,
                ),
              )
            : null,
        ),
        h(
          'div',
          { style: card },
          h('div', { style: cardTitle }, '服务器与 API Key'),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
            h(Field, { label: '服务器地址（产品根地址，例如 https://crm.example.com）' }, h('input', { style: input, value: form.baseUrl, placeholder: 'https://crm.example.com', onChange: (event) => set({ baseUrl: event.target.value }) })),
            h(
              'div',
              { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 } },
              h(Field, { label: 'Access Key' }, h('input', { style: input, type: 'password', value: form.accessKey, placeholder: saved.accessKey ? `留空保持不变（当前 ${saved.accessKey}）` : '个人中心 → API Keys 生成', onChange: (event) => set({ accessKey: event.target.value }) })),
              h(Field, { label: 'Secret Key' }, h('input', { style: input, type: 'password', value: form.secretKey, placeholder: saved.secretKey ? `留空保持不变（当前 ${saved.secretKey}）` : '与 Access Key 成对出现', onChange: (event) => set({ secretKey: event.target.value }) })),
            ),
            h(Field, { label: '组织 ID（可选，多组织时才需要）' }, h('input', { style: input, value: form.organizationId, placeholder: '留空使用默认组织', onChange: (event) => set({ organizationId: event.target.value }) })),
            h(
              'label',
              { style: { display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, cursor: 'pointer', padding: '8px 10px', borderRadius: 8, background: form.readOnly ? OK_SOFT : DANGER_SOFT, border: `1px solid ${mix(form.readOnly ? OK : DANGER, 25)}` } },
              h('input', { type: 'checkbox', checked: !form.readOnly, onChange: (event) => set({ readOnly: !event.target.checked }), style: { marginTop: 2 } }),
              h('span', null,
                h('div', { style: { fontWeight: 600, color: form.readOnly ? OK : DANGER } }, form.readOnly ? '只读模式（推荐先保持）' : '允许写入 CRM'),
                h('div', { style: hint }, form.readOnly ? '只能查重/查询，不会创建线索；确认无误后再取消勾选。' : '取消只读后，预检通过的线索会真正创建到 CRM 的线索池。'),
              ),
            ),
            h(
              'div',
              { style: { ...row, marginTop: 2 } },
              h('button', { type: 'button', style: withDisabled(primaryButton, saving), disabled: saving, onClick: () => onSaveConnection(form) }, saving ? '保存中…' : '保存并测试连接'),
              h('button', { type: 'button', style: withDisabled(smallButton, probing || !configured), disabled: probing || !configured, onClick: () => onTest() }, probing ? '测试中…' : '测试连接'),
              h('button', { type: 'button', style: smallButton, onClick: () => onRefresh() }, '重新读取状态'),
            ),
            h('div', { style: hint }, '配置保存到本机 ~/.dsh/data-collector/crm.json（权限 0600，仅本用户可读）；第一次使用会自动迁移原「Cordys CRM」插件的地址与 Key。'),
          ),
        ),
        h(
          'div',
          { style: card },
          h('div', { style: cardTitle }, '写入默认值'),
          h('div', { style: hint }, '写入 CRM 时，线索会先创建再移入这里选中的线索池；意向产品随线索一起写入。'),
          crmOptions && crmOptions.warnings && crmOptions.warnings.length > 0
            ? h(
                'div',
                { style: { marginTop: 8, padding: '8px 10px', borderRadius: 8, border: `1px solid ${mix(DANGER, 35)}`, background: DANGER_SOFT, color: DANGER, fontSize: 12, lineHeight: 1.6 } },
                h('div', { style: { fontWeight: 600, marginBottom: 2 } }, '线索池 / 产品清单拉取失败（通常是 API Key 权限不足）'),
                crmOptions.warnings.map((item) => h('div', { key: item.source }, `${item.source}：${item.message}`)),
                h('div', { style: { marginTop: 4 } }, '解决办法：① 让 CRM 管理员给当前账号的「模块设置-更新」与「产品管理-读取」权限；② 或换用管理员 API Key；③ 或者直接在下方手动填写线索池 ID。'),
              )
            : null,
          h(
            'div',
            { style: { ...row, marginTop: 8 } },
            h(
              'select',
              { style: { ...input, width: 'auto', minWidth: 180 }, value: (crmOptions && crmOptions.crm && crmOptions.crm.poolId) || '', onChange: (event) => onCrmConfig(event.target.value) },
              h('option', { value: '' }, '选择线索池'),
              ((crmOptions && crmOptions.pools) || []).map((pool) => h('option', { key: pool.id, value: pool.id }, pool.name)),
            ),
            h(
              'select',
              { style: { ...input, width: 'auto', minWidth: 160 }, value: (crmOptions && crmOptions.crm && crmOptions.crm.productId) || '', onChange: (event) => onCrmConfig(undefined, event.target.value) },
              h('option', { value: '' }, '不指定产品'),
              ((crmOptions && crmOptions.products) || []).map((product) => h('option', { key: product.id, value: product.id }, product.name)),
            ),
            crmOptions && crmOptions.configured === false
              ? h('span', { style: { ...hint, marginTop: 0 } }, '先保存并测试连接，才会加载线索池与产品。')
              : null,
          ),
          h(
            'div',
            { style: { ...row, marginTop: 8 } },
            h('input', { style: { ...input, width: 'auto', minWidth: 200 }, value: manualPoolId, placeholder: '手动填写线索池 ID（清单拉不到时用）', onChange: (event) => setManualPoolId(event.target.value) }),
            h('button', { type: 'button', style: smallButton, onClick: () => onCrmConfig(manualPoolId.trim()) }, '保存线索池 ID'),
            h('input', { style: { ...input, width: 'auto', minWidth: 180 }, value: manualProductId, placeholder: '手动填写产品 ID（可选）', onChange: (event) => setManualProductId(event.target.value) }),
            h('button', { type: 'button', style: smallButton, onClick: () => onCrmConfig(undefined, manualProductId.trim()) }, '保存产品 ID'),
          ),
        ),
      )
    }

    // ------------------------------------------------------------------ 主面板
    function CollectorPanel() {
      const [data, setData] = useState(null)
      const [loadError, setLoadError] = useState('')
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState('')
      const [tab, setTab] = useState('overview')
      const [topicSel, setTopicSel] = useState('')
      const [topicForm, setTopicForm] = useState(emptyTopicForm())
      const [channelSel, setChannelSel] = useState('')
      const [channelForm, setChannelForm] = useState(emptyChannelForm())
      const [testResult, setTestResult] = useState(null)
      const [scheduleDraft, setScheduleDraft] = useState(scheduleDraftOf(null))
      const [scopeDraft, setScopeDraft] = useState(scopeDraftOf(null))
      const [filters, setFilters] = useState({ date: '', topic: '', q: '', hasPhone: false, sync: 'all', page: 1, pageSize: 20 })
      const [results, setResults] = useState(null)
      const [detail, setDetail] = useState(null)
      const [selected, setSelected] = useState([])
      const [crmOptions, setCrmOptions] = useState(null)
      const [crmPre, setCrmPre] = useState(null)
      const [crmStatus, setCrmStatus] = useState(null)
      const [crmProbe, setCrmProbe] = useState(null)
      const [toast, setToast] = useState(null)
      const [crmResult, setCrmResult] = useState(null)

      useEffect(() => {
        if (!toast) return undefined
        const timer = setTimeout(() => setToast(null), 6000)
        return () => clearTimeout(timer)
      }, [toast])

      const topicDirty = data
        ? JSON.stringify(topicForm) !== JSON.stringify(topicFormOf(topicSel === 'new' ? null : (data.topics || []).find((topic) => topic.id === topicSel) || null))
        : false
      const channelDirty = data
        ? JSON.stringify(channelForm) !== JSON.stringify(channelFormOf(channelSel === 'new' ? null : (data.channels || []).find((channel) => channel.id === channelSel) || null))
        : false

      const refresh = useCallback(async (options) => {
        try {
          const next = await getJson('/data-collector/state')
          setData(next)
          setLoadError('')
          if (!options || !options.keepDraft) {
            setScheduleDraft(scheduleDraftOf(next.schedule))
            setScopeDraft(scopeDraftOf(next.scope))
          }
          return next
        } catch (error) {
          setLoadError(errText(error))
          return null
        }
      }, [])

      const loadResults = useCallback(
        async (nextFilters) => {
          const current = nextFilters || filters
          setBusy('results')
          try {
            const params = new URLSearchParams()
            if (current.date) params.set('date', current.date)
            if (current.topic) params.set('topic', current.topic)
            if (current.q) params.set('q', current.q)
            if (current.hasPhone) params.set('hasPhone', '1')
            if (current.sync && current.sync !== 'all') params.set('sync', current.sync)
            params.set('page', String(current.page || 1))
            params.set('pageSize', String(current.pageSize || 20))
            setResults(await getJson(`/data-collector/results?${params.toString()}`))
          } catch (error) {
            setNotice({ tone: 'danger', text: `结果加载失败：${errText(error)}` })
          } finally {
            setBusy('')
          }
        },
        [filters],
      )

      useEffect(() => {
        void refresh()
      }, [refresh])

      // 采集中：每 1.5 秒刷新一次进度，完成后提示并刷新线索
      const runtimeId = data && data.runtime ? data.runtime.runId : ''
      useEffect(() => {
        if (!runtimeId) return undefined
        const previousRunId = data && data.runtime ? data.runtime.runId : ''
        const timer = setInterval(() => {
          void loadResults(filters)
          void refresh({ keepDraft: true }).then((next) => {
            const finished = next && next.stats && next.stats.lastRun
            if (finished && finished.id !== previousRunId) {
              const failed = (finished.tasks || []).filter((task) => task.status === 'failed').length
              setNotice({ tone: finished.status === 'failed' ? 'danger' : 'ok', text: `采集完成：新增 ${finished.newItems || 0} 条线索（${finished.withPhone || 0} 条有电话）${failed > 0 ? `，${failed} 个渠道失败（见总览）` : ''}。` })
            }
          })
        }, 1500)
        return () => clearInterval(timer)
      }, [runtimeId, data, filters, loadResults, refresh])

      // 空闲时每 45 秒同步一次配置（定时采集、其它窗口或 Agent 改的配置都能反映出来）
      useEffect(() => {
        if (runtimeId) return undefined
        const timer = setInterval(() => {
          void refresh({ keepDraft: true })
        }, 45000)
        return () => clearInterval(timer)
      }, [runtimeId, refresh])

      const confirmSwitch = (message) => {
        if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true
        return Boolean(window.confirm(message))
      }

      const selectTab = (id, date) => {
        if (busy.endsWith('-confirm')) setBusy('')
        setTab(id)
        if (id === 'results') {
          const next = { ...filters, date: date === undefined ? filters.date : date, page: 1 }
          setFilters(next)
          void loadResults(next)
          if (!crmOptions && data && data.crmAvailable) void loadCrmOptions()
        }
        if (id === 'crm') {
          void loadCrmStatus()
          void loadCrmOptions()
        }
      }

      // ---- CRM 写入
      const loadCrmOptions = async () => {
        try {
          const options = await getJson('/data-collector/crm/options')
          setCrmOptions(options)
          return options
        } catch (error) {
          setNotice({ tone: 'danger', text: `CRM 配置读取失败：${errText(error)}` })
          return null
        }
      }

      const loadCrmStatus = async () => {
        try {
          const status = await getJson('/data-collector/crm/status')
          setCrmStatus(status)
          return status
        } catch (error) {
          setNotice({ tone: 'danger', text: `CRM 状态读取失败：${errText(error)}` })
          return null
        }
      }

      const testCrm = async (silent = false) => {
        setBusy('crm-test')
        try {
          const probe = await postJson('/data-collector/crm/test', {})
          setCrmProbe(probe)
          if (!silent) {
            setNotice({
              tone: probe.ok ? 'ok' : 'danger',
              text: probe.ok ? `CRM 连接正常${probe.identity && (probe.identity.name || probe.identity.userId) ? `（账号：${probe.identity.name || probe.identity.userId}）` : ''}。` : `CRM 连接失败：${probe.message || '未知错误'}`,
            })
            setToast({
              tone: probe.ok ? 'ok' : 'danger',
              title: probe.ok ? 'CRM 连接正常' : 'CRM 连接失败',
              detail: probe.ok ? '连通与鉴权都已通过，可以开始写入。' : probe.message || '未知错误',
            })
          }
          return probe
        } catch (error) {
          setCrmProbe({ ok: false, message: errText(error) })
          if (!silent) {
            setNotice({ tone: 'danger', text: `CRM 连接失败：${errText(error)}` })
            setToast({ tone: 'danger', title: 'CRM 连接失败', detail: errText(error) })
          }
          return null
        } finally {
          setBusy('')
        }
      }

      /** 保存连接配置（地址 / Key / 只读），保存后自动跑一次连接测试。 */
      const saveCrmConnection = async (form) => {
        setBusy('crm-connect')
        try {
          await postJson('/data-collector/crm/connect', form)
          await loadCrmStatus()
          const probe = await testCrm(true)
          setNotice({
            tone: probe && probe.ok ? 'ok' : 'danger',
            text: probe && probe.ok ? 'CRM 配置已保存，连接正常。' : `CRM 配置已保存，但连接失败：${(probe && probe.message) || '未知错误'}`,
          })
          setToast({
            tone: probe && probe.ok ? 'ok' : 'danger',
            title: probe && probe.ok ? 'CRM 配置已保存' : '配置已保存，但连接失败',
            detail: probe && probe.ok ? '连接正常，可以开始写入线索。' : (probe && probe.message) || '未知错误',
          })
          await loadCrmOptions()
          await refresh({ keepDraft: true })
        } catch (error) {
          setNotice({ tone: 'danger', text: `保存 CRM 配置失败：${errText(error)}` })
        } finally {
          setBusy('')
        }
      }

      const toggleSelect = (item) => {
        setSelected((prev) => (prev.includes(item.id) ? prev.filter((id) => id !== item.id) : [...prev, item.id]))
      }

      const openCrmPrecheck = async () => {
        setBusy('crm-precheck')
        try {
          const options = crmOptions || (await loadCrmOptions())
          if (!options || !options.ok) return
          if (!options.writable) {
            setNotice({ tone: 'danger', text: 'CRM 目前是只读模式，写入会被拒绝：先到「CRM」页签取消只读。' })
            return
          }
          if (!options.crm || !options.crm.poolId) {
            setNotice({ tone: 'danger', text: '还没有选择线索池：先在上方选择一个线索池。' })
            return
          }
          setCrmPre(await postJson('/data-collector/crm/precheck', { ids: selected }))
          // 预检会把「CRM 已存在」的线索标记为已同步，刷新列表让行状态立刻更新
          void loadResults(filters)
        } catch (error) {
          setNotice({ tone: 'danger', text: `预检失败：${errText(error)}` })
        } finally {
          setBusy('')
        }
      }

      const saveCrmPool = async (poolId) => {
        const pool = ((crmOptions && crmOptions.pools) || []).find((item) => item.id === poolId)
        try {
          const saved = await postJson('/data-collector/crm/config', { crm: { ...(data.crm || {}), poolId, poolName: (pool && pool.name) || '' } })
          setData(saved.state)
          setCrmOptions((prev) => (prev ? { ...prev, crm: saved.crm } : prev))
          setNotice({ tone: 'ok', text: pool ? `线索池已设为「${pool.name}」。` : '已清除线索池选择。' })
        } catch (error) {
          setNotice({ tone: 'danger', text: `保存线索池失败：${errText(error)}` })
        }
      }

      const saveCrmProduct = async (productId) => {
        const product = ((crmOptions && crmOptions.products) || []).find((item) => item.id === productId)
        try {
          const saved = await postJson('/data-collector/crm/config', { crm: { ...(data.crm || {}), productId, productName: (product && product.name) || '' } })
          setData(saved.state)
          setCrmOptions((prev) => (prev ? { ...prev, crm: saved.crm } : prev))
          setNotice({ tone: 'ok', text: product ? `意向产品已设为「${product.name}」。` : '已清除产品选择。' })
        } catch (error) {
          setNotice({ tone: 'danger', text: `保存产品失败：${errText(error)}` })
        }
      }

      const saveCrmBoth = async (poolId, productId) => {
        if (poolId !== undefined) await saveCrmPool(poolId)
        if (productId !== undefined) await saveCrmProduct(productId)
      }

      const confirmCrmPush = async (ids) => {
        setBusy('crm-push')
        try {
          const outcome = await postJson('/data-collector/crm/push', { ids })
          if (outcome.state) setData(outcome.state)
          const created = Number(outcome.created) || 0
          const failed = Number(outcome.failed) || 0
          setCrmPre(null)
          setCrmResult(outcome)
          setSelected([])
          const firstError = (outcome.items || []).find((item) => item.status === 'failed' || item.status === 'created_no_pool')
          setToast({
            tone: failed > 0 ? (created > 0 ? 'warn' : 'danger') : 'ok',
            title: failed > 0 ? (created > 0 ? `写入部分成功：${created} 条成功，${failed} 条失败` : `写入失败：${failed} 条`) : `写入成功：${created} 条`,
            detail: firstError ? `失败原因：${firstError.error || firstError.name || '未知错误'}` : created > 0 ? '线索已创建并移入线索池，本地标记为「已同步」。' : '没有可写入的线索。',
          })
          setNotice({ tone: outcome.failed ? 'danger' : 'ok', text: `CRM 写入完成：成功 ${created} 条${failed ? `，失败 ${failed} 条` : ''}。` })
          void loadResults(filters)
        } catch (error) {
          setNotice({ tone: 'danger', text: `写入失败：${errText(error)}` })
          setToast({ tone: 'danger', title: 'CRM 写入失败', detail: errText(error) })
        } finally {
          setBusy('')
        }
      }

      /** 单条写入：先预检，通过就直接写；被拦截时弹预检窗口说明原因。 */
      const pushOneToCrm = async (item) => {
        if (!item || !item.id) return
        setBusy(`crm-one:${item.id}`)
        try {
          const options = crmOptions || (await loadCrmOptions())
          if (!options || !options.ok) return
          if (!options.writable) {
            setNotice({ tone: 'danger', text: 'CRM 目前是只读模式，写入会被拒绝：先到「CRM」页签取消只读。' })
            setToast({ tone: 'danger', title: 'CRM 只读', detail: '到「CRM」页签取消只读后才能写入。' })
            return
          }
          if (!options.crm || !options.crm.poolId) {
            setNotice({ tone: 'danger', text: '还没有选择线索池：先在上方选择一个线索池。' })
            setToast({ tone: 'danger', title: '还没有选择线索池', detail: '在「CRM」页签或顶部 CRM 面板选择一个线索池。' })
            return
          }
          const pre = await postJson('/data-collector/crm/precheck', { ids: [item.id] })
          const row = pre && pre.items ? pre.items[0] : null
          if (!row || row.status !== 'ok') {
            // CRM 里已存在：预检已把它标记为已同步，刷新后行上会显示「已同步」
            setCrmPre(pre)
            void loadResults(filters)
            return
          }
          const outcome = await postJson('/data-collector/crm/push', { ids: [item.id] })
          if (outcome.state) setData(outcome.state)
          const rowResult = (outcome.items || [])[0] || {}
          const ok = Number(outcome.created) > 0
          setToast({
            tone: ok ? 'ok' : 'danger',
            title: ok ? '已写入 CRM' : '写入失败',
            detail: ok ? `「${item.company || item.title || item.id}」已创建并移入线索池。` : rowResult.error || '未知错误',
          })
          setNotice({
            tone: outcome.failed ? 'danger' : 'ok',
            text: outcome.failed ? `写入失败：${rowResult.error || '未知错误'}` : `已写入 CRM：「${item.company || item.title || item.id}」`,
          })
          void loadResults(filters)
        } catch (error) {
          setNotice({ tone: 'danger', text: `写入失败：${errText(error)}` })
          setToast({ tone: 'danger', title: 'CRM 写入失败', detail: errText(error) })
        } finally {
          setBusy('')
        }
      }

      const chooseTopic = (id) => {
        if (topicDirty && !confirmSwitch('主题有未保存的修改，确定切换吗？')) return
        setTopicSel(id)
        setTopicForm(topicFormOf((data.topics || []).find((topic) => topic.id === id) || null))
      }
      const startNewTopic = () => {
        if (topicDirty && !confirmSwitch('主题有未保存的修改，确定新建吗？')) return
        setTopicSel('new')
        setTopicForm(emptyTopicForm())
      }
      const saveTopic = async () => {
        setBusy('topic-save')
        try {
          const saved = await postJson('/data-collector/topics/save', { topic: { ...topicForm, id: topicForm.id || undefined } })
          setData(saved.state)
          setTopicSel(saved.topic.id)
          setTopicForm(topicFormOf(saved.topic))
          setNotice({ tone: 'ok', text: `主题「${saved.topic.name}」已保存。` })
        } catch (error) {
          setNotice({ tone: 'danger', text: `保存主题失败：${errText(error)}` })
        } finally {
          setBusy('')
        }
      }
      const deleteTopic = async () => {
        if (!topicForm.id) return
        if (busy !== 'topic-confirm') {
          setBusy('topic-confirm')
          setNotice({ tone: 'danger', text: `再点一次「确认删除主题」会删除主题「${topicForm.name}」，已采集的线索也会一起删除。` })
          return
        }
        setBusy('topic-delete')
        try {
          const saved = await postJson('/data-collector/topics/delete', { id: topicForm.id })
          setData(saved.state)
          setTopicSel('')
          setTopicForm(emptyTopicForm())
          setNotice({ tone: 'ok', text: '主题已删除。' })
        } catch (error) {
          setNotice({ tone: 'danger', text: `删除主题失败：${errText(error)}` })
        } finally {
          setBusy('')
        }
      }

      const chooseChannel = (id) => {
        if (channelDirty && !confirmSwitch('渠道有未保存的修改，确定切换吗？')) return
        setChannelSel(id)
        setChannelForm(channelFormOf((data.channels || []).find((channel) => channel.id === id) || null))
      }
      const startNewChannel = () => {
        if (channelDirty && !confirmSwitch('渠道有未保存的修改，确定新建吗？')) return
        setChannelSel('new')
        setChannelForm(emptyChannelForm())
      }
      const saveChannel = async () => {
        setBusy('channel-save')
        try {
          const saved = await postJson('/data-collector/channels/save', { channel: { ...channelForm, id: channelForm.id || undefined } })
          setData(saved.state)
          setChannelSel(saved.channel.id)
          setChannelForm(channelFormOf(saved.channel))
          setNotice({ tone: 'ok', text: `渠道「${saved.channel.name}」已保存。` })
        } catch (error) {
          setNotice({ tone: 'danger', text: `保存渠道失败：${errText(error)}` })
        } finally {
          setBusy('')
        }
      }
      const deleteChannel = async () => {
        if (!channelForm.id) return
        if (busy !== 'channel-confirm') {
          setBusy('channel-confirm')
          setNotice({ tone: 'danger', text: `再点一次「确认删除渠道」会删除渠道「${channelForm.name}」，已采集的结果会保留。` })
          return
        }
        setBusy('channel-delete')
        try {
          const saved = await postJson('/data-collector/channels/delete', { id: channelForm.id })
          setData(saved.state)
          setChannelSel('')
          setChannelForm(emptyChannelForm())
          setNotice({ tone: 'ok', text: '渠道已删除。' })
        } catch (error) {
          setNotice({ tone: 'danger', text: `删除渠道失败：${errText(error)}` })
        } finally {
          setBusy('')
        }
      }
      const testChannel = async () => {
        setBusy('channel-test')
        setTestResult(null)
        try {
          const outcome = await postJson('/data-collector/channels/test', { channel: channelForm })
          setTestResult(outcome)
        } catch (error) {
          setTestResult({ success: false, message: errText(error) })
        } finally {
          setBusy('')
        }
      }

      const addPresetChannel = async (preset) => {
        setBusy(`preset-add:${preset.name}`)
        try {
          const saved = await postJson('/data-collector/channels/save', { channel: preset })
          setData(saved.state)
          setNotice({ tone: 'ok', text: `已添加平台「${saved.channel.name}」。` })
        } catch (error) {
          setNotice({ tone: 'danger', text: `添加「${preset.name}」失败：${errText(error)}` })
        } finally {
          setBusy('')
        }
      }
      const addAllPresets = async () => {
        const existing = new Set((data.channels || []).map((channel) => channel.name))
        const missing = CHANNEL_PRESETS.filter((preset) => !existing.has(preset.name))
        if (missing.length === 0) {
          setNotice({ tone: 'ok', text: '预置平台都已添加。' })
          return
        }
        setBusy('presets-add-all')
        let added = 0
        const failed = []
        let lastState = null
        for (const preset of missing) {
          try {
            const saved = await postJson('/data-collector/channels/save', { channel: preset })
            added += 1
            lastState = saved.state
          } catch (error) {
            failed.push(`${preset.name}：${errText(error)}`)
          }
        }
        if (lastState) setData(lastState)
        else await refresh({ keepDraft: true })
        setNotice({ tone: failed.length > 0 ? 'danger' : 'ok', text: `预置平台：添加 ${added} 个${failed.length > 0 ? `，失败 ${failed.length} 个（${failed.join('；')}）` : ''}。` })
        setBusy('')
      }

      const saveSchedule = async () => {
        setBusy('schedule-save')
        try {
          const saved = await postJson('/data-collector/schedule', { schedule: scheduleDraft })
          setData(saved.state)
          setScheduleDraft(scheduleDraftOf(saved.schedule))
          setNotice({ tone: 'ok', text: '定时任务已保存。' })
        } catch (error) {
          setNotice({ tone: 'danger', text: `保存定时失败：${errText(error)}` })
        } finally {
          setBusy('')
        }
      }
      const saveScopeDraft = async () => {
        setBusy('scope')
        try {
          const saved = await postJson('/data-collector/scope', { scope: { regions: scopeDraft.regions, unknown: scopeDraft.unknown } })
          setData(saved.state)
          setScopeDraft(scopeDraftOf(saved.scope))
          setNotice({ tone: 'ok', text: '采集范围已保存。' })
        } catch (error) {
          setNotice({ tone: 'danger', text: `保存范围失败：${errText(error)}` })
        } finally {
          setBusy('')
        }
      }

      const clearResults = async () => {
        if (busy !== 'clear-confirm') {
          setBusy('clear-confirm')
          setNotice({ tone: 'danger', text: '再点一次「确认清空线索」会删除全部线索与去重记录（主题和渠道配置保留）。' })
          return
        }
        setBusy('clear')
        try {
          const saved = await postJson('/data-collector/results/clear', {})
          setData(saved.state)
          setResults({ ok: true, total: 0, page: 1, pageSize: 20, pages: 1, items: [], dates: [] })
          setDetail(null)
          setNotice({ tone: 'ok', text: `已清空 ${saved.removed} 条线索，下次采集会重新收录当前页面上的条目。` })
        } catch (error) {
          setNotice({ tone: 'danger', text: `清空失败：${errText(error)}` })
        } finally {
          setBusy('')
        }
      }

      const deleteLead = async (item) => {
        if (!item || !item.id) return
        const confirmKey = `lead-confirm:${item.id}`
        if (busy !== confirmKey) {
          setBusy(confirmKey)
          setNotice({ tone: 'danger', text: `再点一次「确认删除」会删除线索「${item.company || item.title || item.id}」，删除后同一条线索以后还会被抓回来。` })
          return
        }
        setBusy('lead-delete')
        try {
          const saved = await postJson('/data-collector/results/delete', { id: item.id })
          setData(saved.state || data)
          if (detail && detail.id === item.id) setDetail(null)
          setNotice({ tone: 'ok', text: '已删除 1 条线索。' })
          void loadResults(filters)
        } catch (error) {
          setNotice({ tone: 'danger', text: `删除失败：${errText(error)}` })
        } finally {
          setBusy('')
        }
      }

      const copyDetail = async (item) => {
        const text = [`公司名称：${item.company || item.title || ''}`, `联系人：${item.contact || ''}`, `联系电话：${item.phone || ''}`, `地区：${item.region || ''}`, `备注：${item.note || ''}`, `来源：${item.sourceUrl || ''}`].join('\n')
        try {
          if (typeof navigator === 'undefined' || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('当前浏览器不支持自动复制')
          await navigator.clipboard.writeText(text)
          setNotice({ tone: 'ok', text: '线索详情已复制。' })
        } catch (error) {
          setNotice({ tone: 'danger', text: `复制失败：${msg(error)}` })
        }
      }

      const runNow = async () => {
        setBusy('run')
        setNotice(null)
        try {
          const saved = await postJson('/data-collector/run', {})
          setData(saved.state)
          setNotice({ tone: 'ok', text: '已开始采集，进度会显示在本页顶部。' })
        } catch (error) {
          setNotice({ tone: 'danger', text: `采集失败：${errText(error)}` })
        } finally {
          setBusy('')
        }
      }

      if (!data) {
        return h(
          'div',
          { style: ROOT },
          h('div', { style: HEADER }, h('div', { style: { fontSize: 16, fontWeight: 600 } }, '市场线索')),
          h('div', { style: CONTENT }, h('div', { style: { ...card, ...hint } }, loadError ? `面板数据加载失败：${loadError}` : '加载中…')),
        )
      }

      let tabContent = null
      if (tab === 'overview') tabContent = h(OverviewTab, { data, onSelectTab: selectTab })
      else if (tab === 'topics') tabContent = h(TopicsTab, { data, topicSel, form: topicForm, setForm: setTopicForm, onSelect: chooseTopic, onNew: startNewTopic, onSave: saveTopic, onDelete: deleteTopic, busy, dirty: topicDirty, scopeDraft, setScopeDraft, onSaveScope: saveScopeDraft })
      else if (tab === 'channels') tabContent = h(ChannelsTab, { data, channelSel, form: channelForm, setForm: setChannelForm, onSelect: chooseChannel, onNew: startNewChannel, onSave: saveChannel, onDelete: deleteChannel, onTest: testChannel, onAddPreset: addPresetChannel, onAddAllPresets: addAllPresets, busy, testResult, dirty: channelDirty })
      else if (tab === 'schedule') tabContent = h(ScheduleTab, { data, draft: scheduleDraft, setDraft: setScheduleDraft, onSave: saveSchedule, onRun: runNow, busy })
      else if (tab === 'crm')
        tabContent = h(CrmTab, {
          data,
          crmStatus,
          crmProbe,
          crmOptions,
          busy,
          onSaveConnection: saveCrmConnection,
          onTest: testCrm,
          onCrmConfig: saveCrmBoth,
          onRefresh: async () => {
            await loadCrmStatus()
            await loadCrmOptions()
            setNotice({ tone: 'ok', text: 'CRM 状态已刷新。' })
          },
        })
      else tabContent = h(ResultsTab, { data, filters, setFilters, results, onLoad: loadResults, busy, onRun: runNow, onClear: clearResults, onDelete: deleteLead, detail, onShowDetail: setDetail, onCloseDetail: () => setDetail(null), onCopyDetail: copyDetail, onNotice: setNotice, crmOptions, crmBusy: busy === 'crm-precheck' ? 'precheck' : busy === 'crm-push' ? 'crm-push' : '', selected, onToggleSelect: toggleSelect, onSelectAll: setSelected, onCrmPrecheck: openCrmPrecheck, onCrmConfig: saveCrmPool, crmPre, onCrmClose: () => setCrmPre(null), onCrmConfirm: confirmCrmPush, onCrmPushOne: pushOneToCrm })

      return h(
        'div',
        { style: ROOT },
        h(
          'div',
          { style: HEADER },
          h(
            'div',
            { style: { ...row, justifyContent: 'space-between', alignItems: 'flex-start' } },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'flex-start', gap: 10 } },
              h('span', { style: { width: 4, height: 22, borderRadius: 2, background: BRAND_GRADIENT, marginTop: 2, flex: '0 0 auto' } }),
              h(
                'div',
                null,
                h('div', { style: { fontSize: 17, fontWeight: 700, marginBottom: 4 } }, '市场线索'),
                h('div', { style: hint }, `按主题每天定时抓公开公告，识别成意向客户线索：公司名称 / 联系人 / 联系电话 / 地区 / 备注（网址来源）/ 采集时间。当前范围：${(data.scope && data.scope.label) || '不限地区'}。`),
              ),
            ),
            h('button', { type: 'button', style: smallButton, onClick: () => void refresh() }, '刷新'),
          ),
        ),
        h(
          'div',
          { style: TABSTRIP },
          [
            { id: 'overview', label: '总览', accent: ACCENT, hint: '上次采集到的线索、下次采集时间与最近运行记录。' },
            { id: 'topics', label: '采集主题', accent: OK, hint: '主题决定「关注什么」：标题或摘要命中主题关键词的页面才会进入识别。' },
            { id: 'channels', label: '采集渠道', accent: WARN, hint: '渠道决定「从哪里采」：RSS、JSON 接口、网页列表或网页搜索。' },
            { id: 'schedule', label: '定时任务', accent: ACCENT, hint: '默认每天早上采集一次；只在 Harness 运行时生效。' },
            { id: 'results', label: '线索', accent: OK, hint: '公司名称 / 联系人 / 联系电话 / 地区 / 采集时间，点「详情」看备注与来源，可导出 Excel。' },
            { id: 'crm', label: 'CRM', accent: ACCENT, hint: 'CRM 连接配置与写入默认值：服务器地址、API Key、只读开关、线索池与产品。' },
          ].map((item) =>
            h(
              'button',
              {
                key: item.id,
                type: 'button',
                style: {
                  ...button,
                  border: 'none',
                  borderBottom: `2px solid ${tab === item.id ? item.accent : 'transparent'}`,
                  borderRadius: '8px 8px 0 0',
                  background: tab === item.id ? mix(item.accent, 10) : 'transparent',
                  color: tab === item.id ? item.accent : MUTED,
                  fontWeight: tab === item.id ? 600 : 400,
                  padding: '7px 14px',
                },
                onClick: () => selectTab(item.id),
              },
              item.label,
            ),
          ),
        ),
        h(
          'div',
          { style: CONTENT },
          notice
            ? h(
                'div',
                {
                  style: {
                    ...card,
                    padding: '9px 12px',
                    marginBottom: 10,
                    fontSize: 12,
                    borderColor: mix(notice.tone === 'danger' ? DANGER : OK, 45),
                    background: notice.tone === 'danger' ? DANGER_SOFT : OK_SOFT,
                    color: notice.tone === 'danger' ? DANGER : OK,
                  },
                },
                notice.text,
              )
            : null,
          tabContent,
        ),
        h('div', { style: { ...hint, padding: '0 28px 14px', wordBreak: 'break-all' } }, `配置：${data.dataFile || ''}｜线索库（SQLite）：${data.dbFile || ''}${data.dbBytes ? `（${Math.round(data.dbBytes / 1024)} KB）` : ''}｜报告目录：${data.reportDir || ''}`),
        crmResult ? h(CrmResult, { result: crmResult, onClose: () => setCrmResult(null) }) : null,
        toast ? h(Toast, { toast, onClose: () => setToast(null) }) : null,
      )
    }

    // ------------------------------------------------------------------ 注册
    const SidebarIcon = () =>
      h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: 6, background: BRAND_GRADIENT, color: 'var(--dsw-alias-bg-layer-1, #ffffff)', fontSize: 11, fontWeight: 700 } },
        '线',
      )

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: 'data-collector', order: 9, label: () => '市场线索' }, SidebarIcon),
        )
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'data-collector' }, CollectorPanel))
      },
    }
  },
})

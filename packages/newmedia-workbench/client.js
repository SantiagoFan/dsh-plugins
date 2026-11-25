/**
 * Client half of @mindlink-ai/dsh-newmedia-workbench.
 *
 * 左侧边栏注册「新媒体工作台」入口（sidebar.panellist），
 * 主面板挂同名页面（main，key 必须与侧边栏 id 一致）。
 *
 * 一张定位卡可以关联多个平台账号（抖音 / 视频号 / 小红书 / 公众号 …），
 * 每个平台账号可以一键获取粉丝量（能自动的自动，不能的提示手动填写）。
 *
 * 面板只通过同源 /newmedia-workbench/* 路由与 Host 通信，不依赖任何 @deepseek-ai Client 包：
 *   GET  /newmedia-workbench/state      全部定位卡 + 平台/阶段/能力 + 凭证掩码状态
 *   POST /newmedia-workbench/save       新建或更新一张定位卡（含 platforms 数组）
 *   POST /newmedia-workbench/delete     删除一张定位卡
 *   GET  /newmedia-workbench/context    取某定位卡的口播上下文 Markdown
 *   POST /newmedia-workbench/followers/sync  获取粉丝量（body.id 指定定位卡；不传则全部）
 *   GET/POST /newmedia-workbench/settings    平台凭证 / 代理设置（只回显掩码）
 *
 * 「口播上下文」在 Host 端（buildBrief）与本文件 briefOf() 各生成一份，
 * 两边格式必须一致，改格式时请同时修改 index.js 的 buildBrief()。
 */
window.__ModuleLoader__.load({
  id: '@mindlink-ai/dsh-newmedia-workbench',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const MUTED = 'var(--dsw-alias-label-secondary, #6b7280)'
    const TEXT = 'var(--dsw-alias-label-primary, #111827)'
    const BORDER = 'var(--dsw-alias-border-l2, #d1d5db)'
    const BORDER_SUBTLE = 'var(--dsw-alias-border-l1, #e5e7eb)'
    const PANEL = 'var(--dsw-alias-bg-layer-1, #ffffff)'
    const NESTED = 'var(--dsw-alias-bg-layer-2, #f9fafb)'
    const ACCENT = 'var(--dsw-alias-brand-primary, #2563eb)'
    // 主按钮文字：浅色主题 brand-primary 是深色、深色主题是近白色，
    // 所以文字用「反向的表面色」，两套主题都保持对比度。
    const ACCENT_TEXT = 'var(--dsw-alias-bg-layer-1, #ffffff)'
    const DANGER = 'var(--dsw-alias-state-error-primary, #b91c1c)'
    const OK = 'var(--dsw-alias-state-success-primary, #15803d)'
    const WARN = 'var(--dsw-alias-state-warn-primary, #b45309)'

    /** 平台顺序与 Host 端 index.js 的 PLATFORMS 保持一致。 */
    const PLATFORMS = [
      { key: 'douyin', label: '抖音' },
      { key: 'shipinhao', label: '视频号' },
      { key: 'xiaohongshu', label: '小红书' },
      { key: 'wechat', label: '公众号' },
      { key: 'bilibili', label: 'B站' },
      { key: 'kuaishou', label: '快手' },
      { key: 'youtube', label: 'YouTube' },
      { key: 'tiktok', label: 'TikTok' },
      { key: 'other', label: '其他' },
    ]
    const STAGES = ['冷启动', '成长期', '成熟期', '转型期', '矩阵号']

    const card = {
      border: `1px solid ${BORDER}`,
      borderRadius: 10,
      padding: '14px 16px',
      background: PANEL,
      marginBottom: 14,
    }
    const cardTitle = { fontSize: 14, fontWeight: 600, marginBottom: 4 }
    const hint = { fontSize: 12, color: MUTED, lineHeight: 1.7 }
    const button = {
      cursor: 'pointer',
      border: `1px solid ${BORDER}`,
      background: 'transparent',
      color: TEXT,
      borderRadius: 6,
      padding: '4px 10px',
      fontSize: 13,
      marginRight: 8,
      fontFamily: 'inherit',
    }
    const primaryButton = { ...button, background: ACCENT, borderColor: ACCENT, color: ACCENT_TEXT }
    const smallButton = { ...button, padding: '2px 8px', fontSize: 12, marginRight: 0 }
    const dangerButton = { ...smallButton, color: DANGER, borderColor: BORDER }
    /** 用不到的按钮要看起来就点不了。 */
    const withDisabled = (style, disabled) => (disabled ? { ...style, opacity: 0.5, cursor: 'not-allowed' } : style)
    const input = {
      boxSizing: 'border-box',
      width: '100%',
      border: `1px solid ${BORDER}`,
      borderRadius: 6,
      padding: '6px 8px',
      fontSize: 13,
      color: TEXT,
      background: 'transparent',
      fontFamily: 'inherit',
    }
    const textarea = { ...input, minHeight: 58, resize: 'vertical', lineHeight: 1.6 }
    const row = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
    const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }
    const sectionGrid = {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
      gap: '10px 14px',
    }
    const clamp2 = {
      display: '-webkit-box',
      WebkitLineClamp: 2,
      WebkitBoxOrient: 'vertical',
      overflow: 'hidden',
    }
    const grid = {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))',
      gap: 12,
    }

    // 顶栏固定 + 页签切换 + 内容区自滚动（与战略企划部工作台同构）
    const ROOT = {
      boxSizing: 'border-box',
      height: '100%',
      flex: '1 1 auto',
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      color: TEXT,
      fontSize: 13,
    }
    const INNER = { boxSizing: 'border-box', width: '100%', maxWidth: 1120, margin: '0 auto' }
    const HEADER = { flex: 'none', padding: '18px 28px 0', boxSizing: 'border-box' }
    const TABSTRIP = { flex: 'none', padding: '8px 28px 0', boxSizing: 'border-box', borderBottom: `1px solid ${BORDER_SUBTLE}` }
    const TABSCROLL = {
      flex: '1 1 auto',
      minHeight: 0,
      overflowY: 'auto',
      overflowX: 'hidden',
      scrollbarGutter: 'stable',
    }
    const TABPAD = { padding: '16px 28px 40px', boxSizing: 'border-box' }
    const STAT = {
      boxSizing: 'border-box',
      border: `1px solid ${BORDER_SUBTLE}`,
      borderRadius: 10,
      background: NESTED,
      padding: '9px 12px',
      minWidth: 0,
    }

    const platformLabel = (key) => {
      const found = PLATFORMS.find((item) => item.key === key)
      return found ? found.label : '其他'
    }

    const splitList = (value) => {
      if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
      return String(value || '')
        .split(/[\n、，,;；]+/)
        .map((item) => item.trim())
        .filter(Boolean)
    }

    const fmtTime = (value) => {
      if (!value) return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    const fmtDateOnly = (value) => {
      if (!value) return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }

    /** 与 Host 端 lib/followers.js 的 formatCount() 保持同一格式。 */
    const fmtCount = (value) => {
      const num = Number(value)
      if (!Number.isFinite(num)) return ''
      const trim = (text) => String(text).replace(/\.0$/, '')
      if (num >= 1e8) return `${trim((num / 1e8).toFixed(1))}亿`
      if (num >= 1e4) return `${trim((num / 1e4).toFixed(1))}万`
      return String(Math.max(0, Math.round(num)))
    }

    /** 与 Host 端 describeFollowers() 保持同一格式。 */
    const followersBrief = (account) => {
      const rawCount = account && account.followersCount
      if (rawCount === null || rawCount === undefined || rawCount === '') return String((account && account.followers) || '')
      const count = Number(rawCount)
      if (!Number.isFinite(count)) return String((account && account.followers) || '')
      const exact = count.toLocaleString('zh-CN')
      const display = String((account && account.followers) || '')
      const summarized = display && display !== fmtCount(count) ? `${display}（${exact}）` : exact
      const when = account.followersUpdatedAt ? `，${fmtDateOnly(account.followersUpdatedAt)} 采集` : ''
      const source = account.followersSource === 'auto' ? '自动采集' : account.followersSource === 'manual' ? '手动填写' : ''
      return `${summarized}${when}${source ? `，${source}` : ''}`
    }

    /** 与 Host 端 describePlatformAccount() 保持同一格式。 */
    const platformAccountBrief = (account) => {
      const parts = [platformLabel(account.platform)]
      if (account.name) parts.push(`账号 ${account.name}`)
      if (account.handle) parts.push(String(account.handle))
      if (account.uid) parts.push(`ID ${account.uid}`)
      if (account.homepage) parts.push(`主页 ${account.homepage}`)
      const followers = followersBrief(account)
      if (followers) parts.push(`粉丝量 ${followers}`)
      if (account.note) parts.push(`备注 ${account.note}`)
      return parts.join('｜')
    }

    /** 与 Host 端 buildBrief() 保持同一格式。platforms 由「平台账号」页签里关联的账号提供。 */
    const briefOf = (source, platforms) => {
      const cardData = source || {}
      const name = String(cardData.name || '').trim() || '未命名定位卡'
      const lines = []
      lines.push(`# 账号定位卡：${name}`)
      lines.push('')
      lines.push('> 以下为该定位卡的信息，用于生成口播文案 / 短视频脚本。请严格遵循；未填写的信息视为未知，不要编造。')
      lines.push('')
      lines.push(`- 定位卡：${name}`)
      if (cardData.stage) lines.push(`- 账号阶段：${cardData.stage}`)
      const linked = Array.isArray(platforms) ? platforms : []
      if (linked.length === 0) {
        lines.push('- 关联平台账号：未关联')
      } else {
        lines.push('- 关联平台账号：')
        linked.forEach((account, index) => lines.push(`  ${index + 1}. ${platformAccountBrief(account)}`))
      }
      if (cardData.niche) lines.push(`- 内容赛道：${cardData.niche}`)
      if (cardData.audience) lines.push(`- 目标受众：${cardData.audience}`)
      if (cardData.persona) lines.push(`- 人设标签：${cardData.persona}`)
      if (cardData.value) lines.push(`- 核心价值主张：${cardData.value}`)
      const pillars = splitList(cardData.pillars)
      if (pillars.length > 0) {
        lines.push('- 内容支柱：')
        pillars.forEach((item, index) => lines.push(`  ${index + 1}. ${item}`))
      }
      if (cardData.tone) lines.push(`- 语气风格：${cardData.tone}`)
      if (cardData.hookStyle) lines.push(`- 开场钩子偏好：${cardData.hookStyle}`)
      if (cardData.differentiator) lines.push(`- 差异化记忆点：${cardData.differentiator}`)
      if (cardData.goal) lines.push(`- 当前阶段目标：${cardData.goal}`)
      if (cardData.monetization) lines.push(`- 变现方式：${cardData.monetization}`)
      const taboo = splitList(cardData.taboo)
      if (taboo.length > 0) lines.push(`- 禁忌与红线：${taboo.join('；')}`)
      const keywords = splitList(cardData.keywords)
      if (keywords.length > 0) lines.push(`- 关键词 / 标签：${keywords.join('、')}`)
      if (cardData.references) lines.push(`- 对标账号：${cardData.references}`)
      if (cardData.notes) lines.push(`- 补充说明：${cardData.notes}`)
      return lines.join('\n')
    }

    const msg = (cause) => {
      if (!cause) return '未知错误'
      if (typeof cause === 'string') return cause
      return String(cause.message || cause)
    }

    const getJson = async (path) => {
      const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data || data.ok === false) throw new Error((data && (data.message || data.error)) || `${response.status} ${response.statusText}`)
      return data
    }

    const postJson = async (path, body) => {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body === undefined ? {} : body),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data || data.ok === false) {
        const detail = data && (data.hint ? `${data.message || data.error}（${data.hint}）` : data.message || data.error)
        const error = new Error(detail || `${response.status} ${response.statusText}`)
        // 保留错误码与 hint，面板可以按错误码给用户能执行的文案，而不是把工具参数写法抛给用户。
        error.code = (data && data.error) || 'http_error'
        error.hint = (data && data.hint) || ''
        throw error
      }
      return data
    }

    const copyText = async (text) => {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        throw new Error('当前浏览器不支持自动复制，请在预览框里手动选中复制')
      }
      await navigator.clipboard.writeText(text)
    }


    const emptyForm = () => ({
      id: '',
      name: '',
      stage: '冷启动',
      niche: '',
      audience: '',
      persona: '',
      value: '',
      pillars: '',
      tone: '',
      hookStyle: '',
      differentiator: '',
      goal: '',
      monetization: '',
      taboo: '',
      keywords: '',
      references: '',
      notes: '',
    })

    const formOf = (source) => {
      const next = emptyForm()
      for (const key of Object.keys(next)) {
        if (source && source[key] !== undefined && source[key] !== null) next[key] = String(source[key])
      }
      if (!next.stage) next.stage = '冷启动'
      return next
    }

    /** 平台账号表单（独立实体，cardId 表示关联到哪张定位卡）。 */
    const emptyAccountForm = (cardId = '') => ({
      id: '',
      cardId,
      platform: 'douyin',
      name: '',
      uid: '',
      homepage: '',
      handle: '',
      note: '',
      followers: '',
      followersCount: null,
      followersUpdatedAt: '',
      followersSource: '',
    })

    const accountFormOf = (source) => {
      const next = emptyAccountForm()
      if (!source) return next
      for (const key of Object.keys(next)) {
        if (source[key] !== undefined && source[key] !== null) next[key] = String(source[key])
      }
      if (!next.platform) next.platform = 'douyin'
      return next
    }

    /** 账号表单是否填了关键信息（平台 + 至少一个标识）。 */
    const hasAccountContent = (item) =>
      Boolean(
        String(item.platform || '').trim() &&
          (String(item.name || '').trim() ||
            String(item.uid || '').trim() ||
            String(item.homepage || '').trim() ||
            String(item.handle || '').trim()),
      )

    const SAMPLE_FORM = {
      ...emptyForm(),
      name: '老板IP',
      stage: '成长期',
      niche: '企业管理 / 老板心法',
      audience: '30-45 岁中小企业老板，公司 20-100 人，最头疼招人和现金流',
      persona: '干了 15 年实业的老板，踩过坑、现在带 80 人团队',
      value: '用自己踩过的坑讲管理，不给正确的废话，只给能落地的动作',
      pillars: '招人用人\n现金流管理\n老板该不该亲自下场',
      tone: '口语化、直接，像跟朋友喝茶时聊天',
      hookStyle: '开头用一句反常识结论或自己的失败经历抓注意力',
      differentiator: '每条视频都讲一个自己真实踩过的坑，并给出具体做法',
      goal: '3 个月抖音涨到 5 万粉，视频号跑通私域',
      monetization: '企业咨询 + 老板私董会',
      taboo: '不承诺保过、不贩卖焦虑、不聊具体公司八卦',
      keywords: '管理、招人、现金流、老板',
      references: '@某某老板IP',
      notes: '示例数据，可直接改成自己账号的内容',
    }

    /** 左侧边栏图标：DSH 传入 size / active 两个 owner props。 */
    function WorkbenchIcon({ size = 16, active = false }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: active ? 2.1 : 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M4 9.6v4.8a1.4 1.4 0 0 0 1.4 1.4h2.3l6.6 3.9V4.3L7.7 8.2H5.4A1.4 1.4 0 0 0 4 9.6z' }),
        h('path', { d: 'M17.4 8.7a4.8 4.8 0 0 1 0 6.6' }),
      )
    }

    function Tag({ tone = 'muted', children }) {
      const strong = tone === 'brand'
      return h(
        'span',
        {
          style: {
            display: 'inline-block',
            padding: '1px 8px',
            borderRadius: 999,
            fontSize: 11,
            lineHeight: 1.6,
            color: strong ? ACCENT : MUTED,
            border: `1px solid ${strong ? ACCENT : BORDER}`,
            whiteSpace: 'nowrap',
          },
        },
        children,
      )
    }

    /** 顶部页签条上的一项 */
    function TabButton({ tab, active, onSelect }) {
      const [hover, setHover] = useState(false)
      return h(
        'button',
        {
          type: 'button',
          onClick: onSelect,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            padding: '9px 14px 11px',
            marginBottom: -1,
            fontSize: 13.5,
            fontWeight: active ? 600 : 500,
            fontFamily: 'inherit',
            color: active ? tab.accent : hover ? TEXT : MUTED,
            borderBottom: `2px solid ${active ? tab.accent : 'transparent'}`,
            transition: 'color .12s ease, border-color .12s ease',
            whiteSpace: 'nowrap',
          },
        },
        h('span', {
          style: { width: 7, height: 7, borderRadius: '50%', background: active ? tab.accent : BORDER, flex: 'none' },
        }),
        tab.label,
        tab.badge
          ? h(
              'span',
              {
                style: {
                  fontSize: 11,
                  lineHeight: 1.5,
                  padding: '1px 7px',
                  borderRadius: 999,
                  background: NESTED,
                  border: `1px solid ${BORDER}`,
                  color: active ? tab.accent : MUTED,
                },
              },
              tab.badge,
            )
          : null,
      )
    }

    /** 顶部统计卡 */
    function Stat({ label, value, accent }) {
      return h(
        'div',
        { style: STAT },
        h('div', { style: { fontSize: 11.5, color: MUTED, marginBottom: 2 } }, label),
        h('div', { style: { fontSize: 17, fontWeight: 600, color: accent, lineHeight: 1.35 } }, value),
      )
    }

    function Field({ label, hint: hintText, children }) {
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h('label', { style: { fontSize: 12, color: MUTED } }, label),
        children,
        hintText ? h('div', { style: { fontSize: 11, color: MUTED, opacity: 0.9 } }, hintText) : null,
      )
    }

    /** 左侧列表的一行：点一下就在右侧打开这张卡。linked 是它关联的平台账号。 */
    function CardListRow({ item, linked = [], selected, onSelect }) {
      const [hover, setHover] = useState(false)
      const platforms = Array.isArray(linked) ? linked : []
      const followers = platforms.reduce((sum, account) => {
        const count = Number(account && account.followersCount)
        return sum + (Number.isFinite(count) ? count : 0)
      }, 0)
      return h(
        'button',
        {
          type: 'button',
          onClick: onSelect,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: 'block',
            width: '100%',
            boxSizing: 'border-box',
            textAlign: 'left',
            cursor: 'pointer',
            fontFamily: 'inherit',
            border: `1px solid ${selected ? ACCENT : BORDER}`,
            borderLeft: `3px solid ${selected ? ACCENT : BORDER}`,
            borderRadius: 8,
            background: selected ? NESTED : hover ? NESTED : 'transparent',
            padding: '8px 10px',
            color: TEXT,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 } },
          h(
            'span',
            {
              style: {
                fontSize: 13.5,
                fontWeight: 600,
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            item.name || '未命名定位卡',
          ),
          item.stage ? h(Tag, { tone: selected ? 'brand' : 'muted' }, item.stage) : null,
        ),
        h(
          'div',
          { style: { ...hint, marginTop: 3, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' } },
          h('span', null, `${platforms.length} 个平台账号`),
          followers ? h('span', null, `粉丝 ${fmtCount(followers)}`) : null,
          h('span', { style: { flex: '1 1 auto' } }),
          h('span', { style: { ...mono, fontSize: 11 } }, fmtDateOnly(item.updatedAt)),
        ),
      )
    }

    /** 账号列表的一行：点一下就在右侧打开这个账号 */
    function AccountListRow({ item, cardName, capability, selected, onSelect }) {
      const [hover, setHover] = useState(false)
      return h(
        'button',
        {
          type: 'button',
          onClick: onSelect,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: 'block',
            width: '100%',
            boxSizing: 'border-box',
            textAlign: 'left',
            cursor: 'pointer',
            fontFamily: 'inherit',
            border: `1px solid ${selected ? ACCENT : BORDER}`,
            borderLeft: `3px solid ${selected ? ACCENT : BORDER}`,
            borderRadius: 8,
            background: selected || hover ? NESTED : 'transparent',
            padding: '8px 10px',
            color: TEXT,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flexWrap: 'wrap' } },
          h(Tag, { tone: selected ? 'brand' : 'muted' }, platformLabel(item.platform)),
          h(
            'span',
            {
              style: {
                fontSize: 13,
                fontWeight: 600,
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            item.name || item.handle || item.uid || '未命名账号',
          ),
        ),
        h(
          'div',
          { style: { ...hint, marginTop: 3, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' } },
          h('span', { style: { ...mono, fontSize: 11 } }, followersBrief(item) || '未采集'),
          h('span', { style: { flex: '1 1 auto' } }),
          h('span', null, cardName ? `定位卡：${cardName}` : '未关联'),
        ),
        h('div', { style: { ...hint, marginTop: 2, fontSize: 11 } }, capability.autoLabel || '仅手动填写'),
      )
    }

    function WorkbenchPanel() {
      const [data, setData] = useState(null)
      const [loadError, setLoadError] = useState('')
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState('')
      // 定位卡页签：'' 未选 / 'new' 新建中 / 定位卡 id
      const [selected, setSelected] = useState('')
      const [form, setForm] = useState(emptyForm)
      // 平台账号页签：'' 未选 / 'new' 新建中 / 平台账号 id
      const [accountSelected, setAccountSelected] = useState('')
      const [accountForm, setAccountForm] = useState(() => emptyAccountForm())
      const [query, setQuery] = useState('')
      const [platformFilter, setPlatformFilter] = useState('all')
      const [confirmId, setConfirmId] = useState('')
      const [accountConfirmId, setAccountConfirmId] = useState('')
      const [syncingId, setSyncingId] = useState('')
      const [syncingAll, setSyncingAll] = useState(false)
      const [settingsDraft, setSettingsDraft] = useState(null)
      const [tab, setTab] = useState('cards')

      const busyRef = useRef('')
      const tabRef = useRef('cards')
      useEffect(() => {
        busyRef.current = busy
      }, [busy])
      useEffect(() => {
        tabRef.current = tab
      }, [tab])

      const refresh = useCallback(async (options) => {
        const silent = Boolean(options && options.silent)
        try {
          const next = await getJson('/newmedia-workbench/state')
          setData(next)
          setLoadError('')
        } catch (cause) {
          if (!silent) setLoadError(msg(cause))
        }
      }, [])

      useEffect(() => {
        refresh()
        const timer = setInterval(() => {
          if (busyRef.current) return
          if (tabRef.current === 'settings') return
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          refresh({ silent: true })
        }, 8000)
        return () => clearInterval(timer)
      }, [refresh])

      const doRefresh = async () => {
        if (busy) return
        setBusy('refresh')
        try {
          await refresh()
        } finally {
          setBusy('')
        }
      }

      const cards = useMemo(() => {
        const list = (data && Array.isArray(data.cards) ? data.cards : []).slice()
        list.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
        return list
      }, [data])

      const accounts = useMemo(() => {
        const list = (data && Array.isArray(data.accounts) ? data.accounts : []).slice()
        list.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
        return list
      }, [data])

      /** 某张定位卡关联的平台账号。 */
      const linkedOf = (cardId) => accounts.filter((item) => item.cardId === cardId)
      const cardNameOf = (cardId) => {
        const card = cards.find((item) => item.id === cardId)
        return card ? card.name : ''
      }

      const filtered = useMemo(() => {
        const q = query.trim().toLowerCase()
        return cards.filter((card) => {
          const linked = accounts.filter((item) => item.cardId === card.id)
          if (platformFilter !== 'all' && !linked.some((item) => item.platform === platformFilter)) return false
          if (!q) return true
          const haystack = [
            card.name,
            card.niche,
            card.audience,
            card.persona,
            card.value,
            card.keywords,
            card.references,
            ...linked.map((item) => `${item.name} ${item.uid} ${item.homepage}`),
          ]
            .map((value) => String(value || '').toLowerCase())
            .join('\n')
          return haystack.includes(q)
        })
      }, [cards, accounts, platformFilter, query])

      /** 平台能力表：来自 Host 的 capabilities，取不到时退回「仅手动填写」。 */
      const capabilityMap = useMemo(() => {
        const map = {}
        const list = data && Array.isArray(data.capabilities) ? data.capabilities : []
        for (const item of list) if (item && item.key) map[item.key] = item
        return map
      }, [data])
      const capabilityOf = (platform) => capabilityMap[platform] || { key: platform, auto: 'manual', autoLabel: '仅手动填写', note: '', needs: [] }
      const platformFields = (data && data.platformFields) || {}

      const startCreate = () => {
        setForm(emptyForm())
        setSelected('new')
        setNotice(null)
        setConfirmId('')
      }
      const startEdit = (item) => {
        setForm(formOf(item))
        setSelected(String(item.id))
        setNotice(null)
        setConfirmId('')
      }
      const clearSelection = () => {
        setSelected('')
        setNotice(null)
        setConfirmId('')
      }
      /** 从凭证设置回到定位卡页签 */
      const backToCards = () => {
        setTab('cards')
        setNotice(null)
        setConfirmId('')
      }
      const change = (field) => (event) => {
        const value = event && event.target ? event.target.value : ''
        setForm((prev) => ({ ...prev, [field]: value }))
      }

      // ---- 平台账号（独立页签）：选中 / 新建 / 修改
      const startCreateAccount = (cardId = '') => {
        setAccountForm(emptyAccountForm(cardId))
        setAccountSelected('new')
        setNotice(null)
        setAccountConfirmId('')
      }
      const startEditAccount = (item) => {
        setAccountForm(accountFormOf(item))
        setAccountSelected(String(item.id))
        setNotice(null)
        setAccountConfirmId('')
      }
      const clearAccountSelection = () => {
        setAccountSelected('')
        setNotice(null)
        setAccountConfirmId('')
      }
      const changeAccount = (field) => (event) => {
        const value = event && event.target ? event.target.value : ''
        setAccountForm((prev) => {
          const next = { ...prev, [field]: value }
          if (field === 'platform') {
            // 换平台后原来的账号 ID / 粉丝量都不再适用
            next.uid = ''
            next.homepage = ''
            next.followers = ''
            next.followersCount = null
            next.followersUpdatedAt = ''
            next.followersSource = ''
          }
          if (field === 'followers') {
            next.followersCount = null
            next.followersSource = 'manual'
            next.followersUpdatedAt = ''
          }
          return next
        })
      }

      const save = async (options) => {
        if (busy) return null
        if (!String(form.name || '').trim()) {
          setNotice({ kind: 'err', text: '请先填写定位卡名（例如「老板IP」）。' })
          return null
        }
        const keep = Boolean(options && options.keep)
        setBusy('save')
        setNotice(null)
        try {
          // 定位卡只保存人设字段；平台账号在「平台账号」页签单独维护并关联。
          const result = await postJson('/newmedia-workbench/save', { account: { ...form } })
          if (result.state) setData(result.state)
          setBusy('')
          if (!keep) {
            // 保存后仍留在右侧编辑区：新建的卡切换成「已保存」的 id，继续改还是同一条。
            const savedAccount = result && result.account ? result.account : null
            if (savedAccount && savedAccount.id) {
              setSelected(String(savedAccount.id))
              setForm(formOf(savedAccount))
            }
            setConfirmId('')
            setNotice({ kind: 'ok', text: `已保存定位卡「${String(form.name).trim()}」。之后在对话里说「按这个账号写口播文案」，AI 会读到它。` })
          }
          return result
        } catch (cause) {
          setBusy('')
          const duplicate = cause && cause.code === 'duplicate_name'
          setNotice({
            kind: 'err',
            text: duplicate ? '已有同名定位卡：换个名字，或在左侧选中那张卡直接改。' : `保存失败：${msg(cause)}`,
          })
          return null
        }
      }

      /** 同步结果 → 通知样式：视频号/公众号「需手动填写」不算失败，用 warn 而不是红。 */
      const syncNotice = (result) => {
        if (!result || !result.total) return { kind: 'err', text: '还没有平台账号：到「平台账号」页签新增一个，再获取粉丝量。' }
        if (result.failed > 0) return { kind: result.synced > 0 || result.manual > 0 ? 'warn' : 'err', text: result.hint }
        return { kind: result.manual > 0 ? 'warn' : 'ok', text: result.hint }
      }

      /** 保存并立即获取这张卡下所有平台账号的粉丝量。 */
      const saveAndSync = async () => {
        if (busy) return
        if (!String(form.name || '').trim()) {
          setNotice({ kind: 'err', text: '请先填写定位卡名。' })
          return
        }
        const saved = await save({ keep: true })
        if (!saved || !saved.account) return
        setBusy('')
        setSyncingAll(true)
        try {
          const result = await postJson('/newmedia-workbench/followers/sync', { id: saved.account.id })
          if (result.state) setData(result.state)
          setSelected(String(saved.account.id))
          setForm(formOf(saved.account))
          setConfirmId('')
          setNotice(syncNotice(result))
        } catch (cause) {
          setNotice({ kind: 'err', text: `获取粉丝量失败：${msg(cause)}` })
        } finally {
          setSyncingAll(false)
          setBusy('')
        }
      }

      const remove = async (id) => {
        if (busy) return
        setBusy('delete')
        setNotice(null)
        try {
          const result = await postJson('/newmedia-workbench/delete', { id })
          if (result.state) setData(result.state)
          setBusy('')
          setConfirmId('')
          setSelected((current) => (String(current) === String(id) ? '' : current))
          setAccountForm((prev) => (prev.cardId === String(id) ? { ...prev, cardId: '' } : prev))
          setNotice({ kind: 'ok', text: '定位卡已删除；它关联的平台账号保留在「平台账号」页签，可重新关联。' })
        } catch (cause) {
          setBusy('')
          setNotice({ kind: 'err', text: `删除失败：${msg(cause)}` })
        }
      }

      const copy = async (source) => {
        try {
          await copyText(briefOf(source, linkedOf(String(source && source.id))))
          const label = String((source && source.name) || '').trim() || '未命名定位卡'
          setNotice({ kind: 'ok', text: `已复制「${label}」的口播上下文，可直接粘贴到对话里。` })
        } catch (cause) {
          setNotice({ kind: 'err', text: `复制失败：${msg(cause)}` })
        }
      }

      /** 单张定位卡：刷新它关联的所有平台账号的粉丝量。 */
      const syncCard = async (id) => {
        if (syncingId || syncingAll || busy) return
        const linked = linkedOf(String(id))
        if (linked.length === 0) {
          setNotice({ kind: 'err', text: '这张定位卡还没有关联平台账号：到「平台账号」页签新增或选中账号，把「关联定位卡」选成这张卡。' })
          return
        }
        setSyncingId(String(id))
        setNotice(null)
        try {
          const result = await postJson('/newmedia-workbench/followers/sync', { id })
          if (result.state) setData(result.state)
          setNotice(syncNotice(result))
        } catch (cause) {
          setNotice({ kind: 'err', text: `获取粉丝量失败：${msg(cause)}` })
        } finally {
          setSyncingId('')
        }
      }

      /** 单个平台账号：只刷这一个。 */
      const syncAccount = async (id) => {
        if (syncingId || syncingAll || busy) return
        setSyncingId(String(id))
        setNotice(null)
        try {
          const result = await postJson('/newmedia-workbench/followers/sync', { id })
          if (result.state) setData(result.state)
          setNotice(syncNotice(result))
        } catch (cause) {
          setNotice({ kind: 'err', text: `获取粉丝量失败：${msg(cause)}` })
        } finally {
          setSyncingId('')
        }
      }

      /** 一键获取全部平台账号的粉丝量。 */
      const syncAllFollow = async () => {
        if (syncingAll || syncingId || busy) return
        setSyncingAll(true)
        setNotice(null)
        try {
          const result = await postJson('/newmedia-workbench/followers/sync', {})
          if (result.state) setData(result.state)
          if (!result.total) setNotice({ kind: 'err', text: '还没有平台账号：到「平台账号」页签新增一个，再获取粉丝量。' })
          else setNotice(syncNotice(result))
        } catch (cause) {
          setNotice({ kind: 'err', text: `一键获取失败：${msg(cause)}` })
        } finally {
          setSyncingAll(false)
        }
      }

      // ---- 平台账号保存 / 删除 / 解除关联
      const saveAccountForm = async () => {
        if (busy) return null
        if (!hasAccountContent(accountForm)) {
          setNotice({ kind: 'err', text: '平台账号至少要选平台，并填「账号名 / 账号 ID / 主页」之一。' })
          return null
        }
        setBusy('account')
        setNotice(null)
        try {
          const payload = { ...accountForm }
          if (!payload.id) delete payload.id
          const result = await postJson('/newmedia-workbench/accounts/save', { account: payload })
          if (result.state) setData(result.state)
          if (result.account && result.account.id) {
            setAccountSelected(String(result.account.id))
            setAccountForm(accountFormOf(result.account))
          }
          setBusy('')
          setAccountConfirmId('')
          setNotice({ kind: 'ok', text: `平台账号已保存${accountForm.cardId ? `，并关联到「${cardNameOf(accountForm.cardId) || '定位卡'}」` : '（当前未关联定位卡）'}。` })
          return result
        } catch (cause) {
          setBusy('')
          setNotice({ kind: 'err', text: `保存平台账号失败：${msg(cause)}` })
          return null
        }
      }

      const removeAccount = async (id) => {
        if (busy) return
        setBusy('account-delete')
        setNotice(null)
        try {
          const result = await postJson('/newmedia-workbench/accounts/delete', { id })
          if (result.state) setData(result.state)
          setBusy('')
          setAccountConfirmId('')
          setAccountSelected((current) => (String(current) === String(id) ? '' : current))
          setNotice({ kind: 'ok', text: '平台账号已删除。' })
        } catch (cause) {
          setBusy('')
          setNotice({ kind: 'err', text: `删除平台账号失败：${msg(cause)}` })
        }
      }

      /** 解除某张定位卡与某个账号的关联（账号保留）。 */
      const unlinkAccount = async (accountId) => {
        if (busy) return
        setBusy('unlink')
        setNotice(null)
        try {
          const result = await postJson('/newmedia-workbench/accounts/save', { account: { id: accountId, cardId: '' } })
          if (result.state) setData(result.state)
          setBusy('')
          setNotice({ kind: 'ok', text: '已解除关联；账号仍在「平台账号」页签，可重新关联。' })
        } catch (cause) {
          setBusy('')
          setNotice({ kind: 'err', text: `解除关联失败：${msg(cause)}` })
        }
      }

      /** 凭证设置：草稿里空值表示「不改动」。 */
      const openSettings = () => {
        const credentials = {}
        for (const item of (data && data.capabilities) || []) credentials[item.key] = { cookie: '', apiKey: '' }
        setSettingsDraft({
          timeoutMs: String((data && data.settings && data.settings.timeoutMs) || 12000),
          proxy: (data && data.settings && data.settings.proxy) || '',
          credentials,
        })
        setTab('settings')
        setNotice(null)
        setConfirmId('')
      }
      const changeSettingsField = (field) => (event) => {
        const value = event && event.target ? event.target.value : ''
        setSettingsDraft((prev) => ({ ...prev, [field]: value }))
      }
      const changeCredential = (platform, field) => (event) => {
        const value = event && event.target ? event.target.value : ''
        setSettingsDraft((prev) => ({
          ...prev,
          credentials: { ...prev.credentials, [platform]: { ...(prev.credentials[platform] || {}), [field]: value } },
        }))
      }
      const saveCredentials = async () => {
        if (busy || !settingsDraft) return
        setBusy('settings')
        setNotice(null)
        try {
          const result = await postJson('/newmedia-workbench/settings', {
            timeoutMs: Number(settingsDraft.timeoutMs) || 12000,
            proxy: settingsDraft.proxy,
            credentials: settingsDraft.credentials,
          })
          if (result.state) setData(result.state)
          const credentials = {}
          for (const item of (data && data.capabilities) || []) credentials[item.key] = { cookie: '', apiKey: '' }
          setSettingsDraft({ timeoutMs: String(Number(settingsDraft.timeoutMs) || 12000), proxy: settingsDraft.proxy || '', credentials })
          setBusy('')
          setNotice({ kind: 'ok', text: '凭证与代理已保存到本机（只回显掩码）。现在回列表就能一键获取粉丝量。' })
        } catch (cause) {
          setBusy('')
          setNotice({ kind: 'err', text: `保存凭证失败：${msg(cause)}` })
        }
      }
      const clearCredential = async (platform) => {
        if (busy) return
        setBusy('settings')
        setNotice(null)
        try {
          const result = await postJson('/newmedia-workbench/settings', { clear: [platform] })
          if (result.state) setData(result.state)
          setBusy('')
          setNotice({ kind: 'ok', text: `已清除「${platformLabel(platform)}」的本机凭证。` })
        } catch (cause) {
          setBusy('')
          setNotice({ kind: 'err', text: `清除凭证失败：${msg(cause)}` })
        }
      }

      const fillSample = () => {
        const dirty = Boolean(String(form.name || '').trim())
        if (dirty && typeof window !== 'undefined' && typeof window.confirm === 'function') {
          if (!window.confirm('填入示例会覆盖当前已填的内容（只填示例文案，不会动已保存的数据），确定继续？')) return
        }
        setForm({ ...SAMPLE_FORM })
        setNotice({ kind: 'ok', text: '已填入示例定位卡（老板IP），改成自己账号的信息后保存；平台账号到「平台账号」页签新增并关联。' })
      }

      const preview = briefOf(form, linkedOf(String(form.id)))

      const editorBusy = Boolean(busy) || syncingAll
      const anySyncing = syncingAll || Boolean(syncingId)
      // 每个页签独有的按钮，渲染在页签内容区顶部（不放到全局顶栏）
      const tabActions =
        tab === 'settings'
          ? h(
              'div',
              { style: row },
              h('button', { style: withDisabled(button, Boolean(busy)), type: 'button', disabled: Boolean(busy), onClick: backToCards }, '返回定位卡'),
              h(
                'button',
                { style: withDisabled(primaryButton, Boolean(busy)), type: 'button', disabled: Boolean(busy), onClick: saveCredentials },
                busy === 'settings' ? '保存中…' : '保存设置',
              ),
            )
          : tab === 'accounts'
            ? h(
                'div',
                { style: row },
                h('button', { style: withDisabled(button, Boolean(busy)), type: 'button', disabled: Boolean(busy), onClick: openSettings }, '凭证设置'),
                h(
                  'button',
                  {
                    style: withDisabled(primaryButton, Boolean(busy) || anySyncing || accounts.length === 0),
                    type: 'button',
                    disabled: Boolean(busy) || anySyncing || accounts.length === 0,
                    onClick: syncAllFollow,
                  },
                  syncingAll ? '获取中…' : '一键获取粉丝量',
                ),
                h(
                  'button',
                  { style: withDisabled(button, Boolean(busy) || anySyncing), type: 'button', disabled: Boolean(busy) || anySyncing, onClick: () => startCreateAccount(selected && selected !== 'new' ? selected : '') },
                  '新增平台账号',
                ),
              )
            : h(
                'div',
                { style: row },
                h('button', { style: withDisabled(button, Boolean(busy)), type: 'button', disabled: Boolean(busy), onClick: openSettings }, '凭证设置'),
                h(
                  'button',
                  {
                    style: withDisabled(primaryButton, Boolean(busy) || anySyncing || accounts.length === 0),
                    type: 'button',
                    disabled: Boolean(busy) || anySyncing || accounts.length === 0,
                    onClick: syncAllFollow,
                  },
                  syncingAll ? '获取中…' : '一键获取粉丝量',
                ),
                h(
                  'button',
                  { style: withDisabled(button, Boolean(busy) || anySyncing), type: 'button', disabled: Boolean(busy) || anySyncing, onClick: startCreate },
                  '新建定位卡',
                ),
              )

      const noticeBar = notice
        ? h(
            'div',
            { role: 'status', 'aria-live': 'polite', style: { fontSize: 12, marginBottom: 12, color: TEXT, lineHeight: 1.7 } },
            h(
              'span',
              { style: { color: notice.kind === 'ok' ? OK : notice.kind === 'warn' ? WARN : DANGER, marginRight: 6, fontWeight: 600 } },
              notice.kind === 'ok' ? '✓' : '⚠',
            ),
            h('span', null, notice.text),
          )
        : null

      // ---------------------------------------------------------------- 编辑页
      const editor = h(
        React.Fragment,
        null,
        h(
          'div',
          { style: card },
          h('div', { style: cardTitle }, form.id ? `编辑定位卡：${form.name || '未命名'}` : '新建定位卡'),
          h(
            'div',
            { style: hint },
            '一张定位卡代表一个「账号人设」（例如老板IP），可以关联多个平台的账号。定位卡会作为「口播上下文」提供给 AI：赛道决定选题，受众决定表达方式，人设与语气决定怎么说，禁忌决定不能碰什么。',
          ),
          h(
            'div',
            { style: { ...sectionGrid, marginTop: 12, maxWidth: 640 } },
            h(Field, { label: '定位卡名 *', hint: '例如：老板IP / 职场学姐 / 思链科技官方' }, h('input', { style: input, value: form.name, placeholder: '例如：老板IP', onChange: change('name') })),
            h(
              Field,
              { label: '账号阶段' },
              h(
                'select',
                { style: input, value: form.stage, onChange: change('stage') },
                [''].concat(STAGES.includes(form.stage) || !form.stage ? STAGES : [form.stage].concat(STAGES)).map((item) =>
                  h('option', { key: item || 'none', value: item }, item || '未填写'),
                ),
              ),
            ),
          ),
        ),
        h(
          'div',
          { style: card },
          h(
            'div',
            { style: { ...row, marginBottom: 6 } },
            h('div', { style: { ...cardTitle, marginBottom: 0, flex: 1 } }, '关联的平台账号'),
            h(
              'button',
              { style: button, type: 'button', onClick: () => { setTab('accounts'); setNotice(null) } },
              '去平台账号页签管理',
            ),
          ),
          h(
            'div',
            { style: hint },
            '定位卡只放人设；平台账号在「平台账号」页签单独维护，选中账号后把「关联定位卡」选成这张即可。',
          ),
          (() => {
            const linked = linkedOf(String(form.id))
            if (linked.length === 0) {
              return h('div', { style: { ...hint, marginTop: 10 } }, '这张卡还没有关联平台账号。')
            }
            return h(
              'div',
              { style: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 } },
              linked.map((account) =>
                h(
                  'div',
                  {
                    key: account.id,
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      flexWrap: 'wrap',
                      border: `1px solid ${BORDER_SUBTLE}`,
                      borderRadius: 8,
                      background: NESTED,
                      padding: '6px 9px',
                    },
                  },
                  h(Tag, { tone: 'brand' }, platformLabel(account.platform)),
                  h('span', { style: { fontSize: 13, fontWeight: 600 } }, account.name || account.uid || '未命名账号'),
                  h('span', { style: { ...hint, flex: '1 1 auto' } }, followersBrief(account) || '未采集'),
                  h(
                    'button',
                    {
                      style: withDisabled(dangerButton, Boolean(busy)),
                      type: 'button',
                      disabled: Boolean(busy),
                      onClick: () => unlinkAccount(account.id),
                    },
                    '解除关联',
                  ),
                ),
              ),
            )
          })(),
        ),
        h(
          'div',
          { style: card },
          h('div', { style: cardTitle }, '定位核心'),
          h(
            'div',
            { style: { ...sectionGrid, marginTop: 8 } },
            h(Field, { label: '内容赛道 / 领域' }, h('input', { style: input, value: form.niche, placeholder: '例如：企业管理 / 老板心法', onChange: change('niche') })),
            h(Field, { label: '人设标签' }, h('input', { style: input, value: form.persona, placeholder: '例如：干了 15 年实业的老板', onChange: change('persona') })),
            h(
              Field,
              { label: '目标受众' },
              h('textarea', {
                style: textarea,
                value: form.audience,
                placeholder: '谁在看？年龄、身份、处境、当下最想解决的问题',
                onChange: change('audience'),
              }),
            ),
            h(
              Field,
              { label: '核心价值主张' },
              h('textarea', {
                style: textarea,
                value: form.value,
                placeholder: '这个账号帮用户解决什么问题？凭什么信你？',
                onChange: change('value'),
              }),
            ),
          ),
        ),
        h(
          'div',
          { style: card },
          h('div', { style: cardTitle }, '内容策略'),
          h(
            'div',
            { style: { ...sectionGrid, marginTop: 8 } },
            h(
              Field,
              { label: '内容支柱（选题方向）', hint: '换行或顿号分隔，2-4 个方向最稳' },
              h('textarea', {
                style: textarea,
                value: form.pillars,
                placeholder: '招人用人\n现金流管理\n老板该不该亲自下场',
                onChange: change('pillars'),
              }),
            ),
            h(Field, { label: '语气风格' }, h('textarea', { style: textarea, value: form.tone, placeholder: '口语化 / 直接 / 犀利 / 温柔陪伴…', onChange: change('tone') })),
            h(
              Field,
              { label: '开场钩子偏好' },
              h('textarea', {
                style: textarea,
                value: form.hookStyle,
                placeholder: '开头 3 秒怎么抓人：反常识、失败案例、利益点…',
                onChange: change('hookStyle'),
              }),
            ),
            h(
              Field,
              { label: '差异化记忆点' },
              h('textarea', {
                style: textarea,
                value: form.differentiator,
                placeholder: '同类账号都在讲什么？你不一样在哪？',
                onChange: change('differentiator'),
              }),
            ),
            h(Field, { label: '当前阶段目标' }, h('input', { style: input, value: form.goal, placeholder: '例如：3 个月抖音涨到 5 万粉', onChange: change('goal') })),
          ),
        ),
        h(
          'div',
          { style: card },
          h('div', { style: cardTitle }, '变现与边界'),
          h(
            'div',
            { style: { ...sectionGrid, marginTop: 8 } },
            h(Field, { label: '变现方式 / 转化路径' }, h('textarea', { style: textarea, value: form.monetization, placeholder: '咨询、课程、带货、私域…', onChange: change('monetization') })),
            h(
              Field,
              { label: '禁忌与红线', hint: '换行或顿号分隔；AI 生成文案时会避开' },
              h('textarea', {
                style: textarea,
                value: form.taboo,
                placeholder: '不承诺保过\n不贩卖焦虑\n不聊具体公司八卦',
                onChange: change('taboo'),
              }),
            ),
            h(Field, { label: '关键词 / 标签' }, h('input', { style: input, value: form.keywords, placeholder: '管理、招人、现金流', onChange: change('keywords') })),
            h(Field, { label: '对标账号' }, h('input', { style: input, value: form.references, placeholder: '@某某、@某某某', onChange: change('references') })),
            h(
              Field,
              { label: '补充说明' },
              h('textarea', { style: textarea, value: form.notes, placeholder: '其他需要 AI 知道的背景、素材、限制', onChange: change('notes') }),
            ),
          ),
        ),
        h(
          'div',
          { style: card },
          h(
            'div',
            { style: { ...row, marginBottom: 6 } },
            h('div', { style: { ...cardTitle, marginBottom: 0, flex: 1 } }, '口播上下文预览'),
            h('button', { style: button, type: 'button', onClick: () => copy(form) }, '复制上下文'),
          ),
          h('div', { style: hint }, '下面是 AI 写口播文案时会读到的内容；共 ' + preview.length + ' 字。'),
          h(
            'pre',
            {
              style: {
                margin: '8px 0 0',
                padding: '10px 12px',
                border: `1px solid ${BORDER}`,
                borderRadius: 8,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: 12,
                lineHeight: 1.7,
                color: TEXT,
                maxHeight: 320,
                overflow: 'auto',
                background: NESTED,
              },
            },
            preview,
          ),
        ),
        h(
          'div',
          { style: { marginBottom: 18 } },
          // 页面很长：把提示和操作放在一起，滚到底部也能看到保存结果。
          noticeBar,
          h(
            'div',
            { style: { ...row } },
            h('button', { style: withDisabled(button, editorBusy), type: 'button', disabled: editorBusy, onClick: () => save() }, busy === 'save' ? '保存中…' : '保存定位卡'),
            h('button', { style: withDisabled(button, editorBusy), type: 'button', disabled: editorBusy, onClick: saveAndSync }, syncingAll ? '获取中…' : '保存并获取粉丝量'),
            h('button', { style: withDisabled(button, editorBusy), type: 'button', disabled: editorBusy, onClick: clearSelection }, '收起'),
          ),
        ),
      )

      // ---------------------------------------------------------------- 凭证设置页
      const settingsView =
        !data || !settingsDraft
          ? h('div', { style: { ...card, ...hint } }, '加载中…')
          : h(
              React.Fragment,
              null,
              h(
                'div',
                { style: card },
                h('div', { style: cardTitle }, '采集设置'),
                h(
                  'div',
                  { style: hint },
                  '凭证与代理只保存在本机 settings.json（权限 0600），不上传、不写进对话日志，面板只回显掩码。输入框留空表示不修改，要清除某平台凭证请点「清除该平台凭证」。',
                ),
                h(
                  'div',
                  { style: { ...sectionGrid, marginTop: 12 } },
                  h(
                    Field,
                    { label: '请求超时（毫秒）', hint: '3000 - 60000；海外平台建议 15000 以上' },
                    h('input', { style: { ...input, maxWidth: 160 }, value: settingsDraft.timeoutMs, onChange: changeSettingsField('timeoutMs') }),
                  ),
                  h(
                    Field,
                    {
                      label: 'HTTP 代理（可选）',
                      hint: '例如 http://127.0.0.1:6696；代理对所有平台生效，配了代理后快手、抖音等国内平台可能反而取不到',
                    },
                    h('input', { style: input, value: settingsDraft.proxy, placeholder: 'http://127.0.0.1:6696', onChange: changeSettingsField('proxy') }),
                  ),
                ),
                data.settings && data.settings.envOverride
                  ? h(
                      'div',
                      { style: { ...hint, marginTop: 10, color: WARN } },
                      '⚠ 检测到环境变量覆盖：当前部分凭证来自 DSH_NMW_* 环境变量，面板里保存的值不会生效，需改环境变量后重启 DSH。',
                    )
                  : null,
              ),
              ((data && data.capabilities) || [])
                .filter((cap) => (cap.needs || []).length > 0)
                .map((cap) => {
                  const masked = (data.settings && data.settings.credentials && data.settings.credentials[cap.key]) || {}
                  const draft = settingsDraft.credentials[cap.key] || { cookie: '', apiKey: '' }
                  return h(
                    'div',
                    { key: cap.key, style: card },
                    h(
                      'div',
                      { style: { ...row, marginBottom: 6 } },
                      h('div', { style: { ...cardTitle, marginBottom: 0, flex: 1 } }, cap.label),
                      h(Tag, { tone: cap.auto === 'free' ? 'brand' : 'muted' }, cap.autoLabel),
                      masked.hasCookie ? h(Tag, null, `Cookie：${masked.cookieMasked}`) : null,
                      masked.hasApiKey ? h(Tag, null, `API Key：${masked.apiKeyMasked}`) : null,
                    ),
                    h('div', { style: hint }, cap.note),
                    h(
                      'div',
                      { style: { ...sectionGrid, marginTop: 10 } },
                      cap.needs.includes('cookie')
                        ? h(
                            Field,
                            { label: 'Cookie', hint: '浏览器登录该平台后，从开发者工具 Console 复制 document.cookie' },
                            h('textarea', {
                              style: { ...textarea, minHeight: 46 },
                              value: draft.cookie,
                              placeholder: masked.hasCookie ? '已保存，留空则不修改' : '粘贴 Cookie',
                              onChange: changeCredential(cap.key, 'cookie'),
                            }),
                          )
                        : null,
                      cap.key === 'youtube'
                        ? h(
                            Field,
                            { label: 'YouTube Data API Key', hint: 'Google Cloud 控制台开通 YouTube Data API v3 后创建，免费配额够用' },
                            h('input', {
                              style: input,
                              type: 'password',
                              value: draft.apiKey,
                              placeholder: masked.hasApiKey ? '已保存，留空则不修改' : 'AIza...',
                              onChange: changeCredential(cap.key, 'apiKey'),
                            }),
                          )
                        : null,
                    ),
                    masked.hasCookie || masked.hasApiKey
                      ? h(
                          'div',
                          { style: { marginTop: 10 } },
                          h('button', { style: dangerButton, type: 'button', disabled: Boolean(busy), onClick: () => clearCredential(cap.key) }, '清除该平台凭证'),
                        )
                      : null,
                  )
                }),
              h(
                'div',
                { style: { ...hint, lineHeight: 1.9 } },
                '视频号、公众号没有公开接口，粉丝量请在定位卡的平台账号里手动填写；B站、快手免配置即可自动获取；抖音需要 Cookie 但有签名风控，失败就手填；小红书需要 Cookie。',
              ),
            )

      // ------------------------------------------- 定位卡：左侧列表 + 右侧编辑
      const barButton = { ...button, marginRight: 0 }
      const barPrimary = { ...primaryButton, marginRight: 0 }
      const barDanger = { ...dangerButton, marginRight: 0 }

      const selectedItem =
        selected && selected !== 'new' ? cards.find((item) => String(item.id) === String(selected)) || null : null
      const isCreating = selected === 'new'
      const editing = isCreating || Boolean(selectedItem)

      const listPane = h(
        'div',
        {
          style: {
            flex: '0 0 320px',
            minWidth: 260,
            maxWidth: 360,
            position: 'sticky',
            top: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          },
        },
        h(
          'div',
          { style: { ...card, padding: '10px 12px', marginBottom: 0 } },
          h(
            'div',
            { style: { ...row, gap: 8 } },
            h('input', {
              style: { ...input, flex: 1, minWidth: 0 },
              value: query,
              placeholder: '搜索定位卡、赛道、人设…',
              onChange: (event) => setQuery(event.target.value),
            }),
          ),
          h(
            'div',
            { style: { ...row, gap: 8, marginTop: 8 } },
            h(
              'select',
              { style: { ...input, flex: 1 }, value: platformFilter, onChange: (event) => setPlatformFilter(event.target.value) },
              h('option', { value: 'all' }, '全部平台'),
              PLATFORMS.map((item) => h('option', { key: item.key, value: item.key }, item.label)),
            ),
            h('span', { style: { ...hint, whiteSpace: 'nowrap' } }, `${filtered.length}/${cards.length}`),
          ),
        ),
        cards.length === 0
          ? h(
              'div',
              { style: { ...card, marginBottom: 0 } },
              h('div', { style: { fontSize: 13.5, fontWeight: 600, marginBottom: 6 } }, '还没有定位卡'),
              h('div', { style: hint }, '点页签上方的「新建定位卡」，在右侧填人设，保存后这里就会列出来；平台账号到「平台账号」页签加。'),
            )
          : filtered.length === 0
            ? h('div', { style: { ...card, ...hint, marginBottom: 0 } }, '没有匹配的定位卡。换个关键词，或把平台筛选改成「全部平台」。')
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                filtered.map((item) =>
                  h(CardListRow, {
                    key: item.id,
                    item,
                    linked: linkedOf(item.id),
                    selected: String(selected) === String(item.id),
                    onSelect: () => startEdit(item),
                  }),
                ),
              ),
      )

      const deleteConfirm = Boolean(selectedItem) && confirmId === selectedItem.id

      const detailBar = h(
        'div',
        { style: { ...card, padding: '10px 12px', marginBottom: 0 } },
        h(
          'div',
          { style: { ...row, gap: 8 } },
          h(
            'div',
            {
              style: {
                fontSize: 13.5,
                fontWeight: 600,
                flex: '1 1 160px',
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            isCreating ? '新建定位卡' : `编辑：${(selectedItem && selectedItem.name) || '未命名'}`,
          ),
          isCreating ? h('button', { style: barButton, type: 'button', onClick: fillSample }, '填入示例') : null,
          selectedItem
            ? h('button', { style: barButton, type: 'button', disabled: Boolean(busy), onClick: () => copy(selectedItem) }, '复制上下文')
            : null,
          selectedItem
            ? h(
                'button',
                {
                  style: withDisabled(barButton, Boolean(busy) || Boolean(syncingId) || syncingAll),
                  type: 'button',
                  disabled: Boolean(busy) || Boolean(syncingId) || syncingAll,
                  onClick: () => syncCard(selectedItem.id),
                },
                syncingId === selectedItem.id ? '获取中…' : '获取粉丝量',
              )
            : null,
          h(
            'button',
            { style: withDisabled(barButton, editorBusy), type: 'button', disabled: editorBusy, onClick: saveAndSync },
            syncingAll ? '获取中…' : '保存并获取',
          ),
          h(
            'button',
            { style: withDisabled(barPrimary, editorBusy), type: 'button', disabled: editorBusy, onClick: () => save() },
            busy === 'save' ? '保存中…' : '保存',
          ),
          deleteConfirm
            ? h('button', { style: barDanger, type: 'button', disabled: Boolean(busy), onClick: () => remove(selectedItem.id) }, '确认删除')
            : selectedItem
              ? h('button', { style: barDanger, type: 'button', disabled: Boolean(busy), onClick: () => setConfirmId(selectedItem.id) }, '删除')
              : null,
          deleteConfirm ? h('button', { style: barButton, type: 'button', onClick: () => setConfirmId('') }, '取消') : null,
        ),
      )

      const detailPane = h(
        'div',
        { style: { flex: '2 1 460px', minWidth: 300, display: 'flex', flexDirection: 'column', gap: 12 } },
        editing
          ? h(React.Fragment, null, detailBar, editor)
          : h(
              'div',
              { style: card },
              h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 6 } }, '从左侧选一张定位卡'),
              h(
                'div',
                { style: hint },
                '选中后直接在右侧改并保存，不用跳转页面。想新建就点页签上方的「新建定位卡」；改完点「保存」，或点「保存并获取」顺便刷新粉丝量。',
              ),
            ),
      )

      const listView = h(
        'div',
        { style: { display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' } },
        listPane,
        detailPane,
      )

      const fileLine = data && data.dataFile
        ? h(
            'div',
            { style: { ...hint, marginTop: 18, paddingTop: 12, borderTop: `1px solid ${BORDER_SUBTLE}` } },
            `数据文件：`,
            h('span', { style: { ...mono, wordBreak: 'break-all' } }, data.dataFile),
            data.settingsFile ? h('br') : null,
            data.settingsFile ? '凭证 / 代理文件：' : null,
            data.settingsFile ? h('span', { style: { ...mono, wordBreak: 'break-all' } }, data.settingsFile) : null,
            h('br'),
            '定位卡与凭证只保存在本机；AI 通过 newmedia_workbench 工具读取定位卡，其他插件可通过 newmediaWorkbench 服务读取。',
          )
        : null

      // 顶部统计
      const platformAccounts = accounts.length
      const followersTotal = accounts.reduce((sum, item) => {
        const count = Number(item && item.followersCount)
        return sum + (Number.isFinite(count) ? count : 0)
      }, 0)
      const unlinkedCount = accounts.filter((item) => !item.cardId).length
      const lastSync = data && data.settings && data.settings.lastSyncAt ? fmtTime(data.settings.lastSyncAt) : '—'

      // --------------------------- 平台账号页签：左侧账号列表 + 右侧账号编辑
      const accountItem =
        accountSelected && accountSelected !== 'new'
          ? accounts.find((item) => String(item.id) === String(accountSelected)) || null
          : null
      const accountEditing = accountSelected === 'new' || Boolean(accountItem)
      const accountDeleteConfirm = Boolean(accountItem) && accountConfirmId === accountItem.id

      const accountListPane = h(
        'div',
        {
          style: {
            flex: '0 0 320px',
            minWidth: 260,
            maxWidth: 360,
            position: 'sticky',
            top: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          },
        },
        h(
          'div',
          { style: { ...card, padding: '10px 12px', marginBottom: 0 } },
          h(
            'div',
            { style: { ...row, gap: 8 } },
            h('span', { style: { fontSize: 13, fontWeight: 600, flex: 1 } }, `${accounts.length} 个平台账号`),
            unlinkedCount > 0 ? h(Tag, { tone: 'muted' }, `${unlinkedCount} 个未关联`) : null,
          ),
          h('div', { style: { ...hint, marginTop: 4 } }, '每个账号可以关联一张定位卡；关联后写文案时会一起作为上下文。'),
        ),
        accounts.length === 0
          ? h(
              'div',
              { style: { ...card, marginBottom: 0 } },
              h('div', { style: { fontSize: 13.5, fontWeight: 600, marginBottom: 6 } }, '还没有平台账号'),
              h('div', { style: hint }, '点上方「新增平台账号」，在右侧填平台、账号名与账号 ID，再把「关联定位卡」选好。'),
            )
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              accounts.map((item) =>
                h(AccountListRow, {
                  key: item.id,
                  item,
                  cardName: cardNameOf(item.cardId),
                  capability: capabilityOf(item.platform),
                  selected: String(accountSelected) === String(item.id),
                  onSelect: () => startEditAccount(item),
                }),
              ),
            ),
      )

      const accountDetailBar = h(
        'div',
        { style: { ...card, padding: '10px 12px', marginBottom: 0 } },
        h(
          'div',
          { style: { ...row, gap: 8 } },
          h(
            'div',
            {
              style: {
                fontSize: 13.5,
                fontWeight: 600,
                flex: '1 1 160px',
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            accountSelected === 'new'
              ? '新增平台账号'
              : `账号：${(accountItem && (accountItem.name || accountItem.uid)) || '未命名'}`,
          ),
          accountItem
            ? h(
                'button',
                {
                  style: withDisabled(barButton, Boolean(busy) || Boolean(syncingId) || syncingAll),
                  type: 'button',
                  disabled: Boolean(busy) || Boolean(syncingId) || syncingAll,
                  onClick: () => syncAccount(accountItem.id),
                },
                syncingId === accountItem.id ? '获取中…' : '获取粉丝量',
              )
            : null,
          h(
            'button',
            { style: withDisabled(barPrimary, Boolean(busy)), type: 'button', disabled: Boolean(busy), onClick: saveAccountForm },
            busy === 'account' ? '保存中…' : '保存账号',
          ),
          accountDeleteConfirm
            ? h('button', { style: barDanger, type: 'button', disabled: Boolean(busy), onClick: () => removeAccount(accountItem.id) }, '确认删除')
            : accountItem
              ? h('button', { style: barDanger, type: 'button', disabled: Boolean(busy), onClick: () => setAccountConfirmId(accountItem.id) }, '删除')
              : null,
          accountDeleteConfirm
            ? h('button', { style: barButton, type: 'button', onClick: () => setAccountConfirmId('') }, '取消')
            : null,
          accountSelected === 'new'
            ? h('button', { style: barButton, type: 'button', onClick: clearAccountSelection }, '取消新增')
            : null,
        ),
      )

      const accountEditor = h(
        'div',
        { style: card },
        h('div', { style: cardTitle }, '账号信息'),
        h(
          'div',
          { style: { ...sectionGrid, marginTop: 10 } },
          h(
            Field,
            { label: '平台 *' },
            h(
              'select',
              { style: input, value: accountForm.platform, onChange: changeAccount('platform') },
              PLATFORMS.map((item) => h('option', { key: item.key, value: item.key }, item.label)),
            ),
          ),
          h(
            Field,
            { label: '关联定位卡', hint: '选一张定位卡；留「未关联」也可以单独维护账号' },
            h(
              'select',
              { style: input, value: accountForm.cardId, onChange: changeAccount('cardId') },
              h('option', { value: '' }, '未关联'),
              cards.map((item) => h('option', { key: item.id, value: item.id }, item.name)),
            ),
          ),
          h(Field, { label: '账号名' }, h('input', { style: input, value: accountForm.name, placeholder: '例如：老板账号', onChange: changeAccount('name') })),
          h(
            Field,
            {
              label: (platformFields[accountForm.platform] || {}).uidLabel || `${platformLabel(accountForm.platform)}账号 ID`,
              hint: (platformFields[accountForm.platform] || {}).uidHint,
            },
            h('input', {
              style: input,
              value: accountForm.uid,
              placeholder: (platformFields[accountForm.platform] || {}).uidPlaceholder || '用于自动获取粉丝量的平台 ID',
              onChange: changeAccount('uid'),
            }),
          ),
          h(
            Field,
            { label: '主页链接（可选）', hint: '粘贴主页链接也能自动解析出账号 ID' },
            h('input', {
              style: input,
              value: accountForm.homepage,
              placeholder: (platformFields[accountForm.platform] || {}).homepageHint || 'https://...',
              onChange: changeAccount('homepage'),
            }),
          ),
          h(
            Field,
            { label: '平台内 handle（可选）' },
            h('input', { style: input, value: accountForm.handle, onChange: changeAccount('handle') }),
          ),
          h(
            Field,
            { label: '粉丝量', hint: '能自动获取的填好账号 ID 后点「获取粉丝量」；不能自动的直接手填（3.2w / 32,000）' },
            h('input', { style: input, value: accountForm.followers, placeholder: '例如：1.1万', onChange: changeAccount('followers') }),
          ),
          h(Field, { label: '备注（可选）' }, h('input', { style: input, value: accountForm.note, onChange: changeAccount('note') })),
        ),
        h('div', { style: { ...hint, marginTop: 8 } }, capabilityOf(accountForm.platform).note || ''),
        accountForm.followersCount !== null && accountForm.followersCount !== undefined && accountForm.followersCount !== ''
          ? h(
              'div',
              { style: { ...hint, marginTop: 8 } },
              h(
                'span',
                { style: { color: accountForm.followersSource === 'auto' ? OK : MUTED, fontWeight: 600, marginRight: 4 } },
                accountForm.followersSource === 'auto' ? '自动采集' : '手动填写',
              ),
              `精确粉丝数：${Number(accountForm.followersCount).toLocaleString('zh-CN')}`,
              accountForm.followersUpdatedAt ? `（${fmtTime(accountForm.followersUpdatedAt)} 采集）` : '',
            )
          : null,
      )

      const accountsPane = h(
        'div',
        { style: { display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' } },
        accountListPane,
        h(
          'div',
          { style: { flex: '2 1 460px', minWidth: 300, display: 'flex', flexDirection: 'column', gap: 12 } },
          accountEditing
            ? h(React.Fragment, null, accountDetailBar, accountEditor)
            : h(
                'div',
                { style: card },
                h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 6 } }, '从左侧选一个平台账号'),
                h(
                  'div',
                  { style: hint },
                  '选中后可以在右侧改平台、账号 ID、粉丝量和「关联定位卡」；改完点「保存账号」。点上方「新增平台账号」可以直接加一个。',
                ),
              ),
        ),
      )

      const tabs = [
        {
          id: 'cards',
          label: '定位卡',
          accent: ACCENT,
          badge: String(cards.length),
          hint: '定位卡只放人设（赛道/受众/人设/语气/支柱/禁忌）；平台账号在「平台账号」页签维护并关联到这里。',
        },
        {
          id: 'accounts',
          label: '平台账号',
          accent: OK,
          badge: String(platformAccounts),
          hint: '账号存在这里，可以新增 / 编辑 / 删除，并选择关联到哪张定位卡；「一键获取粉丝量」按平台能力更新。',
        },
        {
          id: 'settings',
          label: '凭证设置',
          accent: WARN,
          badge: '',
          hint: 'Cookie / API Key / 代理只保存在本机，面板只回显掩码。',
        },
      ]
      const activeTab = tabs.find((item) => item.id === tab) || tabs[0]
      const tabContent =
        activeTab.id === 'settings' ? settingsView : activeTab.id === 'accounts' ? accountsPane : listView

      return h(
        'div',
        { style: ROOT },
        h(
          'div',
          { style: HEADER },
          h(
            'div',
            { style: INNER },
            h(
              'div',
              { style: { ...row, alignItems: 'flex-start' } },
              h(
                'div',
                { style: { flex: 1, minWidth: 220 } },
                h(
                  'div',
                  { style: { fontSize: 18, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 10 } },
                  '新媒体工作台',
                  h(Tag, { tone: 'brand' }, `${cards.length} 张定位卡`),
                  data && data.version
                    ? h('span', { style: { ...mono, color: MUTED, fontWeight: 400 } }, `v${data.version}`)
                    : null,
                ),
                h(
                  'div',
                  { style: { ...hint, marginTop: 4 } },
                  '一张定位卡可以关联多个平台账号，并一键获取粉丝量；写口播文案前 AI 会自动读取定位卡——只有一张卡直接使用，多张会在对话里弹出选择。',
                ),
              ),
            ),
            h(
              'div',
              {
                style: {
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(148px, 1fr))',
                  gap: 10,
                  marginTop: 10,
                },
              },
              h(Stat, { label: '定位卡', value: String(cards.length), accent: ACCENT }),
              h(Stat, { label: '平台账号', value: String(platformAccounts), accent: OK }),
              h(Stat, { label: '粉丝合计', value: followersTotal ? fmtCount(followersTotal) : '—', accent: TEXT }),
              h(Stat, { label: '上次获取', value: lastSync, accent: MUTED }),
            ),
            h('div', { style: { height: 8 } }),
            noticeBar,
            loadError
              ? h(
                  'div',
                  { style: { color: DANGER, fontSize: 12, marginBottom: 8 } },
                  `面板数据加载失败：${loadError}（可在对话里让 Agent 检查插件状态）`,
                )
              : null,
          ),
        ),
        h(
          'div',
          { style: TABSTRIP },
          h(
            'div',
            { style: INNER },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' } },
              tabs.map((item) =>
                h(TabButton, { key: item.id, tab: item, active: item.id === activeTab.id, onSelect: () => setTab(item.id) }),
              ),
            ),
          ),
        ),
        h(
          'div',
          { style: TABSCROLL },
          h(
            'div',
            { style: { ...INNER, ...TABPAD } },
            h(
              'div',
              {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  flexWrap: 'wrap',
                  marginBottom: 12,
                },
              },
              h('span', { style: { width: 4, height: 14, borderRadius: 2, background: activeTab.accent, flex: 'none' } }),
              h('span', { style: { ...hint, flex: '1 1 220px', minWidth: 0 } }, activeTab.hint),
              h('div', { style: { ...row, marginLeft: 'auto', gap: 8 } }, tabActions),
            ),
            data === null && !loadError ? h('div', { style: { ...card, ...hint } }, '加载中…') : null,
            data !== null || loadError ? tabContent : null,
            fileLine,
          ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 左侧菜单栏入口（图标）与对应的主面板；id 必须与 main 的 key 一致。
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'newmedia-workbench', order: 7, label: () => '新媒体工作台' },
            WorkbenchIcon,
          ),
        )
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'newmedia-workbench' }, WorkbenchPanel))
      },
    }
  },
})

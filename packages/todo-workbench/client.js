/**
 * Client half of @mindlink-ai/dsh-todo-workbench.
 *
 * 左侧边栏注册「待办事项」入口（sidebar.panellist），主面板挂同名页面
 * （main，key 必须与侧边栏 id 一致）。面板只通过同源 /todo-workbench/* 路由
 * 与 Host 通信，不依赖任何 @deepseek-ai Client 包。
 *
 * 数据由 Host 持久化；面板每 8 秒静默同步一次，所以对话里让 Agent 记的待办
 * 会自动出现在列表里。
 */
window.__ModuleLoader__.load({
  id: '@mindlink-ai/dsh-todo-workbench',
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
    const ACCENT_TEXT = 'var(--dsw-alias-bg-layer-1, #ffffff)'
    const DANGER = 'var(--dsw-alias-state-error-primary, #b91c1c)'
    const OK = 'var(--dsw-alias-state-success-primary, #15803d)'
    const WARN = 'var(--dsw-alias-state-warn-primary, #b45309)'

    const PRIORITIES = [
      { key: 'high', label: '高' },
      { key: 'medium', label: '中' },
      { key: 'low', label: '低' },
    ]
    const PRIORITY_LABEL = { high: '高', medium: '中', low: '低' }
    const PRIORITY_COLOR = { high: DANGER, medium: WARN, low: MUTED }
    const TABS = [
      { key: 'all', label: '未完成', hint: '只看未完成的待办' },
      { key: 'today', label: '今天', hint: '含逾期任务' },
      { key: 'week', label: '本周', hint: '含逾期和今天到期的任务' },
      { key: 'calendar', label: '日历', hint: '按月查看每天到期的待办' },
      { key: 'done', label: '已完成', hint: '已完成的任务' },
    ]
    const GROUP_LABEL = { overdue: '逾期', today: '今天', week: '本周', later: '以后', none: '无截止日期', done: '已完成' }

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
    const INNER = { boxSizing: 'border-box', width: '100%', maxWidth: 980, margin: '0 auto' }
    const HEADER = { flex: 'none', padding: '20px 28px 0', boxSizing: 'border-box' }
    const SCROLL = { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overflowX: 'hidden', scrollbarGutter: 'stable' }
    const PAD = { padding: '14px 28px 40px', boxSizing: 'border-box' }

    const card = { border: `1px solid ${BORDER_SUBTLE}`, borderRadius: 12, background: PANEL }
    const hint = { fontSize: 12, color: MUTED, lineHeight: 1.7 }
    const button = {
      cursor: 'pointer',
      border: `1px solid ${BORDER}`,
      background: 'transparent',
      color: TEXT,
      borderRadius: 7,
      padding: '5px 11px',
      fontSize: 13,
      fontFamily: 'inherit',
      lineHeight: 1.5,
      whiteSpace: 'nowrap',
    }
    const primaryButton = { ...button, background: ACCENT, borderColor: ACCENT, color: ACCENT_TEXT, fontWeight: 500 }
    const smallButton = { ...button, padding: '2px 8px', fontSize: 12 }
    const withDisabled = (style, disabled) => (disabled ? { ...style, opacity: 0.55, cursor: 'not-allowed' } : style)
    const input = {
      boxSizing: 'border-box',
      width: '100%',
      border: `1px solid ${BORDER}`,
      borderRadius: 7,
      padding: '6px 9px',
      fontSize: 13,
      color: TEXT,
      background: 'transparent',
      fontFamily: 'inherit',
      lineHeight: 1.6,
    }
    const select = { ...input, cursor: 'pointer' }
    const textarea = { ...input, minHeight: 66, resize: 'vertical', lineHeight: 1.65 }
    const row = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
    const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11.5 }
    const clamp1 = {
      display: '-webkit-box',
      WebkitLineClamp: 1,
      WebkitBoxOrient: 'vertical',
      overflow: 'hidden',
    }

    // 只在面板内生效的焦点样式：内联 style 表达不了 :focus-visible。
    const LOCAL_STYLE = `
      .todo-wb-root button:focus-visible,
      .todo-wb-root input:focus-visible,
      .todo-wb-root select:focus-visible,
      .todo-wb-root textarea:focus-visible {
        outline: 2px solid ${ACCENT};
        outline-offset: 1px;
      }
      .todo-wb-root input::placeholder,
      .todo-wb-root textarea::placeholder { color: ${MUTED}; opacity: .8; }
    `

    const pad2 = (value) => String(value).padStart(2, '0')
    const dateKeyOf = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    const todayKey = () => dateKeyOf(new Date())
    const addDays = (key, days) => {
      const [y, m, d] = key.split('-').map(Number)
      const date = new Date(y, m - 1, d)
      date.setDate(date.getDate() + days)
      return dateKeyOf(date)
    }
    const endOfWeek = (today) => {
      if (!today) return todayKey()
      const [y, m, d] = today.split('-').map(Number)
      const date = new Date(y, m - 1, d)
      const weekday = (date.getDay() + 6) % 7
      return addDays(today, 6 - weekday)
    }
    const daysBetween = (from, to) => {
      const [fy, fm, fd] = from.split('-').map(Number)
      const [ty, tm, td] = to.split('-').map(Number)
      return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000)
    }
    const parseKey = (key) => {
      const [y, m, d] = key.split('-').map(Number)
      return { y, m, d }
    }

    const weekdayName = (key) => {
      if (!key) return ''
      const [y, m, d] = key.split('-').map(Number)
      return '日一二三四五六'[new Date(y, m - 1, d).getDay()]
    }

    const dueLabel = (todo, today) => {
      if (!todo.dueDate) return ''
      if (todo.dueDate < today) return `逾期 ${daysBetween(todo.dueDate, today)} 天`
      if (todo.dueDate === today) return '今天'
      if (todo.dueDate === addDays(today, 1)) return '明天'
      const { y, m, d } = parseKey(todo.dueDate)
      return y === new Date().getFullYear() ? `${m}月${d}日` : `${y}年${m}月${d}日`
    }

    const dueTone = (todo, today) => {
      if (!todo.dueDate || todo.status === 'done') return MUTED
      if (todo.dueDate < today) return DANGER
      if (todo.dueDate === today) return WARN
      return MUTED
    }

    const PRIORITY_RANK = { high: 0, medium: 1, low: 2 }
    const sortDayTodos = (a, b) => {
      if (a.status !== b.status) return a.status === 'open' ? -1 : 1
      return (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1)
    }

    const monthTitleOf = (monthKey) => {
      const [year, month] = monthKey.split('-').map(Number)
      return `${year}年${month}月`
    }

    /** 以周一为一周第一天，返回 6×7 = 42 个日期格。 */
    const buildMonthCells = (monthKey, today) => {
      const [year, month] = monthKey.split('-').map(Number)
      const first = new Date(year, month - 1, 1)
      const offset = (first.getDay() + 6) % 7
      const cells = []
      for (let index = 0; index < 42; index += 1) {
        const date = new Date(year, month - 1, 1 - offset + index)
        const key = dateKeyOf(date)
        cells.push({ key, day: date.getDate(), inMonth: date.getMonth() === month - 1, isToday: key === today })
      }
      return cells
    }

    const shiftMonthKey = (monthKey, delta) => {
      const [year, month] = monthKey.split('-').map(Number)
      const date = new Date(year, month - 1 + delta, 1)
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`
    }

    const completedLabel = (iso) => {
      if (!iso) return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      const sameYear = date.getFullYear() === new Date().getFullYear()
      return `${sameYear ? '' : `${date.getFullYear()}年`}${date.getMonth() + 1}月${date.getDate()}日 ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    }

    const msgOf = (error) => {
      if (error instanceof TypeError) return '无法连接面板接口，请稍后重试。'
      const message = error && error.message ? error.message : String(error)
      const extra = error && error.hint ? `（${error.hint}）` : ''
      return `${message}${extra}`
    }

    const splitTags = (value) =>
      String(value || '')
        .split(/[\n、,，;；]+/)
        .map((item) => item.trim().replace(/^#+/, ''))
        .filter(Boolean)
        .slice(0, 12)

    async function request(path, init) {
      const response = await fetch(path, init)
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || !payload || payload.ok === false) {
        const error = new Error((payload && payload.message) || `请求失败（HTTP ${response.status}）`)
        error.hint = payload && payload.hint
        throw error
      }
      return payload
    }

    const post = (path, body) =>
      request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })

    /** 左侧边栏图标：DSH 传入 size / active 两个 owner props。 */
    function TodoIcon({ size = 16, active = false }) {
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
        h('rect', { x: 4.2, y: 4.6, width: 15.6, height: 16.2, rx: 2.6 }),
        h('path', { d: 'M9 2.9h6a1 1 0 0 1 1 1v1.7H8V3.9a1 1 0 0 1 1-1z' }),
        h('path', { d: 'M8.2 11.4l1.6 1.6 3.1-3.4' }),
        h('path', { d: 'M8.2 16.4l1.6 1.6 3.1-3.4' }),
        h('path', { d: 'M15.2 11.8h2.2M15.2 16.8h2.2' }),
      )
    }

    function Check({ done, busy, label, onToggle }) {
      const [hover, setHover] = useState(false)
      return h(
        'button',
        {
          type: 'button',
          role: 'checkbox',
          'aria-checked': done,
          'aria-label': label,
          title: label,
          disabled: Boolean(busy),
          onClick: onToggle,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: withDisabled(
            {
              flex: 'none',
              width: 24,
              height: 24,
              marginTop: -2,
              padding: 0,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            },
            busy,
          ),
        },
        h(
          'span',
          {
            'aria-hidden': true,
            style: {
              width: 19,
              height: 19,
              borderRadius: '50%',
              border: `1.5px solid ${done ? OK : hover ? ACCENT : BORDER}`,
              background: done ? OK : 'transparent',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: ACCENT_TEXT,
              transition: 'border-color .12s ease, background .12s ease',
            },
          },
          done
            ? h(
                'svg',
                { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 3.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
                h('path', { d: 'M5 12.5l4.6 4.6L19 7.4' }),
              )
            : null,
        ),
      )
    }

    function StatCard({ label, value, tone }) {
      return h(
        'div',
        { style: { boxSizing: 'border-box', border: `1px solid ${BORDER_SUBTLE}`, borderRadius: 10, background: NESTED, padding: '9px 12px', minWidth: 0 } },
        h('div', { style: { fontSize: 11.5, color: MUTED, marginBottom: 2 } }, label),
        h('div', { style: { fontSize: 19, fontWeight: 600, color: tone || TEXT, lineHeight: 1.3 } }, String(value)),
      )
    }

    function TabButton({ tab, count, active, onSelect }) {
      const [hover, setHover] = useState(false)
      return h(
        'button',
        {
          type: 'button',
          onClick: onSelect,
          'aria-pressed': active,
          title: tab.hint || undefined,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            padding: '9px 13px 10px',
            marginBottom: -1,
            fontSize: 13.5,
            fontWeight: active ? 600 : 500,
            fontFamily: 'inherit',
            color: active ? ACCENT : hover ? TEXT : MUTED,
            borderBottom: `2px solid ${active ? ACCENT : 'transparent'}`,
            transition: 'color .12s ease, border-color .12s ease',
            whiteSpace: 'nowrap',
          },
        },
        tab.label,
        count > 0
          ? h(
              'span',
              {
                style: {
                  minWidth: 19,
                  padding: '0 6px',
                  borderRadius: 999,
                  fontSize: 11,
                  lineHeight: '17px',
                  textAlign: 'center',
                  background: active ? ACCENT : NESTED,
                  color: active ? ACCENT_TEXT : MUTED,
                  border: `1px solid ${active ? ACCENT : BORDER_SUBTLE}`,
                  boxSizing: 'border-box',
                },
              },
              String(count),
            )
          : null,
      )
    }

    function Pill({ children, tone = MUTED, title }) {
      return h(
        'span',
        {
          title,
          style: {
            display: 'inline-block',
            padding: '0 7px',
            borderRadius: 999,
            fontSize: 11,
            lineHeight: '18px',
            color: tone,
            border: `1px solid ${tone}`,
            whiteSpace: 'nowrap',
            flex: 'none',
          },
        },
        children,
      )
    }

    function TodoRow({
      todo,
      today,
      categories,
      busy,
      flash,
      editing,
      draft,
      confirmDelete,
      onStartEdit,
      onCancelEdit,
      onChangeDraft,
      onSaveEdit,
      onToggle,
      onComplete,
      onRestore,
      onDelete,
      hideDue = false,
    }) {
      const [hover, setHover] = useState(false)

      if (editing) {
        return h(
          'div',
          {
            onKeyDown: (event) => {
              if (event.nativeEvent && event.nativeEvent.isComposing) return
              if (event.key === 'Escape') {
                event.stopPropagation()
                onCancelEdit()
              }
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                event.stopPropagation()
                onSaveEdit()
              }
            },
            style: { padding: '12px 14px', background: NESTED, borderBottom: `1px solid ${BORDER_SUBTLE}` },
          },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            h('input', {
              style: input,
              value: draft.title,
              maxLength: 200,
              autoFocus: true,
              'aria-label': '待办内容',
              placeholder: '要做什么？',
              onChange: (event) => onChangeDraft({ title: event.target.value }),
            }),
            h('div', { style: { ...row, gap: 8 } },
              h('select', {
                style: { ...select, width: 112 },
                value: draft.category,
                'aria-label': '分类',
                onChange: (event) => onChangeDraft({ category: event.target.value }),
              }, categories.concat(draft.category && !categories.includes(draft.category) ? [draft.category] : []).map((item) => h('option', { key: item, value: item }, item))),
              h('select', {
                style: { ...select, width: 92 },
                value: draft.priority,
                'aria-label': '优先级',
                onChange: (event) => onChangeDraft({ priority: event.target.value }),
              }, PRIORITIES.map((item) => h('option', { key: item.key, value: item.key }, `优先级 ${item.label}`))),
              h('input', {
                type: 'date',
                style: { ...input, width: 150 },
                value: draft.dueDate,
                'aria-label': '截止日期',
                onChange: (event) => onChangeDraft({ dueDate: event.target.value }),
              }),
              h('input', {
                style: { ...input, flex: '1 1 160px', width: 'auto', minWidth: 140 },
                value: draft.tags,
                placeholder: '标签，用逗号分隔',
                'aria-label': '标签',
                onChange: (event) => onChangeDraft({ tags: event.target.value }),
              }),
            ),
            h('textarea', {
              style: textarea,
              value: draft.note,
              maxLength: 4000,
              rows: 3,
              placeholder: '备注（可选）：补充细节、链接或上下文',
              'aria-label': '备注',
              onChange: (event) => onChangeDraft({ note: event.target.value }),
            }),
            h('div', { style: { ...row, justifyContent: 'flex-end' } },
              h('span', { style: { ...hint, marginRight: 'auto' } }, 'Ctrl / ⌘ + Enter 保存，Esc 取消'),
              h('button', { type: 'button', style: withDisabled(smallButton, busy), disabled: Boolean(busy), onClick: onCancelEdit }, '取消'),
              h('button', { type: 'button', style: withDisabled({ ...smallButton, background: ACCENT, borderColor: ACCENT, color: ACCENT_TEXT }, busy), disabled: Boolean(busy), onClick: onSaveEdit }, busy ? '保存中…' : '保存'),
            ),
          ),
        )
      }

      const done = todo.status === 'done'
      const tone = dueTone(todo, today)
      return h(
        'div',
        {
          'data-todo-id': todo.id,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            padding: '11px 14px',
            borderBottom: `1px solid ${BORDER_SUBTLE}`,
            background: flash || (hover && !done) ? NESTED : 'transparent',
            boxShadow: flash ? `inset 3px 0 0 ${ACCENT}` : 'none',
            transition: 'background .1s ease, box-shadow .1s ease',
          },
        },
        h(Check, {
          done,
          busy: Boolean(busy),
          label: done ? `恢复未完成：${todo.title}` : `标记完成：${todo.title}`,
          onToggle,
        }),
        h(
          'div',
          { style: { flex: '1 1 auto', minWidth: 0 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
            h(
              'span',
              {
                onDoubleClick: done ? undefined : onStartEdit,
                style: {
                  fontSize: 13.5,
                  fontWeight: 500,
                  lineHeight: 1.55,
                  color: done ? MUTED : TEXT,
                  textDecoration: done ? 'line-through' : 'none',
                  textDecorationColor: done ? MUTED : undefined,
                  wordBreak: 'break-word',
                },
              },
              todo.title,
            ),
            todo.priority === 'high' && !done ? h(Pill, { tone: DANGER }, '高') : null,
            !done && !hideDue && todo.dueDate ? h(Pill, { tone }, dueLabel(todo, today)) : null,
          ),
          h(
            'div',
            { style: { ...row, gap: 6, marginTop: 3 } },
            h('span', { style: { fontSize: 11.5, color: MUTED } }, todo.category || '其他'),
            (todo.tags || []).length > 0
              ? h('span', { style: { fontSize: 11.5, color: MUTED } }, `· ${todo.tags.map((tag) => `#${tag}`).join(' ')}`)
              : null,
            todo.source === 'agent' ? h(Pill, { tone: ACCENT, title: '这条是从对话里记录的' }, '对话') : null,
            done && todo.completedAt
              ? h('span', { style: { fontSize: 11.5, color: MUTED } }, `· ${completedLabel(todo.completedAt)} 完成`)
              : null,
          ),
          todo.note
            ? h('div', { style: { ...hint, marginTop: 3, ...clamp1 }, title: todo.note }, todo.note)
            : null,
        ),
        h(
          'div',
          { style: { flex: 'none', display: 'flex', alignItems: 'center', gap: 2 } },
          done
            ? h(
                'button',
                {
                  type: 'button',
                  title: '撤回为未完成',
                  disabled: Boolean(busy),
                  style: withDisabled({ ...smallButton, border: 'none', color: hover ? ACCENT : MUTED, padding: '3px 8px' }, Boolean(busy)),
                  onClick: onRestore,
                },
                busy === `restore:${todo.id}` ? '恢复中…' : '恢复',
              )
            : h(
                'button',
                {
                  type: 'button',
                  title: '标记为已完成',
                  disabled: Boolean(busy),
                  style: withDisabled(
                    {
                      ...smallButton,
                      background: OK,
                      borderColor: OK,
                      color: ACCENT_TEXT,
                      fontWeight: 600,
                      padding: '3px 10px',
                    },
                    Boolean(busy),
                  ),
                  onClick: onComplete,
                },
                busy === `toggle:${todo.id}` ? '完成中…' : '完成',
              ),
          h(
            'button',
            {
              type: 'button',
              title: '编辑',
              disabled: Boolean(busy),
              style: withDisabled({ ...smallButton, border: 'none', color: hover ? TEXT : MUTED, padding: '3px 8px' }, Boolean(busy)),
              onClick: onStartEdit,
            },
            '编辑',
          ),
          h(
            'button',
            {
              type: 'button',
              title: confirmDelete ? '再点一次确认删除' : '删除',
              disabled: Boolean(busy),
              style: withDisabled(
                {
                  ...smallButton,
                  border: 'none',
                  padding: '3px 8px',
                  color: confirmDelete ? DANGER : hover ? TEXT : MUTED,
                  fontWeight: confirmDelete ? 600 : 400,
                },
                Boolean(busy),
              ),
              onClick: onDelete,
            },
            busy === `delete:${todo.id}` ? '删除中…' : confirmDelete ? '确认删除' : '删除',
          ),
        ),
      )
    }

    function EmptyState({ kind, doneCount = 0 }) {
      const copy =
        kind === 'done'
          ? { title: '还没有已完成的待办', text: '完成一条待办后，它会出现在这里。' }
          : kind === 'open'
            ? { title: '没有未完成的待办', text: `已完成 ${doneCount} 条，可以在「已完成」页签查看。` }
            : kind === 'filtered'
              ? { title: '没有符合条件的待办', text: '换个关键词或分类试试。' }
              : { title: '还没有待办', text: '在上面输入一件事，回车就能添加；也可以在对话里直接对我说「记一条待办：…」。' }
      return h(
        'div',
        { style: { ...card, padding: '44px 20px', textAlign: 'center' } },
        h(
          'div',
          { style: { width: 44, height: 44, margin: '0 auto 12px', borderRadius: 12, background: NESTED, display: 'flex', alignItems: 'center', justifyContent: 'center', color: MUTED } },
          h(
            'svg',
            { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
            h('rect', { x: 4.2, y: 4.6, width: 15.6, height: 16.2, rx: 2.6 }),
            h('path', { d: 'M9 2.9h6a1 1 0 0 1 1 1v1.7H8V3.9a1 1 0 0 1 1-1z' }),
            h('path', { d: 'M8.5 12.5h7M8.5 16.5h4.5' }),
          ),
        ),
        h('div', { style: { fontSize: 14, fontWeight: 500, marginBottom: 4 } }, copy.title),
        h('div', { style: hint }, copy.text),
      )
    }

    function TodoPanel() {
      const [data, setData] = useState(null)
      const [loadError, setLoadError] = useState('')
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState('')
      const [tab, setTab] = useState('all')
      const [query, setQuery] = useState('')
      const [categoryFilter, setCategoryFilter] = useState('all')
      const [expandedAdd, setExpandedAdd] = useState(false)
      const [draft, setDraft] = useState({ title: '', note: '', category: '工作', priority: 'medium', dueDate: '', tags: '' })
      const [editingId, setEditingId] = useState('')
      const [editDraft, setEditDraft] = useState({ title: '', note: '', category: '其他', priority: 'medium', dueDate: '', tags: '' })
      const [confirmDelete, setConfirmDelete] = useState('')
      const [confirmClear, setConfirmClear] = useState(false)
      const [flashId, setFlashId] = useState('')
      const [calendarMonth, setCalendarMonth] = useState(() => todayKey().slice(0, 7))
      const [selectedDate, setSelectedDate] = useState(() => todayKey())

      const titleRef = useRef(null)
      const busyRef = useRef('')
      const confirmTimer = useRef(null)
      const clearTimer = useRef(null)
      const silentFailRef = useRef(0)
      const loadedRef = useRef(false)
      const prevIdsRef = useRef(new Set())
      const editBaselineRef = useRef('')
      const calendarInitRef = useRef(false)
      useEffect(() => {
        busyRef.current = busy
      }, [busy])
      useEffect(
        () => () => {
          if (confirmTimer.current) clearTimeout(confirmTimer.current)
          if (clearTimer.current) clearTimeout(clearTimer.current)
        },
        [],
      )

      const refresh = useCallback(async (options) => {
        const silent = Boolean(options && options.silent)
        try {
          const next = await request('/todo-workbench/state')
          setData(next)
          setLoadError('')
          silentFailRef.current = 0
          if (loadedRef.current) {
            const fresh = next.todos.filter((todo) => !prevIdsRef.current.has(todo.id) && todo.source === 'agent')
            if (fresh.length > 0) {
              setNotice({ tone: 'ok', text: `对话里新增 ${fresh.length} 条待办。` })
              setFlashId(fresh[0].id)
            }
          }
          loadedRef.current = true
          prevIdsRef.current = new Set(next.todos.map((todo) => todo.id))
          return true
        } catch (error) {
          if (silent) {
            silentFailRef.current += 1
            if (silentFailRef.current >= 3) setLoadError(msgOf(error))
          } else {
            setLoadError(msgOf(error))
          }
          return false
        }
      }, [])

      useEffect(() => {
        refresh()
        const timer = setInterval(() => {
          if (busyRef.current) return
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          refresh({ silent: true })
        }, 8000)
        const onFocus = () => {
          if (!busyRef.current) refresh({ silent: true })
        }
        window.addEventListener('focus', onFocus)
        return () => {
          clearInterval(timer)
          window.removeEventListener('focus', onFocus)
        }
      }, [refresh])

      useEffect(() => {
        if (!notice) return undefined
        const timer = setTimeout(() => setNotice(null), 4200)
        return () => clearTimeout(timer)
      }, [notice])

      useEffect(() => {
        if (!flashId) return undefined
        const el = typeof document !== 'undefined' ? document.querySelector(`[data-todo-id="${flashId}"]`) : null
        if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        const timer = setTimeout(() => setFlashId(''), 2600)
        return () => clearTimeout(timer)
      }, [flashId])

      // 第一次拿到 Host 的「今天」后，把日历定位到当月与今天。
      useEffect(() => {
        if (calendarInitRef.current || !data || !data.today) return
        calendarInitRef.current = true
        setCalendarMonth(data.today.slice(0, 7))
        setSelectedDate(data.today)
      }, [data])

      const setDraftField = (patch) => setDraft((current) => ({ ...current, ...patch }))
      const setEditField = (patch) => setEditDraft((current) => ({ ...current, ...patch }))

      const applyPayload = (payload) => {
        if (payload && payload.state) setData(payload.state)
        else refresh({ silent: true })
      }

      const flashConfirmDelete = (id) => {
        setConfirmDelete(id)
        if (confirmTimer.current) clearTimeout(confirmTimer.current)
        confirmTimer.current = setTimeout(() => setConfirmDelete(''), 5000)
      }

      const submitAdd = async () => {
        const title = draft.title.trim()
        if (!title || busy) return
        setBusy('add')
        setNotice(null)
        try {
          const payload = await post('/todo-workbench/add', {
            title,
            note: draft.note,
            category: draft.category,
            priority: draft.priority,
            dueDate: draft.dueDate,
            tags: splitTags(draft.tags),
          })
          applyPayload(payload)
          if (payload.duplicate) {
            setNotice({ tone: 'warn', text: '已有同名未完成待办，没有重复添加。' })
          } else {
            setNotice({ tone: 'ok', text: `已添加「${title.length > 24 ? `${title.slice(0, 24)}…` : title}」。` })
            if (payload.todo && payload.todo.id) setFlashId(payload.todo.id)
          }
          setDraft((current) => ({ ...current, title: '', note: '', dueDate: '', tags: '' }))
          setExpandedAdd(false)
          if (titleRef.current) titleRef.current.focus()
        } catch (error) {
          setNotice({ tone: 'error', text: msgOf(error) })
        } finally {
          setBusy('')
        }
      }

      const startEdit = (todo) => {
        if (editingId && editingId !== todo.id) {
          const current = JSON.stringify(editDraft)
          if (current !== editBaselineRef.current) {
            setNotice({ tone: 'warn', text: '另一条待办还有未保存的修改，请先保存或取消。' })
            return
          }
        }
        const next = {
          title: todo.title,
          note: todo.note || '',
          category: todo.category || '其他',
          priority: todo.priority || 'medium',
          dueDate: todo.dueDate || '',
          tags: (todo.tags || []).join('、'),
        }
        setEditingId(todo.id)
        setEditDraft(next)
        editBaselineRef.current = JSON.stringify(next)
        setConfirmDelete('')
        setNotice(null)
      }

      const cancelEdit = () => {
        setEditingId('')
        editBaselineRef.current = ''
      }

      const saveEdit = async () => {
        if (!editingId || busy) return
        if (!editDraft.title.trim()) {
          setNotice({ tone: 'error', text: '待办内容不能为空。' })
          return
        }
        setBusy(`save:${editingId}`)
        try {
          const payload = await post('/todo-workbench/update', {
            id: editingId,
            data: {
              title: editDraft.title,
              note: editDraft.note,
              category: editDraft.category,
              priority: editDraft.priority,
              dueDate: editDraft.dueDate,
              tags: splitTags(editDraft.tags),
            },
          })
          applyPayload(payload)
          setEditingId('')
          editBaselineRef.current = ''
          setNotice({ tone: 'ok', text: '已保存修改。' })
        } catch (error) {
          setNotice({ tone: 'error', text: msgOf(error) })
        } finally {
          setBusy('')
        }
      }

      const toggleTodo = async (todo) => {
        if (busy) return
        const done = todo.status !== 'done'
        setBusy(`toggle:${todo.id}`)
        try {
          const payload = await post('/todo-workbench/complete', { id: todo.id, done })
          applyPayload(payload)
          if (done) setNotice({ tone: 'ok', text: `完成了「${todo.title.length > 20 ? `${todo.title.slice(0, 20)}…` : todo.title}」。` })
          else setNotice({ tone: 'ok', text: `已恢复「${todo.title.length > 20 ? `${todo.title.slice(0, 20)}…` : todo.title}」为未完成。` })
        } catch (error) {
          setNotice({ tone: 'error', text: msgOf(error) })
        } finally {
          setBusy('')
        }
      }

      const restoreTodo = async (todo) => {
        if (busy) return
        setBusy(`restore:${todo.id}`)
        setNotice(null)
        try {
          const payload = await post('/todo-workbench/complete', { id: todo.id, done: false })
          applyPayload(payload)
          setNotice({ tone: 'ok', text: `已恢复「${todo.title.length > 20 ? `${todo.title.slice(0, 20)}…` : todo.title}」为未完成。` })
        } catch (error) {
          setNotice({ tone: 'error', text: msgOf(error) })
        } finally {
          setBusy('')
        }
      }

      const deleteTodo = async (todo) => {
        if (busy) return
        if (confirmDelete !== todo.id) {
          flashConfirmDelete(todo.id)
          return
        }
        setBusy(`delete:${todo.id}`)
        setConfirmDelete('')
        try {
          const payload = await post('/todo-workbench/delete', { id: todo.id })
          applyPayload(payload)
          if (editingId === todo.id) cancelEdit()
          setNotice({ tone: 'ok', text: `已删除「${todo.title}」。` })
        } catch (error) {
          setNotice({ tone: 'error', text: msgOf(error) })
        } finally {
          setBusy('')
        }
      }

      const flashClearConfirm = () => {
        setConfirmClear(true)
        if (clearTimer.current) clearTimeout(clearTimer.current)
        clearTimer.current = setTimeout(() => setConfirmClear(false), 5000)
      }

      const clearCompleted = async () => {
        if (busy) return
        if (!confirmClear) {
          flashClearConfirm()
          return
        }
        if (clearTimer.current) clearTimeout(clearTimer.current)
        setBusy('clear')
        setConfirmClear(false)
        try {
          const payload = await post('/todo-workbench/clear-completed', {})
          applyPayload(payload)
          setNotice({ tone: 'ok', text: payload.removed > 0 ? `已清理 ${payload.removed} 条已完成待办。` : '没有已完成的待办需要清理。' })
        } catch (error) {
          setNotice({ tone: 'error', text: msgOf(error) })
        } finally {
          setBusy('')
        }
      }

      const today = (data && data.today) || todayKey()
      const weekEnd = useMemo(() => endOfWeek(today), [today])
      const todos = useMemo(() => (data && Array.isArray(data.todos) ? data.todos : []), [data])
      const stats = (data && data.stats) || { open: 0, today: 0, week: 0, overdue: 0, done: 0, total: 0 }
      const categories = (data && Array.isArray(data.categories) ? data.categories : ['工作', '生活', '学习', '其他'])

      const calendarCells = useMemo(() => buildMonthCells(calendarMonth, today), [calendarMonth, today])
      const todosByDate = useMemo(() => {
        const map = new Map()
        for (const todo of todos) {
          if (!todo.dueDate) continue
          const list = map.get(todo.dueDate) || []
          list.push(todo)
          map.set(todo.dueDate, list)
        }
        for (const [key, list] of map) map.set(key, list.slice().sort(sortDayTodos))
        return map
      }, [todos])
      const monthTodos = useMemo(
        () => todos.filter((todo) => todo.dueDate && todo.dueDate.slice(0, 7) === calendarMonth),
        [todos, calendarMonth],
      )
      const monthOpen = monthTodos.filter((todo) => todo.status === 'open').length
      const selectedTodos = todosByDate.get(selectedDate) || []

      const goMonth = (delta) => {
        const next = shiftMonthKey(calendarMonth, delta)
        setCalendarMonth(next)
        setSelectedDate(next === today.slice(0, 7) ? today : `${next}-01`)
      }
      const goToday = () => {
        setCalendarMonth(today.slice(0, 7))
        setSelectedDate(today)
      }
      const selectCalendarDate = (key) => {
        setSelectedDate(key)
        if (key.slice(0, 7) !== calendarMonth) setCalendarMonth(key.slice(0, 7))
      }
      const addOnDate = (key) => {
        const { m, d } = parseKey(key)
        setDraft((current) => ({ ...current, dueDate: key }))
        setExpandedAdd(false)
        setNotice({ tone: 'ok', text: `截止日期已设为 ${m}月${d}日，在上方输入内容后回车即可。` })
        if (titleRef.current) titleRef.current.focus()
      }

      const renderTodoRow = (todo, hideDue) =>
        h(TodoRow, {
          key: todo.id,
          todo,
          today,
          categories,
          busy,
          flash: flashId === todo.id,
          editing: editingId === todo.id,
          draft: editDraft,
          confirmDelete: confirmDelete === todo.id,
          onStartEdit: () => startEdit(todo),
          onCancelEdit: cancelEdit,
          onChangeDraft: setEditField,
          onSaveEdit: () => saveEdit(),
          onToggle: () => toggleTodo(todo),
          onComplete: () => toggleTodo(todo),
          onRestore: () => restoreTodo(todo),
          onDelete: () => deleteTodo(todo),
          hideDue,
        })

      const undatedOpen = useMemo(
        () => todos.filter((todo) => !todo.dueDate && todo.status === 'open').slice().sort(sortDayTodos),
        [todos],
      )

      const renderCalendar = () =>
        h(
          'div',
          null,
          h(
            'div',
            { style: { display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' } },
          h(
            'div',
            { style: { ...card, flex: '1 1 560px', minWidth: 0, padding: '12px 14px' } },
            h(
              'div',
              { style: { ...row, justifyContent: 'space-between', marginBottom: 10, gap: 8 } },
              h(
                'div',
                { style: row },
                h('button', { type: 'button', style: smallButton, onClick: () => goMonth(-1), 'aria-label': '上个月', title: '上个月' }, '‹'),
                h('div', { style: { minWidth: 92, textAlign: 'center', fontWeight: 600, fontSize: 13.5 } }, monthTitleOf(calendarMonth)),
                h('button', { type: 'button', style: smallButton, onClick: () => goMonth(1), 'aria-label': '下个月', title: '下个月' }, '›'),
                h('button', { type: 'button', style: smallButton, onClick: goToday }, '回到今天'),
              ),
              h(
                'div',
                { style: hint },
                monthTodos.length === 0
                  ? '这个月还没有带截止日期的待办'
                  : `本月 ${monthOpen} 条未完成${monthTodos.length > monthOpen ? ` · ${monthTodos.length - monthOpen} 条已完成` : ''}`,
              ),
            ),
            h(
              'div',
              { style: { display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 4 } },
              ['一', '二', '三', '四', '五', '六', '日'].map((label) =>
                h('div', { key: label, style: { textAlign: 'center', fontSize: 11.5, color: MUTED, padding: '2px 0 4px' } }, label),
              ),
              calendarCells.map((cell) => {
                const items = todosByDate.get(cell.key) || []
                const selected = cell.key === selectedDate
                return h(
                  'button',
                  {
                    key: cell.key,
                    type: 'button',
                    onClick: () => selectCalendarDate(cell.key),
                    'aria-label': `${cell.key}，${items.length} 条待办`,
                    'aria-pressed': selected,
                    style: {
                      boxSizing: 'border-box',
                      minHeight: 92,
                      padding: '5px 5px 4px',
                      textAlign: 'left',
                      border: `1px solid ${selected || cell.isToday ? ACCENT : BORDER_SUBTLE}`,
                      borderRadius: 8,
                      background: selected ? NESTED : 'transparent',
                      color: TEXT,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 3,
                      opacity: cell.inMonth ? 1 : 0.52,
                      overflow: 'hidden',
                    },
                  },
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 } },
                    h(
                      'span',
                      {
                        style: {
                          width: 20,
                          height: 20,
                          borderRadius: '50%',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flex: 'none',
                          fontSize: 11.5,
                          fontWeight: cell.isToday ? 700 : 500,
                          color: cell.isToday ? ACCENT_TEXT : cell.inMonth ? TEXT : MUTED,
                          background: cell.isToday ? ACCENT : 'transparent',
                        },
                      },
                      String(cell.day),
                    ),
                    items.length > 0 ? h('span', { style: { fontSize: 10, color: MUTED } }, String(items.length)) : null,
                  ),
                  items.slice(0, 2).map((todo) =>
                    h(
                      'span',
                      {
                        key: todo.id,
                        title: todo.title,
                        style: {
                          display: 'block',
                          fontSize: 10.5,
                          lineHeight: '15px',
                          padding: '0 4px',
                          borderRadius: 4,
                          background: NESTED,
                          borderLeft: `2px solid ${
                            todo.status === 'done' ? MUTED : todo.priority === 'high' || todo.dueDate < today ? DANGER : ACCENT
                          }`,
                          color: todo.status === 'done' ? MUTED : TEXT,
                          textDecoration: todo.status === 'done' ? 'line-through' : 'none',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        },
                      },
                      todo.title,
                    ),
                  ),
                  items.length > 2 ? h('span', { style: { fontSize: 10, color: MUTED } }, `+${items.length - 2}`) : null,
                )
              }),
            ),
          ),
          h(
            'div',
            { style: { ...card, flex: '1 1 280px', maxWidth: 380, padding: '12px 14px' } },
            h(
              'div',
              { style: { ...row, justifyContent: 'space-between', marginBottom: 8, gap: 8 } },
              h(
                'div',
                null,
                h(
                  'div',
                  { style: { fontWeight: 600, fontSize: 13.5 } },
                  `${Number(selectedDate.slice(5, 7))}月${Number(selectedDate.slice(8, 10))}日 周${weekdayName(selectedDate)}`,
                ),
                h(
                  'div',
                  { style: hint },
                  selectedTodos.length === 0
                    ? '这天没有待办'
                    : `${selectedTodos.filter((todo) => todo.status === 'open').length} 条未完成 · ${
                        selectedTodos.filter((todo) => todo.status === 'done').length
                      } 条已完成`,
                ),
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: smallButton,
                  onClick: () => addOnDate(selectedDate),
                  title: '把上方快速添加的截止日期设为这天',
                },
                '在这天添加',
              ),
            ),
            selectedTodos.length === 0
              ? h('div', { style: { ...hint, padding: '14px 2px' } }, '点日期可以查看当天待办，也可以点「在这天添加」。')
              : h('div', { style: { ...card, padding: 0, overflow: 'hidden' } }, selectedTodos.map((todo) => renderTodoRow(todo, true))),
          ),
        ),
          undatedOpen.length > 0
            ? h(
                'div',
                { style: { ...card, marginTop: 14, padding: '12px 14px' } },
                h(
                  'div',
                  { style: { ...row, justifyContent: 'space-between', marginBottom: 8, gap: 8 } },
                  h('div', { style: { fontWeight: 600, fontSize: 13.5 } }, '未安排日期'),
                  h('div', { style: hint }, `还有 ${undatedOpen.length} 条没设截止日期，点「编辑」补上日期就会出现在日历里。`),
                ),
                h('div', { style: { ...card, padding: 0, overflow: 'hidden' } }, undatedOpen.map((todo) => renderTodoRow(todo, true))),
              )
            : null,
        )

      const visible = useMemo(() => {
        let list = todos
        if (tab === 'done') list = list.filter((todo) => todo.status === 'done')
        else if (tab === 'today') list = list.filter((todo) => todo.status === 'open' && todo.dueDate && todo.dueDate <= today)
        else if (tab === 'week') list = list.filter((todo) => todo.status === 'open' && todo.dueDate && todo.dueDate <= weekEnd)
        else list = list.filter((todo) => todo.status === 'open')
        if (categoryFilter !== 'all') list = list.filter((todo) => (todo.category || '其他') === categoryFilter)
        const q = query.trim().toLowerCase()
        if (q) {
          list = list.filter((todo) =>
            [todo.title, todo.note, todo.category, ...(todo.tags || [])]
              .join('\n')
              .toLowerCase()
              .includes(q),
          )
        }
        return list
      }, [todos, tab, today, weekEnd, categoryFilter, query])

      const groups = useMemo(() => {
        if (tab === 'done') return visible.length ? [{ key: 'done', label: GROUP_LABEL.done, items: visible }] : []
        const order = tab === 'all' ? ['overdue', 'today', 'week', 'later', 'none'] : tab === 'today' ? ['overdue', 'today'] : ['overdue', 'today', 'week']
        return order
          .map((key) => ({ key, label: GROUP_LABEL[key], items: visible.filter((todo) => todo.bucket === key) }))
          .filter((group) => group.items.length > 0)
      }, [visible, tab])

      const tabCount = {
        all: stats.open,
        today: stats.overdue + stats.today,
        week: stats.overdue + stats.today + stats.week,
        calendar: monthOpen,
        done: stats.done,
      }
      const filteredActive = Boolean(query.trim()) || categoryFilter !== 'all'
      const categoryOptions = categoryFilter === 'all' || categories.includes(categoryFilter) ? categories : categories.concat([categoryFilter])

      const dayLine = data
        ? `${Number(today.slice(5, 7))}月${Number(today.slice(8, 10))}日 周${weekdayName(today)}`
        : ''

      return h(
        'div',
        { className: 'todo-wb-root', style: ROOT },
        h('style', null, LOCAL_STYLE),
        h(
          'div',
          { style: HEADER },
          h(
            'div',
            { style: INNER },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' } },
              h(
                'div',
                { style: { flex: '1 1 320px', minWidth: 0 } },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' } },
                  h('h1', { style: { margin: 0, fontSize: 20, fontWeight: 650, letterSpacing: '.2px' } }, '待办事项'),
                  dayLine ? h('span', { style: { ...hint, fontSize: 12 } }, dayLine) : null,
                ),
                h('div', { style: { ...hint, marginTop: 4 } }, '把要做的事放在这里；对话里让我记录待办，也会自动出现在清单里。'),
              ),
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' } },
                h(
                  'button',
                  {
                    type: 'button',
                    style: withDisabled(button, Boolean(busy)),
                    disabled: Boolean(busy),
                    onClick: async () => {
                      setBusy('refresh')
                      try {
                        const ok = await refresh()
                        if (ok) setNotice({ tone: 'ok', text: '已刷新。' })
                      } finally {
                        setBusy('')
                      }
                    },
                  },
                  busy === 'refresh' ? '刷新中…' : '刷新',
                ),
              ),
            ),
            h(
              'div',
              { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, marginTop: 14 } },
              h(StatCard, { label: '待办中', value: stats.open }),
              h(StatCard, { label: '今天到期', value: stats.today, tone: ACCENT }),
              h(StatCard, { label: '逾期', value: stats.overdue, tone: stats.overdue > 0 ? DANGER : MUTED }),
              h(StatCard, { label: '已完成', value: stats.done, tone: OK }),
            ),
            h(
              'div',
              { style: { ...card, marginTop: 14, padding: '12px 14px' } },
              h(
                'div',
                { style: row },
                h('input', {
                  ref: titleRef,
                  style: { ...input, flex: '1 1 260px', width: 'auto', minWidth: 180, fontSize: 13.5 },
                  value: draft.title,
                  maxLength: 200,
                  placeholder: '要做什么？例如：周五前把报价单发给王总',
                  'aria-label': '新待办内容',
                  onChange: (event) => setDraftField({ title: event.target.value }),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' && !(event.nativeEvent && event.nativeEvent.isComposing)) {
                      event.preventDefault()
                      submitAdd()
                    }
                  },
                }),
                h(
                  'select',
                  {
                    style: { ...select, width: 100 },
                    value: draft.category,
                    'aria-label': '分类',
                    onChange: (event) => setDraftField({ category: event.target.value }),
                  },
                  categories.map((item) => h('option', { key: item, value: item }, item)),
                ),
                h(
                  'select',
                  {
                    style: { ...select, width: 88 },
                    value: draft.priority,
                    'aria-label': '优先级',
                    onChange: (event) => setDraftField({ priority: event.target.value }),
                  },
                  PRIORITIES.map((item) => h('option', { key: item.key, value: item.key }, `优先级${item.label}`)),
                ),
                h('input', {
                  type: 'date',
                  style: { ...input, width: 148 },
                  value: draft.dueDate,
                  'aria-label': '截止日期',
                  onChange: (event) => setDraftField({ dueDate: event.target.value }),
                }),
                h(
                  'button',
                  { type: 'button', style: withDisabled(primaryButton, !draft.title.trim() || Boolean(busy)), disabled: !draft.title.trim() || Boolean(busy), onClick: submitAdd },
                  busy === 'add' ? '添加中…' : '添加',
                ),
                h(
                  'button',
                  { type: 'button', style: smallButton, onClick: () => setExpandedAdd((value) => !value), 'aria-expanded': expandedAdd },
                  expandedAdd ? '收起' : '备注 / 标签',
                ),
              ),
              expandedAdd
                ? h(
                    'div',
                    { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: 8, marginTop: 8 } },
                    h('textarea', {
                      style: { ...textarea, minHeight: 54 },
                      value: draft.note,
                      rows: 2,
                      maxLength: 4000,
                      placeholder: '备注（可选）',
                      'aria-label': '新待办备注',
                      onChange: (event) => setDraftField({ note: event.target.value }),
                    }),
                    h('input', {
                      style: { ...input, alignSelf: 'start' },
                      value: draft.tags,
                      placeholder: '标签：客户、报价',
                      'aria-label': '新待办标签',
                      onChange: (event) => setDraftField({ tags: event.target.value }),
                    }),
                  )
                : null,
              h(
                'div',
                { style: { ...hint, marginTop: 7, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                h('span', null, '回车快速添加。'),
                h('span', null, '也可以直接对我说「记一条待办：……」。'),
              ),
            ),
            notice
              ? h(
                  'div',
                  {
                    role: 'status',
                    style: {
                      marginTop: 10,
                      padding: '7px 11px',
                      borderRadius: 8,
                      fontSize: 12.5,
                      color: notice.tone === 'error' ? DANGER : notice.tone === 'warn' ? WARN : OK,
                      background: NESTED,
                      border: `1px solid ${notice.tone === 'error' ? DANGER : notice.tone === 'warn' ? WARN : OK}`,
                    },
                  },
                  notice.text,
                )
              : null,
            data && data.warning
              ? h('div', { style: { marginTop: 10, padding: '7px 11px', borderRadius: 8, fontSize: 12.5, color: WARN, background: NESTED, border: `1px solid ${WARN}` } }, data.warning)
              : null,
            loadError
              ? h(
                  'div',
                  { style: { marginTop: 10, padding: '8px 11px', borderRadius: 8, fontSize: 12.5, color: DANGER, background: NESTED, border: `1px solid ${DANGER}`, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
                  h('span', { style: { flex: '1 1 220px' } }, `面板接口暂时不可用：${loadError}`),
                  h('button', { type: 'button', style: smallButton, onClick: () => refresh() }, '重试'),
                )
              : null,
          ),
        ),
        h(
          'div',
          { style: { flex: 'none', padding: '10px 28px 0', boxSizing: 'border-box' } },
          h(
            'div',
            { style: { ...INNER, borderBottom: `1px solid ${BORDER_SUBTLE}`, display: 'flex', alignItems: 'flex-end', gap: 8, flexWrap: 'wrap' } },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'flex-end', gap: 2, flex: '1 1 auto', minWidth: 0 } },
              TABS.map((item) =>
                h(TabButton, {
                  key: item.key,
                  tab: item,
                  count: tabCount[item.key],
                  active: tab === item.key,
                  onSelect: () => {
                    setTab(item.key)
                    setConfirmClear(false)
                  },
                }),
              ),
            ),
            h(
              'div',
              { style: { ...row, gap: 6, paddingBottom: 8 } },
              tab === 'calendar'
                ? h('span', { style: { ...hint, fontSize: 11.5 } }, '点日期查看当天待办')
                : [
                    h('input', {
                      key: 'search',
                      style: { ...input, width: 170, padding: '4px 8px', fontSize: 12.5 },
                      value: query,
                      placeholder: '搜索待办',
                      'aria-label': '搜索待办',
                      onChange: (event) => {
                        setQuery(event.target.value)
                        setConfirmClear(false)
                      },
                    }),
                    h(
                      'select',
                      {
                        key: 'category',
                        style: { ...select, width: 96, padding: '4px 8px', fontSize: 12.5 },
                        value: categoryFilter,
                        'aria-label': '按分类过滤',
                        onChange: (event) => {
                          setCategoryFilter(event.target.value)
                          setConfirmClear(false)
                        },
                      },
                      [h('option', { key: 'all', value: 'all' }, '全部分类')].concat(categoryOptions.map((item) => h('option', { key: item, value: item }, item))),
                    ),
                    tab === 'done' && stats.done > 0
                      ? h(
                          'button',
                          {
                            key: 'clear',
                            type: 'button',
                            style: withDisabled(
                              { ...smallButton, color: confirmClear ? DANGER : MUTED, borderColor: confirmClear ? DANGER : BORDER },
                              busy === 'clear',
                            ),
                            disabled: busy === 'clear',
                            title: '清理所有已完成的待办（不受搜索和分类筛选影响）',
                            onClick: clearCompleted,
                          },
                          confirmClear ? `确认清理全部（${stats.done}）` : '清理全部已完成',
                        )
                      : null,
                  ],
            ),
          ),
        ),
        h(
          'div',
          { style: SCROLL },
          h(
            'div',
            { style: { ...INNER, ...PAD } },
            data === null && !loadError
              ? h('div', { style: { ...card, padding: '40px 20px', textAlign: 'center', color: MUTED } }, '加载中…')
              : data === null
                ? null
                : tab === 'calendar'
                  ? renderCalendar()
                  : groups.length === 0
                    ? h(EmptyState, {
                      kind:
                        tab === 'done'
                          ? 'done'
                          : tab === 'all' && !filteredActive && stats.open === 0 && stats.done > 0
                            ? 'open'
                            : filteredActive || tab !== 'all'
                              ? 'filtered'
                              : 'none',
                      doneCount: stats.done,
                    })
                  : groups.map((group) =>
                      h(
                        'div',
                        { key: group.key, style: { marginBottom: 16 } },
                        h(
                          'div',
                          { style: { display: 'flex', alignItems: 'center', gap: 7, margin: '0 2px 6px' } },
                          h('span', { style: { fontSize: 12, fontWeight: 600, color: group.key === 'overdue' ? DANGER : MUTED } }, group.label),
                          h('span', { style: { fontSize: 11.5, color: MUTED } }, String(group.items.length)),
                          h('span', { style: { flex: '1 1 auto', height: 1, background: BORDER_SUBTLE } }),
                        ),
                        group.key === 'done'
                          ? h('div', { style: { ...hint, margin: '0 2px 8px' } }, '已完成的待办可以点「恢复」或左侧圆圈，撤回为未完成。')
                          : null,
                        h('div', { style: { ...card, overflow: 'hidden' } }, group.items.map((todo) => renderTodoRow(todo, false))),
                      ),
                    ),
            h(
              'div',
              { style: { ...row, justifyContent: 'space-between', marginTop: 18, gap: 10 } },
              h(
                'div',
                { style: { ...hint, fontSize: 11 } },
                data ? `共 ${stats.total} 条待办 · ${stats.open} 条未完成 · 数据在本机保存` : '数据在本机保存',
              ),
              data && data.dataFile ? h('div', { style: { ...mono, color: MUTED, wordBreak: 'break-all', textAlign: 'right' } }, data.dataFile) : null,
            ),
          ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 左侧菜单栏入口（图标）与对应的主面板；id 必须与 main 的 key 一致。
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: 'todo-workbench', order: 8.5, label: () => '待办事项' }, TodoIcon),
        )
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'todo-workbench' }, TodoPanel))
      },
    }
  },
})

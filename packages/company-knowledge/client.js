/**
 * Client half of @mindlink-ai/dsh-company-knowledge.
 *
 * 在「设置」里注册「企业知识库」分区（settings.section）：
 * 填写本地 / NAS 上存放公司 Markdown 知识库的文件夹，查看索引状态与文档目录，并可重建索引。
 * 面板通过同源 /company-kb/* 路由与 Host 通信，不依赖任何 Client 包。
 */
window.__ModuleLoader__.load({
  id: '@mindlink-ai/dsh-company-knowledge',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const MUTED = 'var(--dsw-alias-text-secondary, #6b7280)'
    const TEXT = 'var(--dsw-alias-text-primary, #111827)'
    const BORDER = 'var(--dsw-alias-border-1, #e5e7eb)'
    const PANEL = 'var(--dsw-alias-bg-layer-1, #ffffff)'
    const ACCENT = 'var(--dsw-alias-brand-primary, #2563eb)'
    const DANGER = '#b91c1c'
    const WARN = '#b45309'

    const POLL_MS = 4000

    const card = {
      border: `1px solid ${BORDER}`,
      borderRadius: 10,
      padding: '14px 16px',
      background: PANEL,
      marginBottom: 14,
    }
    const cardTitle = { fontSize: 14, fontWeight: 600, marginBottom: 6 }
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
    }
    const primaryButton = { ...button, background: ACCENT, borderColor: ACCENT, color: '#ffffff' }
    const input = {
      boxSizing: 'border-box',
      border: `1px solid ${BORDER}`,
      borderRadius: 6,
      padding: '6px 8px',
      fontSize: 13,
      color: TEXT,
      background: 'transparent',
      fontFamily: 'inherit',
    }
    const row = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
    const mono = {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12,
    }
    const wrapper = {
      padding: '8px 0 32px',
      color: TEXT,
      boxSizing: 'border-box',
      maxWidth: 860,
      fontSize: 13,
    }

    // DSH 主面板容器是 overflow:hidden 的 flex 列，面板必须自己撑满并内部滚动
    // （与官方 Schedule 页、战略企划部工作台同构）。
    const PANEL_ROOT = {
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
    const PANEL_INNER = {
      boxSizing: 'border-box',
      width: '100%',
      maxWidth: 1200,
      margin: '0 auto',
      padding: '16px 24px 20px',
      flex: '1 1 auto',
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      color: TEXT,
      fontSize: 13,
    }

    // 文件树
    const TREE_PANEL = {
      flex: '0 0 280px',
      minWidth: 200,
      maxWidth: 360,
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0,
      border: `1px solid ${BORDER}`,
      borderRadius: 10,
      background: PANEL,
      overflow: 'hidden',
    }
    const TREE_FILTER = { flex: 'none', padding: '9px 10px', borderBottom: `1px solid ${BORDER}` }
    const TREE_SCROLL = {
      flex: '1 1 auto',
      minHeight: 0,
      overflowY: 'auto',
      overflowX: 'hidden',
      padding: '6px 6px 10px',
      scrollbarGutter: 'stable',
    }
    const TREE_ROW = {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '5px 8px',
      borderRadius: 6,
      cursor: 'pointer',
      fontSize: 12.5,
      lineHeight: 1.5,
      userSelect: 'none',
      boxSizing: 'border-box',
    }
    const TREE_FOLDER = { ...TREE_ROW, color: MUTED, fontWeight: 600, cursor: 'default' }
    const TREE_CARET = { width: 12, flex: 'none', textAlign: 'center', fontSize: 10, color: MUTED }
    const TREE_COUNT = { marginLeft: 'auto', fontSize: 11, color: MUTED, flex: 'none' }

    // 编辑器
    const EDITOR_PANEL = {
      flex: '1 1 auto',
      minWidth: 0,
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      border: `1px solid ${BORDER}`,
      borderRadius: 10,
      background: PANEL,
      overflow: 'hidden',
    }
    const EDITOR_BAR = {
      flex: 'none',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '8px 12px',
      borderBottom: `1px solid ${BORDER}`,
      flexWrap: 'wrap',
      rowGap: 6,
    }
    const EDITOR_TEXT = {
      flex: '1 1 auto',
      minHeight: 0,
      width: '100%',
      boxSizing: 'border-box',
      border: 'none',
      outline: 'none',
      resize: 'none',
      padding: '12px 14px',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.65,
      color: TEXT,
      background: 'transparent',
      tabSize: 2,
    }
    const EDITOR_FOOT = { flex: 'none', padding: '6px 12px', borderTop: `1px solid ${BORDER}`, fontSize: 11.5, color: MUTED }
    const DOT = { display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: '#d97706', marginRight: 5 }

    const FORMAT_BAR = {
      flex: 'none',
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      padding: '4px 12px',
      borderBottom: `1px solid ${BORDER}`,
      flexWrap: 'wrap',
    }
    const FORMAT_BTN = {
      cursor: 'pointer',
      border: `1px solid ${BORDER}`,
      background: 'transparent',
      color: TEXT,
      borderRadius: 5,
      padding: '2px 7px',
      fontSize: 12,
      lineHeight: 1.6,
      fontFamily: 'inherit',
    }
    const MODE_BTN = { ...FORMAT_BTN, padding: '2px 9px' }
    const MODE_BTN_ACTIVE = { ...MODE_BTN, borderColor: ACCENT, color: ACCENT, background: 'rgba(37,99,235,0.10)' }

    // 右键菜单
    const MENU = {
      position: 'fixed',
      zIndex: 2000,
      minWidth: 168,
      display: 'flex',
      flexDirection: 'column',
      gap: 1,
      padding: 4,
      background: PANEL,
      border: `1px solid ${BORDER}`,
      borderRadius: 8,
      boxShadow: '0 10px 30px rgba(15,23,42,0.18)',
    }
    const MENU_ITEM = {
      textAlign: 'left',
      border: 'none',
      background: 'transparent',
      color: TEXT,
      fontSize: 12.5,
      padding: '5px 10px',
      borderRadius: 5,
      cursor: 'pointer',
      fontFamily: 'inherit',
      whiteSpace: 'nowrap',
    }
    const MENU_ITEM_DANGER = { ...MENU_ITEM, color: DANGER }

    const stripMd = (name) => String(name || '').replace(/\.(md|markdown)$/i, '')


    // ------------------------------------------- 富文本编辑器（Toast UI Editor，MIT）
    // 库文件随插件放在 vendor/ 下，由 Host 的 /company-kb/vendor/* 同源提供，离线可用。
    let toastuiPromise = null
    const loadToastui = () => {
      if (typeof window === 'undefined' || typeof document === 'undefined') {
        return Promise.reject(new Error('当前环境没有浏览器 DOM，无法加载富文本编辑器'))
      }
      if (window.toastui && window.toastui.Editor) return Promise.resolve(window.toastui.Editor)
      if (toastuiPromise) return toastuiPromise
      toastuiPromise = new Promise((resolve, reject) => {
        if (!document.querySelector('link[data-company-kb-toastui]')) {
          const link = document.createElement('link')
          link.rel = 'stylesheet'
          link.href = '/company-kb/vendor/toastui/toastui-editor.css'
          link.setAttribute('data-company-kb-toastui', 'css')
          document.head.appendChild(link)
        }
        const done = () => {
          if (window.toastui && window.toastui.Editor) resolve(window.toastui.Editor)
          else reject(new Error('编辑器脚本已加载，但没有注册 toastui.Editor'))
        }
        const existing = document.querySelector('script[data-company-kb-toastui]')
        if (existing) {
          if (window.toastui && window.toastui.Editor) {
            done()
            return
          }
          existing.addEventListener('load', done)
          existing.addEventListener('error', () => reject(new Error('编辑器脚本加载失败')))
          return
        }
        const script = document.createElement('script')
        script.src = '/company-kb/vendor/toastui/toastui-editor.js'
        script.async = true
        script.setAttribute('data-company-kb-toastui', 'js')
        script.addEventListener('load', done)
        script.addEventListener('error', () => reject(new Error('编辑器脚本加载失败（/company-kb/vendor/toastui/toastui-editor.js）')))
        document.head.appendChild(script)
      }).catch((error) => {
        toastuiPromise = null
        throw error
      })
      return toastuiPromise
    }

    /** 拆出 YAML front matter：富文本编辑器只编辑正文，保存时原样拼回 */
    const splitFrontMatter = (text) => {
      const source = String(text ?? '')
      const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source)
      if (!match) return { fm: '', body: source }
      return { fm: match[1], body: source.slice(match[0].length).replace(/^\n+/, '') }
    }

    const joinFrontMatter = (fm, body) => {
      const meta = String(fm ?? '').trim()
      const text = String(body ?? '').replace(/^\n+/, '')
      return meta ? `---\n${meta}\n---\n\n${text}` : text
    }

    /** relPath（a/b/c.md）→ 目录树节点；目录在前、文件按名称排序 */
    function buildDocTree(docs) {
      const root = { dirs: new Map(), files: [] }
      for (const doc of Array.isArray(docs) ? docs : []) {
        if (!doc || typeof doc.relPath !== 'string') continue
        const parts = doc.relPath.split('/').filter(Boolean)
        let node = root
        for (let i = 0; i < parts.length - 1; i += 1) {
          const name = parts[i]
          if (!node.dirs.has(name)) node.dirs.set(name, { name, dirs: new Map(), files: [] })
          node = node.dirs.get(name)
        }
        node.files.push({ name: stripMd(parts[parts.length - 1] || doc.title || '未命名'), doc })
      }
      return root
    }

    const docMatches = (doc, query) => {
      if (!query) return true
      const haystack = [doc && doc.title, doc && doc.relPath, doc && doc.summary, ...(Array.isArray(doc && doc.tags) ? doc.tags : [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.includes(query)
    }

    function countDocs(node) {
      let total = node.files.length
      for (const child of node.dirs.values()) total += countDocs(child)
      return total
    }


    const PILL_TONES = {
      ok: {
        color: '#15803d',
        dot: '#16a34a',
        background: 'rgba(21,128,61,0.10)',
        border: 'rgba(21,128,61,0.35)',
      },
      busy: {
        color: ACCENT,
        dot: ACCENT,
        background: 'rgba(37,99,235,0.10)',
        border: 'rgba(37,99,235,0.35)',
      },
      warn: {
        color: WARN,
        dot: '#d97706',
        background: 'rgba(217,119,6,0.10)',
        border: 'rgba(217,119,6,0.35)',
      },
      muted: { color: MUTED, dot: '#9ca3af', background: 'transparent', border: BORDER },
    }

    function StatusPill({ tone, children }) {
      const palette = PILL_TONES[tone] || PILL_TONES.muted
      return h(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            color: palette.color,
            background: palette.background,
            border: `1px solid ${palette.border}`,
            borderRadius: 999,
            padding: '2px 10px',
            whiteSpace: 'nowrap',
          },
        },
        h('span', { style: { width: 7, height: 7, borderRadius: '50%', background: palette.dot } }),
        children,
      )
    }

    /** 页面外框：设置页由外壳提供内边距与滚动；独立主面板自己撑满并内部滚动。 */
    function Frame({ embedded, children }) {
      if (embedded) return h('div', { style: wrapper }, children)
      return h('div', { style: PANEL_ROOT }, h('div', { style: PANEL_INNER }, children))
    }

    /** 左侧菜单栏图标（DSH 传入 size / active 两个 owner props） */
    function CompanyKbIcon({ size = 16, active = false }) {
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
        h('path', {
          d: 'M4 5.2A2.2 2.2 0 0 1 6.2 3H11l1.6 2H18a2 2 0 0 1 2 2v11.8A2.2 2.2 0 0 1 17.8 21H6.2A2.2 2.2 0 0 1 4 18.8z',
        }),
        h('path', { d: 'M8 10.5h8M8 14h5.5' }),
      )
    }

    const msg = (cause) => {
      if (!cause) return '未知错误'
      if (typeof cause === 'string') return cause
      return String(cause.message || cause)
    }

    const toNum = (value) => {
      const n = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(n) ? n : 0
    }

    const fmtTime = (ts) => {
      if (ts === null || ts === undefined || ts === '') return '—'
      let value = ts
      if (typeof ts === 'string' && /^\d+$/.test(ts)) value = Number(ts)
      if (typeof value === 'string') value = Date.parse(value)
      if (!Number.isFinite(value)) return String(ts)
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(ts)
      return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`
    }

    const pathOf = (value) => {
      if (!value || typeof value !== 'object') return ''
      if (value.settings && typeof value.settings.path === 'string') return value.settings.path
      if (value.root && typeof value.root.path === 'string') return value.root.path
      return ''
    }

    const getJson = async (url) => {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data || data.ok === false) {
        throw new Error((data && data.error) || `${response.status} ${response.statusText}`)
      }
      return data
    }

    const postJson = async (url, body) => {
      const response = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body === undefined ? {} : body),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data || data.ok === false) {
        const error = new Error((data && data.error) || `${response.status} ${response.statusText}`)
        if (data && data.code) error.code = data.code
        error.status = response.status
        throw error
      }
      return data
    }

    // apply() 里注入的 ctx，用于调用可选的 uiWorkspace 目录选择器。
    let hostCtx = null

    /** 文件目录树：目录可折叠，文件可点开；filter 支持按标题/路径/摘要筛选 */
    function DocTree({ docs, selected, selection, dirty, onSelect, onSelectDir, onNodeMenu, readOnly, maxHeight, form, contextMenu }) {
      const [filter, setFilter] = useState('')
      const [collapsed, setCollapsed] = useState({})
      const tree = useMemo(() => buildDocTree(docs), [docs])
      const query = filter.trim().toLowerCase()

      const toggle = (key) => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))

      const renderNode = (node, depth, prefix) => {
        const rows = []
        const dirNames = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
        for (const name of dirNames) {
          const child = node.dirs.get(name)
          const childPath = prefix ? `${prefix}/${name}` : name
          if (query) {
            const hits = []
            const collect = (current) => {
              hits.push(...current.files.filter((file) => docMatches(file.doc, query)))
              for (const item of current.dirs.values()) collect(item)
            }
            collect(child)
            if (!hits.length) continue
          }
          const isCollapsed = !query && collapsed[childPath] === true
          const isDirSelected = !readOnly && selection && selection.kind === 'dir' && selection.relPath === childPath
          rows.push(
            h(
              'div',
              {
                key: `dir-${childPath}`,
                style: {
                  ...TREE_FOLDER,
                  paddingLeft: 8 + depth * 12,
                  background: isDirSelected ? 'rgba(37,99,235,0.10)' : 'transparent',
                  color: isDirSelected ? ACCENT : MUTED,
                },
                onClick: readOnly
                  ? undefined
                  : () => {
                      toggle(childPath)
                      if (onSelectDir) onSelectDir(childPath)
                    },
                onContextMenu: readOnly ? undefined : (event) => onNodeMenu(event, { kind: 'dir', relPath: childPath }),
                title: childPath,
              },
              h('span', { style: TREE_CARET }, isCollapsed ? '▸' : '▾'),
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, name),
              h('span', { style: TREE_COUNT }, String(countDocs(child))),
            ),
          )
          if (!isCollapsed) rows.push(...renderNode(child, depth + 1, childPath))
        }
        const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
        for (const file of files) {
          if (!docMatches(file.doc, query)) continue
          const relPath = file.doc.relPath
          const isSelected = !readOnly && selected === relPath
          const isDirty = isSelected && dirty
          rows.push(
            h(
              'div',
              {
                key: `doc-${relPath}`,
                style: {
                  ...TREE_ROW,
                  paddingLeft: 8 + depth * 12 + 12,
                  background: isSelected ? 'rgba(37,99,235,0.10)' : 'transparent',
                  color: isSelected ? ACCENT : TEXT,
                  fontWeight: isSelected ? 600 : 400,
                  cursor: readOnly ? 'default' : 'pointer',
                },
                onClick: readOnly ? undefined : () => onSelect(relPath),
                onContextMenu: readOnly ? undefined : (event) => onNodeMenu(event, { kind: 'file', relPath }),
                title: `${file.doc.title || file.name}\n${relPath}${file.doc.summary ? `\n${file.doc.summary}` : ''}`,
              },
              h('span', { style: { flex: 'none', opacity: 0.7 } }, '📄'),
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1 1 auto' } }, file.name),
              isDirty ? h('span', { style: { ...DOT, flex: 'none', marginRight: 0 } }, '') : null,
            ),
          )
        }
        return rows
      }

      const rows = renderNode(tree, 0, '')
      const rootSelected = !readOnly && selection && selection.kind === 'dir' && selection.relPath === ''
      const rootRow = readOnly
        ? null
        : h(
            'div',
            {
              key: 'dir-root',
              style: { ...TREE_FOLDER, paddingLeft: 8, background: rootSelected ? 'rgba(37,99,235,0.10)' : 'transparent', color: rootSelected ? ACCENT : MUTED },
              onClick: () => onSelectDir && onSelectDir(''),
              onContextMenu: (event) => onNodeMenu(event, { kind: 'dir', relPath: '' }),
              title: '知识库根目录',
            },
            h('span', { style: TREE_CARET }, '⌂'),
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, '知识库根目录'),
            h('span', { style: TREE_COUNT }, String(countDocs(tree))),
          )
      return h(
        'div',
        { style: maxHeight ? { ...TREE_PANEL, maxHeight } : TREE_PANEL },
        h(
          'div',
          { style: TREE_FILTER },
          h('input', {
            style: { ...input, width: '100%', padding: '5px 8px' },
            value: filter,
            placeholder: `筛选 ${Array.isArray(docs) ? docs.length : 0} 篇文档…`,
            spellCheck: false,
            onChange: (event) => setFilter(event.target.value),
          }),
        ),
        form || null,
        h(
          'div',
          {
            style: TREE_SCROLL,
            onContextMenu: readOnly ? undefined : (event) => onNodeMenu(event, { kind: 'dir', relPath: '' }),
          },
          rootRow,
          rows.length
            ? rows
            : h('div', { style: { ...hint, padding: '10px 8px' } }, query ? '没有匹配的文档。' : '知识库还没有 Markdown 文档。'),
        ),
        contextMenu || null,
      )
    }

    function CompanyKbView({ embedded }) {
      const [status, setStatus] = useState(null)
      const [loadError, setLoadError] = useState('')
      const [draft, setDraft] = useState('')
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState(null)
      const [pickerHint, setPickerHint] = useState('')
      const [pathOpen, setPathOpen] = useState(false)
      const [selected, setSelected] = useState('')
      const [fileText, setFileText] = useState('')
      const [fileMeta, setFileMeta] = useState(null)
      const [docLoading, setDocLoading] = useState('')
      const [docError, setDocError] = useState('')
      const [dirty, setDirty] = useState(false)
      const [saving, setSaving] = useState(false)
      const [viewMode, setViewMode] = useState('rich')
      const [fmText, setFmText] = useState('')
      const [fmOpen, setFmOpen] = useState(false)
      const [richError, setRichError] = useState('')
      const [richLoading, setRichLoading] = useState(false)
      const [selection, setSelection] = useState(null)
      const [fsAction, setFsAction] = useState(null)
      const [fsBusy, setFsBusy] = useState(false)
      const [fsError, setFsError] = useState('')
      const [menu, setMenu] = useState(null)

      const aliveRef = useRef(true)
      const busyRef = useRef('')
      const editedRef = useRef(false)
      const openToken = useRef(0)
      const textareaRef = useRef(null)
      const richHostRef = useRef(null)
      const richEditorRef = useRef(null)
      const richInitRef = useRef('')
      const fileTextRef = useRef('')
      fileTextRef.current = fileText

      useEffect(() => {
        busyRef.current = busy || (saving ? 'saving' : '')
      }, [busy, saving])

      const refresh = useCallback(async () => {
        try {
          const next = await getJson('/company-kb/status')
          if (!aliveRef.current) return
          if (next && typeof next === 'object') setStatus(next)
          setLoadError('')
        } catch (cause) {
          if (!aliveRef.current) return
          setLoadError(msg(cause))
        }
      }, [])

      useEffect(() => {
        aliveRef.current = true
        refresh()
        const timer = setInterval(() => {
          if (!aliveRef.current) return
          if (busyRef.current) return
          refresh()
        }, POLL_MS)
        return () => {
          aliveRef.current = false
          clearInterval(timer)
        }
      }, [refresh])

      // 用户未手动编辑时，让输入框跟随服务端保存的路径。
      useEffect(() => {
        if (!status) return
        if (editedRef.current) return
        setDraft(pathOf(status))
      }, [status])

      // 尚未配置知识库时，默认展开路径设置。
      useEffect(() => {
        if (!status) return
        if (!status.root || !status.root.configured) setPathOpen(true)
      }, [status])

      const readRichBody = () => {
        const editor = richEditorRef.current
        if (!editor) return null
        try {
          return String(editor.getMarkdown() || '')
        } catch {
          return null
        }
      }

      /** 富文本正文回写到 fileText，供源码模式与保存共用 */
      const commitRichToText = () => {
        const body = readRichBody()
        if (body === null) return fileTextRef.current
        const full = joinFrontMatter(fmText, body)
        setFileText(full)
        richInitRef.current = body
        return full
      }

      // 富文本编辑器挂载 / 卸载（Toast UI Editor）
      useEffect(() => {
        if (viewMode !== 'rich' || !selected || docLoading) return undefined
        if (typeof document === 'undefined' || typeof window === 'undefined') {
          setRichError('当前环境没有浏览器 DOM，无法加载富文本编辑器；请切到「源码」模式编辑。')
          return undefined
        }
        const host = richHostRef.current
        if (!host) return undefined
        let disposed = false
        let editor = null
        let onResize = null
        const initial = splitFrontMatter(fileTextRef.current)
        setFmText(initial.fm)
        richInitRef.current = initial.body
        setRichError('')
        setRichLoading(true)
        loadToastui()
          .then((EditorCtor) => {
            if (disposed) return
            const measure = () => Math.max(240, host.clientHeight || 420)
            editor = new EditorCtor({
              el: host,
              height: `${measure()}px`,
              initialEditType: 'wysiwyg',
              previewStyle: 'vertical',
              hideModeSwitch: true,
              usageStatistics: false,
              language: 'zh-CN',
              initialValue: initial.body,
              toolbarItems: [
                ['heading', 'bold', 'italic', 'strike'],
                ['hr', 'quote'],
                ['ul', 'ol', 'task'],
                ['table', 'link'],
                ['code', 'codeblock'],
              ],
            })
            richEditorRef.current = editor
            onResize = () => {
              if (richEditorRef.current) richEditorRef.current.setHeight(`${measure()}px`)
            }
            window.addEventListener('resize', onResize)
            editor.on('change', () => {
              let body = ''
              try {
                body = String(editor.getMarkdown() || '')
              } catch {
                return
              }
              if (body !== richInitRef.current) setDirty(true)
            })
            setRichLoading(false)
          })
          .catch((error) => {
            if (disposed) return
            setRichLoading(false)
            setRichError(msg(error))
          })
        return () => {
          disposed = true
          if (onResize) window.removeEventListener('resize', onResize)
          if (editor) {
            try {
              editor.destroy()
            } catch {
              /* ignore */
            }
          }
          if (richEditorRef.current === editor) richEditorRef.current = null
        }
      }, [selected, viewMode, docLoading])

      // 右键菜单：点击别处或 Esc 关闭
      useEffect(() => {
        if (!menu) return undefined
        if (typeof document === 'undefined') return undefined
        const close = () => setMenu(null)
        const onKey = (event) => {
          if (event.key === 'Escape') setMenu(null)
        }
        document.addEventListener('mousedown', close)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', close)
          document.removeEventListener('keydown', onKey)
        }
      }, [menu])

      const confirmOk = (text) =>
        typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm(text) : true

      const openDoc = async (relPath, force = false) => {
        if (!relPath) return
        if (!force && relPath === selected) return
        if (relPath !== selected && dirty && !confirmOk('当前文档有未保存的修改，确定放弃并切换？')) return
        const token = openToken.current + 1
        openToken.current = token
        setSelected(relPath)
        setSelection({ kind: 'file', relPath })
        setDocError('')
        setNotice(null)
        setFileText('')
        setFileMeta(null)
        setDirty(false)
        setDocLoading(relPath)
        try {
          const data = await getJson(`/company-kb/doc?path=${encodeURIComponent(relPath)}`)
          if (openToken.current !== token) return
          setFileText(String(data.text || '').replace(/\r\n?/g, '\n'))
          setFileMeta({ mtime: data.mtime, size: data.size })
        } catch (cause) {
          if (openToken.current !== token) return
          setDocError(`打开失败：${msg(cause)}`)
        } finally {
          if (openToken.current === token) setDocLoading('')
        }
      }

      const reloadDoc = async () => {
        if (!selected || docLoading || saving) return
        if (dirty && !confirmOk('放弃当前未保存的修改，重新从磁盘读取？')) return
        await openDoc(selected, true)
      }

      const saveDoc = async () => {
        if (!selected || saving || docLoading) return
        let text
        let richBody = null
        if (viewMode === 'rich' && richEditorRef.current) {
          richBody = readRichBody()
          text = joinFrontMatter(fmText, richBody === null ? richInitRef.current : richBody)
        } else {
          text = fileText
        }
        setSaving(true)
        setDocError('')
        try {
          const result = await postJson('/company-kb/doc/save', {
            path: selected,
            text,
            baseMtime: fileMeta ? fileMeta.mtime : undefined,
          })
          setFileMeta({ mtime: result.mtime, size: result.size })
          setDirty(false)
          if (richBody !== null) {
            richInitRef.current = richBody
            setFileText(text)
          }
          if (result.status) setStatus(result.status)
          setNotice({
            kind: 'ok',
            text: result.reindexed ? '已保存，本篇索引已更新（AI 可立即检索）。' : '已保存；索引将在下次扫描时更新。',
          })
        } catch (cause) {
          const text = msg(cause)
          setDocError(text)
          setNotice({ kind: 'err', text: `保存失败：${text}` })
        } finally {
          setSaving(false)
        }
      }

      const clearDoc = () => {
        setSelected('')
        setFileText('')
        setFileMeta(null)
        setDirty(false)
        setDocError('')
      }

      const dirOf = (rel) => {
        const value = String(rel || '')
        const at = value.lastIndexOf('/')
        return at === -1 ? '' : value.slice(0, at)
      }
      const baseName = (rel) => String(rel || '').split('/').pop() || ''
      const affectsOpenDoc = (entryPath, kind) => {
        if (!selected) return false
        if (kind === 'file') return selected === entryPath
        return selected === entryPath || selected.startsWith(`${entryPath}/`)
      }

      const startFsAction = (kind, explicitTarget) => {
        setMenu(null)
        setFsError('')
        setNotice(null)
        const target = explicitTarget || selection
        if (kind === 'newdoc' || kind === 'newdir') {
          const dir = target ? (target.kind === 'dir' ? target.relPath : dirOf(target.relPath)) : ''
          setSelection(target || { kind: 'dir', relPath: '' })
          setFsAction({ kind, dir, value: '', recursive: false })
          return
        }
        if (!target) return
        setSelection(target)
        if (dirty && affectsOpenDoc(target.relPath, target.kind)) {
          setFsError('当前文档有未保存的修改，请先保存或「还原」后再重命名 / 删除。')
          return
        }
        setFsAction({
          kind,
          path: target.relPath,
          kindOf: target.kind,
          value: kind === 'rename' ? baseName(target.relPath) : '',
          recursive: false,
        })
      }

      const cancelFsAction = () => {
        setFsAction(null)
        setFsError('')
      }

      const submitFsAction = async () => {
        if (!fsAction || fsBusy) return
        const action = fsAction
        setFsBusy(true)
        setFsError('')
        try {
          let body
          if (action.kind === 'newdoc' || action.kind === 'newdir') {
            const name = String(action.value || '').trim()
            if (!name) throw new Error('请输入名称')
            body = { action: action.kind === 'newdoc' ? 'create-doc' : 'mkdir', dir: action.dir, name }
          } else if (action.kind === 'rename') {
            const newName = String(action.value || '').trim()
            if (!newName) throw new Error('请输入新名称')
            body = { action: 'rename', path: action.path, newName }
          } else {
            body = { action: 'delete', path: action.path, recursive: action.recursive === true }
          }
          const result = await postJson('/company-kb/fs', body)
          if (result.status) setStatus(result.status)
          setFsAction(null)
          setNotice({ kind: 'ok', text: '操作完成，索引已更新。' })
          if (action.kind === 'newdoc' && result.relPath) {
            setSelection({ kind: 'file', relPath: result.relPath })
            await openDoc(result.relPath)
          } else if (action.kind === 'rename' && result.relPath) {
            setSelection({ kind: action.kindOf, relPath: result.relPath })
            if (action.kindOf === 'file' && selected === action.path) {
              await openDoc(result.relPath)
            } else if (action.kindOf === 'dir' && selected && selected.startsWith(`${action.path}/`)) {
              await openDoc(result.relPath + selected.slice(action.path.length))
            }
          } else if (action.kind === 'delete') {
            if (affectsOpenDoc(action.path, action.kindOf)) clearDoc()
            if (selection && selection.relPath === action.path) setSelection(null)
          }
        } catch (cause) {
          if (cause && cause.code === 'NOT_EMPTY') {
            setFsAction({ ...action, recursive: true })
            setFsError('文件夹非空：再点一次「删除」将连同子目录一起删除。')
          } else {
            setFsError(msg(cause))
          }
        } finally {
          setFsBusy(false)
        }
      }

      /** 在光标/选区处套用 Markdown 语法，或给当前行加前缀（标题、列表、引用） */
      const applyFormat = (kind) => {
        if (!selected || viewMode === 'rich') return
        const el = textareaRef.current
        const value = fileText
        const setValue = setFileText
        const start = el && Number.isFinite(el.selectionStart) ? el.selectionStart : value.length
        const end = el && Number.isFinite(el.selectionEnd) ? el.selectionEnd : value.length
        const picked = value.slice(start, end)
        const restore = (from, to) => {
          const focus = () => {
            if (!el || typeof el.setSelectionRange !== 'function') return
            el.focus()
            el.setSelectionRange(from, to)
          }
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focus)
          else setTimeout(focus, 0)
        }
        const replace = (nextText, selStart, selEnd) => {
          setValue(nextText)
          setDirty(true)
          restore(selStart, selEnd)
        }
        if (kind === 'bold') {
          replace(`${value.slice(0, start)}**${picked || '加粗文字'}**${value.slice(end)}`, start + 2, start + 2 + (picked || '加粗文字').length)
          return
        }
        if (kind === 'italic') {
          replace(`${value.slice(0, start)}*${picked || '斜体文字'}*${value.slice(end)}`, start + 1, start + 1 + (picked || '斜体文字').length)
          return
        }
        if (kind === 'link') {
          const label = picked || '链接文字'
          replace(`${value.slice(0, start)}[${label}](https://)${value.slice(end)}`, start + label.length + 3, start + label.length + 12)
          return
        }
        if (kind === 'code') {
          if (picked.includes('\n')) {
            const next = `${value.slice(0, start)}\`\`\`\n${picked}\n\`\`\`${value.slice(end)}`
            replace(next, start + 4, start + 4 + picked.length)
          } else {
            replace(`${value.slice(0, start)}\`${picked || '代码'}\`${value.slice(end)}`, start + 1, start + 1 + (picked || '代码').length)
          }
          return
        }
        // 行级前缀：标题 / 列表 / 引用 / 表格
        const lineStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1
        const lineEndRaw = value.indexOf('\n', end)
        const lineEnd = lineEndRaw === -1 ? value.length : lineEndRaw
        const block = value.slice(lineStart, lineEnd)
        const prefix = kind === 'heading' ? '## ' : kind === 'list' ? '- ' : kind === 'quote' ? '> ' : ''
        if (!prefix) return
        const nextBlock = block
          .split('\n')
          .map((line) => (line.startsWith(prefix) ? line : `${prefix}${line}`))
          .join('\n')
        replace(`${value.slice(0, lineStart)}${nextBlock}${value.slice(lineEnd)}`, lineStart + prefix.length, lineEnd + prefix.length * block.split('\n').length)
      }

      const pickDirectory = async () => {
        setPickerHint('')
        setNotice(null)
        try {
          const ui = hostCtx && typeof hostCtx.get === 'function' ? hostCtx.get('uiWorkspace') : null
          const picked = ui && typeof ui.pickDirectory === 'function' ? await ui.pickDirectory() : null
          let pickedPath = ''
          if (typeof picked === 'string') pickedPath = picked
          else if (picked && typeof picked === 'object' && typeof picked.path === 'string') pickedPath = picked.path
          pickedPath = pickedPath.trim()
          if (pickedPath) {
            editedRef.current = true
            setDraft(pickedPath)
            setNotice({ kind: 'ok', text: '已选择目录，点「保存并重建索引」生效。' })
          } else {
            setPickerHint('当前环境弹不出目录选择框，请手动粘贴知识库路径（NAS 路径形如 \\\\NAS\\共享\\知识库）。')
          }
        } catch (cause) {
          setPickerHint(`目录选择不可用（${msg(cause)}）。网络路径通常无法在浏览器中选择，请手动粘贴路径。`)
        }
      }

      const savePath = async () => {
        if (busy) return
        const value = String(draft || '').trim()
        if (!value) {
          setNotice({ kind: 'err', text: '请先填写知识库路径，再保存。' })
          return
        }
        setBusy('save')
        setNotice(null)
        try {
          const result = await postJson('/company-kb/settings', { path: value })
          const next = result && result.status && typeof result.status === 'object' ? result.status : null
          if (next) {
            editedRef.current = false
            setStatus(next)
            setDraft(pathOf(next) || value)
          }
          openToken.current += 1
          setSelected('')
          setFileText('')
          setFileMeta(null)
          setDirty(false)
          setDocError('')
          setLoadError('')
          const building = Boolean(next && next.index && next.index.building)
          setNotice({ kind: 'ok', text: building ? '保存成功，正在重建索引…' : '保存成功。' })
        } catch (cause) {
          setNotice({ kind: 'err', text: `保存失败：${msg(cause)}` })
        } finally {
          setBusy('')
        }
      }

      const reindex = async () => {
        if (busy) return
        setBusy('reindex')
        setNotice(null)
        try {
          const result = await postJson('/company-kb/reindex')
          const next = result && result.status && typeof result.status === 'object' ? result.status : null
          if (next) setStatus(next)
          setLoadError('')
          const building = Boolean(next && next.index && next.index.building)
          setNotice({ kind: 'ok', text: building ? '已开始重新索引，正在扫描 NAS…' : '重新索引完成。' })
        } catch (cause) {
          setNotice({ kind: 'err', text: `重新索引失败：${msg(cause)}` })
        } finally {
          setBusy('')
        }
      }

      const retry = () => {
        setLoadError('')
        refresh()
      }

      if (!status) {
        return h(
          Frame,
          { embedded },
          loadError
            ? h(
                'div',
                { style: { ...card, borderColor: 'rgba(185,28,28,0.35)' } },
                h('div', { style: cardTitle }, '企业知识库暂时不可用'),
                h('div', { style: { fontSize: 13, color: DANGER, marginBottom: 10, wordBreak: 'break-all' } }, `读取状态失败：${loadError}`),
                h('button', { type: 'button', style: primaryButton, onClick: retry }, '重试'),
                h('div', { style: { ...hint, marginTop: 8 } }, '插件服务可能尚未启动，或开发服务器还没重启；稍后可再点「重试」。'),
              )
            : h('div', { style: { ...hint, padding: '12px 0' } }, '正在读取企业知识库状态…'),
        )
      }

      try {
        const plugin = status.plugin && typeof status.plugin === 'object' ? status.plugin : {}
        const root = status.root && typeof status.root === 'object' ? status.root : {}
        const index = status.index && typeof status.index === 'object' ? status.index : {}
        const docs = Array.isArray(status.docs) ? status.docs : []
        const indexErrors = Array.isArray(index.errors) ? index.errors : []

        const configured = Boolean(root.configured)
        const exists = Boolean(root.exists)
        const building = Boolean(index.building)
        const docsCount = toNum(index.docs) || docs.length

        let pill
        if (!configured) pill = { tone: 'muted', text: '未配置' }
        else if (!exists) pill = { tone: 'warn', text: '路径不可用' }
        else if (building) pill = { tone: 'busy', text: '索引中' }
        else if (docsCount > 0) pill = { tone: 'ok', text: '已连接' }
        else pill = { tone: 'muted', text: '暂无文档' }

        const rootLine = !configured
          ? '尚未配置知识库路径。'
          : exists
            ? `路径可用${root.error ? `（提示：${root.error}）` : ''}`
            : `路径不可用${root.error ? `：${root.error}` : '，请检查文件夹是否存在或网络是否可达'}`
        const checkedLine = root.checkedAt ? ` · 最近检查 ${fmtTime(root.checkedAt)}` : ''

        const selectedMeta = docs.find((doc) => doc && doc.relPath === selected)
        const lines = fileText ? fileText.split('\n').length : 0

        const header = h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flex: 'none', marginBottom: 10 } },
          h('div', { style: { fontSize: 18, fontWeight: 600, marginRight: 6 } }, '企业知识库'),
          h(StatusPill, { tone: pill.tone }, pill.text),
          h('span', { style: { fontSize: 12, color: MUTED } }, `文档 ${docsCount} 篇 · 最近索引 ${fmtTime(index.lastIndexAt)}`),
          h(
            'div',
            { style: { marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' } },
            h(
              'button',
              { type: 'button', style: button, disabled: Boolean(busy), onClick: () => setPathOpen((value) => !value) },
              pathOpen ? '收起路径' : '知识库路径',
            ),
            h(
              'button',
              { type: 'button', style: button, disabled: Boolean(busy), onClick: reindex },
              busy === 'reindex' ? '索引中…' : '重新索引',
            ),
          ),
        )

        const pathCard = h(
          'div',
          { style: { ...card, flex: 'none', marginBottom: 10 } },
          h('div', { style: cardTitle }, '知识库位置'),
          h('div', { style: hint }, '填写公司 Markdown 知识库所在的本地或 NAS 文件夹。目录（含子目录）里的每个 .md 文件就是一篇文档，左侧按目录树展示。'),
          h(
            'div',
            { style: { ...row, marginTop: 8 } },
            h('input', {
              style: { ...input, flex: '1 1 300px', minWidth: 240 },
              value: draft,
              placeholder: '\\\\NAS\\共享\\知识库 或 Z:\\知识库',
              spellCheck: false,
              autoComplete: 'off',
              onChange: (event) => {
                editedRef.current = true
                setDraft(event.target.value)
              },
              onKeyDown: (event) => {
                if (event.key === 'Enter') savePath()
              },
            }),
            h('button', { type: 'button', style: button, disabled: Boolean(busy), onClick: pickDirectory }, '浏览…'),
          ),
          h(
            'div',
            { style: { marginTop: 10 } },
            h(
              'button',
              { type: 'button', style: primaryButton, disabled: Boolean(busy), onClick: savePath },
              busy === 'save' ? '保存中…' : '保存并重建索引',
            ),
          ),
          pickerHint ? h('div', { style: { ...hint, color: WARN, marginTop: 8 } }, pickerHint) : null,
          h('div', { style: { ...hint, marginTop: 8 } }, `${rootLine}${checkedLine}`),
          building ? h('div', { style: { ...hint, color: ACCENT, marginTop: 4 } }, '正在扫描 NAS…') : null,
        )

        const statRow = (labelText, valueText) =>
          h(
            'div',
            { style: { display: 'flex', gap: 8, fontSize: 12, lineHeight: 1.9, alignItems: 'baseline' } },
            h('span', { style: { color: MUTED, minWidth: 72 } }, labelText),
            h('span', { style: { color: TEXT } }, valueText),
          )

        const indexCard = h(
          'div',
          { style: { ...card, flex: 'none', marginBottom: 10 } },
          h('div', { style: cardTitle }, '索引状态'),
          h(
            'div',
            { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: '0 18px' } },
            statRow('文档', `${docsCount} 篇`),
            statRow('切块', `${toNum(index.chunks)} 块`),
            statRow('字符数', `${toNum(index.chars)}`),
            statRow('扫描耗时', index.lastScanMs === undefined || index.lastScanMs === null ? '—' : `${toNum(index.lastScanMs)} ms`),
            statRow('最近索引', fmtTime(index.lastIndexAt)),
            statRow('跳过文件', `${toNum(index.skipped)} 个`),
            statRow('错误', `${indexErrors.length} 条`),
          ),
          indexErrors.length
            ? h(
                'div',
                { style: { marginTop: 10 } },
                h('div', { style: { fontSize: 12, color: DANGER, marginBottom: 4 } }, `索引错误（共 ${indexErrors.length} 条，最多显示 5 条）`),
                h(
                  'ul',
                  { style: { listStyle: 'none', margin: 0, padding: 0 } },
                  indexErrors.slice(0, 5).map((item, itemIndex) =>
                    h(
                      'li',
                      {
                        key: `error-${itemIndex}`,
                        style: {
                          fontSize: 12,
                          padding: '5px 0',
                          borderTop: itemIndex ? `1px solid ${BORDER}` : 'none',
                          color: MUTED,
                        },
                      },
                      h('div', { style: { ...mono, color: TEXT, wordBreak: 'break-all' } }, String((item && (item.path || item.relPath)) || '（未知文件）')),
                      h('div', { style: { wordBreak: 'break-all' } }, String((item && (item.message || item.error)) || '未知错误')),
                    ),
                  ),
                ),
                indexErrors.length > 5 ? h('div', { style: { ...hint, marginTop: 4 } }, `另有 ${indexErrors.length - 5} 条错误未显示。`) : null,
              )
            : null,
        )

        const openNodeMenu = (event, target) => {
          if (!event || typeof event.preventDefault !== 'function' || embedded) return
          event.preventDefault()
          if (typeof event.stopPropagation === 'function') event.stopPropagation()
          const viewportWidth = typeof window !== 'undefined' ? window.innerWidth || 1200 : 1200
          const viewportHeight = typeof window !== 'undefined' ? window.innerHeight || 800 : 800
          const width = 176
          const height = target.kind === 'file' ? 120 : 160
          const x = Math.max(8, Math.min(Number(event.clientX) || 0, viewportWidth - width - 8))
          const y = Math.max(8, Math.min(Number(event.clientY) || 0, viewportHeight - height - 8))
          setSelection(target)
          setMenu({ x, y, target })
        }

        const menuItem = (label, onPress, danger) =>
          h(
            'button',
            {
              type: 'button',
              style: danger ? MENU_ITEM_DANGER : MENU_ITEM,
              onClick: () => {
                setMenu(null)
                onPress()
              },
            },
            label,
          )

        const contextMenuEl = menu
          ? h(
              'div',
              {
                style: { ...MENU, left: menu.x, top: menu.y },
                onMouseDown: (event) => {
                  if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                },
              },
              menu.target.kind === 'file'
                ? [
                    menuItem('打开', () => openDoc(menu.target.relPath)),
                    menuItem('重命名', () => startFsAction('rename', menu.target)),
                    menuItem('删除', () => startFsAction('delete', menu.target), true),
                  ]
                : [
                    menuItem('新建文档', () => startFsAction('newdoc', menu.target)),
                    menuItem('新建文件夹', () => startFsAction('newdir', menu.target)),
                    menu.target.relPath ? menuItem('重命名', () => startFsAction('rename', menu.target)) : null,
                    menu.target.relPath ? menuItem('删除', () => startFsAction('delete', menu.target), true) : null,
                  ],
            )
          : null

        const fsForm =
          !embedded && (fsAction || fsError)
            ? h(
                'div',
                { style: { padding: '6px 10px 8px', borderBottom: `1px solid ${BORDER}`, background: 'rgba(37,99,235,0.05)' } },
                fsAction
                  ? h(
                      'div',
                      { style: { fontSize: 11.5, color: MUTED, marginBottom: 4, wordBreak: 'break-all' } },
                      fsAction.kind === 'newdoc'
                        ? `在「${fsAction.dir || '知识库根目录'}」新建文档`
                        : fsAction.kind === 'newdir'
                          ? `在「${fsAction.dir || '知识库根目录'}」新建文件夹`
                          : fsAction.kind === 'rename'
                            ? `重命名「${baseName(fsAction.path)}」为`
                            : `删除「${fsAction.path}」${fsAction.recursive ? '（含子目录）' : ''}`,
                    )
                  : null,
                fsAction && fsAction.kind === 'delete'
                  ? h(
                      'div',
                      { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                      h(
                        'button',
                        { type: 'button', style: { ...primaryButton, marginRight: 0 }, disabled: fsBusy, onClick: submitFsAction },
                        fsBusy ? '删除中…' : fsAction.recursive ? '确认递归删除' : '确认删除',
                      ),
                      h('button', { type: 'button', style: { ...button, marginRight: 0 }, disabled: fsBusy, onClick: cancelFsAction }, '取消'),
                    )
                  : fsAction
                    ? h(
                        'div',
                        { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                        h('input', {
                          style: { ...input, flex: '1 1 auto', minWidth: 0, padding: '4px 8px' },
                          value: fsAction.value,
                          autoFocus: true,
                          spellCheck: false,
                          placeholder: fsAction.kind === 'rename' ? '新名称' : '名称（文档可省略 .md）',
                          onChange: (event) => setFsAction({ ...fsAction, value: event.target.value }),
                          onKeyDown: (event) => {
                            if (event.key === 'Enter') submitFsAction()
                            if (event.key === 'Escape') cancelFsAction()
                          },
                        }),
                        h(
                          'button',
                          { type: 'button', style: { ...primaryButton, marginRight: 0 }, disabled: fsBusy, onClick: submitFsAction },
                          fsBusy ? '处理中…' : '确定',
                        ),
                        h('button', { type: 'button', style: { ...button, marginRight: 0 }, disabled: fsBusy, onClick: cancelFsAction }, '取消'),
                      )
                    : null,
                fsError ? h('div', { style: { fontSize: 11.5, color: DANGER, marginTop: 4, wordBreak: 'break-all' } }, fsError) : null,
              )
            : null

        const tree = h(DocTree, {
          docs,
          selected,
          selection,
          dirty,
          readOnly: embedded,
          onSelect: openDoc,
          onSelectDir: (relPath) => {
            setFsError('')
            setSelection({ kind: 'dir', relPath })
          },
          maxHeight: embedded ? 460 : undefined,
          onNodeMenu: openNodeMenu,
          form: fsForm,
          contextMenu: contextMenuEl,
        })

        const modeButton = (key, label) =>
          h(
            'button',
            {
              type: 'button',
              style: viewMode === key ? MODE_BTN_ACTIVE : MODE_BTN,
              onClick: () => {
                // 离开富文本前先落盘，避免两种编辑状态互相覆盖
                if (viewMode === 'rich' && key !== 'rich') commitRichToText()
                setViewMode(key)
              },
            },
            label,
          )

        const formatButton = (kind, label, title, extra) =>
          h(
            'button',
            {
              type: 'button',
              style: extra ? { ...FORMAT_BTN, ...extra } : FORMAT_BTN,
              title,
              onClick: () => applyFormat(kind),
            },
            label,
          )

        const showFormatBar = Boolean(selected) && viewMode !== 'rich'

        const formatBar = showFormatBar
          ? h(
              'div',
              { style: FORMAT_BAR },
              formatButton('bold', 'B', '加粗（**文字**）', { fontWeight: 700 }),
              formatButton('italic', 'I', '斜体（*文字*）', { fontStyle: 'italic' }),
              h('span', { style: { width: 4 } }),
              formatButton('heading', 'H2', '把当前行变成二级标题'),
              formatButton('list', '列表', '把当前行变成无序列表'),
              formatButton('quote', '引用', '把当前行变成引用'),
              formatButton('code', '代码', '行内代码或代码块'),
              formatButton('link', '链接', '插入 [文字](https://)'),
            )
          : null


        const editor = h(
          'div',
          { style: EDITOR_PANEL },
          h(
            'div',
            { style: EDITOR_BAR },
            selected
              ? [
                  h(
                    'div',
                    { style: { fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    String((selectedMeta && selectedMeta.title) || stripMd(String(selected).split('/').pop())),
                  ),
                  dirty
                    ? h('span', { style: { fontSize: 11.5, color: WARN, whiteSpace: 'nowrap' } }, h('span', { style: DOT }), '未保存')
                    : null,
                  h(
                    'span',
                    { style: { fontSize: 11.5, color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1 1 auto', minWidth: 60 } },
                    selected,
                  ),
                  fileMeta ? h('span', { style: { fontSize: 11.5, color: MUTED, whiteSpace: 'nowrap' } }, `修改于 ${fmtTime(fileMeta.mtime)}`) : null,
                  h(
                    'div',
                    { style: { display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto' } },
                    h(
                      'button',
                      {
                        type: 'button',
                        style: { ...primaryButton, marginRight: 0, opacity: !dirty || saving ? 0.55 : 1, cursor: !dirty || saving ? 'default' : 'pointer' },
                        disabled: !dirty || saving,
                        onClick: saveDoc,
                      },
                      saving ? '保存中…' : '保存',
                    ),
                    h('button', { type: 'button', style: { ...button, marginRight: 0 }, disabled: saving || docLoading, onClick: reloadDoc }, '还原'),
                  ),
                  h(
                    'div',
                    { style: { display: 'flex', gap: 4, alignItems: 'center', flex: 'none' } },
                    modeButton('rich', '富文本'),
                    modeButton('source', '源码'),
                  ),
                ]
              : h('span', { style: { fontSize: 12.5, color: MUTED } }, '从左侧目录选一篇文档'),
          ),
          formatBar,
          docError
            ? h(
                'div',
                {
                  style: {
                    flex: 'none',
                    padding: '8px 12px',
                    fontSize: 12,
                    color: DANGER,
                    wordBreak: 'break-all',
                    borderBottom: `1px solid ${BORDER}`,
                    background: 'rgba(185,28,28,0.06)',
                  },
                },
                docError,
              )
            : null,
          docLoading
            ? h('div', { style: { ...hint, flex: '1 1 auto', padding: '16px 14px' } }, '正在读取…')
            : !selected
              ? h(
                  'div',
                  { style: { ...hint, flex: '1 1 auto', padding: '24px 16px' } },
                  '点击左侧文档打开。默认是富文本（所见即所得）编辑，可切「源码」改全文。保存（Ctrl+S）后自动重索引这一篇。',
                )
              : viewMode === 'rich'
                ? h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 } },
                    h(
                      'div',
                      { style: { flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', borderBottom: `1px solid ${BORDER}` } },
                      h(
                        'button',
                        { type: 'button', style: { ...FORMAT_BTN, padding: '1px 8px' }, onClick: () => setFmOpen((value) => !value) },
                        fmOpen ? '文档属性 ▾' : '文档属性 ▸',
                      ),
                      h(
                        'span',
                        { style: { fontSize: 11.5, color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                        fmText.trim() ? fmText.replace(/\n/g, ' · ').slice(0, 70) : '未检测到 front matter（展开可添加）',
                      ),
                    ),
                    fmOpen
                      ? h('textarea', {
                          style: { ...EDITOR_TEXT, flex: 'none', height: 96, borderBottom: `1px solid ${BORDER}`, background: 'rgba(17,24,39,0.03)' },
                          value: fmText,
                          spellCheck: false,
                          placeholder: 'title: 文档标题\nsummary: 一句话摘要\ncategory: 分类\ntags: 标签1,标签2',
                          onChange: (event) => {
                            setFmText(event.target.value)
                            setDirty(true)
                          },
                        })
                      : null,
                    h('div', { ref: richHostRef, style: { flex: '1 1 auto', minHeight: 0, overflow: 'hidden', position: 'relative' } }),
                    richLoading ? h('div', { style: { ...hint, flex: 'none', padding: '6px 12px' } }, '正在加载富文本编辑器…') : null,
                    richError
                      ? h(
                          'div',
                          { style: { flex: 'none', padding: '8px 12px', fontSize: 12, color: DANGER, borderTop: `1px solid ${BORDER}`, background: 'rgba(185,28,28,0.06)' } },
                          h('div', { style: { wordBreak: 'break-all' } }, `富文本编辑器不可用：${richError}`),
                          h(
                            'div',
                            { style: { marginTop: 6 } },
                            h('button', { type: 'button', style: FORMAT_BTN, onClick: () => setViewMode('source') }, '改用源码模式'),
                          ),
                        )
                      : null,
                  )
                : h(
                    'div',
                    { style: { display: 'flex', flex: '1 1 auto', minHeight: 0 } },
                      h('textarea', {
                        key: 'source',
                        ref: textareaRef,
                        style: EDITOR_TEXT,
                        value: fileText,
                        spellCheck: false,
                        wrap: 'off',
                        onChange: (event) => {
                          setFileText(event.target.value)
                          setDirty(true)
                        },
                        onKeyDown: (event) => {
                          const key = String(event.key).toLowerCase()
                          if ((event.ctrlKey || event.metaKey) && key === 's') {
                            event.preventDefault()
                            saveDoc()
                            return
                          }
                          if ((event.ctrlKey || event.metaKey) && (key === 'b' || key === 'i')) {
                            event.preventDefault()
                            applyFormat(key === 'b' ? 'bold' : 'italic')
                          }
                        },
                      }),
                    ),
          h(
            'div',
            { style: EDITOR_FOOT },
            !selected
              ? '未选择文档'
              : viewMode === 'rich'
                ? `${lines} 行 · ${fileText.length} 字符 · 富文本（所见即所得）· Ctrl+S 保存`
                : `${lines} 行 · ${fileText.length} 字符 · 源码模式 · Ctrl+S 保存`,
          ),
        )

        const browser = h(
          'div',
          {
            style: embedded
              ? { display: 'flex', gap: 12, height: 520, minHeight: 0, flex: 'none' }
              : { display: 'flex', gap: 12, flex: '1 1 auto', minHeight: 0, paddingTop: 2 },
          },
          tree,
          editor,
        )

        const authorCard = h(
          'div',
          { style: { ...card, flex: 'none' } },
          h('div', { style: cardTitle }, '作者信息'),
          h(
            'div',
            { style: { ...hint, lineHeight: 2 } },
            h('div', null, '作者：', h('span', { style: { color: TEXT, fontWeight: 600 } }, '思链科技（MindLink）')),
            h(
              'div',
              null,
              '插件：',
              h('span', { style: mono }, plugin.name || '@mindlink-ai/dsh-company-knowledge'),
              plugin.version ? ` · v${plugin.version}` : '',
            ),
            h('div', null, '能力：本地 / NAS Markdown 企业知识库索引与检索；面板内按目录树浏览、编辑并保存文档（保存后自动重索引本篇）'),
            h('div', null, '许可：MIT · 不上传数据；写操作只作用于知识库目录内的 .md 文件，并做路径与 mtime 冲突校验'),
          ),
        )

        const noticeLine = notice
          ? h(
              'div',
              {
                style: {
                  flex: 'none',
                  fontSize: 12,
                  marginBottom: 8,
                  color: notice.kind === 'ok' ? '#15803d' : DANGER,
                  wordBreak: 'break-all',
                },
              },
              notice.text,
            )
          : null

        const errorLine = indexErrors.length
          ? h(
              'div',
              { style: { flex: 'none', fontSize: 12, color: WARN, marginBottom: 8, wordBreak: 'break-all' } },
              `索引错误 ${indexErrors.length} 条：${String((indexErrors[0] && (indexErrors[0].message || indexErrors[0].error)) || '')}`,
            )
          : null

        if (embedded) {
          return h(Frame, { embedded }, header, pathCard, noticeLine, indexCard, errorLine, browser, authorCard)
        }
        return h(Frame, { embedded }, header, pathOpen ? pathCard : null, noticeLine, errorLine, browser)
      } catch (cause) {
        return h(
          Frame,
          { embedded },
          h(
            'div',
            { style: { color: DANGER, fontSize: 13 } },
            `企业知识库面板渲染失败：${msg(cause)}，请刷新页面重试。`,
          ),
        )
      }
    }

    /** 设置页里的分区：内边距由外壳提供 */
    function CompanyKbSection() {
      return h(CompanyKbView, { embedded: true })
    }

    /** 左侧菜单栏打开的独立主面板 */
    function CompanyKbPanel() {
      return h(CompanyKbView, { embedded: false })
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        hostCtx = ctx
        // 设置 → 企业知识库（改路径、看索引状态）
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'company-kb', order: 25, label: () => '企业知识库' },
            CompanyKbSection,
          ),
        )
        // 左侧菜单栏入口（图标）与对应的主面板；id 必须与 main 的 key 一致
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'company-kb', order: 6, label: () => '企业知识库' },
            CompanyKbIcon,
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'company-kb' }, CompanyKbPanel),
        )
      },
    }
  },
})

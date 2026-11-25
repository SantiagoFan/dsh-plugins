/**
 * Host half of @mindlink-ai/dsh-company-knowledge（企业知识库）.
 *
 * 目标：让局域网同事安装插件后，把公司 NAS 上的 Markdown 企业知识库
 * （企业基础信息、产品信息、流程、FAQ 等公开内容）变成 DSH 的「企业记忆」：
 *
 *  - 扫描指定目录下的 Markdown，建立本地索引（含标题 / 摘要 / 分类 / 标题大纲）；
 *  - 注册 4 个 Agent 工具：kb_status / kb_search / kb_read / kb_list；
 *  - 每次对话自动注入一段紧凑的知识库概览（可用配置关闭）；
 *  - 同源 HTTP 路由 /company-kb/* 供「设置 → 企业知识库」页面读写配置与状态。
 *
 * 设计约束：
 *  - 默认只读；唯一的写路径是用户在面板里点「保存」：仅知识库根目录内的 .md、
 *    原子写入、写入前校验 mtime 冲突（别人改过就报 409，不覆盖）；
 *  - 索引与配置只存在本机 ~/.dsh/company-kb/（可用 DSH_COMPANY_KB_DIR 覆盖）；
 *  - NAS 可能很慢：扫描在后台异步进行，工具先用缓存/旧索引，不阻塞 Host 事件循环；
 *  - 不引入第三方依赖，只用 Node 内置模块，方便局域网直接分发目录安装。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'company-kb'
export const inject = ['tools']

const PLUGIN_NAME = '@mindlink-ai/dsh-company-knowledge'
const VERSION = '1.0.0'
const TITLE = '企业知识库'

const DATA_DIR = process.env.DSH_COMPANY_KB_DIR || path.join(os.homedir(), '.dsh', 'company-kb')
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')
const CACHE_FILE = path.join(DATA_DIR, 'index.json')
const CACHE_VERSION = 1

/** 插件目录（用于托管第三方编辑器静态资源，离线可用） */
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const VENDOR_DIR = path.join(PLUGIN_DIR, 'vendor')

const DEFAULT_EXTENSIONS = ['.md', '.markdown']
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.idea', '.vscode', '__pycache__',
  '$RECYCLE.BIN', 'System Volume Information', '.obsidian', '.trash',
])
const MAX_DEPTH = 10

const DEFAULT_SETTINGS = {
  /** 知识库根目录：UNC（\\NAS\共享\知识库）或映射盘符（Z:\知识库） */
  path: '',
  /** 工具触发时的懒刷新阈值（毫秒），0 表示永不清新 */
  staleMs: 300000,
  /** 后台定时重扫间隔（秒），0 表示关闭 */
  autoRefreshSeconds: 0,
  /** 是否把知识库概览注入每一轮对话 */
  injectPrompt: true,
  /** 注入概览里最多列出的文档数 */
  promptMaxDocs: 60,
  /** 注入概览的字符上限 */
  promptMaxChars: 2600,
  /** kb_read 单次返回的默认字符数 */
  maxDocChars: 40000,
  /** 扫描文件数上限（防止误指到超大目录） */
  maxFiles: 2000,
  /** 单个文件字节上限 */
  maxFileBytes: 400000,
  /** 等待首次索引的最长时间（毫秒） */
  waitMs: 15000,
  extensions: DEFAULT_EXTENSIONS,
}

// ------------------------------------------------------------------ 纯函数工具

const norm = (value) => String(value ?? '').normalize('NFKC')

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'how', 'what',
  'when', 'where', 'which', 'who', 'why', 'you', 'your', 'our', 'not', 'can', 'could',
  'should', 'would', 'about', 'into', 'than', 'then', 'there', 'their', 'they', 'has', 'have',
  '的', '了', '是', '在', '和', '与', '及', '或', '等', '中', '为', '对', '我', '你', '他',
  '我们', '你们', '他们', '什么', '怎么', '如何', '哪些', '是否', '一下', '这个', '那个',
  '有', '吗', '呢', '吧', '啊', '也', '都', '就', '被', '把', '到', '从', '会', '能', '要',
])

/** 解析 Markdown 头部的 YAML front matter（只解析扁平的 key: value，够用且不引依赖） */
export function parseFrontMatter(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '')
  const meta = {}
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source)
  if (!match) return { meta, body: source }
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    let value = line.slice(colon + 1).trim()
    if (!value) continue
    value = value.replace(/^["']|["']$/g, '')
    if (key === 'tags' || key === 'keywords' || key === 'tag') {
      meta.tags = value
        .replace(/^\[|\]$/g, '')
        .split(/[,，;；\s]+/)
        .map((item) => item.trim())
        .filter(Boolean)
    } else {
      meta[key] = value
    }
  }
  return { meta, body: source.slice(match[0].length) }
}

/** Markdown → 纯文本（用于摘要提取） */
export function plainText(markdown) {
  return String(markdown ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 第一段正文作为摘要兜底 */
function firstParagraph(body) {
  const text = plainText(body)
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  for (const line of lines) {
    if (/^\|?[\s:-]+\|?$/.test(line)) continue // 表格分隔行
    return line.slice(0, 160)
  }
  return ''
}

function stripExt(name) {
  return name.replace(/\.(md|markdown)$/i, '')
}

/**
 * 把一篇 Markdown 文件解析成索引记录（标题 / 摘要 / 分类 / 标题大纲 / 检索块）。
 * 扫描与「保存后单篇重索引」共用，保证两处字段完全一致。
 * @returns {{doc:any, chunks:Array<{heading:string,text:string}>, bodyChars:number}}
 */
export function describeDocument(root, abs, raw, stat) {
  const { meta, body } = parseFrontMatter(raw)
  const relPath = path.relative(root, abs).split(path.sep).join('/')
  const id = stripExt(relPath)
  const docChunks = chunkBody(body)
  const titleFromBody = /^#\s+(.+?)\s*$/m.exec(body)?.[1]?.trim() || ''
  const fileName = stripExt(path.basename(abs))
  const title = (meta.title || titleFromBody || fileName).slice(0, 120)
  const summary = (meta.summary || meta.description || firstParagraph(body)).slice(0, 200)
  const category = meta.category || meta.type || (relPath.includes('/') ? relPath.split('/')[0] : '未分类')
  const headings = docChunks.map((chunk) => chunk.heading).filter(Boolean)
  return {
    doc: {
      id,
      relPath,
      absPath: abs,
      title,
      summary,
      category,
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      updated: meta.updated || meta.date || '',
      size: stat.size,
      mtime: Math.round(stat.mtimeMs),
      headings: [...new Set(headings)],
      chars: body.length,
    },
    chunks: docChunks,
    bodyChars: body.length,
  }
}

/** 词元：ASCII 词 + 中文单字 + 中文二元组（无需分词库，中文召回效果好） */
export function tokenize(text) {
  const lower = norm(text).toLowerCase()
  const tokens = []
  const ascii = /[a-z0-9][a-z0-9_+#.\-]{1,}/g
  let match
  while ((match = ascii.exec(lower)) !== null) tokens.push(match[0])
  const cjk = /[\u3400-\u9fff]+/g
  while ((match = cjk.exec(lower)) !== null) {
    const run = match[0]
    for (let i = 0; i < run.length; i += 1) tokens.push(run[i])
    for (let i = 0; i + 1 < run.length; i += 1) tokens.push(run.slice(i, i + 2))
  }
  return tokens
}

function countOf(haystack, needle) {
  if (!needle) return 0
  let count = 0
  let index = 0
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1
    index += needle.length
  }
  return count
}

function splitLong(text, size) {
  if (text.length <= size) return [text]
  const out = []
  let rest = text
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n\n', size)
    if (cut < size * 0.4) cut = rest.lastIndexOf('\n', size)
    if (cut < size * 0.4) cut = size
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push(rest)
  return out.filter(Boolean)
}

/** 按标题切块，每块不超过约 900 字符；块文本包含标题行，方便检索上下文 */
export function chunkBody(body) {
  const lines = String(body ?? '').split(/\r?\n/)
  const chunks = []
  let heading = ''
  let buffer = []
  const flush = () => {
    const text = buffer.join('\n').trim()
    buffer = []
    if (!text) return
    for (const part of splitLong(text, 900)) chunks.push({ heading, text: part })
  }
  for (const line of lines) {
    const match = /^(#{1,4})\s+(.+?)\s*$/.exec(line)
    if (match) {
      flush()
      heading = match[2].trim()
    }
    buffer.push(line)
  }
  flush()
  return chunks
}

/** 生成一段注入到系统提示里的知识库概览（超出预算时截断） */
export function buildOverviewText(docs, options) {
  const maxDocs = Math.max(1, Number(options?.promptMaxDocs) || 60)
  const maxChars = Math.max(400, Number(options?.promptMaxChars) || 2600)
  const root = String(options?.root ?? '')
  const byCategory = new Map()
  for (const doc of docs) {
    const key = doc.category || '未分类'
    if (!byCategory.has(key)) byCategory.set(key, [])
    byCategory.get(key).push(doc)
  }
  const head = [
    '## 企业知识库（Company knowledge base，可直接编辑）',
    '',
    `本机已挂载公司内部知识库：${root}`,
    `共 ${docs.length} 篇 Markdown 文档。凡是涉及公司概况、产品、价格、流程、政策、客户案例、术语等企业事实的问题，` +
      '先调用 `kb_search` 检索，再用 `kb_read` 读取原文，最后引用文档路径回答；' +
      '不要凭记忆或常识编造企业信息，知识库里没有的内容要明确说明。',
    '',
    '### 知识库编辑规则（必须遵守）',
    '1. 修改直接作用于上述知识库目录里的目标 `.md` 文件；不另存本地副本，不把内容搬到工作区，也不在别处另建一份知识库。',
    '2. 每次新增、修改、删除、重命名文件前，先说明改哪个文件、改什么，并向用户申请许可；用户确认后才可写入。',
    '3. 在面板里保存文档会自动重索引这一篇；其他改动用「重新索引」或 `POST /company-kb/reindex` 刷新，并用 `kb_status` 复核 `docs` 与 `errors`。',
    '4. 遵守知识库 `README.md` 的 front matter 与来源标注规范：官网未披露的信息标【待确认】，不得编造价格、SLA、资质、客户名单。',
    '5. 删除或重命名前确认内容已被替换；需要留备份时放在知识库目录之外（目录内的 `.md` 会被索引进知识库）。',
    '',
    '文档速览（分类 · 标题 — 摘要）：',
  ].join('\n')
  const lines = []
  let used = head.length
  let listed = 0
  const ordered = [...byCategory.keys()].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  outer: for (const category of ordered) {
    for (const doc of byCategory.get(category)) {
      const summary = doc.summary ? ` — ${doc.summary}` : ''
      const line = `- ${category} · ${doc.title}${summary}`
      if (listed >= maxDocs || used + line.length + 1 > maxChars) break outer
      lines.push(line)
      used += line.length + 1
      listed += 1
    }
  }
  const rest = docs.length - listed
  const tail =
    rest > 0
      ? `\n（未列出 ${rest} 篇；需要完整清单时调用 kb_list）`
      : '\n（需要完整清单时调用 kb_list）'
  return `${head}\n${lines.join('\n')}${tail}`
}

// --------------------------------------------------------------- 知识库扫描

/**
 * 扫描知识库目录，返回文档与检索块。纯函数（只读文件系统），便于单元测试。
 * @returns {Promise<{root:string, docs:any[], chunks:any[], chars:number, skipped:number, errors:any[], scanMs:number}>}
 */
export async function scanKnowledgeBase(root, settings = {}) {
  const startedAt = Date.now()
  const extensions = new Set(
    (Array.isArray(settings.extensions) && settings.extensions.length
      ? settings.extensions
      : DEFAULT_EXTENSIONS
    ).map((ext) => String(ext).toLowerCase()),
  )
  const maxFiles = Math.max(1, Number(settings.maxFiles) || 2000)
  const maxFileBytes = Math.max(1024, Number(settings.maxFileBytes) || 400000)
  const files = []
  const errors = []
  let skipped = 0
  let skippedDepth = false

  async function walk(dir, depth) {
    if (files.length >= maxFiles) return
    if (depth > MAX_DEPTH) {
      skippedDepth = true
      return
    }
    let entries
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch (error) {
      errors.push({ path: dir, message: error?.message || String(error) })
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    for (const entry of entries) {
      if (files.length >= maxFiles) return
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      const abs = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        skipped += 1
        continue
      }
      if (entry.isDirectory()) {
        await walk(abs, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (!extensions.has(ext)) continue
      files.push(abs)
    }
  }

  await walk(root, 0)

  const docs = []
  const chunks = []
  let chars = 0
  const concurrency = 8
  let cursor = 0

  async function worker() {
    while (cursor < files.length) {
      const abs = files[cursor]
      cursor += 1
      let stat
      try {
        stat = await fs.promises.stat(abs)
      } catch (error) {
        errors.push({ path: abs, message: error?.message || String(error) })
        continue
      }
      if (!stat.isFile() || stat.size > maxFileBytes) {
        skipped += 1
        continue
      }
      let raw
      try {
        raw = await fs.promises.readFile(abs, 'utf8')
      } catch (error) {
        errors.push({ path: abs, message: error?.message || String(error) })
        continue
      }
      let parsed
      try {
        parsed = describeDocument(root, abs, raw, stat)
      } catch (error) {
        errors.push({ path: abs, message: error?.message || String(error) })
        continue
      }
      const docIndex = docs.length
      docs.push({ ...parsed.doc, docIndex })
      chars += parsed.bodyChars
      for (const chunk of parsed.chunks) {
        chunks.push({
          docIndex,
          heading: chunk.heading,
          text: chunk.text,
          lower: norm(chunk.text).toLowerCase(),
        })
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(files.length, 1)) }, () => worker()))

  // 文档数受上限截断时给出提示
  if (files.length >= maxFiles) {
    errors.push({
      path: root,
      message: `文件数达到上限 ${maxFiles}，剩余文件未索引（可在 settings.json 调大 maxFiles）`,
    })
  }
  if (skippedDepth) {
    errors.push({ path: root, message: `目录层级超过 ${MAX_DEPTH} 层，深层目录未扫描` })
  }
  return { root, docs, chunks, chars, skipped, errors, scanMs: Date.now() - startedAt }
}

// ---------------------------------------------------------------- 检索

const QUERY_WEIGHT = (term) => (/^[\u3400-\u9fff]$/.test(term) ? 0.25 : 1)

export function queryTerms(query) {
  const weights = new Map()
  for (const token of tokenize(query)) {
    if (STOP_WORDS.has(token)) continue
    if (!/^[\w\u3400-\u9fff+#.\-]+$/.test(token)) continue
    const weight = QUERY_WEIGHT(token)
    weights.set(token, Math.max(weights.get(token) || 0, weight))
  }
  return [...weights.entries()].slice(0, 48)
}

function snippetOf(lower, terms) {
  let at = -1
  let needle = ''
  for (const [term] of terms) {
    const index = lower.indexOf(term)
    if (index === -1) continue
    if (at === -1 || index < at) {
      at = index
      needle = term
    }
  }
  if (at === -1) return lower.slice(0, 160).replace(/\s+/g, ' ').trim()
  const start = Math.max(0, at - 70)
  const end = Math.min(lower.length, at + needle.length + 130)
  const text = lower.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${text}${end < lower.length ? '…' : ''}`
}

/** BM25 风格打分（idf + 词频），标题/摘要命中额外加权 */
export function searchIndex(index, query, options = {}) {
  const terms = queryTerms(query)
  if (!terms.length) return []
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 8))
  const category = String(options.category ?? '').trim()
  const chunks = index.chunks
  const docs = index.docs
  const total = chunks.length || 1

  const df = new Map()
  for (const [term] of terms) {
    let seen = 0
    for (const chunk of chunks) {
      if (category) {
        const doc = docs[chunk.docIndex]
        if (!doc || (doc.category || '未分类') !== category) continue
      }
      if (chunk.lower.includes(term)) seen += 1
    }
    df.set(term, seen)
  }

  const scored = []
  for (const chunk of chunks) {
    const doc = docs[chunk.docIndex]
    if (!doc) continue
    if (category && (doc.category || '未分类') !== category) continue
    let score = 0
    for (const [term, weight] of terms) {
      const tf = countOf(chunk.lower, term)
      if (!tf) continue
      const idf = Math.log(1 + total / (1 + (df.get(term) || 0)))
      score += weight * (1 + Math.log(tf)) * idf
      if (term.length >= 2) {
        if (doc.title.toLowerCase().includes(term)) score += weight * idf * 1.6
        if (doc.summary.toLowerCase().includes(term)) score += weight * idf * 0.6
      }
    }
    if (score > 0) scored.push({ chunk, doc, score })
  }
  scored.sort((a, b) => b.score - a.score)

  const results = []
  const seenDoc = new Set()
  for (const hit of scored) {
    if (results.length >= limit) break
    const key = `${hit.doc.id}::${hit.chunk.heading}`
    if (seenDoc.has(key)) continue
    seenDoc.add(key)
    results.push({
      id: hit.doc.id,
      title: hit.doc.title,
      category: hit.doc.category,
      relPath: hit.doc.relPath,
      heading: hit.chunk.heading,
      score: Math.round(hit.score * 1000) / 1000,
      snippet: snippetOf(hit.chunk.lower, terms),
    })
  }
  return results
}

// ------------------------------------------------------------------- 插件

export function apply(ctx) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })

  const settingsFile = SETTINGS_FILE
  const cacheFile = CACHE_FILE

  const readJson = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  }
  const writeJson = (file, value) => {
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, file)
  }

  const settings = { ...DEFAULT_SETTINGS, ...(readJson(settingsFile) || {}) }
  if (!Array.isArray(settings.extensions) || !settings.extensions.length) {
    settings.extensions = [...DEFAULT_EXTENSIONS]
  }
  // 首次部署时允许 IT 通过环境变量预置 NAS 路径
  if (!settings.path && process.env.DSH_COMPANY_KB_PATH) {
    settings.path = String(process.env.DSH_COMPANY_KB_PATH).trim()
  }

  const state = {
    index: null,
    cacheLoaded: false,
    root: { path: '', configured: false, exists: false, error: '', checkedAt: 0, source: 'none' },
    building: false,
    buildStartedAt: 0,
    buildPromise: null,
    lastBuildReason: '',
    lastError: '',
    timer: null,
    disposed: false,
  }
  let promptHandle = null

  // webServer 是可选服务：冷启动时插件可能先于它激活，因此这里记录注册诊断并允许补注册。
  const webDiag = { available: false, registered: false, origin: '', error: '', attempts: 0 }
  let webDisposer = null
  let webRetryTimer = null

  const saveSettings = () => {
    try {
      writeJson(settingsFile, {
        path: settings.path,
        staleMs: settings.staleMs,
        autoRefreshSeconds: settings.autoRefreshSeconds,
        injectPrompt: settings.injectPrompt,
        promptMaxDocs: settings.promptMaxDocs,
        promptMaxChars: settings.promptMaxChars,
        maxDocChars: settings.maxDocChars,
        maxFiles: settings.maxFiles,
        maxFileBytes: settings.maxFileBytes,
        extensions: settings.extensions,
      })
    } catch (error) {
      ctx.logger?.warn?.(`[company-kb] 保存配置失败: ${error?.message ?? error}`)
    }
  }

  const currentRoot = () => String(settings.path || '').trim()

  async function checkRoot(rootPath) {
    if (!rootPath) {
      return { path: '', configured: false, exists: false, error: '尚未配置知识库路径', checkedAt: Date.now(), source: 'none' }
    }
    const source = settings.path ? 'settings' : 'env'
    try {
      const stat = await fs.promises.stat(rootPath)
      if (!stat.isDirectory()) {
        return { path: rootPath, configured: true, exists: false, error: '路径存在但不是文件夹', checkedAt: Date.now(), source }
      }
      await fs.promises.readdir(rootPath)
      return { path: rootPath, configured: true, exists: true, error: '', checkedAt: Date.now(), source }
    } catch (error) {
      const message =
        error?.code === 'ENOENT'
          ? '路径不存在或网络位置未连接（映射盘符需要先登录）'
          : error?.code === 'EACCES'
            ? '没有读取权限'
            : error?.message || String(error)
      return { path: rootPath, configured: true, exists: false, error: message, checkedAt: Date.now(), source }
    }
  }

  function saveCache(index) {
    try {
      writeJson(cacheFile, {
        version: CACHE_VERSION,
        root: index.root,
        builtAt: index.builtAt,
        scanMs: index.scanMs,
        chars: index.chars,
        skipped: index.skipped,
        errors: index.errors.slice(0, 20),
        docs: index.docs,
        // 缓存只存文本，lower 在读取时重算，减小缓存体积
        chunks: index.chunks.map((chunk) => ({ docIndex: chunk.docIndex, heading: chunk.heading, text: chunk.text })),
      })
    } catch (error) {
      ctx.logger?.warn?.(`[company-kb] 写索引缓存失败: ${error?.message ?? error}`)
    }
  }

  function loadCache() {
    if (state.cacheLoaded) return
    state.cacheLoaded = true
    const cached = readJson(cacheFile)
    if (!cached || cached.version !== CACHE_VERSION) return
    if (String(cached.root || '') !== currentRoot()) return
    if (!Array.isArray(cached.docs) || !Array.isArray(cached.chunks)) return
    state.index = {
      root: cached.root,
      builtAt: Number(cached.builtAt) || 0,
      scanMs: Number(cached.scanMs) || 0,
      chars: Number(cached.chars) || 0,
      skipped: Number(cached.skipped) || 0,
      errors: Array.isArray(cached.errors) ? cached.errors : [],
      docs: cached.docs,
      chunks: cached.chunks.map((chunk) => ({
        docIndex: chunk.docIndex,
        heading: chunk.heading,
        text: chunk.text,
        lower: norm(chunk.text).toLowerCase(),
      })),
    }
    state.root = {
      path: cached.root,
      configured: true,
      exists: true,
      error: '',
      checkedAt: Number(cached.builtAt) || 0,
      source: settings.path ? 'settings' : 'env',
    }
    ctx.logger?.info?.(`[company-kb] 已载入索引缓存 ${cached.docs.length} 篇（${cached.root}）`)
  }

  function syncPrompt() {
    const prompt = ctx.get('systemPrompt')
    if (!prompt || typeof prompt.context !== 'function') return
    const should = Boolean(settings.injectPrompt && state.index && state.index.docs.length)
    if (should && !promptHandle) {
      promptHandle = prompt.context({
        name: 'company-kb',
        order: 120,
        required: false,
        text: () => {
          const index = state.index
          if (!index || !index.docs.length) return ''
          return buildOverviewText(index.docs, {
            root: index.root,
            promptMaxDocs: settings.promptMaxDocs,
            promptMaxChars: settings.promptMaxChars,
          })
        },
      })
    } else if (!should && promptHandle) {
      try {
        promptHandle()
      } catch {
        /* ignore */
      }
      promptHandle = null
    }
  }

  async function buildIndex(reason = 'manual') {
    if (state.disposed) return state.index
    if (state.building && state.buildPromise) return state.buildPromise
    state.building = true
    state.buildStartedAt = Date.now()
    state.lastBuildReason = reason
    const rootPath = currentRoot()
    state.buildPromise = (async () => {
      const root = await checkRoot(rootPath)
      state.root = root
      if (!root.exists) {
        state.index = null
        state.lastError = root.error
        syncPrompt()
        return null
      }
      try {
        const scanned = await scanKnowledgeBase(rootPath, settings)
        state.index = {
          root: rootPath,
          builtAt: Date.now(),
          scanMs: scanned.scanMs,
          chars: scanned.chars,
          skipped: scanned.skipped,
          errors: scanned.errors,
          docs: scanned.docs,
          chunks: scanned.chunks,
        }
        state.lastError = ''
        saveCache(state.index)
        ctx.logger?.info?.(
          `[company-kb] 索引完成：${scanned.docs.length} 篇 / ${scanned.chunks.length} 块 / ${scanned.scanMs}ms（${rootPath}）`,
        )
      } catch (error) {
        state.lastError = error?.message || String(error)
        ctx.logger?.warn?.(`[company-kb] 索引失败: ${state.lastError}`)
      }
      syncPrompt()
      return state.index
    })().finally(() => {
      state.building = false
      state.buildStartedAt = 0
      state.buildPromise = null
    })
    return state.buildPromise
  }

  /** 工具调用前保证索引可用：没有索引时等待首建（有上限），索引过期时后台刷新 */
  async function ensureIndex() {
    loadCache()
    if (!state.index && !state.building) {
      void buildIndex('first-use')
    }
    if (!state.index && state.buildPromise) {
      await Promise.race([
        state.buildPromise,
        new Promise((resolve) => setTimeout(resolve, Math.max(1000, Number(settings.waitMs) || 15000))),
      ])
    } else if (state.index && Date.now() - state.index.builtAt > Number(settings.staleMs || 0) && !state.building) {
      void buildIndex('stale')
    }
    return state.index
  }

  const docsSummary = (limit = 300) =>
    (state.index?.docs ?? []).slice(0, limit).map((doc) => ({
      id: doc.id,
      title: doc.title,
      summary: doc.summary,
      category: doc.category,
      relPath: doc.relPath,
      size: doc.size,
      mtime: doc.mtime,
    }))

  function statusBody() {
    const index = state.index
    return {
      ok: true,
      plugin: { name: PLUGIN_NAME, version: VERSION, title: TITLE },
      updatedAt: Date.now(),
      root: { ...state.root },
      index: {
        docs: index?.docs.length ?? 0,
        chunks: index?.chunks.length ?? 0,
        chars: index?.chars ?? 0,
        lastIndexAt: index?.builtAt ?? null,
        lastScanMs: index?.scanMs ?? 0,
        building: state.building,
        skipped: index?.skipped ?? 0,
        errors: (index?.errors ?? []).slice(0, 20),
      },
      docs: docsSummary(500),
      settings: {
        path: settings.path,
        staleMs: settings.staleMs,
        autoRefreshSeconds: settings.autoRefreshSeconds,
        injectPrompt: settings.injectPrompt,
        promptMaxDocs: settings.promptMaxDocs,
        promptMaxChars: settings.promptMaxChars,
      },
      lastError: state.lastError,
      web: { ...webDiag },
    }
  }

  // ------------------------------------------------------------------ 工具

  const textResult = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  const outputSchema = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => textResult(value) }

  const tools = [
    {
      name: 'kb_status',
      description:
        '查看企业知识库状态：NAS 路径是否可用、已索引文档数、最近索引时间、扫描错误。回答涉及公司/产品信息前可先确认知识库可用。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: outputSchema,
      async execute() {
        loadCache()
        if (!state.index && !state.building && currentRoot()) void buildIndex('status')
        const body = statusBody()
        return {
          ok: true,
          configured: body.root.configured,
          path: body.root.path,
          pathAvailable: body.root.exists,
          rootError: body.root.error,
          docs: body.index.docs,
          chunks: body.index.chunks,
          lastIndexAt: body.index.lastIndexAt,
          lastScanMs: body.index.lastScanMs,
          building: body.index.building,
          skipped: body.index.skipped,
          errors: body.index.errors.slice(0, 5),
          webRoutes: webDiag.registered,
          webOrigin: webDiag.origin || '',
          webError: webDiag.error || '',
          webAttempts: webDiag.attempts,
          hint:
            !body.root.configured
              ? '知识库尚未配置：请打开 DSH 设置 → 企业知识库，填入 NAS 上的知识库文件夹路径。'
              : !body.root.exists
                ? '知识库路径当前不可用，请检查 NAS 连接、映射盘符或共享权限。'
                : body.index.docs === 0
                  ? '知识库目录可用但还没有索引到 Markdown 文档。'
                  : '',
        }
      },
    },
    {
      name: 'kb_search',
      description:
        '在企业知识库中检索（中文/英文关键词均可）。返回命中的文档 id、标题、分类、章节与摘要片段；随后用 kb_read 读取原文。涉及公司、产品、价格、流程、政策等企业事实的问题应先检索。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词，可包含多个关键词或一句话' },
          limit: { type: 'number', description: '返回条数，默认 8，最大 30' },
          category: { type: 'string', description: '可选：只在该分类（一级目录名）中检索' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: outputSchema,
      timeoutMs: 30000,
      async execute(args) {
        const query = String(args?.query ?? '').trim()
        if (!query) return { ok: false, error: 'query 不能为空' }
        const index = await ensureIndex()
        if (!state.root.configured) {
          return { ok: false, error: '知识库尚未配置', hint: '请打开 DSH 设置 → 企业知识库，填入 NAS 路径。' }
        }
        if (!index) {
          return {
            ok: false,
            error: state.building ? '知识库首次索引构建中，请稍后重试' : state.lastError || '知识库不可用',
            path: state.root.path,
          }
        }
        const hits = searchIndex(index, query, {
          limit: Number(args?.limit) || 8,
          category: String(args?.category ?? '').trim(),
        })
        return {
          ok: true,
          query,
          total: hits.length,
          docsIndexed: index.docs.length,
          results: hits,
          hint: hits.length ? '用 kb_read 读取命中文档的完整内容后再回答。' : '没有命中：可换关键词，或用 kb_list 查看目录结构。',
        }
      },
    },
    {
      name: 'kb_read',
      description:
        '读取企业知识库中某篇 Markdown 文档的原文。id 取自 kb_search / kb_list 的返回（相对路径，不带 .md）。长文档可用 offset 继续读取。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '文档 id，例如「10-产品/星链助手-功能说明」' },
          offset: { type: 'number', description: '起始字符偏移，默认 0' },
          maxChars: { type: 'number', description: '最多返回字符数，默认 20000，最大 60000' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      output: outputSchema,
      timeoutMs: 30000,
      async execute(args) {
        const wanted = String(args?.id ?? '').trim().replace(/\\/g, '/')
        if (!wanted) return { ok: false, error: 'id 不能为空' }
        const index = await ensureIndex()
        if (!index) {
          return { ok: false, error: state.building ? '知识库首次索引构建中，请稍后重试' : state.lastError || '知识库不可用' }
        }
        const normalizeId = (value) => value.replace(/\.(md|markdown)$/i, '').replace(/^\.?\//, '')
        const target = normalizeId(wanted).toLowerCase()
        const doc =
          index.docs.find((item) => item.id.toLowerCase() === target) ||
          index.docs.find((item) => item.relPath.toLowerCase() === target) ||
          index.docs.find((item) => item.id.toLowerCase().endsWith(`/${target}`))
        if (!doc) {
          const suggestions = index.docs
            .filter((item) => item.id.toLowerCase().includes(target) || item.title.toLowerCase().includes(target))
            .slice(0, 5)
            .map((item) => item.id)
          return {
            ok: false,
            error: `未找到文档：${wanted}`,
            suggestions,
            hint: suggestions.length ? '是否为其中之一？' : '先用 kb_search 或 kb_list 找到正确的 id。',
          }
        }
        let raw
        try {
          raw = await fs.promises.readFile(doc.absPath, 'utf8')
        } catch (error) {
          return { ok: false, error: `读取文档失败：${error?.message || error}`, id: doc.id, path: doc.absPath }
        }
        const text = raw.replace(/^\uFEFF/, '')
        const offset = Math.max(0, Number(args?.offset) || 0)
        const maxChars = Math.max(500, Math.min(60000, Number(args?.maxChars) || Number(settings.maxDocChars) || 20000))
        const slice = text.slice(offset, offset + maxChars)
        return {
          ok: true,
          id: doc.id,
          title: doc.title,
          category: doc.category,
          relPath: doc.relPath,
          tags: doc.tags,
          updated: doc.updated,
          chars: text.length,
          offset,
          returned: slice.length,
          truncated: offset + slice.length < text.length,
          nextOffset: offset + slice.length < text.length ? offset + slice.length : null,
          text: slice,
        }
      },
    },
    {
      name: 'kb_list',
      description:
        '列出企业知识库的文档目录（分类 + 标题 + 一句话摘要），可按分类过滤。用于先了解知识库有什么，再决定检索词。',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', description: '可选：只看某个分类（一级目录名）' },
          limit: { type: 'number', description: '最多返回条数，默认 100，最大 500' },
        },
        additionalProperties: false,
      },
      output: outputSchema,
      timeoutMs: 30000,
      async execute(args) {
        const index = await ensureIndex()
        if (!index) {
          return { ok: false, error: state.building ? '知识库首次索引构建中，请稍后重试' : state.lastError || '知识库不可用' }
        }
        const wanted = String(args?.category ?? '').trim()
        const limit = Math.max(1, Math.min(500, Number(args?.limit) || 100))
        const groups = new Map()
        for (const doc of index.docs) {
          const category = doc.category || '未分类'
          if (wanted && category !== wanted) continue
          if (!groups.has(category)) groups.set(category, [])
          groups.get(category).push({ id: doc.id, title: doc.title, summary: doc.summary, updated: doc.updated })
        }
        const categories = [...groups.keys()].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
        let budget = limit
        const result = []
        for (const category of categories) {
          if (budget <= 0) break
          const docs = groups.get(category)
          const taken = docs.slice(0, budget)
          budget -= taken.length
          result.push({ category, count: docs.length, docs: taken })
        }
        return {
          ok: true,
          total: index.docs.length,
          shown: result.reduce((sum, group) => sum + group.docs.length, 0),
          categories: result,
          hint: '用 kb_search 检索关键词，或 kb_read 读取某篇文档。',
        }
      },
    },
  ]

  for (const tool of tools) {
    try {
      ctx.effect(() => ctx.tools.register(tool))
    } catch (error) {
      ctx.logger?.warn?.(`[company-kb] 注册工具 ${tool.name} 失败: ${error?.message ?? error}`)
    }
  }

  // --------------------------------------------------- Host service（供其他插件）
  if (typeof ctx.provide === 'function') {
    ctx.effect(() =>
      ctx.provide('companyKb', {
        version: VERSION,
        status: () => statusBody(),
        search: async (query, options) => {
          const index = await ensureIndex()
          if (!index) return []
          return searchIndex(index, String(query ?? ''), options || {})
        },
        read: async (id, options) => {
          const result = await tools[2].execute({ id, ...(options || {}) })
          return result
        },
        list: async (options) => {
          const result = await tools[3].execute(options || {})
          return result
        },
        reindex: async () => {
          await buildIndex('service')
          return statusBody()
        },
      }),
    )
  }

  // ------------------------------------------------------------- HTTP 路由
  // webServer 是可选服务，可能比本插件晚激活（冷启动）：先尝试注册，未就绪则轮询补注册。
  const sendJson = (res, value, status = 200) => {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }
  const readBody = (req, limit = 65536) =>
    new Promise((resolve, reject) => {
      let raw = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        raw += chunk
        if (raw.length > limit) {
          reject(new Error('request body too large'))
          req.destroy()
        }
      })
      req.on('end', () => resolve(raw))
      req.on('error', reject)
    })

  // ------------------------------------------------------ 单篇文档读写（面板编辑）
  // 安全边界：只允许知识库根目录内的 Markdown；解析后校验真实路径（防 .. 与软链逃逸）；
  // 写入先落临时文件再 rename，写前比对 mtime，别人改过就报 409 不覆盖。
  const editError = (message, code = 'BAD_REQUEST', status = 400) => {
    const error = new Error(message)
    error.code = code
    error.status = status
    return error
  }
  const maxEditBytes = () => Math.max(1024, Number(settings.maxFileBytes) || 400000)

  function resolveEntryPath(input, options = {}) {
    const rootPath = currentRoot()
    if (!rootPath) throw editError('知识库尚未配置：请先在「设置 → 企业知识库」里填写路径', 'NOT_CONFIGURED', 400)
    const rootAbs = path.resolve(rootPath)
    let rel = String(input ?? '').trim()
    if (!rel) {
      if (options.allowRoot) return { relPath: '', abs: rootAbs, rootAbs }
      throw editError('路径不能为空', 'BAD_PATH', 400)
    }
    if (rel.includes('\u0000')) throw editError('路径包含非法字符', 'BAD_PATH', 400)
    rel = rel.replace(/\\/g, '/')
    if (path.posix.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
      throw editError('只支持知识库内的相对路径', 'BAD_PATH', 400)
    }
    const normalized = path.posix.normalize(rel)
    if (normalized === '.' || normalized.startsWith('../') || normalized.startsWith('/')) {
      throw editError('路径越界', 'BAD_PATH', 400)
    }
    const abs = path.resolve(rootAbs, normalized.split('/').join(path.sep))
    const within = path.relative(rootAbs, abs)
    if (!within || within.startsWith('..') || path.isAbsolute(within)) {
      throw editError('路径越界', 'BAD_PATH', 400)
    }
    return { relPath: normalized, abs, rootAbs }
  }

  function resolveDocPath(input) {
    const resolved = resolveEntryPath(input)
    const extensions = (Array.isArray(settings.extensions) && settings.extensions.length
      ? settings.extensions
      : DEFAULT_EXTENSIONS
    ).map((ext) => String(ext).toLowerCase())
    if (!extensions.includes(path.extname(resolved.relPath).toLowerCase())) {
      throw editError('只允许编辑 Markdown 文件', 'BAD_EXTENSION', 400)
    }
    return resolved
  }

  async function statDocFile(resolved) {
    let stat
    try {
      stat = await fs.promises.lstat(resolved.abs)
    } catch (error) {
      if (error?.code === 'ENOENT') throw editError('文档不存在（可能已被移动或删除）', 'NOT_FOUND', 404)
      throw editError(`读取文档信息失败：${error?.message || error}`, 'STAT_FAILED', 500)
    }
    if (stat.isSymbolicLink() || !stat.isFile()) throw editError('目标不是普通文档文件', 'BAD_PATH', 400)
    // 真实路径复核：软链接 / 8.3 短名 / 大小写差异都不能逃出根目录
    try {
      const realRoot = await fs.promises.realpath(resolved.rootAbs)
      const realAbs = await fs.promises.realpath(resolved.abs)
      const within = path.relative(realRoot, realAbs)
      if (!within || within.startsWith('..') || path.isAbsolute(within)) throw new Error('outside')
    } catch {
      throw editError('文档路径越界', 'BAD_PATH', 400)
    }
    return stat
  }

  async function readDocForEdit(input) {
    const resolved = resolveDocPath(input)
    const stat = await statDocFile(resolved)
    if (stat.size > maxEditBytes()) {
      throw editError(`文件 ${stat.size} 字节，超过在线编辑上限 ${maxEditBytes()} 字节`, 'TOO_LARGE', 413)
    }
    const raw = await fs.promises.readFile(resolved.abs, 'utf8')
    return {
      relPath: resolved.relPath,
      abs: resolved.abs,
      text: raw.replace(/^\uFEFF/, ''),
      mtime: Math.round(stat.mtimeMs),
      size: stat.size,
    }
  }

  async function writeDocForEdit(input, text, baseMtime) {
    const resolved = resolveDocPath(input)
    const stat = await statDocFile(resolved)
    const value = String(text ?? '')
    const bytes = Buffer.byteLength(value, 'utf8')
    if (bytes > maxEditBytes()) {
      throw editError(`内容 ${bytes} 字节，超过在线编辑上限 ${maxEditBytes()} 字节`, 'TOO_LARGE', 413)
    }
    if (baseMtime !== undefined && baseMtime !== null && baseMtime !== '') {
      const seen = Number(baseMtime)
      if (Number.isFinite(seen) && Math.abs(stat.mtimeMs - seen) > 2000) {
        throw editError('文件已被其他人修改，已阻止覆盖；请重新打开文档确认最新内容', 'CONFLICT', 409)
      }
    }
    const dir = path.dirname(resolved.abs)
    const tmp = path.join(dir, `.${path.basename(resolved.abs)}.${process.pid}.${Date.now()}.tmp`)
    try {
      await fs.promises.writeFile(tmp, value, 'utf8')
    } catch (error) {
      throw editError(`写入失败：${error?.message || error}`, 'WRITE_FAILED', 500)
    }
    try {
      await fs.promises.rename(tmp, resolved.abs)
    } catch {
      // 部分 SMB / 网络盘不允许 rename 覆盖已存在文件：退回直接写入
      await fs.promises.unlink(tmp).catch(() => {})
      try {
        await fs.promises.writeFile(resolved.abs, value, 'utf8')
      } catch (error) {
        throw editError(`写入失败：${error?.message || error}`, 'WRITE_FAILED', 500)
      }
    }
    const next = await fs.promises.stat(resolved.abs)
    return { relPath: resolved.relPath, abs: resolved.abs, mtime: Math.round(next.mtimeMs), size: next.size, bytes }
  }

  /** 保存后只重索引这一篇，避免每次保存都整盘重扫 NAS */
  async function reindexSingleDoc(relPath) {
    const index = state.index
    if (!index) return false
    if (path.resolve(String(index.root || '')) !== path.resolve(currentRoot())) return false
    const resolved = resolveDocPath(relPath)
    const stat = await fs.promises.stat(resolved.abs)
    const raw = await fs.promises.readFile(resolved.abs, 'utf8')
    const parsed = describeDocument(index.root, resolved.abs, raw, stat)
    const at = index.docs.findIndex((doc) => doc.relPath === parsed.doc.relPath)
    const nextChunks = parsed.chunks.map((chunk) => ({
      heading: chunk.heading,
      text: chunk.text,
      lower: norm(chunk.text).toLowerCase(),
    }))
    if (at === -1) {
      const docIndex = index.docs.length
      index.docs.push({ ...parsed.doc, docIndex })
      index.chunks.push(...nextChunks.map((chunk) => ({ docIndex, ...chunk })))
    } else {
      const prev = index.docs[at]
      index.chars += (Number(parsed.doc.chars) || 0) - (Number(prev && prev.chars) || 0)
      index.docs[at] = { ...parsed.doc, docIndex: at }
      index.chunks = index.chunks.filter((chunk) => chunk.docIndex !== at)
      index.chunks.push(...nextChunks.map((chunk) => ({ docIndex: at, ...chunk })))
    }
    index.builtAt = Date.now()
    index.errors = (index.errors || []).filter(
      (item) => !String((item && (item.path || item.relPath)) || '').replace(/\\/g, '/').endsWith(parsed.doc.relPath),
    )
    saveCache(index)
    syncPrompt()
    return true
  }

  // ------------------------------------------------ 文件 / 文件夹管理
  const ENTRY_NAME_RE = /^[^<>:"/\\|?*\u0000-\u001f]+$/

  function validateEntryName(raw) {
    const name = String(raw ?? '').trim()
    if (!name) throw editError('名称不能为空', 'BAD_NAME', 400)
    if (name.length > 100) throw editError('名称过长（最多 100 字符）', 'BAD_NAME', 400)
    if (name === '.' || name === '..' || name.startsWith('.')) throw editError('名称不能以 . 开头', 'BAD_NAME', 400)
    if (!ENTRY_NAME_RE.test(name)) throw editError('名称包含 Windows 不允许的字符（< > : " / \\ | ? *）', 'BAD_NAME', 400)
    if (/[. ]$/.test(name)) throw editError('名称不能以空格或点结尾', 'BAD_NAME', 400)
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) throw editError('该名称是 Windows 保留名', 'BAD_NAME', 400)
    return name
  }

  async function ensureRealInsideRoot(resolved) {
    try {
      const realRoot = await fs.promises.realpath(resolved.rootAbs)
      const realTarget = await fs.promises.realpath(resolved.abs)
      const within = path.relative(realRoot, realTarget)
      if (!within || within.startsWith('..') || path.isAbsolute(within)) throw new Error('outside')
    } catch {
      throw editError('路径越界', 'BAD_PATH', 400)
    }
  }

  async function requireDirectory(resolved) {
    let stat
    try {
      stat = await fs.promises.lstat(resolved.abs)
    } catch {
      throw editError('文件夹不存在', 'NOT_FOUND', 404)
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw editError('目标不是文件夹', 'BAD_PATH', 400)
    await ensureRealInsideRoot(resolved)
  }

  /** 新建文件夹 / 新建文档 / 重命名 / 删除；路径与名称都在根目录内校验 */
  async function fsAction(payload) {
    const action = String(payload?.action || '')
    if (action === 'mkdir' || action === 'create-doc') {
      const parent = resolveEntryPath(payload?.dir ?? '', { allowRoot: true })
      await requireDirectory(parent)
      let name = validateEntryName(payload?.name)
      if (action === 'create-doc' && !/\.(md|markdown)$/i.test(name)) name = `${name}.md`
      const targetAbs = path.join(parent.abs, name)
      const targetRel = parent.relPath ? `${parent.relPath}/${name}` : name
      if (action === 'mkdir') {
        try {
          await fs.promises.mkdir(targetAbs)
        } catch (error) {
          if (error?.code === 'EEXIST') throw editError('同名文件或文件夹已存在', 'EXISTS', 409)
          throw editError(`新建文件夹失败：${error?.message || error}`, 'FS_FAILED', 500)
        }
        return { relPath: targetRel, kind: 'dir' }
      }
      const title = name.replace(/\.(md|markdown)$/i, '')
      const category = parent.relPath ? parent.relPath.split('/')[0] : '未分类'
      const today = new Date().toISOString().slice(0, 10)
      const content = `---\ntitle: ${title}\nsummary: 【待补充】\ncategory: ${category}\ntags: \nupdated: ${today}\n---\n\n# ${title}\n\n`
      try {
        await fs.promises.writeFile(targetAbs, content, { encoding: 'utf8', flag: 'wx' })
      } catch (error) {
        if (error?.code === 'EEXIST') throw editError('同名文档已存在', 'EXISTS', 409)
        throw editError(`新建文档失败：${error?.message || error}`, 'FS_FAILED', 500)
      }
      return { relPath: targetRel, kind: 'doc' }
    }
    if (action === 'rename') {
      const source = resolveEntryPath(payload?.path)
      let stat
      try {
        stat = await fs.promises.lstat(source.abs)
      } catch {
        throw editError('目标不存在', 'NOT_FOUND', 404)
      }
      if (stat.isSymbolicLink()) throw editError('不支持操作软链接', 'BAD_PATH', 400)
      await ensureRealInsideRoot(source)
      let name = validateEntryName(payload?.newName)
      if (stat.isFile() && !path.extname(name)) {
        const ext = path.extname(source.abs)
        if (ext) name = `${name}${ext}`
      }
      const targetAbs = path.join(path.dirname(source.abs), name)
      const targetRel = path.posix.join(path.posix.dirname(source.relPath), name)
      if (targetAbs === source.abs) return { relPath: source.relPath }
      let exists = true
      try {
        await fs.promises.lstat(targetAbs)
      } catch (error) {
        if (error?.code === 'ENOENT') exists = false
        else throw editError(`检查目标失败：${error?.message || error}`, 'FS_FAILED', 500)
      }
      if (exists) throw editError('同名文件或文件夹已存在', 'EXISTS', 409)
      try {
        await fs.promises.rename(source.abs, targetAbs)
      } catch (error) {
        throw editError(`重命名失败：${error?.message || error}`, 'FS_FAILED', 500)
      }
      return { relPath: targetRel, previous: source.relPath }
    }
    if (action === 'delete') {
      const target = resolveEntryPath(payload?.path)
      let stat
      try {
        stat = await fs.promises.lstat(target.abs)
      } catch {
        throw editError('目标不存在', 'NOT_FOUND', 404)
      }
      if (stat.isSymbolicLink()) throw editError('不支持操作软链接', 'BAD_PATH', 400)
      await ensureRealInsideRoot(target)
      if (stat.isDirectory()) {
        if (payload?.recursive === true) {
          await fs.promises.rm(target.abs, { recursive: true, force: false })
        } else {
          try {
            await fs.promises.rmdir(target.abs)
          } catch (error) {
            if (error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST') {
              throw editError('文件夹非空，需要再次确认递归删除', 'NOT_EMPTY', 409)
            }
            throw editError(`删除文件夹失败：${error?.message || error}`, 'FS_FAILED', 500)
          }
        }
      } else {
        await fs.promises.unlink(target.abs)
      }
      return { relPath: target.relPath, kind: stat.isDirectory() ? 'dir' : 'file' }
    }
    throw editError('未知操作', 'BAD_ACTION', 400)
  }

  // ------------------------------------------------------ 第三方编辑器静态资源
  // Toast UI Editor（MIT）随插件放在 vendor/ 下，浏览器从同源 /company-kb/vendor/* 加载，
  // 不依赖 CDN，内网离线可用。
  const VENDOR_TYPES = {
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
    '.json': 'application/json; charset=utf-8',
  }
  async function serveVendor(req, res, url) {
    let rel = ''
    try {
      rel = decodeURIComponent(url.pathname.slice('/company-kb/vendor/'.length))
    } catch {
      return sendJson(res, { ok: false, error: 'invalid path' }, 400)
    }
    const normalized = path.posix.normalize(String(rel).replace(/\\/g, '/'))
    if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.startsWith('/') || normalized.includes('\u0000')) {
      return sendJson(res, { ok: false, error: 'invalid path' }, 400)
    }
    const abs = path.resolve(VENDOR_DIR, normalized.split('/').join(path.sep))
    const within = path.relative(VENDOR_DIR, abs)
    if (!within || within.startsWith('..') || path.isAbsolute(within)) {
      return sendJson(res, { ok: false, error: 'invalid path' }, 400)
    }
    const type = VENDOR_TYPES[path.extname(abs).toLowerCase()]
    if (!type) return sendJson(res, { ok: false, error: 'unsupported asset' }, 400)
    let stat
    let data
    try {
      stat = await fs.promises.stat(abs)
      if (!stat.isFile()) throw new Error('not a file')
      data = await fs.promises.readFile(abs)
    } catch {
      return sendJson(res, { ok: false, error: 'asset not found' }, 404)
    }
    const etag = `W/"${stat.size}-${Math.round(stat.mtimeMs)}"`
    if (String(req.headers['if-none-match'] || '') === etag) {
      res.writeHead(304, { etag, 'cache-control': 'public, max-age=86400' })
      res.end()
      return
    }
    res.writeHead(200, {
      'content-type': type,
      'content-length': data.length,
      'cache-control': 'public, max-age=86400',
      etag,
    })
    res.end(data)
  }

  const registerWebRoutes = () => {
    if (webDisposer) return true
    const web = ctx.get('webServer')
    webDiag.available = Boolean(web && typeof web.register === 'function')
    if (!webDiag.available) return false
    webDiag.attempts += 1
    try {
      webDiag.origin = (() => {
        try {
          return web.getOrigin?.() || ''
        } catch {
          return ''
        }
      })()
    } catch {
      webDiag.origin = ''
    }
    try {
      webDisposer = web.register({
        kind: 'prefix',
        path: '/company-kb',
        handler: async (req, res) => {
          try {
            const url = new URL(req.url || '/', 'http://127.0.0.1')
            const method = (req.method || 'GET').toUpperCase()
            if (method === 'GET' && url.pathname === '/company-kb/status') {
              loadCache()
              if (!state.index && !state.building && currentRoot()) void buildIndex('status')
              return sendJson(res, statusBody())
            }
            // 读单篇原文（面板编辑器打开文档）
            if (method === 'GET' && url.pathname === '/company-kb/doc') {
              try {
                const file = await readDocForEdit(url.searchParams.get('path') || '')
                return sendJson(res, {
                  ok: true,
                  path: file.relPath,
                  text: file.text,
                  chars: file.text.length,
                  mtime: file.mtime,
                  size: file.size,
                })
              } catch (error) {
                return sendJson(
                  res,
                  { ok: false, error: error?.message || String(error), code: error?.code || 'ERROR' },
                  Number(error?.status) || 400,
                )
              }
            }
            // 第三方编辑器静态资源（vendor/，同源离线加载）
            if (method === 'GET' && url.pathname.startsWith('/company-kb/vendor/')) {
              return serveVendor(req, res, url)
            }
            if (method === 'POST') {
              const originHeader = req.headers.origin || ''
              const ownOrigin = webDiag.origin
              if (originHeader && ownOrigin && !originHeader.startsWith(ownOrigin) && !originHeader.startsWith('http://127.0.0.1')) {
                return sendJson(res, { ok: false, error: 'cross-origin request refused' }, 403)
              }
              let body = {}
              try {
                // 保存文档可能远大于 64KB，按路由放宽请求体上限
                const limit = url.pathname === '/company-kb/doc/save' ? 6 * 1024 * 1024 : 65536
                body = JSON.parse((await readBody(req, limit)) || '{}')
              } catch {
                return sendJson(res, { ok: false, error: 'invalid json' }, 400)
              }
              // 保存单篇原文
              if (url.pathname === '/company-kb/doc/save') {
                try {
                  const saved = await writeDocForEdit(body.path, body.text, body.baseMtime)
                  let reindexed = false
                  try {
                    reindexed = await reindexSingleDoc(saved.relPath)
                  } catch (error) {
                    ctx.logger?.warn?.(`[company-kb] 保存后重索引失败: ${error?.message ?? error}`)
                  }
                  if (!reindexed && !state.building && currentRoot()) void buildIndex('save')
                  return sendJson(res, {
                    ok: true,
                    path: saved.relPath,
                    mtime: saved.mtime,
                    size: saved.size,
                    bytes: saved.bytes,
                    savedAt: Date.now(),
                    reindexed,
                    status: statusBody(),
                  })
                } catch (error) {
                  return sendJson(
                    res,
                    { ok: false, error: error?.message || String(error), code: error?.code || 'ERROR' },
                    Number(error?.status) || 400,
                  )
                }
              }
              // 新建文件夹 / 新建文档 / 重命名 / 删除
              if (url.pathname === '/company-kb/fs') {
                try {
                  const result = await fsAction(body)
                  await buildIndex('fs')
                  return sendJson(res, { ok: true, ...result, status: statusBody() })
                } catch (error) {
                  return sendJson(
                    res,
                    { ok: false, error: error?.message || String(error), code: error?.code || 'ERROR' },
                    Number(error?.status) || 400,
                  )
                }
              }
              if (url.pathname === '/company-kb/settings') {
                const nextPath = String(body.path ?? '').trim()
                if (nextPath) {
                  const check = await checkRoot(nextPath)
                  if (!check.exists) return sendJson(res, { ok: false, error: check.error, status: statusBody() }, 400)
                }
                settings.path = nextPath
                saveSettings()
                state.index = null
                state.lastError = ''
                syncPrompt()
                if (nextPath) await buildIndex('settings')
                return sendJson(res, { ok: true, status: statusBody() })
              }
              if (url.pathname === '/company-kb/reindex') {
                await buildIndex('manual')
                return sendJson(res, { ok: true, status: statusBody() })
              }
              return sendJson(res, { ok: false, error: 'unknown route' }, 404)
            }
            res.writeHead(405, { allow: 'GET, POST', 'content-type': 'text/plain; charset=utf-8' })
            res.end('method not allowed')
          } catch (error) {
            ctx.logger?.warn?.(`[company-kb] http handler failed: ${error?.message ?? error}`)
            if (res.headersSent) {
              res.destroy()
              return
            }
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: error?.message || String(error) }))
          }
        },
      })
      webDiag.registered = true
      webDiag.error = ''
      if (webRetryTimer) {
        clearInterval(webRetryTimer)
        webRetryTimer = null
      }
      ctx.logger?.info?.(`[company-kb] HTTP 路由 /company-kb 已注册（origin=${webDiag.origin || 'unknown'}）`)
      return true
    } catch (error) {
      webDiag.registered = false
      webDiag.error = error?.message || String(error)
      ctx.logger?.warn?.(`[company-kb] 注册 HTTP 路由失败: ${webDiag.error}`)
      return false
    }
  }

  if (!registerWebRoutes()) {
    // 最多等 60 秒（120 × 500ms），等服务出现后补注册
    let tries = 0
    webRetryTimer = setInterval(() => {
      tries += 1
      if (registerWebRoutes()) return
      if (tries >= 120) {
        clearInterval(webRetryTimer)
        webRetryTimer = null
        ctx.logger?.warn?.('[company-kb] webServer 60 秒内未就绪，设置页接口不可用')
      }
    }, 500)
    if (typeof webRetryTimer.unref === 'function') webRetryTimer.unref()
  }
  ctx.effect(() => () => {
    if (webRetryTimer) {
      clearInterval(webRetryTimer)
      webRetryTimer = null
    }
    if (webDisposer) {
      try {
        webDisposer()
      } catch {
        /* ignore */
      }
      webDisposer = null
      webDiag.registered = false
    }
  })

  // ---------------------------------------------------------------- 生命周期
  ctx.effect(() => {
    loadCache()
    if (currentRoot()) {
      // 启动时先服务缓存，再后台刷新，避免 NAS 慢导致启动卡顿
      void buildIndex('startup')
    }
    if (Number(settings.autoRefreshSeconds) > 0) {
      state.timer = setInterval(() => {
        if (!state.building && currentRoot()) void buildIndex('timer')
      }, Math.max(60, Number(settings.autoRefreshSeconds)) * 1000)
      if (typeof state.timer.unref === 'function') state.timer.unref()
    }
    return () => {
      state.disposed = true
      if (state.timer) clearInterval(state.timer)
      if (promptHandle) {
        try {
          promptHandle()
        } catch {
          /* ignore */
        }
        promptHandle = null
      }
    }
  })

  ctx.logger?.info?.(
    `[company-kb] ready（data=${DATA_DIR}, root=${currentRoot() || '未配置'}, docs=${state.index?.docs.length ?? 0}）`,
  )
}

/** 供本地自测/自动化验证使用，不参与运行时逻辑 */
export const __test__ = {
  parseFrontMatter,
  plainText,
  tokenize,
  chunkBody,
  buildOverviewText,
  describeDocument,
  scanKnowledgeBase,
  searchIndex,
  DEFAULT_SETTINGS,
}

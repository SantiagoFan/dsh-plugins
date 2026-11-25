import path from 'node:path'
import fs from 'node:fs/promises'
import { githubUrls, isMonorepo } from './config.mjs'
import { writeText } from './util.mjs'

const SCOPE_PREFIX_RE = /@[a-z0-9][a-z0-9._-]*\/$/
const REPO_URL_PREFIX_RE = /(?:github\.com|gitlab\.com|bitbucket\.org)(?::[0-9]+)?\/[A-Za-z0-9._-]+\/$/

/** 该处出现是否属于「已带 scope 的包名」或「GitHub 仓库地址里的仓库名」，这些不该被当旧包名替换。 */
function isForeignContext(before) {
  return SCOPE_PREFIX_RE.test(before) || REPO_URL_PREFIX_RE.test(before)
}

/** 需要改的名字对：当前包名（若非规范名）以及配置里声明的旧包名残渣。 */
export function renamePairs(model) {
  const pairs = []
  const current = model.pkg?.name
  if (current && current !== model.expectedName) pairs.push({ from: current, to: model.expectedName })
  const renamedFrom = model.spec?.renamedFrom
  if (renamedFrom && renamedFrom !== current && renamedFrom !== model.expectedName) {
    pairs.push({ from: renamedFrom, to: model.expectedName })
  }
  return pairs
}

/** 替换 from，但跳过已经是 @scope/from 形态的片段，避免把新名字改成 @scope/@scope/x。 */
function replaceOutsideExpected(text, from, to) {
  let out = ''
  let cursor = 0
  for (;;) {
    const index = text.indexOf(from, cursor)
    if (index === -1) {
      out += text.slice(cursor)
      return out
    }
    const before = text.slice(Math.max(0, index - 80), index)
    out += text.slice(cursor, index)
    out += isForeignContext(before) ? from : to
    cursor = index + from.length
  }
}

export function countStale(text, from) {
  let count = 0
  let cursor = 0
  for (;;) {
    const index = text.indexOf(from, cursor)
    if (index === -1) return count
    if (!isForeignContext(text.slice(Math.max(0, index - 120), index))) count += 1
    cursor = index + from.length
  }
}

export function replaceStale(text, pair) {
  return replaceOutsideExpected(text, pair.from, pair.to)
}

const JSON_ANCHORS = {
  private: 'version',
  publishConfig: 'private',
  author: 'license',
  license: 'author',
  repository: 'keywords',
  homepage: 'repository',
  bugs: 'homepage',
  engines: 'bugs',
  exports: 'engines',
}

function mergeOrdered(original, additions) {
  const byKey = new Map(additions.map((item) => [item.key, item]))
  const keys = Object.keys(original)
  for (const item of additions) {
    if (keys.includes(item.key)) continue
    const anchor = item.anchor || JSON_ANCHORS[item.key]
    const index = anchor ? keys.indexOf(anchor) : -1
    if (index >= 0) keys.splice(index + 1, 0, item.key)
    else keys.push(item.key)
  }
  const result = {}
  for (const key of keys) {
    const addition = byKey.get(key)
    result[key] = addition ? addition.value : original[key]
  }
  return result
}

function jsonEdits(model, findings) {
  const fixes = new Set(findings.filter((f) => f.fixable && f.fix && f.fix !== 'rename' && f.fix !== 'patch').map((f) => f.fix))
  if (fixes.size === 0) return null
  const { pkg, config, spec } = model
  const urls = githubUrls(config, spec)
  const additions = []

  if (fixes.has('private')) {
    additions.push({ key: 'private', value: spec.publish ? false : true })
  }
  if (fixes.has('publishConfig')) {
    additions.push({ key: 'publishConfig', value: { ...(pkg.publishConfig || {}), access: 'public' } })
  }
  if (fixes.has('author') && !pkg.author) additions.push({ key: 'author', value: config.author || '' })
  if (fixes.has('license') && !pkg.license) additions.push({ key: 'license', value: config.license || 'MIT' })
  if (fixes.has('repository')) {
    const urls2 = githubUrls(config, spec)
    const value = isMonorepo(config)
      ? { type: 'git', url: urls2.repository, directory: urls2.directory }
      : { type: 'git', url: urls2.repository }
    additions.push({ key: 'repository', value })
  }
  if (fixes.has('homepage')) additions.push({ key: 'homepage', value: urls.homepage })
  if (fixes.has('bugs')) additions.push({ key: 'bugs', value: { ...(pkg.bugs || {}), url: urls.bugs } })
  if (fixes.has('engines') && !pkg.engines?.node) {
    additions.push({ key: 'engines', value: { ...(pkg.engines || {}), node: config.defaultEngines } })
  }
  if (fixes.has('exports') && !pkg.exports?.['.']) {
    additions.push({
      key: 'exports',
      value: pkg.exports ? { ...pkg.exports, '.': './index.js' } : { '.': './index.js', './client': './client.js', './locale/*.json': './locale/*.json', './icon': './icon.svg' },
    })
  }
  if (fixes.has('dsh.bundle.patch') && !pkg.dsh?.bundle?.patch) {
    additions.push({
      key: 'dsh',
      value: { ...(pkg.dsh || {}), bundle: { ...(pkg.dsh?.bundle || {}), patch: './cordis.patch.yml' } },
    })
  }
  if (fixes.has('keywords')) {
    const keywords = Array.isArray(pkg.keywords) ? [...pkg.keywords] : []
    if (!keywords.includes('dsh-plugin')) {
      keywords.unshift('dsh-plugin')
      additions.push({ key: 'keywords', value: keywords })
    }
  }
  if (additions.length === 0) return null
  const merged = mergeOrdered(pkg, additions)
  const before = JSON.stringify(pkg, null, 2)
  const after = `${JSON.stringify(merged, null, 2)}\n`
  return {
    model,
    additions: additions.map((item) => item.key),
    edit: {
      file: model.pkgPath,
      rel: 'package.json',
      kind: 'json',
      before,
      after,
      summary: `补充字段：${additions.map((item) => item.key).join(', ')}`,
    },
  }
}

function renameBlockReason(model, options) {
  const { pkg, spec } = model
  const reasons = []
  if (spec.publish && model.npm?.exists && model.npm.name !== model.expectedName) {
    reasons.push(`旧包名 ${pkg.name} 已在 npm 发布过 ${model.npm.version}，改名等于另发一个新包`)
  }
  if (options.profileText && options.profileText.includes(pkg.name)) {
    reasons.push(`DSH profile 里引用了 ${pkg.name}`)
  }
  return reasons
}

export async function planFix(model, findings, options = {}) {
  const edits = []
  const skipped = []

  const wantsRename = findings.some((f) => f.fixable && f.fix === 'rename')
  const pairs = wantsRename ? renamePairs(model) : []
  if (pairs.length > 0) {
    const reasons = renameBlockReason(model, options)
    if (reasons.length > 0 && !options.force) {
      skipped.push({ what: 'rename', reasons })
    } else {
      const touched = []
      for (const file of model.textFiles) {
        let after = file.text
        const parts = []
        for (const pair of pairs) {
          const count = countStale(after, pair.from)
          if (count === 0) continue
          after = replaceStale(after, pair)
          parts.push(`${pair.from} → ${pair.to}（${count} 处）`)
        }
        if (after === file.text) continue
        touched.push({
          file: file.path,
          rel: file.rel,
          kind: 'rename',
          before: file.text,
          after,
          summary: parts.join('；'),
        })
      }
      edits.push(...touched)
    }
  }

  const json = jsonEdits(model, findings)
  if (json) {
    const renameEdit = edits.find((edit) => edit.file === json.edit.file)
    if (renameEdit) {
      // 同一文件既要改名又要补字段：在改名后的文本上再做 JSON 修补
      const relativeFindings = findings.filter((f) => f.fixable && f.fix !== 'rename')
      let renamedPkg
      try {
        renamedPkg = JSON.parse(renameEdit.after.replace(/^\uFEFF/, ''))
      } catch {
        renamedPkg = null
      }
      if (renamedPkg) {
        const nested = jsonEdits({ ...model, pkg: renamedPkg }, relativeFindings)
        if (nested) {
          renameEdit.after = nested.edit.after
          renameEdit.summary = `${renameEdit.summary}；${nested.edit.summary}`
        }
      }
    } else {
      edits.push(json.edit)
    }
  }

  return { edits, skipped }
}

export async function applyEdits(edits, { log = () => {} } = {}) {
  const written = []
  for (const edit of edits) {
    if (edit.before === edit.after) continue
    if (edit.kind === 'json' || /package\.json$/i.test(edit.file)) {
      JSON.parse(edit.after)
    }
    await writeText(edit.file, edit.after)
    written.push(edit.rel || path.basename(edit.file))
    log(`  写入 ${edit.rel || edit.file}`)
  }
  return written
}

/** Update "`pkg` v1.2.3" style version references in docs, targeted by package name. */
export async function bumpDocVersions(model, oldVersion, newVersion) {
  const changed = []
  const name = model.pkg?.name
  if (!name) return changed
  for (const file of model.textFiles) {
    if (!/\.(md|txt)$/i.test(file.path)) continue
    if (!file.text.includes(name) || !file.text.includes(`v${oldVersion}`)) continue
    const lines = file.text.split(/\r?\n/)
    let touched = false
    const next = lines.map((line) => {
      if (!line.includes(name) || !line.includes(`v${oldVersion}`)) return line
      touched = true
      return line.split(`v${oldVersion}`).join(`v${newVersion}`)
    })
    if (!touched) continue
    const after = next.join(file.text.includes('\r\n') ? '\r\n' : '\n')
    if (after === file.text) continue
    await fs.writeFile(file.path, after, 'utf8')
    changed.push({ rel: file.rel, file: file.path })
  }
  return changed
}

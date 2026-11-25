import fs from 'node:fs/promises'
import fssync from 'node:fs'
import path from 'node:path'

export async function pathExists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export function pathExistsSync(p) {
  try {
    fssync.accessSync(p)
    return true
  } catch {
    return false
  }
}

export async function readJson(file) {
  const raw = await fs.readFile(file, 'utf8')
  try {
    return JSON.parse(raw)
  } catch (error) {
    const err = new Error(`${file} 不是合法 JSON：${error.message}`)
    err.cause = error
    throw err
  }
}

export async function readText(file) {
  return fs.readFile(file, 'utf8')
}

export async function writeText(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text, 'utf8')
}

export function lineOf(text, index) {
  if (index < 0) return 0
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1
  }
  return line
}

export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Minimal semver: returns -1 | 0 | 1, or null when unparsable. */
export function compareSemver(a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return null
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1
  }
  return 0
}

export function parseSemver(version) {
  if (typeof version !== 'string') return null
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function bumpSemver(version, kind) {
  const parts = parseSemver(version)
  if (!parts) return null
  const [major, minor, patch] = parts
  if (kind === 'major') return `${major + 1}.0.0`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`
  return null
}

export function toKebab(text) {
  return String(text)
    .replace(/[_\s]+/g, '-')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'vendor', '.cache', 'coverage', 'test-results'])
export const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.ts', '.txt'])

/** Recursively collect text files, skipping heavy/irrelevant directories. */
export async function collectTextFiles(dir, base = dir) {
  const out = []
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      out.push(...(await collectTextFiles(abs, base)))
      continue
    }
    if (!entry.isFile()) continue
    if (entry.name === 'package-lock.json' || entry.name === 'pnpm-lock.yaml') continue
    if (!TEXT_EXT.has(path.extname(entry.name).toLowerCase())) continue
    out.push(abs)
  }
  return out
}

export async function findUp(startDir, fileName) {
  let dir = path.resolve(startDir)
  for (;;) {
    const candidate = path.join(dir, fileName)
    if (pathExistsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

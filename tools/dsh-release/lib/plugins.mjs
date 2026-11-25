import path from 'node:path'
import fs from 'node:fs/promises'
import { expectedName, githubUrls, findRepoRoot } from './config.mjs'
import { collectTextFiles, lineOf, pathExists, readJson, readText } from './util.mjs'
import { readGitInfo, repoSlugFromRemote } from './git.mjs'
import { npmView } from './registry.mjs'

const NAME_PATCH_RE = /^\s*-?\s*name:\s*['"]?([^'"\s#]+)['"]?\s*$/gm

export function extractPatchNames(patchText) {
  const names = []
  if (!patchText) return names
  NAME_PATCH_RE.lastIndex = 0
  let match
  while ((match = NAME_PATCH_RE.exec(patchText)) !== null) {
    names.push({ name: match[1], line: lineOf(patchText, match.index) })
  }
  return names
}

export function findOccurrences(files, needle) {
  const occurrences = []
  for (const file of files) {
    const text = file.text
    let index = text.indexOf(needle)
    while (index !== -1) {
      occurrences.push({ file: file.path, line: lineOf(text, index), snippet: snippetAt(text, index) })
      index = text.indexOf(needle, index + needle.length)
    }
  }
  return occurrences
}

function snippetAt(text, index) {
  const start = text.lastIndexOf('\n', index) + 1
  const end = text.indexOf('\n', index)
  const line = text.slice(start, end === -1 ? undefined : end).trim()
  return line.length > 160 ? `${line.slice(0, 157)}...` : line
}

async function checkGithubRepo(slug) {
  if (!slug) return { state: 'skipped' }
  try {
    const response = await fetch(`https://api.github.com/repos/${slug}`, {
      headers: { 'user-agent': 'dsh-release', accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(6000),
    })
    if (response.status === 404) return { state: 'missing', status: 404 }
    if (!response.ok) return { state: 'unknown', status: response.status }
    const body = await response.json()
    return { state: 'exists', status: 200, defaultBranch: body.default_branch, private: body.private }
  } catch (error) {
    return { state: 'unknown', error: error.message }
  }
}

export async function loadPlugin(config, spec, { online = true, registry } = {}) {
  const dirAbs = spec.dirAbs
  const model = {
    config,
    spec,
    dir: spec.dir,
    dirAbs,
    expectedName: expectedName(config, spec),
    expectedRepoSlug: config.owner ? `${config.owner}/${githubUrls(config, spec).repo}` : null,
    pkg: null,
    pkgPath: path.join(dirAbs, 'package.json'),
    pkgExists: false,
    patchPath: null,
    patchNames: [],
    readmePath: null,
    textFiles: [],
    occurrences: [],
    git: { isRepo: false },
    npm: { name: null, exists: false, skipped: true },
    gh: { state: 'skipped' },
    fatal: null,
  }

  if (!(await pathExists(dirAbs))) {
    model.fatal = `目录不存在：${dirAbs}`
    return model
  }
  if (!(await pathExists(model.pkgPath))) {
    model.fatal = `缺少 package.json：${model.pkgPath}`
    return model
  }

  model.pkgExists = true
  model.pkg = await readJson(model.pkgPath)

  const patchRel = model.pkg?.dsh?.bundle?.patch
  const patchCandidate = patchRel ? path.resolve(dirAbs, patchRel) : path.join(dirAbs, 'cordis.patch.yml')
  if (await pathExists(patchCandidate)) {
    model.patchPath = patchCandidate
    model.patchNames = extractPatchNames(await readText(patchCandidate))
  }

  const readmeCandidate = path.join(dirAbs, 'README.md')
  if (await pathExists(readmeCandidate)) model.readmePath = readmeCandidate

  const filePaths = await collectTextFiles(dirAbs)
  model.textFiles = []
  for (const filePath of filePaths) {
    try {
      const text = await fs.readFile(filePath, 'utf8')
      model.textFiles.push({ path: filePath, rel: path.relative(dirAbs, filePath), text })
    } catch {
      /* 非 UTF-8 或不可读，跳过 */
    }
  }
  if (typeof model.pkg?.name === 'string' && model.pkg.name) {
    model.occurrences = findOccurrences(model.textFiles, model.pkg.name)
  }

  model.git = (() => {
    const repoRoot = findRepoRoot(dirAbs)
    if (!repoRoot) return { isRepo: false }
    const info = readGitInfo(repoRoot)
    if (!info.isRepo) return { isRepo: false }
    return {
      ...info,
      root: repoRoot,
      relDir: path.relative(repoRoot, dirAbs).split(path.sep).join('/') || '.',
    }
  })()
  model.git.slug = repoSlugFromRemote(model.git.remote)
  if (model.git.isRepo) {
    const relDir = model.git.relDir
    const prefix = relDir && relDir !== '.' ? `${relDir}/` : ''
    const all = model.git.dirty || []
    model.git.pkgDirty = prefix ? all.filter((line) => line.slice(3).trim().replace(/"/g, '').startsWith(prefix)) : all
  }

  if (online && typeof model.pkg?.name === 'string' && model.pkg.name) {
    model.npm = { ...npmView(model.pkg.name, { cwd: dirAbs, ...registry }), skipped: false }
    model.npmExpected = { ...npmView(model.expectedName, { cwd: dirAbs, ...registry }), skipped: false }
    model.gh = await checkGithubRepo(model.expectedRepoSlug)
  }

  return model
}

export async function loadPlugins(config, { online = true, registry } = {}) {
  const models = []
  for (const spec of config.plugins) {
    models.push(await loadPlugin(config, spec, { online, registry }))
  }
  return models
}

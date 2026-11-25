import fs from 'node:fs/promises'
import { git } from './git.mjs'
import { npmPublish, npmWhoami } from './registry.mjs'
import { bumpDocVersions } from './fix.mjs'
import { bumpSemver, parseSemver } from './util.mjs'
import { packageShortName, releaseTag } from './config.mjs'

function step(name, ok, detail = '') {
  return { name, ok, detail }
}

export function computeVersion(current, { bump = 'patch', version = null }) {
  if (version) {
    const parsed = parseSemver(version)
    if (!parsed) throw new Error(`--version 不是合法 semver：${version}`)
    if (parseSemver(current) && version === current) throw new Error(`--version 与当前版本相同（${current}）`)
    return version
  }
  const next = bumpSemver(current, bump)
  if (!next) throw new Error(`无法从 ${current} bump（${bump}）`)
  return next
}

export function buildCommitMessage(template, { tag, version, shortName, fullName }) {
  return String(template)
    .replace(/\{tag\}/g, tag)
    .replace(/\{version\}/g, version)
    .replace(/\{name\}/g, shortName)
    .replace(/\{fullName\}/g, fullName)
}

async function replaceVersionInPackageJson(model, oldVersion, newVersion) {
  const text = await fs.readFile(model.pkgPath, 'utf8')
  const pattern = new RegExp(`("version"\\s*:\\s*)"${oldVersion.replace(/\./g, '\\.')}"`)
  if (!pattern.test(text)) throw new Error(`在 package.json 里没找到 "version": "${oldVersion}"，请手工确认`)
  const next = text.replace(pattern, `$1"${newVersion}"`)
  JSON.parse(next)
  await fs.writeFile(model.pkgPath, next, 'utf8')
}

export async function runRelease(model, options, io) {
  const { log, warn } = io
  const findings = options.findings || []
  const errors = findings.filter((item) => item.level === 'error')
  const steps = []

  if (errors.length > 0) {
    warn('存在阻塞发布的校验错误，先跑 fix/手工修好：')
    for (const error of errors) warn(`  ${error.code}  ${error.message}`)
    return { ok: false, applied: false, steps }
  }

  const current = model.pkg.version
  let next
  try {
    next = computeVersion(current, options)
  } catch (error) {
    warn(error.message)
    return { ok: false, applied: false, steps }
  }

  if (!model.git.isRepo || !model.git.root) {
    warn('找不到包含本包的 git 仓库：先 git init（或在 monorepo 根初始化），再发布')
    return { ok: false, applied: false, steps }
  }
  if (!model.git.remote) {
    warn('git 没有 origin remote：先 git remote add origin <url>')
    return { ok: false, applied: false, steps }
  }
  const dirty = model.git.pkgDirty || model.git.dirty
  if (dirty.length > 0 && !options.allowDirty) {
    warn(`本包有 ${dirty.length} 个未提交改动（用 --allow-dirty 连同本次发布一起提交）：`)
    for (const line of dirty.slice(0, 10)) warn(`  ${line}`)
    return { ok: false, applied: false, steps }
  }

  const tag = releaseTag(model.config, model.spec, next)
  const shortName = packageShortName(model.expectedName)
  const commitMessage = buildCommitMessage(model.config.commitMessage, {
    tag,
    version: next,
    shortName,
    fullName: model.expectedName,
  })
  const registry = { cwd: model.dirAbs, registry: model.config.registry, cache: model.config.npmCache }
  const gitRoot = model.git.root
  const relDir = model.git.relDir && model.git.relDir !== '.' ? model.git.relDir : '.'

  log(`\n发布计划：${model.pkg.name}${model.config.monorepo ? `（monorepo: ${model.git.slug}）` : ''}`)
  log(`  版本      ${current} → ${next}`)
  log(`  提交      ${commitMessage}`)
  log(`  路径      ${relDir}${relDir === '.' ? '' : `（仓库根 ${gitRoot}）`}`)
  log(`  标签      ${tag}${model.git.tags.includes(tag) ? '  ⚠ 该 tag 已存在' : ''}`)
  log(`  推送      ${options.noPush ? '跳过' : `origin ${model.git.branch || model.config.defaultBranch}`}`)
  log(`  发布      ${options.viaCi ? '由 tag 触发的 GitHub Actions 完成' : `npm publish（registry: ${model.config.registry || '默认'}）`}`)

  if (!options.yes) {
    warn('\n这是预演。加 --yes 才会真正执行。')
    return { ok: true, applied: false, steps }
  }
  if (model.git.tags.includes(tag)) {
    warn(`tag ${tag} 已存在，请换版本或删除旧 tag`)
    return { ok: false, applied: false, steps }
  }

  await replaceVersionInPackageJson(model, current, next)
  steps.push(step('version', true, `${current} → ${next}`))
  const docChanged = await bumpDocVersions(model, current, next)
  for (const doc of docChanged) log(`  同步文档版本号：${doc.rel}`)

  const add = git(gitRoot, ['add', '--', relDir])
  steps.push(step('git add', add.ok, add.ok ? relDir : add.stderr))
  if (!add.ok) return { ok: false, applied: true, steps }

  const commit = git(gitRoot, ['commit', '-m', commitMessage])
  steps.push(step('git commit', commit.ok, commit.ok ? commit.stdout.split('\n')[0] : commit.stderr))
  if (!commit.ok) return { ok: false, applied: true, steps }

  const tagging = git(gitRoot, ['tag', '-a', tag, '-m', commitMessage])
  steps.push(step('git tag', tagging.ok, tagging.ok ? tag : tagging.stderr))
  if (!tagging.ok) return { ok: false, applied: true, steps }

  if (!options.noPush) {
    const push = git(gitRoot, ['push', 'origin', 'HEAD'], { timeout: 180000 })
    steps.push(step('git push', push.ok, push.ok ? push.stdout.split('\n').slice(-1)[0] : push.stderr))
    if (push.ok) {
      const pushTag = git(gitRoot, ['push', 'origin', tag], { timeout: 180000 })
      steps.push(step('git push tag', pushTag.ok, pushTag.ok ? tag : pushTag.stderr))
    }
  }

  if (!options.viaCi) {
    const who = npmWhoami(registry)
    if (!who.ok) {
      warn(`npm 未登录或 token 失效：${who.error || ''}`)
      steps.push(step('npm whoami', false, who.error || 'not logged in'))
      return { ok: false, applied: true, steps }
    }
    log(`  npm 身份：${who.user}`)
    const publish = npmPublish({ ...registry, access: model.pkg.publishConfig?.access || 'public' })
    steps.push(step('npm publish', publish.status === 0, `${publish.stdout}\n${publish.stderr}`.trim()))
    if (publish.status !== 0) return { ok: false, applied: true, steps }
  } else {
    steps.push(step('npm publish', true, '交给 CI（tag 推送已触发）'))
  }

  return { ok: true, applied: true, steps }
}

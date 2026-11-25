import path from 'node:path'
import { pathExists, parseSemver, compareSemver } from './util.mjs'
import { githubUrls, expectedRepo, isMonorepo, latestTagFor, tagVersion } from './config.mjs'
import { countStale, renamePairs } from './fix.mjs'

const NAME_RE = /^@[a-z0-9][a-z0-9._-]*\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*$/

function finding(level, code, message, extra = {}) {
  return { level, code, message, ...extra }
}

function rel(model, abs) {
  return abs ? path.relative(model.dirAbs, abs) || path.basename(abs) : undefined
}

async function checkFilesEntries(model, findings) {
  const files = model.pkg?.files
  if (!Array.isArray(files) || files.length === 0) {
    findings.push(finding('warn', 'FILES_MISSING', 'package.json 缺少 files 白名单，npm 会把整个目录打进包里', {
      file: 'package.json',
      fixable: true,
      fix: 'files',
    }))
    return
  }
  const forbidden = ['.env', 'id_rsa', '.pem', '.key', 'node_modules']
  for (const entry of files) {
    if (typeof entry !== 'string') continue
    if (forbidden.some((needle) => entry.includes(needle))) {
      findings.push(finding('error', 'FILES_FORBIDDEN', `files 白名单包含敏感/冗余路径：${entry}`, {
        file: 'package.json',
      }))
    }
    const wildcard = entry.includes('*')
    const exists = wildcard || (await pathExists(path.resolve(model.dirAbs, entry)))
    if (!exists) {
      findings.push(finding('warn', 'FILES_ENTRY_MISSING', `files 白名单条目在磁盘上不存在：${entry}`, {
        file: 'package.json',
      }))
    }
  }
}

async function checkPublishFields(model, findings) {
  const { pkg, spec } = model
  if (!spec.publish) {
    if (pkg.private !== true) {
      findings.push(finding('warn', 'PRIVATE_NOT_SET', '不发布的包建议 private: true，防止误发 npm', {
        file: 'package.json',
        fixable: true,
        fix: 'private',
      }))
    }
    return
  }
  if (pkg.private === true) {
    findings.push(finding('error', 'PRIVATE_PUBLISH_CONFLICT', '配置为发布，但 package.json 里 private: true，npm 会拒绝发布', {
      file: 'package.json',
      fixable: true,
      fix: 'private',
    }))
  }
  if (pkg.publishConfig?.access !== 'public') {
    findings.push(finding('error', 'ACCESS_NOT_PUBLIC', 'scoped 包首发必须 publishConfig.access = "public"', {
      file: 'package.json',
      fixable: true,
      fix: 'publishConfig',
    }))
  }
  const urls = githubUrls(model.config, spec)
  const monorepo = isMonorepo(model.config)
  const target = monorepo ? `${urls.slug} 的 ${urls.directory}` : urls.slug
  if (!pkg.repository?.url) {
    findings.push(finding('error', 'REPO_FIELD_MISSING', `缺少 repository 字段（应为 ${target}），npm 页面会失去源码链接`, {
      file: 'package.json',
      fixable: true,
      fix: 'repository',
    }))
  } else {
    const declared = /github\.com[/:]([^/]+\/[^/#?]+?)(?:\.git)?(?:[#?].*)?$/.exec(pkg.repository.url)
    const declaredSlug = declared ? declared[1] : null
    if (declaredSlug && declaredSlug !== urls.slug) {
      findings.push(finding('warn', 'REPO_NAME_MISMATCH', `repository 指向 ${declaredSlug}，配置期望 ${urls.slug}`, {
        file: 'package.json',
        fixable: true,
        fix: 'repository',
      }))
    }
    if (monorepo && pkg.repository.directory !== urls.directory) {
      findings.push(finding('warn', 'REPO_DIRECTORY_MISMATCH', `repository.directory 应为 "${urls.directory}"，当前是 ${JSON.stringify(pkg.repository.directory ?? null)}`, {
        file: 'package.json',
        fixable: true,
        fix: 'repository',
      }))
    }
    if (declaredSlug && model.git.slug && model.git.slug !== declaredSlug) {
      findings.push(finding('warn', 'REPO_REMOTE_MISMATCH', `本地 git remote 是 ${model.git.slug}，repository 写的是 ${declaredSlug}`, {
        file: 'package.json',
      }))
    }
  }
  if (!pkg.homepage) {
    findings.push(finding('warn', 'HOMEPAGE_MISSING', `缺少 homepage（应为 ${urls.homepage}）`, {
      file: 'package.json',
      fixable: true,
      fix: 'homepage',
    }))
  } else if (monorepo && pkg.homepage !== urls.homepage) {
    findings.push(finding('warn', 'HOMEPAGE_MISMATCH', `homepage 指向旧仓库地址（应为 ${urls.homepage}）`, {
      file: 'package.json',
      fixable: true,
      fix: 'homepage',
    }))
  }
  if (!pkg.bugs?.url) {
    findings.push(finding('warn', 'BUGS_MISSING', `缺少 bugs（应为 ${urls.bugs}）`, {
      file: 'package.json',
      fixable: true,
      fix: 'bugs',
    }))
  } else if (monorepo && pkg.bugs.url !== urls.bugs) {
    findings.push(finding('warn', 'BUGS_MISMATCH', `bugs 指向旧仓库地址（应为 ${urls.bugs}）`, {
      file: 'package.json',
      fixable: true,
      fix: 'bugs',
    }))
  }
}

function checkNaming(model, findings) {
  const { pkg } = model
  if (!pkg.name) {
    findings.push(finding('error', 'NAME_MISSING', 'package.json 缺少 name', { file: 'package.json' }))
    return
  }
  const expected = model.expectedName
  if (pkg.name === expected) {
    if (!NAME_RE.test(pkg.name)) {
      findings.push(finding('warn', 'NAME_UNCONVENTIONAL', `包名 ${pkg.name} 能对上配置，但不符合 @scope/dsh-kebab-case 形态`, {
        file: 'package.json',
      }))
    }
    return
  }
  const level = NAME_RE.test(pkg.name) ? 'warn' : 'error'
  findings.push(finding(level, 'NAME_SLUG_MISMATCH', `包名 ${pkg.name} 应为 ${expected}`, {
    file: 'package.json',
    fixable: true,
    fix: 'rename',
    expected,
  }))
}

function checkPatch(model, findings) {
  const { patchNames, patchPath } = model
  if (!patchPath) {
    findings.push(finding('error', 'PATCH_MISSING', '找不到 cordis.patch.yml，bundle 无法被 DSH 加载', {
      file: 'cordis.patch.yml',
    }))
    return
  }
  const relPatch = rel(model, patchPath)
  if (patchNames.length === 0) {
    findings.push(finding('error', 'PATCH_NO_NAME', `${relPatch} 里没有 name: 行`, { file: relPatch }))
    return
  }
  if (patchNames.length > 1) {
    findings.push(finding('warn', 'PATCH_MULTI_NAME', `${relPatch} 里有 ${patchNames.length} 个 name，改名脚本会全部替换，请确认都是本插件`, {
      file: relPatch,
    }))
  }
  for (const entry of patchNames) {
    if (entry.name !== model.pkg?.name) {
      findings.push(finding('error', 'PATCH_NAME_MISMATCH', `${relPatch}:${entry.line} 写的是 ${entry.name}，与 package.json 的 ${model.pkg?.name} 不一致`, {
        file: `${relPatch}:${entry.line}`,
        fixable: true,
        fix: 'patch',
      }))
    }
  }
}

function checkManifest(model, findings) {
  const { pkg, spec } = model
  const patchField = pkg.dsh?.bundle?.patch
  if (!patchField) {
    findings.push(finding('error', 'DSH_PATCH_FIELD', 'package.json 缺少 dsh.bundle.patch，DSH 不会把它当 bundle', {
      file: 'package.json',
      fixable: true,
      fix: 'dsh.bundle.patch',
    }))
  } else if (!model.patchPath) {
    findings.push(finding('error', 'DSH_PATCH_FILE', `dsh.bundle.patch 指向 ${patchField}，但文件不存在`, { file: 'package.json' }))
  }
  if (!pkg.exports || !pkg.exports['.']) {
    findings.push(finding('warn', 'EXPORTS_MISSING', 'package.json 缺少 exports["."]，加载器会回退到 main', {
      file: 'package.json',
      fixable: true,
      fix: 'exports',
    }))
  }
  if (!pkg.engines?.node) {
    findings.push(finding('warn', 'ENGINES_MISSING', `缺少 engines.node（建议 ${model.config.defaultEngines}）`, {
      file: 'package.json',
      fixable: true,
      fix: 'engines',
    }))
  }
  if (!pkg.author && spec.publish) {
    findings.push(finding('warn', 'AUTHOR_MISSING', '发布包建议补 author', {
      file: 'package.json',
      fixable: true,
      fix: 'author',
    }))
  }
  if (!pkg.license) {
    findings.push(finding('warn', 'LICENSE_MISSING', '缺少 license', {
      file: 'package.json',
      fixable: true,
      fix: 'license',
    }))
  }
  const keywords = Array.isArray(pkg.keywords) ? pkg.keywords : []
  if (!keywords.includes('dsh-plugin')) {
    findings.push(finding('info', 'KEYWORDS_NO_DSH', 'keywords 里没有 "dsh-plugin"，npm 搜索会漏掉', {
      file: 'package.json',
      fixable: true,
      fix: 'keywords',
    }))
  }
  if (!pkg.version || !parseSemver(pkg.version)) {
    findings.push(finding('error', 'VERSION_INVALID', `version 不是合法 semver：${pkg.version}`, { file: 'package.json' }))
  }
}

function checkVersionState(model, findings) {
  const { pkg, npm, npmExpected, git, spec } = model
  if (!pkg.version || !parseSemver(pkg.version)) return

  if (npm?.exists && npm.version) {
    const cmp = compareSemver(pkg.version, npm.version)
    if (cmp === 1) {
      findings.push(finding('warn', 'NPM_AHEAD', `本地 ${pkg.version} 高于 npm 上的 ${npm.version}：发布后才会同步，注意别重复发同一版本`, {}))
    } else if (cmp === -1) {
      findings.push(finding('error', 'NPM_BEHIND', `本地 ${pkg.version} 低于 npm 上的 ${npm.version}：先 npm view 拉最新或提升版本，否则 publish 必失败`, {}))
    }
  }
  if (npmExpected?.exists && npmExpected.name !== npm.name) {
    findings.push(finding('error', 'TARGET_NAME_TAKEN', `目标包名 ${npmExpected.name} 已在 npm 上存在（${npmExpected.version}），不能直接改名过去`, {}))
  }
  if (npm?.exists && npmExpected && !npmExpected.exists && npm.name !== npmExpected.name) {
    findings.push(finding('info', 'RENAME_PUBLISHES_NEW', `改名后是全新包名 ${npmExpected.name}，旧包 ${npm.name} 需 npm deprecate 引导`, {}))
  }
  if (git.isRepo && git.tags.length > 0) {
    const latestTag = latestTagFor(model.config, spec, git.tags)
    if (latestTag) {
      const latest = tagVersion(model.config, spec, latestTag)
      if (compareSemver(latest, pkg.version) !== 0) {
        findings.push(finding('info', 'TAG_DRIFT', `最新 tag ${latestTag} 与 package.json ${pkg.version} 不一致（下次发布前的正常状态）`, {}))
      }
    }
  }
  if (spec.publish && !git.isRepo) {
    findings.push(finding('error', 'GIT_MISSING', '要发布的插件必须位于 git 仓库内（从本目录向上找不到 .git）', {}))
  }
  if (spec.publish && git.isRepo && !git.remote) {
    findings.push(finding('error', 'GIT_REMOTE_MISSING', 'git 仓库没有 origin remote', {}))
  }
}

function checkStaleReferences(model, findings) {
  const pairs = renamePairs(model)
  if (pairs.length === 0) return
  for (const pair of pairs) {
    const touched = []
    let total = 0
    for (const file of model.textFiles) {
      const count = countStale(file.text, pair.from)
      if (count === 0) continue
      total += count
      touched.push(`${file.rel || path.basename(file.path)}×${count}`)
    }
    if (total === 0) continue
    const level = pair.from === model.pkg?.name ? 'error' : 'warn'
    findings.push(
      finding(level, pair.from === model.pkg?.name ? 'NAME_PENDING_RENAME' : 'OLD_NAME_LEFTOVER', `文件名/代码里仍写着旧包名 ${pair.from}（${total} 处：${touched.join('、')}），改名时必须全部同步，否则模块 id 与测试会不一致`, {
        fixable: true,
        fix: 'rename',
      }),
    )
  }
}

function checkGithub(model, findings) {
  const { gh, spec } = model
  if (!spec.publish || !model.config.owner) return
  if (gh.state === 'missing') {
    findings.push(finding('error', 'GITHUB_REPO_404', `GitHub 仓库 ${model.expectedRepoSlug} 不存在，npm 的 repository 会变成死链；先建仓再发布`, {}))
  } else if (gh.state === 'unknown') {
    findings.push(finding('info', 'GITHUB_UNKNOWN', `无法校验 GitHub 仓库 ${model.expectedRepoSlug}${gh.error ? `（${gh.error}）` : ''}`, {}))
  }
}

function checkProfileReference(model, findings, profileText) {
  if (!profileText) return
  const oldName = model.pkg?.name
  if (!oldName || oldName === model.expectedName) return
  if (!profileText.includes(oldName)) return
  findings.push(
    finding('warn', 'PROFILE_REFERENCES_OLD_NAME', `DSH profile 里引用了旧包名 ${oldName}，改名后需同步 profile 并重装插件`, {}),
  )
}

export async function validatePlugin(model, ctx = {}) {
  const findings = [...(model.findings || [])]
  if (model.fatal) {
    findings.push(finding('error', 'FATAL', model.fatal))
    return findings
  }
  if (model.spec.note) findings.push(finding('info', 'NOTE', model.spec.note))
  try {
    checkNaming(model, findings)
    checkPatch(model, findings)
    checkManifest(model, findings)
    await checkPublishFields(model, findings)
    checkVersionState(model, findings)
    checkStaleReferences(model, findings)
    checkGithub(model, findings)
    checkProfileReference(model, findings, ctx.profileText)
    await checkFilesEntries(model, findings)
  } catch (error) {
    findings.push(finding('error', 'VALIDATE_THREW', `校验过程异常：${error.message}`))
  }
  return findings
}

export function summarize(findings) {
  const counts = { error: 0, warn: 0, info: 0 }
  for (const item of findings) counts[item.level] = (counts[item.level] || 0) + 1
  return counts
}

export function expectedRepoName(model) {
  return expectedRepo(model.config, model.spec)
}

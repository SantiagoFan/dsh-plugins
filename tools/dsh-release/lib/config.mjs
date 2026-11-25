import path from 'node:path'
import fs from 'node:fs'
import { findUp, readJson } from './util.mjs'

const CONFIG_NAME = 'dsh-release.config.json'

export function packageShortName(name) {
  return String(name || '').replace(/^@[^/]+\//, '')
}

export function expectedName(config, plugin) {
  return `${config.scope}/${config.prefix}${plugin.slug}`
}

export function isMonorepo(config) {
  return Boolean(config.monorepo && config.monorepo.repo)
}

export function expectedRepo(config, plugin) {
  if (isMonorepo(config)) return config.monorepo.repo
  return plugin.repo || `${config.prefix}${plugin.slug}`
}

/** 包在仓库里的相对目录（POSIX 风格），用于 package.json 的 repository.directory。 */
export function repoDirectory(config, plugin) {
  const rel = path.relative(config.repoRoot, plugin.dirAbs)
  return rel.split(path.sep).join('/')
}

export function githubUrls(config, plugin) {
  const repo = expectedRepo(config, plugin)
  const slug = `${config.owner}/${repo}`
  return {
    repo,
    slug,
    directory: repoDirectory(config, plugin),
    web: `https://github.com/${slug}`,
    repository: `git+https://github.com/${slug}.git`,
    homepage: `https://github.com/${slug}#readme`,
    bugs: `https://github.com/${slug}/issues`,
  }
}

/** 发布标签：monorepo 下必须带包名，避免多包共用一个 v 标签。 */
export function releaseTag(config, plugin, version) {
  const short = packageShortName(expectedName(config, plugin))
  if (isMonorepo(config)) return `${short}@v${version}`
  return `v${version}`
}

export function latestTagFor(config, plugin, tags = []) {
  const short = packageShortName(expectedName(config, plugin))
  const prefix = isMonorepo(config) ? `${short}@v` : 'v'
  return tags.find((tag) => tag.startsWith(prefix)) || null
}

export function tagVersion(config, plugin, tag) {
  const short = packageShortName(expectedName(config, plugin))
  const prefix = isMonorepo(config) ? `${short}@v` : 'v'
  return tag.startsWith(prefix) ? tag.slice(prefix.length) : tag.replace(/^.*@v/, '').replace(/^v/, '')
}

export async function loadConfig({ cwd = process.cwd(), configPath = null, fallbackDir = null } = {}) {
  let file = configPath ? path.resolve(cwd, configPath) : await findUp(cwd, CONFIG_NAME)
  if (!file && fallbackDir) file = await findUp(fallbackDir, CONFIG_NAME)
  if (!file) {
    throw new Error(`找不到 ${CONFIG_NAME}（从 ${cwd} 向上查找）。用 --config 指定路径。`)
  }
  const config = await readJson(file)
  const configDir = path.dirname(file)
  if (!config.scope || !/^@[a-z0-9][a-z0-9._-]*$/i.test(config.scope)) {
    throw new Error(`${CONFIG_NAME}: scope 必须是合法的 npm scope，例如 "@mindlink-ai"`)
  }
  if (!Array.isArray(config.plugins) || config.plugins.length === 0) {
    throw new Error(`${CONFIG_NAME}: plugins 必须是非空数组`)
  }
  const root = path.resolve(configDir, config.root || '.')
  const monorepo = config.monorepo && config.monorepo.repo ? config.monorepo : null
  const repoRoot = monorepo
    ? path.resolve(configDir, monorepo.root || path.relative(configDir, path.dirname(root)))
    : null
  const plugins = config.plugins.map((spec) => {
    if (!spec.dir) throw new Error(`${CONFIG_NAME}: 每个 plugins 项都需要 dir`)
    if (!spec.slug) throw new Error(`${CONFIG_NAME}: plugins.${spec.dir} 缺少 slug`)
    return {
      ...spec,
      publish: spec.publish === true,
      dirAbs: path.resolve(root, spec.dir),
    }
  })
  return {
    ...config,
    file,
    configDir,
    root,
    repoRoot: repoRoot || root,
    monorepo,
    plugins,
    npmCache: path.resolve(configDir, config.npmCache || '.cache/npm'),
    prefix: config.prefix || 'dsh-',
    owner: config.owner || '',
    defaultEngines: config.defaultEngines || '>=20',
    defaultBranch: config.defaultBranch || 'main',
    commitMessage: config.commitMessage || 'chore(release): {tag}',
  }
}

/** 向上查找包含 .git 的目录（monorepo 下每个包自身没有 .git）。 */
export function findRepoRoot(startDir) {
  let dir = path.resolve(startDir)
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

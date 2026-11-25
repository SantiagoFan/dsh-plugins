import { run } from './git.mjs'

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function npm(args, { cwd, registry, cache, preferOnline = false } = {}) {
  const env = {}
  if (cache) env.npm_config_cache = cache
  if (registry) env.npm_config_registry = registry
  if (preferOnline) env.npm_config_prefer_online = 'true'
  return run(NPM, args, { cwd, env, timeout: 90000 })
}

/** Look up the published state of a package name on the registry. */
export function npmView(name, { cwd, registry, cache } = {}) {
  const result = npm(['view', name, 'version', 'dist-tags', '--json'], { cwd, registry, cache, preferOnline: true })
  if (result.status !== 0) {
    const combined = `${result.stderr}${result.stdout}`
    const notFound = /E404|404 Not Found|is not in this registry/i.test(combined)
    return {
      name,
      exists: false,
      notFound,
      version: null,
      latest: null,
      error: notFound ? null : combined.trim().split('\n').slice(0, 3).join(' ') || (result.error?.message ?? 'npm 璋冪敤澶辫触'),
    }
  }
  let data = null
  try {
    data = JSON.parse(result.stdout)
  } catch {
    data = null
  }
  const latest =
    (data && data['dist-tags'] && data['dist-tags'].latest) ||
    (data && data['dist-tags.latest']) ||
    null
  const version = data && typeof data.version === 'string' ? data.version : latest
  return { name, exists: true, version, latest, error: null }
}

export function npmWhoami({ cwd, registry, cache } = {}) {
  const result = npm(['whoami'], { cwd, registry, cache })
  return result.status === 0 ? { ok: true, user: result.stdout } : { ok: false, user: null, error: result.stderr }
}

export function npmPublish({ cwd, registry, cache, access = 'public', dryRun = false }) {
  const args = ['publish', '--access', access]
  if (dryRun) args.push('--dry-run')
  return npm(args, { cwd, registry, cache })
}


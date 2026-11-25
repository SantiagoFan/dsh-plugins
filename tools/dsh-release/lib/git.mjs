import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let counter = 0

function tmpFiles(label) {
  const dir = path.join(os.tmpdir(), 'dsh-release-spawn')
  fs.mkdirSync(dir, { recursive: true })
  counter += 1
  const base = path.join(dir, `${process.pid}-${counter}-${label}`)
  return { out: `${base}.out`, err: `${base}.err` }
}

function quoteWinArg(arg) {
  const text = String(arg)
  if (text === '') return '""'
  if (!/[\s"]/.test(text)) return text
  return `"${text.replace(/"/g, '\\"')}"`
}

/**
 * 通过临时文件而不是管道捕获子进程输出。
 * 受限环境下（禁止命名管道）piped stdio 会 EPERM，文件 fd 仍然可用。
 */
export function run(command, args, { cwd, env = {}, timeout = 120000, shell = false } = {}) {
  const files = tmpFiles(command.replace(/[^a-z0-9]/gi, '_'))
  const outFd = fs.openSync(files.out, 'w')
  const errFd = fs.openSync(files.err, 'w')
  const useShell = shell || (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command))
  try {
    const result = spawnSync(command, useShell && process.platform === 'win32' ? args.map(quoteWinArg) : args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
      timeout,
      shell: useShell,
    })
    fs.closeSync(outFd)
    fs.closeSync(errFd)
    const stdout = fs.readFileSync(files.out, 'utf8').replace(/^\uFEFF/, '')
    const stderr = fs.readFileSync(files.err, 'utf8').replace(/^\uFEFF/, '')
    return {
      status: result.status,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      error: result.error || null,
    }
  } finally {
    for (const file of [files.out, files.err]) {
      try {
        fs.unlinkSync(file)
      } catch {
        /* ignore */
      }
    }
  }
}

export function git(dir, args, options = {}) {
  const result = run('git', args, { cwd: dir, ...options })
  return { ...result, ok: result.status === 0 }
}

export function readGitInfo(dir) {
  const inside = git(dir, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.stdout !== 'true') {
    return { isRepo: false }
  }
  const status = git(dir, ['status', '--porcelain'])
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const remote = git(dir, ['remote', 'get-url', 'origin'])
  const tags = git(dir, ['tag', '--list', 'v*', '--sort=-v:refname'])
  const head = git(dir, ['rev-parse', '--short', 'HEAD'])
  return {
    isRepo: true,
    dirty: status.ok ? status.stdout.split(/\r?\n/).filter(Boolean) : [],
    branch: branch.ok ? branch.stdout : '',
    remote: remote.ok ? remote.stdout : '',
    tags: tags.ok ? tags.stdout.split(/\r?\n/).filter(Boolean) : [],
    head: head.ok ? head.stdout : '',
  }
}

export function repoSlugFromRemote(remote) {
  if (!remote) return null
  const match = /(?:github\.com[:/])([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote.trim())
  return match ? `${match[1]}/${match[2]}` : null
}

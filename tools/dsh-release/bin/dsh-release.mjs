#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../lib/config.mjs'
import { loadPlugins } from '../lib/plugins.mjs'
import { validatePlugin, summarize } from '../lib/validate.mjs'
import { applyEdits, planFix } from '../lib/fix.mjs'
import { runRelease } from '../lib/release.mjs'
import { c } from '../lib/color.mjs'
import { renderPlugin, renderPluginList } from '../lib/report.mjs'
import { pathExists, readText } from '../lib/util.mjs'

const USAGE = `dsh-release — MindLink DSH 插件命名与发布工具

用法：
  dsh-release list                          列出配置里的插件与发布状态
  dsh-release check [选项]                   只读校验包名/清单/git/npm 状态
  dsh-release fix [选项]                     生成改名与补字段的修改（默认只预演）
  dsh-release release --plugin <目录> [选项]  bump + commit + tag + push + npm publish

通用选项：
  --config <路径>      指定 dsh-release.config.json（默认向上查找）
  --plugin <目录>      只处理某个插件（可重复）
  --offline            不访问 npm registry / GitHub
  --json               以 JSON 输出结果（check 用）
  --no-color           关闭颜色

fix 选项：
  --write              真正写入文件（不加只显示将要改什么）
  --force              允许已发布包改名 / 改 profile 引用的私有包名

release 选项：
  --bump <patch|minor|major>   版本增量，默认 patch
  --version <x.y.z>            直接指定版本
  --yes                        真正执行（不加只预演）
  --allow-dirty                把未提交改动一起提交
  --no-push                    不推送（只本地提交打 tag）
  --via-ci                     tag 推送后由 GitHub Actions 发布，本机不跑 npm publish

示例：
  node dsh-release/bin/dsh-release.mjs check
  node dsh-release/bin/dsh-release.mjs fix --write --force
  node dsh-release/bin/dsh-release.mjs release --plugin wechat-bot-plugin --bump patch --yes --via-ci
`

function parseArgs(argv) {
  const args = { _: [], plugins: [], flags: {} }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      args._.push(token)
      continue
    }
    const [rawKey, inlineValue] = token.slice(2).split('=')
    const key = rawKey
    if (key === 'no-color') {
      process.env.NO_COLOR = '1'
      continue
    }
    const takesValue = ['config', 'plugin', 'bump', 'version'].includes(key)
    if (takesValue) {
      const value = inlineValue !== undefined ? inlineValue : argv[++i]
      if (value === undefined) throw new Error(`--${key} 需要一个值`)
      if (key === 'plugin') args.plugins.push(value)
      else args.flags[key] = value
      continue
    }
    args.flags[key] = true
  }
  return args
}

async function readProfileText() {
  const dir = process.env.DSH_PROFILE_DIR
  if (!dir) return null
  const file = path.join(dir, 'package.json')
  if (!(await pathExists(file))) return null
  try {
    return await readText(file)
  } catch {
    return null
  }
}

function selectModels(models, dirs) {
  if (!dirs || dirs.length === 0) return models
  const wanted = dirs.map((dir) => dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop())
  const selected = models.filter((model) => wanted.includes(path.basename(model.dirAbs)) || wanted.includes(model.dir))
  if (selected.length === 0) throw new Error(`--plugin 没有匹配到任何配置项：${dirs.join(', ')}`)
  return selected
}

async function buildContext(args) {
  const cwd = process.cwd()
  const toolDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const config = await loadConfig({ cwd, configPath: args.flags.config, fallbackDir: toolDir })
  const all = await loadPlugins(config, {
    online: !args.flags.offline,
    registry: { registry: config.registry, cache: config.npmCache },
  })
  return { config, models: selectModels(all, args.plugins), profileText: await readProfileText() }
}

async function commandList(args) {
  const { models } = await buildContext(args)
  console.log(renderPluginList(models.map((model) => ({
    dir: model.dir,
    name: model.pkg?.name,
    version: model.pkg?.version,
    publish: model.spec.publish,
  }))))
  console.log('')
  return 0
}

async function commandCheck(args) {
  const { models, profileText } = await buildContext(args)
  const results = []
  for (const model of models) {
    const findings = await validatePlugin(model, { profileText })
    results.push({ model, findings, counts: summarize(findings) })
  }

  if (args.flags.json) {
    console.log(JSON.stringify(results.map(({ model, findings, counts }) => ({
      dir: model.dir,
      name: model.pkg?.name,
      expectedName: model.expectedName,
      version: model.pkg?.version,
      publish: model.spec.publish,
      npm: model.npm,
      npmExpected: model.npmExpected,
      git: { isRepo: model.git.isRepo, dirty: model.git.dirty?.length || 0, tags: model.git.tags?.slice(0, 3) || [] },
      counts,
      findings,
    })), null, 2))
  } else {
    for (const { model, findings } of results) console.log(renderPlugin(model, findings))
    const totals = results.reduce((acc, item) => {
      acc.error += item.counts.error || 0
      acc.warn += item.counts.warn || 0
      return acc
    }, { error: 0, warn: 0 })
    console.log(`\n汇总：${results.length} 个插件 · ${totals.error ? c.red(`${totals.error} 个错误`) : c.green('0 个错误')} · ${totals.warn ? c.yellow(`${totals.warn} 个警告`) : c.dim('0 个警告')}`)
    const dirty = results.filter((item) => (item.model.git.pkgDirty || item.model.git.dirty || []).length)
    if (dirty.length) {
      console.log(c.yellow(`未提交改动：${dirty.map((item) => `${item.model.dir}(${(item.model.git.pkgDirty || item.model.git.dirty).length})`).join(' · ')}`))
    }
    const unpub = results.filter((item) => item.model.spec.publish && !item.model.npm?.exists)
    if (unpub.length) console.log(c.blue(`从未发布：${unpub.map((item) => `${item.model.pkg?.name}`).join(' · ')}`))
  }

  return results.some((item) => (item.counts.error || 0) > 0) ? 1 : 0
}

async function commandFix(args) {
  const { models, profileText } = await buildContext(args)
  const write = Boolean(args.flags.write)
  let pending = 0

  for (const model of models) {
    const findings = await validatePlugin(model, { profileText })
    const { edits, skipped } = await planFix(model, findings, { force: Boolean(args.flags.force), profileText })
    console.log(`\n${c.bold(model.dir)}  ${c.dim(model.pkg?.name || '')}`)

    for (const item of skipped) {
      console.log(c.yellow(`  ! 跳过 ${item.what}`))
      for (const reason of item.reasons) console.log(c.dim(`      ${reason}`))
      console.log(c.dim('      确认要这么改就加 --force'))
    }
    if (edits.length === 0) {
      const manual = findings.filter((item) => item.level === 'error' && !item.fixable)
      console.log(manual.length ? c.yellow(`  没有可自动修的项目，剩余 ${manual.length} 个错误需手工处理`) : c.green('  无需修改'))
      for (const item of manual) console.log(c.dim(`      ${item.code}  ${item.message}`))
      continue
    }

    for (const edit of edits) {
      console.log(`  ${write ? c.green('改  ') : c.cyan('将改')} ${(edit.rel || path.basename(edit.file)).padEnd(20)} ${c.dim(edit.summary)}`)
      pending += 1
    }

    if (write) {
      const written = await applyEdits(edits, { log: () => {} })
      console.log(c.green(`  ✓ 已写入 ${written.length} 个文件；接下来跑 check 和该插件自己的测试`))
    } else {
      console.log(c.dim('  预演，加 --write 才会写入文件'))
    }
  }

  if (!write) console.log(c.dim(`\n预演结束：${pending} 个文件待修改`))
  return 0
}

async function commandRelease(args) {
  if (args.plugins.length !== 1) throw new Error('release 需要且只能用 --plugin 指定一个插件')
  const { models, profileText } = await buildContext(args)
  const model = models[0]
  const findings = await validatePlugin(model, { profileText })
  const log = (line) => console.log(line)
  const warn = (line) => console.error(c.yellow(line))

  const result = await runRelease(model, {
    findings: findings.filter((item) => !['TAG_DRIFT', 'NPM_AHEAD', 'TARGET_NAME_TAKEN'].includes(item.code)),
    bump: args.flags.bump || 'patch',
    version: args.flags.version || null,
    yes: Boolean(args.flags.yes),
    allowDirty: Boolean(args.flags['allow-dirty']),
    noPush: Boolean(args.flags['no-push']),
    viaCi: Boolean(args.flags['via-ci']),
    registry: model.config.registry,
    npmCache: model.config.npmCache,
  }, { log, warn })

  console.log('')
  for (const item of result.steps) {
    console.log(`${item.ok ? c.green('✓') : c.red('✗')} ${String(item.name).padEnd(14)} ${c.dim(item.detail || '')}`)
  }
  if (!result.applied) {
    console.log(c.dim('\n未执行任何改动。'))
    return result.ok ? 0 : 1
  }
  console.log(result.ok ? c.green('\n发布完成。') : c.red('\n发布中断，见上面失败的步骤。'))
  return result.ok ? 0 : 1
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return 0
  }
  const command = argv[0]
  const args = parseArgs(argv.slice(1))

  switch (command) {
    case 'list':
      return await commandList(args)
    case 'check':
      return await commandCheck(args)
    case 'fix':
      return await commandFix(args)
    case 'release':
      return await commandRelease(args)
    default:
      console.error(`未知命令：${command}\n`)
      console.log(USAGE)
      return 2
  }
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    console.error(c.red(`\n失败：${error.message}`))
    if (process.env.DSH_RELEASE_DEBUG) console.error(error.stack)
    process.exitCode = 1
  },
)

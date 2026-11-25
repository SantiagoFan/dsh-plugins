import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import { loadConfig } from '../lib/config.mjs'
import { loadPlugin } from '../lib/plugins.mjs'
import { validatePlugin } from '../lib/validate.mjs'
import { applyEdits, planFix, replaceStale, countStale } from '../lib/fix.mjs'
import { computeVersion, buildCommitMessage } from '../lib/release.mjs'
import { releaseTag, latestTagFor, tagVersion, packageShortName } from '../lib/config.mjs'
import { bumpSemver, compareSemver, toKebab } from '../lib/util.mjs'

let passed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`✓ ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`✗ ${name}\n  ${error.message}`)
  }
}

async function write(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text, 'utf8')
}

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-release-'))
  const pluginDir = path.join(root, 'demo-plugin')
  await write(
    path.join(pluginDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'demo-plugin',
        version: '0.1.0',
        private: false,
        type: 'module',
        description: 'fixture',
        keywords: ['dsh'],
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
      null,
      2,
    )}\n`,
  )
  await write(
    path.join(pluginDir, 'cordis.patch.yml'),
    `- insert:\n    - id: demo\n      name: 'demo-plugin'\n      config: {}\n`,
  )
  await write(
    path.join(pluginDir, 'client.js'),
    `/** Client half of demo-plugin. */\nexport default { id: 'demo-plugin' }\n`,
  )
  await write(path.join(pluginDir, 'README.md'), `# demo-plugin\n\n安装：\`npm i demo-plugin\` · v0.1.0\n`)
  await write(
    path.join(root, 'dsh-release.config.json'),
    `${JSON.stringify(
      {
        scope: '@mindlink-ai',
        prefix: 'dsh-',
        owner: 'SantiagoFan',
        root: '.',
        plugins: [{ dir: 'demo-plugin', slug: 'demo', publish: true }],
      },
      null,
      2,
    )}\n`,
  )
  return { root, pluginDir }
}

await test('semver 工具函数', () => {
  assert.equal(bumpSemver('1.2.3', 'patch'), '1.2.3'.replace(/.$/, '4'))
  assert.equal(bumpSemver('1.2.3', 'minor'), '1.3.0')
  assert.equal(bumpSemver('1.2.3', 'major'), '2.0.0')
  assert.equal(compareSemver('1.0.4', '1.3.0'), -1)
  assert.equal(compareSemver('3.1.1', '3.1.1'), 0)
  assert.equal(toKebab('NewMedia_Workbench'), 'new-media-workbench')
  assert.equal(computeVersion('1.2.3', { bump: 'patch' }), '1.2.4')
  assert.equal(computeVersion('1.2.3', { version: '2.0.0' }), '2.0.0')
  assert.throws(() => computeVersion('1.2.3', { version: 'bad' }))
})

await test('改名不会被 @scope/ 前缀二次污染', () => {
  const text = 'name: dsh-sales-workbench\nnew: @mindlink-ai/dsh-sales-workbench\n'
  const count = countStale(text, 'dsh-sales-workbench')
  assert.equal(count, 1, '只该统计不带 scope 的那一处')
  const replaced = replaceStale(text, { from: 'dsh-sales-workbench', to: '@mindlink-ai/dsh-sales-workbench' })
  assert.ok(!replaced.includes('@mindlink-ai/@mindlink-ai'), '不能出现双重 scope')
  assert.equal((replaced.match(/@mindlink-ai\/dsh-sales-workbench/g) || []).length, 2)
})

await test('仓库地址里的仓库名不当作旧包名替换', () => {
  const text = [
    '"repository": { "url": "git+https://github.com/SantiagoFan/dsh-sales-workbench.git" }',
    '"homepage": "https://github.com/SantiagoFan/dsh-sales-workbench#readme"',
    "name: 'dsh-sales-workbench'",
  ].join('\n')
  assert.equal(countStale(text, 'dsh-sales-workbench'), 1, '只该统计 patch 里那一处真包名')
  const replaced = replaceStale(text, { from: 'dsh-sales-workbench', to: '@mindlink-ai/dsh-sales-workbench' })
  assert.ok(replaced.includes('github.com/SantiagoFan/dsh-sales-workbench.git'), '仓库地址必须保持原样')
  assert.ok(replaced.includes("name: '@mindlink-ai/dsh-sales-workbench'"))
})

await test('monorepo 发布标签带包名，避免多包共用 v 标签', () => {
  const config = { scope: '@mindlink-ai', prefix: 'dsh-', monorepo: { repo: 'dsh-plugins' } }
  const plugin = { slug: 'wechat-bot' }
  assert.equal(releaseTag(config, plugin, '1.4.0'), 'dsh-wechat-bot@v1.4.0')
  assert.equal(
    latestTagFor(config, plugin, ['dsh-sales-workbench@v3.1.0', 'dsh-wechat-bot@v1.2.0']),
    'dsh-wechat-bot@v1.2.0',
  )
  assert.equal(tagVersion(config, plugin, 'dsh-wechat-bot@v1.2.0'), '1.2.0')
  assert.equal(releaseTag({ ...config, monorepo: null }, plugin, '1.4.0'), 'v1.4.0')
  assert.equal(latestTagFor({ ...config, monorepo: null }, plugin, ['v1.0.4']), 'v1.0.4')
  assert.equal(packageShortName('@mindlink-ai/dsh-wechat-bot'), 'dsh-wechat-bot')
})

await test('提交信息模板可替换', () => {
  const message = buildCommitMessage('chore(release): {tag} / {name} {version}', {
    tag: 'dsh-wechat-bot@v1.4.0',
    version: '1.4.0',
    shortName: 'dsh-wechat-bot',
    fullName: '@mindlink-ai/dsh-wechat-bot',
  })
  assert.equal(message, 'chore(release): dsh-wechat-bot@v1.4.0 / dsh-wechat-bot 1.4.0')
})

await test('check 能查出包名不规范与清单缺口（离线）', async () => {
  const { root } = await makeFixture()
  const config = await loadConfig({ cwd: root })
  const model = await loadPlugin(config, config.plugins[0], { online: false })
  const findings = await validatePlugin(model, {})
  const codes = findings.map((item) => item.code)
  assert.ok(codes.includes('NAME_SLUG_MISMATCH'), `应报包名不规范，实际：${codes.join(',')}`)
  assert.ok(codes.includes('PATCH_NAME_MISMATCH') === false, 'patch 与 package.json 同名时不该报不一致')
  assert.ok(codes.includes('REPO_FIELD_MISSING'), '应报缺 repository')
  assert.ok(codes.includes('ACCESS_NOT_PUBLIC'), '应报 publishConfig.access')
  assert.ok(codes.includes('GIT_MISSING'), '应报不是 git 仓库')
  assert.equal(findings.filter((item) => item.code === 'NAME_SLUG_MISMATCH')[0].level, 'error')
  await fs.rm(root, { recursive: true, force: true })
})

await test('fix --write 后包名、patch、模块 id、README 全部同步', async () => {
  const { root, pluginDir } = await makeFixture()
  const config = await loadConfig({ cwd: root })
  const model = await loadPlugin(config, config.plugins[0], { online: false })
  const findings = await validatePlugin(model, {})
  const { edits, skipped } = await planFix(model, findings, { force: true, profileText: null })
  assert.equal(skipped.length, 0)
  const targets = edits.map((edit) => path.basename(edit.file)).sort()
  assert.deepEqual(targets, ['README.md', 'client.js', 'cordis.patch.yml', 'package.json'])
  await applyEdits(edits)

  const pkg = JSON.parse(await fs.readFile(path.join(pluginDir, 'package.json'), 'utf8'))
  assert.equal(pkg.name, '@mindlink-ai/dsh-demo')
  assert.equal(pkg.private, false)
  assert.equal(pkg.publishConfig.access, 'public')
  assert.equal(pkg.repository.url, 'git+https://github.com/SantiagoFan/dsh-demo.git')
  assert.equal(pkg.homepage, 'https://github.com/SantiagoFan/dsh-demo#readme')
  assert.ok(pkg.engines.node, '应补 engines.node')

  const patch = await fs.readFile(path.join(pluginDir, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes("name: '@mindlink-ai/dsh-demo'"), patch)
  assert.ok(!patch.includes("'demo-plugin'"), 'patch 里不该残留旧名')

  const client = await fs.readFile(path.join(pluginDir, 'client.js'), 'utf8')
  assert.equal((client.match(/'@mindlink-ai\/dsh-demo'/g) || []).length, 1)
  assert.ok(!client.includes('@mindlink-ai/@mindlink-ai'))

  const readme = await fs.readFile(path.join(pluginDir, 'README.md'), 'utf8')
  assert.ok(readme.includes('npm i @mindlink-ai/dsh-demo'))

  const reloaded = await loadPlugin(config, config.plugins[0], { online: false })
  const after = await validatePlugin(reloaded, {})
  const afterCodes = after.map((item) => item.code)
  assert.ok(!afterCodes.includes('NAME_SLUG_MISMATCH'))
  assert.ok(!afterCodes.includes('NAME_PENDING_RENAME'), `不该再有残留旧名：${afterCodes.join(',')}`)
  assert.ok(!afterCodes.includes('PATCH_NAME_MISMATCH'))

  await fs.rm(root, { recursive: true, force: true })
})

await test('已发布包改名默认被拦下，需要 --force', async () => {
  const { root } = await makeFixture()
  const config = await loadConfig({ cwd: root })
  const model = await loadPlugin(config, config.plugins[0], { online: false })
  model.npm = { name: 'demo-plugin', exists: true, version: '0.1.0', latest: '0.1.0' }
  const findings = await validatePlugin(model, {})
  const { edits, skipped } = await planFix(model, findings, { force: false })
  assert.ok(edits.every((edit) => edit.kind !== 'rename'), '没有 --force 时不能有改名编辑')
  assert.equal(skipped[0].what, 'rename')
  assert.ok(skipped[0].reasons[0].includes('已在 npm 发布'))
  await fs.rm(root, { recursive: true, force: true })
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1

import fs from 'node:fs'
import path from 'node:path'
import { run } from '../tools/dsh-release/lib/git.mjs'

const root = process.cwd()
const packagesDir = path.join(root, 'packages')
const dirs = fs.readdirSync(packagesDir).filter((name) => fs.existsSync(path.join(packagesDir, name, 'package.json')))

let failed = 0
for (const dir of dirs) {
  const pkgPath = path.join(packagesDir, dir, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  if (!pkg.scripts?.test) {
    console.log(`- ${dir}: 无 test 脚本，跳过`)
    continue
  }
  const result = run('npm', ['test'], { cwd: path.join(packagesDir, dir), shell: true, timeout: 300000 })
  const tail = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/).slice(-3).join('\n')
  if (result.status === 0) {
    console.log(`✓ ${dir} (${pkg.name}@${pkg.version})\n${indent(tail)}`)
  } else {
    failed += 1
    console.log(`✗ ${dir} (${pkg.name}@${pkg.version})\n${indent(tail)}`)
  }
}

if (failed > 0) {
  console.log(`\n${failed} 个包测试失败`)
  process.exitCode = 1
} else {
  console.log(`\n${dirs.length} 个包测试全部通过`)
}

function indent(text) {
  return text.split('\n').map((line) => `    ${line}`).join('\n')
}

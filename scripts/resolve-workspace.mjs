import fs from 'node:fs'
import path from 'node:path'

// 由 tag 里的短包名反查 workspace 目录： dsh-wechat-bot@v1.4.0 → packages/wechat-bot
const short = process.argv[2]
if (!short) {
  console.error('用法: node scripts/resolve-workspace.mjs <短包名>')
  process.exit(1)
}

const root = path.resolve(import.meta.dirname, '..')
const packagesDir = path.join(root, 'packages')
const hits = []

for (const dir of fs.readdirSync(packagesDir)) {
  const pkgPath = path.join(packagesDir, dir, 'package.json')
  if (!fs.existsSync(pkgPath)) continue
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  if (!pkg.name) continue
  const pkgShort = pkg.name.replace(/^@[^/]+\//, '')
  if (pkgShort === short) hits.push({ dir: path.join(packagesDir, dir), name: pkg.name, version: pkg.version })
}

if (hits.length !== 1) {
  console.error(`按短包名 ${short} 匹配到 ${hits.length} 个 workspace，无法发布`)
  process.exit(1)
}

const hit = hits[0]
console.log(`DIR=${hit.dir}`)
console.log(`NAME=${hit.name}`)
console.log(`VERSION=${hit.version}`)

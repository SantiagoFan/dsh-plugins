import { LEVEL, c } from './color.mjs'

function pad(text, width) {
  const raw = String(text)
  const visible = raw.replace(/\u001b\[[0-9;]*m/g, '').length
  return visible >= width ? raw : `${raw}${' '.repeat(width - visible)}`
}

export function renderFindings(findings, { indent = '  ' } = {}) {
  const order = { error: 0, warn: 1, info: 2 }
  const sorted = [...findings].sort((a, b) => (order[a.level] ?? 3) - (order[b.level] ?? 3))
  return sorted.map((item) => {
    const meta = LEVEL[item.level] || LEVEL.info
    const location = item.file ? ` ${c.dim(item.file)}` : ''
    return `${indent}${meta.paint(meta.mark)} ${c.dim(meta.label)} ${pad(item.code, 24)} ${item.message}${location}`
  })
}

export function renderPlugin(model, findings) {
  const counts = { error: 0, warn: 0, info: 0 }
  for (const item of findings) counts[item.level] = (counts[item.level] || 0) + 1
  const name = model.pkg?.name || '(无 package.json)'
  const nameLine =
    model.pkg?.name && model.pkg.name !== model.expectedName
      ? `${c.red(name)} ${c.dim('→')} ${c.green(model.expectedName)}`
      : c.green(name === '(无 package.json)' ? name : name)
  const badges = [
    counts.error ? c.red(`${counts.error} error`) : c.green('0 error'),
    counts.warn ? c.yellow(`${counts.warn} warn`) : c.dim('0 warn'),
    counts.info ? c.gray(`${counts.info} info`) : '',
  ]
    .filter(Boolean)
    .join(c.dim(' · '))
  const version = model.pkg?.version ? c.dim(`v${model.pkg.version}`) : ''
  const publishTag = model.spec.publish ? c.blue('publish') : c.dim('private')
  const lines = [`\n${c.bold(model.dir)}  ${version} ${publishTag}`, `  ${nameLine}`, `  ${badges}`]
  lines.push(...renderFindings(findings))
  return lines.join('\n')
}

export function renderPluginList(summaries) {
  const header = [pad(c.bold('插件目录'), 30), pad(c.bold('包名'), 46), pad(c.bold('版本'), 10), c.bold('发布')].join(' ')
  const rows = summaries.map((item) => {
    const mode = item.publish ? c.blue('publish') : c.dim('private')
    return [pad(item.dir, 30), pad(item.name || '-', 46), pad(item.version || '-', 10), mode].join(' ')
  })
  return [header, c.dim('─'.repeat(96)), ...rows].join('\n')
}

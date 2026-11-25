const enabledNow = () =>
  !process.env.NO_COLOR && process.env.FORCE_COLOR !== '0' && Boolean(process.stdout.isTTY)

const wrap = (code) => (text) => (enabledNow() ? `\u001b[${code}m${text}\u001b[0m` : String(text))

export const c = {
  get enabled() {
    return enabledNow()
  },
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  cyan: wrap('36'),
  gray: wrap('90'),
}

export const LEVEL = {
  error: { mark: '✗', label: 'ERROR', paint: c.red },
  warn: { mark: '!', label: 'WARN ', paint: c.yellow },
  info: { mark: '·', label: 'INFO ', paint: c.gray },
  ok: { mark: '✓', label: 'OK   ', paint: c.green },
}

export function heading(text) {
  return c.bold(text)
}

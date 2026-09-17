import { ANSI, isTTY, parseKey } from './ansi'

export interface MenuItem<T = string> {
  label: string
  value: T
  color?: 'red' | 'cyan'
}

export interface SelectOptions {
  message: string
  subtitle?: string
  clearScreen?: boolean
}

const ESCAPE_TIMEOUT_MS = 50
const ANSI_PATTERN = `${String.fromCharCode(27)}\\[[0-9;]*m`
const ANSI_REGEX = new RegExp(ANSI_PATTERN, 'g')
const ANSI_LEADING_REGEX = new RegExp(`^${ANSI_PATTERN}`)

function stripAnsi(input: string): string {
  return input.replace(ANSI_REGEX, '')
}

function truncateAnsi(input: string, maxVisibleChars: number): string {
  if (maxVisibleChars <= 0) return ''
  if (stripAnsi(input).length <= maxVisibleChars) return input

  const suffix = maxVisibleChars >= 3 ? '...' : '.'.repeat(maxVisibleChars)
  const keep = Math.max(0, maxVisibleChars - suffix.length)
  let output = ''
  let offset = 0
  let visible = 0

  while (offset < input.length && visible < keep) {
    if (input[offset] === '\x1b') {
      const match = input.slice(offset).match(ANSI_LEADING_REGEX)
      if (match) {
        output += match[0]
        offset += match[0].length
        continue
      }
    }
    output += input[offset]
    offset += 1
    visible += 1
  }

  return output.includes('\x1b[')
    ? `${output}${ANSI.reset}${suffix}`
    : output + suffix
}

function colorCode(color: MenuItem['color']): string {
  if (color === 'red') return ANSI.red
  if (color === 'cyan') return ANSI.cyan
  return ''
}

/** Render a bounded, keyboard-only terminal selector without a prompt dependency. */
export async function select<T>(
  items: readonly MenuItem<T>[],
  options: SelectOptions,
): Promise<T | null> {
  if (!isTTY()) throw new Error('Interactive select requires a TTY terminal')
  if (items.length === 0) throw new Error('No menu items provided')
  if (items.length === 1) return items[0]?.value ?? null

  const { stdin, stdout } = process
  let cursor = 0
  let escapeTimeout: ReturnType<typeof setTimeout> | null = null
  let cleaned = false
  let renderedLines = 0

  const render = () => {
    const columns = stdout.columns ?? 80
    const rows = stdout.rows ?? 24
    const previousLines = renderedLines
    if (options.clearScreen) {
      stdout.write(ANSI.clearScreen + ANSI.moveTo(1, 1))
    } else if (previousLines > 0) {
      stdout.write(ANSI.up(previousLines))
    }

    let lines = 0
    const writeLine = (line: string) => {
      stdout.write(`${ANSI.clearLine}${line}\n`)
      lines += 1
    }

    const subtitleLines = options.subtitle ? 3 : 0
    const maxVisible = Math.max(
      1,
      Math.min(items.length, rows - (1 + subtitleLines + 2) - 1),
    )
    const windowStart = Math.max(
      0,
      Math.min(
        cursor - Math.floor(maxVisible / 2),
        Math.max(0, items.length - maxVisible),
      ),
    )
    const visibleItems = items.slice(windowStart, windowStart + maxVisible)

    writeLine(
      `${ANSI.dim}┌  ${ANSI.reset}${truncateAnsi(options.message, Math.max(1, columns - 4))}`,
    )
    if (options.subtitle) {
      writeLine(`${ANSI.dim}│${ANSI.reset}`)
      writeLine(
        `${ANSI.cyan}◆${ANSI.reset}  ${truncateAnsi(options.subtitle, Math.max(1, columns - 4))}`,
      )
      writeLine('')
    }

    for (let offset = 0; offset < visibleItems.length; offset++) {
      const item = visibleItems[offset]
      if (!item) continue
      const selected = windowStart + offset === cursor
      const color = colorCode(item.color)
      let label = color
        ? `${selected ? '' : ANSI.dim}${color}${item.label}${ANSI.reset}`
        : selected
          ? item.label
          : `${ANSI.dim}${item.label}${ANSI.reset}`
      label = truncateAnsi(label, Math.max(1, columns - 8))
      writeLine(
        selected
          ? `${ANSI.cyan}│${ANSI.reset}  ${ANSI.green}●${ANSI.reset} ${label}`
          : `${ANSI.cyan}│${ANSI.reset}  ${ANSI.dim}○${ANSI.reset} ${label}`,
      )
    }

    const windowHint =
      visibleItems.length < items.length
        ? ` (${windowStart + 1}-${windowStart + visibleItems.length}/${items.length})`
        : ''
    writeLine(
      `${ANSI.cyan}│${ANSI.reset}  ${ANSI.dim}${truncateAnsi(
        `Up/Down to select | Enter: confirm | Esc: back${windowHint}`,
        Math.max(1, columns - 6),
      )}${ANSI.reset}`,
    )
    writeLine(`${ANSI.cyan}└${ANSI.reset}`)

    for (let extra = lines; extra < previousLines; extra++) writeLine('')
    renderedLines = lines
  }

  return new Promise((resolve) => {
    const wasRaw = stdin.isRaw ?? false

    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      if (escapeTimeout) clearTimeout(escapeTimeout)
      stdin.removeListener('data', onKey)
      try {
        stdin.setRawMode(wasRaw)
        stdin.pause()
        stdout.write(ANSI.show)
      } catch {}
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
    }

    const finish = (value: T | null) => {
      cleanup()
      resolve(value)
    }
    const onSignal = () => finish(null)
    const onKey = (data: Buffer) => {
      if (escapeTimeout) {
        clearTimeout(escapeTimeout)
        escapeTimeout = null
      }
      switch (parseKey(data)) {
        case 'up':
          cursor = (cursor - 1 + items.length) % items.length
          render()
          break
        case 'down':
          cursor = (cursor + 1) % items.length
          render()
          break
        case 'enter':
          finish(items[cursor]?.value ?? null)
          break
        case 'escape':
          finish(null)
          break
        case 'escape-start':
          escapeTimeout = setTimeout(() => finish(null), ESCAPE_TIMEOUT_MS)
          break
      }
    }

    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    try {
      stdin.setRawMode(true)
    } catch {
      cleanup()
      resolve(null)
      return
    }
    stdin.resume()
    stdout.write(ANSI.hide)
    render()
    stdin.on('data', onKey)
  })
}

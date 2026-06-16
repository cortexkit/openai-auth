import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LOG_FILE = join(tmpdir(), 'opencode-openai-auth.log')
const FLUSH_INTERVAL_MS = 500
const BUFFER_SIZE_LIMIT = 50
const isTestEnv = process.env.NODE_ENV === 'test'

let buffer: string[] = []
let flushTimer: ReturnType<typeof setTimeout> | undefined

function flush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = undefined
  }
  if (buffer.length === 0) return
  const data = buffer.join('')
  buffer = []
  try {
    appendFileSync(LOG_FILE, data)
  } catch {
    // Logging must never throw or write to stderr.
  }
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = undefined
    flush()
  }, FLUSH_INTERVAL_MS)
  flushTimer.unref?.()
}

function serialize(data: unknown): string {
  if (data === undefined) return ''
  if (data instanceof Error) {
    return ` ${data.message}${data.stack ? `\n${data.stack}` : ''}`
  }
  return ` ${JSON.stringify(data)}`
}

export function log(message: string, data?: unknown): void {
  if (isTestEnv) return
  try {
    buffer.push(`[${new Date().toISOString()}] ${message}${serialize(data)}\n`)
    if (buffer.length >= BUFFER_SIZE_LIMIT) flush()
    else scheduleFlush()
  } catch {
    // Logging must never throw.
  }
}

if (!isTestEnv) process.on('exit', flush)

import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Level = 'error' | 'warn' | 'info' | 'debug' | 'trace'
const ORDER: Record<Level, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
}
const isTestEnv = process.env.NODE_ENV === 'test'
const MAX_BYTES = 5 * 1024 * 1024

function logFile(): string {
  return (
    process.env.OPENCODE_OPENAI_AUTH_LOG_FILE ??
    join(tmpdir(), 'opencode-openai-auth.log')
  )
}
let runtimeLevel: Level | undefined
export function setLogLevel(l: Level | undefined) {
  if (l === undefined || l in ORDER) runtimeLevel = l
}
function configuredLevel(): Level {
  if (runtimeLevel) return runtimeLevel
  const env = process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL as Level | undefined
  if (env && env in ORDER) return env
  return 'info'
}

const SECRET_KEY_EXACT =
  /^(authorization|x-api-key|cookie|set-cookie|refresh|access|token)$/i
function isSecretKey(key: string): boolean {
  if (SECRET_KEY_EXACT.test(key)) return true
  const k = key.toLowerCase().replace(/[-_]/g, '')
  if (k === 'accountid' || k === 'chatgptaccountid') return true
  if (k.includes('apikey')) return true
  if (k.endsWith('secret') || k.endsWith('password')) return true
  if (k.endsWith('token') && !k.endsWith('tokens')) return true
  return false
}
const TOKEN_VALUE = /\b(Bearer\s+[\w.-]+|sk-[\w-]+|eyJ[\w.-]+)\b/g
function redact(value: unknown): unknown {
  return redactInner(value, new WeakSet<object>())
}
function redactInner(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string')
    return value.replace(TOKEN_VALUE, '***REDACTED***')
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    const arr = value.map((v) => redactInner(v, seen))
    seen.delete(value)
    return arr
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value))
      out[k] = isSecretKey(k) ? '***REDACTED***' : redactInner(v, seen)
    seen.delete(value)
    return out
  }
  return value
}

let buffer: string[] = []
let timer: ReturnType<typeof setTimeout> | undefined
const ROTATE_KEEP = 3
function rotateIfNeeded() {
  try {
    const f = logFile()
    if (!(existsSync(f) && statSync(f).size > MAX_BYTES)) return
    for (let i = ROTATE_KEEP - 1; i >= 1; i--) {
      if (existsSync(`${f}.${i}`)) renameSync(`${f}.${i}`, `${f}.${i + 1}`)
    }
    renameSync(f, `${f}.1`)
  } catch {
    /* never throw */
  }
}
function flush() {
  if (!buffer.length) return
  const text = buffer.join('')
  buffer = []
  try {
    rotateIfNeeded()
    appendFileSync(logFile(), text)
  } catch {
    /* never throw */
  }
}
function schedule() {
  if (!timer)
    timer = setTimeout(() => {
      timer = undefined
      flush()
    }, 500)
}
if (!isTestEnv) process.on('exit', flush)

function safeSerialize(data: unknown): string {
  try {
    return ` ${JSON.stringify(redact(data))}`
  } catch {
    return ' [unserializable]'
  }
}

function emit(channel: string, level: Level, message: string, data?: unknown) {
  if (ORDER[level] > ORDER[configuredLevel()]) return
  const line =
    `[${new Date().toISOString()}] ${level.toUpperCase()} [${channel}] ${message}` +
    (data === undefined ? '' : safeSerialize(data)) +
    '\n'
  buffer.push(line)
  if (buffer.length >= 50) flush()
  else schedule()
}

export function createLogger(channel: string) {
  return {
    error: (m: string, d?: unknown) => emit(channel, 'error', m, d),
    warn: (m: string, d?: unknown) => emit(channel, 'warn', m, d),
    info: (m: string, d?: unknown) => emit(channel, 'info', m, d),
    debug: (m: string, d?: unknown) => emit(channel, 'debug', m, d),
    trace: (m: string, d?: unknown) => emit(channel, 'trace', m, d),
  }
}
export async function flushForTest() {
  flush()
}

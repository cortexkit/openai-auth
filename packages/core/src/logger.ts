import {
  appendFileSync,
  chmodSync,
  existsSync,
  renameSync,
  statSync,
} from 'node:fs'

export type Level = 'error' | 'warn' | 'info' | 'debug' | 'trace'
const ORDER: Record<Level, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
}
const MAX_BYTES = 5 * 1024 * 1024

/**
 * Where lines are written, and the level floor, as the host supplied them.
 *
 * Both start unset. A host decides where its log lives — that decision reads
 * host environment variables and host directories, neither of which belongs in
 * shared code — and calls `initLogger` before it runs any command. Until then
 * every `log.*` call is a silent no-op: throwing would turn the first command a
 * host forgot to wire into a crash, and buffering would hold credential-bearing
 * lines for an init that may never arrive.
 */
let logFileSource: string | (() => string) | undefined
let initLevelSource: Level | (() => Level | undefined) | undefined
let runtimeLevel: Level | undefined

export interface InitLoggerOptions {
  /**
   * Path of the file lines are appended to, or a function returning it.
   *
   * A function is what a host passes when its destination can move while the
   * process runs — an operator or a test changing the variable that names the
   * log file expects the next line to land in the new file, and a value
   * captured once at init would keep writing to the old one.
   */
  file: string | (() => string)
  /** Level floor applied when no `setLogLevel` call has overridden it. */
  level?: Level | (() => Level | undefined)
}

/**
 * Point the logger at a host's file and level. Idempotent: calling it again
 * replaces both. A runtime level installed by `setLogLevel` is deliberately
 * left alone, because it is the operator's explicit choice and outranks the
 * floor a host computed at start-up.
 */
export function initLogger(options: InitLoggerOptions): void {
  logFileSource = options.file
  initLevelSource = options.level
}

export function setLogLevel(l: Level | undefined) {
  if (l === undefined || l in ORDER) runtimeLevel = l
}

function logFilePath(): string | undefined {
  if (logFileSource === undefined) return undefined
  const resolved =
    typeof logFileSource === 'function' ? logFileSource() : logFileSource
  return resolved || undefined
}

function configuredLevel(): Level {
  if (runtimeLevel) return runtimeLevel
  const floor =
    typeof initLevelSource === 'function' ? initLevelSource() : initLevelSource
  if (floor && floor in ORDER) return floor
  return 'info'
}

const SECRET_KEY_EXACT =
  /^(authorization|x-api-key|cookie|set-cookie|refresh|access|token)$/i
function isSecretKey(key: string): boolean {
  if (SECRET_KEY_EXACT.test(key)) return true
  const k = key.toLowerCase().replace(/[-_]/g, '')
  // Only the unambiguous ChatGPT stable id (chatgpt-account-id / chatgptAccountId)
  // is sensitive. A bare `accountId` field is overloaded — most diagnostic logs put
  // the INTERNAL account id/key ('main' or a fallback id) there, which is safe and
  // needed for debugging — so it is intentionally NOT redacted by name. The genuine
  // ChatGPT id is kept out of logs at the source instead.
  if (k === 'chatgptaccountid') return true
  if (k.includes('apikey')) return true
  if (k.endsWith('secret') || k.endsWith('password')) return true
  if (k.endsWith('token') && !k.endsWith('tokens')) return true
  return false
}
const TOKEN_VALUE = /\b(Bearer\s+[\w.-]+|sk-[\w-]+|eyJ[\w.-]+)\b/g
export function redact(value: unknown): unknown {
  return redactInner(value, new WeakSet<object>())
}

/**
 * Scrub credential-shaped strings without redacting by key name.
 *
 * For regions where a key names a piece of data rather than holding a secret —
 * a JSON Schema property called `api_key` describes an argument, it does not
 * carry one — replacing the node by name destroys the structure while removing
 * nothing sensitive. A credential pasted into a description is still caught,
 * because that is a string.
 */
export function redactStrings(value: unknown): unknown {
  return redactStringsInner(value, new WeakSet<object>())
}

function redactStringsInner(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string')
    return value.replace(TOKEN_VALUE, '***REDACTED***')
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    const arr = value.map((v) => redactStringsInner(v, seen))
    seen.delete(value)
    return arr
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value))
      out[k] = redactStringsInner(v, seen)
    seen.delete(value)
    return out
  }
  return value
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
function chmodPrivate(path: string) {
  try {
    chmodSync(path, 0o600)
  } catch {
    /* never throw */
  }
}
function rotateIfNeeded(f: string) {
  try {
    if (!(existsSync(f) && statSync(f).size > MAX_BYTES)) return
    for (let i = ROTATE_KEEP - 1; i >= 1; i--) {
      if (existsSync(`${f}.${i}`)) {
        const rotated = `${f}.${i + 1}`
        renameSync(`${f}.${i}`, rotated)
        chmodPrivate(rotated)
      }
    }
    const rotated = `${f}.1`
    renameSync(f, rotated)
    chmodPrivate(rotated)
  } catch {
    /* never throw */
  }
}

/**
 * Write whatever is buffered. Safe to call synchronously from a process-exit
 * handler, which is how each host drains the buffer on shutdown.
 */
export function flushLogs() {
  if (!buffer.length) return
  const file = logFilePath()
  const text = buffer.join('')
  buffer = []
  if (!file) return
  try {
    rotateIfNeeded(file)
    if (existsSync(file)) chmodPrivate(file)
    appendFileSync(file, text, { encoding: 'utf8', mode: 0o600 })
  } catch {
    /* never throw */
  }
}
function schedule() {
  if (!timer)
    timer = setTimeout(() => {
      timer = undefined
      flushLogs()
    }, 500)
}

function safeSerialize(data: unknown): string {
  try {
    return ` ${JSON.stringify(redact(data))}`
  } catch {
    return ' [unserializable]'
  }
}

function emit(channel: string, level: Level, message: string, data?: unknown) {
  // No destination means no host has initialised the logger. Drop the line
  // rather than buffering it: see the note on logFileSource above.
  if (logFileSource === undefined) return
  if (ORDER[level] > ORDER[configuredLevel()]) return
  const line =
    `[${new Date().toISOString()}] ${level.toUpperCase()} [${channel}] ${message}` +
    (data === undefined ? '' : safeSerialize(data)) +
    '\n'
  buffer.push(line)
  if (buffer.length >= 50) flushLogs()
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
  flushLogs()
}

/**
 * Return the logger to its uninitialised state. Only a test needs this: a
 * single process runs every test file, so a file path left over from one test
 * would keep a later "logger was never initialised" case writing lines.
 */
export function resetLoggerForTest() {
  buffer = []
  if (timer) {
    clearTimeout(timer)
    timer = undefined
  }
  logFileSource = undefined
  initLevelSource = undefined
  runtimeLevel = undefined
}

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setLogLevel } from '../logger'
import { FLOOR_LOG_FILE } from './setup-env.ts'

process.env.NODE_ENV = 'test'

let dir: string
let logFile: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oai-log-'))
  logFile = join(dir, 'test.log')
  process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = logFile
  // configuredLevel() prefers the module-global runtime level over the env var,
  // so clear any runtime level a prior test left set — these tests drive level
  // through OPENCODE_OPENAI_AUTH_LOG_LEVEL only.
  setLogLevel(undefined)
})
afterEach(() => {
  // Restore to floor (not delete) — keeps in-flight writes away from live defaults.
  process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = FLOOR_LOG_FILE
  delete process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL
})

describe('logger levels', () => {
  it('suppresses debug when level=info, includes warn', async () => {
    process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL = 'info'
    const { createLogger, flushForTest } = await import('../logger.ts')
    const log = createLogger('quota')
    log.debug('hidden-debug-line')
    log.warn('shown-warn-line')
    await flushForTest()
    const txt = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
    expect(txt).not.toContain('hidden-debug-line')
    expect(txt).toContain('shown-warn-line')
    expect(txt).toContain('[quota]')
  })
})

describe('logger safety', () => {
  it('circular payload preserves non-circular fields and marks [Circular]', async () => {
    process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL = 'debug'
    const { createLogger, flushForTest } = await import('../logger.ts')
    const log = createLogger('transport')
    const circ: any = {
      name: 'x',
      secret_token: 'sk-LEAKME123',
      nested: { ok: 1 },
    }
    circ.self = circ
    expect(() => log.debug('circ-msg', circ)).not.toThrow()
    await flushForTest()
    await new Promise((r) => setTimeout(r, 10))
    const txt = readFileSync(logFile, 'utf8')
    expect(txt).toContain('circ-msg')
    expect(txt).not.toContain('sk-LEAKME')
    expect(txt).toContain('[Circular]')
    expect(txt).toContain('"ok":1')
    expect(txt).not.toContain('[unserializable]')
  })

  it('diamond shared ref (no cycle) serializes fully without [Circular]', async () => {
    process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL = 'debug'
    const { createLogger, flushForTest } = await import('../logger.ts')
    const log = createLogger('transport')
    const shared = { x: 1 }
    const diamond: any = { a: shared, b: shared }
    expect(() => log.debug('diamond-msg', diamond)).not.toThrow()
    await flushForTest()
    await new Promise((r) => setTimeout(r, 10))
    const txt = readFileSync(logFile, 'utf8')
    expect(txt).toContain('diamond-msg')
    expect(txt).toContain('"x":1')
    expect(txt).not.toContain('[Circular]')
  })

  it('degrade-catch net still catches non-cycle throws (BigInt) and emits [unserializable]', async () => {
    process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL = 'debug'
    const { createLogger, flushForTest } = await import('../logger.ts')
    const log = createLogger('transport')
    const bad: any = { big: BigInt(1) }
    expect(() => log.debug('bigint-msg', bad)).not.toThrow()
    await flushForTest()
    await new Promise((r) => setTimeout(r, 10))
    const txt = readFileSync(logFile, 'utf8')
    expect(txt).toContain('bigint-msg')
    expect(txt).toContain('[unserializable]')
  })
})

describe('logger redaction', () => {
  it('redacts compound secret keys (accessToken, apiKey, clientSecret, bearerToken, refreshToken)', async () => {
    process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL = 'debug'
    const { createLogger, flushForTest } = await import('../logger.ts')
    const log = createLogger('transport')
    log.info('compound-keys', {
      accessToken: 'should-be-redacted',
      apiKey: 'sk-should-be-redacted',
      clientSecret: 'should-be-redacted',
      bearerToken: 'should-be-redacted',
      refreshToken: 'should-be-redacted',
      password: 'should-be-redacted',
    })
    await flushForTest()
    const txt = readFileSync(logFile, 'utf8')
    expect(txt).not.toContain('should-be-redacted')
    expect(txt).toContain('"accessToken":"***REDACTED***"')
    expect(txt).toContain('"apiKey":"***REDACTED***"')
  })

  it('keeps non-secret camelCase keys (sessionKey, cacheKey, lastAccessAt, accountId)', async () => {
    process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL = 'debug'
    const { createLogger, flushForTest } = await import('../logger.ts')
    const log = createLogger('transport')
    log.info('safe-keys', {
      sessionKey: 'sess-abc',
      cacheKey: 'cache-123',
      lastAccessAt: 1234567890,
      accountId: 'acc-456',
      status: 'ok',
      mode: 'auto',
      level: 'info',
    })
    await flushForTest()
    const txt = readFileSync(logFile, 'utf8')
    expect(txt).toContain('"sessionKey":"sess-abc"')
    expect(txt).toContain('"cacheKey":"cache-123"')
    expect(txt).toContain('"lastAccessAt"')
    expect(txt).toContain('"accountId"')
    expect(txt).toContain('"status"')
  })

  it('keeps token COUNT keys (input_tokens, cached_tokens, output_tokens) unredacted', async () => {
    process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL = 'debug'
    const { createLogger, flushForTest } = await import('../logger.ts')
    const log = createLogger('transport')
    log.info('token-counts', {
      input_tokens: 1500,
      cached_tokens: 800,
      output_tokens: 300,
    })
    await flushForTest()
    const txt = readFileSync(logFile, 'utf8')
    expect(txt).toContain('"input_tokens":1500')
    expect(txt).toContain('"cached_tokens":800')
    expect(txt).toContain('"output_tokens":300')
  })

  it('redacts simple secret keys (authorization, x-api-key, cookie, refresh, token)', async () => {
    process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL = 'debug'
    const { createLogger, flushForTest } = await import('../logger.ts')
    const log = createLogger('transport')
    log.info('simple-keys', {
      authorization: 'Bearer secret',
      'x-api-key': 'k-abc',
      cookie: 'ses=xyz',
      refresh: 'rt-xyz',
      token: 'tok-abc',
    })
    await flushForTest()
    const txt = readFileSync(logFile, 'utf8')
    expect(txt).toContain('***REDACTED***')
  })

  it('masks token-shaped values and secret keys in structured data', async () => {
    process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL = 'debug'
    const { createLogger, flushForTest } = await import('../logger.ts')
    const log = createLogger('transport')
    log.info('req', {
      authorization: 'Bearer sk-secret-abc123',
      headers: { 'x-api-key': 'k-9' },
      ok: 1,
    })
    await flushForTest()
    const txt = readFileSync(logFile, 'utf8')
    expect(txt).not.toContain('sk-secret-abc123')
    expect(txt).not.toContain('k-9')
    expect(txt).toContain('"ok":1')
    expect(txt).toMatch(/REDACTED|\*\*\*/)
  })
})

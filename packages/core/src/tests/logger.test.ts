import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initLogger, resetLoggerForTest, setLogLevel } from '../logger'

let dir: string
let logFile: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oai-log-'))
  logFile = join(dir, 'test.log')
  // configuredLevel() prefers the runtime level set by setLogLevel over the
  // floor a host passed to initLogger, so clear any runtime level a prior test
  // left set — these tests drive level through initLogger only.
  setLogLevel(undefined)
  initLogger({ file: logFile })
})
afterEach(() => {
  // Leave the logger uninitialised so a later test that asserts the
  // never-initialised behaviour is not writing into this test's file.
  resetLoggerForTest()
})

describe('logger levels', () => {
  it('suppresses debug when level=info, includes warn', async () => {
    initLogger({ file: logFile, level: 'info' })
    const { createLogger, flushForTest } = await import('../logger.ts')
    const log = createLogger('quota')
    log.debug('hidden-debug-line')
    log.warn('shown-warn-line')
    await flushForTest()
    const txt = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
    expect(statSync(logFile).mode & 0o777).toBe(0o600)
    expect(txt).not.toContain('hidden-debug-line')
    expect(txt).toContain('shown-warn-line')
    expect(txt).toContain('[quota]')
  })
})

describe('logger safety', () => {
  it('circular payload preserves non-circular fields and marks [Circular]', async () => {
    initLogger({ file: logFile, level: 'debug' })
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
    initLogger({ file: logFile, level: 'debug' })
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
    initLogger({ file: logFile, level: 'debug' })
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
    initLogger({ file: logFile, level: 'debug' })
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

  it('keeps non-secret camelCase keys (sessionKey, cacheKey, lastAccessAt)', async () => {
    initLogger({ file: logFile, level: 'debug' })
    const { createLogger, flushForTest } = await import('../logger.ts')
    const log = createLogger('transport')
    log.info('safe-keys', {
      sessionKey: 'sess-abc',
      cacheKey: 'cache-123',
      lastAccessAt: 1234567890,
      status: 'ok',
      mode: 'auto',
      level: 'info',
    })
    await flushForTest()
    const txt = readFileSync(logFile, 'utf8')
    expect(txt).toContain('"sessionKey":"sess-abc"')
    expect(txt).toContain('"cacheKey":"cache-123"')
    expect(txt).toContain('"lastAccessAt"')
    expect(txt).toContain('"status"')
  })

  it('redacts only the ChatGPT stable id, not the internal accountId key', async () => {
    initLogger({ file: logFile, level: 'debug' })
    const { createLogger, flushForTest } = await import('../logger.ts')
    const log = createLogger('transport')
    log.info('account-keys', {
      // Bare accountId carries the INTERNAL id/key ('main' or a fallback id) in
      // every diagnostic log — safe and needed for debugging, so NOT redacted.
      accountId: 'main',
      chatgptAccountId: 'chatgpt-acc-456',
      'chatgpt-account-id': 'chatgpt-acc-789',
      chatgpt_account_id: 'chatgpt-acc-000',
    })
    await flushForTest()
    const txt = readFileSync(logFile, 'utf8')
    // Internal id stays visible.
    expect(txt).toContain('"accountId":"main"')
    // Every form of the ChatGPT stable id is redacted.
    expect(txt).not.toContain('chatgpt-acc-456')
    expect(txt).not.toContain('chatgpt-acc-789')
    expect(txt).not.toContain('chatgpt-acc-000')
    expect(txt).toContain('"chatgptAccountId":"***REDACTED***"')
    expect(txt).toContain('"chatgpt-account-id":"***REDACTED***"')
    expect(txt).toContain('"chatgpt_account_id":"***REDACTED***"')
  })

  it('keeps token COUNT keys (input_tokens, cached_tokens, output_tokens) unredacted', async () => {
    initLogger({ file: logFile, level: 'debug' })
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

  it('writes nothing at all before a host calls initLogger', async () => {
    resetLoggerForTest()
    const { createLogger, flushForTest } = await import('../logger.ts')
    const log = createLogger('commands')
    expect(() => {
      log.error('uninitialised-error-line')
      log.warn('uninitialised-warn-line')
      log.info('uninitialised-info-line')
      log.debug('uninitialised-debug-line')
      log.trace('uninitialised-trace-line')
    }).not.toThrow()
    await flushForTest()
    expect(existsSync(logFile)).toBe(false)
  })

  it('redacts simple secret keys (authorization, x-api-key, cookie, refresh, token)', async () => {
    initLogger({ file: logFile, level: 'debug' })
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

  it('writes no credential value when a command logs every secret shape at once', async () => {
    initLogger({ file: logFile, level: 'debug' })
    const { createLogger, flushForTest } = await import('../logger.ts')
    const log = createLogger('commands')
    log.info('every-secret-shape', {
      authorization: 'Bearer ya29.a0AfB_byC-token-value',
      apiKey: 'sk-live-0123456789abcdef',
      idToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln',
      'chatgpt-account-id': 'chatgpt-acc-secret',
      clientSecret: 'cs-0123456789',
      accountId: 'main',
    })
    await flushForTest()
    const txt = readFileSync(logFile, 'utf8')
    expect(txt).not.toContain('ya29.a0AfB_byC-token-value')
    expect(txt).not.toContain('sk-live-0123456789abcdef')
    expect(txt).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(txt).not.toContain('chatgpt-acc-secret')
    expect(txt).not.toContain('cs-0123456789')
    expect(txt).toContain('"accountId":"main"')
  })

  it('masks token-shaped values and secret keys in structured data', async () => {
    initLogger({ file: logFile, level: 'debug' })
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

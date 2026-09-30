import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createLogger,
  flushForTest,
  initLogger,
  redact,
  resetLoggerForTest,
  setLogLevel,
} from '../logger'

// The shared logger's redaction and buffering are tested in
// @cortexkit/common-auth. What only this plugin can get wrong is handing its
// identity keys to that logger, so that is what these tests pin.
let dir: string | undefined
afterEach(() => {
  resetLoggerForTest()
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

const identity = {
  accountId: 'main',
  chatgptAccountId: 'chatgpt-acc-456',
  'chatgpt-account-id': 'chatgpt-acc-789',
  email: 'served.identity@example.test',
  orgName: 'Served Identity Organization',
  organization_name: 'Served Identity Org Two',
}

describe('openai identity redaction', () => {
  it('log lines redact the ChatGPT id, email and organisation but keep the internal accountId', async () => {
    dir = mkdtempSync(join(tmpdir(), 'oai-log-identity-'))
    const logFile = join(dir, 'test.log')
    setLogLevel(undefined)
    initLogger({ file: logFile, level: 'debug' })
    createLogger('transport').info('identity-line', identity)
    await flushForTest()
    const txt = readFileSync(logFile, 'utf8')
    expect(txt).toContain('identity-line')
    expect(txt).toContain('"accountId":"main"')
    for (const value of Object.values(identity).slice(1))
      expect(txt).not.toContain(value)
  })

  it('redact applies the same identity keys outside the log file', () => {
    expect(redact(identity)).toEqual({
      accountId: 'main',
      chatgptAccountId: '***REDACTED***',
      'chatgpt-account-id': '***REDACTED***',
      email: '***REDACTED***',
      orgName: '***REDACTED***',
      organization_name: '***REDACTED***',
    })
  })
})

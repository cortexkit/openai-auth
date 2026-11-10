import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaustrumUnreachableError } from '@cortexkit/common-auth/claustrum'

import { flushForTest, initLogger, resetLoggerForTest } from '../logger'
import { OpenAiVault } from '../vault'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

test('authority is logged once when first read and again only when it changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openai-authority-log-'))
  const vault = new OpenAiVault({
    host: 'opencode',
    stateDir: join(dir, 'vault'),
  })
  const logFile = join(dir, 'vault.log')
  resetLoggerForTest()
  initLogger({ file: logFile, level: 'info' })
  cleanups.push(async () => {
    resetLoggerForTest()
    vault.close()
    await rm(dir, { recursive: true, force: true })
  })
  const authorityLines = async () => {
    await flushForTest()
    const text = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
    return text.split('\n').filter((line) => line.includes('vault authority'))
  }

  expect(await vault.authority()).toBe('local')
  expect(await vault.authority()).toBe('local')
  expect(await authorityLines()).toHaveLength(1)

  await mkdir(join(dir, 'vault'), { recursive: true, mode: 0o700 })
  await writeFile(
    vault.paths.tokenPath,
    JSON.stringify({ token: 'ab'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  expect(await vault.authority()).toBe('vault')
  expect(await vault.authority()).toBe('vault')

  const lines = await authorityLines()
  expect(lines).toHaveLength(2)
  expect(lines[0]).toContain('"authority":"local"')
  expect(lines[1]).toContain('"authority":"vault"')
  expect(lines[1]).toContain('"host":"opencode"')
  expect(lines.join('\n')).not.toContain('ab'.repeat(32))
})

for (const reason of [
  'host-accessor-missing',
  'host-accessor-failed',
  undefined,
] as const) {
  test(`roster refresh warning preserves context with ${reason ?? 'no accessor reason'}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openai-refresh-log-'))
    const vault = new OpenAiVault({
      host: 'opencode',
      stateDir: join(dir, 'vault'),
      pollIntervalMs: 0,
      connectScoped: async () => {
        throw new ClaustrumUnreachableError(reason)
      },
    })
    const logFile = join(dir, 'vault.log')
    resetLoggerForTest()
    initLogger({ file: logFile, level: 'info' })
    cleanups.push(async () => {
      resetLoggerForTest()
      vault.close()
      await rm(dir, { recursive: true, force: true })
    })
    await mkdir(join(dir, 'vault'), { recursive: true, mode: 0o700 })
    await writeFile(
      vault.paths.tokenPath,
      JSON.stringify({ token: 'ab'.repeat(32), token_generation: 1 }),
      { mode: 0o600 },
    )

    await vault.refresh()
    await flushForTest()
    const text = readFileSync(logFile, 'utf8')
    const warnings = text
      .split('\n')
      .filter((line) => line.includes('vault roster refresh failed'))
    expect(warnings.length).toBeGreaterThan(0)
    for (const warning of warnings) {
      expect(warning).toContain(' WARN [vault] ')
      expect(warning).toContain('"host":"opencode"')
      expect(warning).toContain(
        '"error":"Claustrum scoped operation unavailable"',
      )
      if (reason) expect(warning).toContain(`"reason":"${reason}"`)
      else expect(warning).not.toContain('"reason":')
    }
    expect(text).not.toContain('ab'.repeat(32))
    expect((await vault.status()).lastError).toBe(
      'Claustrum scoped operation unavailable',
    )
  })
}

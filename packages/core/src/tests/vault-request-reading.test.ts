import { expect, test } from 'bun:test'
import { join } from 'node:path'

test('vault requestReading reports rejected quota polls without an unhandled rejection and releases deduplication', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'fixtures/vault-request-reading-harness.ts'),
    ],
    { stdout: 'pipe', stderr: 'pipe', timeout: 8_000 },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
  const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '')
  expect(result.unhandled).toEqual([])
  expect(result.pollCalls).toBe(2)
  expect(result.warnings).toHaveLength(2)
  for (const warning of result.warnings as string[]) {
    expect(warning).toContain('vault quota poll failed')
    expect(warning).toContain('"routeId":"route-with-failed-poll"')
    expect(warning).toContain('"error":"quota poll setup failed"')
  }
}, 10_000)

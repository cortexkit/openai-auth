import { expect, it } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { FLOOR_ENV } from './setup-env'

it('prints slow, failed and unfinished runtime-layout phases but not a fast pass', async () => {
  const fixture = fileURLToPath(
    new URL('./runtime-layout.test.ts', import.meta.url),
  )
  // Let the child preload create its own temporary homes and private paths.
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPENAI_AUTH_RUNTIME_LAYOUT_TRACE_PROBE: '1',
  }
  for (const name of Object.keys(FLOOR_ENV)) delete env[name]
  const child = Bun.spawn(
    [process.execPath, 'test', fixture, '-t', '^phase trace probe:'],
    {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  const output = stdout + stderr
  expect(status).toBe(1)
  expect(output).toMatch(/\(pass\) phase trace probe: fast/)
  expect(output).toMatch(/\(pass\) phase trace probe: slow/)
  expect(output).not.toContain('[runtime-layout trace] phase trace probe: fast')
  expect(output).toContain(
    '[runtime-layout trace] phase trace probe: slow (slow, ',
  )
  const delay = output.match(
    /\+\d+\.\d ms (\d+\.\d) ms test-step\.after-copy\n/,
  )
  expect(Number(delay?.[1])).toBeGreaterThanOrEqual(2_000)
  expect(output).toContain('lock.acquire runtime-layout: ')
  expect(output).toContain('lock.release runtime-layout: ')
  expect(output).toContain('lock.renewal.scheduled runtime-layout: ')
  expect(output).toContain('marker.write')
  expect(output).toContain('heartbeat.write')
  expect(output).toContain(
    '[runtime-layout trace] phase trace probe: failed (failed, ',
  )
  expect(output).toContain(
    '[runtime-layout trace] phase trace probe: timed out (body unfinished, ',
  )
  expect(output).toMatch(
    /\+\d+\.\d ms \d+\.\d ms test\.waiting-probe \(unfinished\)/,
  )
})

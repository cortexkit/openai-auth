import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

async function timeoutChild(filter: string) {
  const abort = new AbortController()
  const deadline = setTimeout(() => abort.abort(), 4_000)
  const child = Bun.spawn(
    [
      process.execPath,
      'test',
      '--timeout',
      '1000',
      '--preload',
      './src/tests/fixtures/opencode2-dump-timeout.ts',
      './src/tests/opencode2-dump.test.ts',
      './src/tests/vault-command-menu.test.ts',
      '-t',
      filter,
    ],
    {
      cwd: resolve(import.meta.dir, '../..'),
      stdout: 'pipe',
      stderr: 'pipe',
      signal: abort.signal,
    },
  )
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    const output = stdout + stderr
    expect(code).toBe(1)
    expect(output).toContain(
      'a beforeEach/afterEach hook timed out for this test',
    )
    expect(output).toContain(
      '(pass) vault command menu > disconnected output is byte-identical apart from unlabelled row names',
    )
    expect(output).toContain('1 fail')
    expect(output).not.toContain('installed.onAttemptEnd')
    return output
  } finally {
    clearTimeout(deadline)
  }
}

test('OpenCode 2 dump hook timeout fails only its owner and restores menu settings', async () => {
  const output = await timeoutChild(
    'final merged HTTP request once at status (200|400)|disconnected output is byte-identical',
  )
  expect(output).toContain(
    '(pass) OpenCode 2 dumps final merged HTTP request once at status 400',
  )
  expect(output).toContain('2 pass')
})

test('OpenCode 2 last dump hook timeout drains before the next file reads settings', async () => {
  const output = await timeoutChild(
    'final merged HTTP request once at status 200|disconnected output is byte-identical',
  )
  expect(output).toContain('1 pass')
})

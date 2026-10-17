import { expect, test } from 'bun:test'
import { join } from 'node:path'
import type { Plugin } from '@opencode/plugin/tui'
import plugin from '../tui'

test('OpenCode 2 production entry mounts one sidebar at the P0 anchor across reloads', async () => {
  const claims: Array<Record<string, unknown>> = []
  let live = 0
  const context = {
    ui: {
      slot(claim: Record<string, unknown>) {
        claims.push(claim)
        live++
        return () => live--
      },
      router: { current: () => ({ type: 'home' }) },
    },
  } as unknown as Plugin.Context
  let dispose = await plugin.setup(context)
  try {
    expect(live).toBe(1)
    expect(claims[0]?.append).toBe('sidebar.content')
    expect(claims[0]).not.toHaveProperty('order')
    const previous = dispose
    dispose = await plugin.setup(context)
    expect(live).toBe(1)
    previous()
    expect(live).toBe(1)
    expect(claims).toHaveLength(2)
  } finally {
    dispose()
  }
  expect(live).toBe(0)
})

test.each(['local', 'vault'])(
  'OpenCode 2 compiled sidebar renders %s parity, live preferences and cleanup',
  async (mode) => {
    const child = Bun.spawn(
      [
        process.execPath,
        '--conditions=browser',
        '--preload',
        '@opentui/solid/runtime-plugin-support',
        'src/tests/fixtures/sidebar-render.ts',
        mode,
      ],
      {
        cwd: join(import.meta.dir, '..', '..'),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
    expect(stdout).toContain('sidebar-render passed')
  },
)

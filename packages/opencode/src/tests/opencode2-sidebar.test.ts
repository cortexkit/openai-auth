import { expect, test } from 'bun:test'
import { join } from 'node:path'
import type { Plugin } from '@opencode/plugin/tui'
import { RGBA } from '@opentui/core'
import plugin, { sidebarThemeFromHost } from '../tui'

test('OpenCode 2 semantic tokens map every sidebar colour independently', () => {
  const color = (hex: string) => RGBA.fromHex(hex)
  const host = {
    text: {
      base: color('#f0f0f0'),
      muted: color('#888888'),
      action: { primary: { base: color('#55aaff') } },
      feedback: {
        success: { base: color('#00cc55') },
        warning: { base: color('#ffaa00') },
        error: { base: color('#ff0055') },
      },
    },
    background: { base: color('#101010') },
    border: { base: color('#cc88ff') },
  }
  expect(sidebarThemeFromHost(host)).toEqual({
    text: color('#f0f0f0'),
    textMuted: color('#888888'),
    accent: color('#55aaff'),
    success: color('#00cc55'),
    warning: color('#ffaa00'),
    error: color('#ff0055'),
    background: color('#101010'),
    borderActive: color('#cc88ff'),
  })
})

test('OpenCode 2 missing semantic tokens use siblings or neutral colours', () => {
  const text = RGBA.fromHex('#dddddd')
  const accent = RGBA.fromHex('#88aaff')
  const background = RGBA.fromHex('#222222')
  const feedback = { muted: RGBA.fromHex('#ffcc00') }
  expect(
    sidebarThemeFromHost({
      text: {
        base: text,
        action: { primary: { base: accent } },
        feedback: { success: feedback, warning: feedback, error: feedback },
      },
      background: { raised: { base: background } },
    }),
  ).toEqual({
    text,
    textMuted: text,
    accent,
    background,
    borderActive: accent,
    success: feedback.muted,
    warning: feedback.muted,
    error: feedback.muted,
  })
  for (const host of [{ text: { muted: text } }, { text: { base: text } }]) {
    const mapped = sidebarThemeFromHost(host)
    for (const key of [
      'text',
      'textMuted',
      'accent',
      'borderActive',
      'success',
      'warning',
      'error',
    ] as const)
      expect(mapped[key]).toBe(text)
  }
  const empty = sidebarThemeFromHost({})
  expect(empty.text).toEqual(RGBA.fromHex('#ffffff'))
  expect(empty.background).toEqual(RGBA.fromHex('#000000'))
  for (const color of Object.values(empty)) expect(color).toBeInstanceOf(RGBA)
})

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
  renderSidebarFixture,
)

async function renderSidebarFixture(mode: string) {
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
      timeout: 10_000,
    },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
  expect(stdout).toContain('sidebar-render passed')
}

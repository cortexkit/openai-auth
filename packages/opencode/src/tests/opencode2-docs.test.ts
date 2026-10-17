import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

test('OpenCode 2 docs offer log level changes and request dumps with their warning', () => {
  const doc = readFileSync(
    new URL('../../../../docs/opencode-2.md', import.meta.url),
    'utf8',
  )
  const menu = doc.split('## The `/openai` menu')[1]?.split('## Sidebar')[0]
  const unavailable = doc.split('## Not on OpenCode 2 yet')[1]
  expect(menu).toContain('Diagnostics')
  expect(menu).toContain('set the log level')
  expect(menu).toContain('turn request dumps on and off')
  expect(menu).toContain('prompt and session content')
  expect(menu).toContain('Turn them off after debugging.')
  expect(menu).not.toContain('Turning request dumps on is not available yet.')
  expect(menu).toContain('Cache and Reset credits show')
  expect(menu).not.toContain('Cache, Diagnostics and Reset credits')
  expect(unavailable).not.toContain('request dumps')
  expect(unavailable).not.toContain('diagnostics actions')
  expect(unavailable).toContain(
    'vault enrollment and per-host account controls',
  )
  expect(unavailable).toContain('cache keep-warm')
  expect(unavailable).toContain('reset-credit preview and redemption')
  for (const passage of [menu, unavailable])
    expect(passage).not.toMatch(
      /\.ts\b|allowed\(|unavailableSections|hook|test/,
    )
})

test('OpenCode 2 docs describe the HTTP request shape as available and WebSocket rewriting as not yet', () => {
  const doc = readFileSync(
    new URL('../../../../docs/opencode-2.md', import.meta.url),
    'utf8',
  )
  const differences = doc
    .split('## How it differs from OpenCode 1')[1]
    ?.split('## Model costs')[0]
  const shape = differences
    ?.split('\n')
    .find((line) => line.startsWith('- **Codex request shape over HTTP.**'))
  const unavailable = doc.split('## Not on OpenCode 2 yet')[1]
  expect(shape).toContain('conversation headers and tool formatting')
  expect(shape).toContain('after a server restart')
  expect(unavailable).toContain('WebSocket request rewriting')
  expect(unavailable).not.toContain('conversation headers')
  expect(unavailable).not.toContain('tool formatting')
  for (const passage of [shape, unavailable]) {
    expect(passage).not.toMatch(
      /\.ts\b|\.json\b|allowed\(|unavailableSections|hook|test/,
    )
    // Only HTTP requests are reshaped; no sentence may promise the new
    // headers or tool formatting on the WebSocket.
    for (const sentence of passage?.split(/(?<=\.)\s/) ?? [])
      if (sentence.includes('WebSocket'))
        expect(sentence).not.toMatch(/header|tool formatting|tool definitions/)
  }
})

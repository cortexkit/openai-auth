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

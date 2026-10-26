import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

test('OpenCode 2 docs offer log level changes and request dumps with their warning', () => {
  const doc = readFileSync(
    new URL('../../../../docs/opencode-2.md', import.meta.url),
    'utf8',
  )
  const menu = doc.split('## The `/openai` menu')[1]?.split('## Sidebar')[0]
  const unavailable = doc.split('## Not on OpenCode 2 yet')[1] ?? ''
  expect(menu).toContain('Diagnostics')
  expect(menu).toContain('set the log level')
  expect(menu).toContain('turn request dumps on and off')
  expect(menu).toContain('prompt and session content')
  expect(menu).toContain('Turn them off after debugging.')
  expect(menu).not.toContain('Turning request dumps on is not available yet.')
  expect(menu).toContain('Cache shows')
  expect(menu).not.toContain('Cache, Diagnostics and Reset credits')
  expect(unavailable).not.toContain('request dumps')
  expect(unavailable).not.toContain('diagnostics actions')
  expect(unavailable).not.toContain(
    'vault enrollment and per-host account controls',
  )
  expect(unavailable).not.toContain('keep-warm')
  for (const passage of [menu, unavailable])
    expect(passage).not.toMatch(
      /\.ts\b|allowed\(|unavailableSections|hook|test/,
    )
})

test('OpenCode 2 docs describe the HTTP and WebSocket request shapes as available', () => {
  const doc = readFileSync(
    new URL('../../../../docs/opencode-2.md', import.meta.url),
    'utf8',
  )
  const differences = doc
    .split('## How it differs from OpenCode 1')[1]
    ?.split('## Model costs')[0]
  const lines = differences?.split('\n') ?? []
  const shape = lines.find((line) =>
    line.startsWith('- **Codex request shape over HTTP.**'),
  )
  const socket = lines.find((line) =>
    line.startsWith('- **Codex request shape over the WebSocket.**'),
  )
  const unavailable = doc.split('## Not on OpenCode 2 yet')[1] ?? ''
  expect(shape).toContain('conversation headers and tool formatting')
  expect(shape).toContain('after a server restart')
  expect(socket).toContain("OpenCode 1's WebSocket request shape")
  expect(socket).toContain('A tool step stays in its turn')
  expect(socket).toContain('exactly as OpenCode 2 built it')
  expect(socket).toContain('one WebSocket per account')
  expect(unavailable).not.toContain('WebSocket request shape')
  expect(unavailable).not.toContain('conversation headers')
  expect(unavailable).not.toContain('tool formatting')
  for (const passage of [shape, socket, unavailable]) {
    expect(passage).not.toMatch(
      /\.ts\b|\.json\b|allowed\(|unavailableSections|hook|test/,
    )
    // A WebSocket's connection is opened as before; no sentence may promise
    // new headers on it.
    for (const sentence of passage?.split(/(?<=\.)\s/) ?? [])
      if (sentence.includes('WebSocket')) expect(sentence).not.toMatch(/header/)
  }
})

test('OpenCode 2 docs offer reset-credit preview and confirmed redemption, and no longer list them as unavailable', () => {
  const doc = readFileSync(
    new URL('../../../../docs/opencode-2.md', import.meta.url),
    'utf8',
  )
  const menu = doc.split('## The `/openai` menu')[1]?.split('## Sidebar')[0]
  const unavailable = doc.split('## Not on OpenCode 2 yet')[1] ?? ''
  const vault = menu
    ?.split('\n')
    .find((line) => line.startsWith('While connected to the'))
  expect(menu).toContain('Diagnostics, Reset credits, This session and Vault')
  expect(menu).toContain(
    "preview an account's [reset credits](accounts-and-routing.md#reset-credits), spend one or retry the last redemption",
  )
  expect(menu).toContain('and spends nothing')
  expect(menu).toContain('spent only after you confirm it')
  expect(vault).toContain('Reset credits works only with local accounts')
  expect(vault).toContain('Cache shows the tracked HTTP and WebSocket sessions')
  expect(unavailable).not.toMatch(/reset.credit|redemption/i)
  expect(unavailable).not.toContain(
    'vault enrollment and per-host account controls',
  )
  expect(unavailable).not.toContain('keep-warm')
  for (const passage of [menu, unavailable]) {
    expect(passage).not.toMatch(
      /\.ts\b|\.json\b|allowed\(|unavailableSections|hook|test/,
    )
    // No sentence may call reset credits unavailable on OpenCode 2.
    for (const sentence of passage?.split(/(?<=\.)\s/) ?? [])
      if (/reset credit/i.test(sentence))
        expect(sentence).not.toMatch(/not available|not implemented/i)
  }
})

test('OpenCode 2 docs offer vault enrollment and per-host account controls from the running host', () => {
  const doc = readFileSync(
    new URL('../../../../docs/opencode-2.md', import.meta.url),
    'utf8',
  )
  const menu = doc.split('## The `/openai` menu')[1]?.split('## Sidebar')[0]
  expect(menu).toContain('Vault → **Connect**')
  expect(menu).toContain('Approval waits in the background')
  expect(menu).toContain('session that requested it')
  expect(menu).toContain('Vault → **Disconnect**')
  expect(menu).toContain('**Disable on this host** or **Enable on this host**')
  expect(menu).toContain(
    'Setup still requires all OpenCode and Pi processes to stop',
  )
  expect(menu).toContain('Windows, Linux and macOS')
  expect(doc).not.toContain('not implemented on OpenCode 2 yet')
})

test('OpenCode 2 docs explain count placement and invisible HTTP and WebSocket warming', () => {
  const doc = readFileSync(
    new URL('../../../../docs/opencode-2.md', import.meta.url),
    'utf8',
  )
  const cache = readFileSync(
    new URL('../../../../docs/cache-keep-warm.md', import.meta.url),
    'utf8',
  )
  expect(doc).toContain('session count, not request size')
  expect(doc).toContain('on both HTTP and WebSocket')
  expect(doc).toContain('before the request exists')
  expect(doc).toContain('Cache, Diagnostics')
  for (const text of [doc, cache]) {
    expect(text).toContain("plugin's warming is invisible")
    expect(text).toContain('Both can be on')
    expect(text).toContain(
      "If you turn off OpenCode's warming, the plugin waits for the session's next real request before warming it again.",
    )
    expect(text).toContain('keep-alive message')
    expect(text).toContain('WebSocket')
  }
  expect(cache).toContain('both HTTP and WebSocket sessions')
})

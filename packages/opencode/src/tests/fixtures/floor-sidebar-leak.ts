// Run by floor-env.test.ts in a child `bun test`, never collected by the suite
// (the name does not match Bun's test-file pattern). Its first test leaves the
// shape a vault-mode plugin writes in the floor sidebar file; the preload's
// guard must fail that test by name and leave the next one unaffected.
import { expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'

const sidebarFile = () => {
  const file = process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE
  if (!file) throw new Error('the floor sidebar file is not set')
  return file
}

test('leaves a vault-mode snapshot in the floor sidebar file', () => {
  writeFileSync(
    sidebarFile(),
    JSON.stringify({
      main: { quota: null, killed: false },
      fallbacks: [],
      route: 'main-first',
      lastUpdated: 1,
      vaultAccounts: [],
    }),
  )
})

test('runs after the leaking test with the snapshot gone', () => {
  expect(existsSync(sidebarFile())).toBe(false)
})

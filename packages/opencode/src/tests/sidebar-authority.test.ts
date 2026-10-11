import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_SIDEBAR_STATE,
  setSidebarLegacyRouting,
  setSidebarMachineState,
  setSidebarState,
  upsertSidebarActiveRouting,
} from '../sidebar-state'

for (const operation of [
  'machine',
  'legacy-routing',
  'session-routing',
] as const) {
  test(`deferred sidebar ${operation} drops local state when authority changes at commit`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sidebar-authority-'))
    const file = join(dir, 'sidebar.json')
    try {
      await setSidebarState(structuredClone(DEFAULT_SIDEBAR_STATE), file)
      const before = readFileSync(file, 'utf8')
      let local = true
      let commits = 0
      const hooks = {
        canWrite: () => local,
        beforeRecheck: () => {
          commits++
          local = false
        },
      }
      if (operation === 'machine')
        await setSidebarMachineState(
          {
            ...structuredClone(DEFAULT_SIDEBAR_STATE),
            main: {
              ...DEFAULT_SIDEBAR_STATE.main,
              mainAccountId: 'local-only',
            },
            fallbacks: [],
          },
          file,
          hooks,
        )
      else if (operation === 'legacy-routing')
        await setSidebarLegacyRouting(
          {
            activeId: 'local-only',
            route: 'main-first',
            updatedAt: Date.now(),
          },
          file,
          hooks,
        )
      else
        await upsertSidebarActiveRouting(
          {
            sessionId: 'ses_1',
            activeId: 'local-only',
            route: 'main-first',
            updatedAt: Date.now(),
          },
          undefined,
          file,
          hooks,
        )
      expect(commits).toBe(1)
      expect(readFileSync(file, 'utf8')).toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

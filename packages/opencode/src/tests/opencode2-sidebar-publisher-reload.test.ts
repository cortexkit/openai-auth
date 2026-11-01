import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { acquireSidebarPublisher } from '../v2/sidebar-publisher'

// OpenCode 2 reloads a plugin in place, so an older bundle's publisher can
// still sit in the process-wide registry when a newer bundle acquires one.
const registry = (globalThis as unknown as Record<PropertyKey, unknown>)[
  Symbol.for('@cortexkit/openai-auth/opencode2-sidebar-publishers')
] as Map<string, unknown>

const dirs: string[] = []
const releases: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const release of releases.splice(0)) await release()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function sidebarFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oc2-sidebar-reload-'))
  dirs.push(dir)
  return join(dir, 'sidebar-state.json')
}

function producer(write: (...args: unknown[]) => Promise<void>) {
  const missing = join(tmpdir(), 'oc2-sidebar-reload-missing')
  return {
    paths: { configPath: missing, statePath: missing },
    source: { subscribe: () => () => {} },
    pins: { subscribe: () => () => {}, snapshot: () => [] },
    vault: {
      paths: { tokenPath: missing, statePath: missing, rosterPath: missing },
      snapshot: () => undefined,
    },
    write,
  } as never
}

test('a newer bundle replaces a publisher left by an older bundle', async () => {
  const file = sidebarFile()
  let oldAdds = 0
  let oldPublishes = 0
  // The shape a 1.9.3 publisher has: no protocol, its own builder inline.
  const older = {
    add: () => {
      oldAdds++
      return () => {}
    },
    publish: async () => {
      oldPublishes++
    },
    settled: async () => {},
    empty: false,
  }
  registry.set(resolve(file), older)
  const writes: unknown[] = []
  const handle = acquireSidebarPublisher(
    producer(async (target) => {
      writes.push(target)
    }),
    file,
    60_000,
  )
  releases.push(() => handle.release())
  await handle.publish()
  expect(oldAdds).toBe(0)
  expect(oldPublishes).toBe(0)
  expect(writes).toEqual([resolve(file)])
  expect(registry.get(resolve(file))).not.toBe(older)
})

test('a shared publisher builds each producer with that producer’s own code', async () => {
  const file = sidebarFile()
  const calls: string[] = []
  const first = acquireSidebarPublisher(
    producer(async () => {
      calls.push('first')
    }),
    file,
    60_000,
  )
  releases.push(() => first.release())
  const second = acquireSidebarPublisher(
    producer(async () => {
      calls.push('second')
    }),
    file,
    60_000,
  )
  releases.push(() => second.release())
  await second.publish()
  await first.publish()
  expect(calls).toEqual(['second', 'first'])
})

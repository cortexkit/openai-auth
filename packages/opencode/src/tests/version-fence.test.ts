// The version fence the account-pool migration waits on: it opens only when
// every live openai-auth process is the migrating version or newer, and it
// fails closed on anything it cannot read.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compareVersions,
  migrationFenceOpen,
  processHeartbeatDir,
  rpcStateRoot,
} from '../core/version-fence.ts'

const CURRENT = '0.12.0'
const SELF = 1_000
let stateHome: string
let live: Set<number>

beforeEach(() => {
  stateHome = mkdtempSync(join(tmpdir(), 'version-fence-'))
  live = new Set([SELF])
})
afterEach(() => {
  // Some tests make a directory unreadable; restore it so cleanup can
  // remove the temporary state home.
  for (const dir of [processHeartbeatDir(stateHome), rpcStateRoot(stateHome)])
    try {
      chmodSync(dir, 0o700)
    } catch {}
  rmSync(stateHome, { recursive: true, force: true })
})

function heartbeat(pid: number, body: unknown): string {
  const dir = processHeartbeatDir(stateHome)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${pid}.json`)
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body))
  return path
}

function portFile(pid: number, project = 'openai-auth-0123456789abcdef') {
  const dir = join(rpcStateRoot(stateHome), project)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `port-${pid}.json`)
  writeFileSync(path, JSON.stringify({ pid, port: 4000, startedAt: 1 }))
  return path
}

function fence(extra: { currentVersion?: string } = {}) {
  return migrationFenceOpen({
    stateHome,
    currentVersion: extra.currentVersion ?? CURRENT,
    isAlive: (pid) => live.has(pid),
    selfPid: SELF,
  })
}

describe('the version fence', () => {
  it('is open when no plugin process left anything on disk', async () => {
    expect(await fence()).toEqual({ open: true })
  })

  it('is open when every live heartbeat is the current version or newer', async () => {
    live.add(11).add(12)
    heartbeat(11, { pid: 11, version: CURRENT, startedAt: 1 })
    heartbeat(12, { pid: 12, version: '0.13.1', startedAt: 1 })
    portFile(11)
    portFile(12)
    expect(await fence()).toEqual({ open: true })
  })

  it('reads heartbeats exactly as the plugin writes them (process-heartbeat.ts)', async () => {
    // The writer's output: `${JSON.stringify(heartbeat)}\n` in a 0600 file,
    // written to `<pid>.json.<uuid>.tmp` and renamed into a 0700 directory.
    const dir = processHeartbeatDir(stateHome)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const write = (pid: number, version: string) => {
      const target = join(dir, `${pid}.json`)
      const temporary = `${target}.${crypto.randomUUID()}.tmp`
      writeFileSync(
        temporary,
        `${JSON.stringify({ pid, version, startedAt: 1_900_000_000_000 })}\n`,
        { mode: 0o600 },
      )
      renameSync(temporary, target)
      return target
    }
    live.add(71).add(72).add(73)
    write(71, CURRENT)
    portFile(71)
    expect(await fence()).toEqual({ open: true })
    const older = write(72, '0.11.0')
    portFile(72)
    // A temporary file left by an interrupted write is not a heartbeat.
    writeFileSync(join(dir, '73.json.0000.tmp'), '{"pid":73', { mode: 0o600 })
    expect(await fence()).toEqual({
      open: false,
      blockers: [{ pid: 72, version: '0.11.0', detail: older }],
    })
  })

  it('is shut by a live heartbeat of an older version', async () => {
    live.add(21)
    const path = heartbeat(21, { pid: 21, version: '0.11.4', startedAt: 1 })
    expect(await fence()).toEqual({
      open: false,
      blockers: [{ pid: 21, version: '0.11.4', detail: path }],
    })
  })

  it('a pre-release of the current version is older than it', async () => {
    live.add(22)
    heartbeat(22, { pid: 22, version: '0.12.0-beta.3', startedAt: 1 })
    expect(await fence()).toMatchObject({
      open: false,
      blockers: [{ pid: 22, version: '0.12.0-beta.3' }],
    })
  })

  it('ignores the heartbeat and the port file of a dead process', async () => {
    heartbeat(31, { pid: 31, version: '0.1.0', startedAt: 1 })
    portFile(31)
    portFile(32)
    expect(await fence()).toEqual({ open: true })
  })

  it('a live port file without a heartbeat is an older version', async () => {
    live.add(41)
    const path = portFile(41)
    expect(await fence()).toEqual({
      open: false,
      blockers: [{ pid: 41, version: 'unknown', detail: path }],
    })
  })

  it('finds port files in the unprefixed directories older versions used, and only in plugin directories', async () => {
    live.add(42).add(43)
    const path = portFile(42, 'fedcba9876543210')
    portFile(43, 'someone-else')
    expect(await fence()).toEqual({
      open: false,
      blockers: [{ pid: 42, version: 'unknown', detail: path }],
    })
  })

  it('a heartbeat decides over the same process port file', async () => {
    live.add(44)
    heartbeat(44, { pid: 44, version: CURRENT, startedAt: 1 })
    portFile(44)
    expect(await fence()).toEqual({ open: true })
  })

  it('never counts this process, whatever its files say', async () => {
    heartbeat(SELF, { pid: SELF, version: '0.0.1', startedAt: 1 })
    portFile(SELF)
    expect(await fence()).toEqual({ open: true })
  })

  it('an unparseable heartbeat of a live process blocks, as unknown', async () => {
    live.add(51).add(52).add(53)
    const torn = heartbeat(51, '{"pid":51,"vers')
    const wrongPid = heartbeat(52, { pid: 99, version: CURRENT, startedAt: 1 })
    const noVersion = heartbeat(53, { pid: 53, startedAt: 1 })
    expect(await fence()).toEqual({
      open: false,
      blockers: [
        { pid: 51, version: 'unknown', detail: torn },
        { pid: 52, version: 'unknown', detail: wrongPid },
        { pid: 53, version: 'unknown', detail: noVersion },
      ],
    })
  })

  it('a version it cannot compare blocks', async () => {
    live.add(54)
    heartbeat(54, { pid: 54, version: 'next', startedAt: 1 })
    expect(await fence()).toMatchObject({
      open: false,
      blockers: [{ pid: 54, version: 'next' }],
    })
    live.delete(54)
    live.add(55)
    heartbeat(55, { pid: 55, version: CURRENT, startedAt: 1 })
    expect(await fence({ currentVersion: 'not-a-version' })).toMatchObject({
      open: false,
      blockers: [{ pid: 55 }],
    })
  })

  it('an unreadable heartbeat file of a live process blocks', async () => {
    live.add(56)
    const path = heartbeat(56, { pid: 56, version: CURRENT, startedAt: 1 })
    chmodSync(path, 0o000)
    expect(await fence()).toEqual({
      open: false,
      blockers: [{ pid: 56, version: 'unknown', detail: path }],
    })
  })

  it('an unreadable heartbeat directory blocks', async () => {
    heartbeat(57, { pid: 57, version: CURRENT, startedAt: 1 })
    chmodSync(processHeartbeatDir(stateHome), 0o000)
    expect(await fence()).toMatchObject({
      open: false,
      blockers: [{ pid: 'unknown', version: 'unknown' }],
    })
  })

  it('an unreadable RPC directory blocks', async () => {
    portFile(58)
    chmodSync(rpcStateRoot(stateHome), 0o000)
    expect(await fence()).toMatchObject({
      open: false,
      blockers: [{ pid: 'unknown', version: 'unknown' }],
    })
  })

  it('an isAlive that throws counts the process as running', async () => {
    portFile(59)
    expect(
      await migrationFenceOpen({
        stateHome,
        currentVersion: CURRENT,
        selfPid: SELF,
        isAlive: () => {
          throw new Error('probe failed')
        },
      }),
    ).toMatchObject({ open: false, blockers: [{ pid: 59 }] })
  })

  it('by default a pid is alive while the operating system knows it', async () => {
    const exited = spawnSync(process.execPath, ['-e', '0']).pid
    portFile(process.pid)
    portFile(exited)
    const result = await migrationFenceOpen({
      stateHome,
      currentVersion: CURRENT,
      selfPid: SELF,
    })
    expect(result).toMatchObject({
      open: false,
      blockers: [{ pid: process.pid, version: 'unknown' }],
    })
    expect(result.open ? [] : result.blockers).toHaveLength(1)
  })

  it('an explicit RPC root replaces the default one', async () => {
    live.add(61)
    const root = join(stateHome, 'elsewhere')
    mkdirSync(join(root, 'openai-auth-0123456789abcdef'), { recursive: true })
    writeFileSync(
      join(root, 'openai-auth-0123456789abcdef', 'port-61.json'),
      '{}',
    )
    expect(
      await migrationFenceOpen({
        stateHome,
        rpcDir: root,
        currentVersion: CURRENT,
        isAlive: (pid) => live.has(pid),
        selfPid: SELF,
      }),
    ).toMatchObject({ open: false, blockers: [{ pid: 61 }] })
  })
})

describe('semver comparison', () => {
  it('orders versions by precedence', () => {
    expect(compareVersions('0.12.0', '0.12.0')).toBe(0)
    expect(compareVersions('v0.12.0+build.7', '0.12.0')).toBe(0)
    expect(compareVersions('0.11.9', '0.12.0')).toBe(-1)
    expect(compareVersions('0.12.1', '0.12.0')).toBe(1)
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1)
    expect(compareVersions('0.12.0-rc.1', '0.12.0')).toBe(-1)
    expect(compareVersions('0.12.0-alpha', '0.12.0-alpha.1')).toBe(-1)
    expect(compareVersions('0.12.0-alpha.2', '0.12.0-alpha.10')).toBe(-1)
    expect(compareVersions('0.12.0-2', '0.12.0-alpha')).toBe(-1)
    expect(compareVersions('0.12.0-beta', '0.12.0-alpha')).toBe(1)
    expect(compareVersions('0.12', '0.12.0')).toBeUndefined()
  })
})

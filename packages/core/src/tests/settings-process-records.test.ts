import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  aggregateProcessSettings,
  piProcessRecordDir,
  recordPiProcessSettings,
  SETTINGS_ADOPTING_VERSION,
  type SettingsFenceOptions,
  settingsFenceOpen,
  settingsProcessRoot,
} from '../settings-process-records'

const SELF = 1000
const BOOT = 1_900_000_000_000
const NOW = BOOT + 60 * 60 * 1000
const BEFORE_BOOT = BOOT - 5 * 60 * 1000 - 1
const OLDER = `${SETTINGS_ADOPTING_VERSION}-before-settings`
const [adoptingMajor, adoptingMinor] = SETTINGS_ADOPTING_VERSION.split('.').map(
  Number,
) as [number, number, number]
const OLDER_RELEASE = `${adoptingMajor}.${adoptingMinor - 1}.999`
const NEWER = `${adoptingMajor + 1}.0.0-alpha.1`
let stateHome: string
let live: Set<number>

beforeEach(() => {
  const scratch = resolve(import.meta.dir, '../../../../target/scratch')
  mkdirSync(scratch, { recursive: true })
  stateHome = mkdtempSync(join(scratch, 'settings-records-'))
  live = new Set([SELF, 11])
})
afterEach(() => rmSync(stateHome, { recursive: true, force: true }))

function seed(path: string, body: unknown): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body))
  return path
}

function record(
  host: 'processes' | 'pi-processes',
  fields: Record<string, unknown> = {},
) {
  return seed(join(settingsProcessRoot(stateHome), host, '11.json'), {
    pid: 11,
    version: SETTINGS_ADOPTING_VERSION,
    startedAt: NOW,
    ...fields,
  })
}

function port(
  fields: Record<string, unknown> = {},
  project = 'openai-auth-0123456789abcdef',
) {
  return seed(
    join(settingsProcessRoot(stateHome), 'rpc', project, 'port-11.json'),
    {
      pid: 11,
      version: SETTINGS_ADOPTING_VERSION,
      startedAt: NOW,
      ...fields,
    },
  )
}

function fence(options: SettingsFenceOptions = {}) {
  return settingsFenceOpen({
    stateHome,
    selfPid: SELF,
    isAlive: (pid) => live.has(pid),
    now: () => NOW,
    uptime: () => 3600,
    ...options,
  })
}

describe('settings adoption fence', () => {
  it('uses the fixed adopting release, not a host package version', () => {
    expect(SETTINGS_ADOPTING_VERSION).toBe('1.15.0')
  })

  it('is open with no process directories', async () => {
    expect(await fence()).toEqual({ open: true })
  })

  it.each([undefined, 'shared'])(
    'allows an adopting heartbeat with settings=%s',
    async (settings) => {
      record('processes', { settings })
      expect(await fence()).toEqual({ open: true })
    },
  )

  it.each([
    OLDER,
    OLDER_RELEASE,
    'next',
    `${adoptingMajor + 1}.999999999999999999999.0`,
    undefined,
  ])(
    'blocks a heartbeat below adoption or with an unknown version: %s',
    async (version) => {
      const path = record('processes', { version })
      expect(await fence()).toEqual({
        open: false,
        blockers: [{ pid: 11, version: version ?? 'unknown', detail: path }],
      })
    },
  )

  it.each([
    SETTINGS_ADOPTING_VERSION,
    `v${SETTINGS_ADOPTING_VERSION}+build.1`,
    NEWER,
  ])('allows shared at or above adoption: %s', async (version) => {
    record('processes', { version, settings: 'shared' })
    expect(await fence()).toEqual({ open: true })
  })

  for (const host of ['processes', 'pi-processes'] as const) {
    describe(host, () => {
      it('keeps a live legacy process blocking after an older process exits', async () => {
        const path = record(host, { settings: 'legacy' })
        const old = seed(
          join(settingsProcessRoot(stateHome), 'processes', '12.json'),
          { pid: 12, version: OLDER, startedAt: NOW },
        )
        live.add(12)
        expect((await fence()).open).toBe(false)
        live.delete(12)
        expect(await fence()).toEqual({
          open: false,
          blockers: [
            { pid: 11, version: SETTINGS_ADOPTING_VERSION, detail: path },
          ],
        })
        expect(existsSync(old)).toBe(true)
        live.delete(11)
        expect(await fence()).toEqual({ open: true })
      })

      it('a separate record never blocks, even with an older version', async () => {
        record(host, { version: OLDER, settings: 'separate' })
        expect(await fence()).toEqual({ open: true })
      })

      it('ignores dead pids, including unreadable records', async () => {
        const path = record(host, { settings: 'legacy' })
        writeFileSync(path, '{')
        live.delete(11)
        expect(await fence()).toEqual({ open: true })
      })

      it('removes a pre-boot record even when its pid has been reused', async () => {
        const path = record(host, {
          startedAt: BEFORE_BOOT,
          settings: 'legacy',
        })
        expect(await fence()).toEqual({ open: true })
        expect(existsSync(path)).toBe(false)
      })

      it('keeps a record inside the boot-time uncertainty margin', async () => {
        record(host, { startedAt: BOOT - 5 * 60 * 1000, settings: 'legacy' })
        expect((await fence()).open).toBe(false)
      })

      it.each([
        '{',
        'null',
        '[]',
        '{"pid":12}',
        '{"pid":11,"settings":"invalid"}',
      ])(
        'fails closed on an unreadable or invalid record: %s',
        async (text) => {
          const path = record(host)
          writeFileSync(path, text)
          expect((await fence()).open).toBe(false)
        },
      )

      it('fails closed on a live record that cannot be read as a file', async () => {
        const path = record(host)
        rmSync(path)
        mkdirSync(path)
        expect(await fence()).toEqual({
          open: false,
          blockers: [{ pid: 11, version: 'unknown', detail: path }],
        })
      })

      it('fails closed when the records directory cannot be listed', async () => {
        const dir = join(settingsProcessRoot(stateHome), host)
        seed(dir, '{}')
        expect(await fence()).toEqual({
          open: false,
          blockers: [{ pid: 'unknown', version: 'unknown', detail: dir }],
        })
      })

      it('ignores this process and interrupted temporary writes', async () => {
        seed(join(settingsProcessRoot(stateHome), host, `${SELF}.json`), '{')
        seed(
          join(settingsProcessRoot(stateHome), host, '11.json.interrupted.tmp'),
          '{',
        )
        expect(await fence()).toEqual({ open: true })
      })
    })
  }

  it.each(['0.0.1', 'next', undefined])(
    'never compares Pi version %s with OpenCode adoption',
    async (version) => {
      record('pi-processes', { version, settings: 'shared' })
      expect(await fence()).toEqual({ open: true })
    },
  )

  it('fails closed for a Pi record with no settings decision', async () => {
    record('pi-processes')
    expect((await fence()).open).toBe(false)
  })

  it('treats uncertain liveness as alive', async () => {
    record('processes', { settings: 'legacy' })
    expect(
      (
        await fence({
          isAlive: () => {
            throw new Error('unknown')
          },
        })
      ).open,
    ).toBe(false)
  })
})

describe('independent OpenCode port evidence', () => {
  it.each(['shared', 'separate'])(
    'a %s heartbeat cannot exonerate an older port for the same live pid',
    async (settings) => {
      record('processes', { settings })
      const path = port({ version: OLDER })
      expect(await fence()).toEqual({
        open: false,
        blockers: [{ pid: 11, version: OLDER, detail: path }],
      })
    },
  )

  it.each([undefined, 'next'])(
    'fails closed on a port with version %s',
    async (version) => {
      const path = port({ version })
      expect(await fence()).toEqual({
        open: false,
        blockers: [{ pid: 11, version: version ?? 'unknown', detail: path }],
      })
    },
  )

  it('accepts an adopting port in the old unprefixed project folder', async () => {
    port({}, '0123456789abcdef')
    expect(await fence()).toEqual({ open: true })
  })

  it('ignores an unrelated project directory and a plain file with a managed name', async () => {
    port({ version: OLDER }, 'other-plugin')
    seed(join(settingsProcessRoot(stateHome), 'rpc', '0123456789abcdef'), '{')
    expect(await fence()).toEqual({ open: true })
  })

  it('ignores a pre-boot port, falling back to mtime only when startedAt is absent', async () => {
    const path = port({ version: OLDER, startedAt: BEFORE_BOOT })
    expect(await fence()).toEqual({ open: true })
    port({ version: OLDER, startedAt: undefined })
    utimesSync(path, new Date(BEFORE_BOOT), new Date(BEFORE_BOOT))
    expect(await fence()).toEqual({ open: true })
    port({ version: OLDER, startedAt: NOW })
    utimesSync(path, new Date(BEFORE_BOOT), new Date(BEFORE_BOOT))
    expect((await fence()).open).toBe(false)
  })

  it('fails closed on an unreadable live port but ignores a dead pid', async () => {
    const path = port()
    writeFileSync(path, '{')
    expect((await fence()).open).toBe(false)
    live.delete(11)
    expect(await fence()).toEqual({ open: true })
  })

  it('fails closed when the RPC root cannot be listed', async () => {
    const rpcDir = seed(join(stateHome, 'not-a-directory'), '{}')
    expect(await fence({ rpcDir })).toEqual({
      open: false,
      blockers: [{ pid: 'unknown', version: 'unknown', detail: rpcDir }],
    })
  })
})

describe('Pi process writer', () => {
  function write(
    config: string,
    settings: 'legacy' | 'shared' | 'separate',
    extra = {},
  ) {
    return recordPiProcessSettings({
      configPath: join(stateHome, config),
      settings,
      version: '0.1.0',
      stateHome,
      pid: 11,
      now: () => NOW,
      ...extra,
    })
  }

  it('writes one private complete record beside OpenCode, by temporary file and rename', async () => {
    const path = await write('a.json', 'shared')
    expect(path).toBe(join(piProcessRecordDir(stateHome), '11.json'))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      pid: 11,
      version: '0.1.0',
      startedAt: NOW,
      settings: 'shared',
    })
    expect(readdirSync(piProcessRecordDir(stateHome))).toEqual(['11.json'])
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
    }
    expect(await fence()).toEqual({ open: true })
  })

  it('aggregates all configs and preserves their first choices and start time', async () => {
    const path = await write('a.json', 'separate')
    expect(JSON.parse(readFileSync(path, 'utf8')).settings).toBe('separate')
    await write('b.json', 'shared', { now: () => NOW + 1 })
    expect(JSON.parse(readFileSync(path, 'utf8')).settings).toBe('shared')
    await write('c.json', 'legacy')
    await write('c.json', 'shared')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      settings: 'legacy',
      startedAt: NOW,
    })
  })

  it('serializes concurrent writes so shared cannot replace legacy', async () => {
    const [path] = await Promise.all([
      write('a.json', 'shared'),
      write('b.json', 'legacy'),
      write('c.json', 'separate'),
    ])
    expect(JSON.parse(readFileSync(path, 'utf8')).settings).toBe('legacy')
  })

  it('reports directory-creation failure to the decision caller', async () => {
    const dir = seed(join(stateHome, 'file'), '{}')
    await expect(write('a.json', 'legacy', { dir })).rejects.toThrow()
  })

  it('reports rename failure and cleans only its temporary file', async () => {
    const dir = piProcessRecordDir(stateHome)
    mkdirSync(join(dir, '11.json'), { recursive: true })
    await expect(write('a.json', 'legacy')).rejects.toThrow()
    expect(readdirSync(dir)).toEqual(['11.json'])
  })

  it('uses the same aggregate precedence in either mixed-instance order', () => {
    expect(aggregateProcessSettings(['shared', 'separate'])).toBe('shared')
    expect(aggregateProcessSettings(['separate', 'shared'])).toBe('shared')
    expect(aggregateProcessSettings(['legacy', 'shared', 'separate'])).toBe(
      'legacy',
    )
    expect(aggregateProcessSettings(['separate', 'shared', 'legacy'])).toBe(
      'legacy',
    )
    expect(aggregateProcessSettings(['separate', 'separate'])).toBe('separate')
    expect(aggregateProcessSettings([])).toBeUndefined()
  })
})

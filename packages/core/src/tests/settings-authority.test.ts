import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import * as commonFs from '@cortexkit/common-auth/fs'
import { POOL_LOCK_DEFAULTS } from '@cortexkit/common-auth/store'
import {
  __resetProcessHeartbeatForTest,
  recordProcessSettings,
} from '../../../opencode/src/core/process-heartbeat.js'
import {
  decideSettingsAuthority,
  getSettingsAuthority,
  SettingsAuthorityRefusal,
} from '../settings-authority.js'
import { getSettingsDecision } from '../settings-decisions.js'
import {
  resolveDefaultSettingsStores,
  resolveSettingsInstall,
  type SettingsHost,
  type SettingsInstall,
} from '../settings-install.js'
import * as mover from '../settings-move.js'
import * as records from '../settings-process-records.js'

const roots: string[] = []
const scratch = resolve(import.meta.dir, '../../../../target/scratch')
const children: Actor[] = []

afterEach(async () => {
  mock.restore()
  __resetProcessHeartbeatForTest()
  for (const child of children.splice(0)) await child.stop()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('settings authority lock and record safety', () => {
  it('makes the fixed records root private before locking with the pool defaults, and records under the lock', async () => {
    const f = await fixture()
    await mkdir(f.folder, { recursive: true, mode: 0o777 })
    const actualLock = commonFs.withLock
    const lock = spyOn(commonFs, 'withLock').mockImplementation(
      async (path, options, work) => {
        expect(path).toBe(join(f.folder, 'settings-authority'))
        expect(options).toEqual({
          name: 'settings-authority',
          ...POOL_LOCK_DEFAULTS,
        })
        if (process.platform !== 'win32')
          expect((await stat(f.folder)).mode & 0o777).toBe(0o700)
        return actualLock(path, options, work)
      },
    )
    // Avoid the mover's locks so this assertion isolates the startup lock.
    spyOn(records, 'settingsFenceOpen').mockResolvedValue({
      open: false,
      blockers: [],
    })
    const record = f.input.record
    f.input.record = mock(async (settings) => {
      const competing = await commonFs.acquireRefreshFileLock({
        path: join(f.folder, 'settings-authority'),
        name: 'settings-authority',
        ttlMs: POOL_LOCK_DEFAULTS.ttlMs,
      })
      if (competing) await competing.release()
      expect(competing).toBeNull()
      return record(settings)
    })
    await decideSettingsAuthority(f.input)
    expect(lock).toHaveBeenCalledTimes(1)
    expect((await f.saved()).settings).toBe('legacy')
  })

  for (const host of ['opencode', 'pi'] as const) {
    for (const failure of ['folder', 'lock', 'record'] as const) {
      for (const state of ['source', 'existing', 'removed', 'fresh'] as const) {
        it(`${host}: ${failure} failure ${state === 'source' ? 'refuses' : 'does not refuse'} with ${state}`, async () => {
          const f = await fixture(state !== 'fresh', host)
          if (state === 'existing') await put(f.install.target, '{}')
          if (state === 'removed')
            await put(
              `${f.sources[1]!.configPath}.MOVED_READPLEASE`,
              `Settings moved to ${f.install.target}.\n`,
            )
          spyOn(records, 'settingsFenceOpen').mockResolvedValue({
            open: false,
            blockers: [],
          })
          if (failure === 'folder') await put(f.folder, 'not a directory')
          if (failure === 'lock')
            spyOn(commonFs, 'withLock').mockRejectedValue(
              new Error('injected authority timeout'),
            )
          if (failure === 'record')
            await mkdir(join(f.dir, `${process.pid}.json`), { recursive: true })
          const pending = decideSettingsAuthority(f.input)
          if (state === 'source') {
            const refusal = await pending.catch((error) => error)
            expect(refusal).toBeInstanceOf(SettingsAuthorityRefusal)
            expect(refusal.folder).toBe(f.folder)
            expect(refusal.message).toContain(f.folder)
            expect(refusal.cause).toBeInstanceOf(Error)
            expect(refusal.message).toContain(refusal.cause.message)
            expect(
              getSettingsDecision(f.install.configIdentity),
            ).toBeUndefined()
            expect(getSettingsAuthority(f.install.configIdentity)).toBe(pending)
          } else {
            const result = await pending
            expect(result.decision).toBe('shared')
            expect(getSettingsDecision(f.install.configIdentity)).toBe('shared')
            expect(result.ranMove).toBe(false)
          }
          expect(existsSync(f.install.target)).toBe(state === 'existing')
        })
      }
    }
  }
})

async function put(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

async function fixture(source = true, host: SettingsHost = 'pi') {
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, 'settings-authority-'))
  roots.push(root)
  const stateHome = join(root, 'state')
  const env = {
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_STATE_HOME: stateHome,
  }
  const options = { env, platform: 'linux' as const, homedir: () => root }
  const sources = resolveDefaultSettingsStores(options)
  if (source)
    await put(sources[1]!.configPath, '{"routing":{"mode":"sticky-balanced"}}')
  const install = resolveSettingsInstall({
    ...options,
    host,
    paths: sources[host === 'pi' ? 1 : 0]!,
  })
  const folder = records.settingsProcessRoot(stateHome)
  const dir = join(folder, host === 'pi' ? 'pi-processes' : 'processes')
  const record = mock(async (settings: 'shared' | 'legacy' | 'separate') => {
    const input = {
      configPath: install.configIdentity,
      settings,
      version: records.SETTINGS_ADOPTING_VERSION,
      dir,
    }
    if (host === 'pi') return records.recordPiProcessSettings(input)
    return recordProcessSettings(input)
  })
  const warnings: string[] = []
  const input = {
    install,
    stateHome,
    record,
    log: { warn: (line: string) => warnings.push(line) },
    fenceOptions: { isAlive: () => false },
  }
  return {
    root,
    stateHome,
    sources,
    install,
    folder,
    dir,
    input,
    warnings,
    record,
    async saved() {
      return JSON.parse(
        await readFile(join(dir, `${process.pid}.json`), 'utf8'),
      )
    },
  }
}

function moveResult(outcome: mover.SettingsMoveResult['outcome']) {
  return {
    outcome,
    unmapped: [],
    differing: [],
    noteFailures: [],
    postPublishFailures: [],
  }
}

describe('settings authority startup branches', () => {
  for (const host of ['opencode', 'pi'] as const) {
    it(`${host}: makes one decision and one settings record for two plugin instances on one config`, async () => {
      const f = await fixture(true, host)
      const move = spyOn(mover, 'runSettingsMove')
      const first = decideSettingsAuthority(f.input)
      const second = decideSettingsAuthority({
        ...f.input,
        install: {
          ...f.install,
          configIdentity: join(
            dirname(f.install.configIdentity),
            '.',
            'openai-auth.json',
          ),
        },
      })
      expect(first).toBe(second)
      const result = await first
      expect(result.decision).toBe('shared')
      expect(result.ranMove).toBe(true)
      expect(result.move?.outcome).toBe('moved')
      expect(result.completion?.completed).toBe(true)
      expect(move).toHaveBeenCalledTimes(1)
      expect(f.record).toHaveBeenCalledTimes(1)
      expect((await f.saved()).settings).toBe('shared')
      expect(getSettingsDecision(f.install.configIdentity)).toBe('shared')
      expect(getSettingsAuthority(f.install.configIdentity)).toBe(first)
    })
  }

  for (const branch of ['existing', 'removed', 'fresh'] as const) {
    it(`records shared for ${branch} without a move or fence check`, async () => {
      const f = await fixture(branch !== 'fresh')
      if (branch === 'existing')
        await put(f.install.target, '{broken on purpose')
      if (branch === 'removed')
        await put(
          `${f.sources[1]!.configPath}.MOVED_READPLEASE`,
          `Settings moved to ${f.install.target}.\nA rollback loses changes made after the move.\n`,
        )
      const move = spyOn(mover, 'runSettingsMove')
      const fence = spyOn(records, 'settingsFenceOpen')
      const result = await decideSettingsAuthority(f.input)
      expect(result.decision).toBe('shared')
      expect(result.ranMove).toBe(false)
      expect(result.completion?.kind).toBe(
        branch === 'existing'
          ? 'target-exists'
          : branch === 'removed'
            ? 'target-removed'
            : 'no-source',
      )
      expect(move).not.toHaveBeenCalled()
      expect(fence).not.toHaveBeenCalled()
      expect((await f.saved()).settings).toBe('shared')
      expect(existsSync(f.install.target)).toBe(branch === 'existing')
    })
  }

  it('records legacy with the fence blockers and does not retry during this process', async () => {
    const f = await fixture()
    const fenceResult = {
      open: false as const,
      blockers: [{ pid: 42, version: 'old', detail: 'another process' }],
    }
    const fence = spyOn(records, 'settingsFenceOpen').mockResolvedValue(
      fenceResult,
    )
    const move = spyOn(mover, 'runSettingsMove')
    const result = await decideSettingsAuthority(f.input)
    expect(result).toMatchObject({
      decision: 'legacy',
      ranMove: false,
      fence: fenceResult,
    })
    expect((await f.saved()).settings).toBe('legacy')
    expect(getSettingsDecision(f.install.configIdentity)).toBe('legacy')
    fence.mockResolvedValue({ open: true })
    expect(await decideSettingsAuthority(f.input)).toBe(result)
    expect(move).not.toHaveBeenCalled()
    expect(f.record).toHaveBeenCalledTimes(1)
  })

  for (const outcome of [
    'moved',
    'done-already',
    'aborted-target-appeared',
    'fence-closed',
    'busy',
    'failed',
  ] as const) {
    for (const completed of [false, true]) {
      it(`${outcome} with completion=${completed} retains its move report and records the safe choice`, async () => {
        const f = await fixture()
        const report = {
          ...moveResult(outcome),
          ...(outcome === 'failed'
            ? { failure: { kind: 'setting' as const, setting: 'quota_minima' } }
            : {}),
        }
        spyOn(mover, 'runSettingsMove').mockImplementation(async () => {
          if (completed) await put(f.install.target, '{}')
          return report
        })
        const result = await decideSettingsAuthority(f.input)
        const shared =
          completed ||
          ['moved', 'done-already', 'aborted-target-appeared'].includes(outcome)
        expect(result.decision).toBe(shared ? 'shared' : 'legacy')
        expect(result.move).toBe(report)
        expect(result.ranMove).toBe(true)
        expect((await f.saved()).settings).toBe(result.decision)
      })
    }
  }

  it('an exception inside the mover is a failed move, not a refusal', async () => {
    const f = await fixture()
    const cause = new Error('move publication failed')
    spyOn(mover, 'runSettingsMove').mockRejectedValue(cause)
    const result = await decideSettingsAuthority(f.input)
    expect(result).toMatchObject({
      decision: 'legacy',
      ranMove: true,
      move: { outcome: 'failed', cause },
    })
    expect((await f.saved()).settings).toBe('legacy')
  })

  it('keeps the blockers when the fence closes inside the mover', async () => {
    const f = await fixture()
    const closed = {
      open: false as const,
      blockers: [{ pid: 42, version: 'old', detail: 'another process' }],
    }
    spyOn(records, 'settingsFenceOpen')
      .mockResolvedValueOnce({ open: true })
      .mockResolvedValue(closed)
    const result = await decideSettingsAuthority(f.input)
    expect(result).toMatchObject({
      decision: 'legacy',
      ranMove: true,
      move: { outcome: 'fence-closed' },
      fence: closed,
    })
  })

  for (const failure of ['synchronous', 'asynchronous'] as const) {
    it(`separate installs take no authority lock or move, and ignore ${failure} record failure`, async () => {
      const f = await fixture()
      const lock = spyOn(commonFs, 'withLock')
      const move = spyOn(mover, 'runSettingsMove')
      if (failure === 'synchronous')
        f.record.mockImplementation(() => {
          throw new Error('unwritable record')
        })
      else f.record.mockRejectedValue(new Error('unwritable record'))
      const result = await decideSettingsAuthority({
        ...f.input,
        install: { ...f.install, separate: true },
      })
      expect(result).toMatchObject({ decision: 'separate', ranMove: false })
      expect(lock).not.toHaveBeenCalled()
      expect(move).not.toHaveBeenCalled()
      expect(f.record).toHaveBeenCalledWith('separate')
      expect(existsSync(f.folder)).toBe(false)
    })
  }
})

// Each actor has its own global decision cache and real pid. IPC barriers hold
// exact publication/record/lock-observation boundaries, not elapsed wall time.
const actorProgram = `
import { spyOn } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as commonFs from '@cortexkit/common-auth/fs';
import * as commonSettings from '@cortexkit/common-auth/settings';
import { decideSettingsAuthority } from ${JSON.stringify(new URL('../settings-authority.ts', import.meta.url).href)};
import { recordPiProcessSettings, settingsProcessRoot, SETTINGS_ADOPTING_VERSION } from ${JSON.stringify(new URL('../settings-process-records.ts', import.meta.url).href)};
import { recordProcessSettings } from ${JSON.stringify(new URL('../../../opencode/src/core/process-heartbeat.ts', import.meta.url).href)};
const input = JSON.parse(process.argv[1]);
const commands = new Map();
process.on('message', (name) => {
  const pending = commands.get(name);
  if (typeof pending === 'function') { commands.delete(name); pending(); }
  else commands.set(name, true);
});
const wait = (name) => new Promise(resolve => {
  if (commands.get(name) === true) { commands.delete(name); resolve(); }
  else commands.set(name, resolve);
});
const barrier = async (name) => { process.send({ event: name }); await wait(name); };
const put = async (path, text) => { await mkdir(dirname(path), {recursive:true}); await writeFile(path, text); };
let clock = 0;
if (input.waitBoundary) spyOn(performance, 'now').mockImplementation(() => clock);
const actualLock = commonFs.withLock;
spyOn(commonFs, 'withLock').mockImplementation(async (path, options, work) => {
  process.send({event:'lock-attempt'});
  let observed = false;
  return actualLock(path, {
    ...options,
    ...(input.waitBoundary ? {timeoutMs:100, onStep: async step => {
      if (!observed && step === 'lock-read-ready') {
        observed = true;
        await barrier('contended');
        clock = input.waitBoundary === 'past' ? 101 : 50;
      }
    }} : {})
  }, async lock => {
    process.send({event:'lock-acquired'});
    return work(lock);
  });
});
if (input.beforePublish) {
  const actualMove = commonSettings.moveSettingsOnce;
  spyOn(commonSettings, 'moveSettingsOnce').mockImplementation(options => actualMove({
    ...options,
    map: async legacy => {
      const mapped = await options.map(legacy);
      await barrier('before-publish');
      return mapped;
    }
  }));
}
await barrier('ready');
if (input.older) {
  const [major, minor] = SETTINGS_ADOPTING_VERSION.split('.').map(Number);
  await put(join(settingsProcessRoot(input.stateHome), 'processes', process.pid + '.json'), JSON.stringify({
    pid:process.pid, version:major + '.' + (minor - 1) + '.999', startedAt:Date.now(), layouts:{}
  }));
  process.send({event:'older-ready'});
} else {
  let oldWrites = 0;
  try {
    const result = await decideSettingsAuthority({
      install:input.install,
      stateHome:input.stateHome,
      log:{warn(){}},
      record:async settings => {
        if (input.beforeRecord) await barrier('before-record');
        const args = {configPath:input.install.configIdentity, settings, version:SETTINGS_ADOPTING_VERSION};
        if (input.install.host === 'pi') await recordPiProcessSettings({...args, stateHome:input.stateHome});
        else await recordProcessSettings({...args, dir:join(settingsProcessRoot(input.stateHome), 'processes')});
        process.send({event:'recorded', settings});
      }
    });
    if (input.edit && result.decision === 'legacy') {
      const path = input.install.sources.find(s => s.host === input.install.host).configPath;
      const store = JSON.parse(await readFile(path, 'utf8'));
      store.routing = {mode:input.edit};
      await writeFile(path, JSON.stringify(store));
      oldWrites++;
    }
    process.send({event:'result', decision:result.decision, outcome:result.move?.outcome, ranMove:result.ranMove, oldWrites});
  } catch (error) {
    process.send({event:'result', refused:error.name === 'SettingsAuthorityRefusal', message:error.message, oldWrites});
  }
}
await wait('stop');
process.exit(0);
`

interface ActorEvent {
  event: string
  decision?: string
  outcome?: string
  ranMove?: boolean
  oldWrites?: number
  refused?: boolean
  message?: string
}

interface Actor {
  pid: number
  observed: ActorEvent[]
  wait(name: string): Promise<ActorEvent>
  release(name: string): void
  start(): Promise<Actor>
  stop(): Promise<void>
  exit(): Promise<void>
}

function actor(input: {
  install: SettingsInstall
  stateHome: string
  older?: boolean
  beforePublish?: boolean
  beforeRecord?: boolean
  waitBoundary?: 'below' | 'past'
  edit?: string
}): Actor {
  const events = new Map<string, ActorEvent[]>()
  const pending = new Map<string, (event: ActorEvent) => void>()
  const observed: ActorEvent[] = []
  const child = Bun.spawn(
    [process.execPath, '-e', actorProgram, JSON.stringify(input)],
    {
      cwd: resolve(import.meta.dir, '../..'),
      stdout: 'pipe',
      stderr: 'pipe',
      ipc(message) {
        const event = message as ActorEvent
        observed.push(event)
        const listener = pending.get(event.event)
        if (listener) {
          pending.delete(event.event)
          listener(event)
        } else {
          const queue = events.get(event.event) ?? []
          queue.push(event)
          events.set(event.event, queue)
        }
      },
    },
  )
  const stderr = new Response(child.stderr).text()
  const exited = child.exited.then(async (code) => {
    const output = await stderr
    return new Error(`Authority actor exited ${code}: ${output}`)
  })
  const handle: Actor = {
    pid: child.pid,
    observed,
    async wait(name: string): Promise<ActorEvent> {
      const queued = events.get(name)?.shift()
      if (queued) return queued
      return Promise.race([
        new Promise<ActorEvent>((resolve) => pending.set(name, resolve)),
        exited.then((error) => {
          throw error
        }),
      ])
    },
    release(name: string) {
      child.send(name)
    },
    async start() {
      await handle.wait('ready')
      child.send('ready')
      return handle
    },
    async stop() {
      if (child.exitCode === null) child.kill()
      await child.exited
    },
    async exit() {
      child.send('stop')
      expect(await child.exited).toBe(0)
    },
  }
  children.push(handle)
  return handle
}

describe('settings authority across processes', () => {
  it('a starter between the mover fence scan and publication waits, then uses shared without an old-store write', async () => {
    const f = await fixture()
    const a = await actor({ ...f.input, beforePublish: true }).start()
    await a.wait('before-publish')
    const b = await actor({
      ...f.input,
      waitBoundary: 'below',
      edit: 'main-first',
    }).start()
    await b.wait('contended')
    expect(b.observed.some((e) => e.event === 'recorded')).toBe(false)
    a.release('before-publish')
    expect(await a.wait('result')).toMatchObject({
      decision: 'shared',
      outcome: 'moved',
    })
    b.release('contended')
    expect(await b.wait('result')).toMatchObject({
      decision: 'shared',
      ranMove: false,
      oldWrites: 0,
    })
    expect(
      JSON.parse(await readFile(f.sources[1]!.configPath, 'utf8')).routing.mode,
    ).toBe('sticky-balanced')
  })

  it('simultaneous first starts with no records folder move once and refuse none', async () => {
    const f = await fixture()
    expect(existsSync(f.folder)).toBe(false)
    const actors = Array.from({ length: 4 }, () => actor(f.input))
    await Promise.all(actors.map((a) => a.start()))
    const results = await Promise.all(actors.map((a) => a.wait('result')))
    expect(results.filter((r) => r.outcome === 'moved')).toHaveLength(1)
    expect(results.every((r) => r.decision === 'shared' && !r.refused)).toBe(
      true,
    )
  })

  it('a file created after the locked recheck gives aborted-target-appeared and never writes old preferences', async () => {
    const f = await fixture()
    const a = await actor({
      ...f.input,
      beforePublish: true,
      edit: 'main-first',
    }).start()
    await a.wait('before-publish')
    await put(f.install.target, '{"routing_mode":"main-first"}')
    a.release('before-publish')
    expect(await a.wait('result')).toMatchObject({
      decision: 'shared',
      outcome: 'aborted-target-appeared',
      oldWrites: 0,
    })
    expect(await readFile(f.install.target, 'utf8')).toBe(
      '{"routing_mode":"main-first"}',
    )
  })

  it('different targets sharing Pi cannot scan the fence until a pending legacy record is on disk', async () => {
    const f = await fixture()
    const old = await actor({ ...f.input, older: true }).start()
    await old.wait('older-ready')
    const a = await actor({ ...f.input, beforeRecord: true }).start()
    await a.wait('before-record')
    await old.exit()
    const b = await actor({
      ...f.input,
      install: {
        ...f.install,
        target: join(f.root, 'other', 'settings.jsonc'),
      },
      waitBoundary: 'below',
    }).start()
    await b.wait('contended')
    expect(b.observed.some((e) => e.event === 'lock-acquired')).toBe(false)
    expect(existsSync(join(f.root, 'other', 'settings.jsonc'))).toBe(false)
    a.release('before-record')
    expect(await a.wait('result')).toMatchObject({ decision: 'legacy' })
    b.release('contended')
    expect(await b.wait('result')).toMatchObject({
      decision: 'legacy',
      ranMove: false,
    })
  })

  it('an adopting legacy process fences the next start and its preference edit moves only after it exits', async () => {
    const f = await fixture()
    const old = await actor({ ...f.input, older: true }).start()
    await old.wait('older-ready')
    const a = await actor({ ...f.input, edit: 'fallback-first' }).start()
    expect(await a.wait('result')).toMatchObject({
      decision: 'legacy',
      oldWrites: 1,
    })
    await old.exit()
    const b = await actor(f.input).start()
    expect(await b.wait('result')).toMatchObject({
      decision: 'legacy',
      ranMove: false,
    })
    await a.exit()
    await b.exit()
    const c = await actor(f.input).start()
    expect(await c.wait('result')).toMatchObject({
      decision: 'shared',
      outcome: 'moved',
    })
    const shared = JSON.parse(
      (await readFile(f.install.target, 'utf8')).replace(/^\/\/.*$/gm, ''),
    )
    expect(shared.routing_mode).toBe('fallback-first')
  })

  it('a short lock deadline exceeded at a barrier refuses a starter before any old-store write', async () => {
    const f = await fixture()
    const a = await actor({ ...f.input, beforePublish: true }).start()
    await a.wait('before-publish')
    const b = await actor({
      ...f.input,
      waitBoundary: 'past',
      edit: 'main-first',
    }).start()
    await b.wait('contended')
    b.release('contended')
    const refusal = await b.wait('result')
    expect(refusal).toMatchObject({ refused: true, oldWrites: 0 })
    expect(refusal.message).toContain(f.folder)
    expect(refusal.message).toContain('Timed out acquiring settings-authority')
    a.release('before-publish')
    expect(await a.wait('result')).toMatchObject({ decision: 'shared' })
  })

  it('a completed move discovered after the short lock deadline is shared, not refused', async () => {
    const f = await fixture()
    const a = await actor({ ...f.input, beforePublish: true }).start()
    await a.wait('before-publish')
    const b = await actor({
      ...f.input,
      waitBoundary: 'past',
      edit: 'main-first',
    }).start()
    await b.wait('contended')
    await put(f.install.target, '{}')
    b.release('contended')
    expect(await b.wait('result')).toMatchObject({
      decision: 'shared',
      ranMove: false,
      oldWrites: 0,
    })
    expect(b.observed.some((e) => e.event === 'recorded')).toBe(false)
    a.release('before-publish')
    expect(await a.wait('result')).toMatchObject({
      decision: 'shared',
      outcome: 'aborted-target-appeared',
    })
  })
})

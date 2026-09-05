import { describe, expect, mock, test } from 'bun:test'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveAccounts } from '../core/accounts.ts'
import { acquireCustodyTransitionMutex } from '../core/custody-transition.ts'
import { CodexAuthPlugin } from '../index.ts'
import { getSidebarState } from '../sidebar-state.ts'
import {
  claustrumConfig,
  enrollmentManifest,
  liveStorage,
} from './custody-fixtures.ts'

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

async function waitForSleep(
  sleeps: Array<Deferred<void>>,
  count = 1,
): Promise<void> {
  for (let turn = 0; turn < 32; turn += 1) {
    if (sleeps.length >= count) return
    await Promise.resolve()
  }
  throw new Error('expected host readback poller to sleep')
}

type TokenResponse = {
  access_token: string
  refresh_token: string
  id_token: string
  expires_in: number
}

type Authorize = () => Promise<{
  callback(): Promise<{ access: string; refresh: string }>
}>

type HostOauth = {
  type: 'oauth'
  access: string
  refresh: string
  expires: number
}

type VerifiedMainLoginRecord = {
  mainSlotFamilyFingerprint(slot: HostOauth): string
  hasVerifiedInProcessMainLogin(slot: HostOauth): boolean
}

async function verifiedMainLoginRecord(): Promise<VerifiedMainLoginRecord> {
  return (await import(
    '../core/custody-host-slot.ts'
  )) as unknown as VerifiedMainLoginRecord
}

async function withFreshLocalFactory(
  slot: HostOauth,
  run: (start: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'custody-authorize-local-'))
  const configPath = join(directory, 'openai-auth.json')
  const manifestPath = join(directory, 'opencode-handles.json')
  const prior = {
    config: process.env.OPENCODE_OPENAI_AUTH_FILE,
    state: process.env.OPENCODE_OPENAI_AUTH_STATE_FILE,
    sidebar: process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE,
    log: process.env.OPENCODE_OPENAI_AUTH_LOG_FILE,
    manifest: process.env.CLAUSTRUM_OPENCODE_HANDLES,
  }
  let hooks: Awaited<ReturnType<typeof CodexAuthPlugin>> | undefined
  try {
    process.env.OPENCODE_OPENAI_AUTH_FILE = configPath
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(directory, 'state.json')
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = join(
      directory,
      'sidebar.json',
    )
    process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = join(directory, 'test.log')
    process.env.CLAUSTRUM_OPENCODE_HANDLES = manifestPath
    await saveAccounts(
      liveStorage([], { claustrum: claustrumConfig({ mode: 'local' }) }),
      configPath,
    )
    const manifest = enrollmentManifest('main')
    if (!manifest.ok) throw new Error('expected manifest fixture')
    writeFileSync(manifestPath, JSON.stringify(manifest.value))
    chmodSync(manifestPath, 0o600)

    await run(async () => {
      await hooks?.dispose?.()
      hooks = await CodexAuthPlugin(
        {
          client: {
            auth: {
              get: async () => slot,
              all: async () => ({ openai: slot }),
              set: async () => {},
            },
          },
          project: { id: 'test', name: 'test' },
          directory: '',
          worktree: directory,
          experimental_workspace: { register: () => {} },
          serverUrl: new URL('http://localhost:0'),
          $: {},
        } as never,
        {
          custody: {
            transport: {
              getCredential: async () => {
                throw new Error('not used')
              },
              statusCredential: async () => ({
                ready: false,
                lastErrorCode: null,
                leaseHeld: false,
                recordVersion: 0,
              }),
              reportAuthFailure: async () => {},
              close: () => {},
            },
          },
        },
      )
    })
  } finally {
    await hooks?.dispose?.()
    for (const [key, value] of Object.entries(prior)) {
      const envKey =
        key === 'config'
          ? 'OPENCODE_OPENAI_AUTH_FILE'
          : key === 'state'
            ? 'OPENCODE_OPENAI_AUTH_STATE_FILE'
            : key === 'sidebar'
              ? 'OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE'
              : key === 'log'
                ? 'OPENCODE_OPENAI_AUTH_LOG_FILE'
                : 'CLAUSTRUM_OPENCODE_HANDLES'
      if (value === undefined) delete process.env[envKey]
      else process.env[envKey] = value
    }
    rmSync(directory, { recursive: true, force: true })
  }
}

async function makeAuthorizeMethods() {
  const browserTokens = deferred<TokenResponse>()
  const headlessTokens = deferred<TokenResponse>()
  const browserStarted = mock(async () => ({
    url: 'http://test/callback',
    tokens: browserTokens.promise,
  }))
  const headlessStarted = mock(async () => ({
    url: 'http://test/device',
    instructions: 'test',
    tokens: headlessTokens.promise,
  }))

  let hostSlot: HostOauth | undefined
  let rejectAuthGet = false
  let now = 0
  const sleeps: Array<Deferred<void>> = []
  const warnings: string[] = []
  const hostAuthSet = mock(
    async ({ body }: { path: { id: string }; body: HostOauth }) => {
      hostSlot = body
    },
  )
  const hooks = await CodexAuthPlugin(
    {
      client: {
        auth: {
          all: async () => ({}),
          get: async () => {
            if (rejectAuthGet) throw new Error('host read failed')
            return hostSlot
          },
          set: hostAuthSet,
        },
      },
      project: { id: 'test', name: 'test' },
      directory: '',
      worktree: '',
      experimental_workspace: { register: () => {} },
      serverUrl: new URL('http://localhost:0'),
      $: {},
    } as never,
    {
      custody: {
        transport: {
          getCredential: async () => {
            throw new Error('not used')
          },
          statusCredential: async () => ({
            ready: false,
            lastErrorCode: null,
            leaseHeld: false,
            recordVersion: 0,
          }),
          reportAuthFailure: async () => {},
          close: () => {},
        },
        now: () => now,
        sleep: async () => {
          const next = deferred<void>()
          sleeps.push(next)
          await next.promise
        },
        authorize: { browser: browserStarted, headless: headlessStarted },
        warn: (message: string) => warnings.push(message),
      },
    },
  )
  const methods = hooks.auth?.methods as
    | Array<{ authorize: Authorize; label: string }>
    | undefined
  if (!methods) throw new Error('expected auth methods')

  return {
    browser: methods[0]!.authorize,
    headless: methods[1]!.authorize,
    browserStarted,
    headlessStarted,
    browserTokens,
    headlessTokens,
    hostSet: (access: string, refresh = 'refresh') => {
      hostSlot = { type: 'oauth', access, refresh, expires: 60_000 }
    },
    otherWindowSet: async (access: string, refresh = 'refresh') => {
      await hostAuthSet({
        path: { id: 'openai' },
        body: { type: 'oauth', access, refresh, expires: 60_000 },
      })
    },
    hostSlot: () => hostSlot,
    advanceTo: (next: number) => {
      now = next
    },
    rejectHostReads: () => {
      rejectAuthGet = true
    },
    sleeps,
    warnings,
    dispose: hooks.dispose,
  }
}

describe('production authorize custody leases', () => {
  test.each([
    ['browser', 'minted-browser'],
    ['headless', 'minted-headless'],
  ] as const)(
    '%s waits behind the production transition mutex before OAuth starts',
    async (kind, access) => {
      const fixture = await makeAuthorizeMethods()
      const held = await acquireCustodyTransitionMutex()
      try {
        const authorize =
          kind === 'browser' ? fixture.browser : fixture.headless
        const pending = authorize()
        await Promise.resolve()

        expect(fixture.browserStarted).not.toHaveBeenCalled()
        expect(fixture.headlessStarted).not.toHaveBeenCalled()

        await held.release()
        const flow = await pending
        expect(fixture.browserStarted).toHaveBeenCalledTimes(
          kind === 'browser' ? 1 : 0,
        )
        expect(fixture.headlessStarted).toHaveBeenCalledTimes(
          kind === 'headless' ? 1 : 0,
        )

        if (kind === 'browser') {
          fixture.browserTokens.resolve({
            access_token: access,
            refresh_token: 'refresh',
            id_token: 'id',
            expires_in: 60,
          })
        } else {
          fixture.headlessTokens.resolve({
            access_token: access,
            refresh_token: 'refresh',
            id_token: 'id',
            expires_in: 60,
          })
        }
        await flow.callback()
        await waitForSleep(fixture.sleeps)
        fixture.hostSet(access)
        fixture.sleeps[0]!.resolve()
        const released = await acquireCustodyTransitionMutex()
        await released.release()
      } finally {
        await held.release()
        await fixture.dispose?.()
      }
    },
  )

  test('retains the production callback lease until exact host readback', async () => {
    const fixture = await makeAuthorizeMethods()
    try {
      const flow = await fixture.browser()
      fixture.browserTokens.resolve({
        access_token: 'minted-access',
        refresh_token: 'refresh',
        id_token: 'id',
        expires_in: 60,
      })
      await flow.callback()
      await waitForSleep(fixture.sleeps)

      let barrierAcquired = false
      const barrier = acquireCustodyTransitionMutex().then(async (lease) => {
        barrierAcquired = true
        await lease.release()
      })
      for (let turn = 0; turn < 32; turn += 1) await Promise.resolve()
      expect(barrierAcquired).toBe(false)

      fixture.hostSet('minted-access')
      fixture.sleeps[0]!.resolve()
      await barrier
      expect(barrierAcquired).toBe(true)
    } finally {
      await fixture.dispose?.()
    }
  })

  test.each([
    ['browser', 'minted-browser'],
    ['headless', 'minted-headless'],
  ] as const)(
    '%s releases at the five-second bound when the host never writes',
    async (kind, access) => {
      const fixture = await makeAuthorizeMethods()
      try {
        const flow = await (kind === 'browser'
          ? fixture.browser
          : fixture.headless)()
        const tokens =
          kind === 'browser' ? fixture.browserTokens : fixture.headlessTokens
        tokens.resolve({
          access_token: access,
          refresh_token: 'refresh',
          id_token: 'id',
          expires_in: 60,
        })

        await expect(flow.callback()).resolves.toMatchObject({ access })
        await waitForSleep(fixture.sleeps)
        fixture.advanceTo(5_000)
        fixture.sleeps[0]!.resolve()

        const acquired = await acquireCustodyTransitionMutex()
        await acquired.release()
        expect(fixture.warnings).toEqual([
          'host write not observed within 5s; lease released',
        ])
      } finally {
        await fixture.dispose?.()
      }
    },
  )

  test.each([
    ['browser', 'minted-browser'],
    ['headless', 'minted-headless'],
  ] as const)(
    '%s contains a rejected host readback and releases at the bound',
    async (kind, access) => {
      const fixture = await makeAuthorizeMethods()
      try {
        const flow = await (kind === 'browser'
          ? fixture.browser
          : fixture.headless)()
        const tokens =
          kind === 'browser' ? fixture.browserTokens : fixture.headlessTokens
        tokens.resolve({
          access_token: access,
          refresh_token: 'refresh',
          id_token: 'id',
          expires_in: 60,
        })
        fixture.rejectHostReads()

        await expect(flow.callback()).resolves.toMatchObject({ access })
        await waitForSleep(fixture.sleeps)
        fixture.advanceTo(5_000)
        fixture.sleeps[0]!.resolve()

        const acquired = await acquireCustodyTransitionMutex()
        await acquired.release()
        expect(fixture.warnings).toEqual([
          'host write not observed within 5s; lease released',
        ])
      } finally {
        await fixture.dispose?.()
      }
    },
  )

  test.each([
    ['browser', 'minted-browser'],
    ['headless', 'minted-headless'],
  ] as const)(
    '%s ignores a different host token until the five-second bound',
    async (kind, access) => {
      const fixture = await makeAuthorizeMethods()
      try {
        const flow = await (kind === 'browser'
          ? fixture.browser
          : fixture.headless)()
        const tokens =
          kind === 'browser' ? fixture.browserTokens : fixture.headlessTokens
        tokens.resolve({
          access_token: access,
          refresh_token: 'refresh',
          id_token: 'id',
          expires_in: 60,
        })
        await flow.callback()
        await waitForSleep(fixture.sleeps)

        fixture.hostSet('different-access')
        fixture.sleeps[0]!.resolve()
        await waitForSleep(fixture.sleeps, 2)

        let acquired = false
        const pending = acquireCustodyTransitionMutex().then(async (lease) => {
          acquired = true
          await lease.release()
        })
        await Promise.resolve()
        expect(acquired).toBe(false)

        fixture.advanceTo(5_000)
        fixture.sleeps[1]!.resolve()
        await pending
        expect(fixture.warnings).toEqual([
          'host write not observed within 5s; lease released',
        ])
      } finally {
        await fixture.dispose?.()
      }
    },
  )

  test('keeps bound manifest bytes after a local authorize callback writes a new host family', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'custody-authorize-local-'))
    const manifestPath = join(directory, 'opencode-handles.json')
    const configPath = join(directory, 'openai-auth.json')
    const priorManifestPath = process.env.CLAUSTRUM_OPENCODE_HANDLES
    const priorConfigPath = process.env.OPENCODE_OPENAI_AUTH_FILE
    let fixture: Awaited<ReturnType<typeof makeAuthorizeMethods>> | undefined
    try {
      const manifest = enrollmentManifest('main')
      if (!manifest.ok) throw new Error('expected enrollment manifest')
      writeFileSync(manifestPath, JSON.stringify(manifest.value))
      process.env.CLAUSTRUM_OPENCODE_HANDLES = manifestPath
      process.env.OPENCODE_OPENAI_AUTH_FILE = configPath
      const before = readFileSync(manifestPath)
      const record = await verifiedMainLoginRecord()
      fixture = await makeAuthorizeMethods()
      fixture.hostSet('before-login', 'before-refresh')
      const beforeFingerprint = record.mainSlotFamilyFingerprint(
        fixture.hostSlot()!,
      )

      const flow = await fixture.browser()
      fixture.browserTokens.resolve({
        access_token: 'after-login',
        refresh_token: 'after-refresh',
        id_token: 'id',
        expires_in: 60,
      })
      const result = await flow.callback()
      await waitForSleep(fixture.sleeps)
      fixture.hostSet(result.access, result.refresh)
      fixture.sleeps[0]!.resolve()
      for (let turn = 0; turn < 32; turn += 1) await Promise.resolve()

      const afterFingerprint = record.mainSlotFamilyFingerprint(
        fixture.hostSlot()!,
      )
      expect(afterFingerprint).not.toBe(beforeFingerprint)
      expect(afterFingerprint).toBe(
        record.mainSlotFamilyFingerprint({
          type: 'oauth',
          access: 'after-login',
          refresh: 'after-refresh',
          expires: 60_000,
        }),
      )
      expect(readFileSync(manifestPath)).toEqual(before)
    } finally {
      await fixture?.dispose?.()
      if (priorManifestPath === undefined) {
        delete process.env.CLAUSTRUM_OPENCODE_HANDLES
      } else {
        process.env.CLAUSTRUM_OPENCODE_HANDLES = priorManifestPath
      }
      if (priorConfigPath === undefined) {
        delete process.env.OPENCODE_OPENAI_AUTH_FILE
      } else {
        process.env.OPENCODE_OPENAI_AUTH_FILE = priorConfigPath
      }
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('records only the authorize callback family after its exact host readback', async () => {
    const fixture = await makeAuthorizeMethods()
    try {
      const record = await verifiedMainLoginRecord()
      const flow = await fixture.browser()
      fixture.browserTokens.resolve({
        access_token: 'minted-access',
        refresh_token: 'minted-refresh',
        id_token: 'id',
        expires_in: 60,
      })
      const result = await flow.callback()
      await waitForSleep(fixture.sleeps)

      await fixture.otherWindowSet('other-access', 'other-refresh')
      fixture.sleeps[0]!.resolve()
      await waitForSleep(fixture.sleeps, 2)
      expect(record.hasVerifiedInProcessMainLogin(fixture.hostSlot()!)).toBe(
        false,
      )

      fixture.hostSet(result.access, result.refresh)
      fixture.sleeps[1]!.resolve()
      for (let turn = 0; turn < 32; turn += 1) await Promise.resolve()

      expect(record.hasVerifiedInProcessMainLogin(fixture.hostSlot()!)).toBe(
        true,
      )
    } finally {
      await fixture.dispose?.()
    }
  })

  test('a local bound slot serves only after its authorize callback verifies that exact family', async () => {
    const record = await verifiedMainLoginRecord()
    const restoredSlot: HostOauth = {
      type: 'oauth',
      access: 'verified-access',
      refresh: 'verified-refresh',
      expires: 60_000,
    }

    expect(record.hasVerifiedInProcessMainLogin(restoredSlot)).toBe(false)
    await withFreshLocalFactory(restoredSlot, async (start) => {
      await start()
      expect((await getSidebarState()).main.custody).toEqual({
        state: 'inert',
        reason: 'needs-login',
      })

      const fixture = await makeAuthorizeMethods()
      try {
        const flow = await fixture.headless()
        fixture.headlessTokens.resolve({
          access_token: 'verified-access',
          refresh_token: 'verified-refresh',
          id_token: 'id',
          expires_in: 60,
        })
        const result = await flow.callback()
        await waitForSleep(fixture.sleeps)
        fixture.hostSet(result.access, result.refresh)
        fixture.sleeps[0]!.resolve()
        for (let turn = 0; turn < 32; turn += 1) await Promise.resolve()

        expect(record.hasVerifiedInProcessMainLogin(fixture.hostSlot()!)).toBe(
          true,
        )
      } finally {
        await fixture.dispose?.()
      }

      await start()
      expect((await getSidebarState()).main.custody).toEqual({
        state: 'local',
      })
    })
  })
})

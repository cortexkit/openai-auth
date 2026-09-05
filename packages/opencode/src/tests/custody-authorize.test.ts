import { describe, expect, mock, test } from 'bun:test'
import { acquireCustodyTransitionMutex } from '../core/custody-transition.ts'
import { CodexAuthPlugin } from '../index.ts'

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
  callback(): Promise<{ access: string }>
}>

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

  let hostAccess: string | undefined
  let rejectAuthGet = false
  let now = 0
  const sleeps: Array<Deferred<void>> = []
  const warnings: string[] = []
  const hooks = await CodexAuthPlugin(
    {
      client: {
        auth: {
          all: async () => ({}),
          get: async () => {
            if (rejectAuthGet) throw new Error('host read failed')
            return hostAccess
              ? { type: 'oauth', access: hostAccess }
              : undefined
          },
          set: async () => {},
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
    hostSet: (access: string) => {
      hostAccess = access
    },
    rejectHostReads: () => {
      rejectAuthGet = true
    },
    advanceTo: (next: number) => {
      now = next
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
})

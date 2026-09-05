import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountStorage,
  type AccountStoreTransaction,
  getAccountStatePath,
  saveAccounts,
  withAccountStoreTransaction,
} from '../core/accounts.ts'
import type { TransitionResult } from '../core/custody-transition.ts'
import { liveAccount, liveStorage } from './custody-fixtures.ts'

type Deferred = {
  promise: Promise<void>
  resolve: () => void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function fakeCoordinatorDeps(
  options: {
    storage?: AccountStorage
    manifestRevisions?: string[]
    preflight?: (id: string) => Promise<'ready' | 'vault-cold' | 'no-handle'>
    beforeSet?: () => void
    afterSet?: () => void
    all?: () => Promise<Record<string, unknown>>
    failFallbackId?: string
  } = {},
) {
  const storage =
    options.storage ??
    liveStorage([liveAccount('fallback-b'), liveAccount('fallback-a')])
  const authSlot = {
    type: 'oauth',
    access: 'main-access',
    refresh: 'main-refresh',
    expires: 1,
  }
  const traces: string[] = []
  const writes: string[] = []
  const revisions = options.manifestRevisions ?? ['revision-1', 'revision-1']
  let revisionIndex = 0
  let current = structuredClone(storage)
  const released: string[] = []

  return {
    traces,
    writes,
    released,
    storage: () => current,
    deps: {
      accountIds: current.accounts.map((account) => account.id),
      acquireLock: async ({
        name,
        renew,
      }: {
        name: string
        renew: boolean
      }) => {
        traces.push(`acquire:${name}:${renew}`)
        return {
          release: async () => {
            released.push(name)
            traces.push(`release:${name}`)
          },
        }
      },
      withStoreTransaction: async (
        action: (
          transaction: AccountStoreTransaction,
        ) => Promise<TransitionResult>,
      ) => {
        traces.push('acquire:store')
        try {
          return await action({
            read: async () => structuredClone(current),
            write: async (next: AccountStorage) => {
              const failed =
                options.failFallbackId &&
                next.accounts.find(
                  (account) =>
                    account.type === 'oauth' &&
                    account.id === options.failFallbackId &&
                    account.refresh.startsWith('claustrum-tombstone'),
                )
              if (failed) throw new Error(`fallback write failed: ${failed.id}`)
              current = structuredClone(next)
              writes.push('fallback')
            },
            writeMode: async (mode, transition) => {
              writes.push('mode')
              current.claustrum = {
                mode,
                ...(transition ? { transition } : {}),
              }
            },
          })
        } finally {
          traces.push('release:store')
        }
      },
      readManifest: async () => ({
        ok: true as const,
        value: {
          version: 1 as const,
          providers: [
            {
              provider: 'openai',
              shape: 'oauth' as const,
              serve: 'openai-auth',
              accounts: [
                {
                  label: 'main',
                  handle: `ckh_${'m'.repeat(43)}`,
                  credential_id: 'oauth:openai:main',
                },
                ...current.accounts.map((account) => ({
                  label: account.id,
                  handle: `ckh_${account.id.padEnd(43, 'x').slice(0, 43)}`,
                  credential_id: `oauth:openai:${account.id}`,
                })),
              ],
            },
          ],
        },
        revision: revisions[Math.min(revisionIndex++, revisions.length - 1)]!,
      }),
      preflight: async ({ id }: { id: string }) =>
        options.preflight?.(id) ?? 'ready',
      auth: {
        all:
          options.all ??
          (async () => ({ openai: authSlot, anthropic: { type: 'oauth' } })),
        get: async () => authSlot,
        set: async () => {
          options.beforeSet?.()
          authSlot.access = 'claustrum-tombstone:v1:openai'
          authSlot.refresh = 'claustrum-tombstone:v1:openai'
          authSlot.expires = 0
          writes.push('main')
          options.afterSet?.()
        },
      },
      onStep: (step: string) => {
        traces.push(step)
      },
      warn: (message: string) => {
        traces.push(`warn:${message}`)
      },
    },
  }
}

describe('custody transition fingerprints', () => {
  it('slot fingerprints preserve the access-refresh boundary', async () => {
    const transition = await import('../core/custody-transition.ts')

    expect('ab' + 'c').toBe('a' + 'bc')
    expect(transition.custodySlotFingerprint('ab', 'c')).not.toBe(
      transition.custodySlotFingerprint('a', 'bc'),
    )
  })

  it('account store generation changes when a new oauth row is added or enabled', async () => {
    const transition = await import('../core/custody-transition.ts')
    const disabled = liveAccount('fallback-1', { enabled: false })
    const enabled = { ...disabled, enabled: true }
    const base: AccountStorage = {
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      accounts: [disabled],
    }

    expect(transition.accountStoreGeneration(base)).not.toBe(
      transition.accountStoreGeneration({ ...base, accounts: [enabled] }),
    )
    expect(transition.accountStoreGeneration(base)).not.toBe(
      transition.accountStoreGeneration({
        ...base,
        accounts: [disabled, liveAccount('fallback-2')],
      }),
    )
  })

  it('account store generation uses UTF-8 byte ordering for row fences', async () => {
    const transition = await import('../core/custody-transition.ts')
    const z = liveAccount('z')
    const umlaut = liveAccount('ä')
    const rows = [z, umlaut].map((account) => ({
      id: account.id,
      enabled: account.enabled !== false,
      accountId: account.accountId ?? '',
      access: account.access ?? '',
      refresh: account.refresh,
      expires: account.expires ?? null,
    }))
    const byteOrdered = createHash('sha256')
      .update(JSON.stringify(rows))
      .digest('hex')

    expect(
      transition.accountStoreGeneration({
        accounts: [umlaut, z],
      }),
    ).toBe(byteOrdered)
  })

  it('live account expiry is deterministic from injected now unless expires is explicit', () => {
    const now = 12_345

    expect(liveAccount('fallback-1', {}, now).expires).toBe(now + 3_600_000)
    expect(liveAccount('fallback-1', { expires: 99 }, now).expires).toBe(99)
  })
})

describe('enterClaustrumMode coordinator', () => {
  it('holds the five fences and executes the normative event order', async () => {
    const transition = await import('../core/custody-transition.ts')
    const index = await import('../index.ts')
    const fixture = fakeCoordinatorDeps()

    const result = await transition.enterClaustrumMode(fixture.deps)

    expect(result.status).toBe('completed')
    expect(transition.MAIN_REFRESH_LOCK_NAME).toBe('main-refresh')
    expect(index.getMainRefreshLockName()).toBe(
      transition.MAIN_REFRESH_LOCK_NAME,
    )
    expect(fixture.traces).toEqual([
      'mutex-acquired',
      'acquire:claustrum-mode:true',
      'acquire:fallback-oauth-refresh-ztmmMIFaJkALBOTT:true',
      'acquire:fallback-oauth-refresh-n-FDJpEHUMmMUzc9:true',
      'acquire:main-refresh:true',
      'acquire:store',
      'captured',
      'preflight',
      'revalidated',
      'mode-written',
      'material-written',
      'release:store',
      'release:main-refresh',
      'release:fallback-oauth-refresh-n-FDJpEHUMmMUzc9',
      'release:fallback-oauth-refresh-ztmmMIFaJkALBOTT',
      'release:claustrum-mode',
      'mutex-released',
    ])
    expect(fixture.writes).toEqual([
      'mode',
      'fallback',
      'fallback',
      'main',
      'mode',
    ])
  })

  it('does not write mode when a fenced preflight is cold or a reader revision moves', async () => {
    const transition = await import('../core/custody-transition.ts')
    const cold = fakeCoordinatorDeps({
      preflight: async (id) => (id === 'fallback-a' ? 'vault-cold' : 'ready'),
    })
    const moved = fakeCoordinatorDeps({
      manifestRevisions: ['revision-1', 'revision-2'],
    })

    await expect(
      transition.enterClaustrumMode(cold.deps),
    ).resolves.toMatchObject({
      status: 'aborted',
      outcomes: { 'fallback-a': 'vault-cold' },
    })
    await expect(
      transition.enterClaustrumMode(moved.deps),
    ).resolves.toMatchObject({
      status: 'aborted',
      reason: 'manifest-revision-changed',
    })
    expect(cold.writes).toEqual([])
    expect(moved.writes).toEqual([])
  })

  it('aborts before mode when the fenced store generation changes', async () => {
    const transition = await import('../core/custody-transition.ts')
    const fixture = fakeCoordinatorDeps({
      preflight: async () => {
        fixture.storage().accounts.push(liveAccount('new-racing-row'))
        return 'ready'
      },
    })

    const result = await transition.enterClaustrumMode(fixture.deps)

    expect(result).toMatchObject({
      status: 'aborted',
      reason: 'store-generation-changed',
    })
    expect(fixture.writes).toEqual([])
  })

  it('does not read or write when the mode lock is unavailable', async () => {
    const transition = await import('../core/custody-transition.ts')
    const fixture = fakeCoordinatorDeps()
    let reads = 0
    fixture.deps.readManifest = async () => {
      reads++
      throw new Error('must not read')
    }
    fixture.deps.acquireLock = (async () => null) as never

    await expect(
      transition.enterClaustrumMode(fixture.deps),
    ).resolves.toMatchObject({
      status: 'aborted',
      reason: 'mode-lock-unavailable',
    })
    expect(reads).toBe(0)
    expect(fixture.writes).toEqual([])
  })

  it('holds both real save locks until the transaction releases', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'oai-custody-transition-'))
    const path = join(directory, 'accounts.json')
    try {
      await saveAccounts(liveStorage([liveAccount('fallback-a')]), path)
      const entered = deferred()
      const release = deferred()
      const held = withAccountStoreTransaction(async () => {
        entered.resolve()
        await release.promise
        return { status: 'completed', outcomes: {} }
      }, path)
      await entered.promise
      const statePath = getAccountStatePath(path)
      expect(existsSync(`${path}.save.lock`)).toBe(true)
      expect(existsSync(`${statePath}.save.lock`)).toBe(true)
      release.resolve()
      await held
      expect(existsSync(`${path}.save.lock`)).toBe(false)
      expect(existsSync(`${statePath}.save.lock`)).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('defers a host tombstone on an empty auth map and warns exactly once', async () => {
    const transition = await import('../core/custody-transition.ts')
    const fixture = fakeCoordinatorDeps({ all: async () => ({}) })

    const result = await transition.enterClaustrumMode(fixture.deps)

    expect(result.status).toBe('incomplete')
    expect(result.outcomes.main).toBe('torn-read-deferred')
    expect(fixture.writes).toEqual(['mode', 'fallback', 'fallback'])
    expect(fixture.traces.filter((step) => step.startsWith('warn:'))).toEqual([
      'warn:host auth store read empty; refusing to write — possible torn read',
    ])
  })

  it('reports a host overwrite observed by post-write readback', async () => {
    const transition = await import('../core/custody-transition.ts')
    const fixture = fakeCoordinatorDeps()
    fixture.deps.auth.get = async () =>
      fixture.writes.includes('main')
        ? {
            type: 'oauth',
            access: 'new-access',
            refresh: 'new-refresh',
            expires: 2,
          }
        : {
            type: 'oauth',
            access: 'main-access',
            refresh: 'main-refresh',
            expires: 1,
          }

    const result = await transition.enterClaustrumMode(fixture.deps)

    expect(result.outcomes.main).toBe('new-local-family-under-claustrum')
  })

  it('retains the mode and prior tombstones when one fallback write fails', async () => {
    const transition = await import('../core/custody-transition.ts')
    const fixture = fakeCoordinatorDeps({ failFallbackId: 'fallback-b' })

    const result = await transition.enterClaustrumMode(fixture.deps)

    expect(result).toMatchObject({
      status: 'incomplete',
      outcomes: {
        'fallback-a': 'tombstoned',
        'fallback-b': 'aborted:write-failed',
      },
    })
    expect(fixture.storage().claustrum?.mode).toBe('claustrum')
    expect(fixture.writes).toEqual(['mode', 'fallback'])
  })

  it('resumes only a remaining row that still matches its persisted fingerprint', async () => {
    const transition = await import('../core/custody-transition.ts')
    const fixture = fakeCoordinatorDeps({ failFallbackId: 'fallback-b' })
    await transition.enterClaustrumMode(fixture.deps)
    const changed = fixture
      .storage()
      .accounts.find(
        (account) => account.type === 'oauth' && account.id === 'fallback-b',
      )
    if (changed?.type !== 'oauth') throw new Error('missing fallback-b')
    changed.access = 'new-local-access'

    const result = await transition.enterClaustrumMode(fixture.deps)

    expect(result.outcomes).toMatchObject({
      'fallback-a': 'tombstoned',
      'fallback-b': 'new-local-family-under-claustrum',
    })
    expect(changed.access).toBe('new-local-access')
  })

  it('resumes a deferred main tombstone and clears fingerprints only after completion', async () => {
    const transition = await import('../core/custody-transition.ts')
    let empty = true
    const fixture = fakeCoordinatorDeps({
      all: async () => (empty ? {} : { openai: {} }),
    })
    await transition.enterClaustrumMode(fixture.deps)
    empty = false

    const result = await transition.enterClaustrumMode(fixture.deps)

    expect(result.status).toBe('completed')
    expect(result.outcomes.main).toBe('tombstoned')
    expect(fixture.storage().claustrum?.transition).toBeUndefined()
  })

  it('serializes a barrier behind a shared process mutex', async () => {
    const transition = await import('../core/custody-transition.ts')
    const held = await transition.acquireCustodyTransitionMutex()
    const fixture = fakeCoordinatorDeps()
    const started = deferred()
    fixture.deps.onStep = (step: string) => {
      fixture.traces.push(step)
      if (step === 'mutex-acquired') started.resolve()
    }

    const pending = transition.enterClaustrumMode(fixture.deps)
    await Promise.resolve()
    expect(fixture.traces).toEqual([])
    await held.release()
    await started.promise
    await pending
  })

  it('makes a fake authorize callback wait until the barrier releases the shared mutex', async () => {
    const transition = await import('../core/custody-transition.ts')
    const preflightEntered = deferred()
    const releasePreflight = deferred()
    const fixture = fakeCoordinatorDeps({
      preflight: async () => {
        preflightEntered.resolve()
        await releasePreflight.promise
        return 'ready'
      },
    })
    const barrier = transition.enterClaustrumMode(fixture.deps)
    await preflightEntered.promise
    let oauthStarted = false
    const authorize = (async () => {
      const lease = await transition.acquireCustodyTransitionMutex()
      oauthStarted = true
      await lease.release()
    })()

    await Promise.resolve()
    expect(oauthStarted).toBe(false)
    releasePreflight.resolve()
    await barrier
    await authorize
    expect(oauthStarted).toBe(true)
  })

  it('makes barrier step one wait until a fake authorize host set has landed', async () => {
    const transition = await import('../core/custody-transition.ts')
    const order: string[] = []
    const authorize = (async () => {
      const lease = await transition.acquireCustodyTransitionMutex()
      order.push('host-set')
      await lease.release()
    })()
    const fixture = fakeCoordinatorDeps()
    fixture.deps.onStep = (step: string) => {
      if (step === 'mutex-acquired') order.push('barrier-step-1')
    }

    await Promise.all([authorize, transition.enterClaustrumMode(fixture.deps)])

    expect(order).toEqual(['host-set', 'barrier-step-1'])
  })

  it('leaves custody under the mode lock without touching account material', async () => {
    const transition = await import('../core/custody-transition.ts')
    const calls: string[] = []

    await transition.leaveClaustrumMode({
      acquireLock: async ({ name, renew }) => {
        calls.push(`acquire:${name}:${renew}`)
        return {
          release: async () => {
            calls.push(`release:${name}`)
          },
        }
      },
      withStoreTransaction: async (action) =>
        await action({
          read: async () => {
            throw new Error('leave must not read credential material')
          },
          write: async () => {
            throw new Error('leave must not write credential material')
          },
          writeMode: async (mode) => {
            calls.push(`mode:${mode}`)
          },
        }),
    })

    expect(calls).toEqual([
      'acquire:claustrum-mode:true',
      'mode:local',
      'release:claustrum-mode',
    ])
  })
})

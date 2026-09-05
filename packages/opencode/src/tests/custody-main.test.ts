import { describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAccounts, saveAccounts } from '../core/accounts.ts'
import { custodyTombstoneKey } from '../core/custody.ts'
import {
  classifyMainAuthSlot,
  confirmMainAuthSlot,
  reconcileMainSlotBeforeHooks,
} from '../core/custody-host-slot.ts'
import { type ClaustrumCacheTransportLike, CodexAuthPlugin } from '../index.ts'
import { getSidebarState } from '../sidebar-state.ts'
import {
  claustrumConfig,
  enrollmentManifest,
  liveStorage,
} from './custody-fixtures.ts'

const canonicalTombstone = {
  type: 'oauth' as const,
  access: custodyTombstoneKey('openai'),
  refresh: custodyTombstoneKey('openai'),
  expires: 0,
}

function mainJwt(accountId: string | undefined): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString(
    'base64url',
  )
  const payload = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': accountId
        ? { chatgpt_account_id: accountId }
        : {},
    }),
  ).toString('base64url')
  return `${header}.${payload}.sig`
}

type MainOauth = {
  type: 'oauth'
  access: string
  refresh: string
  expires: number
}

async function withMainLoader(
  options: {
    auth: MainOauth
    storage: ReturnType<typeof liveStorage>
    transport: ClaustrumCacheTransportLike
    slotAbsent?: boolean
  },
  run: (input: {
    loader: (
      getAuth: () => Promise<MainOauth>,
      ctx: unknown,
    ) => Promise<unknown>
    configPath: string
    authSetCalls: () => number
  }) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'custody-main-review-'))
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
  let authSetCalls = 0
  try {
    process.env.OPENCODE_OPENAI_AUTH_FILE = configPath
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(directory, 'state.json')
    process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = join(
      directory,
      'sidebar.json',
    )
    process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = join(directory, 'test.log')
    process.env.CLAUSTRUM_OPENCODE_HANDLES = manifestPath
    await saveAccounts(options.storage, configPath)
    const manifest = enrollmentManifest('main')
    if (!manifest.ok) throw new Error('expected manifest fixture')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(manifestPath, JSON.stringify(manifest.value), { mode: 0o600 })
    chmodSync(manifestPath, 0o600)
    hooks = await CodexAuthPlugin(
      {
        client: {
          auth: {
            get: async () => (options.slotAbsent ? undefined : options.auth),
            all: async () =>
              options.slotAbsent
                ? { anthropic: { type: 'oauth' } }
                : { openai: options.auth },
            set: async () => {
              authSetCalls += 1
            },
          },
        },
        project: { id: 'test', name: 'test' },
        directory: '',
        worktree: directory,
        experimental_workspace: { register: () => {} },
        serverUrl: new URL('http://localhost:0'),
        $: {},
      } as never,
      { custody: { transport: options.transport, detection: 'available' } },
    )
    const loader = hooks.auth?.loader
    if (!loader) throw new Error('expected auth loader')
    await run({
      loader: loader as (
        getAuth: () => Promise<MainOauth>,
        ctx: unknown,
      ) => Promise<unknown>,
      configPath,
      authSetCalls: () => authSetCalls,
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

describe('main host slot', () => {
  test('recognizes canonical and partial tombstones without treating either as real', () => {
    expect(classifyMainAuthSlot(canonicalTombstone)).toEqual({
      kind: 'tombstone',
      oauth: canonicalTombstone,
    })
    expect(
      classifyMainAuthSlot({
        type: 'oauth',
        access: 'partial',
        refresh: custodyTombstoneKey('openai'),
        expires: 1,
      }),
    ).toMatchObject({ kind: 'empty' })
  })

  test('confirms slot absence only after two separated undefined reads with non-empty auth maps', async () => {
    let now = 10_000
    let getCalls = 0
    let allCalls = 0

    const result = await confirmMainAuthSlot({
      client: {
        auth: {
          get: async () => {
            getCalls += 1
            return undefined
          },
          all: async () => {
            allCalls += 1
            return { anthropic: { type: 'oauth' } }
          },
        },
      },
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
    })

    expect(result).toEqual({ kind: 'slot-absent' })
    expect(getCalls).toBe(2)
    expect(allCalls).toBe(2)
    expect(now).toBe(10_250)
  })

  test('leaves a torn empty auth map indeterminate rather than declaring the slot absent', async () => {
    let now = 10_000
    const result = await confirmMainAuthSlot({
      client: {
        auth: {
          get: async () => undefined,
          all: async () => ({}),
        },
      },
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
    })

    expect(result).toEqual({ kind: 'indeterminate' })
  })

  test('does not declare absence from one undefined read when the next read contains an oauth slot', async () => {
    let reads = 0
    let now = 10_000
    const real = {
      type: 'oauth' as const,
      access: 'access',
      refresh: 'refresh',
      expires: 1,
    }

    const result = await confirmMainAuthSlot({
      client: {
        auth: {
          get: async () => (reads++ === 0 ? undefined : real),
          all: async () => ({ anthropic: { type: 'oauth' } }),
        },
      },
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
    })

    expect(result).toEqual({ kind: 'real', oauth: real })
  })

  test('returns the slot-absent custody verdict through the factory adapter without host writes', async () => {
    let authSetCalls = 0
    let now = 10_000
    const verdict = await reconcileMainSlotBeforeHooks({
      client: {
        auth: {
          get: async () => undefined,
          all: async () => ({ anthropic: { type: 'oauth' } }),
          set: async () => {
            authSetCalls += 1
          },
        },
      },
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
      mode: 'claustrum',
      manifest: enrollmentManifest('main'),
      getCredential: async () => ({ access: mainJwt('acct-served') }),
    })

    expect(verdict).toEqual({
      kind: 'INERT',
      reason: 'takeover-incomplete/slot-absent',
    })
    expect(authSetCalls).toBe(0)
  })

  test('reports identity mismatch when the factory binding disputes the served main JWT', async () => {
    let now = 10_000
    const verdict = await reconcileMainSlotBeforeHooks({
      client: {
        auth: {
          get: async () => undefined,
          all: async () => ({ anthropic: { type: 'oauth' } }),
        },
      },
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
      mode: 'claustrum',
      manifest: enrollmentManifest('main'),
      mainAccountId: 'stored-main',
      getCredential: async () => ({ access: mainJwt('other-main') }),
    })

    expect(verdict).toEqual({ kind: 'INERT', reason: 'identity-mismatch' })
  })

  test('keeps a prior main identity when an empty tombstone retains a local JWT and the vault is cold', async () => {
    const empty = {
      type: 'oauth' as const,
      access: mainJwt('local-leftover'),
      refresh: custodyTombstoneKey('openai'),
      expires: 1,
    }
    await withMainLoader(
      {
        auth: empty,
        storage: liveStorage([], {
          mainAccountId: 'vault-derived',
          claustrum: claustrumConfig({ mode: 'claustrum' }),
        }),
        transport: {
          getCredential: async () => {
            throw new Error('vault cold')
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
      async ({ loader, configPath, authSetCalls }) => {
        await expect(loader(async () => empty, {})).resolves.toBeDefined()
        expect((await loadAccounts(configPath))?.mainAccountId).toBe(
          'vault-derived',
        )
        expect(authSetCalls()).toBe(0)
      },
    )
  })

  test('keeps the loader alive when a bound tombstone vault reports reauth', async () => {
    await withMainLoader(
      {
        auth: canonicalTombstone,
        storage: liveStorage([], {
          claustrum: claustrumConfig({ mode: 'claustrum' }),
        }),
        transport: {
          getCredential: async () => {
            throw new Error('vault needs reauth')
          },
          statusCredential: async () => ({
            ready: false,
            lastErrorCode: 'reauth',
            leaseHeld: false,
            recordVersion: 0,
          }),
          reportAuthFailure: async () => {},
          close: () => {},
        },
      },
      async ({ loader, authSetCalls }) => {
        await expect(
          loader(async () => canonicalTombstone, {}),
        ).resolves.toBeDefined()
        expect(authSetCalls()).toBe(0)
      },
    )
  })

  test('writes the factory slot-absent verdict into the main sidebar row', async () => {
    await withMainLoader(
      {
        auth: canonicalTombstone,
        storage: liveStorage([], {
          mainAccountId: 'stored-main',
          claustrum: claustrumConfig({ mode: 'claustrum' }),
        }),
        slotAbsent: true,
        transport: {
          getCredential: async () => ({
            material: mainJwt('stored-main'),
            recordVersion: 1,
            expiresAtMs: Date.now() + 60_000,
          }),
          statusCredential: async () => ({
            ready: true,
            lastErrorCode: null,
            leaseHeld: false,
            recordVersion: 1,
          }),
          reportAuthFailure: async () => {},
          close: () => {},
        },
      },
      async () => {
        expect((await getSidebarState()).main.custody).toEqual({
          state: 'inert',
          reason: 'takeover-incomplete/slot-absent',
        })
      },
    )
  })

  test('writes identity mismatch when the factory slot-absent binding disputes the served main JWT', async () => {
    await withMainLoader(
      {
        auth: canonicalTombstone,
        storage: liveStorage([], {
          mainAccountId: 'stored-main',
          claustrum: claustrumConfig({ mode: 'claustrum' }),
        }),
        slotAbsent: true,
        transport: {
          getCredential: async () => ({
            material: mainJwt('other-main'),
            recordVersion: 1,
            expiresAtMs: Date.now() + 60_000,
          }),
          statusCredential: async () => ({
            ready: true,
            lastErrorCode: null,
            leaseHeld: false,
            recordVersion: 1,
          }),
          reportAuthFailure: async () => {},
          close: () => {},
        },
      },
      async () => {
        expect((await getSidebarState()).main.custody).toEqual({
          state: 'inert',
          reason: 'identity-mismatch',
        })
      },
    )
  })

  test('does not acquire refresh state or call the token endpoint for a tombstoned main slot', async () => {
    const originalFetch = globalThis.fetch
    const urls: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url))
      return new Response('{}', { status: 200 })
    }) as typeof globalThis.fetch
    try {
      await withMainLoader(
        {
          auth: canonicalTombstone,
          storage: liveStorage([], {
            claustrum: claustrumConfig({ mode: 'claustrum' }),
          }),
          transport: {
            getCredential: async () => {
              throw new Error('vault cold')
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
        async ({ loader, configPath }) => {
          const result = (await loader(async () => canonicalTombstone, {})) as {
            fetch?: typeof globalThis.fetch
          }
          if (!result.fetch) throw new Error('expected fetch override')
          await result.fetch(
            'https://chatgpt.com/backend-api/codex/responses',
            {
              method: 'POST',
              body: '{}',
            },
          )
          expect(urls).toEqual([
            'https://chatgpt.com/backend-api/codex/responses',
          ])
          expect(
            (await loadAccounts(configPath))?.refresh?.mainRefreshLeaseId,
          ).toBeUndefined()
          expect(
            (await loadAccounts(configPath))?.refresh?.mainLastRefreshError,
          ).toBeUndefined()
        },
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('derives main identity from the served vault JWT before migration can inspect the tombstone', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'custody-main-loader-'))
    const configPath = join(directory, 'openai-auth.json')
    const manifestPath = join(directory, 'opencode-handles.json')
    const priorConfigPath = process.env.OPENCODE_OPENAI_AUTH_FILE
    const priorStatePath = process.env.OPENCODE_OPENAI_AUTH_STATE_FILE
    const priorManifestPath = process.env.CLAUSTRUM_OPENCODE_HANDLES
    const priorSidebarPath = process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE
    const priorLogPath = process.env.OPENCODE_OPENAI_AUTH_LOG_FILE
    let authSetCalls = 0
    let credentialCalls = 0
    let runtimeCalls = 0
    let hooks: Awaited<ReturnType<typeof CodexAuthPlugin>> | undefined
    const transport: ClaustrumCacheTransportLike = {
      getCredential: async () => {
        credentialCalls += 1
        return {
          material: mainJwt('served-main'),
          recordVersion: 1,
          expiresAtMs: Date.now() + 60_000,
        }
      },
      statusCredential: async () => ({
        ready: true,
        lastErrorCode: null,
        leaseHeld: false,
        recordVersion: 1,
      }),
      reportAuthFailure: async () => {},
      close: () => {},
    }

    try {
      process.env.OPENCODE_OPENAI_AUTH_FILE = configPath
      process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(
        directory,
        'state.json',
      )
      process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = join(
        directory,
        'sidebar.json',
      )
      process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = join(directory, 'test.log')
      process.env.CLAUSTRUM_OPENCODE_HANDLES = manifestPath
      await saveAccounts(
        liveStorage([], {
          mainAccountId: 'locally-minted-label',
          claustrum: claustrumConfig({ mode: 'claustrum' }),
        }),
        configPath,
      )
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const manifest = enrollmentManifest('main')
      if (!manifest.ok) throw new Error('expected manifest fixture')
      writeFileSync(manifestPath, JSON.stringify(manifest.value), {
        mode: 0o600,
      })
      chmodSync(manifestPath, 0o600)

      hooks = await CodexAuthPlugin(
        {
          client: {
            auth: {
              get: async () => canonicalTombstone,
              all: async () => ({ openai: canonicalTombstone }),
              set: async () => {
                authSetCalls += 1
              },
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
            transport,
            detection: 'available',
            onRuntime: () => {
              runtimeCalls += 1
            },
          },
        },
      )
      const loader = hooks.auth?.loader
      if (!loader) throw new Error('expected auth loader')
      expect(credentialCalls).toBe(1)
      expect(runtimeCalls).toBe(1)
      expect(authSetCalls).toBe(0)
      await loader(async () => canonicalTombstone, {} as never)

      expect((await loadAccounts(configPath))?.mainAccountId).toBe(
        'served-main',
      )
      expect(runtimeCalls).toBe(1)
      expect(authSetCalls).toBe(0)
    } finally {
      await hooks?.dispose?.()
      if (priorConfigPath === undefined)
        delete process.env.OPENCODE_OPENAI_AUTH_FILE
      else process.env.OPENCODE_OPENAI_AUTH_FILE = priorConfigPath
      if (priorStatePath === undefined)
        delete process.env.OPENCODE_OPENAI_AUTH_STATE_FILE
      else process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = priorStatePath
      if (priorManifestPath === undefined)
        delete process.env.CLAUSTRUM_OPENCODE_HANDLES
      else process.env.CLAUSTRUM_OPENCODE_HANDLES = priorManifestPath
      if (priorSidebarPath === undefined)
        delete process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE
      else
        process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = priorSidebarPath
      if (priorLogPath === undefined)
        delete process.env.OPENCODE_OPENAI_AUTH_LOG_FILE
      else process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = priorLogPath
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('does not migrate a recognized main tombstone into a new local account store', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'custody-main-no-migration-'))
    const configPath = join(directory, 'openai-auth.json')
    const priorConfigPath = process.env.OPENCODE_OPENAI_AUTH_FILE
    const priorStatePath = process.env.OPENCODE_OPENAI_AUTH_STATE_FILE
    const priorSidebarPath = process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE
    const priorLogPath = process.env.OPENCODE_OPENAI_AUTH_LOG_FILE
    let hooks: Awaited<ReturnType<typeof CodexAuthPlugin>> | undefined

    try {
      process.env.OPENCODE_OPENAI_AUTH_FILE = configPath
      process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(
        directory,
        'state.json',
      )
      process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = join(
        directory,
        'sidebar.json',
      )
      process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = join(directory, 'test.log')
      hooks = await CodexAuthPlugin(
        {
          client: {
            auth: {
              get: async () => canonicalTombstone,
              all: async () => ({ openai: canonicalTombstone }),
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
                throw new Error('should not read vault without custody mode')
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
            detection: 'available',
          },
        },
      )
      const loader = hooks.auth?.loader
      if (!loader) throw new Error('expected auth loader')
      await loader(async () => canonicalTombstone, {} as never)

      expect(await loadAccounts(configPath)).toBeNull()
    } finally {
      await hooks?.dispose?.()
      if (priorConfigPath === undefined)
        delete process.env.OPENCODE_OPENAI_AUTH_FILE
      else process.env.OPENCODE_OPENAI_AUTH_FILE = priorConfigPath
      if (priorStatePath === undefined)
        delete process.env.OPENCODE_OPENAI_AUTH_STATE_FILE
      else process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = priorStatePath
      if (priorSidebarPath === undefined)
        delete process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE
      else
        process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = priorSidebarPath
      if (priorLogPath === undefined)
        delete process.env.OPENCODE_OPENAI_AUTH_LOG_FILE
      else process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = priorLogPath
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

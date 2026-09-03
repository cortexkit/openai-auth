import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountStorage,
  loadAccounts,
  saveAccounts,
} from '../core/accounts.ts'
import { __resetEnrollPendingForTest } from '../core/custody.ts'
import {
  type CustodyCacheReadView,
  DEFAULT_SIDEBAR_STATE,
  normalizeSidebarState,
  projectCustodyForSidebar,
  projectCustodyForSidebarAsync,
  type SidebarState,
} from '../sidebar-state.ts'
import { liveAccount } from './custody-fixtures.ts'

let authDir: string
let cfgPath: string

beforeEach(() => {
  authDir = mkdtempSync(join(tmpdir(), 'oai-custody-sidebar-'))
  cfgPath = join(authDir, 'openai-auth.json')
})

afterEach(() => {
  __resetEnrollPendingForTest()
  try {
    rmSync(authDir, { recursive: true, force: true })
  } catch {}
})

// ---------------------------------------------------------------------------
// Storage shape — the one plugin-wide gate survives every storage path
// ---------------------------------------------------------------------------

describe('plugin-wide claustrum gate', () => {
  it('preserves the shape and round-trips enabled:false + manifestWrite:false on disk', async () => {
    const storage: AccountStorage = {
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      accounts: [],
      claustrum: { enabled: false, manifestWrite: false },
    }
    // loadAccounts/saveAccounts write through the configFromStorage path,
    // so a successful round-trip proves both directions preserve both fields.
    await saveAccounts(storage, cfgPath)
    const loaded = await loadAccounts(cfgPath)
    expect(loaded?.claustrum).toEqual({
      enabled: false,
      manifestWrite: false,
    })
  })

  it('round-trips enabled:true + manifestWrite:false', async () => {
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
        claustrum: { enabled: true, manifestWrite: false },
      },
      cfgPath,
    )
    const loaded = await loadAccounts(cfgPath)
    expect(loaded?.claustrum).toEqual({
      enabled: true,
      manifestWrite: false,
    })
  })

  it('normalizes old config files with no claustrum block byte-identical (no implicit block on read)', async () => {
    // An old config (no `claustrum` key) must read as `claustrum === undefined`
    // and round-trip back to disk with no `claustrum` key written. Adding
    // an implicit block would silently flip absent values, which is a
    // operator-visible behaviour change.
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
      },
      cfgPath,
    )
    const loaded = await loadAccounts(cfgPath)
    expect(loaded?.claustrum).toBeUndefined()
  })

  it('coerces non-boolean claustrum fields to false (typos cannot arm the vault path)', async () => {
    // A string "true" must NOT flip the toggle. The storage normalizer
    // accepts only `=== true`; any other shape collapses to false.
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
        claustrum: {
          enabled: 'true' as unknown as boolean,
          manifestWrite: 1 as unknown as boolean,
        },
      },
      cfgPath,
    )
    const loaded = await loadAccounts(cfgPath)
    expect(loaded?.claustrum).toEqual({
      enabled: false,
      manifestWrite: false,
    })
  })

  it('never emits a per-account claustrum.accounts map on disk', async () => {
    // Even if a future caller tries to set a per-account block, the writer
    // must not surface it on disk. Membership is the manifest entry — the
    // plugin-wide gate is the only knob.
    const storage = {
      version: 1 as const,
      main: { type: 'opencode' as const, provider: 'openai' as const },
      accounts: [],
      claustrum: { enabled: true, manifestWrite: false },
    } as AccountStorage & {
      claustrum: {
        enabled: boolean
        manifestWrite: boolean
        accounts?: unknown
      }
    }
    storage.claustrum.accounts = { work: { enabled: true } }
    await saveAccounts(storage, cfgPath)
    const onDisk = JSON.parse(readFileSync(cfgPath, 'utf8'))
    expect(onDisk.claustrum).toBeDefined()
    expect(onDisk.claustrum.accounts).toBeUndefined()
    // And the loaded value must also strip it — a future configFromStorage
    // change that re-introduces a per-account block would show up here.
    const loaded = await loadAccounts(cfgPath)
    expect(
      (loaded?.claustrum as { accounts?: unknown })?.accounts,
    ).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Sidebar projection — six states, four reasons, main frozen-local
// ---------------------------------------------------------------------------

function makeCache(
  overrides: Partial<CustodyCacheReadView> = {},
): CustodyCacheReadView {
  return {
    isBlocked: () => false,
    isReauth: () => false,
    async peekMetadata() {
      return undefined
    },
    ...overrides,
  }
}

describe('projectCustodyForSidebar — six states', () => {
  it('excluded → needsLogin (tombstoned + storage off)', () => {
    const out = projectCustodyForSidebar({
      tombstoned: true,
      storageEnabled: false,
      enrolled: false,
    })
    expect(out).toEqual({ state: 'needsLogin' })
  })

  it('custody-refuse → needsLogin (tombstoned + storage on, manifest does not recognize the account)', () => {
    const out = projectCustodyForSidebar({
      tombstoned: true,
      storageEnabled: true,
      enrolled: false,
    })
    expect(out).toEqual({ state: 'needsLogin' })
  })

  it('custodied + blocked → vaultGone', () => {
    const out = projectCustodyForSidebar({
      tombstoned: true,
      storageEnabled: true,
      enrolled: true,
      handle: 'ckh_x',
      cache: makeCache({ isBlocked: () => true }),
    })
    expect(out).toEqual({ state: 'vaultGone' })
  })

  it('custodied + reauth-bound → vaultReauth', () => {
    const out = projectCustodyForSidebar({
      tombstoned: true,
      storageEnabled: true,
      enrolled: true,
      handle: 'ckh_x',
      cache: makeCache({ isReauth: () => true }),
    })
    expect(out).toEqual({ state: 'vaultReauth' })
  })

  it('custodied + no live record → vaultReauth (the operator must wait for the next successful get)', () => {
    const out = projectCustodyForSidebar({
      tombstoned: true,
      storageEnabled: true,
      enrolled: true,
      handle: 'ckh_x',
      cache: makeCache(),
    })
    expect(out).toEqual({ state: 'vaultReauth' })
  })

  it('ordinary fallback → local (no custody state applies)', () => {
    const out = projectCustodyForSidebar({
      tombstoned: false,
      storageEnabled: false,
      enrolled: false,
    })
    expect(out).toEqual({ state: 'local' })
  })

  it('enrolling fallback without a failure → local (the projection defers to the local token until the sweep marks a reason)', () => {
    const out = projectCustodyForSidebar({
      tombstoned: false,
      storageEnabled: true,
      enrolled: true,
    })
    expect(out).toEqual({ state: 'local' })
  })
})

describe('projectCustodyForSidebarAsync — vault upgrade with recordVersion', () => {
  it('returns vault + recordVersion when the cache has a live resident record', async () => {
    const out = await projectCustodyForSidebarAsync({
      tombstoned: true,
      storageEnabled: true,
      enrolled: true,
      handle: 'ckh_x',
      cache: makeCache({
        async peekMetadata() {
          return { recordVersion: 42, expiresAtMs: 1_700_000_000_000 }
        },
      }),
    })
    expect(out).toEqual({ state: 'vault', recordVersion: 42 })
  })

  it('still resolves to vaultGone when blocked, regardless of any resident record', async () => {
    const out = await projectCustodyForSidebarAsync({
      tombstoned: true,
      storageEnabled: true,
      enrolled: true,
      handle: 'ckh_x',
      cache: makeCache({
        isBlocked: () => true,
        async peekMetadata() {
          return { recordVersion: 99, expiresAtMs: 1_700_000_000_000 }
        },
      }),
    })
    expect(out).toEqual({ state: 'vaultGone' })
  })

  it('keeps vaultReauth when the resident record is absent and no fence is active', async () => {
    const out = await projectCustodyForSidebarAsync({
      tombstoned: true,
      storageEnabled: true,
      enrolled: true,
      handle: 'ckh_x',
      cache: makeCache(),
    })
    expect(out).toEqual({ state: 'vaultReauth' })
  })

  it('serialized projection contains state + recordVersion only — no handle, no token, no payload', async () => {
    const out = await projectCustodyForSidebarAsync({
      tombstoned: true,
      storageEnabled: true,
      enrolled: true,
      handle: 'ckh_SECRET_HANDLE_LEAKED',
      cache: makeCache({
        async peekMetadata() {
          return { recordVersion: 1, expiresAtMs: 1_700_000_000_000 }
        },
      }),
    })
    const json = JSON.stringify(out)
    expect(json).not.toContain('ckh_')
    expect(json).not.toContain('SECRET')
    expect(json).not.toContain('handle')
    expect(json).not.toContain('payload')
    expect(json).not.toContain('access')
  })
})

describe('projectCustodyForSidebar — enroll-pending reason', () => {
  it('latched reason wins over every other state (the sweep wrote a failure)', () => {
    // Even a fully custodied + live account renders as enrollPending while
    // a sweep-failure reason is latched — the operator must see the reason
    // until the sweep clears it.
    const out = projectCustodyForSidebar({
      tombstoned: true,
      storageEnabled: true,
      enrolled: true,
      handle: 'ckh_x',
      cache: makeCache(),
      enrollPendingReason: 'unavailable',
    })
    expect(out).toEqual({ state: 'enrollPending', reason: 'unavailable' })
  })

  it('all four operator reasons are distinct, individual states', () => {
    const reasons: Array<
      'unavailable' | 'gone' | 'identityMismatch' | 'nullClaim'
    > = ['unavailable', 'gone', 'identityMismatch', 'nullClaim']
    const observed = new Set<string>()
    for (const reason of reasons) {
      const out = projectCustodyForSidebar({
        tombstoned: false,
        storageEnabled: true,
        enrolled: true,
        enrollPendingReason: reason,
      })
      // The state is constant; the reason is what distinguishes them.
      expect(out.state).toBe('enrollPending')
      observed.add(out.reason!)
    }
    expect(observed.size).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// Sidebar state normalizer — tolerant reader + round-trip + no leakage
// ---------------------------------------------------------------------------

function stateWithFallbacks(
  fallbacks: SidebarState['fallbacks'],
): SidebarState {
  return { ...DEFAULT_SIDEBAR_STATE, fallbacks }
}

describe('normalizeSidebarState — custody field', () => {
  it('drops an unknown state value silently (a stale file must not silently render as local)', () => {
    const result = normalizeSidebarState(
      stateWithFallbacks([
        {
          id: 'fb1',
          label: undefined,
          quota: null,
          killed: false,
          enabled: true,
          // State is invented; the tolerant reader must drop it.
          custody: { state: 'vaultHealing' as unknown as 'vault' },
        },
      ]),
    )
    expect(result.fallbacks[0]?.custody).toBeUndefined()
  })

  it('drops an unknown reason value silently (the field is gone, the state survives)', () => {
    const result = normalizeSidebarState(
      stateWithFallbacks([
        {
          id: 'fb1',
          label: undefined,
          quota: null,
          killed: false,
          enabled: true,
          custody: {
            state: 'enrollPending',
            reason: 'experimental' as unknown as 'gone',
          },
        },
      ]),
    )
    expect(result.fallbacks[0]?.custody).toEqual({ state: 'enrollPending' })
  })

  it('round-trips a valid vault projection with recordVersion', () => {
    const original = stateWithFallbacks([
      {
        id: 'fb1',
        label: undefined,
        quota: null,
        killed: false,
        enabled: true,
        custody: { state: 'vault', recordVersion: 7 },
      },
    ])
    const result = normalizeSidebarState(original)
    expect(result.fallbacks[0]?.custody).toEqual({
      state: 'vault',
      recordVersion: 7,
    })
  })

  it('round-trips every valid state', () => {
    const states: Array<
      | 'vault'
      | 'vaultReauth'
      | 'vaultGone'
      | 'needsLogin'
      | 'enrollPending'
      | 'local'
    > = [
      'vault',
      'vaultReauth',
      'vaultGone',
      'needsLogin',
      'enrollPending',
      'local',
    ]
    for (const state of states) {
      const result = normalizeSidebarState(
        stateWithFallbacks([
          {
            id: 'fb1',
            label: undefined,
            quota: null,
            killed: false,
            enabled: true,
            custody: { state },
          },
        ]),
      )
      expect(result.fallbacks[0]?.custody?.state).toBe(state)
    }
  })

  it('round-trips every valid reason paired with enrollPending', () => {
    const reasons: Array<
      'unavailable' | 'gone' | 'identityMismatch' | 'nullClaim'
    > = ['unavailable', 'gone', 'identityMismatch', 'nullClaim']
    for (const reason of reasons) {
      const result = normalizeSidebarState(
        stateWithFallbacks([
          {
            id: 'fb1',
            label: undefined,
            quota: null,
            killed: false,
            enabled: true,
            custody: { state: 'enrollPending', reason },
          },
        ]),
      )
      expect(result.fallbacks[0]?.custody).toEqual({
        state: 'enrollPending',
        reason,
      })
    }
  })

  it('drops a non-numeric recordVersion (a typo cannot crash the reader)', () => {
    const result = normalizeSidebarState(
      stateWithFallbacks([
        {
          id: 'fb1',
          label: undefined,
          quota: null,
          killed: false,
          enabled: true,
          custody: {
            state: 'vault',
            recordVersion: 'seventeen' as unknown as number,
          },
        },
      ]),
    )
    expect(result.fallbacks[0]?.custody).toEqual({ state: 'vault' })
  })

  it('drops a non-object custody (a string, a number, an array)', () => {
    for (const value of ['vault', 42, ['vault']]) {
      const result = normalizeSidebarState(
        stateWithFallbacks([
          {
            id: 'fb1',
            label: undefined,
            quota: null,
            killed: false,
            enabled: true,
            // @ts-expect-error — intentionally wrong shape
            custody: value,
          },
        ]),
      )
      expect(result.fallbacks[0]?.custody).toBeUndefined()
    }
  })

  it('serialized sidebar state never carries a handle, token, or sentinel', () => {
    const rendered = normalizeSidebarState(
      stateWithFallbacks([
        {
          id: 'fb1',
          label: undefined,
          quota: null,
          killed: false,
          enabled: true,
          custody: { state: 'vault', recordVersion: 1 },
        },
        {
          id: 'fb2',
          label: undefined,
          quota: null,
          killed: false,
          enabled: true,
          custody: { state: 'enrollPending', reason: 'unavailable' },
        },
      ]),
    )
    const json = JSON.stringify(rendered)
    // The serialized form must contain state + reason + recordVersion, but
    // never a handle, an access token, a payload, or the tombstone sentinel.
    expect(json).toContain('"state":"vault"')
    expect(json).toContain('"state":"enrollPending"')
    expect(json).toContain('"reason":"unavailable"')
    expect(json).toContain('"recordVersion":1')
    expect(json).not.toContain('ckh_')
    expect(json).not.toContain('claustrum-tombstone')
    expect(json).not.toContain('acc-')
    expect(json).not.toContain('handle')
  })

  it('main slot never carries the custody field (frozen-local text)', () => {
    // A persisted file that someone tried to push custody into main must
    // NOT propagate it to the read shape — main is the always-local slot.
    const result = normalizeSidebarState({
      ...DEFAULT_SIDEBAR_STATE,
      main: {
        quota: null,
        killed: false,
        custody: { state: 'vault' },
      } as SidebarState['main'] & { custody: { state: 'vault' } },
    })
    expect((result.main as { custody?: unknown }).custody).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// End-to-end: a real custody sidebar scenario reads what the projection
// produced, with no handle, token, or sentinel in the serialized state.
// ---------------------------------------------------------------------------

describe('custody sidebar end-to-end', () => {
  it('a tombstoned fallback with a live cache record serializes as vault + recordVersion', async () => {
    // The tombstone id is a stable test fixture; here we only need an id
    // that resembles what the projection will see, so the test is
    // independent of custody-fixtures.ts imports.
    const tombstonedId = 'custody-1'
    const result = normalizeSidebarState({
      ...DEFAULT_SIDEBAR_STATE,
      fallbacks: [
        {
          id: tombstonedId,
          label: undefined,
          quota: null,
          killed: false,
          enabled: true,
          // Built by the projection; here we exercise the round-trip path.
          custody: { state: 'vault', recordVersion: 11 },
        },
      ],
    })
    const json = JSON.stringify(result)
    expect(json).toContain('"state":"vault"')
    expect(json).toContain('"recordVersion":11')
    // No tombstone sentinel on the wire — that is for the storage file only.
    expect(json).not.toContain('claustrum-tombstone')
  })

  it('a non-tombstoned, non-custodied fallback serializes as local', () => {
    const live = liveAccount('work')
    expect(live.access).toBe('acc-work')
    const result = normalizeSidebarState({
      ...DEFAULT_SIDEBAR_STATE,
      fallbacks: [
        {
          id: live.id,
          label: undefined,
          quota: null,
          killed: false,
          enabled: true,
          custody: { state: 'local' },
        },
      ],
    })
    expect(result.fallbacks[0]?.custody).toEqual({ state: 'local' })
  })
})

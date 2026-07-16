import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { AccountStorage, OAuthQuotaSnapshot } from '../core/accounts.ts'
import type { QuotaManager } from '../core/quota-manager.ts'
import {
  buildSidebarMachineState,
  buildSidebarState,
  mergePushedQuotaMetadata,
} from '../index.ts'
import { normalizeQuotaHeaders } from '../quota-normalize.ts'
import type { SidebarState } from '../sidebar-state.ts'
import { FLOOR_AUTH_FILE, FLOOR_STATE_FILE } from './setup-env.ts'

let origAuthFile: string | undefined
let origStateFile: string | undefined
let tempDir: string

beforeEach(() => {
  origAuthFile = process.env.OPENCODE_OPENAI_AUTH_FILE
  origStateFile = process.env.OPENCODE_OPENAI_AUTH_STATE_FILE
  const { mkdtempSync } = require('node:fs')
  const { tmpdir } = require('node:os')
  const { join } = require('node:path')
  tempDir = mkdtempSync(join(tmpdir(), 'oai-quota-push-'))
  process.env.OPENCODE_OPENAI_AUTH_FILE = join(tempDir, 'openai-auth.json')
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(
    tempDir,
    'openai-auth-state.json',
  )
})

afterEach(() => {
  // Restore to the saved value (which is the floor when the preload is
  // active) rather than deleting — never leave the env unset.
  process.env.OPENCODE_OPENAI_AUTH_FILE = origAuthFile ?? FLOOR_AUTH_FILE
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE =
    origStateFile ?? FLOOR_STATE_FILE
  try {
    const { rmSync } = require('node:fs')
    rmSync(tempDir, { recursive: true, force: true })
  } catch {}
})

function goodSnapshot(): OAuthQuotaSnapshot {
  return normalizeQuotaHeaders(
    new Headers({
      'x-codex-primary-used-percent': '10',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': '1781729038',
    }),
  )
}

describe('QuotaManager push', () => {
  it('setMain push updates getMain without any network', async () => {
    const { QuotaManager } = await import('../core/quota-manager.ts')
    const token = `access-${randomUUID()}`
    const snapshot = goodSnapshot()

    const qm = new QuotaManager({
      storage: null,
      fetchQuotaFn: () => {
        throw new Error('must not be called')
      },
    })

    expect(qm.getMain()).toBeNull()

    qm.setMain(token, {
      quota: snapshot,
      refreshAfter: Date.now() + 60_000,
      checkedAt: Date.now(),
    })
    const entry = qm.getMain(token)
    expect(entry).not.toBeNull()
    expect(entry!.quota.primary?.usedPercent).toBe(10)
    expect(entry!.quota.primary?.remainingPercent).toBe(90)
  })

  it('peekMainForPolicy survives a token refresh but drops on an account switch', async () => {
    const { QuotaManager } = await import('../core/quota-manager.ts')
    const oldToken = `access-old-${randomUUID()}`
    const newToken = `access-new-${randomUUID()}`
    const snapshot = goodSnapshot()

    const qm = new QuotaManager({
      storage: null,
      fetchQuotaFn: () => {
        throw new Error('must not be called')
      },
    })

    // Quota pushed for account "acct-A" with the old token.
    qm.setMain(
      oldToken,
      {
        quota: snapshot,
        refreshAfter: Date.now() + 60_000,
        checkedAt: Date.now(),
      },
      'acct-A',
    )

    // A normal token refresh (same account, new access token) must NOT drop the
    // policy view — the killswitch still sees the account's quota.
    const afterRefresh = qm.peekMainForPolicy('acct-A')
    expect(afterRefresh).not.toBeNull()
    expect(afterRefresh!.quota.primary?.usedPercent).toBe(10)

    // No-identity peek also returns the cached entry (best-effort).
    expect(qm.peekMainForPolicy()).not.toBeNull()

    // Contrast: the invalidating display read with the NEW token drops the
    // cache (token-bound) — this is exactly the path the leak fix bypasses.
    expect(qm.getMain(newToken)).toBeNull()

    // A genuine account SWITCH (different ChatGPT id) drops the policy view, so
    // the killswitch never judges account B by account A's quota.
    qm.setMain(
      oldToken,
      {
        quota: snapshot,
        refreshAfter: Date.now() + 60_000,
        checkedAt: Date.now(),
      },
      'acct-A',
    )
    expect(qm.peekMainForPolicy('acct-B')).toBeNull()
  })

  it('peekFallbackForPolicy survives a token refresh (keyed by stable account id)', async () => {
    const { QuotaManager } = await import('../core/quota-manager.ts')
    const oldToken = `fb-old-${randomUUID()}`
    const newToken = `fb-new-${randomUUID()}`
    const snapshot = goodSnapshot()

    const qm = new QuotaManager({
      storage: null,
      fetchQuotaFn: () => {
        throw new Error('must not be called')
      },
    })

    qm.setFallback(
      'fb-1',
      {
        quota: snapshot,
        refreshAfter: Date.now() + 60_000,
        checkedAt: Date.now(),
      },
      oldToken,
    )

    // Token refresh for the same fallback id: policy peek still sees it.
    expect(qm.peekFallbackForPolicy('fb-1')).not.toBeNull()
    // But the invalidating display read with the new token drops it.
    expect(qm.getFallback('fb-1', newToken)).toBeNull()
  })

  it('conditional push: empty snapshot does NOT overwrite a valid cached one', async () => {
    const { QuotaManager } = await import('../core/quota-manager.ts')
    const token = `access-${randomUUID()}`
    const snapshot = goodSnapshot()

    const qm = new QuotaManager({
      storage: null,
      fetchQuotaFn: () => {
        throw new Error('must not be called')
      },
    })

    qm.setMain(token, {
      quota: snapshot,
      refreshAfter: Date.now() + 60_000,
      checkedAt: Date.now(),
    })

    // Push empty snapshot — must NOT overwrite
    qm.setMain(token, {
      quota: {},
      refreshAfter: Date.now() + 60_000,
      checkedAt: Date.now(),
    })
    const entry = qm.getMain(token)
    expect(entry).not.toBeNull()
    // Still has the good snapshot
    expect(entry!.quota.primary?.usedPercent).toBe(10)
  })

  it('conditional push: reset-credit metadata alone does NOT count as a window and must not overwrite a valid cached snapshot', async () => {
    const { QuotaManager } = await import('../core/quota-manager.ts')
    const token = `access-${randomUUID()}`
    const snapshot = goodSnapshot()

    const qm = new QuotaManager({
      storage: null,
      fetchQuotaFn: () => {
        throw new Error('must not be called')
      },
    })

    qm.setMain(token, {
      quota: snapshot,
      refreshAfter: Date.now() + 60_000,
      checkedAt: Date.now(),
    })

    // A push carrying only metadata (no window data) must be treated the
    // same as an empty snapshot — the conditional-push guard is about
    // window presence, not key presence.
    qm.setMain(token, {
      quota: { resetCreditsAvailable: 4 },
      refreshAfter: Date.now() + 60_000,
      checkedAt: Date.now(),
    })
    const entry = qm.getMain(token)
    expect(entry).not.toBeNull()
    expect(entry!.quota.primary?.usedPercent).toBe(10)
  })

  it('conditional push: an explicit zero-window quota IS a real window and overwrites the cache', async () => {
    const { QuotaManager } = await import('../core/quota-manager.ts')
    const token = `access-${randomUUID()}`
    const snapshot = goodSnapshot()

    const qm = new QuotaManager({
      storage: null,
      fetchQuotaFn: () => {
        throw new Error('must not be called')
      },
    })

    qm.setMain(token, {
      quota: snapshot,
      refreshAfter: Date.now() + 60_000,
      checkedAt: Date.now(),
    })

    qm.setMain(token, {
      quota: {
        primary: { usedPercent: 100, remainingPercent: 0, checkedAt: 1 },
      },
      refreshAfter: Date.now() + 60_000,
      checkedAt: Date.now(),
    })
    const entry = qm.getMain(token)
    expect(entry!.quota.primary?.usedPercent).toBe(100)
  })

  it('setFallback push updates getFallback without any network', async () => {
    const { QuotaManager } = await import('../core/quota-manager.ts')
    const accountId = randomUUID()
    const token = `access-${randomUUID()}`
    const snapshot = goodSnapshot()

    const qm = new QuotaManager({
      storage: null,
      fetchQuotaFn: () => {
        throw new Error('must not be called')
      },
    })

    expect(qm.getFallback(accountId)).toBeNull()

    qm.setFallback(
      accountId,
      {
        quota: snapshot,
        refreshAfter: Date.now() + 60_000,
        checkedAt: Date.now(),
      },
      token,
    )
    const entry = qm.getFallback(accountId, token)
    expect(entry).not.toBeNull()
    expect(entry!.quota.primary?.usedPercent).toBe(10)
  })

  it('conditional push: empty fallback snapshot does NOT overwrite a valid cached one', async () => {
    const { QuotaManager } = await import('../core/quota-manager.ts')
    const accountId = randomUUID()
    const token = `access-${randomUUID()}`
    const snapshot = goodSnapshot()

    const qm = new QuotaManager({
      storage: null,
      fetchQuotaFn: () => {
        throw new Error('must not be called')
      },
    })

    qm.setFallback(
      accountId,
      {
        quota: snapshot,
        refreshAfter: Date.now() + 60_000,
        checkedAt: Date.now(),
      },
      token,
    )

    // Push empty — must NOT overwrite
    qm.setFallback(
      accountId,
      { quota: {}, refreshAfter: Date.now() + 60_000, checkedAt: Date.now() },
      token,
    )
    const entry = qm.getFallback(accountId, token)
    expect(entry).not.toBeNull()
    expect(entry!.quota.primary?.usedPercent).toBe(10)
  })

  it('preserves last-known reset credits when a per-turn push omits them', () => {
    const previous: OAuthQuotaSnapshot = {
      primary: {
        usedPercent: 10,
        remainingPercent: 90,
        checkedAt: 1,
        windowMinutes: 10_080,
      },
      resetCreditsAvailable: 4,
    }
    const incoming: OAuthQuotaSnapshot = {
      primary: {
        usedPercent: 20,
        remainingPercent: 80,
        checkedAt: 2,
        windowMinutes: 10_080,
      },
    }

    expect(
      mergePushedQuotaMetadata(incoming, previous).resetCreditsAvailable,
    ).toBe(4)
    expect(
      mergePushedQuotaMetadata(
        { ...incoming, resetCreditsAvailable: 0 },
        previous,
      ).resetCreditsAvailable,
    ).toBe(0)
  })

  it('publishes each account reset-credit count independently of the active account', async () => {
    const { QuotaManager } = await import('../core/quota-manager.ts')
    const qm: QuotaManager = new QuotaManager({ storage: null })
    qm.setMain('main-token', {
      quota: {
        primary: {
          usedPercent: 20,
          remainingPercent: 80,
          checkedAt: 1,
          windowMinutes: 10_080,
        },
        resetCreditsAvailable: 4,
      },
      refreshAfter: 2,
      checkedAt: 1,
    })
    qm.setFallback(
      'fallback-1',
      {
        quota: {
          primary: {
            usedPercent: 30,
            remainingPercent: 70,
            checkedAt: 1,
            windowMinutes: 10_080,
          },
          resetCreditsAvailable: 2,
        },
        refreshAfter: 2,
        checkedAt: 1,
      },
      'fallback-token',
    )
    const store: AccountStorage = {
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      accounts: [
        {
          id: 'fallback-1',
          type: 'oauth',
          access: 'fallback-token',
          refresh: 'fallback-refresh',
          expires: 10,
          enabled: true,
        },
      ],
    }

    const machine = buildSidebarMachineState(qm, store, 10)
    const expectedMachine = {
      main: {
        quota: {
          primary: {
            usedPercent: 20,
            remainingPercent: 80,
            checkedAt: 1,
            windowMinutes: 10_080,
          },
          resetCreditsAvailable: 4,
        },
        killed: false,
        resetCredits: 4,
      },
      fallbacks: [
        {
          id: 'fallback-1',
          label: undefined,
          quota: {
            primary: {
              usedPercent: 30,
              remainingPercent: 70,
              checkedAt: 1,
              windowMinutes: 10_080,
            },
            resetCreditsAvailable: 2,
          },
          killed: false,
          enabled: true,
          resetCredits: 2,
        },
      ],
      route: 'main-first',
      lastUpdated: 10,
    }
    expect(machine).toEqual(expectedMachine)

    const legacy = buildSidebarState(qm, store, 'fallback-1', 10)
    expect(legacy).toEqual({ ...machine, activeId: 'fallback-1' })
    expect(
      (legacy as SidebarState & { resetCredits?: number }).resetCredits,
    ).toBeUndefined()
  })
})

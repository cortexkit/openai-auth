import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { OAuthQuotaSnapshot } from '../core/accounts.ts'
import { normalizeQuotaHeaders } from '../quota-normalize.ts'
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
})

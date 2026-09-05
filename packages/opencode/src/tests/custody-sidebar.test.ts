import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountStorage,
  loadAccounts,
  saveAccounts,
} from '../core/accounts.ts'
import {
  CUSTODY_INERT_REASONS,
  type CustodyVerdict,
} from '../core/custody-state.ts'
import {
  DEFAULT_SIDEBAR_STATE,
  normalizeSidebarState,
  projectCustodyForSidebar,
  type SidebarState,
} from '../sidebar-state.ts'
import { claustrumConfig } from './custody-fixtures.ts'

describe('plugin-wide claustrum mode', () => {
  test('round-trips explicit local and claustrum modes on disk', async () => {
    const authDir = mkdtempSync(join(tmpdir(), 'oai-custody-sidebar-'))
    const cfgPath = join(authDir, 'openai-auth.json')
    try {
      for (const mode of ['local', 'claustrum'] as const) {
        const storage: AccountStorage = {
          version: 1,
          main: { type: 'opencode', provider: 'openai' },
          accounts: [],
          claustrum: claustrumConfig({ mode }),
        }
        await saveAccounts(storage, cfgPath)
        expect((await loadAccounts(cfgPath))?.claustrum?.mode).toBe(mode)
      }
    } finally {
      rmSync(authDir, { recursive: true, force: true })
    }
  })

  test('rejects legacy switches rather than accepting them as a mode', async () => {
    const authDir = mkdtempSync(join(tmpdir(), 'oai-custody-sidebar-'))
    const cfgPath = join(authDir, 'openai-auth.json')
    try {
      writeFileSync(
        cfgPath,
        JSON.stringify({
          version: 1,
          main: { type: 'opencode', provider: 'openai' },
          accounts: [],
          claustrum: { enabled: true, manifestWrite: true },
        }),
      )
      await expect(loadAccounts(cfgPath)).rejects.toThrow(
        'Remove the legacy claustrum switches and run /openai-account claustrum',
      )
    } finally {
      rmSync(authDir, { recursive: true, force: true })
    }
  })

  test('keeps a config with no claustrum block byte-identical on read', async () => {
    const authDir = mkdtempSync(join(tmpdir(), 'oai-custody-sidebar-'))
    const cfgPath = join(authDir, 'openai-auth.json')
    try {
      const raw = JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'openai' },
        accounts: [],
      })
      writeFileSync(cfgPath, raw)
      const loaded = await loadAccounts(cfgPath)
      expect(loaded?.claustrum).toBeUndefined()
      expect(readFileSync(cfgPath, 'utf8')).toBe(raw)
    } finally {
      rmSync(authDir, { recursive: true, force: true })
    }
  })
})

function stateWithCustody(custody: unknown): SidebarState {
  return {
    ...DEFAULT_SIDEBAR_STATE,
    fallbacks: [
      {
        id: 'fallback-1',
        label: undefined,
        quota: null,
        killed: false,
        enabled: true,
        custody: custody as never,
      },
    ],
  }
}

describe('projectCustodyForSidebar — v7 verdict projection', () => {
  test('maps every inert reason without transition metadata', () => {
    for (const reason of CUSTODY_INERT_REASONS) {
      const projected = projectCustodyForSidebar({ kind: 'INERT', reason })
      expect(projected).toEqual({ state: 'inert', reason })
      expect(JSON.stringify(projected)).not.toContain('fingerprint')
      expect(JSON.stringify(projected)).not.toContain('generation')
      expect(JSON.stringify(projected)).not.toContain('revision')
    }
  })

  test.each([
    { verdict: { kind: 'LOCAL' }, want: { state: 'local' } },
    { verdict: { kind: 'VAULT' }, want: { state: 'vault' } },
    { verdict: { kind: 'NEEDS_LOGIN' }, want: { state: 'needsLogin' } },
    {
      verdict: { kind: 'NEEDS_LOGIN', reason: 'corrupt' },
      want: { state: 'needsLogin', reason: 'corrupt' },
    },
  ] as const)('projects $verdict.kind', ({ verdict, want }) => {
    expect(projectCustodyForSidebar(verdict as CustodyVerdict)).toEqual(want)
  })

  test('accepts legacy consumer inputs without projecting v6 sidebar vocabulary', () => {
    const projected = projectCustodyForSidebar({
      tombstoned: true,
      storageEnabled: true,
      enrolled: true,
      enrollPendingReason: 'completionDisarmed',
      cache: {
        isBlocked: () => false,
        isReauth: () => false,
        async peekMetadata() {
          return { recordVersion: 7, expiresAtMs: 1 }
        },
      },
    })
    expect(projected).toEqual({ state: 'inert', reason: 'manifest-unreadable' })
    expect(JSON.stringify(projected)).not.toContain('enrollPending')
    expect(JSON.stringify(projected)).not.toContain('completionDisarmed')
    expect(JSON.stringify(projected)).not.toContain('recordVersion')
  })
})

describe('normalizeSidebarState — v7 custody reader', () => {
  test('drops unknown states and removed v6 states', () => {
    for (const state of [
      'vaultHealing',
      'vaultReauth',
      'vaultGone',
      'enrollPending',
    ]) {
      expect(
        normalizeSidebarState(stateWithCustody({ state })).fallbacks[0]
          ?.custody,
      ).toBeUndefined()
    }
  })

  test('drops unknown and removed v6 reasons but keeps the inert state', () => {
    for (const reason of [
      'experimental',
      'unavailable',
      'gone',
      'identityMismatch',
      'nullClaim',
      'completionDisarmed',
    ]) {
      expect(
        normalizeSidebarState(stateWithCustody({ state: 'inert', reason }))
          .fallbacks[0]?.custody,
      ).toEqual({ state: 'inert' })
    }
  })

  test('round-trips every v7 state and reason exactly', () => {
    for (const reason of CUSTODY_INERT_REASONS) {
      expect(
        normalizeSidebarState(stateWithCustody({ state: 'inert', reason }))
          .fallbacks[0]?.custody,
      ).toEqual({ state: 'inert', reason })
    }
    expect(
      normalizeSidebarState(stateWithCustody({ state: 'local' })).fallbacks[0]
        ?.custody,
    ).toEqual({
      state: 'local',
    })
    expect(
      normalizeSidebarState(stateWithCustody({ state: 'vault' })).fallbacks[0]
        ?.custody,
    ).toEqual({
      state: 'vault',
    })
    expect(
      normalizeSidebarState(
        stateWithCustody({ state: 'needsLogin', reason: 'corrupt' }),
      ).fallbacks[0]?.custody,
    ).toEqual({
      state: 'needsLogin',
      reason: 'corrupt',
    })
  })

  test('drops transition metadata from persisted output', () => {
    expect(
      normalizeSidebarState(
        stateWithCustody({
          state: 'inert',
          reason: 'takeover-incomplete',
          fingerprint: 'secret',
          generation: 7,
          revision: 'abc',
          recordVersion: 11,
        }),
      ).fallbacks[0]?.custody,
    ).toEqual({ state: 'inert', reason: 'takeover-incomplete' })
  })

  test('drops v6 state, reason, and recordVersion from consumer output', () => {
    expect(
      normalizeSidebarState(
        stateWithCustody({
          state: 'enrollPending',
          reason: 'completionDisarmed',
          recordVersion: 7,
        }),
      ).fallbacks[0]?.custody,
    ).toBeUndefined()
  })
})

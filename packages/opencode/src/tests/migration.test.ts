import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FLOOR_AUTH_FILE, FLOOR_STATE_FILE } from './setup-env.ts'

let dir: string
let cfgPath: string
let statePath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oai-mig-'))
  cfgPath = join(dir, 'openai-auth.json')
  statePath = join(dir, 'openai-auth-state.json')
  process.env.OPENCODE_OPENAI_AUTH_FILE = cfgPath
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = statePath
})

afterEach(() => {
  // Restore to the floor (not delete) so any in-flight write resolves to a
  // temp path rather than the operator's live default.
  process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
})

describe('migration', () => {
  it('seeds account store from a settings-only openai-auth.json without dropping transport keys', async () => {
    // Write a settings-only config (no accounts/version key)
    writeFileSync(
      cfgPath,
      JSON.stringify({ webSockets: true, rawWebSocket: true, dump: false }),
    )

    const { migrateIfNeeded, loadAccounts } = await import(
      '../core/accounts.ts'
    )

    const existingToken = {
      type: 'oauth' as const,
      access: 'existing-access',
      refresh: 'existing-refresh',
      expires: Date.now() + 3600_000,
    }

    await migrateIfNeeded(existingToken, cfgPath)

    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    // Transport keys preserved (FE-5)
    expect(cfg.webSockets).toBe(true)
    expect(cfg.rawWebSocket).toBe(true)
    // Content discriminator present
    expect(cfg.version).toBe(1)
    expect(Array.isArray(cfg.accounts)).toBe(true)

    const loaded = await loadAccounts(cfgPath)
    expect(loaded).not.toBeNull()
    // FIX 1: main.type==='opencode' means the active token lives in
    // opencode's single-slot store (read via getAuth). accounts[] is
    // empty — no fallback candidates until explicitly added.
    expect(loaded!.main?.type).toBe('opencode')
    expect(loaded!.main?.provider).toBe('openai')
    expect(loaded!.accounts.length).toBe(0)
  })

  it('is idempotent — second run does not re-migrate or duplicate', async () => {
    // Start with a settings-only config
    writeFileSync(cfgPath, JSON.stringify({ webSockets: true, dump: false }))

    const { migrateIfNeeded, loadAccounts } = await import(
      '../core/accounts.ts'
    )

    const existingToken = {
      type: 'oauth' as const,
      access: 'existing-access',
      refresh: 'existing-refresh',
      expires: Date.now() + 3600_000,
    }

    // First migration
    await migrateIfNeeded(existingToken, cfgPath)
    const loaded1 = await loadAccounts(cfgPath)
    expect(loaded1!.main?.type).toBe('opencode')
    expect(loaded1!.accounts.length).toBe(0)

    // Second migration — must be a no-op
    await migrateIfNeeded(existingToken, cfgPath)
    const loaded2 = await loadAccounts(cfgPath)
    expect(loaded2!.main?.type).toBe('opencode')
    expect(loaded2!.accounts.length).toBe(0)
  })

  it('tolerates expired token — still migrates', async () => {
    writeFileSync(cfgPath, JSON.stringify({ dump: true }))

    const { migrateIfNeeded, loadAccounts } = await import(
      '../core/accounts.ts'
    )

    const expiredToken = {
      type: 'oauth' as const,
      access: 'expired-access',
      refresh: 'expired-refresh',
      expires: Date.now() - 3600_000, // expired 1 hour ago
    }

    await migrateIfNeeded(expiredToken, cfgPath)
    const loaded = await loadAccounts(cfgPath)
    expect(loaded!.main?.type).toBe('opencode')
    expect(loaded!.accounts.length).toBe(0)
  })

  it('no-op when no token provided', async () => {
    writeFileSync(cfgPath, JSON.stringify({ webSockets: true }))

    const { migrateIfNeeded, loadAccounts } = await import(
      '../core/accounts.ts'
    )

    await migrateIfNeeded(undefined, cfgPath)
    const loaded = await loadAccounts(cfgPath)
    expect(loaded).toBeNull() // still a settings-only file
  })
})

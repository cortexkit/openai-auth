import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  chmodSync,
  constants as fsConstants,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAccountStoragePath } from '../core/account-paths.ts'
import {
  type AccountStorage,
  loadAccounts,
  normalizeAccount,
  saveAccounts,
} from '../core/accounts.ts'
import {
  assertNoCustodyTombstoneMaterial,
  ClaustrumCredentialCache,
  CUSTODY_EXCLUDED,
  CUSTODY_REFUSE,
  CUSTODY_TOMBSTONE_PREFIX,
  custodied,
  custodyTombstoneKey,
  enrolled,
  enrolling,
  excluded,
  reconcileFallbackCustody,
  refreshInert,
  resolveFallbackAccess,
  tombstoned,
  type VaultProvenance,
  verifyServedFallbackIdentity,
} from '../core/custody.ts'
import { readCustodyManifest } from '../core/custody-manifest.ts'
import { acquireRefreshFileLock } from '../core/refresh-file-lock.ts'
import {
  CUSTODY_FIXTURE_NOW,
  claustrumConfig,
  enrollmentManifest,
  liveAccount,
  liveStorage,
  makeSentinelAccount,
  TOMBSTONE_OPENAI,
} from './custody-fixtures.ts'
import {
  assertFloor,
  FLOOR_CLAUSTRUM_HANDLES,
  FLOOR_CLAUSTRUM_HANDLES_LOCK,
} from './setup-env.ts'

const TEST_OAUTH_HANDLES_ENV = 'CLAUSTRUM_OPENCODE_HANDLES'

let handlesDir: string
let handlesPath: string

beforeEach(async () => {
  handlesDir = mkdtempSync(join(tmpdir(), 'custody-test-'))
  handlesPath = join(handlesDir, 'opencode-handles.json')
  process.env[TEST_OAUTH_HANDLES_ENV] = handlesPath
})

afterEach(() => {
  // Restore to floor — never delete, so any in-flight reads resolve to a temp path.
  process.env[TEST_OAUTH_HANDLES_ENV] = FLOOR_CLAUSTRUM_HANDLES
  try {
    rmSync(handlesDir, { recursive: true, force: true })
  } catch {}
})

// ---------------------------------------------------------------------------
// Tombstone sentinel
// ---------------------------------------------------------------------------

describe('custodyTombstoneKey', () => {
  it('produces the per-provider sentinel using the documented prefix', () => {
    expect(custodyTombstoneKey('openai')).toBe('claustrum-tombstone:v1:openai')
    expect(CUSTODY_TOMBSTONE_PREFIX).toBe('claustrum-tombstone:v1:')
  })

  it('normalizes a canonical tombstone with empty access (preserves the account on load)', async () => {
    const sentinel = makeSentinelAccount({ access: '' })
    // If normalizeAccount dropped the entry, the list would be empty and the
    // tombstone would vanish. Assert it survives normalisation as an account
    // with empty access, sentinel refresh, and expiry zero so callers can
    // observe the tombstone rather than silently losing the entry.
    const normalized = normalizeAccount({
      id: sentinel.id,
      type: 'oauth',
      access: sentinel.access,
      refresh: sentinel.refresh,
      expires: sentinel.expires,
    })
    expect(normalized).not.toBeNull()
    expect(normalized?.type).toBe('oauth')
    if (normalized?.type !== 'oauth') throw new Error('expected oauth')
    expect(normalized.access).toBe('')
    expect(normalized.refresh).toBe(TOMBSTONE_OPENAI)
    expect(normalized.expires).toBe(0)
  })

  it('round-trips a canonical tombstone through saveAccounts/loadAccounts', async () => {
    const cfg = liveStorage([makeSentinelAccount({ access: '' })])
    await saveAccounts(cfg, getAccountStoragePath())
    const loaded = await loadAccounts()
    expect(loaded).not.toBeNull()
    const account = loaded?.accounts[0]
    expect(account?.type).toBe('oauth')
    if (account?.type !== 'oauth') throw new Error('expected oauth')
    expect(account.access).toBe('')
    expect(account.refresh).toBe(TOMBSTONE_OPENAI)
    expect(account.expires).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Manifest reader
// ---------------------------------------------------------------------------

async function writeManifest(providers: unknown[]): Promise<void> {
  const fd = openSync(
    handlesPath,
    fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_TRUNC,
    0o600,
  )
  const json = JSON.stringify({ version: 1, providers })
  writeSync(fd, json)
  // Belt-and-braces: openSync with O_CREAT honours mode on POSIX but some
  // platforms may differ — chmod to the desired 0o600 to keep the manifest
  // reader's mode check deterministic across test runs.
  chmodSync(handlesPath, 0o600)
}

describe('readCustodyManifest', () => {
  it('manifest revision changes when only parsed source whitespace changes', async () => {
    const source = JSON.stringify({
      version: 1,
      providers: [
        {
          provider: 'openai',
          shape: 'oauth',
          serve: 'openai-auth',
          accounts: [
            {
              label: 'main',
              handle: `ckh_${'a'.repeat(43)}`,
              credential_id: 'oauth:openai:main',
            },
          ],
        },
      ],
    })
    writeFileSync(handlesPath, source, { mode: 0o600 })
    chmodSync(handlesPath, 0o600)
    const first = await readCustodyManifest(handlesPath)
    writeFileSync(handlesPath, `\n${source}\n`, { mode: 0o600 })
    chmodSync(handlesPath, 0o600)
    const second = await readCustodyManifest(handlesPath)

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) throw new Error('expected valid manifests')
    expect(first.revision).not.toBe(second.revision)
  })

  it('manifest revision is stable for the same bytes across two reads', async () => {
    const source = JSON.stringify({
      version: 1,
      providers: [
        {
          provider: 'openai',
          shape: 'oauth',
          serve: 'openai-auth',
          accounts: [
            {
              label: 'main',
              handle: `ckh_${'a'.repeat(43)}`,
              credential_id: 'oauth:openai:main',
            },
          ],
        },
      ],
    })
    writeFileSync(handlesPath, source, { mode: 0o600 })
    chmodSync(handlesPath, 0o600)

    const first = await readCustodyManifest(handlesPath)
    const second = await readCustodyManifest(handlesPath)

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) throw new Error('expected valid manifests')
    expect(first.revision).toMatch(/^[a-f0-9]{64}$/)
    expect(first.revision).toBe(second.revision)
  })

  it('reads a regular 0600 file owned by the current uid', async () => {
    const handle = `ckh_${'a'.repeat(43)}`
    await writeManifest([
      {
        provider: 'openai',
        shape: 'oauth',
        serve: 'openai-auth',
        accounts: [
          { label: 'main', handle, credential_id: 'oauth:openai:main' },
        ],
      },
    ])
    const result = await readCustodyManifest(handlesPath)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.providers).toHaveLength(1)
    expect(result.value.providers[0]?.provider).toBe('openai')
    expect(result.value.providers[0]?.accounts[0]?.handle).toBe(handle)
  })

  it('rejects files larger than 256 KiB', async () => {
    const big = JSON.stringify({ version: 1, providers: [] }).padEnd(
      257 * 1024,
      ' ',
    )
    writeFileSync(handlesPath, big, { mode: 0o600 })
    const result = await readCustodyManifest(handlesPath)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('tooLarge')
  })

  it('rejects handles that do not match the ckh_… pattern (mixed case)', async () => {
    // Mixed-case A-Z is allowed, but missing the ckh_ prefix or wrong length is not.
    await writeManifest([
      {
        provider: 'openai',
        shape: 'oauth',
        serve: 'openai-auth',
        accounts: [
          {
            label: 'main',
            handle: `ckh_${'A'.repeat(43)}`,
            credential_id: 'oauth:openai:main',
          },
          {
            label: 'work',
            handle: 'BADHANDLE',
            credential_id: 'oauth:openai:work',
          },
        ],
      },
    ])
    const result = await readCustodyManifest(handlesPath)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('invalid')
  })

  it('rejects prototype keys as identifiers', async () => {
    await writeManifest([
      {
        provider: 'openai',
        shape: 'oauth',
        serve: 'openai-auth',
        accounts: [
          {
            label: '__proto__',
            handle: `ckh_${'a'.repeat(43)}`,
            credential_id: 'oauth:openai:x',
          },
        ],
      },
    ])
    const result = await readCustodyManifest(handlesPath)
    expect(result.ok).toBe(false)
  })

  it('rejects manifest version != 1', async () => {
    const fd = openSync(
      handlesPath,
      fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_TRUNC,
      0o600,
    )
    writeSync(fd, JSON.stringify({ version: 2, providers: [] }))
    chmodSync(handlesPath, 0o600)
    const result = await readCustodyManifest(handlesPath)
    expect(result.ok).toBe(false)
  })

  it('joins case-exactly on label === account.id (not on credential_id suffix)', async () => {
    // Manifest label is 'Main', local account id is 'main' — should NOT match.
    await writeManifest([
      {
        provider: 'openai',
        shape: 'oauth',
        serve: 'openai-auth',
        accounts: [
          {
            label: 'Main',
            handle: `ckh_${'a'.repeat(43)}`,
            credential_id: 'oauth:openai:main',
          },
        ],
      },
    ])
    const acct = liveAccount('main')
    expect(enrolled(acct, await readCustodyManifest(handlesPath))).toBe(false)

    // Same handle + credential_id, but label exactly matches the id — IS enrolled.
    await writeManifest([
      {
        provider: 'openai',
        shape: 'oauth',
        serve: 'openai-auth',
        accounts: [
          {
            label: 'main',
            handle: `ckh_${'a'.repeat(43)}`,
            credential_id: 'oauth:openai:main',
          },
        ],
      },
    ])
    expect(enrolled(acct, await readCustodyManifest(handlesPath))).toBe(true)
  })

  it('returns invalid JSON without leaking a handle or a cause', async () => {
    // An unquoted ckh_… beside a SyntaxError must produce a stable message —
    // no handle in the message, no `cause` set, and the file is rejected cleanly.
    const mixed = '{"providers":[{"handle":"ckh_LEAKED_HANDLE_VALUE_BAD"'
    writeFileSync(handlesPath, mixed, { mode: 0o600 })
    const result = await readCustodyManifest(handlesPath)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('invalid')
    if (result.reason === 'invalid') {
      expect(result.message).toBe('invalid JSON')
      // The 'cause' field must NOT be set — the parser drops it to keep the
      // SyntaxError payload (which may contain a handle) off the log/error
      // surface.
      expect((result as { cause?: unknown }).cause).toBeUndefined()
      expect(result.message.includes('ckh_')).toBe(false)
    }
  })

  it('rejects files with mode != 0600', async () => {
    await writeManifest([
      {
        provider: 'openai',
        shape: 'oauth',
        serve: 'openai-auth',
        accounts: [
          {
            label: 'main',
            handle: `ckh_${'a'.repeat(43)}`,
            credential_id: 'oauth:openai:main',
          },
        ],
      },
    ])
    chmodSync(handlesPath, 0o644)
    const result = await readCustodyManifest(handlesPath)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('permissions')
  })

  it('rejects files whose parent is not safe', async () => {
    const unsafeParent = join(handlesDir, 'unsafe-parent')
    mkdirSync(unsafeParent, { mode: 0o755, recursive: true })
    const unsafePath = join(unsafeParent, 'handles.json')
    writeFileSync(unsafePath, JSON.stringify({ version: 1, providers: [] }), {
      mode: 0o600,
    })
    // 0o755 = no sticky bit, no group/other write — but no longer 0700 either.
    // Too-permissive parent (0o755) trips the safe-parent check.
    chmodSync(unsafeParent, 0o755)
    const result = await readCustodyManifest(unsafePath)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(
      result.reason === 'permissions' || result.reason === 'unsafeParent',
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

describe('predicates', () => {
  it('enrolled = case-exact manifest account label === account.id (storage toggle is not a parameter)', async () => {
    await writeManifest([
      {
        provider: 'openai',
        shape: 'oauth',
        serve: 'openai-auth',
        accounts: [
          {
            label: 'main',
            handle: `ckh_${'a'.repeat(43)}`,
            credential_id: 'oauth:openai:main',
          },
        ],
      },
    ])
    const m = await readCustodyManifest(handlesPath)
    const acct = liveAccount('main')
    expect(enrolled(acct, m)).toBe(true)
    const other = liveAccount('other')
    expect(enrolled(other, m)).toBe(false)
    // Storage.claustrum cannot influence enrollment — the predicate does not
    // accept it as a parameter; the test name states the invariant.
  })

  it('recognizes an oauth tombstone from the exact provider refresh sentinel alone', () => {
    expect(tombstoned(makeSentinelAccount(), 'openai')).toBe(true)
    // A refresh mismatch remains a local credential, regardless of access.
    expect(
      tombstoned(
        { ...makeSentinelAccount(), refresh: 'live-refresh' },
        'openai',
      ),
    ).toBe(false)
    // A partial or corrupt write is still custody evidence. Removing this
    // refresh-only recognition would send the sentinel into local refresh.
    expect(
      tombstoned(
        makeSentinelAccount({
          access: 'stale',
          refresh: TOMBSTONE_OPENAI,
          expires: CUSTODY_FIXTURE_NOW + 60_000,
        }),
        'openai',
      ),
    ).toBe(true)
  })

  it('custodied requires claustrum mode + enrolled + tombstoned', async () => {
    const m = await readCustodyManifest(handlesPath) // empty manifest
    const sentinel = makeSentinelAccount()
    expect(
      custodied(
        sentinel,
        m,
        liveStorage([], { claustrum: claustrumConfig({ mode: 'claustrum' }) }),
      ),
    ).toBe(false)
    await writeManifest([
      {
        provider: 'openai',
        shape: 'oauth',
        serve: 'openai-auth',
        accounts: [
          {
            label: sentinel.id,
            handle: `ckh_${'a'.repeat(43)}`,
            credential_id: 'oauth:openai:x',
          },
        ],
      },
    ])
    const m2 = await readCustodyManifest(handlesPath)
    // Toggle OFF → not custodied.
    expect(
      custodied(
        sentinel,
        m2,
        liveStorage([], { claustrum: claustrumConfig({ mode: 'local' }) }),
      ),
    ).toBe(false)
    // Toggle ON → custodied.
    expect(
      custodied(
        sentinel,
        m2,
        liveStorage([], { claustrum: claustrumConfig({ mode: 'claustrum' }) }),
      ),
    ).toBe(true)
  })

  it('foreign tombstone is not OpenAI custody but is refused before refresh', () => {
    const foreign = makeSentinelAccount({
      access: '',
      refresh: 'claustrum-tombstone:v1:anthropic',
    })
    const storage = liveStorage([foreign], {
      claustrum: claustrumConfig({ mode: 'claustrum' }),
    })
    expect(custodied(foreign, enrollmentManifest(foreign.id), storage)).toBe(
      false,
    )
    expect(() => assertNoCustodyTombstoneMaterial(foreign.refresh)).toThrow()
  })

  it('refuses every tombstone prefix but permits empty and ordinary refresh material', () => {
    expect(() =>
      assertNoCustodyTombstoneMaterial('claustrum-tombstone:v1:openai'),
    ).toThrow()
    expect(() =>
      assertNoCustodyTombstoneMaterial('claustrum-tombstone:v1:anthropic'),
    ).toThrow()
    expect(() =>
      assertNoCustodyTombstoneMaterial('ordinary-refresh'),
    ).not.toThrow()
    expect(() => assertNoCustodyTombstoneMaterial('')).not.toThrow()
  })

  it('enrolling = enrolled && !tombstoned; refreshInert = enrolled || tombstoned; excluded = tombstoned && !custodied', async () => {
    await writeManifest([
      {
        provider: 'openai',
        shape: 'oauth',
        serve: 'openai-auth',
        accounts: [
          {
            label: 'live-acct',
            handle: `ckh_${'a'.repeat(43)}`,
            credential_id: 'oauth:openai:x',
          },
          {
            label: 'tomb-acct',
            handle: `ckh_${'b'.repeat(43)}`,
            credential_id: 'oauth:openai:y',
          },
        ],
      },
    ])
    const m = await readCustodyManifest(handlesPath)
    const live = liveAccount('live-acct')
    const tomb = makeSentinelAccount()
    tomb.id = 'tomb-acct'

    expect(enrolling(live, m)).toBe(true)
    expect(enrolling(tomb, m)).toBe(false)
    expect(refreshInert(live, m, 'openai')).toBe(true)
    expect(refreshInert(tomb, m, 'openai')).toBe(true)
    expect(refreshInert(liveAccount('absent'), m, 'openai')).toBe(false)

    // excluded = tombstoned && !custodied — storage toggle OFF → excluded.
    expect(
      excluded(
        tomb,
        m,
        liveStorage([], { claustrum: claustrumConfig({ mode: 'local' }) }),
        'openai',
      ),
    ).toBe(true)
    // Toggle ON → no longer excluded.
    expect(
      excluded(
        tomb,
        m,
        liveStorage([], { claustrum: claustrumConfig({ mode: 'claustrum' }) }),
        'openai',
      ),
    ).toBe(false)
  })

  it('does not refresh an entry-present account in local mode (mode gates custodied serving, not local access)', async () => {
    // A live, enrolled account in local mode is "enrolling" and its access
    // token must still be served from local. The mode gates
    // custodied serving only, not refresh-gate decisions.
    await writeManifest([
      {
        provider: 'openai',
        shape: 'oauth',
        serve: 'openai-auth',
        accounts: [
          {
            label: 'main',
            handle: `ckh_${'a'.repeat(43)}`,
            credential_id: 'oauth:openai:main',
          },
        ],
      },
    ])
    const m = await readCustodyManifest(handlesPath)
    const acct = liveAccount('main')
    const storage = liveStorage([acct], {
      claustrum: claustrumConfig({ mode: 'local' }),
    })
    // resolveFallbackAccess observes the predicates; with toggle off + live cache,
    // it must serve local access, NOT consult the vault.
    const result = await resolveFallbackAccess(acct, storage, m)
    expect(result).not.toBe(CUSTODY_REFUSE)
    expect(result).not.toBe(CUSTODY_EXCLUDED)
    if (typeof result === 'symbol')
      throw new Error('expected resolution object')
    expect(result.provenance).toBe('local')
    expect(result.token).toBe(acct.access ?? '')
  })
})

// ---------------------------------------------------------------------------
// Identity verifier
// ---------------------------------------------------------------------------

function jwtFor(accountId: string): string {
  const claims = { chatgpt_account_id: accountId }
  const b64 = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `h.${b64}.s`
}

describe('verifyServedFallbackIdentity', () => {
  it('returns nullClaim when the served access token has no claims', () => {
    const acct = liveAccount('main', { accountId: 'acct-X' })
    const result = verifyServedFallbackIdentity(
      {
        payload: { access: 'not-a-jwt' },
        recordVersion: 1,
        expiresAtMs: Date.now() + 60_000,
      },
      acct,
    )
    expect(result).toEqual({ reason: 'nullClaim' })
  })

  it('returns identityMismatch / claimDiffersFromLocal when claims differ from the local accountId', () => {
    const acct = liveAccount('main', { accountId: 'acct-X' })
    const result = verifyServedFallbackIdentity(
      {
        payload: { access: jwtFor('acct-Y') },
        recordVersion: 1,
        expiresAtMs: Date.now() + 60_000,
      },
      acct,
    )
    expect(result).toEqual({
      reason: 'identityMismatch',
      detail: 'claimDiffersFromLocal',
    })
  })

  it('verifier compares the PARSED CLAIM, not the served string field', () => {
    // Mutation: bind the comparison to the served string instead of the parsed
    // claim. Then a mislabelled record (served string says "acct-X" but the
    // token claims a different account) would incorrectly pass.
    const acct = liveAccount('main', { accountId: 'acct-X' })
    const servedAccess = jwtFor('acct-Y') // claims a different account
    // Even if the servedAccountId (if present) is undefined, the verifier MUST
    // still reject because the parsed claim does not match the local accountId.
    const result = verifyServedFallbackIdentity(
      {
        payload: { access: servedAccess },
        recordVersion: 1,
        expiresAtMs: Date.now() + 60_000,
      },
      acct,
    )
    expect(result).toEqual({
      reason: 'identityMismatch',
      detail: 'claimDiffersFromLocal',
    })
  })

  it('passes when claims match the local accountId', () => {
    const acct = liveAccount('main', { accountId: 'acct-X' })
    const result = verifyServedFallbackIdentity(
      {
        payload: { access: jwtFor('acct-X') },
        recordVersion: 1,
        expiresAtMs: Date.now() + 60_000,
      },
      acct,
    )
    expect(result).toEqual({ reason: 'ok' })
  })

  // The conditional branch: the vendored ServedCredential has no served id,
  // so the normalized servedAccountId is undefined today. The test is `test.skip`
  // with a documented reason until the wire contract adds the field.
  it.skip('labelDisagreesWithClaim branch when a served id is present and disagrees', () => {
    // Placeholder — pending wire contract addition. Skipped intentionally so the
    // missing field does not mask the implementation gap.
  })
})

// ---------------------------------------------------------------------------
// Resolver outcomes
// ---------------------------------------------------------------------------

describe('resolveFallbackAccess', () => {
  it('returns local provenance for a live, non-tombstoned account', async () => {
    const acct = liveAccount('main')
    const m = await readCustodyManifest(handlesPath) // empty
    const result = await resolveFallbackAccess(acct, liveStorage([acct]), m)
    expect(typeof result).toBe('object')
    if (typeof result === 'symbol')
      throw new Error('expected resolution object')
    expect(result.provenance).toBe('local')
    expect(result.token).toBe(acct.access ?? '')
  })

  it('returns CUSTODY_REFUSE when the manifest is empty but the account is tombstoned', async () => {
    const acct = makeSentinelAccount()
    const m = await readCustodyManifest(handlesPath) // empty
    const storage = liveStorage([acct], {
      claustrum: claustrumConfig({ mode: 'claustrum' }),
    })
    const result = await resolveFallbackAccess(acct, storage, m)
    expect(result).toBe(CUSTODY_REFUSE)
  })

  it('returns CUSTODY_EXCLUDED for tombstoned accounts in local mode', async () => {
    const acct = makeSentinelAccount()
    const m = await readCustodyManifest(handlesPath) // empty
    const storage = liveStorage([acct], {
      claustrum: claustrumConfig({ mode: 'local' }),
    })
    const result = await resolveFallbackAccess(acct, storage, m)
    expect(result).toBe(CUSTODY_EXCLUDED)
  })

  it('mode=local + enrolled tombstone is excluded and never serves local access', async () => {
    const acct = makeSentinelAccount({ access: '' })
    const manifest = enrollmentManifest(acct.id)
    const storage = liveStorage([acct], {
      claustrum: claustrumConfig({ mode: 'local' }),
    })
    expect(await resolveFallbackAccess(acct, storage, manifest)).toBe(
      CUSTODY_EXCLUDED,
    )
  })

  it('returns vault provenance for a custodied account whose live cache serves the credential', async () => {
    const handle = `ckh_${'a'.repeat(43)}`
    const acct = makeSentinelAccount()
    await writeManifest([
      {
        provider: 'openai',
        shape: 'oauth',
        serve: 'openai-auth',
        accounts: [{ label: acct.id, handle, credential_id: 'oauth:openai:x' }],
      },
    ])
    const m = await readCustodyManifest(handlesPath)
    const storage = liveStorage([acct], {
      claustrum: claustrumConfig({ mode: 'claustrum' }),
    })
    const served = jwtFor('acct-X')
    const cache = new ClaustrumCredentialCache({
      connector: async () =>
        (async () => ({
          async getCredential(handleArg: string) {
            return {
              material: served,
              recordVersion: 7,
              expiresAtMs: Date.now() + 60_000,
            }
          },
          async statusCredential() {
            return {
              ready: true,
              lastErrorCode: null,
              leaseHeld: false,
              recordVersion: 7,
            }
          },
          async reportAuthFailure() {
            return
          },
          close() {},
        }))() as never,
    })
    // Seed the cache under the manifest handle.
    const result = await resolveFallbackAccess(acct, storage, m, {
      cache,
      manifestHandle: handle,
    })
    expect(typeof result).toBe('object')
    if (typeof result === 'symbol')
      throw new Error('expected resolution object')
    expect(result.provenance).not.toBe('local')
    const prov = result.provenance as VaultProvenance
    expect(prov.handle).toBe(handle)
    expect(prov.recordVersion).toBe(7)
    expect(result.token).toBe(served)
    cache.close()
  })

  it('returns CUSTODY_REFUSE for custodied account with empty cache', async () => {
    const handle = `ckh_${'a'.repeat(43)}`
    const acct = makeSentinelAccount()
    await writeManifest([
      {
        provider: 'openai',
        shape: 'oauth',
        serve: 'openai-auth',
        accounts: [{ label: acct.id, handle, credential_id: 'oauth:openai:x' }],
      },
    ])
    const m = await readCustodyManifest(handlesPath)
    const storage = liveStorage([acct], {
      claustrum: claustrumConfig({ mode: 'claustrum' }),
    })
    const cache = new ClaustrumCredentialCache({
      connector: async () =>
        (async () => ({
          async getCredential() {
            throw new Error('not found')
          },
          async statusCredential() {
            return {
              ready: false,
              lastErrorCode: 'nf',
              leaseHeld: false,
              recordVersion: 0,
            }
          },
          async reportAuthFailure() {
            return
          },
          close() {},
        }))() as never,
    })
    const result = await resolveFallbackAccess(acct, storage, m, {
      cache,
      manifestHandle: handle,
    })
    expect(result).toBe(CUSTODY_REFUSE)
    cache.close()
  })

  it('refuses a reauth handle even when its resident vault record is populated', async () => {
    const handle = `ckh_${'r'.repeat(43)}`
    const account = makeSentinelAccount({ accountId: 'acct-reauth' })
    await writeManifest([
      {
        provider: 'openai',
        shape: 'oauth',
        serve: 'openai-auth',
        accounts: [
          { label: account.id, handle, credential_id: 'oauth:openai:x' },
        ],
      },
    ])
    const storage = liveStorage([account], {
      claustrum: claustrumConfig({ mode: 'claustrum' }),
    })
    const manifest = await readCustodyManifest(handlesPath)
    let version = 1
    const cache = new ClaustrumCredentialCache({
      connector: async () =>
        makeFakeClient({
          getCredential: async () => ({
            material: jwtFor('acct-reauth'),
            recordVersion: version,
            expiresAtMs: Date.now() + 60_000,
          }),
        }) as never,
    })
    await cache.get(handle)
    await cache.reportAuthFailure({
      handle,
      providerStatus: 401,
      recordVersion: 1,
    })
    version = 2
    await cache.get(handle)
    await cache.reportAuthFailure({
      handle,
      providerStatus: 401,
      recordVersion: 2,
    })
    version = 3
    await cache.get(handle)
    expect(await cache.peek(handle)).toBeDefined()
    expect(cache.isReauth(handle)).toBe(true)
    expect(
      await resolveFallbackAccess(account, storage, manifest, {
        cache,
        manifestHandle: handle,
        requestPath: true,
      }),
    ).toBe(CUSTODY_REFUSE)
    cache.close()
  })
})

describe('reconcileFallbackCustody', () => {
  it('writes the canonical tombstone with empty access after vault verification', async () => {
    const now = CUSTODY_FIXTURE_NOW
    const account = liveAccount('completion-1', {
      accountId: 'acct-completion',
    })
    let storage = liveStorage([account])
    const cache = new ClaustrumCredentialCache({
      now: () => now,
      connector: async () =>
        makeFakeClient({
          getCredential: async () => ({
            material: jwtFor('acct-completion'),
            recordVersion: 7,
            expiresAtMs: now + 60_000,
          }),
        }) as never,
    })

    const result = await reconcileFallbackCustody(account, {
      loadAccounts: async () => storage,
      readCustodyManifest: async () => enrollmentManifest(account.id),
      acquireRefreshFileLock,
      configPath: join(handlesDir, 'completion-store.json'),
      cache,
      minTtlMs: 30_000,
      mutateAccounts: async (mutate) => {
        storage = mutate(storage) ?? storage
      },
      now: () => now,
    })

    expect(result).toEqual({ kind: 'succeeded', recordVersion: 7 })
    const completed = storage.accounts[0]
    expect(completed?.type).toBe('oauth')
    if (completed?.type !== 'oauth') throw new Error('expected oauth')
    expect(completed.access).toBe('')
    expect(completed.refresh).toBe(TOMBSTONE_OPENAI)
    expect(completed.expires).toBe(0)
    cache.close()
  })
})

describe('binding-pending request reconciliation', () => {
  it('uses the account lock before binding the first served identity', async () => {
    const account = makeSentinelAccount({
      id: 'binding-pending',
      accountId: undefined,
    })
    let storage = liveStorage([account], {
      claustrum: claustrumConfig({ mode: 'claustrum' }),
    })
    let lockCalls = 0
    const cache = new ClaustrumCredentialCache({
      connector: async () =>
        makeFakeClient({
          getCredential: async () => ({
            material: jwtFor('acct-bound'),
            recordVersion: 9,
            expiresAtMs: Date.now() + 60_000,
          }),
        }) as never,
    })
    const manifest = enrollmentManifest(account.id)
    const resolution = await resolveFallbackAccess(account, storage, manifest, {
      cache,
      manifestHandle: manifest.ok
        ? manifest.value.providers[0]?.accounts[0]?.handle
        : undefined,
      requestPath: true,
      completeEnrollmentDeps: {
        loadAccounts: async () => storage,
        readCustodyManifest: async () => manifest,
        acquireRefreshFileLock: async () => {
          lockCalls += 1
          return { release: async () => {} }
        },
        configPath: join(handlesDir, 'binding-store.json'),
        cache,
        minTtlMs: 30_000,
        mutateAccounts: async (mutate) => {
          storage = mutate(storage) ?? storage
        },
      },
    })

    expect(lockCalls).toBe(1)
    expect(storage.accounts[0]).toMatchObject({ accountId: 'acct-bound' })
    expect(resolution).toMatchObject({ token: jwtFor('acct-bound') })
    cache.close()
  })

  it('makes inline request reconciliation wait behind a parked sweep', async () => {
    const account = liveAccount('serialized', { accountId: 'acct-serialized' })
    let storage = liveStorage([account], {
      claustrum: claustrumConfig({ mode: 'claustrum' }),
    })
    let releaseSweep = () => {}
    let sweepEntered = () => {}
    const entered = new Promise<void>((resolve) => {
      sweepEntered = resolve
    })
    const sweepCache = new ClaustrumCredentialCache({
      connector: async () =>
        makeFakeClient({
          getCredential: async () => {
            sweepEntered()
            await new Promise<void>((resolve) => {
              releaseSweep = resolve
            })
            return {
              material: jwtFor('acct-serialized'),
              recordVersion: 10,
              expiresAtMs: Date.now() + 60_000,
            }
          },
        }) as never,
    })
    const requestCache = new ClaustrumCredentialCache({
      connector: async () =>
        makeFakeClient({
          getCredential: async () => ({
            material: jwtFor('acct-serialized'),
            recordVersion: 11,
            expiresAtMs: Date.now() + 60_000,
          }),
        }) as never,
    })
    const manifest = enrollmentManifest(account.id)
    let lockHeld = false
    let releaseWaiter = () => {}
    const waitForRelease = () =>
      new Promise<void>((resolve) => {
        releaseWaiter = resolve
      })
    const shared = {
      loadAccounts: async () => storage,
      readCustodyManifest: async () => manifest,
      acquireRefreshFileLock: async () => {
        if (lockHeld) await waitForRelease()
        lockHeld = true
        return {
          release: async () => {
            lockHeld = false
            releaseWaiter()
          },
        }
      },
      configPath: join(handlesDir, 'serialized-store.json'),
      minTtlMs: 30_000,
      mutateAccounts: async (
        mutate: (current: AccountStorage) => AccountStorage | undefined,
      ) => {
        storage = mutate(storage) ?? storage
      },
    }
    const sweep = reconcileFallbackCustody(account, {
      ...shared,
      cache: sweepCache,
    })
    await entered

    let requestSettled = false
    const request = resolveFallbackAccess(account, storage, manifest, {
      cache: requestCache,
      manifestHandle: manifest.ok
        ? manifest.value.providers[0]?.accounts[0]?.handle
        : undefined,
      requestPath: true,
      completeEnrollmentDeps: { ...shared, cache: requestCache },
    }).then((result) => {
      requestSettled = true
      return result
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(requestSettled).toBe(false)

    releaseSweep()
    await sweep
    expect(await request).toBe(CUSTODY_REFUSE)
    sweepCache.close()
    requestCache.close()
  })
})

// ---------------------------------------------------------------------------
// Cache behaviour
// ---------------------------------------------------------------------------

function makeFakeClient(
  overrides: Partial<{
    getCredential: (h: string) => Promise<unknown>
    statusCredential: (h: string) => Promise<unknown>
    reportAuthFailure: (p: unknown) => Promise<void>
  }> = {},
) {
  return {
    calls: { get: 0, status: 0, report: 0 },
    async getCredential(handle: string) {
      this.calls.get++
      return overrides.getCredential
        ? overrides.getCredential(handle)
        : {
            material: 'acc-live',
            recordVersion: 1,
            expiresAtMs: Date.now() + 60_000,
          }
    },
    async statusCredential(handle: string) {
      this.calls.status++
      return overrides.statusCredential
        ? overrides.statusCredential(handle)
        : {
            ready: true,
            lastErrorCode: null,
            leaseHeld: false,
            recordVersion: 1,
          }
    },
    async reportAuthFailure(params: unknown) {
      this.calls.report++
      return overrides.reportAuthFailure
        ? overrides.reportAuthFailure(params)
        : undefined
    },
    close() {},
  }
}

describe('ClaustrumCredentialCache', () => {
  it('returns the live resident record immediately without a refresh', async () => {
    const fake = makeFakeClient()
    const cache = new ClaustrumCredentialCache({
      connector: async () => fake as never,
    })
    const handle = `ckh_${'h'.repeat(43)}`
    const first = await cache.get(handle, 30_000)
    expect(fake.calls.get).toBe(1)
    expect(first.payload.access).toBe('acc-live')
    // Second call within TTL must hit the resident record (no second get).
    const second = await cache.get(handle, 30_000)
    expect(fake.calls.get).toBe(1)
    expect(second.recordVersion).toBe(first.recordVersion)
    cache.close()
  })

  it('does not refresh on an expired resident cache; enrollment is gated by manifest state, not record freshness', async () => {
    const fake = makeFakeClient({
      getCredential: async () => ({
        material: 'acc-live',
        recordVersion: 1,
        expiresAtMs: Date.now() - 1_000,
      }),
    })
    const cache = new ClaustrumCredentialCache({
      connector: async () => fake as never,
    })
    const handle = `ckh_${'e'.repeat(43)}`
    const result = await cache.get(handle, 30_000)
    expect(result.payload.access).toBe('acc-live')
    // The cache returns the expired record (no refresh logic) — gate is in the resolver.
    expect(fake.calls.get).toBe(1)
    cache.close()
  })

  it('force:true bypasses the resident record but still joins the in-flight call', async () => {
    let resolveOnce: ((v: unknown) => void) | undefined
    const gate = new Promise((resolve) => {
      resolveOnce = resolve
    })
    let firstCallCount = 0
    const fake = makeFakeClient({
      getCredential: async () => {
        firstCallCount++
        if (firstCallCount === 1) {
          await gate
          return {
            material: 'first',
            recordVersion: 1,
            expiresAtMs: Date.now() + 60_000,
          }
        }
        return {
          material: 'second',
          recordVersion: 2,
          expiresAtMs: Date.now() + 60_000,
        }
      },
    })
    const cache = new ClaustrumCredentialCache({
      connector: async () => fake as never,
    })
    const handle = `ckh_${'f'.repeat(43)}`
    // Kick off the in-flight call, but DO NOT await it yet.
    const inflight = cache.get(handle, 30_000)
    // While the in-flight call is pending, fire two force:true reads.
    const a = cache.get(handle, 30_000, { force: true })
    const b = cache.get(handle, 30_000, { force: true })
    // Resolve the gate so the in-flight call lands.
    resolveOnce?.({})
    const [first, second, third] = await Promise.all([inflight, a, b])
    expect(first.recordVersion).toBe(1)
    // Both force:true calls bypass the resident record and each issue one new get,
    // but since they share the in-flight gate, the count should be 2 not 3.
    expect(fake.calls.get).toBe(2)
    expect(second.recordVersion).toBe(2)
    expect(third.recordVersion).toBe(second.recordVersion)
    cache.close()
  })

  it('reportAuthFailure version-fences, sends once, and invalidates exactly the reported version', async () => {
    const reports: Array<{ handle: string; version: number }> = []
    let nextVersion = 17
    const fake = makeFakeClient({
      getCredential: async () => ({
        material: 'acc-live',
        recordVersion: nextVersion,
        expiresAtMs: Date.now() + 60_000,
      }),
      reportAuthFailure: async (params) => {
        reports.push({
          handle: (params as { handle: string }).handle,
          version: (params as { recordVersion: number }).recordVersion,
        })
        // After a report, the daemon rotates to a fresh version. A poisoned
        // v=17 is followed by a fresh v=18; a poisoned v=18 by v=19, etc.
        nextVersion = (params as { recordVersion: number }).recordVersion + 1
      },
    })
    const cache = new ClaustrumCredentialCache({
      connector: async () => fake as never,
    })
    const handle = `ckh_${'r'.repeat(43)}`
    // Seed the resident record at version 17.
    const seeded = await cache.get(handle, 30_000)
    expect(seeded.recordVersion).toBe(17)
    await cache.reportAuthFailure({
      handle,
      recordVersion: 17,
      providerStatus: 401,
    })
    // Two more 17s must NOT trigger another report — the version fence is monotonic.
    await cache.reportAuthFailure({
      handle,
      recordVersion: 17,
      providerStatus: 401,
    })
    await cache.reportAuthFailure({
      handle,
      recordVersion: 17,
      providerStatus: 401,
    })
    expect(reports).toEqual([{ handle, version: 17 }])
    // A higher version (18) must issue a second report.
    await cache.reportAuthFailure({
      handle,
      recordVersion: 18,
      providerStatus: 401,
    })
    expect(reports).toEqual([
      { handle, version: 17 },
      { handle, version: 18 },
    ])
    // After invalidating 17, a get must NOT return version 17 from the resident record.
    const afterInvalidate = await cache.get(handle, 30_000)
    expect(afterInvalidate.recordVersion).not.toBe(17)
    cache.close()
  })

  it('keeps the two-cycle bound through a fresh get until a served vault request succeeds', async () => {
    const reports: number[] = []
    let nextVersion = 1
    const fake = makeFakeClient({
      getCredential: async () => ({
        material: 'acc-live',
        recordVersion: nextVersion,
        expiresAtMs: Date.now() + 60_000,
      }),
      reportAuthFailure: async (params) => {
        const v = (params as { recordVersion: number }).recordVersion
        reports.push(v)
        // Bump the daemon's next served version past the rejected ones so a
        // subsequent get returns a credential the cache will accept.
        nextVersion = v + 1
      },
    })
    const cache = new ClaustrumCredentialCache({
      connector: async () => fake as never,
    })
    const handle = `ckh_${'b'.repeat(43)}`
    // Seed at version 1.
    await cache.get(handle, 30_000)
    // 1st report → enters blocked.
    await cache.reportAuthFailure({
      handle,
      recordVersion: 1,
      providerStatus: 401,
    })
    // 2nd report on a NEW version → still goes through (cycle 2 of two-cycle bound).
    await cache.reportAuthFailure({
      handle,
      recordVersion: 2,
      providerStatus: 401,
    })
    // 3rd report on yet another new version → bound fires; we do NOT report.
    await cache.reportAuthFailure({
      handle,
      recordVersion: 3,
      providerStatus: 401,
    })
    expect(reports).toEqual([1, 2])
    // A fresh vault record is not evidence that it works. The fake's nextVersion
    // stays at 3 because the bound suppresses the v=3 report.
    const after = await cache.get(handle, 30_000)
    expect(after.recordVersion).toBe(3)
    expect(cache.isReauth(handle)).toBe(true)
    await cache.reportAuthFailure({
      handle,
      recordVersion: 3,
      providerStatus: 401,
    })
    expect(reports).toEqual([1, 2])
    cache.markVaultSuccess(handle)
    expect(cache.isReauth(handle)).toBe(false)
    await cache.reportAuthFailure({
      handle,
      recordVersion: 3,
      providerStatus: 401,
    })
    expect(reports).toEqual([1, 2, 3])
    cache.close()
  })

  it('a new instance starts with empty process-local state', async () => {
    const fake = makeFakeClient()
    const a = new ClaustrumCredentialCache({
      connector: async () => fake as never,
    })
    const handle = `ckh_${'n'.repeat(43)}`
    await a.get(handle, 30_000)
    a.close()
    // After close, a fresh instance must NOT carry over the resident record.
    const fake2 = makeFakeClient()
    const b = new ClaustrumCredentialCache({
      connector: async () => fake2 as never,
    })
    expect(await b.peek(handle)).toBeUndefined()
    b.close()
  })
})

// ---------------------------------------------------------------------------
// Golden check (script integration)
// ---------------------------------------------------------------------------

describe('golden fixture', () => {
  it('pinned fixture pins prefix and contains the expected providers', () => {
    // The fixture file under src/tests/fixtures/claustrum-golden/handles.json
    // is the byte-for-byte copy from upstream — see check:claustrum-golden.
    // Here we just assert that the local copy exists and contains the
    // tenant-stable structure the manifest reader expects.
    const fixturePath = join(
      import.meta.dir,
      'fixtures',
      'claustrum-golden',
      'handles.json',
    )
    expect(fixturePath.endsWith('handles.json')).toBe(true)
    const source = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      version: number
      providers: Array<{ provider: string; shape: string; serve: string }>
    }
    expect(source.version).toBe(1)
    expect(source.providers.length).toBeGreaterThan(0)
    // Pin the structural tenant-stable fields.
    const deepseek = source.providers.find((p) => p.provider === 'deepseek')
    expect(deepseek).toBeDefined()
    expect(deepseek?.shape).toBe('api')
    const anthropic = source.providers.find((p) => p.provider === 'anthropic')
    expect(anthropic).toBeDefined()
    expect(anthropic?.shape).toBe('oauth')
  })
})

// ---------------------------------------------------------------------------
// Preload isolation assertion
// ---------------------------------------------------------------------------

describe('setup-env preload guard', () => {
  // The assertion logic accepts a `floorDir` override so the test can place
  // the synthetic live-default INSIDE a fake floor and verify that the
  // live-default branch (not the FLOOR_DIR branch) is what fires. Without
  // the override, a poisoned path under fakeHome fails the FLOOR_DIR
  // check first and the live-default branch is never exercised.

  it('refuses a path under a synthetic ~/.config-shaped directory inside an allowed floor', () => {
    // Pretend the operator's home is a temp dir; the assertion must treat
    // its <home>/.config subtree as the live default and refuse any path
    // resolved there, even if a misconfigured env were to point at it.
    const fakeFloor = mkdtempSync(join(tmpdir(), 'setup-env-fake-floor-'))
    const fakeHome = join(fakeFloor, 'home')
    mkdirSync(fakeHome, { recursive: true })
    const fakeConfig = join(fakeHome, '.config')
    const fakeCortexkit = join(fakeConfig, 'cortexkit')
    mkdirSync(fakeCortexkit, { recursive: true })
    const poisonedPath = join(fakeCortexkit, 'opencode-handles.json')
    expect(() =>
      assertFloor(
        'CLAUSTRUM_OPENCODE_HANDLES',
        poisonedPath,
        `${poisonedPath}.lock`,
        {
          floorDir: fakeFloor,
          homeConfig: fakeConfig,
          homeLocalShare: join(fakeHome, '.local', 'share'),
        },
      ),
    ).toThrow(/live default/)
  })

  it('refuses a path under a synthetic ~/.local/share-shaped directory inside an allowed floor', () => {
    const fakeFloor = mkdtempSync(join(tmpdir(), 'setup-env-fake-floor-'))
    const fakeHome = join(fakeFloor, 'home')
    mkdirSync(fakeHome, { recursive: true })
    const fakeLocalShare = join(fakeHome, '.local', 'share')
    const fakeCortexkit = join(fakeLocalShare, 'cortexkit')
    mkdirSync(fakeCortexkit, { recursive: true })
    const poisonedPath = join(fakeCortexkit, 'opencode-handles.json')
    expect(() =>
      assertFloor(
        'CLAUSTRUM_OPENCODE_HANDLES',
        poisonedPath,
        `${poisonedPath}.lock`,
        {
          floorDir: fakeFloor,
          homeConfig: join(fakeHome, '.config'),
          homeLocalShare: fakeLocalShare,
        },
      ),
    ).toThrow(/live default/)
  })

  it('accepts the floor path itself (sanity check the guard is not over-eager)', () => {
    // The floor path resolves under FLOOR_DIR, not under any live default,
    // so the guard must not throw for it.
    expect(() =>
      assertFloor(
        'CLAUSTRUM_OPENCODE_HANDLES',
        FLOOR_CLAUSTRUM_HANDLES,
        FLOOR_CLAUSTRUM_HANDLES_LOCK,
      ),
    ).not.toThrow()
  })

  it('refuses a non-absolute path even when the live-default branches would pass', () => {
    expect(() =>
      assertFloor('CLAUSTRUM_OPENCODE_HANDLES', 'relative/handles.json'),
    ).toThrow(/not absolute/)
  })
})

// ---------------------------------------------------------------------------
// Cache read accessors — projection-only, no behaviour change.
// ---------------------------------------------------------------------------

describe('cache read accessors', () => {
  it('isBlocked is false on a fresh handle and stays false after a successful get', async () => {
    const cache = new ClaustrumCredentialCache({
      connector: async () => makeFakeClient() as never,
    })
    const handle = `ckh_${'b'.repeat(43)}`
    expect(cache.isBlocked(handle)).toBe(false)
    await cache.get(handle, 30_000)
    expect(cache.isBlocked(handle)).toBe(false)
    cache.close()
  })

  it('isBlocked is true after reportAuthFailure and false after a successful get clears it', async () => {
    let nextVersion = 1
    const fake = makeFakeClient({
      getCredential: async () => ({
        material: 'acc-live',
        recordVersion: nextVersion,
        expiresAtMs: Date.now() + 60_000,
      }),
    })
    const cache = new ClaustrumCredentialCache({
      connector: async () => fake as never,
    })
    const handle = `ckh_${'c'.repeat(43)}`
    await cache.get(handle, 30_000)
    await cache.reportAuthFailure({
      handle,
      providerStatus: 401,
      recordVersion: 1,
    })
    expect(cache.isBlocked(handle)).toBe(true)
    // The next get must observe a higher version so the rejected-version
    // fence does not stall the fetch (cache invariant: rejected versions stay
    // rejected until a higher version arrives).
    nextVersion = 2
    await cache.get(handle, 30_000)
    expect(cache.isBlocked(handle)).toBe(false)
    cache.close()
  })

  it('isReauth is false when no reauth-until has been recorded', () => {
    const cache = new ClaustrumCredentialCache({
      connector: async () => makeFakeClient() as never,
    })
    expect(cache.isReauth('any-handle')).toBe(false)
    cache.close()
  })

  it('isReauth is true inside the reauth window and false after it elapses', async () => {
    const now = 1_000_000
    const fake = makeFakeClient()
    const cache = new ClaustrumCredentialCache({
      connector: async () => fake as never,
      now: () => now,
    })
    const handle = `ckh_${'r'.repeat(43)}`
    await cache.get(handle, 30_000)
    // Two reports on the same version trip the reauth bound.
    await cache.reportAuthFailure({
      handle,
      providerStatus: 401,
      recordVersion: 1,
    })
    // The second report sees a new recordVersion so it is not dropped by the
    // monotonic per-handle fence.
    await cache.reportAuthFailure({
      handle,
      providerStatus: 401,
      recordVersion: 2,
    })
    expect(cache.isReauth(handle, now)).toBe(true)
    // One hour past the reauth deadline: no longer in reauth.
    expect(cache.isReauth(handle, now + 60 * 60 * 1000 + 1)).toBe(false)
    cache.close()
  })

  it('peekMetadata exposes version and expiry but never the credential material', async () => {
    const fake = makeFakeClient({
      getCredential: async () => ({
        material: 'acc-secret',
        recordVersion: 42,
        expiresAtMs: 1_700_000_000_000,
      }),
    })
    const cache = new ClaustrumCredentialCache({
      connector: async () => fake as never,
    })
    const handle = `ckh_${'m'.repeat(43)}`
    await cache.get(handle, 30_000)
    const meta = await cache.peekMetadata(handle)
    expect(meta).toEqual({ recordVersion: 42, expiresAtMs: 1_700_000_000_000 })
    // No `material`, no `payload`, no token material on the metadata surface.
    expect((meta as { material?: unknown }).material).toBeUndefined()
    expect((meta as { payload?: unknown }).payload).toBeUndefined()
    cache.close()
  })
})

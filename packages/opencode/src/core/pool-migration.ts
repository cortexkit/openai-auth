// Moves openai-auth's accounts into the shared account pool of
// `@cortexkit/common-auth/store`, and keeps adopting real logins that later
// land in OpenCode's own login slot.
//
// Before the pool, the main account's credential lived in OpenCode's login
// slot (`auth.json`, key `openai`) and fallbacks lived in openai-auth's
// config and state files. In the pool every account is a row of those files
// and the slot holds a placeholder that is never sent. Nothing here is wired
// into the loader or the request path yet: callers are the harness tests.
//
// Crash-safety rule: the slot keeps the only unmoved copy of its credential
// until the pool holds it and a reload has proved it; only then is the
// placeholder written, and only through a fence (the slot must still hold
// the exact access/refresh pair that was read). A durable pending-transfer
// record, written before a row is touched, lets any later run tell whether
// an interrupted transfer never happened, finished, or was overtaken.
//
// Older openai-auth builds may run against the same files at the same time.
// They refresh the slot credential under the `main-refresh` file lock plus a
// lease in `state.main`, and every enabled roster row (the migrated `main`
// row included) under a per-account fallback lock. Every step here that
// copies a credential takes those same locks, so an old and a new build can
// never rotate one refresh token at once.

import { readFile } from 'node:fs/promises'
import {
  acquireRefreshFileLock,
  writeJsonAtomic,
} from '@cortexkit/common-auth/fs'
import { type QuotaObservation, quotaCodec } from '@cortexkit/common-auth/quota'
import {
  fingerprintOf,
  type OpenPoolStoreOptions,
  openPoolStore,
  type PoolLockSpec,
  PoolOperationError,
  type PoolRow,
  type PoolStore,
  type ProviderRefresh,
  type RefreshOptions,
  type RefreshOutcome,
} from '@cortexkit/common-auth/store'
import {
  type AccountPaths,
  type AccountStorage,
  claustrumMode,
  extractAccountIdFromClaims,
  FALLBACK_REFRESH_LOCK_TTL_MS,
  fallbackRefreshLockName,
  hashRefreshToken,
  isOAuthAccount,
  loadAccounts,
  type OAuthQuotaSnapshot,
  parseJwtClaims,
  saveAccountState,
} from '@cortexkit/openai-auth-core/internal'
import { createLogger } from '../logger'
import {
  asCompleteMainOauthSlot,
  confirmMainAuthSlot,
  mainSlotFamilyFingerprint,
} from './custody-host-slot.ts'
import { MAIN_REFRESH_LOCK_NAME } from './custody-transition.ts'

const PROVIDER = 'openai'

/** The refresh value of the slot placeholder. Only an exact match counts. */
export const POOL_PLACEHOLDER_REFRESH = 'common-auth-placeholder:v1:openai'

/**
 * What the host slot holds once its credential lives in the pool. The empty
 * access token means nothing can ever be sent from it. It is deliberately not
 * the custody tombstone (`claustrum-tombstone:v1:`), which marks vault
 * custody and must never be confused with a completed migration.
 */
export const POOL_PLACEHOLDER = Object.freeze({
  type: 'oauth' as const,
  access: '',
  refresh: POOL_PLACEHOLDER_REFRESH,
  expires: 0,
})

/** Exact placeholder match: a near miss is a real credential. */
export function isPoolPlaceholder(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    value.type === POOL_PLACEHOLDER.type &&
    value.access === POOL_PLACEHOLDER.access &&
    value.refresh === POOL_PLACEHOLDER.refresh &&
    value.expires === POOL_PLACEHOLDER.expires
  )
}

/**
 * openai-auth's own top-level config key for migration bookkeeping. Both the
 * pool store and every older openai-auth writer keep unknown top-level config
 * keys, so it survives every writer of the file.
 */
export const POOL_MIGRATION_KEY = 'openaiAuthPool'

/**
 * Lease length of the `main-refresh` file lock, the same value older builds
 * use (`MAIN_REFRESH_LOCK_TTL_MS` in the plugin entry `index.ts`), so a
 * crashed holder on either side blocks the other for the same bounded time.
 */
export const LEGACY_MAIN_REFRESH_LOCK_TTL_MS = 2 * 60_000

/** The host login slot, shaped like the plugin's `client.auth`. */
export interface HostSlotAdapter {
  get(input: { path: { id: string } }): Promise<unknown>
  set(input: { path: { id: string }; body: unknown }): Promise<unknown>
  all(): Promise<Record<string, unknown>>
}

export interface PoolMigrationLogger {
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
}

/** Named points between this module's own writes; awaited, for crash tests. */
export type PoolMigrationStep =
  | 'after-pool-key-write'
  | 'after-record-write'
  | 'after-row-write'
  | 'after-verify'
  | 'after-carry-over'
  | 'after-shield-drop'
  | 'before-placeholder-write'
  | 'after-placeholder-write'
  | 'after-record-clear'
  | 'after-marker-write'

/** Timing of the legacy file locks and of waits on them. */
export interface LegacyLockOptions {
  mainRefreshTtlMs: number
  fallbackTtlMs: number
  /** Lease of the `save` lock pair around this module's own config writes. */
  saveTtlMs: number
  renew: boolean
  renewIntervalMs?: number
  /** How long to wait for a held legacy lock before giving up (real clock). */
  timeoutMs: number
  retryMs: number
}

export const LEGACY_LOCK_DEFAULTS: Readonly<LegacyLockOptions> = Object.freeze({
  mainRefreshTtlMs: LEGACY_MAIN_REFRESH_LOCK_TTL_MS,
  fallbackTtlMs: FALLBACK_REFRESH_LOCK_TTL_MS,
  saveTtlMs: 10_000,
  renew: true,
  timeoutMs: 15_000,
  retryMs: 50,
})

export interface PoolMigrationDeps {
  paths: AccountPaths
  slot: HostSlotAdapter
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Id for a new row whose login carries no usable wire identity. */
  newId?: () => string
  log?: PoolMigrationLogger
  legacyLocks?: Partial<LegacyLockOptions>
  /** Bound and poll interval for waiting out an active legacy main lease. */
  leaseWait?: { timeoutMs: number; pollMs: number }
  /** Pass-through options for the pool store this module opens. */
  store?: Partial<
    Pick<
      OpenPoolStoreOptions,
      | 'lockOptions'
      | 'rowLockOptions'
      | 'providerLock'
      | 'storeLocks'
      | 'onStep'
      | 'onLockEvent'
    >
  >
  onStep?: (step: PoolMigrationStep) => void | Promise<void>
}

export type SlotNothingKind =
  | 'placeholder'
  | 'empty'
  | 'tombstone'
  | 'slot-absent'
  | 'declined'

export type PoolTransferOutcome =
  /** Custody mode: the legacy store stays in charge; nothing was written. */
  | { status: 'deferred-claustrum' }
  /** Migration already recorded as done; nothing was imported. */
  | { status: 'already-migrated' }
  /** Adoption asked for before the migration ran. */
  | { status: 'not-migrated' }
  | { status: 'nothing-to-import'; slot: SlotNothingKind }
  | {
      status: 'completed'
      rowId: string
      operation: 'add' | 'rotate' | 'replace' | 'resumed'
      /**
       * `written`: the placeholder was written and read back. `overwritten`:
       * something replaced it between the write and the readback (the next
       * adoption run takes whatever landed). `already-present`: a resumed run
       * found the placeholder in place. `slot-moved-on`: the slot changed to
       * another value before the fence; it is left for the next adoption.
       */
      placeholder:
        | 'written'
        | 'overwritten'
        | 'already-present'
        | 'slot-moved-on'
    }
  /**
   * An interrupted transfer's row holds neither its old credential nor the
   * slot's: someone rotated it after the interruption, so the slot copy may
   * be stale. The slot is left alone and this exact slot value is declined
   * for adoption; the user's next login resolves it.
   */
  | { status: 'ambiguous'; rowId: string }
  | {
      status: 'retry'
      reason:
        | 'host-slot-indeterminate'
        | 'legacy-refresh-in-progress'
        | 'lock-contention'
        | 'verify-failed'
        | 'torn-read'
        | 'unsettled'
        | `store-${string}`
    }
  | { status: 'error'; reason: string }

type SlotCredential = { access: string; refresh: string; expires?: number }

type SlotView =
  | {
      kind: 'real'
      credential: SlotCredential
      /** Fence fingerprint over the exact (access, refresh) pair. */
      fingerprint: string
      /** The pool's credential fingerprint (refresh token only). */
      credentialFingerprint: string
      identity?: string
    }
  | { kind: Exclude<SlotNothingKind, 'declined'> }
  | { kind: 'indeterminate' }

/** Durable record of one slot-to-row transfer, written before the row. */
export interface PendingTransfer {
  rowId: string
  operation: 'add' | 'rotate' | 'replace'
  /** The row's credential fingerprint before the transfer; null if none. */
  rowFingerprint: string | null
  slotFingerprint: string
  credentialFingerprint: string
  identity?: string
  /** Carry the legacy `state.main` quota and backoff onto the row. */
  carryLegacyMain: boolean
  recordedAt: number
}

export interface PoolMigrationBookkeeping {
  migratedAt?: number
  pending?: PendingTransfer
  /**
   * Fence fingerprint of a host-slot value that must not be imported: the
   * slot copy left behind by an `ambiguous` outcome, which may be a spent
   * token. Any new login changes the slot value and is adopted normally.
   */
  declinedSlotFingerprint?: string
}

type Context = {
  paths: AccountPaths
  slot: HostSlotAdapter
  now: () => number
  sleep: (ms: number) => Promise<void>
  newId: () => string
  log: PoolMigrationLogger
  locks: LegacyLockOptions
  leaseWait: { timeoutMs: number; pollMs: number }
  store: PoolStore
  onStep: (step: PoolMigrationStep) => Promise<void>
}

type HeldLock = { release(): Promise<void>; assertOwned(): Promise<void> }

class LegacyLockContention extends Error {
  constructor(name: string) {
    super(`timed out waiting for the legacy ${name} lock`)
    this.name = 'LegacyLockContention'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function context(deps: PoolMigrationDeps): Context {
  const now = deps.now ?? Date.now
  return {
    paths: deps.paths,
    slot: deps.slot,
    now,
    sleep:
      deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    newId: deps.newId ?? (() => crypto.randomUUID()),
    log: deps.log ?? createLogger('pool-migration'),
    locks: { ...LEGACY_LOCK_DEFAULTS, ...deps.legacyLocks },
    leaseWait: deps.leaseWait ?? { timeoutMs: 4_000, pollMs: 50 },
    store: openPoolStore({
      provider: PROVIDER,
      configPath: deps.paths.configPath,
      statePath: deps.paths.statePath,
      quota: quotaCodec,
      now,
      ...deps.store,
    }),
    onStep: async (step) => {
      await deps.onStep?.(step)
    },
  }
}

// ---------------------------------------------------------------------------
// Files and locks
// ---------------------------------------------------------------------------

async function readConfig(path: string): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)) throw new Error('config root is not an object')
  return value
}

/** Takes one file lock, polling while a live holder has it. */
async function acquireLock(
  ctx: Context,
  name: string,
  path: string,
  ttlMs: number,
): Promise<HeldLock> {
  const started = performance.now()
  for (;;) {
    const lock = await acquireRefreshFileLock({
      name,
      path,
      ttlMs,
      now: ctx.now,
      renew: ctx.locks.renew,
      ...(ctx.locks.renewIntervalMs !== undefined
        ? { renewIntervalMs: ctx.locks.renewIntervalMs }
        : {}),
    })
    if (lock) return lock
    if (performance.now() - started >= ctx.locks.timeoutMs)
      throw new LegacyLockContention(name)
    await ctx.sleep(ctx.locks.retryMs)
  }
}

/**
 * One read-modify-write of the config under the older writers' `save` lock
 * pair (config, then state) — the pair the pool store and every legacy
 * writer serialise on.
 */
async function updateConfig(
  ctx: Context,
  mutate: (config: Record<string, unknown>) => boolean,
): Promise<void> {
  const ttlMs = ctx.locks.saveTtlMs
  const configLock = await acquireLock(ctx, 'save', ctx.paths.configPath, ttlMs)
  try {
    const stateLock = await acquireLock(ctx, 'save', ctx.paths.statePath, ttlMs)
    try {
      const config = await readConfig(ctx.paths.configPath)
      if (!mutate(config)) return
      await writeJsonAtomic(ctx.paths.configPath, config, {
        beforeRename: async () => {
          await configLock.assertOwned()
          await stateLock.assertOwned()
        },
      })
    } finally {
      await stateLock.release().catch(() => {})
    }
  } finally {
    await configLock.release().catch(() => {})
  }
}

function parsePending(value: unknown): PendingTransfer | undefined {
  if (!isRecord(value)) return undefined
  const { rowId, operation, rowFingerprint, slotFingerprint } = value
  const { credentialFingerprint, carryLegacyMain, recordedAt, identity } = value
  if (typeof rowId !== 'string' || !rowId) return undefined
  if (operation !== 'add' && operation !== 'rotate' && operation !== 'replace')
    return undefined
  if (rowFingerprint !== null && typeof rowFingerprint !== 'string')
    return undefined
  if (typeof slotFingerprint !== 'string') return undefined
  if (typeof credentialFingerprint !== 'string') return undefined
  return {
    rowId,
    operation,
    rowFingerprint,
    slotFingerprint,
    credentialFingerprint,
    ...(typeof identity === 'string' && identity ? { identity } : {}),
    carryLegacyMain: carryLegacyMain === true,
    recordedAt: typeof recordedAt === 'number' ? recordedAt : 0,
  }
}

/** Reads this module's bookkeeping key from a parsed config. */
export function readPoolMigrationBookkeeping(
  config: Record<string, unknown>,
): PoolMigrationBookkeeping {
  const raw = config[POOL_MIGRATION_KEY]
  if (!isRecord(raw)) return {}
  const pending = parsePending(raw.pending)
  return {
    ...(typeof raw.migratedAt === 'number'
      ? { migratedAt: raw.migratedAt }
      : {}),
    ...(pending ? { pending } : {}),
    ...(typeof raw.declinedSlotFingerprint === 'string'
      ? { declinedSlotFingerprint: raw.declinedSlotFingerprint }
      : {}),
  }
}

function writeBookkeeping(
  config: Record<string, unknown>,
  next: PoolMigrationBookkeeping,
): void {
  const prior = isRecord(config[POOL_MIGRATION_KEY])
    ? config[POOL_MIGRATION_KEY]
    : {}
  const out: Record<string, unknown> = { ...prior }
  for (const key of ['migratedAt', 'pending', 'declinedSlotFingerprint'])
    delete out[key]
  Object.assign(out, next)
  config[POOL_MIGRATION_KEY] = out
}

// ---------------------------------------------------------------------------
// Slot
// ---------------------------------------------------------------------------

function identityOf(access: string): string | undefined {
  const claims = access ? parseJwtClaims(access) : undefined
  return claims ? extractAccountIdFromClaims(claims) : undefined
}

function realView(credential: SlotCredential): SlotView {
  const fingerprint = mainSlotFamilyFingerprint({
    type: 'oauth',
    ...credential,
  })
  const identity = identityOf(credential.access)
  return {
    kind: 'real',
    credential,
    fingerprint: fingerprint as string,
    credentialFingerprint: fingerprintOf({
      type: 'oauth',
      refresh: credential.refresh,
    }),
    ...(identity ? { identity } : {}),
  }
}

/** Classifies a single slot value that is known to exist. */
function viewOf(value: unknown): SlotView {
  if (isPoolPlaceholder(value)) return { kind: 'placeholder' }
  const complete = asCompleteMainOauthSlot(value)
  if (!complete?.refresh.trim()) return { kind: 'empty' }
  return realView(complete)
}

/**
 * Reads the slot with the host-slot rules openai-auth already uses: a single
 * missing read is not trusted (the host may be mid-write), so absence needs
 * two reads apart with a non-empty auth map both times.
 */
async function readSlot(ctx: Context): Promise<SlotView> {
  const verdict = await confirmMainAuthSlot({
    client: {
      auth: {
        get: (input) => ctx.slot.get(input),
        all: () => ctx.slot.all(),
      },
    },
    now: ctx.now,
    sleep: ctx.sleep,
  })
  if (verdict.kind === 'real') return viewOf(verdict.oauth)
  return verdict.kind === 'slot-absent' || verdict.kind === 'indeterminate'
    ? { kind: verdict.kind }
    : { kind: verdict.kind }
}

/**
 * The slot view, after waiting out an active legacy main-refresh lease on
 * the slot's own refresh token, exactly as the plugin's `refreshMainWithLease`
 * does before it refreshes: a lease is active while `refreshLeaseUntil` lies
 * in the future and its token hash matches. Copying a token an older build
 * is rotating right now would put a consumed token into the pool.
 */
async function readSlotHonouringLease(
  ctx: Context,
): Promise<SlotView | { kind: 'retry' }> {
  const deadline = ctx.now() + ctx.leaseWait.timeoutMs
  for (;;) {
    const view = await readSlot(ctx)
    if (view.kind !== 'real') return view
    if (!(await legacyLeaseActive(ctx, view.credential.refresh))) return view
    if (ctx.now() >= deadline) return { kind: 'retry' }
    await ctx.sleep(ctx.leaseWait.pollMs)
  }
}

async function legacyLeaseActive(
  ctx: Context,
  refreshToken: string,
): Promise<boolean> {
  const legacy = await loadAccounts(ctx.paths)
  const until = legacy?.refresh?.mainRefreshLeaseUntil
  return Boolean(
    until &&
      until > ctx.now() &&
      legacy?.refresh?.mainRefreshLeaseTokenHash ===
        hashRefreshToken(refreshToken),
  )
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

type Plan =
  | { kind: 'nothing'; slot: SlotNothingKind }
  | { kind: 'drop-record' }
  | { kind: 'ambiguous'; record: PendingTransfer }
  | { kind: 'finish'; record: PendingTransfer }
  | {
      kind: 'transfer'
      record: PendingTransfer
      credential: SlotCredential
      fresh: boolean
    }

function usableAsId(value: string): boolean {
  return (
    value.length > 0 &&
    value.trim() === value &&
    !['__proto__', 'constructor', 'prototype', 'main'].includes(value)
  )
}

/**
 * Picks the row a slot credential goes to. The same refresh token wins first
 * (it already lives in that row: a rotate, never a second copy). Migration
 * then takes `main`, which pins, quota, killswitch, reset credits, cachekeep
 * and lock names all key on. Otherwise the wire identity picks an enabled
 * row (a re-login: replace), and failing that the login becomes a new row
 * named like the plugin's own logins name theirs (its identity, else a uuid).
 */
function resolveTarget(
  mode: 'migrate' | 'adopt',
  rows: readonly PoolRow[],
  slot: Extract<SlotView, { kind: 'real' }>,
  idHint: string | undefined,
  newId: () => string,
): Omit<
  PendingTransfer,
  'slotFingerprint' | 'credentialFingerprint' | 'recordedAt'
> {
  const identity = slot.identity ? { identity: slot.identity } : {}
  const same = rows.find(
    (row) => !row.invalid && row.fingerprint === slot.credentialFingerprint,
  )
  if (same)
    return {
      rowId: same.id,
      operation: 'rotate',
      rowFingerprint: same.fingerprint ?? null,
      ...identity,
      carryLegacyMain: mode === 'migrate' && same.id === 'main',
    }
  if (mode === 'migrate') {
    const main = rows.find((row) => row.id === 'main')
    if (!main || (!main.invalid && !main.credential))
      return {
        rowId: 'main',
        operation: 'add',
        rowFingerprint: null,
        ...identity,
        carryLegacyMain: true,
      }
  }
  if (slot.identity) {
    const holder = rows.find(
      (row) =>
        !row.invalid &&
        row.type === 'oauth' &&
        row.enabled &&
        row.identity === slot.identity,
    )
    if (holder)
      return {
        rowId: holder.id,
        operation: 'replace',
        rowFingerprint: holder.fingerprint ?? null,
        ...identity,
        carryLegacyMain: mode === 'migrate' && holder.id === 'main',
      }
  }
  const taken = new Set(rows.map((row) => row.id))
  const rowId =
    idHint ??
    (slot.identity && usableAsId(slot.identity) && !taken.has(slot.identity)
      ? slot.identity
      : newId())
  return {
    rowId,
    operation: 'add',
    rowFingerprint: null,
    ...identity,
    carryLegacyMain: false,
  }
}

/**
 * Decides what one run does. With a pending record, the recorded row's
 * credential says how far the interrupted transfer got: still its old
 * credential (or still absent, for a new row) means it never happened;
 * the slot's credential means it happened; anything else means the row was
 * rotated after the interruption, and whether the slot copy is stale can no
 * longer be told.
 */
function plan(
  mode: 'migrate' | 'adopt',
  book: PoolMigrationBookkeeping,
  rows: readonly PoolRow[],
  slot: SlotView,
  idHint: string | undefined,
  now: number,
  newId: () => string,
): Plan {
  const record = book.pending
  if (record) {
    const row = rows.find((r) => r.id === record.rowId && !r.invalid)
    const rowFingerprint = row?.fingerprint ?? null
    const slotIsRecorded =
      slot.kind === 'real' && slot.fingerprint === record.slotFingerprint
    if (row && rowFingerprint === record.credentialFingerprint)
      return { kind: 'finish', record }
    if (
      (row || record.rowFingerprint === null) &&
      rowFingerprint === record.rowFingerprint
    )
      return slotIsRecorded && slot.kind === 'real'
        ? {
            kind: 'transfer',
            record,
            credential: slot.credential,
            fresh: false,
          }
        : { kind: 'drop-record' }
    if (!row) return { kind: 'drop-record' }
    return slotIsRecorded
      ? { kind: 'ambiguous', record }
      : { kind: 'drop-record' }
  }
  if (slot.kind === 'indeterminate') return { kind: 'drop-record' }
  if (slot.kind !== 'real') return { kind: 'nothing', slot: slot.kind }
  if (book.declinedSlotFingerprint === slot.fingerprint)
    return { kind: 'nothing', slot: 'declined' }
  return {
    kind: 'transfer',
    record: {
      ...resolveTarget(mode, rows, slot, idHint, newId),
      slotFingerprint: slot.fingerprint,
      credentialFingerprint: slot.credentialFingerprint,
      recordedAt: now,
    },
    credential: slot.credential,
    fresh: true,
  }
}

function samePlan(a: Plan, b: Plan): boolean {
  if (a.kind !== b.kind) return false
  if (!('record' in a) || !('record' in b)) return true
  return (
    a.record.rowId === b.record.rowId &&
    a.record.operation === b.record.operation &&
    a.record.rowFingerprint === b.record.rowFingerprint &&
    a.record.credentialFingerprint === b.record.credentialFingerprint
  )
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function applyToRow(
  ctx: Context,
  record: PendingTransfer,
  credential: SlotCredential,
): Promise<void> {
  const oauth = {
    type: 'oauth' as const,
    access: credential.access,
    refresh: credential.refresh,
    ...(credential.expires !== undefined
      ? { expires: credential.expires }
      : {}),
  }
  const identity = record.identity ? { identity: record.identity } : {}
  if (record.operation === 'add') {
    await ctx.store.add({ id: record.rowId, credential: oauth, ...identity })
  } else if (record.operation === 'replace') {
    await ctx.store.replace(record.rowId, oauth, identity)
  } else {
    const load = await ctx.store.read()
    const row =
      load.status === 'ready'
        ? load.rows.find((r) => r.id === record.rowId)
        : undefined
    // A rotate records an identity only where the row has none yet.
    await ctx.store.rotate(
      record.rowId,
      oauth,
      row?.identity === undefined ? identity : {},
    )
  }
}

async function verifyRow(
  ctx: Context,
  record: PendingTransfer,
): Promise<PoolRow | undefined> {
  const load = await ctx.store.read()
  if (load.status !== 'ready') return undefined
  const row = load.rows.find((r) => r.id === record.rowId && !r.invalid)
  return row?.fingerprint === record.credentialFingerprint ? row : undefined
}

/** A legacy quota window snapshot as one pool quota observation each. */
export function observationsFromLegacySnapshot(
  snapshot: OAuthQuotaSnapshot,
  budgetCheckedAt: number | undefined,
): QuotaObservation[] {
  const out: QuotaObservation[] = []
  const windows: Array<[string, OAuthQuotaSnapshot['primary']]> = [
    ['primary', snapshot.primary],
    ['secondary', snapshot.secondary],
  ]
  let latest = 0
  for (const [label, window] of windows) {
    if (
      !window ||
      !Number.isFinite(window.checkedAt) ||
      !Number.isFinite(window.usedPercent)
    )
      continue
    latest = Math.max(latest, window.checkedAt)
    out.push({
      checkedAt: window.checkedAt,
      readings: [
        {
          label,
          usedPercent: window.usedPercent,
          ...(typeof window.resetsAt === 'string'
            ? { resetsAt: window.resetsAt }
            : {}),
          ...(Number.isFinite(window.windowMinutes)
            ? { windowMinutes: window.windowMinutes as number }
            : {}),
        },
      ],
    })
  }
  const at = budgetCheckedAt ?? (latest || undefined)
  const spend = snapshot.spendControl
  if (at !== undefined && spend) {
    out.push({
      checkedAt: at,
      budget: {
        kind: 'reading',
        reached: spend.reached,
        remainingPercent: spend.remainingPercent,
        usedPercent: spend.usedPercent,
        limit: spend.limit,
        used: spend.used,
        remaining: spend.remaining,
        ...(spend.resetsAt !== undefined ? { resetsAt: spend.resetsAt } : {}),
        ...(spend.unit !== undefined ? { unit: spend.unit } : {}),
      },
    })
  } else if (at !== undefined && snapshot.spendControlCleared) {
    out.push({ checkedAt: at, budget: { kind: 'cleared' } })
  }
  return out.sort((a, b) => a.checkedAt - b.checkedAt)
}

/**
 * Moves what the legacy store kept about the slot account (`state.main`'s
 * quota snapshot and refresh backoff) onto the row that now holds it. The
 * pool map gets the quota attributed to the row's current credential and
 * wire identity; the legacy per-row state gets both too, through the legacy
 * writer, so an older build serving the row as a fallback keeps honouring
 * the backoff. Advisory data: a failure is logged and never blocks the move.
 */
async function carryLegacyMainState(ctx: Context, row: PoolRow): Promise<void> {
  const legacy = await loadAccounts(ctx.paths)
  if (!legacy) return
  const snapshot = legacy.quota?.mainQuota
  if (snapshot && row.credentialEpoch !== undefined) {
    const attribution = {
      credentialEpoch: row.credentialEpoch,
      ...(row.identity !== undefined ? { identity: row.identity } : {}),
    }
    for (const observation of observationsFromLegacySnapshot(
      snapshot,
      legacy.quota?.mainQuotaCheckedAt,
    )) {
      try {
        await ctx.store.recordQuota(row.id, attribution, observation)
      } catch (error) {
        ctx.log.warn('legacy main quota not carried to the pool row', {
          rowId: row.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  const mainError = legacy.refresh?.mainLastRefreshError
  const account = legacy.accounts.find((a) => a.id === row.id)
  if (!account || !isOAuthAccount(account) || account.corrupt) return
  if (!mainError && !snapshot) return
  const next: AccountStorage = {
    ...legacy,
    accounts: [
      {
        ...account,
        ...(account.lastRefreshError || !mainError
          ? {}
          : { lastRefreshError: mainError }),
        ...(account.quota || !snapshot ? {} : { quota: snapshot }),
      },
    ],
  }
  try {
    await saveAccountState(next, ctx.paths, { accounts: [row.id] })
  } catch (error) {
    ctx.log.warn('legacy main backoff not carried to the pool row', {
      rowId: row.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Bookkeeping written once a transfer (or a migration with nothing to
 * import) is over: the record goes, and `mainAccountId` goes with it. Older
 * builds skip every roster row whose wire identity equals `mainAccountId`,
 * which is what hides the migrated `main` row from them while the slot still
 * holds the same token; once the slot no longer serves it they must see it.
 */
async function writeFinished(
  ctx: Context,
  mode: 'migrate' | 'adopt',
  extra: Pick<PoolMigrationBookkeeping, 'declinedSlotFingerprint'> = {},
): Promise<void> {
  await updateConfig(ctx, (config) => {
    const book = readPoolMigrationBookkeeping(config)
    delete config.mainAccountId
    writeBookkeeping(config, {
      ...(book.migratedAt !== undefined || mode === 'migrate'
        ? { migratedAt: book.migratedAt ?? ctx.now() }
        : {}),
      ...(extra.declinedSlotFingerprint !== undefined
        ? { declinedSlotFingerprint: extra.declinedSlotFingerprint }
        : book.declinedSlotFingerprint !== undefined
          ? { declinedSlotFingerprint: book.declinedSlotFingerprint }
          : {}),
    })
    return true
  })
}

async function clearRecord(ctx: Context): Promise<void> {
  await updateConfig(ctx, (config) => {
    const book = readPoolMigrationBookkeeping(config)
    if (!book.pending) return false
    const { pending: _dropped, ...rest } = book
    writeBookkeeping(config, rest)
    return true
  })
}

/**
 * Writes the record and, while the slot and the row share one token, shields
 * the row from older builds by naming its identity in `mainAccountId`.
 */
async function writeRecord(
  ctx: Context,
  record: PendingTransfer,
): Promise<void> {
  await updateConfig(ctx, (config) => {
    const book = readPoolMigrationBookkeeping(config)
    if (record.identity) config.mainAccountId = record.identity
    writeBookkeeping(config, { ...book, pending: record })
    return true
  })
}

/**
 * Puts the placeholder into the slot through the fence: the slot must still
 * hold exactly the (access, refresh) pair the record names. OpenCode's slot
 * has no compare-and-replace, so a login landing between the fence read and
 * the write is overwritten; that window is declared, not closed.
 */
async function finishTransfer(
  ctx: Context,
  mode: 'migrate' | 'adopt',
  record: PendingTransfer,
  operation: 'add' | 'rotate' | 'replace' | 'resumed',
): Promise<PoolTransferOutcome> {
  const completed = (
    placeholder: Extract<
      PoolTransferOutcome,
      { status: 'completed' }
    >['placeholder'],
  ): PoolTransferOutcome => ({
    status: 'completed',
    rowId: record.rowId,
    operation,
    placeholder,
  })
  const current = viewOf(await ctx.slot.get({ path: { id: PROVIDER } }))
  if (current.kind === 'placeholder') {
    await writeFinished(ctx, mode)
    await ctx.onStep('after-record-clear')
    return completed('already-present')
  }
  if (
    current.kind !== 'real' ||
    current.fingerprint !== record.slotFingerprint
  ) {
    await writeFinished(ctx, mode)
    await ctx.onStep('after-record-clear')
    return completed('slot-moved-on')
  }
  if (Object.keys(await ctx.slot.all()).length === 0)
    return { status: 'retry', reason: 'torn-read' }
  // From here an older build may serve the row: the slot copy is about to go.
  await updateConfig(ctx, (config) => {
    if (!('mainAccountId' in config)) return false
    delete config.mainAccountId
    return true
  })
  await ctx.onStep('after-shield-drop')
  const fenced = viewOf(await ctx.slot.get({ path: { id: PROVIDER } }))
  if (fenced.kind !== 'real' || fenced.fingerprint !== record.slotFingerprint) {
    await writeFinished(ctx, mode)
    await ctx.onStep('after-record-clear')
    return completed('slot-moved-on')
  }
  await ctx.onStep('before-placeholder-write')
  await ctx.slot.set({ path: { id: PROVIDER }, body: { ...POOL_PLACEHOLDER } })
  await ctx.onStep('after-placeholder-write')
  const readback = await ctx.slot.get({ path: { id: PROVIDER } })
  await writeFinished(ctx, mode)
  await ctx.onStep('after-record-clear')
  return completed(isPoolPlaceholder(readback) ? 'written' : 'overwritten')
}

async function executeTransfer(
  ctx: Context,
  mode: 'migrate' | 'adopt',
  step: Extract<Plan, { kind: 'transfer' }>,
): Promise<PoolTransferOutcome> {
  const { record } = step
  if (step.fresh) {
    await writeRecord(ctx, record)
    await ctx.onStep('after-record-write')
  }
  await applyToRow(ctx, record, step.credential)
  await ctx.onStep('after-row-write')
  return completeTransfer(
    ctx,
    mode,
    record,
    step.fresh ? record.operation : 'resumed',
  )
}

/**
 * Everything after the row write: prove the row holds the slot credential,
 * carry the legacy main state over, then the placeholder. A run resuming a
 * transfer whose row write already landed starts here too, so the carry-over
 * is never skipped by a crash (it is idempotent: the same readings merge to
 * the same map and the legacy per-row copy is written with the same token).
 */
async function completeTransfer(
  ctx: Context,
  mode: 'migrate' | 'adopt',
  record: PendingTransfer,
  operation: 'add' | 'rotate' | 'replace' | 'resumed',
): Promise<PoolTransferOutcome> {
  const row = await verifyRow(ctx, record)
  if (!row) return { status: 'retry', reason: 'verify-failed' }
  await ctx.onStep('after-verify')
  if (record.carryLegacyMain) {
    await carryLegacyMainState(ctx, row)
    await ctx.onStep('after-carry-over')
  }
  return finishTransfer(ctx, mode, record, operation)
}

const deferredLogged = new Set<string>()

async function run(
  deps: PoolMigrationDeps,
  mode: 'migrate' | 'adopt',
): Promise<PoolTransferOutcome> {
  const ctx = context(deps)
  let config: Record<string, unknown>
  try {
    config = await readConfig(ctx.paths.configPath)
  } catch (error) {
    return {
      status: 'error',
      reason: error instanceof Error ? error.message : String(error),
    }
  }
  const early = gate(ctx, mode, config)
  if (early) {
    if (early.status === 'already-migrated' && 'mainAccountId' in config)
      await repairShield(ctx)
    return early
  }

  let mainLock: HeldLock
  try {
    mainLock = await acquireLock(
      ctx,
      MAIN_REFRESH_LOCK_NAME,
      ctx.paths.configPath,
      ctx.locks.mainRefreshTtlMs,
    )
  } catch (error) {
    if (error instanceof LegacyLockContention)
      return { status: 'retry', reason: 'lock-contention' }
    throw error
  }
  try {
    return await runUnderMainLock(ctx, mode)
  } catch (error) {
    if (error instanceof LegacyLockContention)
      return { status: 'retry', reason: 'lock-contention' }
    if (error instanceof PoolOperationError)
      return { status: 'retry', reason: `store-${error.kind}` }
    throw error
  } finally {
    await mainLock.release().catch(() => {})
  }
}

/** The checks that end a run before any lock: custody mode and the marker. */
function gate(
  ctx: Context,
  mode: 'migrate' | 'adopt',
  config: Record<string, unknown>,
): PoolTransferOutcome | undefined {
  if (claustrumMode(config as Pick<AccountStorage, 'claustrum'>) !== 'local') {
    if (!deferredLogged.has(ctx.paths.configPath)) {
      deferredLogged.add(ctx.paths.configPath)
      ctx.log.info(
        'account pool migration deferred: claustrum custody mode keeps the legacy store',
      )
    }
    return { status: 'deferred-claustrum' }
  }
  const book = readPoolMigrationBookkeeping(config)
  if (mode === 'migrate' && book.migratedAt !== undefined)
    return { status: 'already-migrated' }
  if (mode === 'adopt' && book.migratedAt === undefined)
    return { status: 'not-migrated' }
  return undefined
}

async function runUnderMainLock(
  ctx: Context,
  mode: 'migrate' | 'adopt',
): Promise<PoolTransferOutcome> {
  let idHint: string | undefined
  for (let attempt = 0; attempt < 4; attempt++) {
    const config = await readConfig(ctx.paths.configPath)
    const early = gate(ctx, mode, config)
    if (early) {
      if (early.status === 'already-migrated') await repairShield(ctx)
      return early
    }
    let load = await ctx.store.read()
    if (load.status === 'pending-migration') {
      // The store refuses every write to a legacy roster until its pool key
      // exists. `mainAccountId` is deliberately kept here: older builds skip
      // the roster row whose identity it names, which keeps them off the
      // `main` row while the slot still holds the same token. It is dropped
      // just before the placeholder lands (see `finishTransfer`).
      await ctx.store.initialize()
      await ctx.onStep('after-pool-key-write')
      load = await ctx.store.read()
    }
    if (load.status !== 'ready')
      return {
        status: 'error',
        reason:
          load.status === 'error'
            ? `${load.file}: ${load.reason}`
            : 'pool still pending migration',
      }
    const slot = await readSlotHonouringLease(ctx)
    if (slot.kind === 'retry')
      return { status: 'retry', reason: 'legacy-refresh-in-progress' }
    if (slot.kind === 'indeterminate')
      return { status: 'retry', reason: 'host-slot-indeterminate' }
    const book = readPoolMigrationBookkeeping(config)
    const first = plan(
      mode,
      book,
      load.rows,
      slot,
      idHint,
      ctx.now(),
      ctx.newId,
    )

    if (first.kind === 'nothing') {
      if (mode === 'migrate') {
        await writeFinished(ctx, mode)
        await ctx.onStep('after-marker-write')
      }
      return { status: 'nothing-to-import', slot: first.slot }
    }
    if (first.kind === 'drop-record') {
      await clearRecord(ctx)
      await ctx.onStep('after-record-clear')
      continue
    }
    if (first.kind === 'ambiguous') {
      await writeFinished(ctx, mode, {
        declinedSlotFingerprint: first.record.slotFingerprint,
      })
      await ctx.onStep('after-record-clear')
      ctx.log.warn(
        'interrupted slot transfer left alone: the row was rotated since, so the slot copy may be stale; the next login resolves it',
        { rowId: first.record.rowId },
      )
      return { status: 'ambiguous', rowId: first.record.rowId }
    }
    if (first.kind === 'transfer' && first.fresh) idHint = first.record.rowId

    // Older builds refresh a roster row while holding its fallback refresh
    // lock (`fallbackRefreshLockName`). Hold the target row's lock across
    // the whole transfer, then re-read and plan again under it, so the row
    // cannot be rotated between the decision and the write.
    const rowLock = await acquireLock(
      ctx,
      fallbackRefreshLockName(first.record.rowId),
      ctx.paths.configPath,
      ctx.locks.fallbackTtlMs,
    )
    try {
      const locked = await ctx.store.read()
      if (locked.status !== 'ready') continue
      const lockedConfig = await readConfig(ctx.paths.configPath)
      const lockedSlot = await readSlotHonouringLease(ctx)
      if (lockedSlot.kind === 'retry')
        return { status: 'retry', reason: 'legacy-refresh-in-progress' }
      const second = plan(
        mode,
        readPoolMigrationBookkeeping(lockedConfig),
        locked.rows,
        lockedSlot,
        idHint,
        first.kind === 'transfer' ? first.record.recordedAt : ctx.now(),
        ctx.newId,
      )
      if (!samePlan(first, second)) continue
      if (second.kind === 'finish')
        return await completeTransfer(ctx, mode, second.record, 'resumed')
      if (second.kind === 'transfer')
        return await executeTransfer(ctx, mode, second)
    } finally {
      await rowLock.release().catch(() => {})
    }
  }
  return { status: 'retry', reason: 'unsettled' }
}

/**
 * An older build holding a pre-migration snapshot can write `mainAccountId`
 * back (its full-store save merges its snapshot over the file). With no
 * transfer in flight nothing needs the shield, so a finished migration
 * removes it again rather than let older builds skip the `main` row.
 */
async function repairShield(ctx: Context): Promise<void> {
  await updateConfig(ctx, (config) => {
    if (!('mainAccountId' in config)) return false
    if (readPoolMigrationBookkeeping(config).pending) return false
    delete config.mainAccountId
    return true
  })
}

/**
 * One-time move of the host-slot credential into the pool row `main`
 * (fallback rows are already pool rows: same ids, same files). Local custody
 * mode only; under claustrum mode it writes nothing and logs once. A re-run
 * after completion does nothing.
 */
export function migrateToPool(
  deps: PoolMigrationDeps,
): Promise<PoolTransferOutcome> {
  return run(deps, 'migrate')
}

/**
 * After migration: a real login found in the host slot (someone ran
 * `/login openai` in OpenCode) moves into the pool, matched by wire identity,
 * and the placeholder goes back into the slot.
 */
export function adoptHostSlotLogin(
  deps: PoolMigrationDeps,
): Promise<PoolTransferOutcome> {
  return run(deps, 'adopt')
}

// ---------------------------------------------------------------------------
// Refresh of a pool row while older builds may run
// ---------------------------------------------------------------------------

export interface PoolRowRefreshDeps {
  paths: AccountPaths
  store: PoolStore
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  legacyLocks?: Partial<LegacyLockOptions>
  /** Bound and poll interval for waiting out an active legacy main lease. */
  leaseWait?: { timeoutMs: number; pollMs: number }
}

/** Thrown from the provider seam when a legacy main lease covers the token. */
export class LegacyMainRefreshInFlightError extends Error {
  constructor() {
    super(
      'an older build holds a refresh lease on this token; not refreshing it here',
    )
    this.name = 'LegacyMainRefreshInFlightError'
  }
}

/**
 * The legacy locks a pool refresh of `rowId` must also hold: `main-refresh`
 * (an older build refreshes the slot's token under it, and any row can share
 * the slot's token while a transfer is interrupted) and the row's fallback
 * lock (an older build refreshes every enabled roster row under it, the
 * migrated `main` row included). The provider-wide lock already serialises
 * every refresh, so these cost no concurrency.
 */
export function legacyRefreshLocks(
  paths: AccountPaths,
  rowId: string,
  options: Partial<LegacyLockOptions> = {},
): PoolLockSpec[] {
  const locks = { ...LEGACY_LOCK_DEFAULTS, ...options }
  const tuning = {
    renew: locks.renew,
    timeoutMs: locks.timeoutMs,
    retryMs: locks.retryMs,
    ...(locks.renewIntervalMs !== undefined
      ? { renewIntervalMs: locks.renewIntervalMs }
      : {}),
  }
  return [
    {
      name: MAIN_REFRESH_LOCK_NAME,
      path: paths.configPath,
      ttlMs: locks.mainRefreshTtlMs,
      ...tuning,
    },
    {
      name: fallbackRefreshLockName(rowId),
      path: paths.configPath,
      ttlMs: locks.fallbackTtlMs,
      ...tuning,
    },
  ]
}

/**
 * Refreshes one pool row with the legacy locks as the store's extra locks,
 * and honours an active legacy main lease on the row's token the way
 * `refreshMainWithLease` does: it waits (bounded) and never refreshes that
 * token itself. Once such a lease was seen the token may already be spent by
 * the older build (which writes its result to the host slot, not the row),
 * so the refresh fails retryably and adoption of the slot takes over.
 */
export async function refreshPoolRow(
  deps: PoolRowRefreshDeps,
  rowId: string,
  provider: ProviderRefresh,
  options: Omit<RefreshOptions, 'extraLocks'> = {},
): Promise<RefreshOutcome> {
  const now = deps.now ?? Date.now
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const wait = deps.leaseWait ?? { timeoutMs: 4_000, pollMs: 50 }
  const guarded: ProviderRefresh = async (credential, row) => {
    const hash = hashRefreshToken(credential.refresh)
    const active = async () => {
      const legacy = await loadAccounts(deps.paths)
      const until = legacy?.refresh?.mainRefreshLeaseUntil
      return Boolean(
        until &&
          until > now() &&
          legacy?.refresh?.mainRefreshLeaseTokenHash === hash,
      )
    }
    if (await active()) {
      const deadline = now() + wait.timeoutMs
      while (now() < deadline && (await active())) await sleep(wait.pollMs)
      throw new LegacyMainRefreshInFlightError()
    }
    return provider(credential, row)
  }
  return deps.store.refresh(rowId, guarded, {
    ...options,
    extraLocks: legacyRefreshLocks(deps.paths, rowId, deps.legacyLocks),
  })
}

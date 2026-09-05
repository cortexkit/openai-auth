import { createHash } from 'node:crypto'
import { fallbackRefreshLockName } from './account-paths.ts'
import type {
  AccountStorage,
  AccountStoreTransaction,
  OAuthAccount,
} from './accounts.ts'
import { custodyTombstoneKey, tombstoned } from './custody.ts'
import { asCompleteMainOauthSlot } from './custody-host-slot.ts'
import {
  type CustodyManifestReadResult,
  custodyManifestHandles,
} from './custody-manifest.ts'
import type { CustodyInertReason } from './custody-state.ts'

export type ClaustrumMode = 'local' | 'claustrum'

export type CustodyTransitionState = {
  manifestRevision: string
  storeGeneration: string
  fingerprints: {
    main?: string
    fallbacks: Record<string, string>
  }
}

export const MODE_LOCK_NAME = 'claustrum-mode'
export const MAIN_REFRESH_LOCK_NAME = 'main-refresh'

export type TransitionOutcome =
  | 'ready'
  | 'tombstoned'
  | Extract<
      CustodyInertReason,
      | 'new-local-family-under-claustrum'
      | 'vault-cold'
      | 'vault-reauth'
      | 'identity-mismatch'
      | 'no-handle'
    >
  | 'torn-read-deferred'
  | `aborted:${string}`

export type TransitionResult = {
  status: 'completed' | 'incomplete' | 'aborted'
  outcomes: Record<string, TransitionOutcome>
  reason?: string
}

type Release = { release(): Promise<void> }

export type EnterClaustrumModeDeps = {
  accountIds: readonly string[]
  acquireLock(options: {
    name: string
    renew: boolean
  }): Promise<Release | null>
  withStoreTransaction(
    action: (transaction: AccountStoreTransaction) => Promise<TransitionResult>,
  ): Promise<TransitionResult>
  readManifest(): Promise<CustodyManifestReadResult>
  preflight(input: {
    id: string
    accountId?: string
    handle: string
  }): Promise<
    Exclude<
      TransitionOutcome,
      | `aborted:${string}`
      | 'tombstoned'
      | 'new-local-family-under-claustrum'
      | 'torn-read-deferred'
    >
  >
  auth: {
    all(): Promise<Record<string, unknown>>
    get(input: { path: { id: string } }): Promise<unknown>
    set(input: {
      path: { id: string }
      body: { type: 'oauth'; access: string; refresh: string; expires: number }
    }): Promise<void>
  }
  onStep?(step: string): void | Promise<void>
  warn?(message: string): void
}

let custodyMutexTail = Promise.resolve()

export async function acquireCustodyTransitionMutex(): Promise<Release> {
  let release!: () => void
  const next = new Promise<void>((resolve) => {
    release = resolve
  })
  const previous = custodyMutexTail
  custodyMutexTail = previous.then(() => next)
  await previous
  let released = false
  return {
    async release() {
      if (released) return
      released = true
      release()
    },
  }
}

export async function releaseCustodyLoginLeaseAfterHostWrite(input: {
  accessToken: string
  getAuth(): Promise<{ access?: string } | undefined>
  release(): Promise<void>
  warn(message: string): void
  now(): number
  sleep(ms: number): Promise<void>
}): Promise<void> {
  const deadline = input.now() + 5_000
  while (input.now() < deadline) {
    try {
      const auth = await input.getAuth()
      if (auth?.access === input.accessToken) {
        await input.release()
        return
      }
    } catch {
      // A transient host read must not strand the process-local exclusion lease.
    }
    await input.sleep(Math.max(0, Math.min(100, deadline - input.now())))
  }
  input.warn('host write not observed within 5s; lease released')
  await input.release()
}

type Participant = {
  id: string
  accountId?: string
  kind: 'main' | 'fallback'
}

function enabledOauthAccounts(storage: AccountStorage): OAuthAccount[] {
  return storage.accounts.filter(
    (account): account is OAuthAccount =>
      account.type === 'oauth' && account.enabled !== false,
  )
}

function compareAccountIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function transitionParticipants(
  accountIds: readonly string[],
  storage?: AccountStorage,
): Participant[] {
  return [
    { id: 'main', accountId: storage?.mainAccountId, kind: 'main' as const },
    ...accountIds.map((id) => ({
      id,
      accountId: storage?.accounts.find((account) => account.id === id)
        ?.accountId,
      kind: 'fallback' as const,
    })),
  ].sort((left, right) => compareAccountIds(left.id, right.id))
}

function lockName(participant: Participant): string {
  return participant.kind === 'main'
    ? MAIN_REFRESH_LOCK_NAME
    : fallbackRefreshLockName(participant.id)
}

function fallbackFingerprint(account: OAuthAccount): string | undefined {
  return account.access
    ? custodySlotFingerprint(account.access, account.refresh)
    : undefined
}

function incomplete(outcomes: Record<string, TransitionOutcome>): boolean {
  return Object.values(outcomes).some(
    (outcome) =>
      outcome === 'new-local-family-under-claustrum' ||
      outcome === 'torn-read-deferred' ||
      outcome.startsWith('aborted:'),
  )
}

export async function enterClaustrumMode(
  deps: EnterClaustrumModeDeps,
): Promise<TransitionResult> {
  const mutex = await acquireCustodyTransitionMutex()
  const locks: Release[] = []
  const outcomes: Record<string, TransitionOutcome> = {}
  let warnedTornRead = false

  const step = async (name: string) => {
    await deps.onStep?.(name)
  }

  try {
    await step('mutex-acquired')
    if (
      deps.accountIds.includes('main') ||
      new Set(deps.accountIds).size !== deps.accountIds.length
    ) {
      return { status: 'aborted', outcomes, reason: 'duplicate-account-lock' }
    }
    const modeLock = await deps.acquireLock({
      name: MODE_LOCK_NAME,
      renew: true,
    })
    if (!modeLock)
      return { status: 'aborted', outcomes, reason: 'mode-lock-unavailable' }
    locks.push(modeLock)

    const participants = transitionParticipants(deps.accountIds)
    for (const participant of participants) {
      const accountLock = await deps.acquireLock({
        name: lockName(participant),
        renew: true,
      })
      if (!accountLock) {
        return {
          status: 'aborted',
          outcomes,
          reason: `account-lock-unavailable:${participant.id}`,
        }
      }
      locks.push(accountLock)
    }

    return await deps.withStoreTransaction(async (transaction) => {
      const initial = await transaction.read()
      const currentParticipants = transitionParticipants(
        deps.accountIds,
        initial,
      )
      const currentAccountIds = enabledOauthAccounts(initial)
        .map((account) => account.id)
        .sort(compareAccountIds)
      const lockedAccountIds = [...deps.accountIds].sort(compareAccountIds)
      if (
        currentAccountIds.length !== lockedAccountIds.length ||
        currentAccountIds.some((id, index) => id !== lockedAccountIds[index])
      ) {
        return { status: 'aborted', outcomes, reason: 'account-roster-changed' }
      }
      const manifest = await deps.readManifest()
      if (!manifest.ok) {
        return {
          status: 'aborted',
          outcomes,
          reason: `manifest-${manifest.reason}`,
        }
      }
      const handles = custodyManifestHandles(manifest)
      const persisted =
        initial.claustrum?.mode === 'claustrum'
          ? initial.claustrum?.transition
          : undefined
      const fingerprints: CustodyTransitionState['fingerprints'] = persisted
        ? persisted.fingerprints
        : { fallbacks: {} }
      const capturedGeneration =
        persisted?.storeGeneration ?? accountStoreGeneration(initial)
      if (!persisted) {
        const mainSlot = asCompleteMainOauthSlot(
          await deps.auth.get({ path: { id: 'openai' } }),
        )
        if (mainSlot) {
          fingerprints.main = custodySlotFingerprint(
            mainSlot.access,
            mainSlot.refresh,
          )
        }
        for (const account of enabledOauthAccounts(initial)) {
          const fingerprint = fallbackFingerprint(account)
          if (fingerprint) fingerprints.fallbacks[account.id] = fingerprint
        }
      }
      await step('captured')

      for (const participant of currentParticipants) {
        const handle = handles.get(participant.id)
        if (!handle) {
          outcomes[participant.id] = 'no-handle'
          continue
        }
        const outcome = await deps.preflight({
          id: participant.id,
          accountId: participant.accountId,
          handle,
        })
        outcomes[participant.id] = outcome
      }
      await step('preflight')
      if (Object.values(outcomes).some((outcome) => outcome !== 'ready')) {
        return { status: 'aborted', outcomes, reason: 'preflight-failed' }
      }

      if (!persisted) {
        const revalidatedManifest = await deps.readManifest()
        const revalidated = await transaction.read()
        if (
          !revalidatedManifest.ok ||
          revalidatedManifest.revision !== manifest.revision
        ) {
          return {
            status: 'aborted',
            outcomes,
            reason: 'manifest-revision-changed',
          }
        }
        if (accountStoreGeneration(revalidated) !== capturedGeneration) {
          return {
            status: 'aborted',
            outcomes,
            reason: 'store-generation-changed',
          }
        }
        await step('revalidated')
        await transaction.writeMode('claustrum', {
          manifestRevision: manifest.revision,
          storeGeneration: capturedGeneration,
          fingerprints,
        })
        await step('mode-written')
      }

      let materialWriteFailed = false
      for (const participant of participants) {
        if (participant.kind === 'main') continue
        const current = await transaction.read()
        const account = current.accounts.find(
          (candidate): candidate is OAuthAccount =>
            candidate.id === participant.id && candidate.type === 'oauth',
        )
        if (account && tombstoned(account, 'openai')) {
          outcomes[participant.id] = 'tombstoned'
          continue
        }
        const expected = fingerprints.fallbacks[participant.id]
        if (
          !account ||
          !expected ||
          fallbackFingerprint(account) !== expected
        ) {
          outcomes[participant.id] = 'new-local-family-under-claustrum'
          continue
        }
        const next = structuredClone(current)
        const nextAccount = next.accounts.find(
          (candidate): candidate is OAuthAccount =>
            candidate.id === participant.id && candidate.type === 'oauth',
        )
        if (!nextAccount) {
          outcomes[participant.id] = 'new-local-family-under-claustrum'
          continue
        }
        nextAccount.access = custodyTombstoneKey('openai')
        nextAccount.refresh = custodyTombstoneKey('openai')
        nextAccount.expires = 0
        try {
          await transaction.write(next)
          const written = (await transaction.read()).accounts.find(
            (candidate): candidate is OAuthAccount =>
              candidate.id === participant.id && candidate.type === 'oauth',
          )
          outcomes[participant.id] =
            written && tombstoned(written, 'openai')
              ? 'tombstoned'
              : 'aborted:post-write-readback'
        } catch {
          outcomes[participant.id] = 'aborted:write-failed'
          materialWriteFailed = true
          break
        }
      }

      if (materialWriteFailed) {
        await step('material-written')
        return { status: 'incomplete', outcomes }
      }

      const currentMain = asCompleteMainOauthSlot(
        await deps.auth.get({ path: { id: 'openai' } }),
      )
      if (
        currentMain &&
        tombstoned(
          {
            id: 'main',
            type: 'oauth',
            access: currentMain.access,
            refresh: currentMain.refresh,
            expires: currentMain.expires ?? 0,
          },
          'openai',
        )
      ) {
        outcomes.main = 'tombstoned'
      } else if (!fingerprints.main || !currentMain) {
        outcomes.main = 'new-local-family-under-claustrum'
      } else if (
        custodySlotFingerprint(currentMain.access, currentMain.refresh) !==
        fingerprints.main
      ) {
        outcomes.main = 'new-local-family-under-claustrum'
      } else {
        const all = await deps.auth.all()
        if (Object.keys(all).length === 0) {
          if (!warnedTornRead) {
            warnedTornRead = true
            deps.warn?.(
              'host auth store read empty; refusing to write — possible torn read',
            )
          }
          outcomes.main = 'torn-read-deferred'
        } else {
          try {
            await deps.auth.set({
              path: { id: 'openai' },
              body: {
                type: 'oauth',
                access: custodyTombstoneKey('openai'),
                refresh: custodyTombstoneKey('openai'),
                expires: 0,
              },
            })
            const after = asCompleteMainOauthSlot(
              await deps.auth.get({ path: { id: 'openai' } }),
            )
            outcomes.main =
              after &&
              tombstoned(
                {
                  id: 'main',
                  type: 'oauth',
                  access: after.access,
                  refresh: after.refresh,
                  expires: after.expires ?? 0,
                },
                'openai',
              )
                ? 'tombstoned'
                : 'new-local-family-under-claustrum'
          } catch {
            outcomes.main = 'aborted:write-failed'
          }
        }
      }
      await step('material-written')
      if (!incomplete(outcomes)) {
        await transaction.writeMode('claustrum')
      }
      return {
        status: incomplete(outcomes) ? 'incomplete' : 'completed',
        outcomes,
      }
    })
  } finally {
    for (const lock of locks.reverse()) await lock.release()
    await step('mutex-released')
    await mutex.release()
  }
}

export async function leaveClaustrumMode(
  deps: Pick<EnterClaustrumModeDeps, 'acquireLock' | 'withStoreTransaction'>,
): Promise<void> {
  const modeLock = await deps.acquireLock({ name: MODE_LOCK_NAME, renew: true })
  if (!modeLock) throw new Error('Claustrum mode lock unavailable')
  try {
    await deps.withStoreTransaction(async (transaction) => {
      await transaction.writeMode('local')
      return { status: 'completed', outcomes: {} }
    })
  } finally {
    await modeLock.release()
  }
}

export function custodySlotFingerprint(
  access: string,
  refresh: string,
): string {
  const accessBytes = Buffer.from(access, 'utf8')
  const refreshBytes = Buffer.from(refresh, 'utf8')
  const accessLength = Buffer.allocUnsafe(4)
  const refreshLength = Buffer.allocUnsafe(4)
  accessLength.writeUInt32BE(accessBytes.length)
  refreshLength.writeUInt32BE(refreshBytes.length)
  return createHash('sha256')
    .update(accessLength)
    .update(accessBytes)
    .update(refreshLength)
    .update(refreshBytes)
    .digest('hex')
}

export function accountStoreGeneration(
  storage: Pick<AccountStorage, 'accounts'>,
): string {
  const rows = storage.accounts
    .filter((account) => account.type === 'oauth')
    .map((account) => ({
      id: account.id,
      enabled: account.enabled !== false,
      accountId: account.accountId ?? '',
      access: account.access ?? '',
      refresh: account.refresh,
      expires: account.expires ?? null,
    }))
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    )

  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

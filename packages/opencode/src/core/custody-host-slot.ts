import { createHash } from 'node:crypto'
import { custodyTombstoneKey, tombstoned } from './custody.ts'
import {
  type CustodyManifestReadResult,
  custodyManifestHandles,
} from './custody-manifest.ts'
import { type CustodyVerdict, evaluateCustodyStartup } from './custody-state.ts'
import { extractAccountIdFromClaims, parseJwtClaims } from './oauth.ts'

const MAIN_PROVIDER = 'openai'
const SLOT_ABSENT_CONFIRMATION_MS = 250
const verifiedInProcessMainLoginFingerprints = new Set<string>()

export type MainOauthSlot = {
  type: 'oauth'
  access?: string
  refresh?: string
  expires?: number
}

export function mainSlotFamilyFingerprint(
  slot: MainOauthSlot,
): string | undefined {
  if (typeof slot.access !== 'string' || typeof slot.refresh !== 'string') {
    return undefined
  }
  const access = Buffer.from(slot.access)
  const refresh = Buffer.from(slot.refresh)
  const length = (value: Buffer) => {
    const encoded = Buffer.alloc(4)
    encoded.writeUInt32BE(value.length)
    return encoded
  }
  return createHash('sha256')
    .update(length(access))
    .update(access)
    .update(length(refresh))
    .update(refresh)
    .digest('hex')
}

export function recordVerifiedInProcessMainLogin(slot: MainOauthSlot): void {
  const fingerprint = mainSlotFamilyFingerprint(slot)
  if (fingerprint) verifiedInProcessMainLoginFingerprints.add(fingerprint)
}

export function hasVerifiedInProcessMainLogin(slot: MainOauthSlot): boolean {
  const fingerprint = mainSlotFamilyFingerprint(slot)
  return (
    fingerprint !== undefined &&
    verifiedInProcessMainLoginFingerprints.has(fingerprint)
  )
}

export type MainAuthSlot =
  | { kind: 'real'; oauth: MainOauthSlot }
  | { kind: 'tombstone'; oauth: MainOauthSlot }
  | { kind: 'empty'; oauth: MainOauthSlot }
  | { kind: 'slot-absent' }
  | { kind: 'indeterminate' }

type HostAuthClient = {
  auth: {
    get?: (input: { path: { id: string } }) => Promise<unknown>
    all?: () => Promise<Record<string, unknown>>
    set?: unknown
  }
}

type MainSlotConfirmationDeps = {
  client: HostAuthClient
  now: () => number
  sleep: (ms: number) => Promise<void>
}

type MainSlotReconciliationDeps = MainSlotConfirmationDeps & {
  mode: 'local' | 'claustrum'
  manifest: CustodyManifestReadResult
  mainAccountId?: string
  getCredential?: (handle: string) => Promise<{ access: string }>
  isReauth?: (handle: string) => boolean
}

export type CustodyBootstrap = {
  mainVerdict?: CustodyVerdict
  mainAccountId?: string
  cache?: {
    get(
      handle: string,
      minTtlMs?: number,
    ): Promise<{ payload: { access: string } }>
    isReauth(handle: string): boolean
  }
}

function asOauthSlot(value: unknown): MainOauthSlot | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Record<string, unknown>
  if (candidate.type !== 'oauth') return undefined
  return {
    type: 'oauth',
    ...(typeof candidate.access === 'string'
      ? { access: candidate.access }
      : {}),
    ...(typeof candidate.refresh === 'string'
      ? { refresh: candidate.refresh }
      : {}),
    ...(typeof candidate.expires === 'number'
      ? { expires: candidate.expires }
      : {}),
  }
}

export function asCompleteMainOauthSlot(
  value: unknown,
): { access: string; refresh: string; expires?: number } | undefined {
  const oauth = asOauthSlot(value)
  if (typeof oauth?.access !== 'string' || typeof oauth.refresh !== 'string') {
    return undefined
  }
  return {
    access: oauth.access,
    refresh: oauth.refresh,
    ...(typeof oauth.expires === 'number' ? { expires: oauth.expires } : {}),
  }
}

export function classifyMainAuthSlot(value: unknown): MainAuthSlot {
  const oauth = asOauthSlot(value)
  if (!oauth) return { kind: 'indeterminate' }
  if (
    !tombstoned(
      {
        id: 'main',
        type: 'oauth',
        access: oauth.access ?? '',
        refresh: oauth.refresh ?? '',
        expires: oauth.expires ?? 0,
        addedAt: 0,
      },
      MAIN_PROVIDER,
    )
  ) {
    return { kind: 'real', oauth }
  }
  if (
    oauth.access === custodyTombstoneKey(MAIN_PROVIDER) &&
    oauth.expires === 0
  ) {
    return { kind: 'tombstone', oauth }
  }
  return { kind: 'empty', oauth }
}

async function getMainSlot(client: HostAuthClient): Promise<unknown> {
  if (!client.auth.get) return undefined
  return client.auth.get({ path: { id: MAIN_PROVIDER } })
}

async function nonEmptyAuthMap(client: HostAuthClient): Promise<boolean> {
  if (!client.auth.all) return false
  return Object.keys(await client.auth.all()).length > 0
}

export async function confirmMainAuthSlot(
  deps: MainSlotConfirmationDeps,
): Promise<MainAuthSlot> {
  const first = await getMainSlot(deps.client)
  if (first !== undefined) return classifyMainAuthSlot(first)

  const firstMapNonEmpty = await nonEmptyAuthMap(deps.client)
  const beforeSleep = deps.now()
  await deps.sleep(SLOT_ABSENT_CONFIRMATION_MS)
  if (deps.now() - beforeSleep < SLOT_ABSENT_CONFIRMATION_MS) {
    return { kind: 'indeterminate' }
  }

  const second = await getMainSlot(deps.client)
  if (second !== undefined) return classifyMainAuthSlot(second)
  const secondMapNonEmpty = await nonEmptyAuthMap(deps.client)
  return firstMapNonEmpty && secondMapNonEmpty
    ? { kind: 'slot-absent' }
    : { kind: 'indeterminate' }
}

function manifestState(
  manifest: CustodyManifestReadResult,
): 'absent' | 'present' | 'unreadable' {
  if (manifest.ok) return 'present'
  return manifest.reason === 'absent' ? 'absent' : 'unreadable'
}

export function mainAccountIdFromServedCredential(
  access: string,
): string | undefined {
  const claims = parseJwtClaims(access)
  return claims ? extractAccountIdFromClaims(claims) : undefined
}

async function mainVaultState(
  deps: MainSlotReconciliationDeps,
): Promise<
  'serves' | 'cold' | 'needs_reauth' | 'identity_mismatch' | 'no_handle'
> {
  const handle = custodyManifestHandles(deps.manifest).get('main')
  if (!handle) return 'no_handle'
  if (!deps.getCredential) return 'cold'
  try {
    const credential = await deps.getCredential(handle)
    const servedAccountId = mainAccountIdFromServedCredential(credential.access)
    if (
      deps.mainAccountId &&
      servedAccountId &&
      servedAccountId !== deps.mainAccountId
    ) {
      return 'identity_mismatch'
    }
    return 'serves'
  } catch {
    return deps.isReauth?.(handle) ? 'needs_reauth' : 'cold'
  }
}

function verifiedInProcessLogin(slot: MainAuthSlot): boolean {
  return slot.kind === 'real' && hasVerifiedInProcessMainLogin(slot.oauth)
}

export async function reconcileMainSlotBeforeHooks(
  deps: MainSlotReconciliationDeps,
): Promise<CustodyVerdict | undefined> {
  const slot = await confirmMainAuthSlot(deps)
  if (slot.kind === 'indeterminate') return undefined

  const manifest = manifestState(deps.manifest)
  if (slot.kind === 'slot-absent') {
    const vault = await mainVaultState(deps)
    return evaluateCustodyStartup({
      mode: deps.mode,
      manifest,
      local: slot.kind,
      verifiedInProcessLogin: verifiedInProcessLogin(slot),
      // The absent-slot recovery row remains takeover-incomplete while a bound
      // vault is merely cold or latched; only a missing/disputed binding changes
      // the typed factory verdict.
      vault: () =>
        vault === 'no_handle' || vault === 'identity_mismatch'
          ? vault
          : 'serves',
    })
  }

  const vault = await mainVaultState(deps)
  return evaluateCustodyStartup({
    mode: deps.mode,
    manifest,
    local: slot.kind,
    verifiedInProcessLogin: verifiedInProcessLogin(slot),
    vault: () => vault,
  })
}

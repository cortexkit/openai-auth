import {
  type AccountStorage,
  isSafeResetAccountKey,
  type loadAccounts,
  type mutateAccounts,
  type OAuthQuotaSnapshot,
  type ResetAccountState,
  type ResetInFlight,
} from './accounts.ts'

const RESET_CREDITS_PATH = '/backend-api/wham/rate-limit-reset-credits'
const RESET_CREDITS_URL = `https://chatgpt.com${RESET_CREDITS_PATH}`
const CONSUME_RESET_CREDIT_PATH = `${RESET_CREDITS_PATH}/consume`
const CONSUME_RESET_CREDIT_URL = `https://chatgpt.com${CONSUME_RESET_CREDIT_PATH}`

const RESET_IN_FLIGHT_TTL_MS = 5 * 60_000
// This timeout must remain below the in-flight TTL so an uncertain request is
// persisted long enough for every immediate retry to reuse its identity.
const RESET_CONSUME_TIMEOUT_MS = 60_000
// The list GET is a read-only lookup upstream of the mutating call, so it gets
// a tighter bound; a hung inventory fetch must not stall redemption indefinitely.
const RESET_LIST_TIMEOUT_MS = 15_000
const RESET_COOLDOWN_MS = 60_000

export interface ResetCredit {
  id: string
  status: string
  grantedAt?: string
  expiresAt: string
  resetType?: string
  isSupportedByPlan: boolean
}

export interface ResetCreditList {
  credits: ResetCredit[]
  availableCount?: number
}

export type ResetConsumeKind =
  | 'reset'
  | 'already_redeemed'
  | 'nothing_to_reset'
  | 'no_credit'
  | 'http_error'
  | 'ambiguous'

export interface ResetConsumeOutcome {
  kind: ResetConsumeKind
  raw: unknown
  status?: number
}

export type ResetPrecondition =
  | { ok: true }
  | {
      ok: false
      reason: 'not exhausted' | 'no applicable credits'
    }

export interface ResetStateDeps {
  configPath: string
  mutateAccountsFn: typeof mutateAccounts
  loadAccountsFn: typeof loadAccounts
  now: () => number
  randomUUID: () => string
}

export interface ResetResolvedTarget {
  accountKey: string
  label: string
  accessToken: string
  chatgptAccountId?: string
}

export interface RunResetCreditDeps extends ResetStateDeps {
  fetchImpl: typeof fetch
  resolveTarget(accountKey: string): Promise<ResetResolvedTarget>
  fetchUsage(target: ResetResolvedTarget): Promise<OAuthQuotaSnapshot>
  hasActiveRateLimitMark(accountKey: string): boolean
}

export interface RunResetCreditInput {
  accountKey: string
  expectedChatgptAccountId: string
  retry: boolean
}

export type ResetRedemptionErrorKind =
  | 'invalid_account_key'
  | 'identity_mismatch'
  | 'cooldown_active'
  | 'expired_unreconciled'
  | 'retry_without_inflight'
  | 'not_exhausted'
  | 'no_applicable_credits'
  | 'no_eligible_credit'

export class ResetRedemptionError extends Error {
  readonly kind: ResetRedemptionErrorKind
  readonly cooldownUntil?: number

  constructor(
    kind: ResetRedemptionErrorKind,
    message: string,
    cooldownUntil?: number,
  ) {
    super(message)
    this.name = 'ResetRedemptionError'
    this.kind = kind
    this.cooldownUntil = cooldownUntil
  }
}

export interface ResetLocalAmbiguousOutcome {
  kind: 'ambiguous_local'
  raw: { reason: 'corrupt_in_flight' }
}

export type ResetRedemptionOutcome =
  | ResetConsumeOutcome
  | ResetLocalAmbiguousOutcome

export type ResetSelectedCredit = ResetCredit | { id: string }

export interface RunResetCreditResult {
  target: ResetResolvedTarget
  selectedCredit: ResetSelectedCredit | undefined
  beforeState: ResetAccountState | undefined
  outcome: ResetRedemptionOutcome
  retrySafety: string
  finalizeStateWriteFailed?: boolean
}

interface ResetClaim {
  inFlight: ResetInFlight
  selectedCredit: ResetSelectedCredit
}

type ResetStateDecision =
  | {
      kind: 'fresh'
      beforeState: ResetAccountState | undefined
    }
  | {
      kind: 'claim'
      beforeState: ResetAccountState | undefined
      claim: ResetClaim
    }
  | {
      kind: 'expired_unreconciled'
      beforeState: ResetAccountState | undefined
      claim: ResetClaim
    }
  | {
      kind: 'cooldown'
      beforeState: ResetAccountState | undefined
      cooldownUntil: number
    }
  | {
      kind: 'corrupt'
      beforeState: ResetAccountState | undefined
    }

export type ResetCreditErrorKind = 'http_error' | 'invalid_response'

export class ResetCreditError extends Error {
  readonly kind: ResetCreditErrorKind
  readonly status?: number

  constructor(kind: ResetCreditErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'ResetCreditError'
    this.kind = kind
    this.status = status
  }
}

function whamHeaders(
  token: string,
  targetPath: string,
  accountId?: string,
): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
    'oai-client-platform': 'web',
    'oai-client-version': '0',
    'x-openai-target-path': targetPath,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneResetState(
  state: ResetAccountState | undefined,
): ResetAccountState | undefined {
  if (!state) return undefined
  return {
    ...(state.inFlight ? { inFlight: { ...state.inFlight } } : {}),
    ...(state.lastOutcome ? { lastOutcome: { ...state.lastOutcome } } : {}),
    ...(state.cooldownUntil !== undefined
      ? { cooldownUntil: state.cooldownUntil }
      : {}),
  }
}

function validInFlight(value: unknown): ResetInFlight | undefined {
  if (
    !isRecord(value) ||
    typeof value.redeemRequestId !== 'string' ||
    value.redeemRequestId.length === 0 ||
    typeof value.creditId !== 'string' ||
    value.creditId.length === 0 ||
    typeof value.startedAt !== 'number' ||
    !Number.isFinite(value.startedAt)
  ) {
    return undefined
  }
  return {
    redeemRequestId: value.redeemRequestId,
    creditId: value.creditId,
    startedAt: value.startedAt,
  }
}

function hasInFlightField(state: ResetAccountState | undefined): boolean {
  return Boolean(state && Object.hasOwn(state, 'inFlight'))
}

function isYoungerThanInFlightTtl(inFlight: ResetInFlight, now: number) {
  return now - inFlight.startedAt < RESET_IN_FLIGHT_TTL_MS
}

function resetStateForAccount(
  current: AccountStorage,
  accountKey: string,
): ResetAccountState | undefined {
  if (!isSafeResetAccountKey(accountKey)) return undefined
  return current.reset?.[accountKey]
}

function resetStateMap(current: AccountStorage) {
  if (!current.reset) {
    current.reset = Object.create(null) as NonNullable<AccountStorage['reset']>
  }
  return current.reset
}

function resolveCorruptState(
  current: AccountStorage,
  accountKey: string,
  now: number,
): void {
  if (!isSafeResetAccountKey(accountKey)) return
  const reset = resetStateMap(current)
  const state = reset[accountKey] ?? {}
  const previousOutcome = state.lastOutcome
  delete state.inFlight
  state.lastOutcome = {
    code: 'ambiguous_local',
    at: now,
    ...(previousOutcome
      ? {
          previousOutcome: {
            code: previousOutcome.code,
            at: previousOutcome.at,
          },
        }
      : {}),
  }
  reset[accountKey] = state
}

function inspectResetState(
  state: ResetAccountState | undefined,
  now: number,
): ResetStateDecision {
  const beforeState = cloneResetState(state)
  const inFlight = validInFlight(state?.inFlight)
  if (hasInFlightField(state) && !inFlight) {
    return { kind: 'corrupt', beforeState }
  }
  if (state?.cooldownUntil !== undefined && state.cooldownUntil > now) {
    return {
      kind: 'cooldown',
      beforeState,
      cooldownUntil: state.cooldownUntil,
    }
  }
  if (inFlight && isYoungerThanInFlightTtl(inFlight, now)) {
    return {
      kind: 'claim',
      beforeState,
      claim: {
        inFlight,
        selectedCredit: { id: inFlight.creditId },
      },
    }
  }
  if (inFlight) {
    return {
      kind: 'expired_unreconciled',
      beforeState,
      claim: {
        inFlight,
        selectedCredit: { id: inFlight.creditId },
      },
    }
  }
  return { kind: 'fresh', beforeState }
}

async function inspectResetAttempt(
  deps: ResetStateDeps,
  accountKey: string,
): Promise<ResetStateDecision> {
  if (!isSafeResetAccountKey(accountKey)) {
    return { kind: 'fresh', beforeState: undefined }
  }
  const current = await deps.loadAccountsFn(deps.configPath)
  return inspectResetState(
    current ? resetStateForAccount(current, accountKey) : undefined,
    deps.now(),
  )
}

async function resolveCorruptResetAttempt(
  deps: ResetStateDeps,
  accountKey: string,
): Promise<ResetStateDecision> {
  let decision: ResetStateDecision | undefined
  await deps.mutateAccountsFn((current) => {
    const now = deps.now()
    const state = resetStateForAccount(current, accountKey)
    decision = inspectResetState(state, now)
    if (decision.kind === 'corrupt') {
      resolveCorruptState(current, accountKey, now)
    }
    return current
  }, deps.configPath)
  if (!decision) throw new Error('corrupt reset state mutation did not run')
  return decision
}

export async function claimResetAttempt(
  deps: ResetStateDeps,
  accountKey: string,
  credits: readonly ResetCredit[],
): Promise<ResetStateDecision> {
  if (!isSafeResetAccountKey(accountKey)) {
    return { kind: 'fresh', beforeState: undefined }
  }
  let decision: ResetStateDecision | undefined
  await deps.mutateAccountsFn((current) => {
    const now = deps.now()
    const state = resetStateForAccount(current, accountKey)
    const beforeState = cloneResetState(state)
    const inFlight = validInFlight(state?.inFlight)
    if (hasInFlightField(state) && !inFlight) {
      resolveCorruptState(current, accountKey, now)
      decision = { kind: 'corrupt', beforeState }
      return current
    }
    if (state?.cooldownUntil !== undefined && state.cooldownUntil > now) {
      decision = {
        kind: 'cooldown',
        beforeState,
        cooldownUntil: state.cooldownUntil,
      }
      return current
    }
    if (inFlight && isYoungerThanInFlightTtl(inFlight, now)) {
      decision = {
        kind: 'claim',
        beforeState,
        claim: {
          inFlight,
          selectedCredit: { id: inFlight.creditId },
        },
      }
      return current
    }
    if (inFlight) {
      decision = {
        kind: 'expired_unreconciled',
        beforeState,
        claim: {
          inFlight,
          selectedCredit: { id: inFlight.creditId },
        },
      }
      return current
    }

    const selectedCredit = selectCreditToSpend(credits)
    if (!selectedCredit) {
      decision = { kind: 'fresh', beforeState }
      return current
    }
    const claimedInFlight = {
      redeemRequestId: deps.randomUUID(),
      creditId: selectedCredit.id,
      startedAt: now,
    }
    const reset = resetStateMap(current)
    reset[accountKey] = {
      ...state,
      inFlight: claimedInFlight,
    }
    decision = {
      kind: 'claim',
      beforeState,
      claim: { inFlight: claimedInFlight, selectedCredit },
    }
    return current
  }, deps.configPath)
  if (!decision) throw new Error('reset claim mutation did not run')
  return decision
}

export async function finalizeResetAttempt(
  deps: ResetStateDeps,
  accountKey: string,
  completing: ResetInFlight,
  outcome: ResetConsumeOutcome,
): Promise<void> {
  if (!isSafeResetAccountKey(accountKey)) return
  if (!isTerminalConsumeKind(outcome.kind)) return
  await deps.mutateAccountsFn((current) => {
    const state = resetStateForAccount(current, accountKey)
    const persisted = validInFlight(state?.inFlight)
    if (
      !state ||
      !persisted ||
      persisted.redeemRequestId !== completing.redeemRequestId ||
      persisted.creditId !== completing.creditId
    ) {
      return current
    }
    const now = deps.now()
    delete state.inFlight
    state.lastOutcome = { code: outcome.kind, at: now }
    if (outcome.kind === 'reset' || outcome.kind === 'already_redeemed') {
      state.cooldownUntil = now + RESET_COOLDOWN_MS
    } else {
      delete state.cooldownUntil
    }
    return current
  }, deps.configPath)
}

export function resetWindowIsExhausted(
  window: { usedPercent: number; resetsAt?: string } | undefined,
  now: number,
): boolean {
  if (!window || window.usedPercent < 100) return false
  if (!window.resetsAt) return true
  const resetsAt = Date.parse(window.resetsAt)
  return !Number.isFinite(resetsAt) || resetsAt > now
}

export function evaluateResetPrecondition(
  quota: OAuthQuotaSnapshot,
  hasActiveRateLimitMark: boolean,
  applicableAvailableCount: number,
  now: number,
): ResetPrecondition {
  const exhausted =
    hasActiveRateLimitMark ||
    resetWindowIsExhausted(quota.primary, now) ||
    resetWindowIsExhausted(quota.secondary, now)
  if (!exhausted) return { ok: false, reason: 'not exhausted' }
  if (applicableAvailableCount <= 0) {
    return { ok: false, reason: 'no applicable credits' }
  }
  return { ok: true }
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined | null {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  return typeof value === 'string' ? value : null
}

function parseCredit(value: unknown): ResetCredit | undefined {
  if (!isRecord(value)) return undefined

  const grantedAt = optionalString(value, 'granted_at')
  const resetType = optionalString(value, 'reset_type')
  if (
    typeof value.id !== 'string' ||
    typeof value.status !== 'string' ||
    typeof value.expires_at !== 'string' ||
    Number.isNaN(Date.parse(value.expires_at)) ||
    typeof value.is_supported_by_plan !== 'boolean' ||
    grantedAt === null ||
    resetType === null
  ) {
    return undefined
  }

  return {
    id: value.id,
    status: value.status,
    ...(grantedAt === undefined ? {} : { grantedAt }),
    expiresAt: value.expires_at,
    ...(resetType === undefined ? {} : { resetType }),
    isSupportedByPlan: value.is_supported_by_plan,
  }
}

export async function listResetCredits(
  fetchImpl: typeof fetch,
  token: string,
  accountId?: string,
): Promise<ResetCreditList> {
  let response: Response
  try {
    response = await fetchImpl(RESET_CREDITS_URL, {
      method: 'GET',
      headers: whamHeaders(token, RESET_CREDITS_PATH, accountId),
      signal: AbortSignal.timeout(RESET_LIST_TIMEOUT_MS),
    })
  } catch {
    throw new ResetCreditError('http_error', 'reset credit list request failed')
  }

  if (!response.ok) {
    throw new ResetCreditError(
      'http_error',
      `reset credit list request failed: ${response.status}`,
      response.status,
    )
  }

  let raw: unknown
  try {
    raw = await response.json()
  } catch {
    throw new ResetCreditError(
      'invalid_response',
      'reset credit list response was not valid JSON',
      response.status,
    )
  }

  if (!isRecord(raw)) {
    throw new ResetCreditError(
      'invalid_response',
      'reset credit list response was not an object',
      response.status,
    )
  }

  const wireCredits = Array.isArray(raw.credits) ? raw.credits : []

  return {
    credits: wireCredits.flatMap((value) => {
      const parsed = parseCredit(value)
      return parsed === undefined ? [] : [parsed]
    }),
    availableCount:
      typeof raw.available_count === 'number' &&
      Number.isFinite(raw.available_count)
        ? raw.available_count
        : undefined,
  }
}

export function selectCreditToSpend(
  credits: readonly ResetCredit[],
): ResetCredit | undefined {
  return [...credits]
    .filter(
      (credit) =>
        credit.status === 'available' &&
        credit.isSupportedByPlan &&
        credit.resetType === 'codex_rate_limits',
    )
    .sort(
      (left, right) => Date.parse(left.expiresAt) - Date.parse(right.expiresAt),
    )[0]
}

function isTerminalConsumeKind(value: unknown): value is ResetConsumeKind {
  return (
    value === 'reset' ||
    value === 'already_redeemed' ||
    value === 'nothing_to_reset' ||
    value === 'no_credit'
  )
}

export async function consumeResetCredit(
  fetchImpl: typeof fetch,
  token: string,
  accountId: string | undefined,
  creditId: string,
  redeemRequestId: string,
): Promise<ResetConsumeOutcome> {
  let response: Response
  try {
    response = await fetchImpl(CONSUME_RESET_CREDIT_URL, {
      method: 'POST',
      headers: {
        ...whamHeaders(token, CONSUME_RESET_CREDIT_PATH, accountId),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        redeem_request_id: redeemRequestId,
        credit_id: creditId,
      }),
      signal: AbortSignal.timeout(RESET_CONSUME_TIMEOUT_MS),
    })
  } catch (error) {
    return { kind: 'ambiguous', raw: error }
  }

  let body: string
  try {
    body = await response.text()
  } catch (error) {
    return response.ok
      ? { kind: 'ambiguous', raw: error }
      : { kind: 'http_error', raw: error, status: response.status }
  }

  let raw: unknown = body
  let parsed = false
  try {
    raw = JSON.parse(body)
    parsed = true
  } catch {}

  if (!response.ok) {
    return { kind: 'http_error', raw, status: response.status }
  }

  if (!parsed || !isRecord(raw) || !isTerminalConsumeKind(raw.code)) {
    return { kind: 'ambiguous', raw }
  }

  return { kind: raw.code, raw }
}

function throwForStateDecision(decision: ResetStateDecision): never {
  if (decision.kind === 'cooldown') {
    throw new ResetRedemptionError(
      'cooldown_active',
      'reset credit redemption is cooling down',
      decision.cooldownUntil,
    )
  }
  throw new Error(`unexpected reset state decision: ${decision.kind}`)
}

function throwExpiredUnreconciled(): never {
  throw new ResetRedemptionError(
    'expired_unreconciled',
    'the previous reset attempt outcome is unknown',
  )
}

function localAmbiguousResult(
  target: ResetResolvedTarget,
  beforeState: ResetAccountState | undefined,
): RunResetCreditResult {
  return {
    target,
    selectedCredit: undefined,
    beforeState,
    outcome: {
      kind: 'ambiguous_local',
      raw: { reason: 'corrupt_in_flight' },
    },
    retrySafety:
      'No request was sent because the saved redemption identity was incomplete.',
  }
}

function retrySafetyFor(outcome: ResetConsumeOutcome): string {
  if (outcome.kind === 'reset' || outcome.kind === 'already_redeemed') {
    return 'The server returned a terminal result; cooldown blocks an immediate new redemption.'
  }
  if (outcome.kind === 'nothing_to_reset' || outcome.kind === 'no_credit') {
    return 'The server returned a terminal no-op. No cooldown was set; a new attempt starts fresh and remains gated by fresh preconditions.'
  }
  return 'The outcome is uncertain. A retry within five minutes reuses the same request and credit identifiers; this does not prove the server did nothing.'
}

export async function runResetCreditRedemption(
  deps: RunResetCreditDeps,
  input: RunResetCreditInput,
): Promise<RunResetCreditResult> {
  if (!isSafeResetAccountKey(input.accountKey)) {
    throw new ResetRedemptionError(
      'invalid_account_key',
      'the reset account key is reserved',
    )
  }
  const target = await deps.resolveTarget(input.accountKey)
  if (target.chatgptAccountId !== input.expectedChatgptAccountId) {
    throw new ResetRedemptionError(
      'identity_mismatch',
      'the resolved ChatGPT account identity changed before redemption',
    )
  }
  const wireAccountId =
    target.accountKey === 'main' ? undefined : target.chatgptAccountId

  let initial = await inspectResetAttempt(deps, input.accountKey)
  if (initial.kind === 'corrupt') {
    initial = await resolveCorruptResetAttempt(deps, input.accountKey)
    if (initial.kind === 'corrupt') {
      return localAmbiguousResult(target, initial.beforeState)
    }
  }
  if (initial.kind === 'cooldown') throwForStateDecision(initial)

  let claim: ResetClaim
  if (initial.kind === 'claim') {
    claim = initial.claim
  } else if (initial.kind === 'expired_unreconciled') {
    if (!input.retry) throwExpiredUnreconciled()
    claim = initial.claim
  } else {
    if (input.retry) {
      throw new ResetRedemptionError(
        'retry_without_inflight',
        'there is no active reset credit redemption to retry',
      )
    }
    const [quota, credits] = await Promise.all([
      deps.fetchUsage(target),
      listResetCredits(deps.fetchImpl, target.accessToken, wireAccountId),
    ])
    const precondition = evaluateResetPrecondition(
      quota,
      deps.hasActiveRateLimitMark(input.accountKey),
      quota.resetCreditsApplicable ?? 0,
      deps.now(),
    )
    if (!precondition.ok) {
      throw new ResetRedemptionError(
        precondition.reason === 'not exhausted'
          ? 'not_exhausted'
          : 'no_applicable_credits',
        precondition.reason,
      )
    }
    if (!selectCreditToSpend(credits.credits)) {
      throw new ResetRedemptionError(
        'no_eligible_credit',
        'no eligible reset credit was returned',
      )
    }

    const claimed = await claimResetAttempt(
      deps,
      input.accountKey,
      credits.credits,
    )
    if (claimed.kind === 'corrupt') {
      return localAmbiguousResult(target, claimed.beforeState)
    }
    if (claimed.kind === 'cooldown') throwForStateDecision(claimed)
    if (claimed.kind === 'expired_unreconciled') {
      throwExpiredUnreconciled()
    }
    if (claimed.kind !== 'claim') {
      throw new ResetRedemptionError(
        'no_eligible_credit',
        'no eligible reset credit was available while claiming',
      )
    }
    claim = claimed.claim
  }

  const outcome = await consumeResetCredit(
    deps.fetchImpl,
    target.accessToken,
    wireAccountId,
    claim.inFlight.creditId,
    claim.inFlight.redeemRequestId,
  )
  let finalizeStateWriteFailed = false
  try {
    await finalizeResetAttempt(deps, input.accountKey, claim.inFlight, outcome)
  } catch {
    finalizeStateWriteFailed = isTerminalConsumeKind(outcome.kind)
  }
  return {
    target,
    selectedCredit: claim.selectedCredit,
    beforeState: initial.beforeState,
    outcome,
    retrySafety: finalizeStateWriteFailed
      ? 'The server returned a terminal result, but the state write failed. A retry within five minutes reuses the same request and credit identifiers.'
      : retrySafetyFor(outcome),
    ...(finalizeStateWriteFailed ? { finalizeStateWriteFailed: true } : {}),
  }
}

/**
 * OpenAI accounts held in the Claustrum vault, through the shared consumer in
 * `@cortexkit/common-auth/claustrum`.
 *
 * Each host (OpenCode, Pi) enrolls with the vault under its own name
 * (`openai-auth-opencode`, `openai-auth-pi`), so the operator approves and
 * revokes them separately. Enrollment runs only from setup surfaces (the
 * `opencode auth login` menu, the Vault section of `/openai`), never on the
 * request path: the operator approves the request with `ck`, and the token the
 * vault then hands out lives owner-only in this host's vault directory.
 *
 * Once enrolled, every OpenAI credential the vault lets this host read becomes
 * a routing row beside the local pool rows (`routes()`), and goes through the
 * same admission and routing. A vault row never holds a token: each send asks
 * the vault for one (`send`), deliberately without a cache, so a revoked
 * enrollment or a changed record takes effect on the next request. A 401 on a
 * served credential is reported to the vault with the exact record version
 * that send used; nothing else is reported. Vault quota lives in the roster
 * file next to the token, not in the account store.
 */
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveClaustrumConnectionPath } from '@cortexkit/claustrum-client'
import {
  assertHostSlotMatchesMode,
  ClaustrumConsumer,
  ClaustrumConsumerError,
  type ClaustrumEnrollmentConnection,
  ClaustrumEnrollmentManager,
  type ClaustrumEnrollmentPaths,
  type ClaustrumEnrollmentStatus,
  type ClaustrumFamily,
  type ClaustrumScopedAttempt,
  type ClaustrumScopedClient,
  connectClaustrumEnrollmentClient,
  connectClaustrumScopedClient,
  enrollmentName,
  hostEnrollmentPaths,
  readClaustrumEnrollmentStatus,
  type VaultRosterFile,
  type VaultRosterRow,
} from '@cortexkit/common-auth/claustrum'
import { projectQuota, type QuotaMap } from '@cortexkit/common-auth/quota'
import { createLogger } from './logger'
import { extractAccountIdFromClaims, parseJwtClaims } from './oauth'
import { observationFromSnapshot } from './pool-quota'
import { whamUsageFn } from './provider'
import { errorMessage } from './util/error'

const log = createLogger('vault')

/** The plugin part of each host's enrollment name (`openai-auth-opencode`, `openai-auth-pi`). */
export const VAULT_PLUGIN_NAME = 'openai-auth'

/**
 * Which vault credentials are OpenAI's: OAuth logins refreshed by the vault's
 * `openai` adapter, granted to this consumer under the `openai-native`
 * category.
 *
 * Static API keys (`apikey:openai`) are not admitted: they are never listed,
 * read or routed. Every request this plugin sends goes to the ChatGPT Codex
 * endpoint, which takes ChatGPT logins; a platform API key sent there as a
 * bearer would be refused, and that 401 would be reported to the vault as
 * the death of a key that works elsewhere. Admit them only once there is a
 * transport that sends an API key where it is accepted.
 */
export const VAULT_FAMILY: ClaustrumFamily = {
  refreshAdapter: 'openai',
  category: 'openai-native',
  apiKeys: false,
}

export type VaultHost = 'opencode' | 'pi'

const HOST_NAMES: Record<VaultHost, string> = {
  opencode: 'OpenCode',
  pi: 'Pi',
}

/** The name a host proposes when it enrolls, for example `openai-auth-pi`. */
export function vaultEnrollmentName(host: VaultHost): string {
  return enrollmentName(VAULT_PLUGIN_NAME, host)
}

/**
 * The directory a host keeps its vault files in: a dedicated subdirectory
 * next to its account state file. The vault library makes it owner-only
 * (0700), which is why it is not the host's own configuration directory.
 */
export function vaultStateDir(accountStatePath: string): string {
  return join(dirname(accountStatePath), 'openai-auth-vault')
}

export interface VaultPaths extends ClaustrumEnrollmentPaths {
  /** The roster: the vault accounts, their quota and the declined ones. Holds no token. */
  rosterPath: string
}

export function vaultPaths(stateDir: string, host: VaultHost): VaultPaths {
  return {
    ...hostEnrollmentPaths({ stateDir, host }),
    rosterPath: join(stateDir, `${host}-roster.json`),
  }
}

/** The ChatGPT account a served access token signs in as, read from its claims. */
export function vaultIdentityOf(accessToken: string): string | undefined {
  const claims = parseJwtClaims(accessToken)
  return claims ? extractAccountIdFromClaims(claims) : undefined
}

/** One vault account as routing sees it. */
export interface VaultRoute {
  id: string
  kind: 'oauth' | 'api-key'
  /** The ChatGPT account it signs in as, when the vault knows it. */
  identity?: string
  quota?: QuotaMap
}

export interface VaultStatus {
  host: VaultHost
  /** The name this host enrolls as. */
  name: string
  enrollment: ClaustrumEnrollmentStatus
  /** Every vault account this host can see, declined and cold ones included. */
  accounts: readonly VaultRosterRow[]
  lastError?: string
}

export interface VaultWaitOptions {
  /** Called with each status while the request waits for approval. */
  onPending?: (status: ClaustrumEnrollmentStatus) => void
  pollIntervalMs?: number
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

export interface OpenAiVaultOptions {
  host: VaultHost
  /** This host's vault directory; see `vaultStateDir`. */
  stateDir: string
  /** The vault's connection file; `CLAUSTRUM_SUBC_CONNECTION` or the default by default. */
  connectionFile?: () => string
  /** The project this host runs in, part of the identity the vault sees. */
  projectRoot?: string
  /** Replaces the request-path connection (tests). */
  connectScoped?: () => Promise<ClaustrumScopedClient>
  /** Replaces the setup-only enrollment connection (tests). */
  connectEnrollment?: () => Promise<ClaustrumEnrollmentConnection>
  /** Ids of the local pool rows; no vault route takes one. */
  reservedRouteIds?: () => Iterable<string>
  /** How often the roster is re-read from the vault; 0 stops the poll. */
  pollIntervalMs?: number
  fetchImpl?: () => typeof fetch
  now?: () => number
}

/** One host's view of its OpenAI accounts in the vault. */
export class OpenAiVault {
  readonly host: VaultHost
  readonly name: string
  readonly paths: VaultPaths
  readonly #options: OpenAiVaultOptions
  readonly #consumer: ClaustrumConsumer
  readonly #pulls = new Map<string, Promise<unknown>>()
  #lastError: string | undefined
  #waiting: Promise<ClaustrumEnrollmentStatus> | undefined

  constructor(options: OpenAiVaultOptions) {
    this.#options = options
    this.host = options.host
    this.name = vaultEnrollmentName(options.host)
    this.paths = vaultPaths(options.stateDir, options.host)
    this.#consumer = new ClaustrumConsumer({
      rosterPath: this.paths.rosterPath,
      tokenPath: this.paths.tokenPath,
      family: VAULT_FAMILY,
      connect: () => this.#connectScoped(),
      // The consumer lists and serves vault accounts only while this host
      // holds an enrollment token; without one it serves nothing.
      isCustodyActive: () => this.enrolled(),
      ...(options.reservedRouteIds
        ? { reservedRouteIds: options.reservedRouteIds }
        : {}),
      parseIdentity: vaultIdentityOf,
      ...(options.pollIntervalMs !== undefined
        ? { pollIntervalMs: options.pollIntervalMs }
        : {}),
      ...(options.now ? { now: options.now } : {}),
      onRoster: () => {
        this.#lastError = undefined
      },
      onError: (error) => this.#fail('vault roster refresh failed', error),
      logger: log,
    })
  }

  #connectionFile(): string {
    return (this.#options.connectionFile ?? resolveClaustrumConnectionPath)()
  }

  #clientOptions() {
    return {
      connectionFile: this.#connectionFile(),
      projectRoot: this.#options.projectRoot ?? process.cwd(),
      storagePath: this.paths.tokenPath,
      // The Claustrum client's default logger prints transport error classes
      // to stderr; they go to this plugin's debug log instead.
      logger: (errorClass: string) =>
        log.debug('vault transport error', { errorClass }),
    }
  }

  #connectScoped(): Promise<ClaustrumScopedClient> {
    return (
      this.#options.connectScoped?.() ??
      connectClaustrumScopedClient(this.#clientOptions())
    )
  }

  #connectEnrollment(): Promise<ClaustrumEnrollmentConnection> {
    return (
      this.#options.connectEnrollment?.() ??
      connectClaustrumEnrollmentClient(this.#clientOptions())
    )
  }

  #fail(message: string, error: unknown): void {
    this.#lastError = errorMessage(error)
    log.warn(message, { host: this.host, error: this.#lastError })
  }

  /** Whether this host holds an enrollment token. */
  enrolled(): boolean {
    return existsSync(this.paths.tokenPath)
  }

  /**
   * Starts polling the vault for this host's accounts. Cheap while the host
   * is not enrolled (one file check per poll), and it notices an enrollment
   * another process (`opencode auth login`) finished.
   */
  start(): void {
    this.#consumer.start()
  }

  /** Re-reads the accounts from the vault now. Never rejects. */
  async refresh(): Promise<VaultRosterFile | undefined> {
    try {
      const roster = await this.#consumer.refresh()
      this.#lastError = undefined
      return roster
    } catch (error) {
      this.#fail('vault roster refresh failed', error)
      return this.#consumer.snapshot()
    }
  }

  snapshot(): VaultRosterFile | undefined {
    return this.#consumer.snapshot()
  }

  /** Whether the vault serves this host any account (whatever its state). */
  serves(): boolean {
    return this.enrolled() && (this.snapshot()?.rows.length ?? 0) > 0
  }

  /**
   * The ChatGPT accounts the vault holds for this host. A local row signing
   * in as one of them is skipped: one account has one owner, and the vault
   * owns it even while it is declined or waiting for a new login there.
   */
  identities(): ReadonlySet<string> {
    if (!this.enrolled()) return new Set()
    return new Set(
      (this.snapshot()?.rows ?? []).flatMap((row) =>
        row.accountIdentity !== undefined ? [row.accountIdentity] : [],
      ),
    )
  }

  /** The vault accounts that may route now: enabled and active. */
  routes(): VaultRoute[] {
    if (!this.enrolled()) return []
    const rows = new Map(
      (this.snapshot()?.rows ?? []).map((row) => [row.routeId, row]),
    )
    return this.#consumer.routingRows().map((routing) => {
      const identity = rows.get(routing.id)?.accountIdentity
      return {
        id: routing.id,
        kind: routing.kind === 'api-key' ? 'api-key' : 'oauth',
        ...(identity !== undefined ? { identity } : {}),
        ...(routing.quota !== undefined ? { quota: routing.quota } : {}),
      }
    })
  }

  /** Whether a route id names a vault account. */
  owns(routeId: string): boolean {
    return (this.snapshot()?.rows ?? []).some((row) => row.routeId === routeId)
  }

  /**
   * Sends one request on a vault account. `dispatch` sends with the token
   * the vault serves for this attempt and may be called twice (a 401 is
   * retried once when the vault has a newer version of the same login), so
   * it must be able to rebuild its body. Returns undefined when the vault
   * refused before anything was sent (not enrolled, declined, cold,
   * unreachable): the caller treats the account like a row with no token.
   * An error from `dispatch` itself (a transport failure, an abort) is
   * rethrown.
   */
  async send(
    routeId: string,
    dispatch: (
      token: string,
      attempt: ClaustrumScopedAttempt,
    ) => Promise<Response>,
    options: { site: string; signal?: AbortSignal },
  ): Promise<Response | undefined> {
    let dispatched = false
    try {
      return await this.#consumer.send(
        routeId,
        (attempt) => {
          dispatched = true
          return dispatch(attempt.accessToken, attempt)
        },
        {
          site: options.site,
          ...(options.signal ? { signal: options.signal } : {}),
        },
      )
    } catch (error) {
      if (dispatched) throw error
      this.#fail('vault refused to serve an account', error)
      return undefined
    }
  }

  /**
   * Authorizes one send on a vault account for a caller that sends the
   * request itself (OpenCode 2's host does): the receipt holds the token to
   * send with and the record version a 401 on that send is reported
   * against (`reportFailure`). Undefined when the vault refused (not
   * enrolled, declined, cold, unreachable): the caller treats the account
   * like a row with no token. Authorize again for every send; a receipt is
   * never reused.
   */
  async authorize(
    routeId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ClaustrumScopedAttempt | undefined> {
    try {
      return await this.#consumer.authorize(routeId, options.signal)
    } catch (error) {
      this.#fail('vault refused to serve an account', error)
      return undefined
    }
  }

  /**
   * Reports the provider's answer to a send made with `authorize`'s receipt.
   * Only a 401 is reported, against the receipt's record version; anything
   * else is ignored. The roster is re-read afterwards so an account the
   * vault now marks as needing a new login stops routing. Never rejects.
   */
  async reportFailure(
    attempt: ClaustrumScopedAttempt,
    status: number,
  ): Promise<void> {
    if (status !== 401) return
    try {
      await this.#consumer.reportFailure(attempt, 401, 'direct')
    } catch (error) {
      this.#fail('vault failure report failed', error)
    }
    await this.refresh()
  }

  /**
   * Records a quota snapshot (response headers, a WebSocket rate-limit frame,
   * a usage poll) for a vault account, fenced on the account the attempt was
   * served for. Runs in the background; a failure is logged.
   */
  recordSnapshot(
    routeId: string,
    snapshot: unknown,
    complete: boolean,
    attempt?: Pick<ClaustrumScopedAttempt, 'accountIdentity'>,
  ): Promise<void> {
    const observation = observationFromSnapshot(
      snapshot,
      (this.#options.now ?? Date.now)(),
      complete,
    )
    if (!observation) return Promise.resolve()
    return this.#consumer.recordQuota(routeId, observation, attempt).then(
      () => {},
      (error: unknown) => this.#fail('vault quota write failed', error),
    )
  }

  /** Takes one quota reading for a vault account through the usage endpoint. */
  async pollQuota(routeId: string): Promise<{ ok: boolean; error?: string }> {
    let failure: string | undefined
    const fetchImpl = this.#options.fetchImpl?.() ?? globalThis.fetch
    const response = await this.send(
      routeId,
      async (token, attempt) => {
        try {
          const snapshot = await whamUsageFn({
            accessToken: token,
            fetchImpl,
            now: this.#options.now ?? Date.now,
            ...(attempt.accountIdentity
              ? { accountId: attempt.accountIdentity }
              : {}),
            accountKey: routeId,
            logger: log,
          })
          await this.recordSnapshot(routeId, snapshot, true, attempt)
          failure = undefined
          return new Response(null, { status: 200 })
        } catch (error) {
          failure = errorMessage(error)
          const status = (error as { status?: unknown } | null)?.status
          // An HTTP failure is returned as a response so the consumer sees
          // its status and reports a 401 to the vault; an error with no
          // status is a failed reading and is thrown.
          if (typeof status === 'number') return new Response(null, { status })
          throw error
        }
      },
      { site: 'quota' },
    ).catch((error: unknown) => {
      failure = errorMessage(error)
      return undefined
    })
    if (!response) return { ok: false, error: failure ?? 'vault refused' }
    return response.ok
      ? { ok: true }
      : { ok: false, error: failure ?? `status ${response.status}` }
  }

  /**
   * Asks for a quota reading of a vault account that admission refused
   * because it has no reading yet. At most one reading per account is in
   * flight.
   */
  requestReading(routeId: string): void {
    if (this.#pulls.has(routeId)) return
    const pull = this.pollQuota(routeId).finally(() => {
      this.#pulls.delete(routeId)
    })
    this.#pulls.set(routeId, pull)
  }

  /** Readings for the routable vault accounts whose last one is older than `maxAgeMs`. */
  async pollStale(
    maxAgeMs: number,
  ): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
    const now = (this.#options.now ?? Date.now)()
    const results: Array<{ id: string; ok: boolean; error?: string }> = []
    for (const route of this.routes()) {
      const checkedAt = latestReadingAt(route.quota)
      if (checkedAt !== undefined && now - checkedAt < maxAgeMs) continue
      results.push({ id: route.id, ...(await this.pollQuota(route.id)) })
    }
    return results
  }

  /** Declines a vault account: it stays listed and never routes until accepted. */
  async decline(routeId: string): Promise<void> {
    await this.#consumer.decline(routeId)
    log.info('vault account declined', { routeId })
  }

  async accept(routeId: string): Promise<void> {
    await this.#consumer.accept(routeId)
    log.info('vault account accepted', { routeId })
  }

  async status(): Promise<VaultStatus> {
    let enrollment: ClaustrumEnrollmentStatus
    try {
      enrollment = await readClaustrumEnrollmentStatus(this.paths, this.name)
    } catch (error) {
      this.#fail('vault enrollment state unreadable', error)
      enrollment = {
        state: 'blocked',
        proposedName: this.name,
        code:
          error instanceof ClaustrumConsumerError
            ? error.kind
            : 'unreadable-state',
      }
    }
    return {
      host: this.host,
      name: this.name,
      enrollment,
      accounts: this.enrolled() ? (this.snapshot()?.rows ?? []) : [],
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
    }
  }

  /**
   * One step of enrollment: proposes this host to the vault, or polls the
   * proposal already on disk. A denied or blocked request is cleared first,
   * so Connect always starts a usable request.
   */
  async connectStep(): Promise<ClaustrumEnrollmentStatus> {
    const client = await this.#connectEnrollment().catch((error: unknown) => {
      throw new Error(
        `Could not reach the Claustrum vault (${this.#connectionFile()}): ${errorMessage(error)}. Is the vault running?`,
      )
    })
    try {
      const manager = new ClaustrumEnrollmentManager({
        client,
        paths: this.paths,
        proposedName: this.name,
        ...(this.#options.now ? { now: this.#options.now } : {}),
      })
      const current = await manager.status()
      if (current.state === 'denied' || current.state === 'blocked')
        await manager.resetTerminal()
      const status = await manager.reconcile()
      log.info('vault enrollment step', {
        host: this.host,
        state: status.state,
      })
      if (status.state === 'approved') {
        this.#lastError = undefined
        await this.refresh()
      }
      return status
    } finally {
      client.close()
    }
  }

  /**
   * Polls the enrollment until the operator approves or denies it, or until
   * `timeoutMs`. One wait runs at a time; a second caller shares it.
   */
  waitForApproval(
    options: VaultWaitOptions = {},
  ): Promise<ClaustrumEnrollmentStatus> {
    this.#waiting ??= (async () => {
      const sleep =
        options.sleep ??
        ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
      const interval = options.pollIntervalMs ?? 2_000
      const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000)
      let status = await this.connectStep()
      while (status.state === 'pending' || status.state === 'busy') {
        options.onPending?.(status)
        if (Date.now() >= deadline) return status
        await sleep(interval)
        status = await this.connectStep()
      }
      return status
    })().finally(() => {
      this.#waiting = undefined
    })
    return this.#waiting
  }

  /**
   * Forgets this host's enrollment: its token and ceremony state are
   * deleted, and the vault accounts stop routing at once. The roster (the
   * declined accounts and their quota) is kept for a later Connect. The
   * enrollment itself stays approved in the vault until the operator revokes
   * it there.
   */
  async disconnect(): Promise<void> {
    await rm(this.paths.tokenPath, { force: true })
    await rm(this.paths.statePath, { force: true })
    await this.#consumer.refresh().catch(() => undefined)
    this.#lastError = undefined
    log.info('vault enrollment forgotten', { host: this.host })
  }

  /**
   * Refuses a real login in the host's own slot while the vault serves this
   * host's accounts: serving either one would silently pick one of two
   * accounts the user may not mean. The pool placeholder and the old
   * tombstone are not logins and must be screened out by the caller.
   */
  assertHostSlot(auth: unknown): void {
    if (this.serves())
      assertHostSlotMatchesMode({ mode: 'custody', auth, provider: 'openai' })
  }

  close(): void {
    this.#consumer.close()
  }
}

function latestReadingAt(quota: QuotaMap | undefined): number | undefined {
  if (!quota) return undefined
  const times = projectQuota(quota).limits.map((limit) => limit.checkedAt)
  return times.length > 0 ? Math.max(...times) : undefined
}

/** The `ck` (Claustrum CLI) commands that approve a pending enrollment, line by line. */
export function vaultApprovalInstructions(
  name: string,
  status: ClaustrumEnrollmentStatus,
): string[] {
  if (status.state !== 'pending') return []
  if (!status.requestId)
    return [
      `The vault did not take the enrollment request yet${status.retryCode ? ` (${status.retryCode})` : ''}. Run Connect again in a moment.`,
    ]
  return [
    `Enrollment request ${status.requestId} for ${name} is waiting for approval. Approve it with:`,
    `  ck auth enroll approve --request-id ${status.requestId}`,
    `and let it read your OpenAI accounts with:`,
    `  ck auth grant --principal enrolled:${name} --selector-kind category --selector ${VAULT_FAMILY.category} --operation read`,
  ]
}

/** One line for an enrollment status. */
export function vaultEnrollmentLine(
  host: VaultHost,
  name: string,
  status: ClaustrumEnrollmentStatus,
): string {
  const who = `${HOST_NAMES[host]} (${name})`
  switch (status.state) {
    case 'approved':
      return `${who}: connected to the Claustrum vault.`
    case 'idle':
      return `${who}: not connected to the Claustrum vault.`
    case 'pending':
      return status.requestId
        ? `${who}: waiting for approval of request ${status.requestId}.`
        : `${who}: enrollment request not taken yet${status.retryCode ? ` (${status.retryCode})` : ''}.`
    case 'denied':
      return `${who}: the vault denied the enrollment request.`
    case 'blocked':
      return `${who}: enrollment stopped (${status.code}).`
    case 'unavailable':
      return `${who}: the vault is unavailable (${status.code}).`
    case 'busy':
      return `${who}: another process is enrolling right now.`
  }
}

/** The outcome of a finished (or abandoned) wait, for the operator. */
export function vaultConnectOutcome(
  vault: Pick<OpenAiVault, 'name' | 'routes' | 'snapshot'>,
  status: ClaustrumEnrollmentStatus,
): { ok: boolean; text: string } {
  switch (status.state) {
    case 'approved': {
      const accounts = vault.snapshot()?.rows.length ?? 0
      return {
        ok: true,
        text: `Connected: the vault approved ${vault.name}. It serves ${accounts} OpenAI account${accounts === 1 ? '' : 's'} to this host${accounts === 0 ? ' (grant it the openai-native category with `ck auth grant` to add some)' : ''}.`,
      }
    }
    case 'denied':
      return {
        ok: false,
        text: 'The vault denied the enrollment request. Run Connect again to send a new one.',
      }
    case 'blocked':
      return {
        ok: false,
        text: `Enrollment stopped (${status.code}). Run Connect again to send a new request.`,
      }
    case 'pending':
    case 'busy':
      return {
        ok: false,
        text: [
          ...vaultApprovalInstructions(vault.name, status),
          'Still waiting. The request stays open: run Connect again after approving it.',
        ].join('\n'),
      }
    default:
      return { ok: false, text: `Enrollment is ${status.state}.` }
  }
}

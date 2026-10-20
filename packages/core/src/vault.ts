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
 * Once enrolled (vault mode), the OpenAI credentials the vault lets this host
 * read are the only accounts the host routes (`routes()`): no local pool row,
 * login slot or native login is used, refreshed or polled until the host
 * disconnects. A vault row never holds a token: while the vault is
 * reachable each send asks it for one (`send`), deliberately without a
 * cache, so a revoked enrollment or a changed record takes effect on the
 * next request. Only while the vault cannot be reached does the shared
 * consumer reuse the token it last served each account, in memory. A 401 on a
 * served credential is reported to the vault with the exact record version
 * that send used; nothing else is reported. Vault quota lives in the roster
 * file next to the token, not in the account store.
 */
import { statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveClaustrumConnectionPath } from '@cortexkit/claustrum-client'
import {
  assertHostSlotMatchesMode,
  ClaustrumConsumer,
  ClaustrumConsumerError,
  type ClaustrumConsumerOptions,
  type ClaustrumEnrollmentConnection,
  ClaustrumEnrollmentManager,
  type ClaustrumEnrollmentPaths,
  type ClaustrumEnrollmentStatus,
  type ClaustrumFamily,
  type ClaustrumScopedAttempt,
  type ClaustrumScopedClient,
  type ClaustrumWatchState,
  connectClaustrumEnrollmentClient,
  connectClaustrumScopedClient,
  enrollmentAuthority,
  enrollmentName,
  hostEnrollmentPaths,
  type KeptReceiptState,
  type QuotaReceipt,
  readClaustrumEnrollmentStatus,
  readVaultRoster,
  type VaultGrantReach,
  type VaultRosterFile,
  type VaultRosterRow,
} from '@cortexkit/common-auth/claustrum'
import { CommandError } from '@cortexkit/common-auth/commands'
import { projectQuota, type QuotaMap } from '@cortexkit/common-auth/quota'
import { normalizeInsulaCodexQuota } from './insula-quota'
import { createLogger } from './logger'
import { extractAccountIdFromClaims, parseJwtClaims } from './oauth'
import { observationFromSnapshot } from './pool-quota'
import type { QuotaReadingRequest } from './pool-routing'
import { whamUsageFn } from './provider'
import { errorMessage } from './util/error'
import {
  VAULT_RECLASSIFY_COMMAND,
  vaultEmptyAccessHint,
  vaultGrantCommand,
} from './vault-messages'

const log = createLogger('vault')

type VaultQuotaSource = 'insula' | 'fallback'
type VaultQuotaSourceReason =
  | 'account-changed'
  | 'insula-not-configured'
  | 'insula-unusable'
  | 'no-insula-reading'
  | 'cold'
  | 'upstream-failed'
  | null

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

/**
 * Longest a request waits for the vault's first account list in vault mode
 * before it is refused (the vault is then treated as unreachable).
 */
export const VAULT_REQUEST_ROSTER_WAIT_MS = 2_000

/**
 * Why a request was refused in vault mode, where only vault accounts may
 * serve. `vault-no-grant` and `vault-grant-unreached` split `vault-empty`
 * when the vault reports this host's grants and lists no account at all:
 * no grant exists, or the grant matches no login.
 */
export type VaultModeRefusal =
  | 'vault-unreachable'
  | 'vault-empty'
  | 'vault-no-grant'
  | 'vault-grant-unreached'
  | 'vault-refused'

/** Every vault-mode refusal cause, for telling them from a host's own causes. */
export const VAULT_MODE_REFUSAL_CAUSES: readonly VaultModeRefusal[] = [
  'vault-unreachable',
  'vault-empty',
  'vault-no-grant',
  'vault-grant-unreached',
  'vault-refused',
]

/**
 * The fixed texts of a vault-mode refusal, shared by every host. Hosts decide
 * whether to retry a failed request by matching its error message (OpenCode's
 * retry patterns look for words such as "rate limit", "timeout" or
 * "connection refused"), so these never carry an account id or any word that
 * would make the refusal look temporary. `vault-no-grant` is missing here
 * because its text names the host's enrollment; see `vaultModeRefusalText`.
 */
export const VAULT_MODE_REFUSALS: Record<
  Exclude<VaultModeRefusal, 'vault-no-grant'>,
  string
> = {
  'vault-unreachable':
    'Request refused locally: this host is connected to the credential vault, which could not be reached, and local accounts are not used while it is connected. Start the vault and connect accounts in it, or disconnect this host from the vault.',
  'vault-empty':
    'Request refused locally: this host is connected to the credential vault, which serves it no usable OpenAI account, and local accounts are not used while it is connected. Connect accounts in the vault, or disconnect this host from the vault.',
  'vault-grant-unreached': `Request refused locally: this host is connected to the credential vault, whose grant for it reaches no ChatGPT login, and local accounts are not used while it is connected. Logins without the openai-native category are not reached: run ${VAULT_RECLASSIFY_COMMAND} to fill empty category sets, then check the CATEGORIES column with ck auth status. Or disconnect this host from the vault.`,
  'vault-refused':
    'Request refused locally: the credential vault did not authorize an account, and local accounts are not used while this host is connected to it. Check the accounts in the vault, or disconnect this host from the vault.',
}

/**
 * The refusal text for a cause. Only `vault-no-grant` depends on the host: it
 * prints the grant command for this host's enrollment name (`vault.name`).
 * Like every refusal it carries no account label or id.
 */
export function vaultModeRefusalText(
  cause: VaultModeRefusal,
  name: string,
): string {
  if (cause !== 'vault-no-grant') return VAULT_MODE_REFUSALS[cause]
  return `Request refused locally: this host is connected to the credential vault, which has no grant letting it read OpenAI accounts, and local accounts are not used while it is connected. Disconnect this host from the vault, or grant it access with: ${vaultGrantCommand(name)}`
}

/**
 * The refusal for a vault-mode request that found no vault account to try:
 * unreachable while the vault has not listed its accounts in this process.
 * When the vault lists no account at all and reports this host's grants, the
 * cause is named exactly (no grant, or a grant that reaches no login); a
 * vault that does not report grants, or a list whose accounts are all
 * declined or unusable, is empty.
 */
export function vaultModeNoRouteCause(
  vault: Pick<OpenAiVault, 'snapshot' | 'grantReach'>,
): Exclude<VaultModeRefusal, 'vault-refused'> {
  const roster = vault.snapshot()
  if (roster === undefined) return 'vault-unreachable'
  if (roster.rows.length === 0) {
    const reach = vault.grantReach()
    if (reach !== undefined)
      return reach.grants === 0 ? 'vault-no-grant' : 'vault-grant-unreached'
  }
  return 'vault-empty'
}

/** The ChatGPT account a served access token signs in as, read from its claims. */
export function vaultIdentityOf(accessToken: string): string | undefined {
  const claims = parseJwtClaims(accessToken)
  return claims ? extractAccountIdFromClaims(claims) : undefined
}

/** One vault account as routing sees it. */
export interface VaultRoute {
  id: string
  /** The vault credential name, distinct from its stable routing id. */
  credentialId?: string
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
  /**
   * Replace the timers behind the background poll, the vault and insula
   * watches' retries and the outage probe (tests).
   */
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
}

type VaultInsulaQuota = NonNullable<
  ReturnType<typeof normalizeInsulaCodexQuota>
>

/**
 * The shared consumer, reporting every roster discovery to `onDiscovery`.
 * Its own poll, its vault watch and its send path all start discoveries by
 * calling `refresh()` on the instance, so overriding it here sees each one,
 * including those `OpenAiVault` did not start itself.
 */
class ObservedConsumer extends ClaustrumConsumer<VaultInsulaQuota> {
  readonly #onDiscovery: (
    discovery: Promise<VaultRosterFile | undefined>,
  ) => void

  constructor(
    options: ClaustrumConsumerOptions<VaultInsulaQuota>,
    onDiscovery: (discovery: Promise<VaultRosterFile | undefined>) => void,
  ) {
    super(options)
    this.#onDiscovery = onDiscovery
  }

  override refresh(): Promise<VaultRosterFile | undefined> {
    const discovery = super.refresh()
    this.#onDiscovery(discovery)
    return discovery
  }
}

/** One host's view of its OpenAI accounts in the vault. */
export class OpenAiVault {
  readonly host: VaultHost
  readonly name: string
  readonly paths: VaultPaths
  readonly #options: OpenAiVaultOptions
  readonly #consumer: ObservedConsumer
  readonly #pulls = new Map<string, Promise<unknown>>()
  readonly #quotaPolls = new Map<
    string,
    Promise<{ ok: boolean; error?: string }>
  >()
  readonly #lastQuotaSource = new Map<
    string,
    { source: VaultQuotaSource; reason: VaultQuotaSourceReason }
  >()
  #consumerHasInsula: boolean | undefined
  #lastError: string | undefined
  #waiting: Promise<ClaustrumEnrollmentStatus> | undefined
  /**
   * The roster discovery the consumer has in flight, if any, whoever started
   * it: this class, the consumer's poll, its vault watch or a send.
   */
  #discovery: Promise<VaultRosterFile | undefined> | undefined
  #polling = false
  #closed = false
  /** Settles once this instance's first roster discovery has, either way. */
  readonly #firstRoster = Promise.withResolvers<void>()
  #authority: 'vault' | 'local' | 'unreadable' | 'unknown' = 'unknown'
  #authorityKey: string | undefined

  constructor(options: OpenAiVaultOptions) {
    this.#options = options
    this.host = options.host
    this.name = vaultEnrollmentName(options.host)
    this.paths = vaultPaths(options.stateDir, options.host)
    this.#consumer = new ObservedConsumer(
      {
        rosterPath: this.paths.rosterPath,
        tokenPath: this.paths.tokenPath,
        family: VAULT_FAMILY,
        connect: () => this.#connectScoped(),
        // Unknown or unreadable enrollment must never enable local credentials.
        isCustodyActive: () => this.#custodyActive(),
        ...(options.reservedRouteIds
          ? { reservedRouteIds: options.reservedRouteIds }
          : {}),
        parseIdentity: vaultIdentityOf,
        insula: { provider: 'codex', normalize: normalizeInsulaCodexQuota },
        ...(options.now ? { now: options.now } : {}),
        ...(options.pollIntervalMs !== undefined
          ? { pollIntervalMs: options.pollIntervalMs }
          : {}),
        ...(options.setTimeoutImpl
          ? { setTimeoutImpl: options.setTimeoutImpl }
          : {}),
        ...(options.clearTimeoutImpl
          ? { clearTimeoutImpl: options.clearTimeoutImpl }
          : {}),
        onRoster: () => {
          this.#lastError = undefined
        },
        onError: (error) => this.#fail('vault roster refresh failed', error),
        logger: {
          ...log,
          warn: (message, fields) => {
            // The route-aware background source log below includes these skips.
            if (message !== 'skipped insula provider poll')
              log.warn(message, fields)
          },
        },
      },
      (discovery) => this.#track(discovery),
    )
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
    ).then((client) => {
      this.#consumerHasInsula = client.insula !== undefined
      return client
    })
  }

  #logQuotaSource(
    routeId: string,
    source: VaultQuotaSource,
    reason: VaultQuotaSourceReason,
  ): void {
    const previous = this.#lastQuotaSource.get(routeId)
    if (previous?.source === source && previous.reason === reason) return
    this.#lastQuotaSource.set(routeId, { source, reason })
    log.info('vault background quota source changed', {
      routeId,
      source,
      reason,
    })
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

  #enrollmentKey(): string {
    return [this.paths.tokenPath, this.paths.statePath]
      .map((path) => {
        try {
          const stat = statSync(path)
          return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
        } catch {
          return '?'
        }
      })
      .join('|')
  }

  /** Read enrollment files before a request, menu action or background pass, using common-auth's mode rules. */
  async authority(): Promise<'vault' | 'local' | 'unreadable'> {
    const key = this.#enrollmentKey()
    const mode = await enrollmentAuthority(this.paths, this.name)
    if (key === this.#enrollmentKey()) {
      this.#authority = mode
      this.#authorityKey = key
      return mode
    }
    return 'unreadable'
  }

  /**
   * Callbacks that cannot await use the last authority value only while the
   * enrollment files are unchanged. Before the first read, or after a change,
   * local token refreshes, quota polls and account writes are blocked.
   * Requests and menus await authority() instead of trusting the cached value.
   */
  enrolled(): boolean {
    return (
      this.#authorityKey !== this.#enrollmentKey() ||
      this.#authority !== 'local'
    )
  }

  /**
   * The consumer's mode check, run before each of its discoveries, sends and
   * quota reads. The enrollment files are read again only when they changed
   * since the last read, so a new enrollment or a disconnect made by another
   * process applies on the consumer's next poll.
   */
  async #custodyActive(): Promise<boolean> {
    if (this.#authorityKey !== this.#enrollmentKey()) await this.authority()
    return this.enrolled()
  }

  /**
   * Starts the consumer's background poll and its vault and insula watches.
   * With local authority the consumer sends no vault request. A new
   * enrollment completed by another process is detected on the next poll.
   * While the vault watch is open the poll lists the vault only every five
   * minutes, and a notice that the visible accounts changed starts a
   * discovery at once; without a watch (an older vault or client, or a
   * refusal) every poll lists the vault as before.
   */
  start(): void {
    if (this.#polling || this.#closed) return
    this.#polling = true
    this.#consumer.start()
  }

  /**
   * Remembers a discovery the consumer reports, so `refresh` can wait out one
   * that was already running when it was called, and `firstRoster` settles
   * once the first one ends.
   */
  #track(discovery: Promise<VaultRosterFile | undefined>): void {
    if (this.#discovery === discovery) return
    this.#discovery = discovery
    discovery
      .finally(() => {
        if (this.#discovery === discovery) this.#discovery = undefined
        this.#firstRoster.resolve()
      })
      .catch(() => {})
  }

  /**
   * One roster discovery through the consumer, shared by every caller that
   * arrives while it runs (the consumer coalesces them).
   */
  #discover(): Promise<VaultRosterFile | undefined> {
    return this.#consumer.refresh()
  }

  /**
   * Resolves once this instance's first roster discovery has ended, whether
   * it read the vault or failed, or once the instance is closed. Never
   * rejects. A vault-mode request waits for it, bounded by
   * `VAULT_REQUEST_ROSTER_WAIT_MS`.
   */
  firstRoster(): Promise<void> {
    return this.#firstRoster.promise
  }

  /**
   * Readies a current vault roster before request routing. The startup
   * discovery may have settled while this host was local, so firstRoster()
   * alone cannot tell a vault-mode request that it has a roster to use.
   */
  async awaitRequestRoster(): Promise<void> {
    if (this.snapshot()) return
    if ((await this.authority()) !== 'vault') return

    const inFlight = this.#discovery
    if (inFlight) await inFlight.catch(() => undefined)

    if (this.snapshot() || (await this.authority()) !== 'vault') return

    const discovery = this.#discovery ?? this.#discover()
    await discovery.catch((error: unknown) => {
      this.#fail('vault roster refresh failed', error)
    })
  }

  /**
   * Re-reads the accounts from the vault now. Never rejects. It resolves only
   * after a discovery that began after this call: one already in flight (the
   * poll, or a refresh another caller started) may have read the enrollment
   * and the vault before what this caller just changed, so it is waited out
   * and a new one runs. Callers that arrive while that new one runs share it.
   */
  async refresh(): Promise<VaultRosterFile | undefined> {
    try {
      await this.authority()
      const earlier = this.#discovery
      if (earlier) await earlier.catch(() => undefined)
      const roster = await this.#discover()
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

  /**
   * Whether the consumer learns about vault and insula changes from a watch
   * or by polling, without any I/O.
   */
  watchState(): ClaustrumWatchState {
    return this.#consumer.watchState()
  }

  /**
   * Whether any account is being served the last token the vault gave it
   * because the vault cannot be reached, without any I/O.
   */
  keptReceiptState(): KeptReceiptState {
    return this.#consumer.keptReceiptState()
  }

  /**
   * What the vault says this host is granted, from the latest list, without
   * any I/O. Undefined is unknown (a vault that does not report grants, or
   * nothing listed yet), never zero grants.
   */
  grantReach(): VaultGrantReach | undefined {
    return this.#consumer.grantReach()
  }

  /** Whether the vault serves this host any account (whatever its state). */
  serves(): boolean {
    return this.enrolled() && (this.snapshot()?.rows.length ?? 0) > 0
  }

  /**
   * The ChatGPT accounts the vault holds for this host, declined and cold
   * ones included. Empty unless this host is enrolled; while it is, no local
   * row is used at all (vault mode), so this only names which vault account
   * a set-aside local row belongs to.
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
        credentialId: rows.get(routing.id)?.credentialId,
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
   * a usage poll) for a vault account. `receipt` is what the send that
   * produced the reading was served with (its credential id and the account
   * it was bound to, and how that account was known); the reading is kept
   * only while the route still holds that credential and account, so a
   * reading taken before the vault replaced the account is dropped. Runs in
   * the background; a failure is logged.
   */
  recordSnapshot(
    routeId: string,
    snapshot: unknown,
    complete: boolean,
    receipt: QuotaReceipt,
  ): Promise<void> {
    const observation = observationFromSnapshot(
      snapshot,
      (this.#options.now ?? Date.now)(),
      complete,
    )
    if (!observation) return Promise.resolve()
    return this.#consumer.recordQuota(routeId, observation, receipt).then(
      () => {},
      (error: unknown) => this.#fail('vault quota write failed', error),
    )
  }

  /** Joins a quota poll; insula decides whether a background provider read is needed. */
  pollQuota(
    routeId: string,
    background = true,
  ): Promise<{ ok: boolean; error?: string }> {
    const pending = this.#quotaPolls.get(routeId)
    if (pending) return pending
    const pull = this.#pollQuota(routeId, background).finally(() => {
      this.#quotaPolls.delete(routeId)
    })
    this.#quotaPolls.set(routeId, pull)
    return pull
  }

  async #pollQuota(
    routeId: string,
    background: boolean,
  ): Promise<{ ok: boolean; error?: string }> {
    if (background) {
      await this.authority()
      await this.#consumer.refreshInsulaQuota()
      const row = (await readVaultRoster(this.paths.rosterPath))?.rows.find(
        (row) => row.routeId === routeId,
      )
      let fallback: { ok: boolean; error?: string } | undefined
      const cached = await this.#consumer.pollInsulaQuotaForRoute(
        routeId,
        async () => {
          this.#logQuotaSource(
            routeId,
            'fallback',
            this.#consumerHasInsula === false
              ? 'insula-not-configured'
              : 'no-insula-reading',
          )
          fallback = await this.#pollProviderQuota(routeId, background)
          return undefined
        },
      )
      if (fallback) return fallback
      if (cached !== undefined && row?.accountIdentity) {
        const observation = observationFromSnapshot(
          cached,
          cached.primary.checkedAt,
          true,
        )
        if (!observation) {
          this.#logQuotaSource(routeId, 'fallback', 'insula-unusable')
          return { ok: false, error: 'unusable insula reading' }
        }
        const kept = await this.#consumer.recordAccountQuota(
          routeId,
          row.accountIdentity,
          observation,
        )
        if (kept) {
          this.#logQuotaSource(routeId, 'insula', null)
          return { ok: true }
        }
        this.#logQuotaSource(routeId, 'fallback', 'account-changed')
        return { ok: false, error: 'vault account changed' }
      }
      // When insula skips this background poll, do not fall back to a provider read.
      const { miss } = await this.#consumer.lookupInsulaQuotaForRoute(routeId)
      const reason =
        miss === 'cold' || miss === 'upstream-failed'
          ? miss
          : 'no-insula-reading'
      this.#logQuotaSource(routeId, 'insula', reason)
      return { ok: false, error: `insula ${reason}` }
    }
    return this.#pollProviderQuota(routeId, background)
  }

  async #pollProviderQuota(
    routeId: string,
    background: boolean,
  ): Promise<{ ok: boolean; error?: string }> {
    let failure: string | undefined
    const fetchImpl = this.#options.fetchImpl?.() ?? globalThis.fetch
    const response = await this.send(
      routeId,
      async (token, attempt) => {
        try {
          const cached = background
            ? undefined
            : await this.#consumer.cachedInsulaQuota(attempt)
          if (cached !== undefined) {
            const observation = observationFromSnapshot(
              cached,
              cached.primary.checkedAt,
              true,
            )
            if (!observation) throw new Error('unusable insula reading')
            await this.#consumer.recordQuota(routeId, observation, attempt)
            return new Response(null, { status: 200 })
          }
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
  requestReading(routeId: string): ReturnType<QuotaReadingRequest> {
    const pending = this.#pulls.get(routeId)
    if (pending) return pending
    const pull = this.pollQuota(routeId, false)
      .catch((error: unknown) => {
        log.warn('vault quota poll failed', {
          routeId,
          error: errorMessage(error),
        })
      })
      .finally(() => {
        this.#pulls.delete(routeId)
      })
    this.#pulls.set(routeId, pull)
    return pull
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
    await this.authority()
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
      // A CommandError, so the `/openai` menu's Connect shows this message
      // (the menu shows a generic line for any other thrown error).
      throw new CommandError(
        'vault-unreachable',
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
    await this.authority()
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
    this.#closed = true
    this.#firstRoster.resolve()
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
  vault: Pick<OpenAiVault, 'name' | 'routes' | 'snapshot' | 'grantReach'>,
  status: ClaustrumEnrollmentStatus,
): { ok: boolean; text: string } {
  switch (status.state) {
    case 'approved': {
      const accounts = vault.snapshot()?.rows.length ?? 0
      return {
        ok: true,
        text: `Connected: the vault approved ${vault.name}. It serves ${accounts} OpenAI account${accounts === 1 ? '' : 's'} to this host${accounts === 0 ? `. ${vaultEmptyAccessHint(vault.name, vault.grantReach())}` : '.'}`,
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

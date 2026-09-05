import {
  SubcCallError,
  SubcClient,
  type BindIdentity,
} from '@cortexkit/subc-client'
import { resolveClaustrumConnectionPath } from './detect.js'
import {
  asCredentialError,
  ClaustrumCredentialError,
  hasCredentialError,
} from './errors.js'
import { storeIdentity } from './identity.js'

const CLAUSTRUM_MODULE_ID = 'claustrum'
const RECONNECT_BACKOFF_MS = 60_000

type ClaustrumTransport = Pick<SubcClient, 'call' | 'close'>

export type ClaustrumConnector = (options: {
  connectionFile: string
  handshakeTimeoutMs?: number
}) => Promise<SubcClient>

export type ClaustrumClientOptions = {
  connectionFile?: string
  handshakeTimeoutMs?: number
  projectRoot?: string
  storagePath?: string
  identity?: BindIdentity
  connector?: ClaustrumConnector
  logger?: (errorClass: string) => void
}

export type ServedCredential = {
  material: string
  recordVersion: number
  expiresAtMs: number | null
}

export type CredentialStatus = {
  ready: boolean
  lastErrorCode: string | null
  leaseHeld: boolean
  recordVersion: number
  stalePending?: boolean
}

export type ClaustrumReporterSource =
  | 'direct'
  | 'relay_status_field'
  | 'relay_message_parse'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecordVersion(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function decodeCredential(response: unknown, logUnknownClass: (errorClass: string) => void): ServedCredential {
  if (hasCredentialError(response)) throw asCredentialError(response, 'invalid_response', logUnknownClass)
  const result = isRecord(response) && isRecord(response.result) ? response.result : undefined
  const payload = result?.payload
  if (
    !Array.isArray(payload) ||
    payload.length === 0 ||
    !payload.every((value) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255)
  ) {
    throw asCredentialError(response, 'invalid_response', logUnknownClass)
  }
  const recordVersion = asRecordVersion(result?.record_version)
  if (recordVersion === undefined) {
    throw asCredentialError(response, 'invalid_record_version', logUnknownClass)
  }
  const rawExpiresAtMs = result?.expires_at_ms
  const expiresAtMs =
    rawExpiresAtMs === undefined || rawExpiresAtMs === null
      ? null
      : typeof rawExpiresAtMs === 'number' && Number.isFinite(rawExpiresAtMs)
        ? rawExpiresAtMs
        : undefined
  if (expiresAtMs === undefined) {
    throw asCredentialError(response, 'invalid_expiry', logUnknownClass)
  }
  return {
    material: new TextDecoder().decode(Uint8Array.from(payload)),
    recordVersion,
    expiresAtMs,
  }
}

function decodeStatus(response: unknown, logUnknownClass: (errorClass: string) => void): CredentialStatus {
  if (hasCredentialError(response)) throw asCredentialError(response, 'invalid_response', logUnknownClass)
  const result = isRecord(response) && isRecord(response.result) ? response.result : undefined
  const recordVersion = asRecordVersion(result?.record_version)
  if (
    typeof result?.ready !== 'boolean' ||
    (result?.last_error_code !== undefined && result?.last_error_code !== null && typeof result?.last_error_code !== 'string') ||
    typeof result?.lease_held !== 'boolean' ||
    recordVersion === undefined ||
    (result?.stale_pending !== undefined && typeof result.stale_pending !== 'boolean')
  ) {
    throw asCredentialError(response, 'invalid_status', logUnknownClass)
  }
  return {
    ready: result.ready,
    lastErrorCode: result.last_error_code ?? null,
    leaseHeld: result.lease_held,
    recordVersion,
    ...(result.stale_pending === undefined ? {} : { stalePending: result.stale_pending }),
  }
}

export class ClaustrumClient {
  #client: ClaustrumTransport
  readonly #connector: ClaustrumConnector
  readonly #connectionFile: string
  readonly #handshakeTimeoutMs?: number
  readonly #identity: BindIdentity
  readonly #logger: (errorClass: string) => void
  #reconnecting: Promise<void> | null = null
  #nextReconnectAt = 0
  #closed = false

  private constructor(
    client: ClaustrumTransport,
    connector: ClaustrumConnector,
    connectionFile: string,
    handshakeTimeoutMs: number | undefined,
    identity: BindIdentity,
    logger: (errorClass: string) => void,
  ) {
    this.#client = client
    this.#connector = connector
    this.#connectionFile = connectionFile
    this.#handshakeTimeoutMs = handshakeTimeoutMs
    this.#identity = identity
    this.#logger = logger
  }

  static async connect(options: ClaustrumClientOptions = {}): Promise<ClaustrumClient> {
    const connectionFile = resolveClaustrumConnectionPath(options.connectionFile)
    const connector = options.connector ?? ((connectOptions) => SubcClient.connect(connectOptions))
    const identity = options.identity ?? storeIdentity(
      options.projectRoot ?? process.cwd(),
      options.storagePath ?? process.cwd(),
    )
    const client = await connector({
      connectionFile,
      handshakeTimeoutMs: options.handshakeTimeoutMs,
    })
    return new ClaustrumClient(
      client,
      connector,
      connectionFile,
      options.handshakeTimeoutMs,
      identity,
      options.logger ?? ((errorClass) => console.warn(errorClass)),
    )
  }

  async getCredential(handle: string, minTtlMs?: number): Promise<ServedCredential> {
    const response = await this.#call('credential.get', {
      handle,
      min_ttl_ms: minTtlMs,
      force_refresh: false,
    })
    return decodeCredential(response, this.#logger)
  }

  async statusCredential(handle: string): Promise<CredentialStatus> {
    const response = await this.#call('credential.status', { handle })
    return decodeStatus(response, this.#logger)
  }

  async reportAuthFailure(input: {
    handle: string
    providerStatus: number
    recordVersion: number
    reporterSource: ClaustrumReporterSource
  }): Promise<void> {
    const response = await this.#call('credential.report_auth_failure', {
      handle: input.handle,
      provider_status: input.providerStatus,
      record_version: input.recordVersion,
      reporter_source: input.reporterSource,
    })
    if (hasCredentialError(response)) throw asCredentialError(response, 'invalid_response', this.#logger)
    const result = isRecord(response) && isRecord(response.result) ? response.result : undefined
    if (result?.accepted !== true) throw asCredentialError(response, 'invalid_response', this.#logger)
  }

  close(): void {
    this.#closed = true
    this.#client.close()
  }

  async #call(method: string, params: unknown): Promise<unknown> {
    try {
      return await this.#client.call(CLAUSTRUM_MODULE_ID, method, params, {
        identity: this.#identity,
        consumerIdentity: null,
      })
    } catch (error) {
      if (this.#shouldReconnect(error)) {
        try {
          await this.#reconnect()
        } catch (reconnectError) {
          throw this.#asTransportError(reconnectError)
        }
        try {
          return await this.#client.call(CLAUSTRUM_MODULE_ID, method, params, {
            identity: this.#identity,
            consumerIdentity: null,
          })
        } catch (retryError) {
          throw this.#asTransportError(retryError)
        }
      }
      throw this.#asTransportError(error)
    }
  }

  #asTransportError(error: unknown): ClaustrumCredentialError {
    if (error instanceof ClaustrumCredentialError) return error
    const code = error instanceof SubcCallError && error.code ? error.code : 'transport_error'
    return new ClaustrumCredentialError(code, 'transient', 'retry')
  }

  #shouldReconnect(error: unknown): boolean {
    return (
      !this.#closed &&
      error instanceof SubcCallError &&
      error.kind === 'terminal' &&
      error.code !== 'missing_identity' &&
      error.code !== 'invalid_control_body'
    )
  }

  async #reconnect(): Promise<void> {
    if (this.#closed) throw new Error('Claustrum client is closed')
    if (this.#reconnecting) {
      await this.#reconnecting
      return
    }
    const now = Date.now()
    if (now < this.#nextReconnectAt) throw new Error('Claustrum client reconnect is backed off')
    this.#nextReconnectAt = now + RECONNECT_BACKOFF_MS
    this.#reconnecting = this.#connector({
      connectionFile: this.#connectionFile,
      handshakeTimeoutMs: this.#handshakeTimeoutMs,
    })
      .then((client) => {
        if (this.#closed) {
          client.close()
          throw new Error('Claustrum client is closed')
        }
        const previous = this.#client
        this.#client = client
        previous.close()
      })
      .finally(() => {
        this.#reconnecting = null
      })
    await this.#reconnecting
  }
}

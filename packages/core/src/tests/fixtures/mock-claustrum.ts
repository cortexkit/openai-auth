// A Claustrum daemon stand-in speaking the real subc wire protocol, so the
// real `@cortexkit/claustrum-client` is driven over a socket. Copied from
// `@cortexkit/common-auth`'s own tests (test/claustrum/mock-daemon.ts at
// 0.2.9), which ported it from anthropic-auth's end-to-end mock, with this
// plugin's defaults: OpenAI credentials are the `openai` adapter's, granted
// under the `openai-native` category. Shared by the OpenCode and Pi tests.
import { createHash } from 'node:crypto'
import { chmod, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname, join } from 'node:path'

// subc-client is the claustrum client's own transport and is not a direct
// dependency here, so resolve it from the client's location.
interface SubcWire {
  buildFlags(binary: boolean, priority: number, subscription: boolean): number
  buildFrame(
    type: number,
    flags: number,
    channel: number,
    epoch: number,
    corr: bigint,
    body: Uint8Array,
  ): unknown
  computeProof(
    key: Uint8Array,
    domain: Uint8Array | string,
    clientNonce: Uint8Array,
    serverNonce: Uint8Array,
    daemonId: Uint8Array,
  ): Uint8Array
  decodeHeader(bytes: Uint8Array): {
    ty: number
    len: number
    channel: number
    epoch: number
    corr: bigint
  }
  encodeFrame(frame: unknown): Uint8Array
  FrameType: { Request: number; Response: number; Error: number }
  HEADER_LEN: number
  PROTOCOL_VERSION: number
  Priority: { Interactive: number }
  SERVER_PROOF_DOMAIN: Uint8Array | string
}

const clientEntry = Bun.resolveSync(
  '@cortexkit/claustrum-client',
  import.meta.dir,
)
const subc = (await import(
  Bun.resolveSync('@cortexkit/subc-client', dirname(clientEntry))
)) as SubcWire

const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
const daemonId = Uint8Array.from({ length: 16 }, (_, index) => 200 + index)

export interface MockCredential {
  payload: string
  account_id?: string
  record_version: number
  expires_at_ms: number | null
  state?: string
  type?: 'oauth' | 'api_key'
  /** null removes the field, as for a static key. */
  refresh_adapter?: string | null
  categories?: string[]
  operations?: string[]
  /** Extra or replacement wire fields for the inventory row. */
  wire?: Record<string, unknown>
  /** get_scoped refuses with this code while set. */
  refuse?: string
  /** Served identity when it differs from the listed one; null omits it. */
  served_account_id?: string | null
}

export interface MockReport {
  credential_id?: string
  enrollment_token?: string
  provider_status?: number
  record_version?: number
  reporter_source?: string
}

export interface MockDaemon {
  connectionFile: string
  credentials: Record<string, MockCredential>
  gets: Array<{ credential_id?: string; enrollment_token?: string }>
  reports: MockReport[]
  proposals: Array<{ name?: string; hash?: string }>
  polls: number
  lists: number
  onReport?: (report: MockReport) => void
  approve(requestId: string, token?: string, generation?: number): void
  deny(requestId: string): void
  stop(): Promise<void>
}

type Wire = Record<string, unknown>

function error(code: string, errorClass = 'permanent'): Wire {
  return { error: { code, class: errorClass } }
}

export async function startMockDaemon(input: {
  directory: string
  credentials?: Record<string, MockCredential>
  category?: string
  refreshAdapter?: string
}): Promise<MockDaemon> {
  const category = input.category ?? 'openai-native'
  const adapter = input.refreshAdapter ?? 'openai'
  const sockets = new Set<Socket>()
  const enrollments = new Map<
    string,
    {
      name: string
      hash: string
      status: 'pending' | 'approved' | 'denied' | 'consumed'
      token?: string
      generation?: number
    }
  >()
  let nextRequest = 1

  const state: MockDaemon = {
    connectionFile: '',
    credentials: input.credentials ?? {},
    gets: [],
    reports: [],
    proposals: [],
    polls: 0,
    lists: 0,
    approve(requestId, token = 'ab'.repeat(32), generation = 1) {
      const entry = enrollments.get(requestId)
      if (!entry) throw new Error(`unknown request ${requestId}`)
      entry.status = 'approved'
      entry.token = token
      entry.generation = generation
    },
    deny(requestId) {
      const entry = enrollments.get(requestId)
      if (entry) entry.status = 'denied'
    },
    stop: async () => {},
  }

  function inventory(): Wire {
    const rows = Object.entries(state.credentials).map(([id, credential]) => {
      const row: Wire = {
        id,
        type: credential.type ?? 'oauth',
        state: credential.state ?? 'active',
        record_version: credential.record_version,
        categories: credential.categories ?? [category],
        serves: ['openai'],
        operations: credential.operations ?? ['read'],
        ...(credential.account_id !== undefined && {
          account_id: credential.account_id,
        }),
        ...(credential.refresh_adapter !== null && {
          refresh_adapter: credential.refresh_adapter ?? adapter,
        }),
        ...credential.wire,
      }
      return row
    })
    // The view covers what the caller can see, never record versions.
    const view = createHash('sha256')
      .update(
        JSON.stringify(
          rows.map(
            ({ id, type, state, categories, operations, account_id }) => [
              id,
              type,
              state,
              categories,
              operations,
              account_id ?? null,
            ],
          ),
        ),
      )
      .digest('hex')
    return { result: { credentials: rows, view } }
  }

  function handle(method: string | undefined, params: Wire): Wire {
    if (method === 'credential.list_scoped') {
      state.lists++
      return inventory()
    }
    if (method === 'credential.get_scoped') {
      const id = params.credential_id as string | undefined
      state.gets.push({
        credential_id: id,
        enrollment_token: params.enrollment_token as string | undefined,
      })
      const credential = id ? state.credentials[id] : undefined
      if (!credential) return error('not_found')
      if (credential.refuse) return error(credential.refuse, 'auth_required')
      if ((credential.state ?? 'active') !== 'active')
        return error('needs_reauth', 'auth_required')
      const served =
        credential.served_account_id === null
          ? undefined
          : (credential.served_account_id ?? credential.account_id)
      return {
        result: {
          payload: Array.from(new TextEncoder().encode(credential.payload)),
          credential_id: id,
          ...(served !== undefined && { account_id: served }),
          record_version: credential.record_version,
          expires_at_ms: credential.expires_at_ms,
        },
      }
    }
    if (method === 'credential.report_auth_failure') {
      const report: MockReport = {
        credential_id: params.credential_id as string | undefined,
        enrollment_token: params.enrollment_token as string | undefined,
        provider_status: params.provider_status as number | undefined,
        record_version: params.record_version as number | undefined,
        reporter_source: params.reporter_source as string | undefined,
      }
      state.reports.push(report)
      if (report.provider_status !== 401) return error('invalid_params')
      state.onReport?.(report)
      return { result: { accepted: true } }
    }
    if (method === 'auth.enroll_propose') {
      const name = params.proposed_name as string
      const hash = params.request_secret_hash as string
      state.proposals.push({ name, hash })
      for (const [requestId, entry] of enrollments) {
        if (entry.name !== name || entry.status !== 'pending') continue
        // Idempotent on (name, secret); a different secret is another caller.
        if (entry.hash === hash) return { result: { request_id: requestId } }
        return error('pending_exists')
      }
      const requestId = `request-${nextRequest++}`
      enrollments.set(requestId, { name, hash, status: 'pending' })
      return { result: { request_id: requestId } }
    }
    if (method === 'auth.enroll_poll') {
      state.polls++
      const entry = enrollments.get(params.request_id as string)
      if (!entry) return error('not_found')
      const hash = createHash('sha256')
        .update(Buffer.from(String(params.request_secret), 'hex'))
        .digest('hex')
      if (hash !== entry.hash) return error('not_found')
      if (entry.status === 'pending') return { result: { status: 'pending' } }
      if (entry.status === 'denied') return { result: { status: 'denied' } }
      if (entry.status === 'consumed') return error('already_consumed')
      entry.status = 'consumed'
      return {
        result: {
          status: 'approved',
          name: entry.name,
          token: entry.token,
          token_generation: entry.generation,
        },
      }
    }
    return { result: {} }
  }

  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let buffer = Buffer.alloc(0)
    let phase: 'hello' | 'auth' | 'frames' = 'hello'
    let routeChannel: number | undefined

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([
        buffer,
        typeof chunk === 'string' ? Buffer.from(chunk) : chunk,
      ])
      for (;;) {
        if (phase !== 'frames') {
          if (buffer.length < 4) return
          const length = buffer.readUInt32LE(0)
          if (buffer.length < 4 + length) return
          const body = JSON.parse(
            buffer.subarray(4, 4 + length).toString('utf8'),
          ) as Record<string, unknown>
          buffer = buffer.subarray(4 + length)
          if (phase === 'hello') {
            const clientNonce = Uint8Array.from(body.client_nonce as number[])
            const serverNonce = Uint8Array.from(
              { length: 32 },
              (_, index) => 100 + index,
            )
            writeHandshake(socket, {
              daemon_id: Array.from(daemonId),
              server_nonce: Array.from(serverNonce),
              daemon_ver: 'mock-daemon',
              server_proof: Array.from(
                subc.computeProof(
                  key,
                  subc.SERVER_PROOF_DOMAIN,
                  clientNonce,
                  serverNonce,
                  daemonId,
                ),
              ),
            })
            phase = 'auth'
          } else {
            phase = 'frames'
          }
          continue
        }
        if (buffer.length < subc.HEADER_LEN) return
        const header = subc.decodeHeader(buffer.subarray(0, subc.HEADER_LEN))
        if (buffer.length < subc.HEADER_LEN + header.len) return
        const body = buffer.subarray(
          subc.HEADER_LEN,
          subc.HEADER_LEN + header.len,
        )
        buffer = buffer.subarray(subc.HEADER_LEN + header.len)
        if (header.ty !== subc.FrameType.Request) continue
        const request = JSON.parse(body.toString('utf8')) as {
          method?: string
          op?: string
          params?: Wire
        }
        if (header.channel === 0) {
          if (request.op === 'route.open') routeChannel = 7
          writeResponse(socket, header, { route_channel: 7, route_epoch: 1 })
          continue
        }
        if (header.channel !== routeChannel) {
          writeResponse(
            socket,
            header,
            { code: 'unknown_channel' },
            subc.FrameType.Error,
          )
          continue
        }
        writeResponse(
          socket,
          header,
          handle(request.method, request.params ?? {}),
        )
      }
    })
  })
  await listen(server)
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('mock Claustrum daemon has no TCP address')
  state.connectionFile = join(input.directory, 'claustrum-connection.json')
  await writeConnectionFile(state.connectionFile, address.port)
  state.stop = async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  return state
}

function writeHandshake(socket: Socket, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32LE(body.length)
  socket.write(Buffer.concat([prefix, body]))
}

function writeResponse(
  socket: Socket,
  header: ReturnType<SubcWire['decodeHeader']>,
  value: unknown,
  type: number = subc.FrameType.Response,
): void {
  const frame = subc.buildFrame(
    type,
    subc.buildFlags(false, subc.Priority.Interactive, false),
    header.channel,
    header.epoch,
    header.corr,
    new TextEncoder().encode(JSON.stringify(value)),
  )
  socket.write(Buffer.from(subc.encodeFrame(frame)))
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
}

async function writeConnectionFile(path: string, port: number): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({
      schema: 1,
      wire_version: subc.PROTOCOL_VERSION,
      endpoints: [{ host: '127.0.0.1', port }],
      key: Array.from(key),
      daemon_id: Array.from(daemonId),
      pid: process.pid,
      daemon_ver: 'mock-daemon',
    }),
    { mode: 0o600 },
  )
  await chmod(path, 0o600)
}

/** An access token whose claims name `accountId` as its ChatGPT account. */
export function chatgptAccessToken(accountId: string, salt = ''): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    salt,
  })}.signature`
}

/** A vault OpenAI login for `accountId`, valid for an hour. */
export function vaultLogin(
  accountId: string,
  overrides: Partial<MockCredential> = {},
): MockCredential {
  return {
    payload: JSON.stringify({ access_token: chatgptAccessToken(accountId) }),
    account_id: accountId,
    record_version: 1,
    expires_at_ms: Date.now() + 3_600_000,
    ...overrides,
  }
}

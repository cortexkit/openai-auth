// A loopback stand-in for the Codex Responses backend with two ChatGPT
// accounts, speaking just enough HTTP SSE and WebSocket for one OpenCode 2
// turn. It records which account each request arrived under (bearer and
// `chatgpt-account-id` together), reports quota the way Codex does
// (`x-codex-*` headers, `codex.rate_limits` frames), and refuses on request
// with Codex's usage-limit shapes.

export const MOCK_ACCOUNTS = {
  A: { token: 'tok-A', id: 'acct-A', used: 33 },
  B: { token: 'tok-B', id: 'acct-B', used: 55 },
  C: { token: 'tok-C', id: 'acct-C', used: 12 },
} as const

export type MockAccount = keyof typeof MOCK_ACCOUNTS
export type Identity = MockAccount | 'none'

/** How the next agent-loop request of an account is refused. */
export type RejectMode = 'usage-limit'

export interface WireRecord {
  readonly transport: 'http' | 'ws'
  readonly action: 'request' | 'handshake' | 'frame'
  readonly connection?: number
  readonly kind?: 'primary' | 'other'
  readonly identity: Identity
  /** The `chatgpt-account-id` header as sent. */
  readonly accountHeader: string | null
  /** Any header carried a value the host should never send. */
  readonly forbiddenSeen: boolean
  readonly rejected?: RejectMode
}

function identify(headers: Headers): Identity {
  const token = /^Bearer (.+)$/i.exec(headers.get('authorization') ?? '')?.[1]
  const account = headers.get('chatgpt-account-id')
  for (const [name, entry] of Object.entries(MOCK_ACCOUNTS)) {
    if (token === entry.token && account === entry.id)
      return name as MockAccount
  }
  return 'none'
}

function responseEvents(text: string, id: string) {
  const itemID = `msg_${id}`
  const response = (status: string, output: unknown[]) => ({
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: 'gpt-5.5',
    output,
    usage:
      status === 'completed'
        ? {
            input_tokens: 11,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 3,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 14,
          }
        : null,
  })
  const done = {
    id: itemID,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
  return [
    {
      type: 'response.created',
      sequence_number: 0,
      response: response('in_progress', []),
    },
    {
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: {
        id: itemID,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    },
    {
      type: 'response.content_part.added',
      sequence_number: 2,
      item_id: itemID,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    },
    {
      type: 'response.output_text.delta',
      sequence_number: 3,
      item_id: itemID,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: 'response.output_text.done',
      sequence_number: 4,
      item_id: itemID,
      output_index: 0,
      content_index: 0,
      text,
    },
    {
      type: 'response.content_part.done',
      sequence_number: 5,
      item_id: itemID,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text, annotations: [] },
    },
    {
      type: 'response.output_item.done',
      sequence_number: 6,
      output_index: 0,
      item: done,
    },
    {
      type: 'response.completed',
      sequence_number: 7,
      response: response('completed', [done]),
    },
  ]
}

/** Codex's refusal for an account whose usage window is spent. */
const USAGE_LIMIT = {
  type: 'usage_limit_reached',
  message: 'The usage limit has been reached',
  resets_in_seconds: 1800,
}

const toSSE = (events: unknown[]) =>
  events
    .map(
      (event) =>
        `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
    )
    .join('')

const quotaHeaders = (identity: Identity): Record<string, string> =>
  identity === 'none'
    ? {}
    : {
        'x-codex-primary-used-percent': String(MOCK_ACCOUNTS[identity].used),
        'x-codex-primary-window-minutes': '300',
      }

const quotaFrame = (identity: Identity) => ({
  type: 'codex.rate_limits',
  rate_limits: {
    primary:
      identity === 'none'
        ? null
        : { used_percent: MOCK_ACCOUNTS[identity].used, window_minutes: 300 },
    secondary: null,
  },
})

export interface MockCodex {
  readonly url: string
  readonly records: WireRecord[]
  /** Refuses the next agent-loop request of `account` once. */
  reject(account: MockAccount, mode: RejectMode): void
  stop(): Promise<void>
}

export function startMockCodex(forbidden: readonly string[]): MockCodex {
  const records: WireRecord[] = []
  const rejects: Array<{ account: MockAccount; mode: RejectMode }> = []
  let requests = 0
  let connections = 0
  const carriesForbidden = (headers: Headers) =>
    [...headers.values()].some((value) =>
      forbidden.some((secret) => value.includes(secret)),
    )
  const takeReject = (identity: Identity) => {
    const index = rejects.findIndex((entry) => entry.account === identity)
    if (index < 0) return undefined
    return rejects.splice(index, 1)[0]?.mode
  }
  type Socket = {
    connection: number
    identity: Identity
    accountHeader: string | null
  }

  const server = Bun.serve<Socket>({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request, server) {
      const identity = identify(request.headers)
      const accountHeader = request.headers.get('chatgpt-account-id')
      const forbiddenSeen = carriesForbidden(request.headers)
      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const connection = ++connections
        records.push({
          transport: 'ws',
          action: 'handshake',
          connection,
          identity,
          accountHeader,
          forbiddenSeen,
        })
        if (
          server.upgrade(request, {
            data: { connection, identity, accountHeader },
          })
        )
          return undefined
        return new Response('upgrade failed', { status: 400 })
      }
      const body = await request.text()
      if (
        request.method !== 'POST' ||
        !/\/responses$/.test(new URL(request.url).pathname)
      ) {
        return Response.json(
          { error: { message: 'mock: no route' } },
          { status: 404 },
        )
      }
      const index = ++requests
      // Only agent-loop requests carry tool definitions.
      const kind = /"tools"\s*:/.test(body) ? 'primary' : 'other'
      const rejected = kind === 'primary' ? takeReject(identity) : undefined
      records.push({
        transport: 'http',
        action: 'request',
        kind,
        identity,
        accountHeader,
        forbiddenSeen,
        ...(rejected ? { rejected } : {}),
      })
      if (rejected === 'usage-limit') {
        return Response.json(
          { error: USAGE_LIMIT },
          { status: 429, headers: quotaHeaders(identity) },
        )
      }
      return new Response(
        toSSE(
          responseEvents(`MOCK-HTTP-REPLY-${index}-${identity}`, `r${index}`),
        ),
        {
          headers: {
            'content-type': 'text/event-stream',
            ...quotaHeaders(identity),
          },
        },
      )
    },
    websocket: {
      message(socket) {
        const { connection, identity, accountHeader } = socket.data
        const index = ++requests
        const rejected = takeReject(identity)
        records.push({
          transport: 'ws',
          action: 'frame',
          connection,
          kind: 'primary',
          identity,
          accountHeader,
          forbiddenSeen: false,
          ...(rejected ? { rejected } : {}),
        })
        const send = (event: unknown) => socket.send(JSON.stringify(event))
        send(quotaFrame(identity))
        if (rejected === 'usage-limit') {
          send({ type: 'error', status: 429, error: USAGE_LIMIT })
          return
        }
        for (const event of responseEvents(
          `MOCK-WS-REPLY-${index}-${identity}`,
          `ws${connection}_${index}`,
        ))
          send(event)
      },
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    records,
    reject(account, mode) {
      rejects.push({ account, mode })
    },
    async stop() {
      await server.stop(true)
    },
  }
}

// A strict loopback stand-in for the Codex Responses backend, for the
// OpenCode 2 transport proofs. Unlike `opencode2-mock-codex.ts` it keeps every
// request and frame byte for byte, and it holds the conversation the way the
// real backend does on a WebSocket: each connection remembers the responses it
// produced, a `previous_response_id` must name one of them, and the input the
// model would read is that response's input, then its output, then the new
// frame's input. A frame chained to an unknown response is refused with
// `previous_response_not_found`, as Codex refuses it, so a client whose idea of
// the conversation drifted from the server's shows up as a failed turn.
//
// A user message containing `USE-TOOL` gets a function call back instead of
// text, so a turn exercises a tool call and its output.

import { MOCK_ACCOUNTS, type MockAccount } from './opencode2-mock-codex'

export type ProofIdentity = MockAccount | 'none'

/** One request or frame as it reached the mock. */
export interface ProofRecord {
  readonly seq: number
  readonly at: number
  readonly transport: 'http' | 'ws'
  readonly action: 'request' | 'handshake' | 'frame' | 'other'
  readonly connection?: number
  readonly identity: ProofIdentity
  /** Header names and values, with the bearer reduced to the account it names. */
  readonly headers: Record<string, string>
  /** The exact bytes of the HTTP body or WebSocket text frame. */
  readonly raw?: string
  readonly path?: string
  /** The response id the mock answered with. */
  readonly responseID?: string
  /** For a frame: the response it chained to, if any. */
  readonly previous?: string
  /** The conversation the model reads: earlier input and output plus this input. */
  readonly conversation?: unknown[]
  /** What the mock did with it. */
  readonly outcome?:
    | 'text'
    | 'tool-call'
    | 'usage-limit'
    | 'previous_response_not_found'
    | 'not-json'
}

export interface ProofCodex {
  readonly url: string
  readonly records: ProofRecord[]
  /** Refuses the next response.create of `account` with a usage-limit error. */
  reject(account: MockAccount): void
  stop(): Promise<void>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The account a request was sent as, and which of its tokens: `seeded` is
 * the token the pool started with, any other label names a token the test
 * rotated in (`aliases`).
 */
function identify(
  headers: Headers,
  aliases: Readonly<Record<string, { account: MockAccount; label: string }>>,
): { identity: ProofIdentity; label: string } {
  const token = /^Bearer (.+)$/i.exec(headers.get('authorization') ?? '')?.[1]
  const account = headers.get('chatgpt-account-id')
  const alias = token ? aliases[token] : undefined
  if (alias && account === MOCK_ACCOUNTS[alias.account].id)
    return { identity: alias.account, label: alias.label }
  for (const [name, entry] of Object.entries(MOCK_ACCOUNTS)) {
    if (token === entry.token && account === entry.id)
      return { identity: name as MockAccount, label: 'seeded' }
  }
  return { identity: 'none', label: 'none' }
}

/**
 * The request's headers for the record, with secrets replaced: the bearer
 * token is written as `<bearer:account:label>` (which pool account and which
 * of its tokens it was), so records can be printed without leaking a token.
 */
function redact(headers: Headers, identity: ProofIdentity, label: string) {
  const out: Record<string, string> = {}
  for (const [name, value] of headers) {
    if (name === 'authorization') out[name] = `<bearer:${identity}:${label}>`
    else if (name === 'cookie') out[name] = '<cookie>'
    else out[name] = value
  }
  return out
}

const textOf = (item: unknown): string => {
  if (!isRecord(item)) return ''
  if (typeof item.content === 'string') return item.content
  if (!Array.isArray(item.content)) return ''
  return item.content
    .map((part) =>
      isRecord(part) && typeof part.text === 'string' ? part.text : '',
    )
    .join('')
}

const isUser = (item: unknown) =>
  isRecord(item) &&
  (item.type === 'message' || 'role' in item) &&
  item.role === 'user'

/** Picks a harmless built-in tool and arguments that satisfy its schema. */
function toolCall(tools: unknown, file: string) {
  const list = Array.isArray(tools) ? tools.filter(isRecord) : []
  const preferred = ['read', 'glob', 'list', 'ls']
  const tool =
    preferred
      .map((name) => list.find((entry) => entry.name === name))
      .find(Boolean) ?? list[0]
  if (!tool || typeof tool.name !== 'string') return undefined
  const schema = isRecord(tool.parameters) ? tool.parameters : {}
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const required = Array.isArray(schema.required) ? schema.required : []
  const args: Record<string, unknown> = {}
  for (const key of required) {
    if (typeof key !== 'string') continue
    const property = isRecord(properties[key]) ? properties[key] : {}
    if (/path|file/i.test(key)) args[key] = file
    else if (/pattern/i.test(key)) args[key] = '*.md'
    else if (property.type === 'number' || property.type === 'integer')
      args[key] = 1
    else if (property.type === 'boolean') args[key] = false
    else args[key] = file
  }
  return { name: tool.name, arguments: JSON.stringify(args) }
}

function textEvents(text: string, id: string) {
  const itemID = `msg_${id}`
  const done = {
    id: itemID,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
  return {
    output: [done],
    events: [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...done, status: 'in_progress', content: [] },
      },
      {
        type: 'response.content_part.added',
        item_id: itemID,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      },
      {
        type: 'response.output_text.delta',
        item_id: itemID,
        output_index: 0,
        content_index: 0,
        delta: text,
      },
      {
        type: 'response.output_text.done',
        item_id: itemID,
        output_index: 0,
        content_index: 0,
        text,
      },
      {
        type: 'response.content_part.done',
        item_id: itemID,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text, annotations: [] },
      },
      { type: 'response.output_item.done', output_index: 0, item: done },
    ],
  }
}

function toolEvents(call: { name: string; arguments: string }, id: string) {
  const item = {
    id: `fc_${id}`,
    type: 'function_call',
    status: 'completed',
    call_id: `call_${id}`,
    name: call.name,
    arguments: call.arguments,
  }
  return {
    output: [item],
    events: [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...item, status: 'in_progress', arguments: '' },
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: item.id,
        output_index: 0,
        delta: call.arguments,
      },
      {
        type: 'response.function_call_arguments.done',
        item_id: item.id,
        output_index: 0,
        arguments: call.arguments,
      },
      { type: 'response.output_item.done', output_index: 0, item },
    ],
  }
}

function wrap(
  id: string,
  output: unknown[],
  events: Record<string, unknown>[],
) {
  const response = (status: string, items: unknown[]) => ({
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: 'gpt-5.5',
    output: items,
    usage:
      status === 'completed'
        ? {
            input_tokens: 11,
            input_tokens_details: { cached_tokens: 7 },
            output_tokens: 3,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 14,
          }
        : null,
  })
  return [
    { type: 'response.created', response: response('in_progress', []) },
    ...events,
    { type: 'response.completed', response: response('completed', output) },
  ].map((event, index) => ({ ...event, sequence_number: index }))
}

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

export function startProofCodex(options: {
  toolFile: string
  aliases?: Record<string, { account: MockAccount; label: string }>
  /**
   * Whether replies report the account's quota (headers, rate-limit frames);
   * on by default. Off keeps the seeded readings, so placement is decided by
   * the sessions already placed rather than by fresh readings.
   */
  quota?: boolean
}): ProofCodex {
  const aliases = options.aliases ?? {}
  const records: ProofRecord[] = []
  const rejects: MockAccount[] = []
  let seq = 0
  let connections = 0
  let responses = 0
  const takeReject = (identity: ProofIdentity) => {
    const index = rejects.indexOf(identity as MockAccount)
    if (index < 0) return false
    rejects.splice(index, 1)
    return true
  }
  /**
   * The model's answer for a conversation: a tool call when the turn's user
   * message asks for one and no tool output has come back yet, else text.
   */
  const answer = (body: Record<string, unknown>, conversation: unknown[]) => {
    const id = `resp_${++responses}`
    const lastUser = conversation.findLastIndex(isUser)
    const afterUser = conversation.slice(lastUser + 1)
    const wantsTool =
      lastUser >= 0 &&
      textOf(conversation[lastUser]).includes('USE-TOOL') &&
      !afterUser.some(
        (item) => isRecord(item) && item.type === 'function_call_output',
      )
    const call = wantsTool ? toolCall(body.tools, options.toolFile) : undefined
    // OpenCode 2 accepts a compaction summary only if it carries one of its
    // template's section headings.
    const summarizing =
      lastUser >= 0 &&
      /summarize the conversation above|Update the existing checkpoint|did not fill in the required summary/.test(
        textOf(conversation[lastUser]),
      )
    const built = call
      ? toolEvents(call, String(responses))
      : textEvents(
          summarizing
            ? `## Next Move\n1. (none)\n## Important Context\n- PROOF-SUMMARY-${responses}`
            : `PROOF-REPLY-${responses}`,
          String(responses),
        )
    return {
      id,
      outcome: call ? ('tool-call' as const) : ('text' as const),
      output: built.output,
      events: wrap(id, built.output, built.events),
    }
  }

  type Socket = {
    connection: number
    identity: ProofIdentity
    headers: Record<string, string>
    /** The responses produced on this connection: their full input and output. */
    held: Map<string, { conversation: unknown[]; output: unknown[] }>
  }

  const server = Bun.serve<Socket>({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request, server) {
      const { identity, label } = identify(request.headers, aliases)
      const headers = redact(request.headers, identity, label)
      const path = new URL(request.url).pathname
      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const connection = ++connections
        records.push({
          seq: ++seq,
          at: Date.now(),
          transport: 'ws',
          action: 'handshake',
          connection,
          identity,
          headers,
          path,
        })
        if (
          server.upgrade(request, {
            data: { connection, identity, headers, held: new Map() },
          })
        )
          return undefined
        return new Response('upgrade failed', { status: 400 })
      }
      const raw = await request.text()
      if (request.method !== 'POST' || !/\/responses$/.test(path)) {
        records.push({
          seq: ++seq,
          at: Date.now(),
          transport: 'http',
          action: 'other',
          identity,
          headers,
          path,
          raw,
        })
        return Response.json(
          { error: { message: 'no route' } },
          { status: 404 },
        )
      }
      let body: Record<string, unknown> | undefined
      try {
        const parsed: unknown = JSON.parse(raw)
        body = isRecord(parsed) ? parsed : undefined
      } catch {}
      const base = {
        seq: ++seq,
        at: Date.now(),
        transport: 'http' as const,
        action: 'request' as const,
        identity,
        headers,
        path,
        raw,
      }
      if (!body) {
        records.push({ ...base, outcome: 'not-json' })
        return Response.json(
          { error: { message: 'bad json' } },
          { status: 400 },
        )
      }
      if (takeReject(identity)) {
        records.push({ ...base, outcome: 'usage-limit' })
        return Response.json({ error: USAGE_LIMIT }, { status: 429 })
      }
      const conversation = Array.isArray(body.input) ? body.input : []
      const reply = answer(body, conversation)
      records.push({
        ...base,
        responseID: reply.id,
        conversation,
        outcome: reply.outcome,
      })
      return new Response(toSSE(reply.events), {
        headers: {
          'content-type': 'text/event-stream',
          ...(identity === 'none' || options.quota === false
            ? {}
            : {
                'x-codex-primary-used-percent': String(
                  MOCK_ACCOUNTS[identity].used,
                ),
                'x-codex-primary-window-minutes': '300',
              }),
        },
      })
    },
    websocket: {
      message(socket, message) {
        const raw = String(message)
        const { connection, identity, headers, held } = socket.data
        const base = {
          seq: ++seq,
          at: Date.now(),
          transport: 'ws' as const,
          action: 'frame' as const,
          connection,
          identity,
          headers,
          raw,
        }
        const send = (event: unknown) => socket.send(JSON.stringify(event))
        let body: Record<string, unknown> | undefined
        try {
          const parsed: unknown = JSON.parse(raw)
          body = isRecord(parsed) ? parsed : undefined
        } catch {}
        if (body?.type !== 'response.create') {
          records.push({ ...base, outcome: 'not-json' })
          send({ type: 'error', status: 400, error: { message: 'bad frame' } })
          return
        }
        if (identity !== 'none' && options.quota !== false)
          send({
            type: 'codex.rate_limits',
            rate_limits: {
              primary: {
                used_percent: MOCK_ACCOUNTS[identity].used,
                window_minutes: 300,
              },
              secondary: null,
            },
          })
        if (takeReject(identity)) {
          records.push({ ...base, outcome: 'usage-limit' })
          send({ type: 'error', status: 429, error: USAGE_LIMIT })
          return
        }
        const previous =
          typeof body.previous_response_id === 'string'
            ? body.previous_response_id
            : undefined
        const prior = previous ? held.get(previous) : undefined
        if (previous && !prior) {
          records.push({
            ...base,
            previous,
            outcome: 'previous_response_not_found',
          })
          send({
            type: 'error',
            status: 400,
            error: {
              type: 'invalid_request_error',
              code: 'previous_response_not_found',
              message: `Previous response with id '${previous}' not found.`,
              param: 'previous_response_id',
            },
          })
          return
        }
        const input = Array.isArray(body.input) ? body.input : []
        const conversation = prior
          ? [...prior.conversation, ...prior.output, ...input]
          : input
        const reply = answer(body, conversation)
        held.set(reply.id, { conversation, output: reply.output })
        records.push({
          ...base,
          ...(previous ? { previous } : {}),
          responseID: reply.id,
          conversation,
          outcome: reply.outcome,
        })
        for (const event of reply.events) send(event)
      },
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    records,
    reject(account) {
      rejects.push(account)
    },
    async stop() {
      await server.stop(true)
    },
  }
}

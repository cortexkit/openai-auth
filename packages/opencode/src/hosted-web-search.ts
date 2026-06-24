import { type ToolDefinition, tool } from '@opencode-ai/plugin'

import { isRecord } from './util/record'

const HOSTED_WEB_SEARCH_ID_PREFIX = 'ws_'
const hostedWebSearchItems = new Map<string, Record<string, unknown>>()

export const HostedWebSearchTool: ToolDefinition = tool({
  description:
    'Provider-executed OpenAI web search. This tool is handled server-side by OpenAI; the local plugin records the hosted action for deterministic replay.',
  args: {
    type: tool.schema.string().optional(),
    query: tool.schema.string().optional(),
    queries: tool.schema.array(tool.schema.string()).optional(),
  },
  async execute(args) {
    return {
      title: 'OpenAI Web Search',
      output: JSON.stringify({ action: args }),
      metadata: { action: args },
    }
  },
})

export function translateHostedWebSearchEvent(event: Record<string, unknown>) {
  if (isHostedWebSearchLifecycleEvent(event)) return undefined
  if (!isHostedWebSearchDoneEvent(event)) return event
  const item = event.item
  hostedWebSearchItems.set(item.id, item)
  return {
    ...event,
    item: {
      type: 'function_call',
      id: item.id,
      call_id: item.id,
      name: 'web_search',
      arguments: JSON.stringify(isRecord(item.action) ? item.action : {}),
    },
  }
}

export function translateHostedWebSearchResponse(response: Response) {
  if (!response.body) return response
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream')) return response
  return new Response(translateHostedWebSearchSSE(response.body), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

export function rewriteHostedWebSearchReplay(body: Record<string, unknown>) {
  if (!Array.isArray(body.input)) return false
  let changed = false
  const hostedCalls = new Map<string, Record<string, unknown>>()
  const rewritten: unknown[] = []

  const allCalls = new Map<string, Record<string, unknown>>()
  const allOutputs = new Map<string, string>()
  for (const item of body.input) {
    if (
      isRecord(item) &&
      typeof item.call_id === 'string' &&
      item.call_id.startsWith(HOSTED_WEB_SEARCH_ID_PREFIX)
    ) {
      if (item.type === 'function_call') {
        allCalls.set(item.call_id, item)
      } else if (
        item.type === 'function_call_output' &&
        typeof item.output === 'string'
      ) {
        allOutputs.set(item.call_id, item.output)
      }
    }
  }

  for (const item of body.input) {
    if (isHostedWebSearchFunctionCall(item)) {
      hostedCalls.set(item.call_id, item)
      changed = true
      continue
    }

    if (isHostedWebSearchFunctionOutput(item, hostedCalls)) {
      rewritten.push(
        toCodexWebSearchCall(
          item.call_id,
          item.output,
          hostedCalls.get(item.call_id),
        ),
      )
      changed = true
      continue
    }

    if (isHostedWebSearchItemReference(item)) {
      const hostedItem = hostedWebSearchItems.get(item.id)
      if (hostedItem) {
        rewritten.push(toCodexWebSearchCall(item.id, hostedItem))
      } else {
        const call = allCalls.get(item.id)
        const output = allOutputs.get(item.id)
        if (call || output) {
          rewritten.push(toCodexWebSearchCall(item.id, output, call))
        } else {
          rewritten.push(item)
        }
      }
      changed = true
      continue
    }

    rewritten.push(item)
  }

  if (changed) body.input = rewritten
  return changed
}

function isHostedWebSearchLifecycleEvent(event: Record<string, unknown>) {
  if (
    typeof event.type === 'string' &&
    event.type.startsWith('response.web_search_call.')
  ) {
    return true
  }
  return (
    event.type === 'response.output_item.added' &&
    isRecord(event.item) &&
    event.item.type === 'web_search_call'
  )
}

function translateHostedWebSearchSSE(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true })
        let boundary = sseBoundary(buffer)
        while (boundary) {
          const frame = buffer.slice(0, boundary.index)
          buffer = buffer.slice(boundary.index + boundary.length)
          const translated = translateSSEFrame(frame)
          if (translated) controller.enqueue(encoder.encode(translated))
          boundary = sseBoundary(buffer)
        }
      },
      flush(controller) {
        buffer += decoder.decode()
        if (!buffer) return
        const translated = translateSSEFrame(buffer)
        if (translated) controller.enqueue(encoder.encode(translated))
      },
    }),
  )
}

function sseBoundary(
  buffer: string,
): { index: number; length: number } | undefined {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf === -1) return crlf === -1 ? undefined : { index: crlf, length: 4 }
  if (crlf === -1 || lf < crlf) return { index: lf, length: 2 }
  return { index: crlf, length: 4 }
}

function translateSSEFrame(frame: string) {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  if (!data) return `${frame}\n\n`
  if (data === '[DONE]') return `data: [DONE]\n\n`
  try {
    const event = JSON.parse(data)
    if (!isRecord(event)) return `${frame}\n\n`
    const translated = translateHostedWebSearchEvent(event)
    if (!translated) return ''
    return `data: ${JSON.stringify(translated)}\n\n`
  } catch {
    return `${frame}\n\n`
  }
}

function isHostedWebSearchDoneEvent(
  event: Record<string, unknown>,
): event is Record<string, unknown> & {
  item: Record<string, unknown> & { id: string; action?: unknown }
} {
  return (
    event.type === 'response.output_item.done' &&
    isRecord(event.item) &&
    event.item.type === 'web_search_call' &&
    typeof event.item.id === 'string'
  )
}

function isHostedWebSearchFunctionCall(item: unknown): item is {
  type: 'function_call'
  call_id: string
  name: string
  arguments?: string
} {
  return (
    isRecord(item) &&
    item.type === 'function_call' &&
    item.name === 'web_search' &&
    typeof item.call_id === 'string' &&
    item.call_id.startsWith(HOSTED_WEB_SEARCH_ID_PREFIX)
  )
}

function isHostedWebSearchFunctionOutput(
  item: unknown,
  hostedCalls: Map<string, Record<string, unknown>>,
): item is { type: 'function_call_output'; call_id: string; output: string } {
  return (
    isRecord(item) &&
    item.type === 'function_call_output' &&
    typeof item.call_id === 'string' &&
    typeof item.output === 'string' &&
    item.call_id.startsWith(HOSTED_WEB_SEARCH_ID_PREFIX) &&
    hostedCalls.has(item.call_id)
  )
}

function isHostedWebSearchItemReference(
  item: unknown,
): item is { type: 'item_reference'; id: string } {
  return (
    isRecord(item) &&
    item.type === 'item_reference' &&
    typeof item.id === 'string' &&
    item.id.startsWith(HOSTED_WEB_SEARCH_ID_PREFIX)
  )
}

function toCodexWebSearchCall(
  _id: string,
  output: unknown,
  call?: Record<string, unknown>,
) {
  const parsed = parseOutput(output)
  const action = isRecord(parsed?.action)
    ? parsed.action
    : parseArguments(call?.arguments)

  return {
    type: 'web_search_call',
    status: 'completed',
    ...(action ? { action } : {}),
  }
}

function parseOutput(output: unknown): Record<string, unknown> | undefined {
  if (isRecord(output)) return output
  if (typeof output !== 'string') return undefined
  try {
    const parsed = JSON.parse(output)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function parseArguments(args: unknown): Record<string, unknown> | undefined {
  if (isRecord(args)) return args
  if (typeof args !== 'string') return undefined
  try {
    const parsed = JSON.parse(args)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

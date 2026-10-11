import { performance } from 'node:perf_hooks'
import { redactCredentialResponse } from '../packages/core/src/util/credential-redaction'

const events = 2_000
const rounds = 60
const warmups = 10
const credential = 'opaque-benchmark-credential'
const encoder = new TextEncoder()
type Variant = 'completed' | 'failed'
type Mode = 'raw' | 'wrapped'

function chunksFor(variant: Variant): Uint8Array[] {
  const chunks: Uint8Array[] = []
  const fragments: string[] = []
  for (let index = 0; index < events - 1; index++) {
    const delta = [
      'The ',
      'implementation ',
      'preserves ',
      'streaming ',
      'output.\n',
    ][index % 5]
    if (delta === undefined) throw new Error('Missing delta fragment')
    fragments.push(delta)
    chunks.push(
      encoder.encode(
        `event: response.output_text.delta\ndata: ${JSON.stringify({
          type: 'response.output_text.delta',
          sequence_number: index,
          item_id: 'msg_codex_benchmark',
          output_index: 0,
          content_index: 0,
          delta,
        })}\n\n`,
      ),
    )
  }
  const response = {
    id: 'resp_codex_benchmark',
    object: 'response',
    model: 'gpt-5.4',
    status: variant,
    output: [
      {
        id: 'msg_codex_benchmark',
        type: 'message',
        role: 'assistant',
        status: variant,
        content: [
          { type: 'output_text', text: fragments.join(''), annotations: [] },
        ],
      },
    ],
    usage: { input_tokens: 12_000, output_tokens: 1_999, total_tokens: 13_999 },
    error:
      variant === 'failed'
        ? { code: 'server_error', message: `Provider echoed ${credential}` }
        : null,
  }
  chunks.push(
    encoder.encode(
      `event: response.${variant}\ndata: ${JSON.stringify({ type: `response.${variant}`, sequence_number: events - 1, response })}\n\n`,
    ),
  )
  return chunks
}

async function consume(chunks: Uint8Array[], mode: Mode) {
  const producedAt: number[] = []
  const latencyMs: number[] = []
  let sourceIndex = 0
  const start = performance.now()
  const source = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sourceIndex === chunks.length) {
          controller.close()
          return
        }
        producedAt.push(performance.now())
        const chunk = chunks[sourceIndex++]
        if (!chunk) throw new Error('Missing source chunk')
        controller.enqueue(chunk)
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
  const response =
    mode === 'wrapped'
      ? await redactCredentialResponse(source, credential)
      : source
  if (!response.body) throw new Error('Missing benchmark response body')
  const reader = response.body.getReader()
  let bytes = 0
  for (;;) {
    const result = await reader.read()
    const readAt = performance.now()
    if (result.done) break
    const produced = producedAt[latencyMs.length]
    if (produced === undefined)
      throw new Error('Consumer read before source enqueue')
    latencyMs.push(readAt - produced)
    bytes += result.value.byteLength
  }
  const totalMs = performance.now() - start
  if (latencyMs.length !== events)
    throw new Error(`Expected ${events} chunks, read ${latencyMs.length}`)
  return { totalMs, latencyMs, bytes }
}

function distribution(samples: number[], scale = 1) {
  const sorted = samples.toSorted((left, right) => left - right)
  const median = sorted[Math.floor(sorted.length / 2)]
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]
  if (median === undefined || p95 === undefined)
    throw new Error('No benchmark samples')
  return {
    median: Number((median * scale).toFixed(3)),
    p95: Number((p95 * scale).toFixed(3)),
  }
}

async function parseCount(chunks: Uint8Array[]) {
  const parse = JSON.parse
  let count = 0
  JSON.parse = (...args: Parameters<typeof JSON.parse>) => {
    count++
    return parse(...args)
  }
  try {
    await consume(chunks, 'wrapped')
  } finally {
    JSON.parse = parse
  }
  return count
}

const results = []
for (const variant of ['completed', 'failed'] as const) {
  const chunks = chunksFor(variant)
  const sourceBytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const totals: Record<Mode, number[]> = { raw: [], wrapped: [] }
  const latencies: Record<Mode, number[]> = { raw: [], wrapped: [] }
  const addedTotal: number[] = []
  const addedLatency: number[] = []
  for (let round = -warmups; round < rounds; round++) {
    const order: Mode[] =
      round % 2 === 0 ? ['raw', 'wrapped'] : ['wrapped', 'raw']
    const pair: Partial<Record<Mode, Awaited<ReturnType<typeof consume>>>> = {}
    for (const mode of order) {
      const result = await consume(chunks, mode)
      const expectedBytes =
        sourceBytes -
        (mode === 'wrapped' && variant === 'failed'
          ? credential.length - '[credential]'.length
          : 0)
      if (result.bytes !== expectedBytes)
        throw new Error('Unexpected stream byte count')
      pair[mode] = result
      if (round < 0) continue
      totals[mode].push(result.totalMs)
      for (const latency of result.latencyMs) latencies[mode].push(latency)
    }
    if (round < 0) continue
    if (!pair.raw || !pair.wrapped)
      throw new Error('Missing paired measurement')
    addedTotal.push(pair.wrapped.totalMs - pair.raw.totalMs)
    for (let index = 0; index < events; index++) {
      const raw = pair.raw.latencyMs[index]
      const wrapped = pair.wrapped.latencyMs[index]
      if (raw === undefined || wrapped === undefined)
        throw new Error('Missing chunk measurement')
      addedLatency.push(wrapped - raw)
    }
  }
  results.push({
    variant,
    events,
    source_bytes: sourceBytes,
    rounds,
    warmups,
    json_parses_per_wrapped_stream: await parseCount(chunks),
    raw_total_ms: distribution(totals.raw),
    wrapped_total_ms: distribution(totals.wrapped),
    added_total_ms: distribution(addedTotal),
    raw_chunk_latency_us: distribution(latencies.raw, 1_000),
    wrapped_chunk_latency_us: distribution(latencies.wrapped, 1_000),
    added_chunk_latency_us: distribution(addedLatency, 1_000),
  })
}
console.log(
  JSON.stringify(
    {
      label: process.argv[2] ?? 'unlabelled',
      bun: Bun.version,
      method:
        'Pre-encoded Codex SSE; one event per source chunk, unpaced pull-driven source; alternating paired raw/wrapped runs. Chunk latency is source enqueue to consumer read; parse counts are separate untimed runs.',
      results,
    },
    null,
    2,
  ),
)

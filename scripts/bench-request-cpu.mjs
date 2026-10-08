// CPU-only transport benchmark: no sockets, authentication, timers or network.
// Copies expose private functions without changing the plugin's public exports.
import { execFileSync } from 'node:child_process'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

process.env.CORTEXKIT_OPENAI_AUTH_DUMP = 'false'
const dir = new URL('../packages/opencode/src/', import.meta.url)
const baseline = process.argv.includes('--baseline')
const base = '20ecc8aba6d75cf17cae3c7c4b1ce93e57dc698d'
const copies = ['index', 'ws-pool', 'dump']
try {
  for (const name of copies) {
    const source = baseline
      ? execFileSync(
          'git',
          ['show', `${base}:packages/opencode/src/${name}.ts`],
          { encoding: 'utf8' },
        )
      : await readFile(new URL(`${name}.ts`, dir), 'utf8')
    const names =
      name === 'dump'
        ? 'dumpCodexRequest'
        : name === 'index'
          ? 'updateHttpTurnMetadata, prepareCodexRequest'
          : 'normalizeResponseBody, shouldPrewarm, withContinuation, applyTurnId, updateContinuation, bodySignature'
    const comparisonExport = source.includes('function requestComparison(')
      ? ', requestComparison'
      : ''
    await writeFile(
      new URL(`.cpu-bench-${name}.ts`, dir),
      `${source}\nexport const cpuBench = { ${names}${comparisonExport} };\n`,
    )
  }
  const { cpuBench: http } = await import(
    fileURLToPath(new URL('.cpu-bench-index.ts', dir))
  )
  const { cpuBench: ws } = await import(
    fileURLToPath(new URL('.cpu-bench-ws-pool.ts', dir))
  )
  const { dumpCodexRequest } = await import(
    fileURLToPath(new URL('.cpu-bench-dump.ts', dir))
  )
  const { stableStringify } = await import(
    '../packages/opencode/src/util/stable-json.ts'
  )
  const tools = Array.from({ length: 30 }, (_, i) => ({
    type: 'function',
    name: `tool_${i}`,
    description: 'Inspect or edit project state',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, query: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  }))
  const text =
    'Realistic source and tool output: const result = await inspectProject();\n'.repeat(
      43,
    )
  const item = (i) =>
    [
      {
        type: 'message',
        role: i === 0 ? 'user' : 'assistant',
        content: [{ type: i === 0 ? 'input_text' : 'output_text', text }],
      },
      {
        type: 'function_call',
        call_id: `call_${i}`,
        name: 'tool_1',
        arguments: JSON.stringify({ query: text }),
      },
      { type: 'function_call_output', call_id: `call_${i - 1}`, output: text },
      {
        type: 'reasoning',
        id: `rs_${i}`,
        summary: [{ type: 'summary_text', text }],
      },
    ][i % 4]
  const clone = (v) => JSON.parse(JSON.stringify(v))
  const metadata = () => ({
    threadID: 'session',
    turnID: 'turn',
    windowID: 'session:0',
    turnStartedAt: 1,
  })
  const entry = () => ({
    busy: false,
    fallback: false,
    streamFailures: 0,
    lastUsedAt: 0,
  })
  const event = { response: { id: 'resp' } }
  const finalized = new Set()
  const runs = 300
  async function measure(label, setup, run) {
    const samples = []
    for (let i = 0; i < runs + 20; i++) {
      const state = setup()
      const start = performance.now()
      await run(state)
      if (i >= 20) samples.push(performance.now() - start)
    }
    samples.sort((a, b) => a - b)
    console.log(
      `${label}: ${samples[Math.floor(samples.length / 2)].toFixed(3)} ms/request (median)`,
    )
  }
  console.log(
    `Bun ${Bun.version}; ${baseline ? 'baseline' : 'working tree'}; ${runs} measured requests + 20 warmups per row; dumps disabled`,
  )
  for (const count of [50, 200, 400]) {
    const previous = {
      model: 'gpt-5.5',
      stream: true,
      tools,
      reasoning: { effort: 'high' },
      input: Array.from({ length: count }, (_, i) => item(i)),
    }
    const current = {
      ...previous,
      input: [
        ...previous.input,
        { type: 'function_call_output', call_id: 'last', output: 'new output' },
      ],
    }
    const bodyText = JSON.stringify(current)
    const httpPrior = metadata()
    http.updateHttpTurnMetadata(httpPrior, clone(previous))
    const wsPrior = entry()
    const priorBody = ws.normalizeResponseBody(clone(previous))
    ws.applyTurnId(wsPrior, priorBody)
    ws.updateContinuation(wsPrior, priorBody, event, finalized, false)
    const setupHttp = () => ({ state: { ...httpPrior }, body: clone(current) })
    const setupWs = () => {
      const e = { ...wsPrior }
      const body = ws.normalizeResponseBody(clone(current))
      const comparison = ws.requestComparison?.(e, body)
      return { e, body, comparison }
    }
    console.log(
      `\n${count} prior items + 1 output; ${bodyText.length} bytes; 30 tools`,
    )
    await measure(
      'stableStringify one history',
      () => current.input,
      (input) => input.map(stableStringify),
    )
    await measure('HTTP updateHttpTurnMetadata', setupHttp, ({ state, body }) =>
      http.updateHttpTurnMetadata(state, body),
    )
    await measure(
      'HTTP prepareCodexRequest TOTAL (parse + decisions + wire)',
      setupHttp,
      ({ state }) =>
        http.prepareCodexRequest({
          init: { body: bodyText },
          headers: new Headers(),
          metadata: state,
          installationID: 'bench',
          websocket: false,
          responsesLite: false,
        }),
    )
    await measure('WS bodySignature', setupWs, ({ body }) =>
      ws.bodySignature(body),
    )
    if (ws.requestComparison) {
      await measure(
        'WS requestComparison (canonical items + signature)',
        setupWs,
        ({ e, body }) => ws.requestComparison(e, body),
      )
    }
    await measure('WS shouldPrewarm', setupWs, ({ e, body, comparison }) =>
      ws.shouldPrewarm(e, body, comparison),
    )
    await measure('WS withContinuation', setupWs, ({ e, body, comparison }) =>
      ws.withContinuation(e, body, comparison),
    )
    await measure('WS applyTurnId', setupWs, ({ e, body, comparison }) =>
      ws.applyTurnId(e, body, body, comparison),
    )
    await measure('WS updateContinuation', setupWs, ({ e, body, comparison }) =>
      ws.updateContinuation(e, body, event, finalized, true, comparison),
    )
    await measure('WS disabled main dump', setupWs, ({ body }) =>
      dumpCodexRequest({
        sessionID: 'bench',
        transport: 'websocket',
        phase: 'main',
        bodyText: baseline ? JSON.stringify(body) : () => JSON.stringify(body),
      }),
    )
    await measure(
      'WS TOTAL (parse + decisions + dump + wire + completion)',
      setupWs,
      async ({ e }) => {
        const body = ws.normalizeResponseBody(JSON.parse(bodyText))
        const comparison = ws.requestComparison?.(e, body)
        ws.shouldPrewarm(e, body, comparison)
        const continued = ws.withContinuation(e, body, comparison)
        const sent = ws.applyTurnId(e, continued, body, comparison)
        await dumpCodexRequest({
          sessionID: 'bench',
          transport: 'websocket',
          phase: 'main',
          bodyText: baseline
            ? JSON.stringify(sent)
            : () => JSON.stringify(sent),
        })
        JSON.stringify({ type: 'response.create', ...sent })
        ws.updateContinuation(e, body, event, finalized, true, comparison)
      },
    )
  }
} finally {
  await Promise.all(
    copies.map((name) =>
      unlink(new URL(`.cpu-bench-${name}.ts`, dir)).catch(() => {}),
    ),
  )
}

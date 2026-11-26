// CPU-only transport benchmark: no sockets, authentication, timers or network.
// The scratch copy exposes private functions without changing the plugin's exports.
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.CORTEXKIT_OPENAI_AUTH_DUMP = 'false'
const dir = fileURLToPath(new URL('../packages/opencode/src/', import.meta.url))
const scratch = fileURLToPath(new URL('../target/scratch/', import.meta.url))
if (process.argv.length !== 2) {
  console.error('Usage: bun scripts/bench-request-cpu.mjs')
  process.exit(2)
}
await mkdir(scratch, { recursive: true })
const work = await mkdtemp(join(scratch, 'request-cpu-'))
try {
  // Keep relative imports working without writing into the plugin's source tree.
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    await symlink(
      join(dir, entry.name),
      join(work, entry.name),
      entry.isDirectory() ? 'junction' : 'file',
    )
  }
  await symlink(
    join(dirname(dir), 'node_modules'),
    join(work, 'node_modules'),
    'junction',
  )
  const wsPath = join(work, '.cpu-bench-ws-pool.ts')
  const wsSource = await readFile(join(dir, 'ws-pool.ts'), 'utf8')
  await writeFile(
    wsPath,
    `${wsSource}\nexport const cpuBench = { normalizeResponseBody, shouldPrewarm, withContinuation, applyTurnId, updateContinuation, bodySignature, requestComparison };\n`,
    { flag: 'wx' },
  )
  const http = await import('../packages/opencode/src/codex-request.ts')
  const { cpuBench: ws } = await import(wsPath)
  const { dumpCodexRequest } = await import('../packages/opencode/src/dump.ts')
  const { stableStringify } = await import(
    '../packages/core/src/util/stable-json.ts'
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
    `Bun ${Bun.version}; working tree; ${runs} measured requests + 20 warmups per row; dumps disabled`,
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
      const comparison = ws.requestComparison(e, body)
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
          rewriteLite: () => {},
        }),
    )
    await measure('WS bodySignature', setupWs, ({ body }) =>
      ws.bodySignature(body),
    )
    await measure(
      'WS requestComparison (canonical items + signature)',
      setupWs,
      ({ e, body }) => ws.requestComparison(e, body),
    )
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
        bodyText: () => JSON.stringify(body),
      }),
    )
    await measure(
      'WS TOTAL (parse + decisions + dump + wire + completion)',
      setupWs,
      async ({ e }) => {
        const body = ws.normalizeResponseBody(JSON.parse(bodyText))
        const comparison = ws.requestComparison(e, body)
        ws.shouldPrewarm(e, body, comparison)
        const continued = ws.withContinuation(e, body, comparison)
        const sent = ws.applyTurnId(e, continued, body, comparison)
        await dumpCodexRequest({
          sessionID: 'bench',
          transport: 'websocket',
          phase: 'main',
          bodyText: () => JSON.stringify(sent),
        })
        JSON.stringify({ type: 'response.create', ...sent })
        ws.updateContinuation(e, body, event, finalized, true, comparison)
      },
    )
  }
} finally {
  await rm(work, { recursive: true })
}

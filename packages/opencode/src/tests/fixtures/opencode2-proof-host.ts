// Runs the packed plugin in the OpenCode 2 CLI pinned by the
// `opencode2-host` fixture (2.0.22), against the loopback Codex mock in
// `opencode2-proof-codex.ts`, which records exact bytes and refuses a frame
// chained to a response it never produced. A probe plugin wraps the packed
// `./server` entry and records every session hook the host runs for the
// `openai` provider. The probe can also rewrite outbound WebSocket frames,
// capture the final owned HTTP request, and replay it out of band; a loopback
// control endpoint inside the host process lets the test ask it to.
//
// Everything that is not the loopback mock goes to a dead proxy, as in
// `opencode2-e2e.test.ts`.

import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import { MOCK_ACCOUNTS, type MockAccount } from './opencode2-mock-codex'
import { PACKAGE_NAME } from './opencode2-pack'
import {
  type ProofCodex,
  type ProofRecord,
  startProofCodex,
} from './opencode2-proof-codex'

export const PROOF_PLACEHOLDER = placeholderSecret('openai')
const PASSWORD = 'openai-auth-proof-loopback-only'
const HOUR = 3600_000
const POOL_MODULE = resolve(import.meta.dir, 'opencode2-proof-pool.ts')

export interface TraceEvent {
  readonly seq: number
  readonly at: number
  readonly hook: string
  readonly pid?: number
  readonly sessionID?: string
  readonly kind?: string
  readonly agent?: string
  readonly [key: string]: unknown
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => done(port))
    })
  })
}

function isolatedEnv(root: string) {
  const dirs = {
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
    XDG_STATE_HOME: join(root, 'xdg-state'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'),
    TMPDIR: join(root, 'tmp'),
  }
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  return {
    PATH: process.env.PATH ?? '',
    ...dirs,
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9',
    https_proxy: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    OPENCODE_SERVER_PASSWORD: PASSWORD,
    OPENCODE_PASSWORD: PASSWORD,
    OPENCODE_OPENAI_AUTH_LOG_FILE: join(root, 'openai-auth.log'),
    OPENCODE_OPENAI_AUTH_LOG_LEVEL: 'debug',
  }
}

/** Two (or more) equal-quota pool accounts in the migrated layout. */
function seedPool(
  configDir: string,
  accounts: MockAccount[],
  used: Partial<Record<MockAccount, number>>,
  keepWarm = false,
) {
  mkdirSync(configDir, { recursive: true })
  const checkedAt = Date.now()
  const rowId = (account: MockAccount) => (account === 'A' ? 'main' : account)
  writeFileSync(
    join(configDir, 'openai-auth.json'),
    JSON.stringify({
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      routing: { mode: 'sticky-balanced' },
      ...(keepWarm ? { cacheKeep: { enabled: true } } : {}),
      accounts: accounts.map((account) => ({
        id: rowId(account),
        type: 'oauth',
        label: account,
        enabled: true,
        accountId: MOCK_ACCOUNTS[account].id,
        addedAt: 1,
      })),
      commonAuthPool: {
        schemaVersion: 1,
        rows: Object.fromEntries(
          accounts.map((account) => [
            rowId(account),
            {
              credentialEpoch: 1,
              needsFirstReading: false,
              quota: {
                limits: [
                  {
                    scope: 'all',
                    label: 'primary',
                    kind: 'reading',
                    checkedAt,
                    usedPercent: used[account] ?? 10,
                    resetsAt: new Date(checkedAt + 2 * HOUR).toISOString(),
                    windowMinutes: 300,
                  },
                ],
              },
            },
          ]),
        ),
      },
      openaiAuthPool: { migratedAt: Date.now() - 60_000 },
    }),
  )
  writeFileSync(
    join(configDir, 'openai-auth-state.json'),
    JSON.stringify({
      version: 1,
      accounts: Object.fromEntries(
        accounts.map((account) => [
          rowId(account),
          {
            access: MOCK_ACCOUNTS[account].token,
            refresh: `refresh-${account}`,
            expires: Date.now() + 24 * HOUR,
          },
        ]),
      ),
    }),
  )
}

/** Replaces one account's stored access token, as a refresh would. */
export function rotateToken(configDir: string, row: string, access: string) {
  const path = join(configDir, 'openai-auth-state.json')
  const state = JSON.parse(readFileSync(path, 'utf8'))
  state.accounts[row] = { ...state.accounts[row], access }
  writeFileSync(path, JSON.stringify(state))
}

async function waitForServer(url: string, child: Bun.Subprocess) {
  const deadline = Date.now() + 60_000
  const authorization = `Basic ${btoa(`opencode:${PASSWORD}`)}`
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`host exited early with ${child.exitCode}`)
    try {
      const response = await fetch(`${url}/api/info`, {
        headers: { authorization },
        signal: AbortSignal.timeout(1000),
      })
      await response.body?.cancel()
      if (response.status === 200) return
    } catch {}
    await Bun.sleep(250)
  }
  throw new Error(`host at ${url} did not become ready`)
}

async function collect(
  stream: ReadableStream<Uint8Array> | null | undefined,
  into: string[],
) {
  if (!stream) return
  const decoder = new TextDecoder()
  for await (const chunk of stream)
    into.push(decoder.decode(chunk, { stream: true }))
}

/**
 * The probe plugin: the packed entry first, then a recorder for every session
 * hook. Registered after the packed plugin, its `experimental.ws.send` and
 * `http.request` callbacks see what the plugin left in the draft.
 */
function probeSource(trace: string) {
  return `import plugin, { createOpenAIAuthPlugin } from '${PACKAGE_NAME}/server'
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
const TRACE = ${JSON.stringify(trace)}
let seq = 0
const rec = (hook, data = {}) => appendFileSync(TRACE, JSON.stringify({ seq: ++seq, at: Date.now(), pid: process.pid, hook, ...data }) + '\\n')
const scope = (d) => ({ sessionID: d.sessionID, kind: d.kind, agent: d.agent })
const bytes = (value) => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value) ?? '', 'utf8')
const redactHeaders = (headers) => Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, /^(authorization|cookie)$/i.test(k) ? '<redacted:' + String(v).slice(0, 13) + '>' : v]))
const hostView = (messages) => messages.flatMap((m) => {
  if (m.role === 'system') return []
  return (m.content ?? []).flatMap((p) => {
    if (p.type === 'text') return [m.role + ':' + p.text]
    if (p.type === 'tool-call') return ['call:' + p.id + ':' + p.name]
    if (p.type === 'tool-result') return ['result:' + p.id]
    if (p.type === 'compaction') return ['compaction']
    return []
  })
})
let frames = 0
// A fake clock drives the real plugin manager, not a separate replay adapter.
// Its timer is counted rather than scheduled so the test controls every warm.
const cacheState = globalThis[Symbol.for('proof-cache-clock')] ??= { now: Date.now(), armed: 0, cleared: 0 }
const keepWarm = process.env.PROOF_CACHE_KEEP === '1'
const packed = keepWarm ? createOpenAIAuthPlugin({
  now: () => cacheState.now,
  cacheKeep: {
    setIntervalImpl: () => { cacheState.armed++; return { unref() {} } },
    clearIntervalImpl: () => { cacheState.cleared++ },
  },
}) : plugin
const cacheEntries = () => [...(globalThis[Symbol.for('@cortexkit/openai-auth/opencode2-cache-keep')]?.values() ?? [])]
export default { ...plugin, async setup(ctx) {
  // With PROOF_HOST_FRAMES, a recorder registered before the plugin's own
  // hooks keeps each frame as the host built it, and when the plugin got it.
  const early = process.env.PROOF_HOST_FRAMES === '1' ? await ctx.session.hook('experimental.ws.send', (d) => rec('ws.send.host', { ...scope(d), frame: d.frame }), { providerID: 'openai' }) : undefined
  const dispose = await packed.setup(ctx)
  const location = ctx.location?.directory
  rec('setup', { location })
  const regs = early ? [early] : []
  const hook = async (name, fn) => regs.push(await ctx.session.hook(name, fn, { providerID: 'openai' }))
  // P6: the last owned primary HTTP request of each session, without a credential.
  const captures = new Map()
  // P6: the WebSocket conversation of each session as rebuilt from its frames.
  const mirrors = new Map()
  const turnState = new Map()
  const events = new AbortController()
  void (async () => { try { for await (const event of ctx.event.subscribe({ signal: events.signal })) {
    if (event.type === 'session.deleted') { rec('session.deleted', { sessionID: event.data.sessionID }); captures.delete(event.data.sessionID); mirrors.delete(event.data.sessionID) }
  } } catch (error) { if (!events.signal.aborted) rec('event-error', { error: String(error) }) } })()
  const parentOf = async (sessionID) => { try { return (await ctx.session.get({ sessionID }))?.parentID ?? null } catch (e) { return 'error:' + String(e) } }
  for (const name of ['context', 'compaction', 'generate']) {
    await hook(name, async (d) => {
      const view = hostView(d.messages)
      rec(name, { ...scope(d), kind: name === 'context' ? 'primary' : name, parentID: await parentOf(d.sessionID), messages: d.messages.length, contextBytes: bytes({ system: d.system, messages: d.messages, tools: d.tools }), messagesBytes: bytes(d.messages), toolNames: Object.keys(d.tools ?? {}), view })
    })
  }
  await hook('title', (d) => rec('title', { sessionID: d.sessionID, messages: d.messages.length }))
  await hook('model.request', (d) => rec('model.request', { ...scope(d), draftKeys: Object.keys(d), baseURL: d.baseURL, headers: redactHeaders(d.headers) }))
  await hook('http.request', async (d) => {
    const text = await d.request.clone().text()
    const headers = Object.fromEntries(d.request.headers)
    rec('http.request', { ...scope(d), url: d.request.url, bodyBytes: bytes(text), headers: redactHeaders(headers), body: (() => { try { const b = JSON.parse(text); return { keys: Object.keys(b), store: b.store, cacheKey: b.prompt_cache_key, inputItems: Array.isArray(b.input) ? b.input.length : null, tools: Array.isArray(b.tools) ? b.tools.length : null, capped: 'max_output_tokens' in b } } catch { return null } })() })
    const owned = /^Bearer /.test(headers.authorization ?? '') && headers.authorization !== 'Bearer ${PROOF_PLACEHOLDER}'
    if (d.kind === 'primary' && owned) {
      const keep = {}
      for (const [k, v] of Object.entries(headers)) if (!/^(authorization|cookie|chatgpt-account-id|content-length)$/i.test(k)) keep[k] = v
      captures.set(d.sessionID, { url: d.request.url, body: text, headers: keep, account: headers['chatgpt-account-id'] })
    }
  })
  await hook('http.response', (d) => rec('http.response', { ...scope(d), status: d.response.status }))
  await hook('experimental.ws.handshake', (d) => rec('ws.handshake', { ...scope(d), draftKeys: Object.keys(d), url: d.url, headers: redactHeaders(d.headers) }))
  await hook('experimental.ws.send', (d) => {
    let frame = d.frame
    let body
    try { body = JSON.parse(frame) } catch {}
    const seen = { ...scope(d), frameBytes: bytes(frame), keys: body ? Object.keys(body) : [], previous: body?.previous_response_id ?? null, inputItems: Array.isArray(body?.input) ? body.input.length : null, cacheKey: body?.prompt_cache_key ?? null, inputTypes: Array.isArray(body?.input) ? body.input.map((i) => i?.type ?? i?.role) : null, clientMetadata: body?.client_metadata ?? null }
    if (process.env.PROOF_REWRITE === '1' && body?.type === 'response.create') {
      // A benign marker on the frame's metadata, and a different field order:
      // input moves ahead of every other field but type, model goes last.
      // The marker also carries a turn number the probe derives from frames
      // alone: a turn starts when the conversation's last user message is
      // one the server has not seen before.
      const marker = 'proof-p1-' + process.pid + '-' + (++frames)
      const mirror = mirrors.get(d.sessionID)
      const known = body.previous_response_id ? mirror?.byResponse.get(body.previous_response_id) : undefined
      const input = Array.isArray(body.input) ? body.input : []
      const whole = body.previous_response_id ? (known ? [...known.conversation, ...known.output, ...input] : input) : input
      const lastUser = JSON.stringify(whole.findLast((item) => item && item.role === 'user') ?? null)
      const turns = turnState.get(d.sessionID) ?? { n: 0, lastUser: undefined }
      if (lastUser !== turns.lastUser) { turns.n++; turns.lastUser = lastUser }
      turnState.set(d.sessionID, turns)
      const { type, input: _input, model, ...rest } = body
      rest.client_metadata = { ...(rest.client_metadata ?? {}), 'x-proof-marker': marker, 'x-proof-turn': String(turns.n) }
      frame = JSON.stringify({ type, input, ...rest, model })
      d.frame = frame
      seen.marker = marker
      seen.turn = turns.n
      seen.replacement = frame
    }
    if (process.env.PROOF_HOST_FRAMES === '1') seen.sent = frame
    rec('ws.send', seen)
    // Mirror: the full conversation the server now holds for this send.
    if (body?.type === 'response.create') {
      const prior = body.previous_response_id ? mirrors.get(d.sessionID)?.byResponse.get(body.previous_response_id) : undefined
      const input = Array.isArray(body.input) ? body.input : []
      const conversation = body.previous_response_id ? (prior ? [...prior.conversation, ...prior.output, ...input] : undefined) : input
      const { type: _t, previous_response_id: _p, ...fields } = JSON.parse(frame)
      const mirror = mirrors.get(d.sessionID) ?? { byResponse: new Map(), pending: undefined, output: [], last: undefined }
      mirror.pending = { conversation, fields }
      mirror.output = []
      mirrors.set(d.sessionID, mirror)
    }
  })
  await hook('experimental.ws.receive', (d) => {
    let event
    try { event = JSON.parse(d.frame) } catch {}
    rec('ws.receive', { ...scope(d), type: event?.type ?? null, responseID: event?.response?.id ?? null, code: event?.error?.code ?? event?.error?.type ?? null })
    const mirror = mirrors.get(d.sessionID)
    if (!mirror?.pending) return
    if (event?.type === 'response.output_item.done' && event.item) mirror.output.push(event.item)
    if (event?.type === 'response.completed' && event.response?.id) {
      const entry = { conversation: mirror.pending.conversation, output: mirror.output.slice(), fields: mirror.pending.fields }
      if (entry.conversation) mirror.byResponse.set(event.response.id, entry)
      mirror.last = entry
      mirror.pending = undefined
    }
  })
  await hook('retry', (d) => rec('retry', { sessionID: d.sessionID, attempt: d.attempt, decision: d.decision, error: String(d.error?.message ?? '').slice(0, 200) }))

  // The control endpoint the test drives the probe with.
  const pool = process.env.PROOF_POOL === '1' ? await import(${JSON.stringify(POOL_MODULE)}) : undefined
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const sessionID = url.searchParams.get('session')
    const reply = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    try {
      if (url.pathname === '/cache' || url.pathname === '/cache-tick') {
        if (!keepWarm) return reply(409, { error: 'plugin keep-warm not enabled' })
        const entries = cacheEntries()
        if (url.pathname === '/cache-tick') {
          cacheState.now += Number(url.searchParams.get('advance') ?? 0)
          for (const entry of entries) await entry.manager.tick()
        }
        return reply(200, { managers: entries.length, holders: entries.map(e => e.holders.length), armed: cacheState.armed, cleared: cacheState.cleared, status: entries.map(e => e.manager.status()) })
      }
      if (url.pathname === '/record-account') {
        // Simulate the adapter's recorded primary choice before its HTTP
        // capture arrives, so a stale target is tested in that narrow gap.
        const accounts = globalThis[Symbol.for('@cortexkit/openai-auth/opencode2-session-accounts')]
        for (const registry of accounts?.values() ?? []) registry.record(sessionID, url.searchParams.get('account'))
        return reply(200, { recorded: true })
      }
      if (url.pathname === '/replay-http') {
        const capture = captures.get(sessionID)
        if (!capture) return reply(404, { error: 'no capture' })
        const body = JSON.parse(capture.body)
        body.store = false
        delete body.max_output_tokens
        const access = await pool.freshAccess(process.env.PROOF_CONFIG_DIR, capture.account)
        if (!access) return reply(409, { error: 'no fresh access' })
        rec('replay', { sessionID, transport: 'http', row: access.row, account: capture.account, bodyBytes: bytes(JSON.stringify(body)) })
        const response = await fetch(capture.url, { method: 'POST', headers: { ...capture.headers, authorization: 'Bearer ' + access.token, 'chatgpt-account-id': capture.account }, body: JSON.stringify(body) })
        const text = await response.text()
        const completed = /event: response\\.completed/.test(text)
        rec('replay-result', { sessionID, status: response.status, completed })
        return reply(200, { status: response.status, completed, row: access.row, cacheKey: body.prompt_cache_key, headers: Object.keys(capture.headers) })
      }
      if (url.pathname === '/replay-ws') {
        const mirror = mirrors.get(sessionID)
        const last = mirror?.last
        if (!last?.conversation) return reply(404, { error: 'no full conversation', frames: mirror ? mirror.byResponse.size : 0 })
        const body = { ...last.fields, input: [...last.conversation, ...last.output], store: false }
        delete body.max_output_tokens
        return reply(200, { body })
      }
      if (url.pathname === '/captures') return reply(200, { sessions: [...captures.keys()], mirrors: [...mirrors.keys()] })
      reply(404, { error: 'unknown' })
    } catch (error) { reply(500, { error: String(error && error.stack || error) }) }
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  rec('control', { location, port: server.address().port })
  return async () => {
    rec('dispose', { location })
    events.abort()
    server.close()
    for (const r of regs) await r.dispose()
    await dispose?.()
  }
} }
`
}

/** A plugin standing for another vendor: it grows every request's context. */
function thirdPartySource(trace: string) {
  return `import { appendFileSync } from 'node:fs'
export default { id: 'proof-third-party', async setup(ctx) {
  const reg = await ctx.session.hook('context', (d) => {
    if (process.env.PROOF_THIRD_PARTY !== '1') return
    d.system.push({ type: 'text', text: 'THIRD-PARTY-CONTEXT ' + 'x'.repeat(Number(process.env.PROOF_THIRD_PARTY_BYTES ?? 20000)) })
    appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ seq: 0, at: Date.now(), hook: 'third-party.context', sessionID: d.sessionID }) + '\\n')
  })
  return () => reg.dispose()
} }
`
}

export interface ProofHost {
  readonly root: string
  readonly project: string
  readonly configDir: string
  readonly mock: ProofCodex
  readonly url: string
  /** Runs one `opencode run` turn and returns its session id. */
  turn(
    text: string,
    options?: { session?: string; continue?: boolean },
  ): Promise<{
    exit: number | null
    sessionID?: string
    stdout: string
    stderr: string
  }>
  /** Calls the host's HTTP API. */
  api(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }>
  /** Calls the probe's control endpoint in the newest plugin setup. */
  control(
    path: string,
  ): Promise<{ status: number; json: Record<string, unknown> }>
  trace(): TraceEvent[]
  records(): ProofRecord[]
  pluginLog(): string
  hostLog(): string
  stop(): Promise<void>
}

export async function startProofHost(input: {
  cli: string
  consumer: string
  transport: 'http' | 'websocket'
  accounts: MockAccount[]
  used?: Partial<Record<MockAccount, number>>
  rewrite?: boolean
  /**
   * Records each WebSocket frame as the host built it (`ws.send.host`, from
   * a hook registered before the plugin's) and as it left the plugin
   * (`sent` on `ws.send`).
   */
  hostFrames?: boolean
  thirdParty?: { bytes: number }
  pool?: boolean
  /** Enable the plugin's real manager, with a manually advanced clock. */
  keepWarm?: boolean
  /** OpenCode 2's own `warming` setting, if the scenario turns it on. */
  warming?: unknown
  model?: string
  /** Extra tokens the mock accepts for an account (a rotated token). */
  aliases?: Record<string, { account: MockAccount; label: string }>
  /** The credential the host prepares; the pool placeholder by default. */
  apiKey?: string
  /** Whether the mock reports quota; see `startProofCodex`. */
  quota?: boolean
  /** OpenCode 2's own `compaction` setting. */
  compaction?: unknown
}): Promise<ProofHost> {
  const root = mkdtempSync(join(tmpdir(), 'oai-oc2-proof-'))
  const project = join(root, 'project')
  mkdirSync(project, { recursive: true })
  spawnSync('git', ['init', '-q'], { cwd: project })
  const toolFile = join(project, 'README.md')
  writeFileSync(toolFile, '# proof project\n')
  const mock = startProofCodex({
    toolFile,
    aliases: input.aliases,
    quota: input.quota,
  })
  const isolated = isolatedEnv(root)
  const trace = join(root, 'trace.jsonl')
  writeFileSync(trace, '')
  const configDir = join(isolated.XDG_CONFIG_HOME, 'opencode')
  seedPool(configDir, input.accounts, input.used ?? {}, input.keepWarm)
  const probe = join(
    input.consumer,
    `proof-probe-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(probe, { recursive: true })
  writeFileSync(join(probe, 'index.js'), probeSource(trace))
  const third = join(
    input.consumer,
    `proof-third-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(third, { recursive: true })
  writeFileSync(join(third, 'index.js'), thirdPartySource(trace))
  const env: Record<string, string> = {
    ...isolated,
    PROOF_REWRITE: input.rewrite ? '1' : '0',
    PROOF_HOST_FRAMES: input.hostFrames ? '1' : '0',
    PROOF_POOL: input.pool ? '1' : '0',
    PROOF_CACHE_KEEP: input.keepWarm ? '1' : '0',
    PROOF_CONFIG_DIR: configDir,
    PROOF_THIRD_PARTY: input.thirdParty ? '1' : '0',
    PROOF_THIRD_PARTY_BYTES: String(input.thirdParty?.bytes ?? 0),
  }
  const model = input.model ?? 'gpt-5.5'
  writeFileSync(
    join(configDir, 'opencode.json'),
    JSON.stringify(
      {
        // The other vendor's plugin is enabled before the probe, so the
        // probe's context hook sees what it added.
        plugins: [third, probe],
        ...(input.warming === undefined ? {} : { warming: input.warming }),
        ...(input.compaction === undefined
          ? {}
          : { compaction: input.compaction }),
        providers: {
          openai: {
            settings: {
              apiKey: input.apiKey ?? PROOF_PLACEHOLDER,
              baseURL: `${mock.url}/v1`,
              transport: input.transport,
            },
            models: { [model]: { name: `${model} (proof mock)` } },
          },
        },
      },
      null,
      2,
    ),
  )
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const hostLog: string[] = []
  const server = Bun.spawn(
    [
      input.cli,
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
      '--print-logs',
      '--log-level',
      'info',
    ],
    { cwd: project, env, stdout: 'pipe', stderr: 'pipe' },
  )
  const output = Promise.all([
    collect(server.stdout, hostLog),
    collect(server.stderr, hostLog),
  ])
  await waitForServer(url, server)
  const authorization = `Basic ${btoa(`opencode:${PASSWORD}`)}`
  const readTrace = () =>
    readFileSync(trace, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TraceEvent)
  let lastSession: string | undefined
  return {
    root,
    project,
    configDir,
    mock,
    url,
    async turn(text, options = {}) {
      const args = [
        'run',
        '--server',
        url,
        '--format',
        'json',
        '--model',
        `openai/${model}`,
        ...(options.session ? ['--session', options.session] : []),
        ...(options.continue ? ['--continue'] : []),
        text,
      ]
      const child = Bun.spawn([input.cli, ...args], {
        cwd: project,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const out: string[] = []
      const err: string[] = []
      const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
      await Promise.all([
        collect(child.stdout, out),
        collect(child.stderr, err),
        child.exited,
      ])
      clearTimeout(timer)
      const stdout = out.join('')
      const sessionID = /"sessionID"\s*:\s*"(ses_[^"]+)"/.exec(stdout)?.[1]
      if (sessionID) lastSession = sessionID
      return {
        exit: child.exitCode,
        sessionID: sessionID ?? lastSession,
        stdout,
        stderr: err.join(''),
      }
    },
    async api(method, path, body) {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: {
          authorization,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          'x-opencode-directory': project,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await response.text()
      let json: unknown = text
      try {
        json = JSON.parse(text)
      } catch {}
      return { status: response.status, json }
    },
    async control(path) {
      const port = readTrace()
        .filter((event) => event.hook === 'control')
        .at(-1)?.port
      if (!port) throw new Error('the probe has no control endpoint')
      const response = await fetch(`http://127.0.0.1:${port}${path}`)
      return {
        status: response.status,
        json: (await response.json()) as Record<string, unknown>,
      }
    },
    trace: readTrace,
    records: () => [...mock.records],
    pluginLog: () => {
      try {
        return readFileSync(isolated.OPENCODE_OPENAI_AUTH_LOG_FILE, 'utf8')
      } catch {
        return ''
      }
    },
    hostLog: () => hostLog.join(''),
    async stop() {
      server.kill('SIGTERM')
      const timer = setTimeout(() => server.kill('SIGKILL'), 15_000)
      await server.exited
      clearTimeout(timer)
      await output
      await mock.stop()
      rmSync(probe, { recursive: true, force: true })
      rmSync(third, { recursive: true, force: true })
      if (process.env.PROOF_KEEP !== '1')
        rmSync(root, { recursive: true, force: true })
    },
  }
}

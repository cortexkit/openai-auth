import { afterEach, expect, spyOn, test } from 'bun:test'
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { PrivateFileError } from '@cortexkit/common-auth/fs'
import type {
  Attempt,
  OpenCode2AuthAdapter,
} from '@cortexkit/common-auth/opencode2'
import * as auth from '@cortexkit/common-auth/opencode2'
import { resetSettingsForTest } from '../config'
import * as requestDump from '../dump'
import { flushForTest, setLogLevel } from '../logger'
import { RequestDumps } from '../v2/request-dumps'
import { setupOpenAIAuth } from '../v2/setup'
import {
  fakeOpenCode2Host,
  poolFiles,
  scope,
  seedPool,
} from './fixtures/opencode2-host'
import { restoreEnv } from './setup-env'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  resetSettingsForTest()
  requestDump.resetDumpStateForTest()
  setLogLevel(undefined)
})

async function start(enabled = true) {
  await flushForTest()
  const files = poolFiles()
  cleanups.push(() => rmSync(files.dir, { recursive: true, force: true }))
  seedPool(files, 'main-first', [
    {
      id: 'main',
      access: 'dump-private-token',
      identity: 'private-chatgpt-id',
    },
  ])
  const dir = join(files.dir, 'dumps')
  const log = join(files.dir, 'dump.log')
  const env = {
    OPENCODE_OPENAI_AUTH_FILE: files.configPath,
    OPENCODE_OPENAI_AUTH_DUMP_DIR: dir,
    OPENCODE_OPENAI_AUTH_LOG_FILE: log,
    CORTEXKIT_OPENAI_AUTH_DUMP: enabled ? '1' : '0',
  }
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key]
    process.env[key] = value
    cleanups.push(() => restoreEnv(key, previous))
  }
  resetSettingsForTest()
  requestDump.resetDumpStateForTest()
  const attempts: Attempt[] = []
  let installed!: OpenCode2AuthAdapter
  const install = auth.installOpenCode2Auth
  const spy = spyOn(auth, 'installOpenCode2Auth').mockImplementation(
    (ctx, adapter, options) => {
      installed = adapter
      return install(
        ctx,
        {
          ...adapter,
          rewriteRequest: async (input) => {
            attempts.push(input.attempt)
            return adapter.rewriteRequest?.(input)
          },
        },
        options,
      )
    },
  )
  cleanups.push(() => spy.mockRestore())
  const host = fakeOpenCode2Host()
  const stop = await setupOpenAIAuth(host.ctx, {
    paths: files.paths,
    heartbeat: false,
    sidebarStateFile: join(files.dir, 'sidebar.json'),
    fetch: Object.assign(async () => new Response('{}', { status: 503 }), {
      preconnect: () => {},
    }),
    vault: {
      stateDir: join(files.dir, 'vault'),
      connectionFile: () => join(files.dir, 'no-vault.json'),
      pollIntervalMs: 0,
    },
  })
  cleanups.push(async () => {
    await stop?.()
  })
  const body = JSON.stringify({
    model: 'gpt-5.5',
    input: [],
    tools: [
      {
        type: 'function',
        name: 'tool',
        parameters: {
          type: 'object',
          properties: { api_key: { type: 'string' } },
        },
      },
    ],
    email: 'private@example.test',
    token: 'body-private-token',
  })
  async function request(
    kind: 'primary' | 'title' = 'primary',
    bearer = auth.placeholderSecret('openai'),
  ) {
    return host.fire('http.request', {
      ...scope('dump-session', kind),
      request: new Request('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearer}`,
          cookie: 'private-cookie',
          'content-type': 'application/json',
          'x-final-fixture': kind,
        },
        body,
      }),
    })
  }
  async function response(
    draft: Awaited<ReturnType<typeof request>>,
    response = new Response('ok'),
  ) {
    return (await host.fire('http.response', { ...draft, response })).response
  }
  function records() {
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((name) => name.endsWith('.meta.json'))
      .map((name) => {
        const prefix = join(dir, name.slice(0, -'.meta.json'.length))
        return {
          meta: JSON.parse(readFileSync(`${prefix}.meta.json`, 'utf8')),
          request: JSON.parse(readFileSync(`${prefix}.request.json`, 'utf8')),
          body: JSON.parse(readFileSync(`${prefix}.body.json`, 'utf8')),
        }
      })
  }
  return {
    files,
    host,
    dir,
    log,
    body,
    request,
    response,
    records,
    attempts,
    stop: async () => {
      await stop?.()
    },
    // OpenCode 2's retry callback carries a session id, not the failed Request.
    // Call onAttemptEnd with a chosen Attempt to test request-specific errors
    // while the real setup still captures and correlates the outgoing Request.
    end: (
      index: number,
      error: { reason: 'failed' | 'cancelled' | 'abandoned'; message?: string },
    ) =>
      installed.onAttemptEnd?.(attempts[index]!, {
        outputStarted: false,
        error,
      }),
  }
}

for (const status of [200, 400, 503]) {
  test(`OpenCode 2 dumps final merged HTTP request once at status ${status}`, async () => {
    const f = await start()
    const draft = await f.request()
    const sent = draft.request
    const actual = await f.response(draft, new Response('ok', { status }))
    expect(actual.status).toBe(status)
    await actual.text()
    await f.end(0, { reason: 'failed', message: 'late failure' })
    const [record] = f.records()
    expect(f.records()).toHaveLength(1)
    expect(record!.meta).toMatchObject({
      session: 'dump-session',
      channel: 'http',
      phase: 'http',
      accountId: 'main',
      status,
    })
    expect(record!.meta.error).toBeUndefined()
    expect(record!.request).toMatchObject({
      url: sent.url,
      method: sent.method,
      headers: {
        'session-id': sent.headers.get('session-id'),
        'x-final-fixture': 'primary',
        authorization: '***REDACTED***',
        cookie: '***REDACTED***',
        'chatgpt-account-id': '***REDACTED***',
      },
    })
    expect(record!.request.error).toBeUndefined()
    expect(record!.body.tools).toEqual([
      { ...JSON.parse(f.body).tools[0], strict: false },
    ])
    expect(record!.body.model).toBe('gpt-5.5')
    expect(statSync(f.dir).mode & 0o777).toBe(0o700)
    for (const name of readdirSync(f.dir))
      expect(statSync(join(f.dir, name)).mode & 0o777).toBe(0o600)
    const text = readdirSync(f.dir)
      .map((name) => readFileSync(join(f.dir, name), 'utf8'))
      .join('\n')
    for (const secret of [
      'dump-private-token',
      'private-cookie',
      'private-chatgpt-id',
      'private@example.test',
      'body-private-token',
    ])
      expect(text).not.toContain(secret)
  })
}

test('OpenCode 2 dumps off create no directory', async () => {
  const f = await start(false)
  await (await f.response(await f.request())).text()
  expect(existsSync(f.dir)).toBe(false)
})

test('OpenCode 2 non-owned HTTP requests write no dump and stay unchanged', async () => {
  const f = await start()
  for (const bearer of ['api-key-private', 'builtin-oauth-private']) {
    const draft = await f.request('primary', bearer)
    expect(await draft.request.clone().text()).toBe(f.body)
    expect(draft.request.headers.get('authorization')).toBe(`Bearer ${bearer}`)
    expect(draft.request.url).toBe('https://api.openai.com/v1/responses')
    await (await f.response(draft)).text()
  }
  expect(f.attempts).toHaveLength(0)
  expect(f.records()).toEqual([])
  expect(existsSync(f.dir)).toBe(false)
})

for (const reason of ['failed', 'cancelled', 'abandoned'] as const) {
  test(`OpenCode 2 no-response dump records ${reason} without status`, async () => {
    const f = await start()
    await f.request()
    await f.end(0, {
      reason,
      ...(reason === 'failed' ? { message: 'before headers' } : {}),
    })
    const records = f.records()
    expect(records).toHaveLength(1)
    expect(records[0]!.meta.error).toBe(
      reason === 'failed' ? 'failed: before headers' : reason,
    )
    expect(records[0]!.meta.status).toBeUndefined()
    expect(records[0]!.request.status).toBeUndefined()
  })
}

for (const order of [
  [0, 1],
  [1, 0],
]) {
  test(`OpenCode 2 overlapping failures keep request errors in order ${order.join('-')}`, async () => {
    const f = await start()
    await Promise.all([f.request('primary'), f.request('title')])
    for (const index of order) {
      const attempt = f.attempts[index]!
      await f.end(index, {
        reason: 'failed',
        message: `${attempt.kind} before headers`,
      })
    }
    expect(f.records()).toHaveLength(2)
    for (const record of f.records())
      expect(record.meta.error).toBe(
        `failed: ${record.request.headers['x-final-fixture']} before headers`,
      )
  })
}

for (const mode of ['failed', 'cancelled'] as const) {
  test(`OpenCode 2 response dump closes before stream is ${mode}`, async () => {
    const f = await start()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
      },
    })
    const result = await f.response(
      await f.request(),
      new Response(stream, {
        headers: { 'content-type': 'text/event-stream' },
      }),
    )
    expect(f.records()).toHaveLength(1)
    if (mode === 'failed') {
      controller.error(new Error('stream stopped'))
      await expect(result.text()).rejects.toThrow('stream stopped')
    } else await result.body!.cancel()
    await f.end(0, { reason: mode })
    expect(f.records()).toHaveLength(1)
    expect(f.records()[0]!.meta.status).toBe(200)
    expect(f.records()[0]!.meta.error).toBeUndefined()
  })
}

test('OpenCode 2 observes only owned outbound WebSocket frames after rewriting', async () => {
  const f = await start()
  const handshake = async (session: string, bearer: string) =>
    f.host.fire('experimental.ws.handshake', {
      ...scope(session),
      url: 'wss://api.openai.com/v1/responses',
      headers: { authorization: `Bearer ${bearer}` },
    })
  await handshake('owned', auth.placeholderSecret('openai'))
  const frame = JSON.stringify({
    type: 'response.create',
    model: 'gpt-6.1-sol',
    input: [],
    reasoning: { effort: 'low' },
  })
  const sent = await f.host.fire('experimental.ws.send', {
    ...scope('owned'),
    frame,
  })
  await f.host.fire('experimental.ws.receive', {
    ...scope('owned'),
    frame: JSON.stringify({ type: 'response.completed' }),
  })
  await handshake('other', 'builtin-private')
  await f.host.fire('experimental.ws.send', { ...scope('other'), frame })
  const records = f.records()
  expect(records).toHaveLength(1)
  expect(records[0]!.meta).toMatchObject({
    session: 'owned',
    accountId: 'main',
    channel: 'websocket',
    phase: 'observed',
  })
  expect(records[0]!.body).toEqual(JSON.parse(sent.frame))
  const rewritten = await f.host.fire('experimental.ws.send', {
    ...scope('owned'),
    frame: JSON.stringify({
      ...JSON.parse(frame),
      reasoning: { effort: 'high' },
      input: [{ role: 'user', content: 'next' }],
    }),
  })
  expect(JSON.parse(rewritten.frame).reasoning.effort).toBe('low')
  expect(f.records()).toHaveLength(2)
  expect(f.records()[1]!.body).toEqual(JSON.parse(rewritten.frame))
})

for (const failure of ['ordinary', 'private'] as const) {
  test(`OpenCode 2 ${failure} dump write failure warns once without changing response`, async () => {
    const f = await start()
    if (failure === 'ordinary') writeFileSync(f.dir, 'not a directory')
    else {
      // POSIX uses ordinary filesystem IO. Inject the cross-platform security
      // refusal at the dumper boundary to exercise the caller's catch, not mkdir.
      const error = new PrivateFileError(f.dir, 'create', {
        code: 'ERR_PRIVATE_FILES_SECURITY',
      })
      const dump = spyOn(requestDump, 'dumpCodexRequest').mockRejectedValue(
        error,
      )
      cleanups.push(() => dump.mockRestore())
    }
    const result = await f.response(
      await f.request(),
      new Response('normal response', { status: 200 }),
    )
    expect(result.status).toBe(200)
    expect(await result.text()).toBe('normal response')
    await f.end(0, { reason: 'abandoned' })
    await flushForTest()
    const logs = readFileSync(f.log, 'utf8')
    expect(logs.match(/request dump failed/g)).toHaveLength(1)
    expect(logs.split('\n').filter((line) => /\bwarn\b/i.test(line))).toEqual([
      expect.stringContaining('request dump failed'),
    ])
    for (const secret of [
      'dump-private-token',
      'private-cookie',
      'private-chatgpt-id',
      'private@example.test',
    ])
      expect(logs).not.toContain(secret)
  })
}

test('OpenCode 2 dumps the rewritten body actually emitted over HTTP', async () => {
  const f = await start()
  const body = { model: 'gpt-5.5', input: [], max_output_tokens: 20 }
  const draft = await f.host.fire('http.request', {
    ...scope('cap-removal'),
    request: new Request('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${auth.placeholderSecret('openai')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  })
  const emitted = await draft.request.clone().json()
  const threadID = draft.request.headers.get('thread-id')
  expect(emitted).toEqual({
    model: 'gpt-5.5',
    input: [],
    parallel_tool_calls: true,
    prompt_cache_key: threadID,
    client_metadata: {
      'x-codex-installation-id': expect.any(String),
      'x-codex-window-id': `${threadID}:0`,
    },
  })
  await (await f.response(draft)).text()
  expect(f.records()).toHaveLength(1)
  expect(f.records()[0]!.body).toEqual(emitted)
})

test('OpenCode 2 bounds HTTP snapshots at 512 and drops the oldest without a dump', async () => {
  const f = await start()
  const warnings: string[] = []
  const dumps = new RequestDumps({
    warn: (message) => {
      warnings.push(message)
    },
  })
  const attempts: Attempt[] = []
  const requests: Request[] = []
  for (let index = 0; index < 513; index++) {
    const attempt: Attempt = {
      providerID: 'openai',
      modelID: 'gpt-5.5',
      sessionID: `bounded-${index}`,
      agent: 'build',
      kind: 'primary',
      accountId: 'main',
      attemptId: `bounded-${index}`,
      transport: 'http',
      data: undefined,
    }
    const request = new Request('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: '{}',
    })
    attempts.push(attempt)
    requests.push(request)
    await dumps.captureHttp(request, attempt)
  }
  await dumps.end(attempts[0]!, {
    outputStarted: false,
    error: { reason: 'abandoned' },
  })
  expect(f.records()).toEqual([])
  await dumps.response(requests[1]!, 200)
  await dumps.end(attempts[512]!, {
    outputStarted: false,
    error: { reason: 'failed', message: 'last attempt' },
  })
  expect(
    f
      .records()
      .map((record) => record.meta.session)
      .sort(),
  ).toEqual(['bounded-1', 'bounded-512'])
  expect(warnings).toEqual([])
})

test('OpenCode 2 retry is not a dump source and disposal dumps an unanswered request as abandoned', async () => {
  const f = await start()
  await f.request()
  await f.host.fire('retry', {
    ...scope('dump-session'),
    error: { type: 'network', message: 'unattributed retry error' },
    attempt: 0,
    decision: { retry: false },
  })
  expect(f.records()).toEqual([])
  await f.stop()
  expect(f.records()).toHaveLength(1)
  expect(f.records()[0]!.meta.error).toBe(
    'abandoned: the installation was disposed',
  )
  expect(f.records()[0]!.meta.status).toBeUndefined()
})

test('OpenCode 2 no-response error text redacts the serving credential', async () => {
  const f = await start()
  await f.request()
  await f.end(0, {
    reason: 'failed',
    message: 'network rejected dump-private-token',
  })
  expect(f.records()).toHaveLength(1)
  expect(f.records()[0]!.meta.error).toContain('failed: network rejected')
  for (const name of readdirSync(f.dir))
    expect(readFileSync(join(f.dir, name), 'utf8')).not.toContain(
      'dump-private-token',
    )
})

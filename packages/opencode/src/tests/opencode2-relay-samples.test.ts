import { afterEach, expect, mock, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { VAULT_ROUTING_REFUSAL_MESSAGE } from '@cortexkit/openai-auth-core/internal'
import { scope } from './fixtures/opencode2-host'
import {
  placementRequest,
  relayAccessorAnswer,
  restoreRoutingAccessor,
} from './fixtures/opencode2-routing'

const fixtures = new URL('./fixtures/thalamus-relay-v1/', import.meta.url)
const placementFile = '01-first-placement.json'
const generationFile = '02-generate-first-placement.json'
const exhaustedFile = '03-exhausted-continue.json'
const backoffFile = '05-transient-backoff.json'
const refusalsFile = '06-refusals.json'
const emptyViewFile = '07-synthetic-signed-out-no-alternate.json'
const anthropicFile = '08-synthetic-anthropic-first-placement.json'
const resetOnlyFile = 'refusal-timing-v2/09-pool-reserve-limited.json'
const shortWaitFile = 'refusal-timing-v2/10-selection-unavailable.json'

const at = 1_784_721_600_000
const refusal = { kind: 'no-account', message: VAULT_ROUTING_REFUSAL_MESSAGE }
const antigravityCandidates = [
  { account_id: 'identity-0', credential_id: 'credential-0' },
  { account_id: 'identity-1', credential_id: 'credential-1' },
]
const anthropicCandidates = [
  { account_id: 'a', credential_id: 'other-credential' },
  { account_id: 'b', credential_id: 'c' },
]
const fallbackCandidate = {
  account_id: 'identity-2',
  credential_id: 'credential-2',
}
const fiveHourLimit = {
  code: 'usage_limit_reached',
  window: '5h',
  resets_in_seconds: 30,
}

afterEach(restoreRoutingAccessor)

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

test.each([
  ['', '820a66b64cdc3d5f18318965d6ba7615182ff7ae847a041fa78d2aa1774df168'],
  [
    'refusal-timing-v2/',
    '4063afab14893bdcde319c585fda68519743325656c9dd39d7728f2c6d58a6ee',
  ],
])('pinned relay checksums: %sSHA256SUMS', (subdir, digest) => {
  const base = new URL(subdir, fixtures)
  const manifest = readFileSync(new URL('SHA256SUMS', base))
  expect(sha256(manifest)).toBe(digest)
  for (const line of manifest.toString('utf8').trimEnd().split('\n')) {
    const [expected, name] = line.split('  ')
    if (!expected || !name) throw new Error(`Invalid checksum line: ${line}`)
    expect(sha256(readFileSync(new URL(name, base))), name).toBe(expected)
  }
})

type Reply = { choice?: unknown; refused?: unknown }

type Capture = {
  name: string
  capabilities: string[]
  plugin_replies: { call_index: number; body: Reply }[]
  wire: { answer?: string; body: unknown }[]
}

function readSample<T>(file: string): T {
  return JSON.parse(readFileSync(new URL(file, fixtures), 'utf8')) as T
}

function capture(file: string, name: string, capability?: string) {
  const entry = readSample<Capture[]>(file).find(
    (item) =>
      item.name === name &&
      (!capability || item.capabilities.includes(capability)),
  )
  if (!entry) throw new Error(`Missing captured scenario ${name} in ${file}`)
  const replies = entry.plugin_replies
    .toSorted((a, b) => a.call_index - b.call_index)
    .map(({ body }) => body)
  return { replies, wire: entry.wire }
}

function syntheticReply(file: string) {
  return readSample<{ plugin_reply: Reply }>(file).plugin_reply
}

type Placement = Awaited<ReturnType<typeof placementRequest>>

async function replay(
  answers: readonly (Reply | undefined)[],
  options?: Parameters<typeof placementRequest>[1],
  candidates = antigravityCandidates,
) {
  const env = await placementRequest(answers, {
    ...options,
    now: () => at,
    decodeAnswer: relayAccessorAnswer,
  })
  // Use the capture's identities in the fake vault, leaving the relay reply intact.
  for (const [index, candidate] of candidates.entries()) {
    const route = env.routes[index]!
    route.identity = candidate.account_id
    route.credentialId = candidate.credential_id
  }
  // Put the local fallback before the relay's chosen route in the roster.
  env.routes.splice(1, 0, {
    ...env.routes[0]!,
    id: 'vault:c',
    identity: fallbackCandidate.account_id,
    credentialId: fallbackCandidate.credential_id,
  })
  return env
}

function recordedReport(wire: Capture['wire']) {
  const reply = wire.find(({ answer }) => answer === 'route.account_observe')
  if (!reply) throw new Error('Missing captured observation reply')
  return mock(async (_report: Record<string, unknown>) => reply.body)
}

async function provider429(
  env: Placement,
  error: { code: string; window?: string; resets_in_seconds?: number },
  headers?: HeadersInit,
) {
  const request = env.providerFetch.mock.lastCall?.[0]
  if (!request) throw new Error('No request to answer with a 429')
  const requestScope = scope(env.request.sessionID)
  const body = { error }
  await env.host.fire('http.response', {
    ...requestScope,
    request,
    response: Response.json(body, { status: 429, headers }),
  })
  return () =>
    env.host.fire('retry', {
      ...requestScope,
      attempt: 2,
      decision: { retry: true, delay: 12345 },
      error: { type: 'api', message: JSON.stringify(body), status: 429 },
    })
}

test.each([
  [placementFile, '01-first-placement', 'primary'],
  [generationFile, '02-generate-first-placement', 'generate'],
  [generationFile, '02-compaction-first-placement', 'compaction'],
  [anthropicFile, '08-synthetic-anthropic-first-placement', 'primary'],
] as const)('%s: relay placement for %s sends B', async (file, name, kind) => {
  const synthetic = file === anthropicFile
  const replies = synthetic
    ? [syntheticReply(file)]
    : capture(file, name).replies
  const candidates = synthetic ? anthropicCandidates : antigravityCandidates
  const env = await replay(replies, undefined, candidates)
  try {
    expect(await env.send(kind)).toBe('Bearer vault:b-token')
    expect(env.providerFetch).toHaveBeenCalledTimes(1)
    expect(env.authorized).toEqual(['vault:b'])
    expect(env.accountFor).toHaveBeenCalledTimes(1)
    const ask = env.accountFor.mock.calls[0]?.[0] as
      | { candidates?: { accounts: unknown[]; view_digest: string } }
      | undefined
    expect(ask).toMatchObject({
      provider: 'openai',
      refusals: true,
    })
    expect(ask?.candidates?.view_digest).toEqual(expect.any(String))
    expect(ask?.candidates?.accounts).toHaveLength(3)
    for (const candidate of [...candidates, fallbackCandidate])
      expect(ask?.candidates?.accounts).toContainEqual(candidate)
    expect(ask).not.toHaveProperty('mode')
  } finally {
    await env.dispose()
  }
})

test.each([
  [exhaustedFile, '03-exhausted-continue', true],
  [refusalsFile, '06-continue-refusal', false],
] as const)(
  '%s: %s after a five-hour limit',
  async (file, name, shouldRetry) => {
    const { replies, wire } = capture(file, name)
    const report = recordedReport(wire)
    const warn = mock((_message: string) => {})
    const env = await replay(replies, {
      report,
      log: { debug() {}, warn },
    })
    try {
      expect(await env.send()).toBe('Bearer vault:a-token')
      const retry = await provider429(env, fiveHourLimit)
      expect(report.mock.calls).toEqual([
        [
          {
            ...antigravityCandidates[0],
            outcome: 'exhausted',
            window: '5h',
            resets_at: at + 30_000,
          },
        ],
      ])
      expect(env.accountFor).toHaveBeenCalledTimes(1)
      const result = await retry()
      expect(env.accountFor).toHaveBeenCalledTimes(2)
      expect(env.accountFor.mock.calls[1]?.[0]).toMatchObject({
        mode: 'continue',
        exhausted: {
          account: 'identity-0',
          credential_id: 'credential-0',
          limit_window: 'five_hour',
          resets_at_ms: at + 30_000,
        },
      })
      expect(result.decision.retry).toBe(shouldRetry)
      if (shouldRetry) {
        expect(result.decision.delay).toBe(0)
        expect(await env.send()).toBe('Bearer vault:b-token')
        expect(env.providerFetch).toHaveBeenCalledTimes(2)
        expect(env.authorized).toEqual(['vault:a', 'vault:b'])
      } else {
        expect(warn).toHaveBeenCalledWith(VAULT_ROUTING_REFUSAL_MESSAGE)
        expect(env.providerFetch).toHaveBeenCalledTimes(1)
        expect(env.authorized).toEqual(['vault:a'])
      }
      expect(env.accountFor).toHaveBeenCalledTimes(2)
    } finally {
      await env.dispose()
    }
  },
)

test('05-transient-backoff: relay observation reply leaves the retry on A', async () => {
  const { replies, wire } = capture(
    backoffFile,
    '05-transient-backoff',
    'observe_backoff',
  )
  const report = recordedReport(wire)
  const env = await replay(replies, { report })
  try {
    expect(await env.send()).toBe('Bearer vault:a-token')
    const retry = await provider429(
      env,
      { code: 'rate_limit_exceeded' },
      { 'retry-after': '8' },
    )
    expect(report.mock.calls).toEqual([
      [
        {
          ...antigravityCandidates[0],
          kind: 'transient_backoff',
          retry_at_ms: at + 8000,
          provider_code: 'rate_limit_exceeded',
        },
      ],
    ])
    expect((await retry()).decision).toEqual({ retry: true, delay: 8000 })
    expect(await env.send()).toBe('Bearer vault:a-token')
    expect(env.providerFetch).toHaveBeenCalledTimes(2)
    expect(env.accountFor).toHaveBeenCalledTimes(1)
  } finally {
    await env.dispose()
  }
})

test.each([
  [refusalsFile, '06-first-refusal-with-retry', 30_000],
  [refusalsFile, '06-first-refusal-without-retry', 0],
  [emptyViewFile, '07-synthetic-signed-out-no-alternate', 0],
  [resetOnlyFile, '09-pool-reserve-limited', 90_000],
] as const)(
  '%s: %s stops without sending or waiting',
  async (file, name, delay) => {
    const replies =
      file === refusalsFile
        ? capture(file, name).replies
        : [syntheticReply(file)]
    const env = await replay(replies, { extraTimerDelays: [delay] })
    try {
      // Keep eligible vault routes so only the relay refusal can stop selection.
      await expect(Promise.race([env.wait, env.send()])).rejects.toMatchObject(
        refusal,
      )
      expect(env.accountFor).toHaveBeenCalledTimes(1)
      expect(env.providerFetch).not.toHaveBeenCalled()
      expect(env.authorized).toEqual([])
    } finally {
      await env.dispose()
    }
  },
)

test('10-selection-unavailable: relay short refusal waits once and re-asks', async () => {
  const env = await replay([
    syntheticReply(shortWaitFile),
    ...capture(placementFile, '01-first-placement').replies,
  ])
  try {
    const sent = env.send()
    const wait = await env.waitBeforeSend(sent)
    expect(wait.delay).toBe(3000)
    expect(env.accountFor).toHaveBeenCalledTimes(1)
    expect(env.providerFetch).not.toHaveBeenCalled()
    expect(env.authorized).toEqual([])
    wait.wake()
    expect(await sent).toBe('Bearer vault:b-token')
    expect(env.accountFor).toHaveBeenCalledTimes(2)
    expect(env.providerFetch).toHaveBeenCalledTimes(1)
    expect(env.authorized).toEqual(['vault:b'])
  } finally {
    await env.dispose()
  }
})

test('control: missing relay choices dispatch A first, then C after exhaustion', async () => {
  const env = await replay([])
  try {
    expect(await env.send()).toBe('Bearer vault:a-token')
    const retry = await provider429(env, fiveHourLimit)
    expect((await retry()).decision).toEqual({ retry: true, delay: 0 })
    expect(await env.send()).toBe('Bearer vault:c-token')
    expect(env.accountFor).toHaveBeenCalledTimes(2)
  } finally {
    await env.dispose()
  }
})

test('a valid relay choice wins when the body also contains a refusal', async () => {
  const [placement] = capture(placementFile, '01-first-placement').replies
  const env = await replay([
    { ...syntheticReply(emptyViewFile), choice: placement!.choice },
  ])
  try {
    expect(await env.send()).toBe('Bearer vault:b-token')
    expect(env.providerFetch).toHaveBeenCalledTimes(1)
    expect(env.authorized).toEqual(['vault:b'])
  } finally {
    await env.dispose()
  }
})

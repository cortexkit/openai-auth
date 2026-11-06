import { expect, test } from 'bun:test'
import {
  type BuiltRefusal,
  buildRefusal,
  createRequestHistory,
  hasUnsafeWording,
  type PolicyFacts,
  scanTerminalReset,
} from '@cortexkit/common-auth/limits'
import type { OAuthQuotaSnapshot } from '../accounts'
import { QUOTA_STALENESS_MS } from '../limit-policy'
import { LimitProvenanceStore } from '../limit-provenance'
import {
  buildOpenAiQuotaRefusal,
  decideOpenAiTerminal,
  type OpenAiTerminalAccount,
  openAiLimitMessages,
  openAiTerminalFacts,
} from '../quota-refusal'

const now = 1800000000000
const a = { namespace: 'terminal', accountId: 'a', incarnation: '1' }
const b = { ...a, accountId: 'b' }
function body(result: BuiltRefusal): string {
  if (result.kind === 'throw') throw new Error('expected a wire refusal')
  return result.body
}
function quota(
  primary: number | undefined,
  secondary?: number,
): OAuthQuotaSnapshot {
  return {
    primary: {
      usedPercent: 100,
      remainingPercent: 0,
      checkedAt: now,
      resetsAt:
        primary === undefined
          ? undefined
          : new Date(now + primary).toISOString(),
    },
    ...(secondary === undefined
      ? {}
      : {
          secondary: {
            usedPercent: 100,
            remainingPercent: 0,
            checkedAt: now,
            resetsAt: new Date(now + secondary).toISOString(),
          },
        }),
  }
}
function facts(
  phase: 'pre-send' | 'after-limit' = 'pre-send',
  host: PolicyFacts['host'] = 'opencode1',
): PolicyFacts {
  return {
    phase,
    host,
    now,
    clockNow: now,
    sessionId: 's',
    requestScope: { kind: 'pool' },
    history: createRequestHistory({
      requestId: 'request',
      originalUrl: 'https://provider.invalid/responses',
      clockNow: now,
    }),
    delivery: { owned: true, attributable: true, replayable: true },
    candidates: [],
  }
}
function terminal(
  accounts: OpenAiTerminalAccount[],
  setting: unknown = 15,
  extra = {},
) {
  return openAiTerminalFacts({
    accounts,
    effectiveModel: 'gpt-6',
    maxSameAccountWait: setting,
    now,
    ...extra,
  })
}
function deliver(
  accounts: OpenAiTerminalAccount[],
  setting: unknown = 15,
  extra = {},
  phase: 'pre-send' | 'after-limit' = 'pre-send',
) {
  const metadata = terminal(accounts, setting, extra)
  const decision = decideOpenAiTerminal(facts(phase), metadata)
  return buildOpenAiQuotaRefusal({ decision, now, maxSameAccountWait: setting })
}

test('terminal scan takes latest per account, earliest across usable accounts', () => {
  const metadata = terminal([
    { account: a, reading: quota(7200000, 345600000) },
    { account: b, reading: quota(10800000) },
  ])
  expect(scanTerminalReset(metadata.scan!, now)?.resetAt).toBe(now + 10800000)
  expect(scanTerminalReset(metadata.scan!, now)?.account).toEqual(b)
  expect(
    scanTerminalReset(
      terminal([
        { account: a, reading: quota(undefined, 7200000) },
        { account: b, reading: quota(10800000) },
      ]).scan!,
      now,
    )?.account,
  ).toEqual(b)
  expect(
    scanTerminalReset(
      terminal([
        { account: a, reading: quota(60000), usable: false },
        { account: b, reading: quota(10800000) },
      ]).scan!,
      now,
    )?.account,
  ).toEqual(b)
})

test('stale and wrong-incarnation readings do not supply terminal estimates or causes', () => {
  const reading = quota(60000)
  reading.primary!.checkedAt = now - QUOTA_STALENESS_MS - 1
  const metadata = terminal([
    { account: a, reading },
    {
      account: b,
      reading: quota(60000),
      readingAccount: { ...b, incarnation: 'old' },
    },
  ])
  expect(scanTerminalReset(metadata.scan!, now)).toBeUndefined()
  expect(metadata.messageKey).toBe('timed-mark')
})

test.each(['pre-send', 'after-limit'] as const)(
  'OA-36 %s pins unproven and provider mark wire bodies at every setting',
  (phase) => {
    const accounts = [
      { account: a, marks: [{ until: now + 90000, evidenceAt: now }] },
    ]
    const zero = deliver(accounts, 0, {}, phase)
    expect(zero.kind).toBe('http')
    if (zero.kind !== 'http') throw new Error('expected HTTP refusal')
    expect(zero.status).toBe(412)
    expect(zero.headers.get('retry-after')).toBeNull()
    expect(zero.body).toBe(
      '{"error":{"code":412,"status":"FAILED_PRECONDITION","message":"Every OpenAI account is paused by OpenAI for now."}}',
    )
    for (const setting of [15, 'max']) {
      const result = deliver(accounts, setting, {}, phase)
      if (result.kind !== 'http') throw new Error('expected HTTP refusal')
      expect(result.status).toBe(429)
      expect(result.headers.get('retry-after')).toBe('300')
      expect(result.body).toBe(
        '{"error":{"message":"OpenAI rate limit reached — retrying on another account. Retry in 5m.","type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}',
      )
    }
    const provenance = new LimitProvenanceStore('terminal')
    provenance.record(
      {
        accountKey: a,
        expiry: now + 90000,
        branch: 'provider',
        observedAt: now,
        evidenceAt: now,
      },
      now,
    )
    const proven = deliver(accounts, 15, { provenance }, phase)
    if (proven.kind !== 'http') throw new Error('expected HTTP refusal')
    expect(proven.headers.get('retry-after')).toBe('90')
    expect(proven.body).toBe(
      '{"error":{"message":"OpenAI rate limit reached — retrying on another account. Retry in 2m. Resets in 2m.","type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}',
    )
  },
)

test.each(['pre-send', 'after-limit'] as const)(
  'OA-38 %s pins true reset versus setting and activity-duration caps',
  (phase) => {
    const accounts = [
      {
        account: a,
        reading: quota(7200000, 345600000),
        floors: { primary: 5, secondary: 10 },
      },
      { account: b, reading: quota(10800000), floors: { primary: 5 } },
    ]
    const zero = deliver(accounts, 0, {}, phase)
    if (zero.kind !== 'http') throw new Error('expected HTTP refusal')
    expect(zero.headers.get('retry-after')).toBeNull()
    expect(zero.body).toBe(
      '{"error":{"code":412,"status":"FAILED_PRECONDITION","message":"Every OpenAI account is below its killswitch quota floor (see the Limits section of `/openai`). Resets in 3h 0m."}}',
    )
    const fifteen = deliver(accounts, 15, {}, phase)
    if (fifteen.kind !== 'http') throw new Error('expected HTTP refusal')
    expect(fifteen.headers.get('retry-after')).toBe('900')
    expect(fifteen.body).toBe(
      '{"error":{"message":"Killswitch: all OpenAI accounts are below their configured quota threshold. Retry in 15m. Resets in 3h 0m.","type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}',
    )
    const max = deliver(
      accounts,
      'max',
      {
        activity: {
          accountKey: a,
          lastAcceptedAt: now - 1799000,
          ttlMs: 1800000,
        },
        currentAccountKey: a,
      },
      phase,
    )
    if (max.kind !== 'http') throw new Error('expected HTTP refusal')
    expect(max.headers.get('retry-after')).toBe('1800')
    expect(max.body).toBe(
      '{"error":{"message":"Killswitch: all OpenAI accounts are below their configured quota threshold. Retry in 30m. Resets in 3h 0m.","type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}',
    )
    const missing = deliver(accounts, 'max', {}, phase)
    if (missing.kind !== 'http') throw new Error('expected HTTP refusal')
    expect(missing.headers.get('retry-after')).toBe('300')
    expect(missing.body).toBe(
      '{"error":{"message":"Killswitch: all OpenAI accounts are below their configured quota threshold. Retry in 5m. Resets in 3h 0m.","type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}',
    )
    for (const row of accounts)
      for (const window of [row.reading.primary, row.reading.secondary])
        if (window) window.checkedAt = now - QUOTA_STALENESS_MS - 1
    for (const setting of [15, 'max']) {
      const stale = deliver(accounts, setting, {}, phase)
      if (stale.kind !== 'http') throw new Error('expected HTTP refusal')
      expect(stale.headers.get('retry-after')).toBe('300')
      expect(stale.body).toBe(
        '{"error":{"message":"Killswitch: all OpenAI accounts are below their configured quota threshold. Retry in 5m.","type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}',
      )
    }
  },
)

test('unproven-earlier override happens before reduction and cannot schedule a real wait', () => {
  const accounts = [
    { account: a, marks: [{ until: now + 60000, evidenceAt: now }] },
    { account: b, reading: quota(7200000) },
  ]
  const metadata = terminal(accounts)
  expect(metadata.scan!.candidates).toEqual([])
  for (const host of ['opencode1', 'pi'] as const) {
    const decision = decideOpenAiTerminal(facts('pre-send', host), metadata)
    expect(decision.action).toBe('refuse')
    if (decision.action === 'refuse') {
      expect(decision.resetAt).toBeUndefined()
      expect(decision.retryAfterMs).toBe(300000)
    }
  }
  const provenance = new LimitProvenanceStore('terminal')
  provenance.record(
    {
      accountKey: a,
      expiry: now + 7200000,
      branch: 'provider',
      evidenceAt: now,
      observedAt: now,
    },
    now,
  )
  expect(
    scanTerminalReset(
      terminal(
        [
          { account: a, marks: [{ until: now + 7200000, evidenceAt: now }] },
          { account: b, reading: quota(10800000) },
        ],
        15,
        { provenance },
      ).scan!,
      now,
    )?.resetAt,
  ).toBe(now + 7200000)
})

test('cause selection is killswitch before quota before timed marks; stale reset adds no clause', () => {
  const marks = [
    { account: a, marks: [{ until: now + 60000, evidenceAt: now }] },
  ]
  expect(terminal(marks).messageKey).toBe('timed-mark')
  expect(
    terminal([...marks, { account: b, reading: quota(undefined) }]).messageKey,
  ).toBe('quota')
  expect(
    terminal([
      ...marks,
      { account: b, reading: quota(undefined), floors: { primary: 5 } },
    ]).messageKey,
  ).toBe('killswitch')
  const reading = quota(10800000)
  reading.primary!.resetsAt = undefined
  const result = deliver([{ account: a, reading, floors: { primary: 5 } }])
  if (result.kind !== 'http') throw new Error('expected HTTP refusal')
  expect(result.body).toBe(
    '{"error":{"message":"Killswitch: all OpenAI accounts are below their configured quota threshold. Retry in 5m.","type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}',
  )
})

test('OC1 hold has the exact cache-preserving body and no terminal reset clause', () => {
  const result = buildOpenAiQuotaRefusal({
    decision: {
      action: 'hold',
      account: a,
      delayMs: 60000,
      retryAfterMs: 60000,
      target: now + 60000,
      checkpoint: {
        accountKey: a,
        decidedAt: now,
        blockers: [{ window: 'primary', resetAt: now + 60000 }],
      },
      history: createRequestHistory({
        requestId: 'request',
        originalUrl: 'https://provider.invalid/responses',
        clockNow: now,
      }),
      reason: 'same-account',
      retryable: true,
      hostRetry: 'leave',
    },
    now,
  })
  if (result.kind !== 'http') throw new Error('expected HTTP refusal')
  expect(result.headers.get('retry-after')).toBe('60')
  expect(result.body).toBe(
    '{"error":{"message":"OpenAI usage limit reached on this account. Waiting for it keeps the conversation\'s prompt cache. Retry in 1m.","type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}',
  )
})

test('Pi known terminal reset waits once; unknown reset and final delivery never advertise retry', () => {
  const input = facts('pre-send', 'pi')
  for (const [reset, delayMs] of [
    [60000, 60000],
    [7200000, 900000],
  ]) {
    const metadata = terminal([{ account: a, reading: quota(reset) }])
    const decision = decideOpenAiTerminal(input, metadata)
    expect(decision.action).toBe('wait-then-reselect')
    if (decision.action !== 'wait-then-reselect')
      throw new Error('expected terminal wait')
    expect(decision.delayMs).toBe(delayMs!)
    const noUi = buildOpenAiQuotaRefusal({ decision, host: 'pi', now })
    expect(noUi.kind).toBe('text')
    expect(body(noUi)).toBe(
      reset === 60000
        ? 'Every OpenAI account has used up its quota. Resets in 1m.'
        : 'Every OpenAI account has used up its quota. Resets in 2h 0m.',
    )
    const later = now + delayMs!
    const nextMetadata = openAiTerminalFacts({
      accounts: [{ account: a, reading: quota(reset) }],
      effectiveModel: 'gpt-6',
      now: later,
    })
    const next = decideOpenAiTerminal(
      {
        ...input,
        now: later,
        clockNow: later,
        wake: {
          checkpoint: decision.checkpoint,
          target: decision.target,
          kind: 'terminal',
        },
      },
      nextMetadata,
    )
    expect(next.action).toBe('refuse')
    if (reset === 7200000)
      expect(
        body(
          buildOpenAiQuotaRefusal({ decision: next, host: 'pi', now: later }),
        ),
      ).toBe('Every OpenAI account has used up its quota. Resets in 1h 45m.')
  }
  const unknown = decideOpenAiTerminal(
    input,
    terminal([{ account: a, reading: quota(undefined) }]),
  )
  expect(unknown.action).toBe('refuse')
  expect(
    body(buildOpenAiQuotaRefusal({ decision: unknown, host: 'pi', now })),
  ).toBe('Every OpenAI account has used up its quota.')
})

test.each([0, 15, 'max'])(
  'OC2 request throw at %s is nonretryable message text with informational reset only',
  (setting) => {
    const decision = decideOpenAiTerminal(
      facts('pre-send', 'opencode2'),
      terminal([{ account: a, reading: quota(7200000) }], setting),
    )
    const result = buildOpenAiQuotaRefusal({
      decision,
      now,
      maxSameAccountWait: setting,
      requestThrow: true,
    })
    if (result.kind !== 'http') throw new Error('expected json-412 envelope')
    expect(result.status).toBe(412)
    expect(result.headers.get('retry-after')).toBeNull()
    expect(result.body).toBe(
      '{"error":{"code":412,"status":"FAILED_PRECONDITION","message":"Every OpenAI account has used up its quota. Resets in 2h 0m."}}',
    )
  },
)

test('registered final causes survive numeric reset fuzz without generic fallback or host retry triggers', () => {
  // OpenCode 1.18.30 session/retry.ts; body matches override a nonretryable flag.
  const oc1 = [
    /429|500|502|503|504|524/i,
    /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
    /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
    /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
    /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
    /try your request again|retry your request|resource exhausted|resource_exhausted/i,
    /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/i,
  ]
  // Pi-ai 1.4.0 RETRYABLE_PROVIDER_ERROR_PATTERN, independent of our templates.
  const pi =
    /overloaded|server_busy|servers are currently busy|currently experiencing high demand|model is at capacity|rate.?limit|too many requests|(?<![a-z0-9])(?:429|500|502|503|504|520|524)(?![a-z0-9])|service.?(?:is.?)?(?:temporarily.?)?unavailable|server.?error|internal.?error|provider.?returned.?(?:an.?)?error|exceeded request buffer limit while retrying upstream|unable to forward upstream|upstream.?request.?failed|upstream_stream_read_error|stream was interrupted|http\/?2 stream failed|network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|request to \S+ failed, reason:|getaddrinfo|ENOTFOUND|EAI_AGAIN|upstream.?connect|reset before headers|socket hang up|socket connection was closed|timed? out|timeout|terminated|websocket.?closed|websocket.?error|ended without|stream ended before message_stop|stream ended before a terminal response event|http2 request did not get a response|stream disconnected before completion|pending stream has been canceled|retry delay|you can retry your request|try your request again|please retry your request|ResourceExhausted|subscription_sharing_usage_unavailable|subscription_sharing_user_unavailable/i
  const starts = {
    quota: 'Every OpenAI account has used up its quota.',
    killswitch:
      'Every OpenAI account is below its killswitch quota floor (see the Limits section of `/openai`).',
    'timed-mark': 'Every OpenAI account is paused by OpenAI for now.',
  }
  const durations = [
    0, 1, 429, 500, 502, 503, 504, 520, 524, 59999, 60000, 90000, 7200000,
    345600000, 999999999999,
  ]
  for (let index = 1; index <= 100; index++) durations.push(index * 524429)
  for (const [messageKey, start] of Object.entries(starts))
    for (const duration of durations)
      for (const family of ['json-412', 'pi-final'] as const) {
        const result = buildRefusal({
          family,
          messageKey,
          messages: openAiLimitMessages,
          now,
          resetAt: now + duration,
          parameters: { labels: ['acct-429@example.com', 'resp_503'] },
        })
        const text =
          result.kind === 'http'
            ? JSON.parse(result.body).error.message
            : body(result)
        expect(text.startsWith(start)).toBe(true)
        expect(text).not.toContain('unknown')
        expect(text).not.toContain('acct-429')
        expect(text).not.toContain('Retry in')
        expect(hasUnsafeWording(text)).toBe(false)
        expect([...oc1, pi].some((pattern) => pattern.test(text))).toBe(false)
      }
})

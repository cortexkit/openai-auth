import { afterEach, expect, spyOn, test } from 'bun:test'
import type { Attempt } from '@cortexkit/common-auth/opencode2'
import type { OpenAIAttemptData } from '../v2/adapter'
import {
  fixture,
  restoreRoutingAccessor,
  routingKey,
} from './fixtures/opencode2-routing'

afterEach(restoreRoutingAccessor)

const now = () => 1_800_000_000_000
const textDelta = {
  type: 'response.output_text.delta',
  sequence_number: 7,
  item_id: 'msg_1',
  output_index: 0,
  content_index: 0,
  delta: 'hello',
  logprobs: [],
}
const quota = {
  type: 'codex.rate_limits',
  rate_limits: { primary: { used_percent: 12, window_minutes: 300 } },
}
const completed = {
  type: 'response.completed',
  response: { id: 'resp_1', usage: { input_tokens: 12, output_tokens: 6 } },
}
const serverError = JSON.stringify({
  type: 'error',
  error: { code: 'server_error' },
})
const receipt = {
  credentialId: 'credential-a',
  credentialType: 'oauth',
  accountIdentity: 'account-a',
  accountIdentitySource: 'asserted',
  accessToken: 'vault:a-token',
  recordVersion: 1,
  expiresAtMs: null,
} as const

function inspectionFixture(transport: 'http' | 'ws') {
  const { openai, request, reportUsage } = fixture(true, 'ordered', now)
  const attempt: Attempt<OpenAIAttemptData> = {
    ...request,
    attemptId: 'inspection-test',
    accountId: 'vault:a',
    transport,
    data: { kind: 'vault', routeId: 'vault:a', receipt },
  }
  return { openai, attempt, reportUsage }
}

const compact = [
  textDelta,
  {
    ...textDelta,
    delta: '"error", rate_limit, "response.completed", codex.rate_limits\n雪\\',
    obfuscation: 'padding',
  },
  {
    type: 'response.function_call_arguments.delta',
    item_id: 'fc_1',
    delta: '{',
  },
  {
    type: 'response.reasoning_summary_text.delta',
    summary_index: 0,
    delta: '',
  },
  { type: 'codex.notice.delta', delta: 'not output' },
].map((event) => JSON.stringify(event))

const needsFullParse = [
  ...[
    { ...textDelta, status: 429 },
    { ...textDelta, body: { error: { type: 'usage_limit_reached' } } },
    { ...textDelta, logprobs: [{ token: 'hello' }] },
    { delta: 'type is not first', type: textDelta.type },
  ].map((event) => JSON.stringify(event)),
  '{"type":"response.output_text.delta","type":"response.created"}',
  '{"type":"response.output_text.delta","type":"response.completed"}',
  '{"type":"response.output_text.delta",',
  '{"type": "response.output_text.delta","delta":"spaced prefix"}',
  '{"type":"response.output_text.\\u0064elta","delta":"escaped type"}',
  '{"type":"response.output_text.delta","delta":"invalid \\q escape"}',
  '{"type":"response.output_text.delta","delta":"raw\nnewline"}',
  'not JSON',
]

const frames = [
  ...compact,
  ...needsFullParse,
  serverError,
  ...[
    { type: 'response.created' },
    { type: 'response.in_progress' },
    { type: 'response.incomplete', response: { status: 'incomplete' } },
    {
      type: 'response.failed',
      response: { error: { code: 'rate_limit_exceeded' } },
    },
    { type: 'error', status: 429, error: { code: 'quota_exceeded' } },
    completed,
    quota,
    null,
  ].map((event) => JSON.stringify(event)),
  JSON.stringify(quota).replace('rate_limits"', 'rate_\\u006cimits"'),
]

async function observeFrames(
  transport: 'http' | 'ws',
  forceFullParse: boolean,
) {
  const { openai, attempt: seed, reportUsage } = inspectionFixture(transport)
  const reports: Record<string, unknown>[] = []
  Reflect.set(globalThis, routingKey, () => ({
    report(payload: Record<string, unknown>) {
      reports.push(
        payload.kind === 'billing'
          ? { ...payload, attempt_id: '<uuid>' }
          : payload,
      )
    },
  }))
  const { adapter } = openai
  const body = JSON.stringify({
    type: 'response.create',
    model: seed.modelID,
    input: [],
  })
  const inspect = adapter.inspectEvent!
  const verdicts = []
  try {
    for (const frame of frames) {
      const attempt = { ...seed }
      // Billing starts at the outgoing rewrite, where the adapter learns the model.
      if (transport === 'ws') {
        adapter.rewriteWebSocketFrame!({ ...attempt, frame: body, attempt })
      } else {
        const request = new Request('https://codex.test/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
        await adapter.rewriteRequest!({ ...attempt, attempt, request })
      }
      // Whitespace forces a full parse without changing the JSON or the raw
      // substrings used to recognize routing and vault quota frames.
      const data = forceFullParse ? ` ${frame}` : frame
      const verdict = inspect({ transport, attempt, data })
      await adapter.onAttemptEnd!(attempt, {
        status: 200,
        outputStarted: verdict?.outputStarted === true,
        limit: verdict?.limit,
      })
      // An error reveals whether the preceding frame latched output for retry.
      const afterError = inspect({ transport, attempt, data: serverError })
      verdicts.push({ frame, verdict, afterError })
    }
    return { verdicts, usage: reportUsage.mock.calls, reports }
  } finally {
    openai.dispose()
  }
}

test.each(['http', 'ws'] as const)(
  '%s stream verdicts and effects agree with full parsing',
  async (transport) => {
    // Quota normalization stamps its readings with the wall clock.
    const clock = spyOn(Date, 'now').mockImplementation(now)
    try {
      const parsed = await observeFrames(transport, true)
      const inspected = await observeFrames(transport, false)
      expect(inspected).toEqual(parsed)
      expect(parsed.verdicts[0]).toMatchObject({
        verdict: { outputStarted: true },
        afterError: { hostRetry: 'veto' },
      })
      expect(parsed.usage).toEqual([['vault:a', { frame: quota }, receipt]])
      expect(parsed.reports).toContainEqual(
        expect.objectContaining({
          kind: 'billing',
          outcome: 'completed',
          provider_response_id: 'resp_1',
        }),
      )
    } finally {
      clock.mockRestore()
    }
  },
)

test('text deltas take zero JSON parses and a vault quota frame takes one', () => {
  const { openai, attempt } = inspectionFixture('http')
  const inspect = openai.adapter.inspectEvent!
  const deltas = Array.from({ length: 32 }, (_, sequence_number) =>
    JSON.stringify({ ...textDelta, sequence_number }),
  )
  const quotaData = JSON.stringify(quota)
  const fallback = ` ${deltas[0]}`
  const parse = spyOn(JSON, 'parse')
  try {
    for (const data of [...deltas, quotaData, fallback])
      inspect({ transport: 'http', attempt, data })
    const parsed = parse.mock.calls.map(([data]) => data)
    const counts = {
      deltas: parsed.filter((data) => deltas.includes(data)).length,
      quota: parsed.filter((data) => data === quotaData).length,
      fallback: parsed.filter((data) => data === fallback).length,
    }
    expect(counts).toEqual({ deltas: 0, quota: 1, fallback: 1 })
  } finally {
    parse.mockRestore()
    openai.dispose()
  }
})

import { expect, test } from 'bun:test'
import {
  type CodexSessionMetadata,
  prepareCodexRequest,
} from '../codex-request'

const session = (): CodexSessionMetadata => ({
  threadID: 'thread',
  turnID: 'turn',
  windowID: 'window',
})

function prepare(metadata: CodexSessionMetadata, skipTurnUpdate?: boolean) {
  const headers = new Headers()
  const result = prepareCodexRequest({
    init: {
      body: JSON.stringify({
        model: 'gpt-5.5',
        input: [{ role: 'user', content: 'new prompt' }],
      }),
    },
    metadata,
    headers,
    installationID: 'installation',
    websocket: false,
    responsesLite: false,
    rewriteLite: () => {},
    runtime: { now: () => 1234, uuid: () => 'new-turn' },
    ...(skipTurnUpdate === undefined ? {} : { skipTurnUpdate }),
  })
  return { body: result.init?.body, headers: [...headers] }
}

test('the default turn-update option preserves OpenCode 1 request bytes', () => {
  const implicit = session()
  const explicit = session()
  expect(prepare(implicit)).toEqual(prepare(explicit, false))
  expect(implicit).toEqual(explicit)
  expect(implicit).toMatchObject({
    turnID: 'new-turn',
    turnStartedAt: 1234,
    input: [{ role: 'user', content: 'new prompt' }],
  })
})

for (const started of [undefined, 100]) {
  test(`skip-turn-update reads metadata without writing history or initializing time ${started}`, () => {
    const metadata = session()
    if (started !== undefined) metadata.turnStartedAt = started
    const before = structuredClone(metadata)
    Object.freeze(metadata)
    const result = prepare(metadata, true)
    expect(metadata).toEqual(before)
    const turn = JSON.parse(
      new Headers(result.headers).get('x-codex-turn-metadata')!,
    )
    expect(turn.turn_id).toBe('turn')
    expect(turn.turn_started_at_unix_ms).toBe(started)
    expect(JSON.parse(String(result.body)).input).toEqual([
      { role: 'user', content: 'new prompt' },
    ])
  })
}

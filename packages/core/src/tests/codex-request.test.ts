import { expect, test } from 'bun:test'
import { shapeCodexRequest, stampCodexSession } from '../codex-request'

test('a sessionless HTTP helper shapes replayed calls, tools and instructions without a session stamp', () => {
  const body = {
    extension: 'kept',
    text: { verbosity: 'medium' },
    tools: [
      {
        name: 'read',
        parameters: { $schema: 'dialect', type: 'object' },
        type: 'function',
      },
      { name: 'list', type: 'function', strict: true },
      { name: 'custom', type: 'custom', format: { type: 'text' } },
    ],
    stream: true,
    model: 'gpt-6.2-sol',
    input: [
      { type: 'function_call', name: 'read', call_id: 'c1', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'ok' },
      {
        type: 'function_call',
        name: 'list',
        call_id: 'c2',
        arguments: '{}',
        status: 'incomplete',
      },
    ],
    tool_choice: 'required',
    instructions: 'be brief',
  }
  const headers = new Headers({
    'content-type': 'application/json',
    'content-length': '300',
  })
  const sent = shapeCodexRequest({
    body,
    headers,
    accountId: 'selected-account',
  })

  expect(JSON.stringify(sent)).toBe(
    JSON.stringify({
      model: 'gpt-6.2-sol',
      input: [
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'be brief' }],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ['model.base_instructions'],
          },
        },
        {
          type: 'function_call',
          name: 'read',
          call_id: 'c1',
          arguments: '{}',
          status: 'completed',
        },
        { type: 'function_call_output', call_id: 'c1', output: 'ok' },
        {
          type: 'function_call',
          name: 'list',
          call_id: 'c2',
          arguments: '{}',
          status: 'incomplete',
        },
      ],
      tools: [
        {
          type: 'function',
          name: 'read',
          strict: false,
          parameters: { type: 'object' },
        },
        { type: 'function', name: 'list', strict: true },
        { name: 'custom', type: 'custom', format: { type: 'text' } },
      ],
      tool_choice: 'required',
      parallel_tool_calls: true,
      stream: true,
      text: { verbosity: 'medium' },
      extension: 'kept',
    }),
  )
  expect(Object.fromEntries(headers)).toEqual({
    accept: 'text/event-stream',
    'chatgpt-account-id': 'selected-account',
    'content-type': 'application/json',
    originator: 'codex_exec',
    'user-agent':
      'codex_exec/0.166.0 (Debian 12.0.0; aarch64) unknown (codex_exec; 0.166.0)',
    version: '0.166.0',
    'x-codex-beta-features': 'terminal_resize_reflow',
  })
})

test('stamping before Lite placement identifies the developer message by the selected thread', () => {
  const body = {
    instructions: 'be brief',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'fixture.jpg', detail: 'high' },
        ],
      },
    ],
    client_metadata: { opaque: 'kept' },
    model: 'gpt-6.2-sol',
    tools: [{ type: 'web_search' }],
    reasoning: { effort: 'low' },
  }
  const headers = new Headers({
    'x-session-id': 'old',
    'x-session-affinity': 'old',
  })
  stampCodexSession({
    body,
    headers,
    metadata: Object.freeze({
      threadID: '00000000-0000-7000-8000-000000000001',
      turnID: 'chosen-turn',
      windowID: 'chosen-window',
      turnStartedAt: 100,
    }),
    installationID: 'installation',
  })
  const sent = shapeCodexRequest({ body, headers, responsesLite: true })

  expect(JSON.stringify(sent)).toBe(
    JSON.stringify({
      model: 'gpt-6.2-sol',
      input: [
        { type: 'additional_tools', role: 'developer', tools: [] },
        {
          type: 'message',
          id: 'msg_ae9f4650-7e56-5c38-aec4-c458158d31ac',
          role: 'developer',
          content: [{ type: 'input_text', text: 'be brief' }],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ['model.base_instructions'],
            content_item_metadata: [
              { provenance: { type: 'harness', hook: false } },
            ],
          },
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', image_url: 'fixture.jpg' }],
        },
      ],
      parallel_tool_calls: false,
      reasoning: { effort: 'low', context: 'all_turns' },
      prompt_cache_key: '00000000-0000-7000-8000-000000000001',
      client_metadata: {
        opaque: 'kept',
        'x-codex-installation-id': 'installation',
        'x-codex-window-id': 'chosen-window',
      },
    }),
  )
  expect(headers.get('session-id')).toBe('00000000-0000-7000-8000-000000000001')
  expect(headers.get('thread-id')).toBe('00000000-0000-7000-8000-000000000001')
  expect(headers.get('x-client-request-id')).toBe(
    '00000000-0000-7000-8000-000000000001',
  )
  expect(headers.get('x-codex-window-id')).toBe('chosen-window')
  expect(headers.get('x-codex-turn-metadata')).toBe(
    '{"session_id":"00000000-0000-7000-8000-000000000001","thread_id":"00000000-0000-7000-8000-000000000001","thread_source":"user","turn_id":"chosen-turn","sandbox":"seccomp","turn_started_at_unix_ms":100,"request_kind":"turn","window_id":"chosen-window"}',
  )
  expect(headers.get('x-openai-internal-codex-responses-lite')).toBe('true')
  expect(headers.has('x-session-id')).toBe(false)
  expect(headers.has('x-session-affinity')).toBe(false)
})

test('a chained WebSocket frame gets neither instructions nor a Lite rewrite', () => {
  const headers = new Headers({
    accept: 'text/event-stream',
    'content-type': 'application/json',
  })
  const sent = shapeCodexRequest({
    body: {
      input: [
        { type: 'function_call', name: 'read', call_id: 'c1', arguments: '{}' },
      ],
      model: 'gpt-6.2-sol',
      type: 'response.create',
      instructions: 'not repeated on the chain',
      previous_response_id: 'resp_previous',
    },
    headers,
    websocket: true,
    responsesLite: true,
    accountId: 'selected-account',
  })

  expect(JSON.stringify(sent)).toBe(
    JSON.stringify({
      type: 'response.create',
      model: 'gpt-6.2-sol',
      previous_response_id: 'resp_previous',
      input: [
        { type: 'function_call', name: 'read', call_id: 'c1', arguments: '{}' },
      ],
      parallel_tool_calls: true,
    }),
  )
  expect(Object.fromEntries(headers)).toEqual({
    'chatgpt-account-id': 'selected-account',
    originator: 'codex_exec',
    'user-agent':
      'codex_exec/0.166.0 (Debian 12.0.0; aarch64) unknown (codex_exec; 0.166.0)',
    version: '0.166.0',
    'x-codex-beta-features': 'terminal_resize_reflow',
  })
})

test('a stamped full WebSocket frame stays standard when Lite is configured', () => {
  const body = {
    model: 'gpt-6.2-sol',
    type: 'response.create',
    instructions: 'be brief',
    input: [
      { type: 'function_call', name: 'read', call_id: 'c1', arguments: '{}' },
    ],
  }
  const headers = new Headers()
  const turn =
    '{"session_id":"00000000-0000-7000-8000-000000000001","thread_id":"00000000-0000-7000-8000-000000000001","thread_source":"user","turn_id":"chosen-turn","sandbox":"seccomp","turn_started_at_unix_ms":100,"request_kind":"turn","window_id":"chosen-window"}'
  stampCodexSession({
    body,
    headers,
    websocket: true,
    metadata: {
      threadID: '00000000-0000-7000-8000-000000000001',
      turnID: 'chosen-turn',
      windowID: 'chosen-window',
      turnStartedAt: 100,
    },
    installationID: 'installation',
    now: () => 219,
  })

  expect(
    JSON.stringify(
      shapeCodexRequest({
        body,
        headers,
        websocket: true,
        responsesLite: true,
      }),
    ),
  ).toBe(
    JSON.stringify({
      type: 'response.create',
      model: 'gpt-6.2-sol',
      input: [
        {
          type: 'message',
          id: 'msg_ae9f4650-7e56-5c38-aec4-c458158d31ac',
          role: 'developer',
          content: [{ type: 'input_text', text: 'be brief' }],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ['model.base_instructions'],
          },
        },
        {
          type: 'function_call',
          name: 'read',
          call_id: 'c1',
          arguments: '{}',
          status: 'completed',
        },
      ],
      parallel_tool_calls: true,
      prompt_cache_key: '00000000-0000-7000-8000-000000000001',
      client_metadata: {
        'x-codex-installation-id': 'installation',
        'x-codex-window-id': 'chosen-window',
        'x-codex-turn-metadata': turn,
        'x-codex-ws-stream-request-start-ms': '219',
      },
    }),
  )
  expect(headers.has('x-openai-internal-codex-responses-lite')).toBe(false)
})

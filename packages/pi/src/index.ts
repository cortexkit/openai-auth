import type {
  Api,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  OAuthCredentials,
  OAuthLoginCallbacks,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import {
  createAssistantMessageEventStream,
  streamSimpleOpenAICodexResponses,
} from '@earendil-works/pi-ai'
import {
  loginOpenAICodex,
  refreshOpenAICodexToken,
} from '@earendil-works/pi-ai/oauth'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { RawWebSocket } from './raw-ws-node.ts'

const BASE_URL = 'https://chatgpt.com/backend-api'

type CodexModel = Model<'openai-codex-responses'>
type WebSocketOptions =
  | string
  | string[]
  | { headers?: Record<string, string> }
  | undefined

type GlobalWebSocketSlot = { WebSocket?: unknown }

class PiRawCodexWebSocket extends RawWebSocket {
  constructor(url: string | URL, options?: WebSocketOptions) {
    const headers =
      options && typeof options === 'object' && !Array.isArray(options)
        ? (options.headers ?? {})
        : {}
    super(String(url), headers)
  }
}

let rawWebSocketInstallCount = 0
let originalWebSocket: unknown

export function installRawCodexWebSocket() {
  const global = globalThis as unknown as GlobalWebSocketSlot
  if (rawWebSocketInstallCount === 0) {
    originalWebSocket = global.WebSocket
    global.WebSocket = PiRawCodexWebSocket
  }
  rawWebSocketInstallCount++

  return () => {
    rawWebSocketInstallCount = Math.max(0, rawWebSocketInstallCount - 1)
    if (rawWebSocketInstallCount === 0) {
      if (global.WebSocket === PiRawCodexWebSocket) {
        global.WebSocket = originalWebSocket
      }
      originalWebSocket = undefined
    }
  }
}

const OPENAI_CODEX_MODELS: CodexModel[] = [
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: BASE_URL,
    reasoning: true,
    thinkingLevelMap: { xhigh: 'xhigh', minimal: 'low' },
    input: ['text', 'image'],
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 128_000,
  },
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: BASE_URL,
    reasoning: true,
    thinkingLevelMap: { xhigh: 'xhigh', minimal: 'low' },
    input: ['text', 'image'],
    cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 128_000,
  },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4 mini',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: BASE_URL,
    reasoning: true,
    thinkingLevelMap: { xhigh: 'xhigh', minimal: 'low' },
    input: ['text', 'image'],
    cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 128_000,
  },
  {
    id: 'gpt-5.3-codex-spark',
    name: 'GPT-5.3 Codex Spark',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: BASE_URL,
    reasoning: true,
    thinkingLevelMap: { xhigh: 'xhigh', minimal: 'low' },
    input: ['text'],
    cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 128_000,
  },
]

async function loginOpenAI(
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  return loginOpenAICodex({
    onAuth: callbacks.onAuth,
    onPrompt: callbacks.onPrompt,
    onProgress: callbacks.onProgress,
    onManualCodeInput: callbacks.onManualCodeInput,
    originator: 'pi',
  })
}

async function refreshOpenAI(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  return refreshOpenAICodexToken(credentials.refresh)
}

function streamOpenAI(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const outer = createAssistantMessageEventStream()
  const restoreWebSocket = installRawCodexWebSocket()
  let inner: AssistantMessageEventStream
  try {
    inner = streamSimpleOpenAICodexResponses(
      model as CodexModel,
      context,
      options,
    )
  } catch (error) {
    restoreWebSocket()
    throw error
  }

  void (async () => {
    try {
      for await (const event of inner as AsyncIterable<AssistantMessageEvent>) {
        outer.push(event)
      }
      outer.end()
    } catch (error) {
      outer.push({
        type: 'error',
        reason: 'error',
        error: {
          role: 'assistant',
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: 'error',
          errorMessage: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        },
      })
      outer.end()
    } finally {
      restoreWebSocket()
    }
  })()

  return outer
}

export default function cortexKitPiOpenAIAuth(pi: ExtensionAPI) {
  pi.registerProvider('openai-codex', {
    name: 'OpenAI Codex (CortexKit OAuth)',
    baseUrl: BASE_URL,
    api: 'openai-codex-responses',
    models: OPENAI_CODEX_MODELS,
    oauth: {
      name: 'ChatGPT Plus/Pro (CortexKit)',
      login: loginOpenAI,
      refreshToken: refreshOpenAI,
      getApiKey: (credentials: OAuthCredentials) => credentials.access,
    },
    streamSimple: streamOpenAI,
  })
}

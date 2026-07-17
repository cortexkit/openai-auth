import { describe, expect, it } from 'bun:test'

import cortexKitPiOpenAIAuth, { installRawCodexWebSocket } from '../index.ts'

type RegisteredProvider = {
  models: Array<{ id: string }>
  oauth?: unknown
}

describe('Pi OpenAI auth extension', () => {
  it('registers the OpenAI Codex provider and its supported models', () => {
    const registrations: Array<{
      id: string
      provider: RegisteredProvider
    }> = []

    cortexKitPiOpenAIAuth({
      registerProvider(id: string, provider: RegisteredProvider) {
        registrations.push({ id, provider })
      },
    } as never)

    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.id).toBe('openai-codex')
    // Pi 0.80+ inherits canonical OAuth from its built-in provider when an
    // extension overrides transport/models without supplying its own OAuth.
    expect(registrations[0]?.provider.oauth).toBeUndefined()
    expect(registrations[0]?.provider.models.map((model) => model.id)).toEqual([
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex-spark',
    ])
  })

  it('restores the original WebSocket only after every installation is removed', () => {
    const originalWebSocket = globalThis.WebSocket
    let uninstallFirst: (() => void) | undefined
    let uninstallSecond: (() => void) | undefined

    try {
      uninstallFirst = installRawCodexWebSocket()
      const installedWebSocket = globalThis.WebSocket
      expect(installedWebSocket).not.toBe(originalWebSocket)
      expect(installedWebSocket.name).toBe('PiRawCodexWebSocket')

      uninstallSecond = installRawCodexWebSocket()
      expect(globalThis.WebSocket).toBe(installedWebSocket)

      uninstallFirst()
      expect(globalThis.WebSocket).toBe(installedWebSocket)

      uninstallSecond()
      expect(globalThis.WebSocket).toBe(originalWebSocket)
    } finally {
      uninstallFirst?.()
      uninstallSecond?.()
      globalThis.WebSocket = originalWebSocket
    }
  })
})

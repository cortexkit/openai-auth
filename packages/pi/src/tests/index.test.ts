import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import cortexKitPiOpenAIAuth, { installRawCodexWebSocket } from '../index.ts'

type RegisteredProvider = {
  models: Array<{ id: string }>
  oauth?: unknown
}

describe('Pi OpenAI auth extension', () => {
  it("imports pi-ai only through specifiers pi's extension loader can alias", () => {
    // Pi rewrites pi-ai specifiers so extensions share its SDK instance, and its
    // alias table covers only these four. A specifier outside the table still
    // prefix-matches the bare root, so the remainder is appended to that alias
    // target — a single file — and the whole extension fails to load. A deep
    // path like `pi-ai/api/openai-codex-responses` is valid under the package's
    // own exports map, so nothing but pi's loader rejects it and neither
    // typecheck nor build catches it.
    //
    // The bare root is deliberately NOT accepted here: under pi it aliases to
    // compat.js, but outside pi it resolves to dist/index.js, which does not
    // export the streaming API this extension needs.
    const aliasable = new Set([
      '@earendil-works/pi-ai/compat',
      '@earendil-works/pi-ai/oauth',
      '@earendil-works/pi-ai/providers/all',
    ])
    const source = readFileSync(join(import.meta.dir, '..', 'index.ts'), 'utf8')
    const specifiers = [
      ...new Set(
        [...source.matchAll(/from\s+'(@earendil-works\/[^']+)'/g)].map(
          (match) => match[1] as string,
        ),
      ),
    ]

    // Non-vacuous: the extension must actually import from pi-ai, or an empty
    // set would satisfy the check below without proving anything.
    expect(specifiers.length).toBeGreaterThan(0)

    const unaliasable = specifiers.filter(
      (specifier) =>
        specifier.startsWith('@earendil-works/pi-ai/') &&
        !aliasable.has(specifier),
    )
    expect(unaliasable).toEqual([])
  })

  it('registers the OpenAI Codex provider and its supported models', () => {
    const registrations: Array<{
      id: string
      provider: RegisteredProvider
    }> = []

    cortexKitPiOpenAIAuth({
      registerCommand() {},
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

  it('registers exactly the three supported account commands', () => {
    const commandNames: string[] = []

    cortexKitPiOpenAIAuth({
      registerCommand(name: string) {
        commandNames.push(name)
      },
      registerProvider() {},
    } as never)

    expect(commandNames.sort()).toEqual([
      'openai-account',
      'openai-quota',
      'openai-routing',
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

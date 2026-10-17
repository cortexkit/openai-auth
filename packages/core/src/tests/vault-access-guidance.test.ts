import { describe, expect, test } from 'bun:test'

import { vaultSection } from '../commands'
import { vaultConnectOutcome } from '../vault'
import { VAULT_EMPTY_ACCESS_HINT } from '../vault-messages'

describe('vault access guidance', () => {
  test('zero-account messages point to the category and grant checks', async () => {
    const connect = vaultConnectOutcome(
      {
        name: 'openai-auth-opencode',
        routes: () => [],
        snapshot: () => ({ rows: [] }) as never,
      },
      {
        state: 'approved',
        proposedName: 'openai-auth-opencode',
        tokenGeneration: 1,
      },
    )

    const section = vaultSection({
      vault: {
        name: 'openai-auth-opencode',
        authority: async () => 'vault',
        status: async () => ({
          host: 'opencode',
          name: 'openai-auth-opencode',
          enrollment: {
            state: 'approved',
            proposedName: 'openai-auth-opencode',
            tokenGeneration: 1,
          },
          accounts: [],
        }),
        routes: () => [],
        snapshot: () => ({ complete: true }) as never,
      } as never,
    })
    const vaultMenu = await section.build({} as never)

    expect(connect.text).toContain(VAULT_EMPTY_ACCESS_HINT)
    expect(vaultMenu.lines).toContain(VAULT_EMPTY_ACCESS_HINT)
    expect(VAULT_EMPTY_ACCESS_HINT).toContain('openai-native')
    expect(VAULT_EMPTY_ACCESS_HINT).toContain('ck auth status')
  })
})

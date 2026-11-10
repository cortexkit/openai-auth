import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenAiVault } from '../vault'

for (const [host, displayName] of [
  ['opencode', 'ChatGPT for OpenCode'],
  ['pi', 'ChatGPT for Pi'],
] as const) {
  test(`${host} Connect proposes its vault display name`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vault-display-name-'))
    const proposals: unknown[] = []
    const vault = new OpenAiVault({
      host,
      stateDir: join(dir, 'vault'),
      pollIntervalMs: 0,
      connectEnrollment: async () => ({
        enrollPropose: async (input) => {
          proposals.push(input)
          return { requestId: 'display-name-request' }
        },
        enrollPoll: async () => ({ status: 'pending' }),
        close() {},
      }),
    })
    try {
      expect(await vault.connectStep()).toMatchObject({ state: 'pending' })
      expect(proposals).toEqual([
        expect.objectContaining({ name: `openai-auth-${host}`, displayName }),
      ])
    } finally {
      vault.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
}

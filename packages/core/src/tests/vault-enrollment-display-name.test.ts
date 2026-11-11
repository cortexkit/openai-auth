import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ClaustrumClient,
  type ClaustrumConnector,
} from '@cortexkit/claustrum-client'
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
        expect.objectContaining({
          name: `openai-auth-${host}`,
          displayName,
          requestedGrants: [
            { selector: { category: 'openai-native' }, operation: 'read' },
          ],
        }),
      ])
    } finally {
      vault.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
}

test('Connect sends its display name through the real enrollment client to the wire', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-display-name-wire-'))
  const proposals: Array<{
    moduleId: string
    method: string
    params: unknown
  }> = []
  const transport = {
    async call(moduleId: string, method: string, params: unknown) {
      if (method === 'auth.enroll_propose') {
        proposals.push({ moduleId, method, params })
        return { result: { request_id: 'wire-display-name-request' } }
      }
      if (method === 'auth.enroll_poll')
        return { result: { status: 'pending' } }
      throw new Error(`Unexpected enrollment wire method: ${method}`)
    },
    close() {},
  }
  const vault = new OpenAiVault({
    host: 'opencode',
    stateDir: join(dir, 'vault'),
    pollIntervalMs: 0,
    connectEnrollment: () =>
      ClaustrumClient.connect({
        connectionFile: join(dir, 'unused-connection.json'),
        identity: {
          project_root: dir,
          harness: 'openai-auth-test',
          session: 'enrollment-display-name',
        },
        // Enrollment uses only call and close, but SubcClient's private state
        // prevents a structural stub from satisfying the connector's type.
        connector: async () =>
          transport as unknown as Awaited<ReturnType<ClaustrumConnector>>,
      }),
  })
  try {
    expect(await vault.connectStep()).toMatchObject({ state: 'pending' })
    expect(proposals).toEqual([
      {
        moduleId: 'claustrum',
        method: 'auth.enroll_propose',
        params: {
          proposed_name: 'openai-auth-opencode',
          display_name: 'ChatGPT for OpenCode',
          requested_grants: [
            { selector: { category: 'openai-native' }, operation: 'read' },
          ],
          request_secret_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    ])
  } finally {
    vault.close()
    await rm(dir, { recursive: true, force: true })
  }
})

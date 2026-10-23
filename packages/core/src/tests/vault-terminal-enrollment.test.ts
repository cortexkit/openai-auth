import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenAiVault, vaultConnectOutcome } from '../vault'
import { startMockDaemon } from './fixtures/mock-claustrum'

test('unsupported enrollment stops without reconnecting or polling and tells the operator to update the vault', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-terminal-'))
  const daemon = await startMockDaemon({ directory: dir, credentials: {} })
  const vault = new OpenAiVault({
    host: 'opencode',
    stateDir: join(dir, 'state'),
    connectionFile: () => daemon.connectionFile,
    pollIntervalMs: 0,
  })
  let waits = 0
  try {
    daemon.outage = 'unknown_method'
    const status = await vault.waitForApproval({
      sleep: async () => {
        waits++
      },
    })
    expect(status).toMatchObject({
      state: 'unavailable',
      code: 'unknown_method',
    })
    expect(waits).toBe(0)
    expect(daemon.outageCalls).toEqual(['auth.enroll_propose'])
    expect(vaultConnectOutcome(vault, status)).toEqual({
      ok: false,
      text: 'Enrollment stopped (unknown_method). Update the Claustrum vault to a version that supports connecting plugins, then run Connect again.',
    })
    expect(vault.routes()).toEqual([])
  } finally {
    vault.close()
    await daemon.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

import { expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function scenario(mode: string) {
  const root = mkdtempSync(join(tmpdir(), 'registry-reload-'))
  try {
    const config = join(root, 'config')
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, 'fixtures', 'registry-reload.ts'),
        mode,
      ],
      {
        env: {
          ...process.env,
          OPENCODE_CONFIG_DIR: config,
          XDG_STATE_HOME: join(root, 'state'),
          OPENCODE_OPENAI_AUTH_FILE: '',
          OPENCODE_OPENAI_AUTH_STATE_FILE: '',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
    return { result: JSON.parse(stdout), config }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

for (const marker of ['vault', 'rpc-symbol', 'rpc-string']) {
  it(`a pre-layout ${marker} registry keeps a reloaded process legacy until exit`, async () => {
    const { result, config } = await scenario(`legacy-${marker}`)
    expect(result.layout).toBe('legacy')
    expect(result.unwritable).toBe('legacy')
    expect(result.before).toEqual({ '*': 'legacy' })
    expect(result.after).toEqual({ '*': 'legacy', [result.key]: 'legacy' })
    expect(result.statePath).toBe(join(config, 'openai-auth-state.json'))
    expect(result.oldState).toBe('old generation still owns this file')
    expect(result.selfFence.open).toBe(false)
    expect(result.otherFence.open).toBe(false)
    expect(
      result.messages.filter((line: string) => line.includes('until restart')),
    ).toHaveLength(1)
    expect(result.messages).toContain('process heartbeat not written')
  })
}

it('fills missing runtime bookkeeping fields without replacing shared state', async () => {
  const { result } = await scenario('partial-layout-state')
  expect(result).toEqual({ layout: 'state-home', same: true, logged: true })
})

it('a fresh current vault import does not look like an older generation', async () => {
  const { result } = await scenario('fresh-vault-import')
  expect(result.layout).toBe('state-home')
  expect(result.layouts).toEqual({ [result.key]: 'state-home' })
})

it('reloads a pre-1.6.2 control plane without entering foreign locations', async () => {
  const { result } = await scenario('old-control-plane')
  expect(result).toEqual({
    opened: ['active'],
    foreignCalls: 0,
    sameState: true,
    sameCommand: true,
    foreignRetained: true,
    oldLocationUnchanged: true,
  })
})

it('adds shared frame turns to a v1.1 Codex store without replacing it', async () => {
  const { result } = await scenario('old-codex-store')
  expect(result).toEqual({
    sameStore: true,
    thread: true,
    sharedFrameTurns: true,
    sharedTurn: true,
    forgotten: true,
    sessionDeleted: true,
  })
})

it('ignores a foreign Codex store without replacing its registry entry', async () => {
  const { result } = await scenario('foreign-codex-store')
  expect(result).toEqual({
    ignored: true,
    retained: true,
    ignoredNull: true,
    retainedNull: true,
    shared: true,
    sessions: 0,
  })
})

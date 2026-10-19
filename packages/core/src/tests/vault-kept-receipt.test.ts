// What a vault account does when the Claustrum vault stops answering after it
// has served this process a token: the shared vault code keeps the last token
// the vault served for each account, in memory only, and serves it while the
// vault cannot be reached. These tests drive that through `OpenAiVault`'s own
// quota poll (the path that reads OpenAI usage with a vault token when insula
// is absent), against the mock daemon over a real socket.
//
// Each outage test also carries a positive control (an account whose kept
// token does serve during the outage), so a test that checks a token is
// dropped cannot pass merely because nothing is ever kept.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flushForTest, initLogger, resetLoggerForTest } from '../logger'
import { OpenAiVault } from '../vault'
import {
  chatgptAccessToken,
  type MockCredential,
  type MockDaemon,
  startMockDaemon,
  vaultLogin,
} from './fixtures/mock-claustrum'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function credentials(): Record<string, MockCredential> {
  return {
    a: vaultLogin('account-a', { record_version: 3 }),
    b: vaultLogin('account-b', { record_version: 5 }),
  }
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'openai-kept-'))
  const daemon: MockDaemon = await startMockDaemon({
    directory: dir,
    credentials: credentials(),
  })
  let now = Date.now()
  /** Each OpenAI usage read: the account header and the bearer it carried. */
  const wham: Array<{ account: string; bearer: string }> = []
  const status = new Map<string, number>()
  const vault = new OpenAiVault({
    host: 'opencode',
    stateDir: join(dir, 'vault'),
    connectionFile: () => daemon.connectionFile,
    pollIntervalMs: 0,
    now: () => now,
    fetchImpl: () =>
      (async (_input, init) => {
        const headers = new Headers(init?.headers)
        const account = headers.get('ChatGPT-Account-Id') ?? 'unknown'
        wham.push({ account, bearer: headers.get('Authorization') ?? '' })
        const code = status.get(account) ?? 200
        if (code !== 200) return new Response('{}', { status: code })
        return Response.json({
          rate_limit: {
            primary_window: {
              used_percent: 20,
              reset_at: Math.floor((now + 3600000) / 1000),
              limit_window_seconds: 18000,
            },
          },
          spend_control: null,
        })
      }) as typeof fetch,
  })
  cleanups.push(async () => {
    vault.close()
    await daemon.stop()
    await rm(dir, { recursive: true, force: true })
  })
  await mkdir(join(dir, 'vault'), { mode: 0o700 })
  await writeFile(
    vault.paths.tokenPath,
    JSON.stringify({ token: 'ab'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  await vault.refresh()
  const route = (identity: string) => {
    const found = vault.routes().find((row) => row.identity === identity)
    if (!found) throw new Error(`missing route ${identity}`)
    return found.id
  }
  return {
    dir,
    vault,
    wham,
    status,
    daemon,
    a: route('account-a'),
    b: route('account-b'),
    get now() {
      return now
    },
    advance(ms: number) {
      now += ms
    },
    /**
     * Makes the vault unreachable: the daemon answers every vault call with a
     * transport error (see `MockDaemon.outage`).
     */
    outage() {
      daemon.outage = 'connection_dropped'
    },
    /** Makes the vault reachable again, holding `next`. */
    restore(next: Record<string, MockCredential>) {
      daemon.outage = undefined
      daemon.credentials = next
    },
  }
}

const bearer = (account: string, salt = '') =>
  `Bearer ${chatgptAccessToken(account, salt)}`

describe('vault quota polls through a vault outage', () => {
  test('a background quota poll during an outage reads OpenAI with the kept token, then fetches fresh once the vault is back', async () => {
    const env = await setup()
    expect(await env.vault.pollQuota(env.a)).toEqual({ ok: true })
    expect(env.daemon.gets.map((get) => get.credential_id)).toEqual(['a'])
    env.outage()

    expect(await env.vault.pollQuota(env.a)).toEqual({ ok: true })
    expect(env.wham).toEqual([
      { account: 'account-a', bearer: bearer('account-a') },
      { account: 'account-a', bearer: bearer('account-a') },
    ])

    const rotated = chatgptAccessToken('account-a', 'rotated')
    env.restore({
      ...credentials(),
      a: vaultLogin('account-a', {
        record_version: 4,
        payload: JSON.stringify({ access_token: rotated }),
      }),
    })
    expect(await env.vault.pollQuota(env.a)).toEqual({ ok: true })
    expect(env.daemon.gets.map((get) => get.credential_id)).toEqual(['a', 'a'])
    expect(env.wham[2]).toEqual({
      account: 'account-a',
      bearer: `Bearer ${rotated}`,
    })
  })

  test('the vault code logs when kept-token serving starts and stops, to the plugin log file', async () => {
    const env = await setup()
    const logFile = join(env.dir, 'kept.log')
    resetLoggerForTest()
    initLogger({ file: logFile, level: 'info' })
    const readLog = async () => {
      await flushForTest()
      return existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
    }
    try {
      expect(await env.vault.pollQuota(env.a)).toEqual({ ok: true })
      env.outage()
      expect(await env.vault.pollQuota(env.a)).toEqual({ ok: true })
      const started = (await readLog())
        .split('\n')
        .filter((line) => line.includes('serving kept vault receipt'))
      expect(started).toHaveLength(1)
      expect(started[0]).toContain(`"routeId":"${env.a}"`)
      expect(started[0]).toContain('"reason":"unreachable"')

      env.restore(credentials())
      expect(await env.vault.pollQuota(env.a)).toEqual({ ok: true })
      const resumed = (await readLog())
        .split('\n')
        .filter((line) => line.includes('vault receipt serving resumed'))
      expect(resumed).toHaveLength(1)
      expect(resumed[0]).toContain(`"routeId":"${env.a}"`)
      expect(await readLog()).not.toContain(chatgptAccessToken('account-a'))
    } finally {
      resetLoggerForTest()
    }
  })

  test('a 401 on a kept quota token is neither retried nor reported, and the account then refuses', async () => {
    const env = await setup()
    expect(await env.vault.pollQuota(env.a)).toEqual({ ok: true })
    expect(await env.vault.pollQuota(env.b)).toEqual({ ok: true })
    env.outage()

    env.status.set('account-a', 401)
    expect(await env.vault.pollQuota(env.a)).toMatchObject({ ok: false })
    expect(
      env.wham.filter((read) => read.account === 'account-a'),
    ).toHaveLength(2)
    expect(env.daemon.outageCalls).not.toContain(
      'credential.report_auth_failure',
    )

    env.status.delete('account-a')
    expect(await env.vault.pollQuota(env.a)).toEqual({
      ok: false,
      error: 'vault refused',
    })
    expect(
      env.wham.filter((read) => read.account === 'account-a'),
    ).toHaveLength(2)
    // The other account's kept token still serves in the same outage.
    expect(await env.vault.pollQuota(env.b)).toEqual({ ok: true })
    expect(env.wham.at(-1)).toEqual({
      account: 'account-b',
      bearer: bearer('account-b'),
    })
  })

  test('a fresh 401 reported before an outage is not served again during it', async () => {
    const env = await setup()
    expect(await env.vault.pollQuota(env.b)).toEqual({ ok: true })
    env.status.set('account-a', 401)
    expect(await env.vault.pollQuota(env.a)).toMatchObject({ ok: false })
    expect(env.daemon.reports).toMatchObject([
      { credential_id: 'a', provider_status: 401, record_version: 3 },
    ])
    env.outage()

    env.status.delete('account-a')
    const reads = env.wham.length
    expect(await env.vault.pollQuota(env.a)).toEqual({
      ok: false,
      error: 'vault refused',
    })
    expect(await env.vault.pollQuota(env.b)).toEqual({ ok: true })
    expect(env.wham.slice(reads)).toEqual([
      { account: 'account-b', bearer: bearer('account-b') },
    ])
  })

  test('a vault refusal while reachable drops the kept token, so a later outage refuses that account', async () => {
    const env = await setup()
    expect(await env.vault.pollQuota(env.a)).toEqual({ ok: true })
    expect(await env.vault.pollQuota(env.b)).toEqual({ ok: true })
    const credential = env.daemon.credentials.a
    if (!credential) throw new Error('missing credential')
    credential.refuse = 'needs_reauth'
    expect(await env.vault.pollQuota(env.a)).toEqual({
      ok: false,
      error: 'vault refused',
    })
    env.outage()

    const reads = env.wham.length
    expect(await env.vault.pollQuota(env.a)).toEqual({
      ok: false,
      error: 'vault refused',
    })
    expect(await env.vault.pollQuota(env.b)).toEqual({ ok: true })
    expect(env.wham.slice(reads)).toEqual([
      { account: 'account-b', bearer: bearer('account-b') },
    ])
  })

  test('a kept OAuth token is used only while more than a minute of it is left', async () => {
    const env = await setup()
    expect(await env.vault.pollQuota(env.a)).toEqual({ ok: true })
    env.outage()
    expect(await env.vault.pollQuota(env.a)).toEqual({ ok: true })
    expect(env.wham).toHaveLength(2)

    const expires = env.daemon.credentials.a?.expires_at_ms
    if (typeof expires !== 'number') throw new Error('no expiry')
    // The vault option's clock drives the kept token's expiry check.
    env.advance(expires - 59_000 - env.now)
    expect(await env.vault.pollQuota(env.a)).toEqual({
      ok: false,
      error: 'vault refused',
    })
    expect(env.wham).toHaveLength(2)
  })
})

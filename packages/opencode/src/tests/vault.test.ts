// The Claustrum vault end to end on OpenCode: the real claustrum client over
// a socket to a mock daemon (`mock-claustrum.ts` in the core tests), the
// plugin loaded on a migrated install, and a fake network for OpenAI.
//
// Enrollment through `opencode auth login`, vault accounts routed beside the
// pool rows in each routing mode, a served 401 reported to the vault, the
// declined-account interlock, one owner per ChatGPT account, the host-slot
// guard, and what an install still holds from the removed handle-mode
// custody.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MenuTerminal } from '@cortexkit/common-auth/auth-menu'
import { readClaustrumEnrollmentToken } from '@cortexkit/common-auth/claustrum'
import {
  loadAccounts,
  mutateAccounts,
  OpenAiVault,
  vaultPaths,
} from '@cortexkit/openai-auth-core/internal'
import type { Hooks } from '@opencode-ai/plugin'
import {
  chatgptAccessToken,
  type MockCredential,
  type MockDaemon,
  startMockDaemon,
  vaultLogin,
} from '../../../core/src/tests/fixtures/mock-claustrum.ts'
import { authDoctorChecks, readStoreIds } from '../auth/doctor'
import { createAuthMethods } from '../auth/methods'
import { applyOpenAiMenu } from '../commands'
import { __menuContextForTest } from '../index.ts'
import {
  HOUR,
  installWire,
  loadPlugin,
  PLACEHOLDER,
  type PoolMode,
  quotaMap,
  readJson,
  seedPool,
  usageBody,
  type Wire,
} from './fixtures/pool-install'

/** The network, with the main row's quota polls reading it exhausted. */
function wireWithExhaustedMain(): Wire {
  return installWire({
    usage: (bearer) =>
      new Response(usageBody(bearer === 'Bearer main-token' ? 100 : 10), {
        status: 200,
      }),
  })
}
import { FLOOR_AUTH_FILE, FLOOR_STATE_FILE } from './setup-env'

const ENROLLMENT_TOKEN = '01'.repeat(32)
const VAULT_ACCESS = chatgptAccessToken('chatgpt-vault')

let dir: string
let files: { configFile: string; stateFile: string }
let stateDir: string
let daemon: MockDaemon | undefined
let hooks: Hooks | undefined
let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'openai-vault-'))
  files = {
    configFile: join(dir, 'openai-auth.json'),
    stateFile: join(dir, 'openai-auth-state.json'),
  }
  stateDir = join(dir, 'vault')
  process.env.OPENCODE_OPENAI_AUTH_FILE = files.configFile
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = files.stateFile
  originalFetch = globalThis.fetch
})

afterEach(async () => {
  await hooks?.dispose?.()
  hooks = undefined
  await daemon?.stop()
  daemon = undefined
  globalThis.fetch = originalFetch
  process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
  rmSync(dir, { recursive: true, force: true })
})

async function startDaemon(credentials: Record<string, MockCredential> = {}) {
  daemon = await startMockDaemon({ directory: dir, credentials })
  return daemon
}

/** An approved enrollment, as Connect leaves it: the token, owner-only. */
function enroll(host: 'opencode' | 'pi' = 'opencode') {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const { tokenPath } = vaultPaths(stateDir, host)
  writeFileSync(
    tokenPath,
    JSON.stringify({ token: ENROLLMENT_TOKEN, token_generation: 1 }),
    { mode: 0o600 },
  )
  chmodSync(tokenPath, 0o600)
}

/** The plugin on a migrated install, its vault pointed at the mock daemon. */
async function plugin(slot: Record<string, unknown> = { ...PLACEHOLDER }) {
  const running = daemon
  if (!running) throw new Error('start the daemon first')
  hooks = await loadPlugin(
    {
      vault: {
        stateDir,
        connectionFile: () => running.connectionFile,
        pollIntervalMs: 0,
      },
    },
    slot,
  )
  const vault = __menuContextForTest()?.vault
  if (!vault) throw new Error('the loader built no vault')
  // The first roster, and a quota reading for every vault account, so
  // admission has something to judge.
  await vault.refresh()
  await vault.pollStale(0)
  return { hooks, vault }
}

async function fetchOverride(): Promise<typeof globalThis.fetch> {
  const loader = hooks?.auth?.loader
  if (!loader) throw new Error('no loader')
  const loaded = (await loader(
    (async () => ({ ...PLACEHOLDER })) as never,
    {} as never,
  )) as { fetch?: typeof globalThis.fetch }
  if (!loaded.fetch) throw new Error('no fetch override')
  return loaded.fetch
}

function request(
  fetchImpl: typeof globalThis.fetch,
  sessionId?: string,
): Promise<Response> {
  return fetchImpl('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(sessionId ? { 'x-session-id': sessionId } : {}),
    },
    body: JSON.stringify({
      model: 'gpt-5.5',
      input: [{ role: 'user', content: 'hi' }],
    }),
  })
}

async function setMode(mode: PoolMode) {
  const config = readJson(files.configFile)
  writeFileSync(
    files.configFile,
    JSON.stringify({ ...config, routing: { mode } }),
  )
  // The request path re-reads the config only when its modification time
  // changes; a short pause makes sure the next request sees the new mode.
  await Bun.sleep(5)
}

/** A terminal that types `keys` into the menu and records what it prints. */
function scriptedTerminal(keys: string[]) {
  const queue = [...keys]
  let listener: ((data: string) => void) | undefined
  let written = ''
  const feed = () => {
    setTimeout(() => {
      if (!listener || queue.length === 0) return
      listener(queue.shift() as string)
      feed()
    }, 5)
  }
  const terminal = {
    input: {
      isTTY: true,
      isRaw: false,
      setRawMode: () => undefined,
      resume: () => undefined,
      pause: () => undefined,
      on: (_event: 'data', handler: (data: string) => void) => {
        listener = handler
        feed()
        return undefined
      },
      removeListener: () => {
        listener = undefined
        return undefined
      },
    },
    output: {
      write: (text: string) => {
        written += text
        return true
      },
      columns: 160,
      rows: 60,
    },
  } as unknown as MenuTerminal
  return { terminal, written: () => written }
}

const DOWN = '\u001b[B'
const ENTER = '\r'

describe('enrollment', () => {
  test('Connect in `opencode auth login` proposes this host, tells the operator the ck commands, and stores the token owner-only', async () => {
    const running = await startDaemon({
      'oauth:openai:work': vaultLogin('chatgpt-work'),
    })
    seedPool(files, [{ id: 'main', quota: quotaMap(10) }])
    const vault = new OpenAiVault({
      host: 'opencode',
      stateDir,
      connectionFile: () => running.connectionFile,
      pollIntervalMs: 0,
    })
    // Add, re-authenticate, remove, enable/disable, quotas, doctor, then
    // Connect: six steps down.
    const scripted = scriptedTerminal([...Array(6).fill(DOWN), ENTER])
    const methods = createAuthMethods({
      client: { auth: { set: async () => {} } } as never,
      getAuth: async () => ({ ...PLACEHOLDER }),
      getPaths: () => ({
        configPath: files.configFile,
        statePath: files.stateFile,
      }),
      vault,
      dependencies: {
        terminal: scripted.terminal,
        migrationBlockers: async () => [],
        // The operator approves while Connect waits.
        vaultWait: {
          pollIntervalMs: 1,
          sleep: async () => running.approve('request-1'),
        },
      },
    })
    const browser = methods[0] as {
      authorize: (inputs: Record<string, string>) => Promise<unknown>
    }
    await browser.authorize({})

    expect(running.proposals.map((proposal) => proposal.name)).toEqual([
      'openai-auth-opencode',
    ])
    const printed = scripted.written()
    expect(printed).toContain('Connect to the Claustrum vault')
    expect(printed).toContain('ck auth enroll approve --request-id request-1')
    expect(printed).toContain(
      'ck auth grant --principal enrolled:openai-auth-opencode --selector-kind category --selector openai-native --operation read',
    )
    expect(printed).toContain(
      'Connected: the vault approved openai-auth-opencode',
    )
    const { tokenPath } = vaultPaths(stateDir, 'opencode')
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600)
    expect(statSync(stateDir).mode & 0o777).toBe(0o700)
    expect(await readClaustrumEnrollmentToken(tokenPath)).toEqual({
      token: 'ab'.repeat(32),
      token_generation: 1,
    })
    // Pi's token is its own, never written by this host.
    expect(() => statSync(vaultPaths(stateDir, 'pi').tokenPath)).toThrow()
    expect(vault.snapshot()?.rows.map((row) => row.credentialId)).toEqual([
      'oauth:openai:work',
    ])
    vault.close()
  })
})

describe('routing', () => {
  async function vaultServesBesideAnExhaustedMain(): Promise<Wire> {
    await startDaemon({ 'oauth:openai:vault': vaultLogin('chatgpt-vault') })
    enroll()
    // The main row is exhausted, so admission sends every request to the
    // vault account whichever way the modes order the two.
    seedPool(files, [{ id: 'main', quota: quotaMap(100) }])
    const wire = wireWithExhaustedMain()
    await plugin()
    return wire
  }

  for (const mode of [
    'main-first',
    'fallback-first',
    'sticky-balanced',
  ] as const) {
    test(`a vault account serves a request in ${mode}, with one vault read per send`, async () => {
      const wire = await vaultServesBesideAnExhaustedMain()
      await setMode(mode)
      const send = await fetchOverride()
      const gets = daemon?.gets.length ?? 0

      const response = await request(send, 'session-vault')

      expect(response.status).toBe(200)
      expect(wire.sends).toEqual([`Bearer ${VAULT_ACCESS}`])
      expect((daemon?.gets.length ?? 0) - gets).toBe(1)
    })
  }

  test('a served 401 is reported with the exact record version, and the account goes cold', async () => {
    const running = await startDaemon({
      'oauth:openai:vault': vaultLogin('chatgpt-vault', { record_version: 7 }),
    })
    running.onReport = (report) => {
      const target = running.credentials[report.credential_id ?? '']
      if (target && target.record_version === report.record_version)
        target.state = 'needs_reauth'
    }
    enroll()
    seedPool(files, [{ id: 'main', quota: quotaMap(100) }])
    const wire = wireWithExhaustedMain()
    const unauthorized = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const bearer = new Headers(init?.headers).get('authorization')
      if (
        String(url).includes('/responses') &&
        bearer === `Bearer ${VAULT_ACCESS}`
      ) {
        wire.sends.push(bearer)
        return new Response('{}', { status: 401 })
      }
      return unauthorized(url as string, init)
    }) as typeof globalThis.fetch
    const { vault } = await plugin()
    await setMode('fallback-first')
    const send = await fetchOverride()

    await request(send)

    // The vault account was tried first and answered 401 (fallback-first
    // then tries main, whose answer the request returns).
    expect(wire.sends[0]).toBe(`Bearer ${VAULT_ACCESS}`)
    expect(running.reports).toEqual([
      {
        credential_id: 'oauth:openai:vault',
        enrollment_token: ENROLLMENT_TOKEN,
        provider_status: 401,
        record_version: 7,
        reporter_source: 'direct',
      },
    ])
    await vault.refresh()
    expect(vault.routes()).toEqual([])
    expect(vault.snapshot()?.rows[0]?.state).toBe('needs_reauth')
    const sent = wire.sends.length
    await request(send)
    expect(wire.sends.slice(sent)).not.toContain(`Bearer ${VAULT_ACCESS}`)
  })

  test('a vault account disabled in the Vault section never routes, and is never read from the vault', async () => {
    await startDaemon({ 'oauth:openai:vault': vaultLogin('chatgpt-vault') })
    enroll()
    seedPool(files, [{ id: 'main', quota: quotaMap(10) }])
    const wire = installWire()
    const { vault } = await plugin()
    const routeId = vault.routes()[0]?.id
    if (!routeId) throw new Error('no vault route')
    const ctx = __menuContextForTest()
    if (!ctx) throw new Error('no menu context')

    const result = await applyOpenAiMenu(ctx, {
      command: 'openai',
      sectionId: 'vault',
      itemId: routeId,
      actionId: 'disable',
    })

    expect(result.ok).toBe(true)
    expect(vault.routes()).toEqual([])
    await setMode('fallback-first')
    const send = await fetchOverride()
    const gets = daemon?.gets.length ?? 0
    const response = await request(send)
    expect(response.status).toBe(200)
    expect(wire.sends).toEqual(['Bearer main-token'])
    expect(daemon?.gets.length).toBe(gets)
    // Still listed, and disabled.
    expect(vault.snapshot()?.rows.map((row) => row.enabled)).toEqual([false])
  })

  test('a pool row signing in as an account the vault holds is skipped: one account, one owner', async () => {
    await startDaemon({ 'oauth:openai:alpha': vaultLogin('chatgpt-alpha') })
    enroll()
    seedPool(files, [
      { id: 'main', quota: quotaMap(100) },
      { id: 'alpha', quota: quotaMap(5) },
    ])
    const wire = wireWithExhaustedMain()
    await plugin()
    await setMode('fallback-first')
    const send = await fetchOverride()

    await request(send)
    await request(send)

    expect(wire.sends).toEqual([
      `Bearer ${chatgptAccessToken('chatgpt-alpha')}`,
      `Bearer ${chatgptAccessToken('chatgpt-alpha')}`,
    ])
    expect(wire.sends).not.toContain('Bearer alpha-token')
  })

  test('a static OpenAI API key in the vault is never listed, read, routed or reported', async () => {
    const running = await startDaemon({
      'apikey:openai:platform': {
        payload: JSON.stringify({ access_token: 'sk-vault-platform-key' }),
        record_version: 3,
        expires_at_ms: null,
        type: 'api_key',
        refresh_adapter: null,
      },
      'oauth:openai:vault': vaultLogin('chatgpt-vault'),
    })
    enroll()
    seedPool(files, [{ id: 'main', quota: quotaMap(100) }])
    const wire = wireWithExhaustedMain()
    // Every model request answers 401, so a key that was sent would be
    // reported to the vault.
    const recorded = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      if (!String(url).includes('/responses'))
        return recorded(url as string, init)
      wire.sends.push(new Headers(init?.headers).get('authorization') ?? '')
      return new Response('{}', { status: 401 })
    }) as typeof globalThis.fetch
    const { vault } = await plugin()
    await setMode('fallback-first')
    const send = await fetchOverride()

    await request(send)

    expect(vault.snapshot()?.rows.map((row) => row.credentialId)).toEqual([
      'oauth:openai:vault',
    ])
    expect(vault.routes().map((route) => route.kind)).not.toContain('api-key')
    expect(running.gets.map((get) => get.credential_id)).not.toContain(
      'apikey:openai:platform',
    )
    expect(wire.sends).not.toContain('Bearer sk-vault-platform-key')
    expect(running.reports.map((report) => report.credential_id)).not.toContain(
      'apikey:openai:platform',
    )
  })

  test('in an ordered mode, a vault account the vault will not serve passes the request to the next account', async () => {
    const running = await startDaemon({
      'oauth:openai:vault': vaultLogin('chatgpt-vault'),
    })
    enroll()
    seedPool(files, [{ id: 'main', quota: quotaMap(10) }])
    const wire = installWire()
    await plugin()
    await setMode('fallback-first')
    // The vault account has a quota reading, so admission puts it first; the
    // vault then refuses to serve it.
    const credential = running.credentials['oauth:openai:vault']
    if (!credential) throw new Error('no credential')
    credential.refuse = 'credential_unavailable'
    const send = await fetchOverride()
    const gets = running.gets.length

    const response = await request(send)

    expect(response.status).toBe(200)
    expect(running.gets.slice(gets).map((get) => get.credential_id)).toContain(
      'oauth:openai:vault',
    )
    expect(wire.sends).toEqual(['Bearer main-token'])
  })

  test('in an ordered mode, a refused vault account passes the request to another vault account', async () => {
    const running = await startDaemon({
      'oauth:openai:a': vaultLogin('chatgpt-a'),
      'oauth:openai:b': vaultLogin('chatgpt-b'),
    })
    enroll()
    seedPool(files, [{ id: 'main', quota: quotaMap(100) }])
    const wire = wireWithExhaustedMain()
    await plugin()
    await setMode('fallback-first')
    const credential = running.credentials['oauth:openai:a']
    if (!credential) throw new Error('no credential')
    credential.refuse = 'credential_unavailable'
    const send = await fetchOverride()
    const gets = running.gets.length

    const response = await request(send)

    expect(response.status).toBe(200)
    expect(running.gets.slice(gets).map((get) => get.credential_id)).toEqual([
      'oauth:openai:a',
      'oauth:openai:b',
    ])
    expect(wire.sends).toEqual([`Bearer ${chatgptAccessToken('chatgpt-b')}`])
  })
})

describe('the host slot', () => {
  test('a real login in the slot is refused while the vault serves this host its accounts', async () => {
    await startDaemon({ 'oauth:openai:vault': vaultLogin('chatgpt-vault') })
    enroll()
    seedPool(files, [{ id: 'main', quota: quotaMap(10) }])
    const wire = installWire()
    const login = {
      type: 'oauth',
      access: chatgptAccessToken('chatgpt-login'),
      refresh: 'login-refresh',
      expires: Date.now() + HOUR,
    }
    await plugin(login)
    const loader = hooks?.auth?.loader
    if (!loader) throw new Error('no loader')
    const { fetch: send } = (await loader(
      (async () => ({ ...login })) as never,
      {} as never,
    )) as { fetch: typeof globalThis.fetch }

    await expect(request(send)).rejects.toThrow(
      'refusing to serve until one is removed',
    )
    expect(wire.sends).toEqual([])
  })
})

describe('what the handle-mode custody left behind', () => {
  test('tombstones and the old mode are shown by the doctor, and a tombstone is never sent or refreshed', async () => {
    await startDaemon()
    seedPool(
      files,
      [
        { id: 'main', quota: quotaMap(10) },
        { id: 'retired', quota: quotaMap(5) },
      ],
      { claustrum: { mode: 'claustrum' }, routing: { mode: 'fallback-first' } },
    )
    const state = readJson(files.stateFile) as {
      accounts: Record<string, Record<string, unknown>>
    }
    state.accounts.retired = {
      access: '',
      refresh: 'claustrum-tombstone:v1:openai',
      expires: 0,
    }
    writeFileSync(files.stateFile, JSON.stringify(state))
    const wire = installWire()
    const tombstone = {
      ...PLACEHOLDER,
      refresh: 'claustrum-tombstone:v1:openai',
    }
    await plugin(tombstone)
    const send = await fetchOverride()

    const response = await request(send)

    expect(response.status).toBe(200)
    expect(wire.sends).toEqual(['Bearer main-token'])
    expect(wire.refreshTokens).not.toContain('claustrum-tombstone:v1:openai')
    expect(wire.polls).not.toContain('Bearer ')

    const paths = { configPath: files.configFile, statePath: files.stateFile }
    const [check] = authDoctorChecks({
      paths,
      migrated: true,
      readAuth: async () => tombstone,
      loadAccounts,
      readStoreIds,
      mutateAccounts,
      setMainAuth: async () => {},
      now: Date.now,
    })
    const findings = (await check?.run()) ?? []
    expect(findings.map((finding) => finding.code).sort()).toEqual([
      'retired-custody-mode',
      'tombstoned-account',
      'tombstoned-host-slot',
    ])
    expect(
      findings.find((finding) => finding.code === 'tombstoned-account')
        ?.accountId,
    ).toBe('retired')
    expect(
      findings.every((finding) =>
        finding.message.includes('Connect this host to the Claustrum vault')
          ? true
          : finding.code === 'retired-custody-mode',
      ),
    ).toBe(true)
  })

  test('a tombstone in the slot is taken like the pool placeholder: the pool and the vault serve', async () => {
    await startDaemon({ 'oauth:openai:vault': vaultLogin('chatgpt-vault') })
    enroll()
    seedPool(files, [{ id: 'main', quota: quotaMap(100) }])
    const wire = wireWithExhaustedMain()
    const tombstone = {
      ...PLACEHOLDER,
      refresh: 'claustrum-tombstone:v1:openai',
    }
    await plugin(tombstone)
    const loader = hooks?.auth?.loader
    if (!loader) throw new Error('no loader')
    const { fetch: send } = (await loader(
      (async () => ({ ...tombstone })) as never,
      {} as never,
    )) as { fetch: typeof globalThis.fetch }

    const response = await request(send)

    expect(response.status).toBe(200)
    // Vault accounts are routed only by the request path of a migrated
    // install (the pool path); the path for a real login in the slot never
    // sends with them.
    expect(wire.sends).toEqual([`Bearer ${VAULT_ACCESS}`])
  })

  test('a settings write drops the old custody mode from the config', async () => {
    seedPool(files, [{ id: 'main', quota: quotaMap(10) }], {
      claustrum: { mode: 'claustrum', rowHistory: ['gone'] },
    })
    await mutateAccounts((current) => current, {
      configPath: files.configFile,
      statePath: files.stateFile,
    })
    expect(readFileSync(files.configFile, 'utf8')).not.toContain('claustrum')
  })
})

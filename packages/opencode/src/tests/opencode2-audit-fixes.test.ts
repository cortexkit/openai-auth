// The OpenCode 2 entry's handling of the account-pool migration and of the
// credentials it finds: the migration switch, the copy of a login OpenCode 2
// already held, leftovers that are not credentials, the writes to OpenCode
// 1's `auth.json`, and which credential a quota reading belongs to.

import { afterEach, describe, expect, it } from 'bun:test'
import {
  chmodSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import { quotaCodec } from '@cortexkit/common-auth/quota'
import { openPoolStore } from '@cortexkit/common-auth/store'
import type { Credential } from '@opencode/plugin'
import { POOL_PLACEHOLDER } from '../core/pool-migration'
import { NO_OPENCODE1_LOGINS, opencode1HostSlot } from '../v2/host-slot'
import { writeLoginToPool } from '../v2/login'
import { type OpenAIAuthV2Options, setupOpenAIAuth } from '../v2/setup'
import {
  fakeOpenCode2Host,
  type PoolFiles,
  poolFiles,
  scope,
  seedPool,
} from './fixtures/opencode2-host'
import { jwt } from './fixtures/pool-migration-harness'

const PLACEHOLDER = placeholderSecret('openai')
const TOMBSTONE_REFRESH = 'claustrum-tombstone:v1:openai'
const offline: typeof fetch = Object.assign(
  async () => {
    throw new Error('offline in tests')
  },
  { preconnect: () => {} },
) as typeof fetch

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Host = ReturnType<typeof fakeOpenCode2Host>

async function start(
  files: PoolFiles,
  options: Partial<OpenAIAuthV2Options> & {
    activeCredential?: Credential.Value
  } = {},
): Promise<{ host: Host; stop: () => Promise<void> }> {
  const { activeCredential, ...rest } = options
  const host = fakeOpenCode2Host(activeCredential ? { activeCredential } : {})
  const cleanup = await setupOpenAIAuth(host.ctx, {
    paths: files.paths,
    slot: opencode1HostSlot(join(files.dir, 'auth.json')),
    fence: async () => ({ open: true }),
    heartbeat: false,
    fetch: offline,
    ...rest,
  })
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    await cleanup?.()
  }
  cleanups.push(stop)
  cleanups.push(() => rmSync(files.dir, { recursive: true, force: true }))
  return { host, stop }
}

async function modelRequest(host: Host, sessionID = 'ses_1') {
  const draft = {
    ...scope(sessionID),
    headers: { Authorization: `Bearer ${PLACEHOLDER}` } as Record<
      string,
      string
    >,
  }
  await host.fire('model.request', draft)
  return draft.headers
}

async function httpRequest(host: Host, sessionID = 'ses_1') {
  const draft = {
    ...scope(sessionID),
    request: new Request('http://codex.test/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${PLACEHOLDER}` },
      body: '{}',
    }),
  }
  await host.fire('http.request', draft)
  return draft.request
}

async function httpResponse(
  host: Host,
  request: Request,
  response: Response,
  sessionID = 'ses_1',
) {
  await host.fire('http.response', { ...scope(sessionID), request, response })
}

/** An install that has not moved into the pool, with OpenCode 1's login slot. */
function unmigratedInstall(slot: Record<string, unknown>) {
  const files = poolFiles()
  writeFileSync(
    files.configPath,
    JSON.stringify({
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      routing: { mode: 'main-first' },
      accounts: [],
    }),
  )
  const authPath = join(files.dir, 'auth.json')
  writeFileSync(authPath, JSON.stringify({ openai: slot }))
  return { files, authPath }
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await Bun.sleep(20)
  }
  return check()
}

describe('OpenCode 2 entry: the migration switch', () => {
  it('leaves an unmigrated install alone while the switch is off: no migration, no hooks, no login methods', async () => {
    const slot = {
      type: 'oauth',
      access: jwt('chatgpt-main'),
      refresh: 'slot-refresh',
      expires: Date.now() + 3600_000,
    }
    const { files, authPath } = unmigratedInstall(slot)
    const before = readFileSync(authPath, 'utf8')
    let fenceAsked = false
    const { host, stop } = await start(files, {
      poolMigration: false,
      fence: async () => {
        fenceAsked = true
        return { open: true }
      },
    })
    // OpenCode 2's own ChatGPT login keeps serving: nothing of this plugin
    // sits on its requests or replaces its login methods.
    expect(host.hooks).toEqual([])
    expect(host.methods).toEqual([])
    // A migration run checks the version fence before anything else, so a
    // fence that is never asked means no migration ran.
    expect(await waitFor(() => fenceAsked, 1_000)).toBe(false)
    await stop()
    expect(fenceAsked).toBe(false)
    expect(readFileSync(authPath, 'utf8')).toBe(before)
    expect(files.readConfig().openaiAuthPool).toBeUndefined()
  })

  it('routes the pool of an already migrated install while the switch is off, without running the migration', async () => {
    const files = poolFiles()
    seedPool(files, 'main-first', [{ id: 'main' }])
    let fenceAsked = false
    const { host } = await start(files, {
      poolMigration: false,
      fence: async () => {
        fenceAsked = true
        return { open: true }
      },
    })
    const headers = await modelRequest(host)
    expect(headers.authorization ?? headers.Authorization).toBe(
      'Bearer main-token',
    )
    expect(await waitFor(() => fenceAsked, 300)).toBe(false)
  })
})

describe('OpenCode 2 entry: copying the login OpenCode 2 held', () => {
  it('does not copy an older OpenCode 2 login of the account the migration just moved into main', async () => {
    const { files } = unmigratedInstall({
      type: 'oauth',
      access: jwt('chatgpt-main', 'slot'),
      refresh: 'slot-refresh',
      expires: Date.now() + 3600_000,
    })
    // The migration is held at its version-fence check until the plugin has
    // started copying OpenCode 2's login, so that copy starts while the pool
    // does not hold the account yet.
    let open: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const { stop } = await start(files, {
      poolMigration: true,
      fence: async () => {
        await gate
        return { open: true }
      },
      activeCredential: {
        type: 'oauth',
        methodID: 'chatgpt-browser',
        access: jwt('chatgpt-main', 'oc2'),
        refresh: 'oc2-stale-refresh',
        expires: Date.now() + 3600_000,
        metadata: { accountID: 'chatgpt-main' },
      } as unknown as Credential.Value,
    })
    await Bun.sleep(50)
    open()
    expect(
      await waitFor(
        () => files.readConfig().openaiAuthPool?.migratedAt !== undefined,
        15_000,
      ),
    ).toBe(true)
    await stop()
    expect(files.readState().accounts.main?.refresh).toBe('slot-refresh')
    expect(files.readConfig().accounts.map((account) => account.id)).toEqual([
      'main',
    ])
  }, 30_000)

  it('never copies a tombstone the removed vault custody left in OpenCode 2', async () => {
    const files = poolFiles()
    seedPool(files, 'main-first', [{ id: 'fb' }])
    const { stop } = await start(files, {
      activeCredential: {
        type: 'oauth',
        methodID: 'chatgpt-browser',
        access: '',
        refresh: TOMBSTONE_REFRESH,
        expires: 0,
      } as unknown as Credential.Value,
    })
    await stop()
    expect(files.readConfig().accounts.map((account) => account.id)).toEqual([
      'fb',
    ])
    expect(JSON.stringify(files.readState())).not.toContain(TOMBSTONE_REFRESH)
  })

  it("never copies OpenCode 1's pool placeholder carried into OpenCode 2", async () => {
    const files = poolFiles()
    seedPool(files, 'main-first', [{ id: 'fb' }])
    const { stop } = await start(files, {
      activeCredential: {
        ...POOL_PLACEHOLDER,
        methodID: 'chatgpt-browser',
      } as unknown as Credential.Value,
    })
    await stop()
    expect(files.readConfig().accounts.map((account) => account.id)).toEqual([
      'fb',
    ])
  })

  it('refuses to store a tombstone as a login', async () => {
    const files = poolFiles()
    seedPool(files, 'main-first', [{ id: 'fb' }])
    cleanups.push(() => rmSync(files.dir, { recursive: true, force: true }))
    const pool = openPoolStore({
      provider: 'openai',
      configPath: files.configPath,
      statePath: files.statePath,
      quota: quotaCodec,
    })
    await expect(
      writeLoginToPool(pool, files.paths(), {
        id: 'x',
        refresh: TOMBSTONE_REFRESH,
        access: '',
      }),
    ).rejects.toThrow('not a ChatGPT login')
    expect(files.readConfig().accounts.map((account) => account.id)).toEqual([
      'fb',
    ])
  })
})

describe("OpenCode 2 entry: OpenCode 1's auth.json as the login slot", () => {
  function authFile(content: string, mode = 0o600) {
    const files = poolFiles()
    cleanups.push(() => rmSync(files.dir, { recursive: true, force: true }))
    const path = join(files.dir, 'auth.json')
    writeFileSync(path, content)
    chmodSync(path, mode)
    return path
  }
  const login = (name: string) => ({
    type: 'oauth',
    access: `${name}-access`,
    refresh: `${name}-refresh`,
    expires: 1,
  })

  it('refuses the placeholder write when the openai login changed after the read it was decided on', async () => {
    const path = authFile(JSON.stringify({ openai: login('a') }))
    const slot = opencode1HostSlot(path)
    expect(await slot.get({ path: { id: 'openai' } })).toEqual(login('a'))
    // A new OpenCode 1 login lands between that read and the write.
    writeFileSync(path, JSON.stringify({ openai: login('b') }))
    await expect(
      slot.set({ path: { id: 'openai' }, body: { ...POOL_PLACEHOLDER } }),
    ).rejects.toThrow()
    expect(JSON.parse(readFileSync(path, 'utf8')).openai).toEqual(login('b'))
  })

  it('refuses a write no read was decided on', async () => {
    const path = authFile(JSON.stringify({ openai: login('a') }))
    await expect(
      opencode1HostSlot(path).set({
        path: { id: 'openai' },
        body: { ...POOL_PLACEHOLDER },
      }),
    ).rejects.toThrow()
    expect(JSON.parse(readFileSync(path, 'utf8')).openai).toEqual(login('a'))
  })

  it("changes only the openai key, keeps another provider's login written meanwhile, and keeps the file's mode", async () => {
    const path = authFile(JSON.stringify({ openai: login('a') }), 0o644)
    const slot = opencode1HostSlot(path)
    await slot.all()
    await slot.get({ path: { id: 'openai' } })
    writeFileSync(
      path,
      JSON.stringify({ openai: login('a'), anthropic: login('k') }),
    )
    await slot.set({ path: { id: 'openai' }, body: { ...POOL_PLACEHOLDER } })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      openai: { ...POOL_PLACEHOLDER },
      anthropic: login('k'),
    })
    expect(statSync(path).mode & 0o777).toBe(0o644)
  })

  it('never reads a torn auth.json as one with no logins', async () => {
    for (const torn of ['', '{\n  "openai": {\n    "type": "oa']) {
      const slot = opencode1HostSlot(authFile(torn))
      await expect(slot.get({ path: { id: 'openai' } })).rejects.toThrow()
      await expect(slot.all()).rejects.toThrow()
    }
  })

  it('reads an absent or empty auth.json as no OpenCode 1 logins', async () => {
    const empty = opencode1HostSlot(authFile('{}'))
    expect(await empty.get({ path: { id: 'openai' } })).toBeUndefined()
    expect(await empty.all()).toEqual({ [NO_OPENCODE1_LOGINS]: true })
    const absent = opencode1HostSlot(join(poolFiles().dir, 'auth.json'))
    expect(await absent.get({ path: { id: 'openai' } })).toBeUndefined()
    expect(await absent.all()).toEqual({ [NO_OPENCODE1_LOGINS]: true })
  })
})

describe('OpenCode 2 entry: quota attribution', () => {
  it("drops a quota reading that arrives after the row's credential was replaced", async () => {
    const files = poolFiles()
    seedPool(files, 'main-first', [
      { id: 'main', access: jwt('chatgpt-main', 'one') },
    ])
    const { host, stop } = await start(files)
    await modelRequest(host, 'ses_1')
    const request = await httpRequest(host, 'ses_1')
    expect(request.headers.get('authorization')).toBe(
      `Bearer ${jwt('chatgpt-main', 'one')}`,
    )
    // The account signs in again: row main gets a new credential (a new
    // credential epoch), same ChatGPT account.
    const config = files.readConfig() as unknown as {
      commonAuthPool: { rows: Record<string, { credentialEpoch: number }> }
    }
    config.commonAuthPool.rows.main = {
      ...config.commonAuthPool.rows.main,
      credentialEpoch: 2,
    }
    writeFileSync(files.configPath, JSON.stringify(config))
    const state = files.readState()
    state.accounts.main = {
      ...state.accounts.main,
      access: jwt('chatgpt-main', 'two'),
      refresh: 'main-refresh-2',
    }
    writeFileSync(files.statePath, JSON.stringify(state))
    // Another request reads the replaced row.
    await modelRequest(host, 'ses_2')
    // The first request's response, with quota, arrives only now.
    await httpResponse(
      host,
      request,
      new Response('', {
        headers: {
          'x-codex-primary-used-percent': '37',
          'x-codex-primary-window-minutes': '300',
        },
      }),
      'ses_1',
    )
    await stop()
    const used = files
      .readConfig()
      .commonAuthPool.rows.main?.quota?.limits?.find(
        (limit) => limit.usedPercent !== undefined,
      )?.usedPercent
    expect(used).toBe(10)
  })
})

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenAiVault } from '@cortexkit/openai-auth-core/internal'
import type { PluginInput } from '@opencode-ai/plugin'
import {
  createAuthMethods,
  VAULT_LOGIN_INSTRUCTIONS,
  VAULT_LOGIN_LABEL,
} from '../auth/methods'
import { POOL_PLACEHOLDER } from '../core/pool-migration'
import {
  VAULT_ACTIVATION_REFUSAL,
  VAULT_METHOD,
  vaultLoginMethod,
} from '../v2/login'
import { restoreEnv } from './setup-env'

let dir: string
let vault: OpenAiVault
let authPath: string
let oldDataHome: string | undefined
let configPath: string
let statePath: string
const setAuth = mock(async () => ({}))
const noOAuth = mock(async () => {
  throw new Error('OAuth must not run for vault activation')
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'openai-vault-login-'))
  oldDataHome = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = dir
  authPath = join(dir, 'opencode', 'auth.json')
  mkdirSync(join(dir, 'opencode'))
  writeFileSync(authPath, '{"other":{"type":"api","key":"keep"}}\n')
  configPath = join(dir, 'accounts.json')
  statePath = join(dir, 'accounts-state.json')
  writeFileSync(configPath, '{"untouched":"config"}\n')
  writeFileSync(statePath, '{"untouched":"state"}\n')
  vault = new OpenAiVault({ host: 'opencode', stateDir: join(dir, 'vault') })
  mkdirSync(join(dir, 'vault'), { recursive: true })
  writeFileSync(
    vault.paths.tokenPath,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  setAuth.mockClear()
  noOAuth.mockClear()
})

afterEach(() => {
  vault.close()
  restoreEnv('XDG_DATA_HOME', oldDataHome)
  rmSync(dir, { recursive: true, force: true })
})

function methods() {
  return createAuthMethods({
    client: { auth: { set: setAuth } } as unknown as Pick<
      PluginInput['client'],
      'auth'
    >,
    getPaths: () => ({ configPath, statePath }),
    vault,
    dependencies: { authorizeBrowser: noOAuth, authorizeHeadless: noOAuth },
  })
}

async function authorization() {
  const method = methods().find((entry) => entry.label === VAULT_LOGIN_LABEL)
  expect(method?.type).toBe('oauth')
  if (method?.type !== 'oauth') throw new Error('missing vault method')
  const flow = await method.authorize()
  if (flow.method !== 'auto')
    throw new Error('vault activation must be automatic')
  return flow
}

function snapshot() {
  return [authPath, configPath, statePath].map((path) => readFileSync(path))
}

const loginContext = { integrationID: 'openai', methodID: VAULT_METHOD }

describe('OpenCode 1 vault activation', () => {
  test('enrolled empty slot returns only the placeholder without touching pool files', async () => {
    const before = snapshot()
    const flow = await authorization()
    expect(flow.url).toBe('')
    expect(flow.method).toBe('auto')
    expect(flow.instructions).toBe(VAULT_LOGIN_INSTRUCTIONS)
    expect(await flow.callback()).toEqual({
      ...POOL_PLACEHOLDER,
      type: 'success',
    })
    expect(snapshot()).toEqual(before)
    expect(setAuth).not.toHaveBeenCalled()
    expect(noOAuth).not.toHaveBeenCalled()
  })

  test('not enrolled hides the method and refuses a previously offered callback', async () => {
    const flow = await authorization()
    rmSync(vault.paths.tokenPath)
    const before = snapshot()
    expect(methods().some((entry) => entry.label === VAULT_LOGIN_LABEL)).toBe(
      false,
    )
    expect(await flow.callback()).toEqual({ type: 'failed' })
    expect(snapshot()).toEqual(before)
  })

  test('unreadable enrollment refuses activation without touching files', async () => {
    writeFileSync(vault.paths.tokenPath, 'not JSON')
    const before = snapshot()
    const tokenBefore = readFileSync(vault.paths.tokenPath)
    expect(await (await authorization()).callback()).toEqual({ type: 'failed' })
    expect(snapshot()).toEqual(before)
    expect(readFileSync(vault.paths.tokenPath)).toEqual(tokenBefore)
  })

  test.each([
    ['oauth', '{"openai":{"type":"oauth","refresh":"keep"}}\n'],
    ['API key', '{"openai":{"type":"api","key":"keep"}}\n'],
    ['invalid record', '{"openai":null}\n'],
    ['placeholder', JSON.stringify({ openai: POOL_PLACEHOLDER })],
    ['malformed JSON', '{broken'],
    ['non-object JSON', '[]'],
  ])(
    'existing or malformed %s refuses and preserves auth bytes',
    async (_name, bytes) => {
      writeFileSync(authPath, bytes)
      const before = snapshot()
      expect(await (await authorization()).callback()).toEqual({
        type: 'failed',
      })
      expect(snapshot()).toEqual(before)
    },
  )

  test('unreadable auth file refuses without touching pool files', async () => {
    rmSync(authPath)
    mkdirSync(authPath)
    writeFileSync(join(authPath, 'keep'), 'unchanged')
    const before = [configPath, statePath].map((path) => readFileSync(path))
    expect(await (await authorization()).callback()).toEqual({ type: 'failed' })
    expect(readFileSync(join(authPath, 'keep'), 'utf8')).toBe('unchanged')
    expect([configPath, statePath].map((path) => readFileSync(path))).toEqual(
      before,
    )
  })

  test('missing auth file on a fresh install returns the placeholder', async () => {
    rmSync(authPath)
    expect(await (await authorization()).callback()).toEqual({
      ...POOL_PLACEHOLDER,
      type: 'success',
    })
  })
})

describe('OpenCode 2 vault activation', () => {
  test('enrolled activation neither logs in nor touches the pool', async () => {
    const before = snapshot()
    const method = vaultLoginMethod(vault)
    expect(method.method).toEqual({
      id: VAULT_METHOD,
      type: 'oauth',
      label: VAULT_LOGIN_LABEL,
    })
    await method.activate(loginContext)
    expect(snapshot()).toEqual(before)
    expect(noOAuth).not.toHaveBeenCalled()
  })

  test('not enrolled activation refuses with fixed credential-free text', async () => {
    rmSync(vault.paths.tokenPath)
    const before = snapshot()
    await expect(
      vaultLoginMethod(vault).activate(loginContext),
    ).rejects.toThrow(VAULT_ACTIVATION_REFUSAL)
    expect(snapshot()).toEqual(before)
  })

  test('unreadable enrollment activation refuses with fixed credential-free text', async () => {
    writeFileSync(vault.paths.tokenPath, 'not JSON')
    const before = snapshot()
    await expect(
      vaultLoginMethod(vault).activate(loginContext),
    ).rejects.toThrow(VAULT_ACTIVATION_REFUSAL)
    expect(snapshot()).toEqual(before)
  })
})

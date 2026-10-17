import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VaultGrantReach } from '@cortexkit/common-auth/claustrum'

import { vaultSection } from '../commands'
import {
  OpenAiVault,
  VAULT_FAMILY,
  VAULT_MODE_REFUSALS,
  vaultConnectOutcome,
  vaultModeNoRouteCause,
  vaultModeRefusalText,
} from '../vault'
import {
  VAULT_EMPTY_ACCESS_HINT,
  vaultEmptyAccessHint,
} from '../vault-messages'
import {
  type MockDaemon,
  startMockDaemon,
  vaultLogin,
} from './fixtures/mock-claustrum'

const NAME = 'openai-auth-opencode'
const GRANT =
  'ck auth grant --principal enrolled:openai-auth-opencode --selector-kind category --selector openai-native --operation read'
const READ_GRANT = {
  selector_kind: 'category',
  selector: 'openai-native',
  operation: 'read',
}
const NO_GRANT: VaultGrantReach = { grants: 0, tuples: [] }
const UNREACHED: VaultGrantReach = {
  grants: 1,
  tuples: [
    { selectorKind: 'category', selector: 'openai-native', operation: 'read' },
  ],
}

// The three things the vault can say about an empty account list.
const CASES = [
  ['no grant', NO_GRANT],
  ['a grant that reaches no login', UNREACHED],
  ['an older vault that reports no grants', undefined],
] as const

async function menuLines(reach: VaultGrantReach | undefined) {
  const section = vaultSection({
    vault: {
      name: NAME,
      authority: async () => 'vault',
      status: async () => ({
        host: 'opencode',
        name: NAME,
        enrollment: {
          state: 'approved',
          proposedName: NAME,
          tokenGeneration: 1,
        },
        accounts: [],
      }),
      routes: () => [],
      snapshot: () => ({ complete: true }) as never,
      grantReach: () => reach,
    } as never,
  })
  return (await section.build({} as never)).lines
}

function connectText(reach: VaultGrantReach | undefined) {
  return vaultConnectOutcome(
    {
      name: NAME,
      routes: () => [],
      snapshot: () => ({ rows: [] }) as never,
      grantReach: () => reach,
    },
    { state: 'approved', proposedName: NAME, tokenGeneration: 1 },
  ).text
}

describe('vault access guidance', () => {
  test('without a grant, the connect outcome and the menu give the exact grant command', async () => {
    const hint = vaultEmptyAccessHint(NAME, NO_GRANT)
    expect(hint).toBe(
      `The vault has no grant letting openai-auth-opencode read OpenAI accounts. Grant it with \`${GRANT}\`.`,
    )
    expect(connectText(NO_GRANT)).toContain(hint)
    expect(await menuLines(NO_GRANT)).toContain(hint)
    expect(hint).not.toContain('reclassify')
  })

  test('with a grant that reaches no login, they name reclassify and status instead', async () => {
    const hint = vaultEmptyAccessHint(NAME, UNREACHED)
    expect(hint).toBe(
      "The vault's grant for openai-auth-opencode reaches no ChatGPT login: no login has the `openai-native` category. `ck auth reclassify --from-registry` fills empty category sets from the vault's defaults; then check the CATEGORIES column with `ck auth status`.",
    )
    expect(connectText(UNREACHED)).toContain(hint)
    expect(await menuLines(UNREACHED)).toContain(hint)
    expect(hint).not.toContain('ck auth grant')
  })

  test('an older vault keeps the general hint', async () => {
    expect(vaultEmptyAccessHint(NAME, undefined)).toBe(VAULT_EMPTY_ACCESS_HINT)
    expect(connectText(undefined)).toContain(VAULT_EMPTY_ACCESS_HINT)
    expect(await menuLines(undefined)).toContain(VAULT_EMPTY_ACCESS_HINT)
    expect(VAULT_EMPTY_ACCESS_HINT).toContain('openai-native')
    expect(VAULT_EMPTY_ACCESS_HINT).toContain('ck auth status')
  })

  test('the hints name the category the plugin is granted under', () => {
    expect(VAULT_FAMILY.category).toBe('openai-native')
    expect(vaultEmptyAccessHint(NAME, NO_GRANT)).toContain(
      `--selector ${VAULT_FAMILY.category}`,
    )
  })
})

describe('vault-mode refusal for an empty account list', () => {
  const roster = (rows: number) =>
    ({ rows: Array.from({ length: rows }, () => ({})) }) as never

  test.each(CASES)('names the cause for %s', (_name, reach) => {
    const cause = vaultModeNoRouteCause({
      snapshot: () => roster(0),
      grantReach: () => reach,
    })
    expect(cause).toBe(
      reach === undefined
        ? 'vault-empty'
        : reach.grants === 0
          ? 'vault-no-grant'
          : 'vault-grant-unreached',
    )
  })

  test('listed but unusable accounts stay empty whatever the grants say', () => {
    for (const reach of [NO_GRANT, UNREACHED, undefined])
      expect(
        vaultModeNoRouteCause({
          snapshot: () => roster(1),
          grantReach: () => reach,
        }),
      ).toBe('vault-empty')
  })

  test('before any list the vault is unreachable', () => {
    expect(
      vaultModeNoRouteCause({
        snapshot: () => undefined,
        grantReach: () => NO_GRANT,
      }),
    ).toBe('vault-unreachable')
  })

  test('the texts give the exact fix and carry no account', () => {
    expect(vaultModeRefusalText('vault-no-grant', NAME)).toBe(
      `Request refused locally: this host is connected to the credential vault, which has no grant letting it read OpenAI accounts, and local accounts are not used while it is connected. Disconnect this host from the vault, or grant it access with: ${GRANT}`,
    )
    expect(vaultModeRefusalText('vault-no-grant', 'openai-auth-pi')).toContain(
      '--principal enrolled:openai-auth-pi ',
    )
    const unreached = vaultModeRefusalText('vault-grant-unreached', NAME)
    expect(unreached).toBe(VAULT_MODE_REFUSALS['vault-grant-unreached'])
    expect(unreached).toContain('ck auth reclassify --from-registry')
    expect(unreached).toContain('ck auth status')
    expect(unreached).not.toContain('ck auth grant')
    expect(vaultModeRefusalText('vault-empty', NAME)).toBe(
      VAULT_MODE_REFUSALS['vault-empty'],
    )
  })
})

describe('a real vault connection reports its grants', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  async function connected(
    grants: MockDaemon['grants'],
    credentials: Parameters<typeof startMockDaemon>[0]['credentials'] = {},
  ) {
    const dir = await mkdtemp(join(tmpdir(), 'openai-grant-reach-'))
    const daemon = await startMockDaemon({
      directory: dir,
      credentials,
      grants,
    })
    const vault = new OpenAiVault({
      host: 'opencode',
      stateDir: join(dir, 'vault'),
      connectionFile: () => daemon.connectionFile,
      pollIntervalMs: 0,
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
    return { vault, daemon }
  }

  test('no grant at all', async () => {
    const { vault } = await connected([])
    expect(vault.grantReach()?.grants).toBe(0)
    expect(vaultModeNoRouteCause(vault)).toBe('vault-no-grant')
  })

  test('a grant that reaches no login', async () => {
    const { vault } = await connected([READ_GRANT])
    expect(vault.grantReach()).toEqual(UNREACHED)
    expect(vaultModeNoRouteCause(vault)).toBe('vault-grant-unreached')
  })

  test('an older vault that omits grants', async () => {
    const { vault } = await connected(undefined)
    expect(vault.grantReach()).toBeUndefined()
    expect(vaultModeNoRouteCause(vault)).toBe('vault-empty')
  })

  test('a grant that reaches a login serves it', async () => {
    const { vault } = await connected([READ_GRANT], {
      a: vaultLogin('account-a'),
    })
    expect(vault.snapshot()?.rows).toHaveLength(1)
    expect(vault.grantReach()?.grants).toBe(1)
  })
})

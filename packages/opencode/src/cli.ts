#!/usr/bin/env node

import {
  claustrumMode,
  FALLBACK_REFRESH_LOCK_TTL_MS,
  fallbackRefreshLockName,
  getAccountStoragePath,
  loadAccounts,
  mutateAccounts,
  type OAuthAccount,
  readConfigRosterIds,
} from './core/accounts'
import {
  assertFallbackAccountIdAllowed,
  beginAccountLogin,
  upsertAccount,
} from './core/oauth'
import { acquireRefreshFileLock } from './core/refresh-file-lock'
import { openUrl } from './util/open-url'

export { openUrl as openBrowserForLogin } from './util/open-url'

type CliDeps = Partial<{
  beginAccountLogin: typeof beginAccountLogin
  openUrl: typeof openUrl
  getAccountStoragePath: typeof getAccountStoragePath
  loadAccounts: typeof loadAccounts
  mutateAccounts: typeof mutateAccounts
  acquireRefreshFileLock: typeof acquireRefreshFileLock
  log: typeof console.log
  error: typeof console.error
}>

function usage(log: typeof console.log = console.log) {
  log(`Usage:
  npx @cortexkit/opencode-openai-auth login [--label <name>] [--headless]
  npx @cortexkit/opencode-openai-auth list
  npx @cortexkit/opencode-openai-auth remove <id>

Fallback accounts are stored in:
  ${getAccountStoragePath()}`)
}

function parseArgs(argv: string[]) {
  const positional: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg) continue
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

export async function runCli(
  argv = process.argv.slice(2),
  deps: CliDeps = {},
): Promise<number> {
  const login = deps.beginAccountLogin ?? beginAccountLogin
  const open = deps.openUrl ?? openUrl
  const storagePath = deps.getAccountStoragePath ?? getAccountStoragePath
  const load = deps.loadAccounts ?? loadAccounts
  const mutate = deps.mutateAccounts ?? mutateAccounts
  const acquireLock = deps.acquireRefreshFileLock ?? acquireRefreshFileLock
  const log = deps.log ?? console.log
  const writeError = deps.error ?? console.error
  const { positional, flags } = parseArgs(argv)
  const [command, ...rest] = positional

  if (!command || command === 'help') {
    usage(log)
    return 0
  }

  switch (command) {
    case 'login': {
      const label = typeof flags.label === 'string' ? flags.label : undefined
      const headless = Boolean(flags.headless)

      try {
        assertFallbackAccountIdAllowed(label)
      } catch (error) {
        writeError(
          `\nError: ${error instanceof Error ? error.message : String(error)}`,
        )
        return 1
      }

      const { url, instructions, completion } = await login({
        label,
        headless,
      })

      log('\nOpen this URL in your browser and complete sign-in:\n')
      log(`${url}\n`)
      if (instructions) log(`${instructions}\n`)

      open(url)

      const account = await completion

      // Read-modify-write under the store lock so a concurrent add/remove
      // (another CLI invocation or a TUI command) cannot clobber this insertion,
      // and the self-fallback check sees the freshest mainAccountId.
      const configPath = storagePath()
      const lock = await acquireLock({
        name: fallbackRefreshLockName(account.id),
        ttlMs: FALLBACK_REFRESH_LOCK_TTL_MS,
        path: configPath,
        renew: true,
      })
      if (!lock) throw new Error('Fallback account lock unavailable')
      let selfFallback = false
      let blockedByClaustrum = false
      try {
        if (claustrumMode((await load(configPath)) ?? {}) === 'claustrum') {
          blockedByClaustrum = true
        } else {
          await mutate((current) => {
            if (
              account.accountId &&
              current.mainAccountId &&
              account.accountId === current.mainAccountId
            ) {
              selfFallback = true
              return current
            }
            upsertAccount(current.accounts, account as unknown as OAuthAccount)
            return current
          }, configPath)
        }
      } finally {
        await lock.release()
      }

      if (blockedByClaustrum) {
        writeError(
          '\nError: Claustrum mode is active. Run /openai-account local before adding a fallback account.',
        )
        return 1
      }

      if (selfFallback) {
        writeError(
          '\nError: that account is already your main (same ChatGPT account).',
        )
        writeError(
          'A self-fallback would retry on the account that just returned 429.',
        )
        return 1
      }

      log(`\n✓ Added account ${account.id}`)
      if (account.label) log(`  Label: ${account.label}`)
      return 0
    }

    case 'list': {
      const storage = await load()
      if (!storage || storage.accounts.length === 0) {
        log('No fallback accounts configured.')
      } else {
        for (const a of storage.accounts) {
          const label = (a as { label?: string }).label
          const parts = [`  ${a.id}`]
          if (label) parts.push(`(${label})`)
          parts.push(a.enabled !== false ? '[enabled]' : '[disabled]')
          log(parts.join(' '))
        }
      }
      return 0
    }

    case 'remove': {
      const targetId = rest[0]
      if (!targetId) {
        writeError('Error: remove requires an account ID.')
        usage(log)
        return 1
      }

      // `allowDrop` is unconditional — for a healthy entry it is a no-op,
      // for a load-dropped entry it suppresses the preservation pass that
      // would otherwise resurrect the raw entry. The user-facing message
      // comes from two signals OR'd together: the mutator's splice and a
      // pre-read of the raw roster that the mutator's current.accounts
      // cannot see. The pre-read is purely diagnostic — a stale read can
      // only change the message when another writer races us, and the
      // mutator signal covers exactly that case.
      const configPath = storagePath()
      const rawRoster = await readConfigRosterIds(configPath)
      const preReadSawIt = rawRoster ? rawRoster.has(targetId) : false

      let mutatorSplicedIt = false
      await mutate(
        (current) => {
          const idx = current.accounts.findIndex((a) => a.id === targetId)
          if (idx === -1) return current
          current.accounts.splice(idx, 1)
          mutatorSplicedIt = true
          return current
        },
        configPath,
        { allowDrop: [targetId] },
      )

      const removed = mutatorSplicedIt || preReadSawIt
      if (!removed) {
        writeError(`No account with id "${targetId}".`)
        return 1
      }
      log(`Removed account ${targetId}.`)
      return 0
    }

    default:
      writeError(`Unknown command: ${command}`)
      usage(log)
      return 1
  }
}

async function main() {
  process.exit(await runCli())
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}

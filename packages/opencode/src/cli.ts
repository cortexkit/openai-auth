#!/usr/bin/env node

import {
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
import { openUrl } from './util/open-url'

export { openUrl as openBrowserForLogin } from './util/open-url'

function usage() {
  console.log(`Usage:
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

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  const [command, ...rest] = positional

  if (!command || command === 'help') {
    usage()
    process.exit(0)
  }

  switch (command) {
    case 'login': {
      const label = typeof flags.label === 'string' ? flags.label : undefined
      const headless = Boolean(flags.headless)

      try {
        assertFallbackAccountIdAllowed(label)
      } catch (error) {
        console.error(
          `\nError: ${error instanceof Error ? error.message : String(error)}`,
        )
        process.exit(1)
      }

      const { url, instructions, completion } = await beginAccountLogin({
        label,
        headless,
      })

      console.log('\nOpen this URL in your browser and complete sign-in:\n')
      console.log(`${url}\n`)
      if (instructions) console.log(`${instructions}\n`)

      openUrl(url)

      const account = await completion

      // Read-modify-write under the store lock so a concurrent add/remove
      // (another CLI invocation or a TUI command) cannot clobber this insertion,
      // and the self-fallback check sees the freshest mainAccountId.
      let selfFallback = false
      await mutateAccounts((current) => {
        // Reject self-fallback: adding main's ChatGPT account as a fallback
        // would let routing retry on the account that just returned 429.
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
      })

      if (selfFallback) {
        console.error(
          '\nError: that account is already your main (same ChatGPT account).',
        )
        console.error(
          'A self-fallback would retry on the account that just returned 429.',
        )
        process.exit(1)
      }

      console.log(`\n✓ Added account ${account.id}`)
      if (account.label) console.log(`  Label: ${account.label}`)
      break
    }

    case 'list': {
      const storage = await loadAccounts()
      if (!storage || storage.accounts.length === 0) {
        console.log('No fallback accounts configured.')
      } else {
        for (const a of storage.accounts) {
          const label = (a as { label?: string }).label
          const parts = [`  ${a.id}`]
          if (label) parts.push(`(${label})`)
          parts.push(a.enabled !== false ? '[enabled]' : '[disabled]')
          console.log(parts.join(' '))
        }
      }
      break
    }

    case 'remove': {
      const targetId = rest[0]
      if (!targetId) {
        console.error('Error: remove requires an account ID.')
        usage()
        process.exit(1)
      }

      // A load-dropped entry sits in the raw config but is absent from the
      // mutator's `current.accounts`; the mutator's splice would no-op and
      // the load-time preservation pass would resurrect it. Pre-check the
      // raw roster and pass `allowDrop` so the entry is gone end-to-end.
      const configPath = getAccountStoragePath()
      const rawRoster = await readConfigRosterIds(configPath)
      const existedOnDisk = rawRoster ? rawRoster.has(targetId) : false

      let removed = false
      await mutateAccounts(
        (current) => {
          const idx = current.accounts.findIndex((a) => a.id === targetId)
          if (idx === -1) return current
          current.accounts.splice(idx, 1)
          removed = true
          return current
        },
        configPath,
        existedOnDisk ? { allowDrop: [targetId] } : undefined,
      )

      // The mutator could not find the id in current.accounts because it was
      // load-dropped; allowDrop prevented preservation, so the on-disk entry
      // is gone — count it as a successful removal.
      if (!removed && existedOnDisk) removed = true

      if (!removed) {
        console.error(`No account with id "${targetId}".`)
        process.exit(1)
      }
      console.log(`Removed account ${targetId}.`)
      break
    }

    default:
      console.error(`Unknown command: ${command}`)
      usage()
      process.exit(1)
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}

import { CommandError } from '@cortexkit/common-auth/commands'
import {
  type ResetCreditsDeps,
  settingsMutateAccounts,
} from '@cortexkit/openai-auth-core'
import {
  type AccountPaths,
  type AccountStorage,
  normalizeResetState,
  type OAuthQuotaSnapshot,
  type QuotaEntry,
} from '@cortexkit/openai-auth-core/internal'
import { FORMER_MAIN_ID } from '@cortexkit/openai-auth-core/pool-routing'
import { identityOfToken, type PiMainAccount } from './main-account.ts'
import type { PiPoolSource } from './pool-source.ts'

export function piResetCredits(options: {
  paths: AccountPaths
  main: PiMainAccount
  pool: PiPoolSource
  storage: () => Promise<AccountStorage | null>
  isLocal: () => Promise<boolean>
  fetchImpl: () => typeof fetch
  now: () => number
}): ResetCreditsDeps {
  const { paths, main, pool, now } = options
  const store = pool.poolStore()
  const mutate = settingsMutateAccounts(store, undefined, paths.configPath)
  const requireLocal = async () => {
    if (!(await options.isLocal()))
      throw new CommandError(
        'vault-local-action',
        'Reset credits are only available for local accounts.',
      )
  }
  const entry = (quota: OAuthQuotaSnapshot | undefined): QuotaEntry | null => {
    if (!quota) return null
    const checkedAt = Math.max(
      quota.primary?.checkedAt ?? 0,
      quota.secondary?.checkedAt ?? 0,
    )
    return { quota, checkedAt, refreshAfter: checkedAt }
  }
  return {
    ...paths,
    now,
    randomUUID: () => crypto.randomUUID(),
    loadAccounts: async () => {
      // Native-only installs have no roster to read. The reset ledger lives
      // in the pool's plugin settings whether or not it has any rows.
      const load = await store.readSettings()
      if (load.status === 'error') throw new Error('Reset state is unreadable')
      return {
        version: 1,
        accounts: [],
        reset: normalizeResetState(load.settings.reset),
      }
    },
    mutateAccounts: async (...args) => {
      await requireLocal()
      return mutate(...args)
    },
    // The shared coordinator waits on the store between preview and consume.
    // Recheck enrollment at the actual send, not just when the menu opens.
    fetchImpl: (async (...args: Parameters<typeof fetch>) => {
      await requireLocal()
      return options.fetchImpl()(...args)
    }) as typeof fetch,
    accountKeys: async () => {
      if (!(await options.isLocal())) return []
      const load = await store.read()
      const rows = load.status === 'ready' ? load.rows : []
      return [
        ...(main.currentToken() ? [FORMER_MAIN_ID] : []),
        ...rows
          .filter(
            (row) =>
              row.id !== FORMER_MAIN_ID && row.enabled && row.type === 'oauth',
          )
          .map((row) => row.id),
      ]
    },
    resolveResetTarget: async (accountKey) => {
      await requireLocal()
      if (accountKey === FORMER_MAIN_ID) {
        // Asking the model registry for the key can refresh and write Pi's login.
        // Use only a token Pi has already resolved and given to the extension.
        const accessToken = main.currentToken()
        if (!accessToken) throw new Error('Pi holds no OpenAI login')
        return {
          accountKey,
          label: 'Main account',
          accessToken,
          chatgptAccountId: main.currentIdentity(),
        }
      }
      const { rows } = await pool.load()
      const row = rows.find((row) => row.id === accountKey)
      if (!row?.candidate || row.type !== 'oauth')
        throw new Error(
          'The pool row is missing or disabled, or holds no OAuth login',
        )
      await pool.refreshDueTokens([row], await options.storage())
      await requireLocal()
      const current = pool.peek().rows.find((row) => row.id === accountKey)
      const accessToken = current?.candidate
        ? pool.usableToken(current)
        : undefined
      if (!current || !accessToken)
        throw new Error('The pool row holds no usable access token')
      return {
        accountKey,
        label: accountKey,
        accessToken,
        chatgptAccountId: current.identity ?? identityOfToken(accessToken),
      }
    },
    refreshResetTargetQuota: async (account) => {
      await requireLocal()
      const result =
        account === FORMER_MAIN_ID
          ? await main.pollNow()
          : (
              await pool.pollRows(await options.storage(), { ids: [account] })
            )[0]
      return {
        account,
        ...(result ?? {
          ok: false,
          error: 'targeted quota refresh returned no result',
        }),
      }
    },
    quotaManager: {
      // Pi uses the quota windows themselves rather than a separate mark cache.
      isRateLimited: () => false,
      getMain: () => entry(main.quotaSnapshot()),
      getFallback: (id) => entry(pool.polledQuota(id)),
    },
  }
}

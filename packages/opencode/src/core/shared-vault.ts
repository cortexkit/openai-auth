import { resolve } from 'node:path'
import { resolveClaustrumConnectionPath } from '@cortexkit/claustrum-client'
import {
  type AccountPaths,
  OpenAiVault,
  type OpenAiVaultOptions,
} from '@cortexkit/openai-auth-core/internal'

const QUOTA_POLL_INTERVAL_MS = 60_000
const QUOTA_STALE_AFTER_MS = 4 * 60_000

type Holder = { reservedRouteIds: () => Iterable<string> }
type Entry = {
  vault: OpenAiVault
  holders: Set<Holder>
  firstRoster: PromiseWithResolvers<void>
  started: boolean
  quotaPoll?: ReturnType<typeof setInterval>
}

// Both OpenCode entries may be bundled/loaded separately in one process.
const registryKey = Symbol.for('@cortexkit/openai-auth/opencode-vaults')
const processState = globalThis as typeof globalThis & {
  [registryKey]?: Map<string, Entry>
}
const entries = processState[registryKey] ?? new Map<string, Entry>()
processState[registryKey] = entries

/** A plugin owns a lease, not the host's consumer or either of its pollers. */
export function acquireOpenCodeVault(
  options: OpenAiVaultOptions,
  poolPaths: AccountPaths,
) {
  const isolated = Boolean(options.connectScoped || options.connectEnrollment)
  const stateDir = resolve(options.stateDir)
  const connectionFile = resolve(
    (options.connectionFile ?? resolveClaustrumConnectionPath)(),
  )
  const key = JSON.stringify([
    options.host,
    stateDir,
    connectionFile,
    resolve(poolPaths.configPath),
    resolve(poolPaths.statePath),
  ])
  const holder: Holder = {
    reservedRouteIds: options.reservedRouteIds ?? (() => []),
  }
  let entry = isolated ? undefined : entries.get(key)
  if (!entry) {
    const holders = new Set<Holder>()
    const vault = new OpenAiVault({
      ...options,
      stateDir,
      connectionFile: () => connectionFile,
      // ClaustrumClient uses projectRoot only as identity.project_root metadata; scoped authorization uses the enrollment token.
      ...(!isolated ? { projectRoot: stateDir } : {}),
      // Holders use the same store; consult only live sources, including one
      // already loaded while another project's loader is still starting.
      reservedRouteIds: () =>
        new Set([...holders].flatMap((live) => [...live.reservedRouteIds()])),
    })
    entry = {
      vault,
      holders,
      firstRoster: Promise.withResolvers<void>(),
      started: false,
    }
    if (!isolated) entries.set(key, entry)
  }
  entry.holders.add(holder)
  const owned = entry
  let released = false
  return {
    vault: owned.vault,
    firstRoster: owned.firstRoster.promise,
    start() {
      if (released || owned.started) return
      owned.started = true
      const pollQuota = () => {
        if (owned.holders.size && owned.vault.enrolled())
          void owned.vault.pollStale(QUOTA_STALE_AFTER_MS)
      }
      // Start joins this first read; later holders must not call refresh,
      // which deliberately starts a new discovery after an in-flight one.
      const first = owned.vault.refresh()
      owned.vault.start()
      void first.finally(() => {
        owned.firstRoster.resolve()
        pollQuota()
      })
      owned.quotaPoll = setInterval(pollQuota, QUOTA_POLL_INTERVAL_MS)
      owned.quotaPoll.unref?.()
    },
    release() {
      if (released) return
      released = true
      owned.holders.delete(holder)
      if (owned.holders.size !== 0) return
      if (owned.quotaPoll) clearInterval(owned.quotaPoll)
      owned.vault.close()
      owned.firstRoster.resolve()
      if (!isolated && entries.get(key) === owned) entries.delete(key)
    },
  }
}

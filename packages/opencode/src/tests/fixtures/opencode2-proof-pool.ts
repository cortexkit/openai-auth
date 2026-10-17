// Imported inside the OpenCode 2 host by the probe plugin of
// `opencode2-proof-host.ts` when it replays a captured request. A replay is
// sent outside any host request, so no hook hands it a bearer: this resolves a
// fresh one for the pool account that served the session, through the
// plugin's own pool reader (`PoolAccountSource.accessFor`, the call meant for
// sends outside a request). It reads only the plugin's pool files; the host's
// credential store holds just a placeholder and is never read.

import { loadAccounts } from '@cortexkit/openai-auth-core/internal'
import { getAccountPaths } from '../../core/account-paths'
import { PoolAccountSource } from '../../core/pool-account-source'

export async function freshAccess(
  configDir: string,
  accountIdentity: string | undefined,
): Promise<{ row: string; token: string } | undefined> {
  const paths = getAccountPaths(`${configDir}/openai-auth.json`)
  const source = new PoolAccountSource({
    paths: () => paths,
    refreshProvider: async () => {
      throw new Error('the proof never refreshes a token')
    },
    pullQuota: async () => undefined,
  })
  try {
    const view = await source.load()
    const row = view.rows.find((entry) => entry.identity === accountIdentity)
    if (!row) return undefined
    const access = await source.accessFor(row.id, await loadAccounts(paths))
    return access ? { row: access.row.id, token: access.token } : undefined
  } finally {
    source.dispose()
  }
}

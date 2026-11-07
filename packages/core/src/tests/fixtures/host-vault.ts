import {
  type ClaustrumScopedClient,
  connectClaustrumScopedClient,
} from '@cortexkit/common-auth/claustrum'

/** Install the host's relay over the mock vault, outside the plugin's native connector. */
export async function installVaultRelay(connectionFile: string) {
  const client = await connectClaustrumScopedClient({ connectionFile })
  const key = Symbol.for('cortexkit.vault')
  const globals = globalThis as typeof globalThis & {
    [key]?: (pluginId: string) => ClaustrumScopedClient
  }
  const previous = globals[key]
  const marker = process.env.CORTEXKIT_VAULT_HOST
  const pluginIds: string[] = []
  const usage: Parameters<
    NonNullable<ClaustrumScopedClient['reportUsageScoped']>
  >[0][] = []
  // Like Thalamus's accessor, every call returns a new client its caller owns;
  // `closed` records which of them (by call order) were closed.
  const closed: number[] = []
  globals[key] = (pluginId) => {
    const index = pluginIds.push(pluginId) - 1
    return {
      listScoped: (...args) => client.listScoped(...args),
      getScoped: (input) => client.getScoped(input),
      reportAuthFailureScoped: (input) => client.reportAuthFailureScoped(input),
      reportUsageScoped: async (input) => {
        usage.push(input)
      },
      insula: client.insula,
      close() {
        closed.push(index)
      },
    }
  }
  process.env.CORTEXKIT_VAULT_HOST = 'thalamus'
  return {
    pluginIds,
    usage,
    closed,
    async close() {
      if (previous) globals[key] = previous
      else delete globals[key]
      if (marker === undefined) delete process.env.CORTEXKIT_VAULT_HOST
      else process.env.CORTEXKIT_VAULT_HOST = marker
      client.close()
    },
  }
}

import type { PluginInput } from '@opencode-ai/plugin'
import { CodexAuthPlugin } from '../../index'
import { discoverPortFile } from '../../rpc/port-file'
import { resolveRpcDir } from '../../rpc/rpc-dir'

// A separate process gives the two loaders independent settings caches.
const directory = process.argv[2]
if (!directory) throw new Error('missing loader directory')
const nativeFetch = globalThis.fetch
globalThis.fetch = Object.assign(
  async () => new Response('{}', { status: 503 }),
  {
    preconnect: () => {},
  },
) as typeof fetch
const plugin = await CodexAuthPlugin(
  {
    client: {
      auth: { set: async () => {} },
      session: { promptAsync: async () => {} },
    },
    directory,
    worktree: directory,
    serverUrl: new URL('http://localhost:0'),
  } as unknown as PluginInput,
  { experimentalWebSockets: false },
)
try {
  const loader = plugin.auth?.loader
  if (!loader) throw new Error('missing auth loader')
  await loader(
    async () => ({
      type: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
      expires: Date.now() + 3600_000,
    }),
    { id: 'openai', models: [] } as never,
  )
  const rpc = await resolveRpcDir(directory)
  const port = await discoverPortFile(rpc.dir, process.pid)
  if (!port) throw new Error('missing loader RPC port')
  const response = await nativeFetch(
    `http://127.0.0.1:${port.port}/rpc/apply`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${port.token}`,
      },
      body: JSON.stringify({
        command: 'openai',
        sectionId: 'diagnostics',
        actionId: 'dump',
        values: { enabled: false },
      }),
    },
  )
  const result = (await response.json()) as { ok: boolean }
  if (!response.ok || !result.ok) throw new Error(JSON.stringify(result))
  console.log('separate loader turned dumps off through /openai')
} finally {
  await plugin.dispose?.()
}

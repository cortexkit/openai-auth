import { adoptRpcServer } from '@cortexkit/common-auth/rpc'
import type { Plugin } from '@opencode/plugin'
import {
  drainNotifications,
  isTuiConnected,
  pushNotification,
} from '../rpc/notifications'
import type { ApplyResult, OpenDialogPayload } from '../rpc/protocol'
import { resolveRpcDir } from '../rpc/rpc-dir'
import { RPC_SERVER_REGISTRY_KEY, startRpcServer } from '../rpc/rpc-server'

/** Server-owned menu callbacks; registering the real menu is a separate opt-in. */
export interface ControlPlaneMenu {
  open(sessionId: string): Promise<OpenDialogPayload>
  apply(request: unknown): Promise<ApplyResult>
}

type Context = Pick<Plugin.Context, 'command' | 'location' | 'session'>
type Location = {
  menu: ControlPlaneMenu
  registration?: { dispose(): Promise<void> }
}
type Registry = {
  locations: Map<string, Location>
}
const KEY = Symbol.for('cortexkit.openai-auth.v2.commands')

function registry(): Registry {
  const process = globalThis as typeof globalThis & { [KEY]?: Registry }
  process[KEY] ??= { locations: new Map() }
  return process[KEY]
}

/** The host scopes command transforms to a location, so each location owns one. */
export async function installControlPlane(
  ctx: Context,
  menu: ControlPlaneMenu,
) {
  const state = registry()
  const directory = ctx.location.directory
  const location: Location = { menu }
  const rpcDir = await resolveRpcDir(directory)
  const rpc = await adoptRpcServer(RPC_SERVER_REGISTRY_KEY, rpcDir.dir, () =>
    startRpcServer({
      ...rpcDir,
      drain: drainNotifications,
      apply: (request) => menu.apply(request),
    }),
  )
  const previous = state.locations.get(directory)
  state.locations.set(directory, location)
  await previous?.registration?.dispose()
  try {
    location.registration = await ctx.command.transform((editor) => {
      editor.add({
        name: 'openai',
        description: 'OpenAI account menu',
        async execute(input) {
          // Session identity, not the first setup's directory, selects the owner.
          const session = await ctx.session.get({ sessionID: input.sessionID })
          const owner = state.locations.get(session.location.directory)
          if (!owner || !isTuiConnected(input.sessionID)) return
          const payload = await owner.menu.open(input.sessionID)
          pushNotification(payload, input.sessionID)
        },
      })
    })
  } catch (error) {
    if (state.locations.get(directory) === location)
      state.locations.delete(directory)
    await rpc.release()
    throw error
  }
  let disposed = false
  return async () => {
    if (disposed) return
    disposed = true
    if (state.locations.get(directory) === location)
      state.locations.delete(directory)
    await rpc.release()
    await location.registration?.dispose()
  }
}

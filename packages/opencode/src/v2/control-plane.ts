import { adoptRpcServer } from '@cortexkit/common-auth/rpc'
import type { Plugin } from '@opencode/plugin'
import { createLogger } from '../logger'
import {
  drainNotifications,
  pushNotification,
  waitForTuiConnected,
} from '../rpc/notifications'
import type { ApplyResult, OpenDialogPayload } from '../rpc/protocol'
import { resolveRpcDir } from '../rpc/rpc-dir'
import { RPC_SERVER_REGISTRY_KEY, startRpcServer } from '../rpc/rpc-server'

/** Server-owned menu callbacks shared by command dispatch and loopback RPC. */
export interface ControlPlaneMenu {
  open(sessionId: string): Promise<OpenDialogPayload>
  apply(request: unknown): Promise<ApplyResult>
}

type Context = Pick<Plugin.Context, 'command' | 'location' | 'session'>
type Location = {
  menu: ControlPlaneMenu
  session: Context['session']
  closed: AbortController
  registration?: { dispose(): Promise<void> }
}
type Registry = {
  locations: Map<string, Location>
  command?: {
    name: string
    description: string
    execute(input: { sessionID: string }): Promise<void>
  }
}
const KEY = Symbol.for('cortexkit.openai-auth.v2.commands')
const log = createLogger('v2-command')

function refuse(state: string) {
  log.warn(`/openai needs the terminal UI (session state: ${state}).`)
}

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
  const location: Location = {
    menu,
    session: ctx.session,
    closed: new AbortController(),
  }
  const rpcDir = await resolveRpcDir(directory)
  const rpc = await adoptRpcServer(RPC_SERVER_REGISTRY_KEY, rpcDir.dir, () =>
    startRpcServer({
      ...rpcDir,
      drain: drainNotifications,
      apply: (request) => {
        const owner = state.locations.get(directory)
        if (!owner) throw new Error('The OpenAI menu location was closed')
        return owner.menu.apply(request)
      },
    }),
  )
  const previous = state.locations.get(directory)
  state.locations.set(directory, location)
  previous?.closed.abort()
  await previous?.registration?.dispose()
  state.command ??= {
    name: 'openai',
    description: 'OpenAI account menu',
    async execute(input) {
      // Any live location can read the host's process-wide session service.
      const api = state.locations.values().next().value?.session
      if (!api) return refuse('no live location')
      const session = await api.get({ sessionID: input.sessionID })
      const owner = state.locations.get(session.location.directory)
      if (!owner) return refuse('location closed')
      const connected = await waitForTuiConnected(
        input.sessionID,
        owner.closed.signal,
      )
      if (
        !connected ||
        state.locations.get(session.location.directory) !== owner
      ) {
        if (!connected && !owner.closed.signal.aborted) {
          // A slow server can miss the 2 s first-poll window while the TUI
          // keeps polling behind it. Leave a notice the TUI shows as a toast
          // at its next successful poll, so the refusal is visible. It adds
          // nothing to the conversation: the queue only feeds the TUI poll.
          // Session-targeted, so the draining TUI prunes it after showing it
          // once; the process-wide queue cap bounds it when no TUI ever
          // drains it (QUEUE_CAP in common-auth `src/rpc/notifications.ts`).
          pushNotification(
            {
              command: 'openai',
              notify: {
                message:
                  '/openai timed out waiting for the terminal UI. Run it again.',
                kind: 'warning',
              },
            },
            input.sessionID,
          )
        }
        return refuse(
          owner.closed.signal.aborted
            ? 'location closed'
            : 'no TUI poll within 2 s',
        )
      }
      const payload = await owner.menu.open(input.sessionID)
      pushNotification(payload, input.sessionID)
    },
  }
  const command = state.command
  try {
    location.registration = await ctx.command.transform((editor) => {
      editor.add(command)
    })
  } catch (error) {
    location.closed.abort()
    if (state.locations.get(directory) === location)
      state.locations.delete(directory)
    await rpc.release()
    throw error
  }
  let disposed = false
  return async () => {
    if (disposed) return
    disposed = true
    location.closed.abort()
    if (state.locations.get(directory) === location)
      state.locations.delete(directory)
    await rpc.release()
    await location.registration?.dispose()
  }
}

/** @jsxImportSource @opentui/solid */
import type { Plugin } from '@opencode/plugin/tui'
import {
  type ApplyRequest,
  type ApplyResult,
  isNotifyPayload,
  type OpenDialogPayload,
} from '../rpc/protocol'
import { createRpcClient } from '../rpc/rpc-client'
import { resolveRpcDir } from '../rpc/rpc-dir'
import { openControlDialog } from './v2-dialog'

export interface TuiTransportOptions {
  /** Only the test fixture supplies content until the sidebar is implemented. */
  sidebarText?: string
  openDialog?: (
    payload: OpenDialogPayload,
    apply: (request: Omit<ApplyRequest, 'sessionId'>) => Promise<ApplyResult>,
  ) => Promise<void>
}

const KEY = Symbol.for('cortexkit.openai-auth.v2.tui')
type Mount = { dispose(): void }
type State = { mount?: Mount; lastIds: Map<string, number> }

/** Uses OpenCode 2's transport without running the OpenCode 1 UI registration. */
export async function setupTui(
  context: Plugin.Context,
  options: TuiTransportOptions = {},
) {
  const processState = globalThis as typeof globalThis & { [KEY]?: State }
  processState[KEY] ??= { lastIds: new Map() }
  const state = processState[KEY]
  state.mount?.dispose()
  const openDialog: NonNullable<TuiTransportOptions['openDialog']> =
    options.openDialog ??
    ((payload, apply) =>
      openControlDialog(context.ui.dialog, payload, apply, () => !disposed))
  let disposed = false
  let inFlight = false
  let dialogOpen = false
  let directory = ''
  let client: ReturnType<typeof createRpcClient> | undefined
  const unmount =
    options.sidebarText === undefined
      ? undefined
      : context.ui.slot({
          append: 'sidebar.content',
          render: () => <text>{options.sidebarText}</text>,
        })

  const poll = async () => {
    if (disposed || inFlight || dialogOpen) return
    const route = context.ui.router.current()
    if (route.type !== 'session') return
    const sessionId = route.sessionID
    const session = context.data.session.get(sessionId)
    if (!session) return
    inFlight = true
    try {
      if (directory !== session.location.directory) {
        directory = session.location.directory
        const resolved = await resolveRpcDir(directory)
        if (disposed) return
        client = createRpcClient(resolved.dir, process.pid)
      }
      const rpc = client
      if (!rpc) return
      const messages = await rpc.pending(
        state.lastIds.get(sessionId) ?? 0,
        sessionId,
      )
      if (
        disposed ||
        context.ui.router.current().type !== 'session' ||
        (context.ui.router.current() as { sessionID?: string }).sessionID !==
          sessionId
      )
        return
      for (const message of [...messages].sort((a, b) => a.id - b.id)) {
        state.lastIds.set(
          sessionId,
          Math.max(state.lastIds.get(sessionId) ?? 0, message.id),
        )
        if (isNotifyPayload(message.payload))
          context.ui.toast.show({
            message: message.payload.notify.message,
            sessionID: sessionId,
          })
        else {
          dialogOpen = true
          await openDialog(message.payload, (request) => {
            if (disposed) throw new Error('The OpenAI dialog was closed')
            return rpc.apply({ ...request, sessionId }, 90_000)
          }).finally(() => {
            dialogOpen = false
          })
        }
      }
    } catch {
      // The server can be absent while a location starts or is reloaded.
    } finally {
      inFlight = false
    }
  }
  const timer = setInterval(() => {
    void poll()
  }, 500)
  const mount: Mount = {
    dispose() {
      if (disposed) return
      disposed = true
      clearInterval(timer)
      unmount?.()
      if (dialogOpen) context.ui.dialog.clear()
      if (state.mount === mount) state.mount = undefined
    },
  }
  state.mount = mount
  void poll()
  return () => mount.dispose()
}

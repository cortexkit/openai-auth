/** @jsxImportSource @opentui/solid */
import type { Plugin } from '@opencode/plugin/tui'
import type { JSX } from 'solid-js'
import { createLogger } from '../logger'
import {
  type ApplyRequest,
  type ApplyResult,
  isNotifyPayload,
  type OpenDialogPayload,
} from '../rpc/protocol'
import { createRpcClient, type RpcClient } from '../rpc/rpc-client'
import { resolveRpcDir } from '../rpc/rpc-dir'
import { openControlDialog } from './v2-dialog'

/**
 * How long one `pending` poll may take before the client gives up on it.
 * The shared default is 2 s, which a busy OpenCode server exceeds on every
 * poll, so a queued menu waits for a lucky fast poll. Retrying with a longer
 * budget is safe: the server prunes only notifications at or below the
 * client's cursor (`drainNotifications` in common-auth
 * `src/rpc/notifications.ts`), so a reply the client never read is sent again.
 */
export const PENDING_POLL_TIMEOUT_MS = 15_000
/** Consecutive failed polls before the TUI says the server is slow. */
export const SLOW_SERVER_POLL_FAILURES = 3
/** Poll failures log at most one line per minute, no matter how fast polls fail. */
export const POLL_FAILURE_LOG_INTERVAL_MS = 60_000
/** Toast shown once per stretch of failed polls, through the host's surface. */
export const SLOW_SERVER_MESSAGE =
  'Waiting for the OpenAI plugin: the OpenCode server is slow.'

/**
 * The error's class for poll-failure logs: never its message, which can carry
 * the request URL with the RPC bearer token.
 */
export function pollFailureClass(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error
}

const log = createLogger('rpc-tui')

export interface TuiTransportOptions {
  /** Test-only label for proving that the host can render a sidebar component. */
  sidebarText?: string
  sidebar?: {
    render(input: { sessionID: string }): JSX.Element
    dispose(): void
  }
  openDialog?: (
    payload: OpenDialogPayload,
    apply: (request: Omit<ApplyRequest, 'sessionId'>) => Promise<ApplyResult>,
  ) => Promise<void>
  /**
   * Builds the RPC client the poll drains. Tests inject failures here; a
   * host setup that runs again needs its own RPC client.
   */
  createRpcClient?: (dir: string, expectedPid?: number) => RpcClient
  /** Timer seam so tests can drive poll cycles without wall-clock waits. */
  setIntervalImpl?: typeof globalThis.setInterval
  clearIntervalImpl?: typeof globalThis.clearInterval
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
  let client: RpcClient | undefined
  // Stretches of consecutive failed polls end at the next success, which
  // re-arms both the log line and the slow-server toast.
  let consecutiveFailures = 0
  let lastPollFailureLogAt = 0
  const makeClient =
    options.createRpcClient ??
    ((dir: string, expectedPid?: number) => createRpcClient(dir, expectedPid))
  const setIntervalImpl = options.setIntervalImpl ?? setInterval
  const clearIntervalImpl = options.clearIntervalImpl ?? clearInterval
  const unmount =
    options.sidebarText === undefined
      ? options.sidebar
        ? context.ui.slot({
            append: 'sidebar.content',
            render: options.sidebar.render,
          })
        : undefined
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
    // Counts one failed poll: after a few in a row the TUI says through the
    // host's toast that the server is slow instead of staying silent, and
    // logs at most one line a minute with the error class only.
    const notePollFailure = (error: unknown) => {
      consecutiveFailures++
      const now = Date.now()
      if (now - lastPollFailureLogAt >= POLL_FAILURE_LOG_INTERVAL_MS) {
        lastPollFailureLogAt = now
        log.warn('OpenAI plugin poll failed', {
          error: pollFailureClass(error),
        })
      }
      if (consecutiveFailures === SLOW_SERVER_POLL_FAILURES)
        context.ui.toast.show({
          message: SLOW_SERVER_MESSAGE,
          sessionID: sessionId,
        })
    }
    inFlight = true
    try {
      if (directory !== session.location.directory) {
        directory = session.location.directory
        const resolved = await resolveRpcDir(directory)
        if (disposed) return
        client = makeClient(resolved.dir, process.pid)
      }
      const rpc = client
      if (!rpc) return
      const pollStartedAt = Date.now()
      const messages = await rpc.pending(
        state.lastIds.get(sessionId) ?? 0,
        sessionId,
        PENDING_POLL_TIMEOUT_MS,
      )
      // A poll counts as failed when it throws, or when it answers empty
      // after taking at least its own timeout: a socket timeout resolves to
      // no messages instead of throwing, so elapsed time is the only signal
      // a slow server leaves. A fast empty poll is a healthy idle server.
      if (
        messages.length === 0 &&
        Date.now() - pollStartedAt >= PENDING_POLL_TIMEOUT_MS
      ) {
        notePollFailure(
          new Error(
            `RPC pending poll timed out after ${PENDING_POLL_TIMEOUT_MS} ms`,
          ),
        )
        return
      }
      consecutiveFailures = 0
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
    } catch (error) {
      // The server can be absent while a location starts or is reloaded.
      notePollFailure(error)
    } finally {
      inFlight = false
    }
  }
  const timer = setIntervalImpl(() => {
    void poll()
  }, 500)
  const mount: Mount = {
    dispose() {
      if (disposed) return
      disposed = true
      clearIntervalImpl(timer)
      unmount?.()
      options.sidebar?.dispose()
      if (dialogOpen) context.ui.dialog.clear()
      if (state.mount === mount) state.mount = undefined
    },
  }
  state.mount = mount
  void poll()
  return () => mount.dispose()
}

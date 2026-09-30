/**
 * The plugin's notification queue, on the shared RPC machinery.
 *
 * `@cortexkit/common-auth/rpc` keeps one queue per scope. This plugin has
 * always used a single queue for the whole process, shared by every plugin
 * instance and drained by whichever RPC server the TUI reaches, so every call
 * here passes the same constant scope. Its fields are only a lookup key: the
 * queue is in memory and nothing is written under `rpcRoot`.
 */
import {
  drainNotifications as drainCommonNotifications,
  isTuiConnected as isCommonTuiConnected,
  type NotificationScope,
  pushNotification as pushCommonNotification,
  resetNotificationsForTest as resetCommonNotificationsForTest,
} from '@cortexkit/common-auth/rpc'
import type { OpenDialogPayload, RpcNotification } from './protocol'
import { RPC_DIRECTORY_PREFIX } from './rpc-dir'

const PROCESS_QUEUE_SCOPE: NotificationScope = {
  rpcRoot: 'openai-auth',
  directoryPrefix: RPC_DIRECTORY_PREFIX,
  registrationSessionId: 'process',
}

export function pushNotification(
  payload: OpenDialogPayload,
  sessionId?: string,
): void {
  pushCommonNotification(PROCESS_QUEUE_SCOPE, payload, sessionId)
}

export function drainNotifications(
  lastReceivedId = 0,
  sessionId?: string,
): RpcNotification[] {
  // Only payloads built by this plugin are ever pushed, so each carries one of
  // its command names.
  return drainCommonNotifications(
    PROCESS_QUEUE_SCOPE,
    lastReceivedId,
    sessionId,
  ) as RpcNotification[]
}

export function isTuiConnected(sessionId: string): boolean {
  return isCommonTuiConnected(PROCESS_QUEUE_SCOPE, sessionId)
}

export function resetNotificationsForTest(): void {
  resetCommonNotificationsForTest(PROCESS_QUEUE_SCOPE)
}

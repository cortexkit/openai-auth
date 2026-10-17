// What crosses the loopback RPC between the plugin process and its TUI.
//
// The dialog and apply shapes are the shared command menu's
// (`@cortexkit/common-auth/commands`): the plugin's one `/openai` command
// opens the menu, and the TUI's drawer applies one action at a time.
import type {
  CommandApplyRequest,
  CommandApplyResult,
  CommandDialogPayload,
  NotifyKind,
} from '@cortexkit/common-auth/commands'

/** The menu, as the slash command opens it in the TUI. */
export type OpenDialogPayload = CommandDialogPayload

/**
 * A message for the user from work a menu action left running (a login that
 * finishes after the action returned).
 */
export interface NotifyPayload {
  command: string
  notify: { message: string; kind: NotifyKind }
}

export interface RpcNotification {
  id: number
  type: 'open-dialog'
  payload: OpenDialogPayload | NotifyPayload
  sessionId?: string
}

/** One action applied from the drawer. */
export type ApplyRequest = CommandApplyRequest

/** Its message and the refreshed menu. */
export type ApplyResult = CommandApplyResult

/** Whether a pushed notification is the menu itself or a message. */
export function isNotifyPayload(
  payload: OpenDialogPayload | NotifyPayload,
): payload is NotifyPayload {
  return 'notify' in payload
}

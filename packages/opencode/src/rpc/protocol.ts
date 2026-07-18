export type CommandModalName =
  | 'openai-quota'
  | 'openai-account'
  | 'openai-routing'
  | 'openai-killswitch'
  | 'openai-dump'
  | 'openai-logging'
  | 'openai-cachekeep'
  | 'openai-reset'

export interface OpenDialogPayload {
  command: CommandModalName
  text: string
  knobs: Record<string, unknown>
}

export interface RpcNotification {
  id: number
  type: 'open-dialog'
  payload: OpenDialogPayload
  sessionId?: string
}

export interface ApplyRequest {
  command: CommandModalName
  arguments: string
}

export interface ApplyResult {
  text: string
  knobs: Record<string, unknown>
}

/**
 * The RPC payload types now live in the shared core, because both hosts build
 * the same payloads. This file stays on disk as a re-export so the existing
 * build entry and every importer that names `rpc/protocol` keep working.
 */
export type {
  ApplyRequest,
  ApplyResult,
  CommandModalName,
  OpenDialogPayload,
  RpcNotification,
} from '@cortexkit/openai-auth-core/internal'

/**
 * The TUI's RPC client, on the shared RPC machinery, typed with this plugin's
 * payloads.
 */
import {
  createRpcClient as createCommonRpcClient,
  type PortFileEntry,
} from '@cortexkit/common-auth/rpc/client'
import type { ApplyRequest, ApplyResult, RpcNotification } from './protocol'

export { DEFAULT_RPC_TIMEOUT_MS } from '@cortexkit/common-auth/rpc/client'

export interface RpcClient {
  pending: (
    lastReceivedId: number,
    sessionId?: string,
  ) => Promise<RpcNotification[]>
  apply: (request: ApplyRequest, timeoutMs?: number) => Promise<ApplyResult>
}

export function createRpcClient(
  dir: string,
  expectedPid?: number,
  onSelected?: (entry: PortFileEntry | null) => void,
): RpcClient {
  // The server this client reaches only queues payloads built by this plugin
  // (the `/openai` menu and its messages); the shared client is typed with
  // the older dialog shape but passes bodies through unchanged.
  return createCommonRpcClient(
    dir,
    expectedPid,
    onSelected,
  ) as unknown as RpcClient
}

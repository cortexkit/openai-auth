/**
 * The plugin's RPC server, on the shared RPC machinery.
 *
 * What stays here is what identifies this plugin: which state directories the
 * startup sweep may clean (see `isOpenaiRpcStateDir`), the `rpc` log channel,
 * and the command types its apply handler receives.
 */
import {
  type RpcServerHandle,
  startRpcServer as startCommonRpcServer,
} from '@cortexkit/common-auth/rpc'
import { createLogger } from '../logger'
import { isOpenaiRpcStateDir } from './port-file'
import type { ApplyRequest, ApplyResult, RpcNotification } from './protocol'

export type { RpcServerHandle } from '@cortexkit/common-auth/rpc'

const log = createLogger('rpc')

/**
 * Registry of running servers, one per project directory, shared by every
 * plugin instance in the process. The name is the global this plugin has
 * always kept its servers under.
 */
export const RPC_SERVER_REGISTRY_KEY = '__openaiAuthRpcServers'

export interface RpcServerOptions {
  dir: string
  secureDir?: boolean
  sweepRoot?: string
  drain: (lastReceivedId: number, sessionId?: string) => RpcNotification[]
  apply: (request: ApplyRequest) => Promise<ApplyResult>
  // Bounds handler execution via the socket inactivity timer.
  timeoutMs?: number
  // Bounds request delivery only (requestTimeout/headersTimeout).
  receiptTimeoutMs?: number
}

export function startRpcServer(
  options: RpcServerOptions,
): Promise<RpcServerHandle> {
  return startCommonRpcServer({
    ...options,
    isManagedDir: isOpenaiRpcStateDir,
    log,
    // The shared server hands over the parsed request body as it arrived, the
    // same body this plugin's handler has always received.
    apply: (request) => options.apply(request as ApplyRequest),
  })
}

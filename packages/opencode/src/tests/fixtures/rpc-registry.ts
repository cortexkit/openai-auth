import { RPC_SERVER_REGISTRY_KEY } from '../../rpc/rpc-server'

/**
 * The process-wide map of running RPC servers, keyed by RPC directory.
 *
 * `adoptRpcServer` from @cortexkit/common-auth/rpc keeps it on `globalThis`
 * under `Symbol.for(<registry key>)`, as `{ servers, pending }`. Tests read it
 * to check which servers a plugin instance registered and released.
 */
export function rpcServerRegistry<T = unknown>(): Map<string, T> | undefined {
  const globals = globalThis as unknown as Record<
    symbol,
    { servers: Map<string, T> } | undefined
  >
  return globals[Symbol.for(RPC_SERVER_REGISTRY_KEY)]?.servers
}

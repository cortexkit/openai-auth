import { discoverPortFile, type PortFileEntry } from './port-file'
import type { ApplyRequest, ApplyResult, RpcNotification } from './protocol'

export interface RpcClient {
  pending: (
    lastReceivedId: number,
    sessionId?: string,
  ) => Promise<RpcNotification[]>
  apply: (request: ApplyRequest, timeoutMs?: number) => Promise<ApplyResult>
}

export const DEFAULT_RPC_TIMEOUT_MS = 2_000

async function call<T>(
  dir: string,
  expectedPid: number | undefined,
  onSelected: ((entry: PortFileEntry | null) => void) | undefined,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
): Promise<T | null> {
  const entry = await discoverPortFile(dir, expectedPid)
  onSelected?.(entry)
  if (!entry) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`http://127.0.0.1:${entry.port}/rpc/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${entry.token}`,
      },
      body: JSON.stringify(params),
      signal: controller.signal,
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export function createRpcClient(
  dir: string,
  expectedPid?: number,
  onSelected?: (entry: PortFileEntry | null) => void,
): RpcClient {
  let reportedSelection = false
  const reportSelected = (entry: PortFileEntry | null) => {
    if (reportedSelection) return
    reportedSelection = true
    onSelected?.(entry)
  }
  return {
    async pending(lastReceivedId, sessionId) {
      const out = await call<{ messages: RpcNotification[] }>(
        dir,
        expectedPid,
        reportSelected,
        'pending-notifications',
        { lastReceivedId, sessionId },
      )
      return out?.messages ?? []
    },
    async apply(request, timeoutMs) {
      const out = await call<ApplyResult>(
        dir,
        expectedPid,
        reportSelected,
        'apply',
        {
          ...request,
        },
        timeoutMs,
      )
      return out ?? { text: 'apply failed', knobs: {} }
    },
  }
}

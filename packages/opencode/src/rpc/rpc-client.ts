import { discoverPortFile, type PortFileEntry } from './port-file'
import type { ApplyRequest, ApplyResult, RpcNotification } from './protocol'

export interface RpcClient {
  pending: (
    lastReceivedId: number,
    sessionId?: string,
  ) => Promise<RpcNotification[]>
  apply: (request: ApplyRequest) => Promise<ApplyResult>
}

async function call<T>(
  dir: string,
  expectedPid: number | undefined,
  onSelected: ((entry: PortFileEntry | null) => void) | undefined,
  method: string,
  params: Record<string, unknown>,
): Promise<T | null> {
  const entry = await discoverPortFile(dir, expectedPid)
  onSelected?.(entry)
  if (!entry) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2_000)
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
    async apply(request) {
      const out = await call<ApplyResult>(
        dir,
        expectedPid,
        reportSelected,
        'apply',
        {
          ...request,
        },
      )
      return out ?? { text: 'apply failed', knobs: {} }
    },
  }
}

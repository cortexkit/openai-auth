import type { OpenDialogPayload, RpcNotification } from './protocol'

const QUEUE_CAP = 100
const TUI_CONNECTED_WINDOW_MS = 3_000

let queue: RpcNotification[] = []
let nextId = 1
let lastDrainAtAny = 0
const lastDrainAtBySession = new Map<string, number>()

export function pushNotification(
  payload: OpenDialogPayload,
  sessionId?: string,
): void {
  queue.push({ id: nextId++, type: 'open-dialog', payload, sessionId })
  if (queue.length > QUEUE_CAP) queue = queue.slice(queue.length - QUEUE_CAP)
}

export function drainNotifications(
  lastReceivedId = 0,
  sessionId?: string,
): RpcNotification[] {
  const now = Date.now()
  lastDrainAtAny = now
  if (sessionId !== undefined) lastDrainAtBySession.set(sessionId, now)
  const matches = (n: RpcNotification) =>
    sessionId === undefined ||
    n.sessionId === undefined ||
    n.sessionId === sessionId
  if (lastReceivedId > 0) {
    queue = queue.filter((n) => {
      if (n.id > lastReceivedId) return true
      if (sessionId === undefined) return false
      return n.sessionId !== sessionId
    })
  }
  return queue.filter((n) => n.id > lastReceivedId && matches(n))
}

export function isTuiConnected(sessionId?: string): boolean {
  const now = Date.now()
  if (sessionId !== undefined) {
    const at = lastDrainAtBySession.get(sessionId) ?? 0
    return at > 0 && now - at < TUI_CONNECTED_WINDOW_MS
  }
  return lastDrainAtAny > 0 && now - lastDrainAtAny < TUI_CONNECTED_WINDOW_MS
}

export function resetNotificationsForTest(): void {
  queue = []
  nextId = 1
  lastDrainAtAny = 0
  lastDrainAtBySession.clear()
}

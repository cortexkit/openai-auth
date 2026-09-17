const stickyRoutingBySession = new Map<string, string>()

export function getPiStickyRouting(sessionId: string): string | undefined {
  return stickyRoutingBySession.get(sessionId)
}

export function clearPiStickyRouting(sessionId: string): boolean {
  return stickyRoutingBySession.delete(sessionId)
}

export function setPiStickyRouting(sessionId: string, accountId: string): void {
  stickyRoutingBySession.set(sessionId, accountId)
}

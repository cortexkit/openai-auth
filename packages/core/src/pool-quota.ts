// Converting between openai-auth's quota snapshots and the account pool's
// quota map (`@cortexkit/common-auth/quota`).
//
// openai-auth reads quota as a fixed snapshot: a `primary` and a `secondary`
// window plus the credit budget (`spendControl`). The pool stores a map of
// labelled limits and a budget entry, and merges observations into it. Every
// response header set and WebSocket rate-limit frame a pooled request produces
// (on OpenCode once the install is migrated, on Pi always) is turned into one
// observation here and recorded against the row that served it; the
// killswitch, which still judges the two fixed windows, reads the windows back
// out of the row's map.

import {
  isQuotaMap,
  type ObservedBudget,
  type ObservedPair,
  type ObservedReading,
  projectQuota,
  type QuotaObservation,
} from '@cortexkit/common-auth/quota'
import type { AccountQuotaWindow, OAuthQuotaSnapshot } from './accounts'

/** The window labels openai-auth reads, as the pool map names them. */
export const POOL_QUOTA_LABELS = ['primary', 'secondary'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function readingFor(
  label: string,
  window: unknown,
): ObservedReading | undefined {
  if (!isRecord(window)) return undefined
  const usedPercent = window.usedPercent
  if (!finite(usedPercent) || usedPercent < 0 || usedPercent > 100)
    return undefined
  return {
    label,
    usedPercent,
    ...(typeof window.resetsAt === 'string'
      ? { resetsAt: window.resetsAt }
      : {}),
    ...(finite(window.windowMinutes) && window.windowMinutes > 0
      ? { windowMinutes: window.windowMinutes }
      : {}),
  }
}

function budgetFor(
  snapshot: Record<string, unknown>,
): ObservedBudget | undefined {
  const spend = snapshot.spendControl
  if (isRecord(spend) && typeof spend.reached === 'boolean') {
    const optionalNumber = (key: string) =>
      finite(spend[key]) ? { [key]: spend[key] as number } : {}
    return {
      kind: 'reading',
      reached: spend.reached,
      ...optionalNumber('remainingPercent'),
      ...optionalNumber('usedPercent'),
      ...optionalNumber('limit'),
      ...optionalNumber('used'),
      ...optionalNumber('remaining'),
      ...(typeof spend.resetsAt === 'string'
        ? { resetsAt: spend.resetsAt }
        : {}),
      ...(typeof spend.unit === 'string' ? { unit: spend.unit } : {}),
    }
  }
  if (snapshot.spendControlCleared === true) return { kind: 'cleared' }
  return undefined
}

/**
 * One pool observation for a quota snapshot taken at `checkedAt`, or
 * undefined when the snapshot says nothing.
 *
 * `complete` is true for sources that report every live window (a WebSocket
 * rate-limit frame, a usage poll, a header set carrying the complete-frame
 * marker): a window such a source leaves out no longer exists, so the
 * observation covers it and the pool retires it. A partial header set covers
 * only what it carries and leaves the other window alone.
 */
export function observationFromSnapshot(
  snapshot: unknown,
  checkedAt: number,
  complete: boolean,
): QuotaObservation | undefined {
  if (!isRecord(snapshot) || !finite(checkedAt)) return undefined
  const readings: ObservedReading[] = []
  const coverage: ObservedPair[] = []
  for (const label of POOL_QUOTA_LABELS) {
    const reading = readingFor(label, snapshot[label])
    if (reading) readings.push(reading)
    else if (complete) coverage.push({ label })
  }
  const budget = budgetFor(snapshot)
  if (readings.length === 0 && coverage.length === 0 && !budget)
    return undefined
  return {
    checkedAt,
    ...(readings.length > 0 ? { readings } : {}),
    ...(coverage.length > 0 ? { coverage } : {}),
    ...(budget ? { budget } : {}),
  }
}

/**
 * The fixed primary and secondary windows of a row's quota map, for the
 * killswitch and its Retry-After, which judge only those two. Undefined when
 * the map holds a reading for neither, which the killswitch treats as unknown
 * quota exactly as it treats a missing snapshot.
 */
export function windowsFromQuotaMap(
  map: unknown,
): OAuthQuotaSnapshot | undefined {
  if (!isQuotaMap(map)) return undefined
  const projection = projectQuota(map)
  const out: OAuthQuotaSnapshot = {}
  for (const label of POOL_QUOTA_LABELS) {
    const limit = projection.limits.find(
      (entry) => entry.label === label && entry.kind === 'reading',
    )
    if (!limit || !finite(limit.usedPercent)) continue
    const window: AccountQuotaWindow = {
      usedPercent: limit.usedPercent,
      remainingPercent: 100 - limit.usedPercent,
      checkedAt: limit.checkedAt,
      ...(limit.resetsAt !== undefined ? { resetsAt: limit.resetsAt } : {}),
      ...(limit.windowMinutes !== undefined
        ? { windowMinutes: limit.windowMinutes }
        : {}),
    }
    out[label] = window
  }
  return out.primary || out.secondary ? out : undefined
}

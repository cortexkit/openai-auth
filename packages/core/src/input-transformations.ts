import { createLogger } from './logger'
import { isRecord } from './util/record'

const log = createLogger('transport')

function category(value: unknown): string {
  return typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 40 &&
    !/[^a-z0-9_]/.test(value)
    ? value
    : 'other'
}

/** The provider reports changes to accepted input on the response object. */
export function inputTransformationsOf(
  response: unknown,
): unknown[] | undefined {
  if (!isRecord(response)) return undefined
  const items = response.input_transformations
  return Array.isArray(items) && items.length > 0 ? items : undefined
}

/** Log category counts and known request context without conversation data. */
export function logInputTransformations(
  response: unknown,
  transport: 'http' | 'websocket',
  host: 'opencode1' | 'opencode2' | 'pi',
  context?: { warm?: boolean; chained?: boolean },
): boolean {
  const transformations = inputTransformationsOf(response)
  if (!transformations) return false

  const items: Record<string, number> = Object.create(null)
  const reasons: Record<string, number> = Object.create(null)
  for (const item of transformations) {
    const entry = isRecord(item) ? item : undefined
    const key = `${category(entry?.action)}:${category(entry?.type)}`
    const reason = category(entry?.reason)
    items[key] = (items[key] ?? 0) + 1
    reasons[reason] = (reasons[reason] ?? 0) + 1
  }
  log.info('Codex transformed input items', {
    model:
      isRecord(response) && typeof response.model === 'string'
        ? response.model
        : 'unknown',
    count: transformations.length,
    items,
    reasons,
    transport,
    host,
    warm: context?.warm,
    chained: context?.chained,
  })
  return true
}

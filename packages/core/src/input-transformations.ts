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

/** Log only the model and category counts from an already parsed completion. */
export function logInputTransformations(
  response: unknown,
  transport: 'http' | 'websocket',
  host: 'opencode1' | 'opencode2' | 'pi',
): boolean {
  if (!isRecord(response)) return false
  const transformations = response.input_transformations
  if (!Array.isArray(transformations) || transformations.length === 0)
    return false

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
    model: typeof response.model === 'string' ? response.model : 'unknown',
    count: transformations.length,
    items,
    reasons,
    transport,
    host,
  })
  return true
}

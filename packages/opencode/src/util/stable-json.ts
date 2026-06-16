import { isRecord } from './record'

export function stableStringify(value: unknown): string {
  return JSON.stringify(stable(value)) ?? 'undefined'
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stable(value[key])]),
  )
}

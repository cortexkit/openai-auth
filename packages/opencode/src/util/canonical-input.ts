import { stableStringify } from './stable-json'

// Only retain one bounded history per owner. Larger requests still compare
// exactly, but do not leave an extra serialized history resident between sends.
const MAX_CACHED_ITEMS = 512
const MAX_CACHED_CHARS = 2 * 1024 * 1024

export interface CanonicalInput {
  texts: string[]
  // Detached JSON snapshots, never host objects: an in-place edit must not
  // change the baseline against which the next request is checked.
  snapshots: unknown[]
  retainable: boolean
}

// Request bodies came from JSON.parse. Comparing their values against a
// detached snapshot avoids sorting/copying/stringifying unchanged items, but
// still checks every value (identity, length and ids alone are not sufficient).
function sameJson(snapshot: unknown, value: unknown): boolean {
  if (typeof snapshot === 'function' || typeof value === 'function')
    return false
  // A serialization hook can hide function-valued keys from its detached
  // snapshot. Keep objects and arrays with their own hook off the fast path.
  if (
    value !== null &&
    typeof value === 'object' &&
    Object.hasOwn(value, 'toJSON') &&
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
  )
    return false
  if (snapshot === value) return true
  if (Array.isArray(snapshot)) {
    return (
      Array.isArray(value) &&
      snapshot.length === value.length &&
      snapshot.every((item, index) => sameJson(item, value[index]))
    )
  }
  if (
    snapshot === null ||
    value === null ||
    typeof snapshot !== 'object' ||
    typeof value !== 'object' ||
    Array.isArray(value)
  )
    return false
  const left = snapshot as Record<string, unknown>
  const right = value as Record<string, unknown>
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.prototype.propertyIsEnumerable.call(right, key) &&
        sameJson(left[key], right[key]),
    )
  )
}

export function canonicalInput(
  input: unknown[],
  prior?: CanonicalInput,
): CanonicalInput {
  const texts: string[] = []
  const snapshots: unknown[] = []
  let chars = 0
  for (let index = 0; index < input.length; index++) {
    const oldText = prior?.texts[index]
    const unchanged =
      oldText !== undefined && sameJson(prior?.snapshots[index], input[index])
    const text = unchanged ? oldText : stableStringify(input[index])
    texts.push(text)
    snapshots.push(
      unchanged
        ? prior?.snapshots[index]
        : text === 'undefined'
          ? undefined
          : JSON.parse(text),
    )
    chars += text.length
  }
  return {
    texts,
    snapshots,
    retainable: input.length <= MAX_CACHED_ITEMS && chars <= MAX_CACHED_CHARS,
  }
}

export function retainedInput(input: CanonicalInput) {
  return input.retainable ? input : undefined
}

export function canonicalPrefixLength(
  prefix: CanonicalInput,
  input: CanonicalInput,
): number | undefined {
  if (prefix.texts.length > input.texts.length) return undefined
  for (let index = 0; index < prefix.texts.length; index++) {
    if (prefix.texts[index] !== input.texts[index]) return undefined
  }
  return prefix.texts.length
}

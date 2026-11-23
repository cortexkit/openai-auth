/** Numeric Retry-After values are seconds, including zero and fractions. */
export function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get('retry-after')
  if (value === null) return undefined
  const seconds = value.trim() ? Number(value) : NaN
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined
}

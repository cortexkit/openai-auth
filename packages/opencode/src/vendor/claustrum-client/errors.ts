export const ERROR_CLASS_WIRE_SET = [
  'transient',
  'permanent',
  'auth_required',
  'context_overflow',
] as const

export type ClaustrumCredentialErrorClass = (typeof ERROR_CLASS_WIRE_SET)[number]
export type ClaustrumCredentialErrorAction =
  | 'gone'
  | 'reauth'
  | 'retry'
  | 'reduce_and_retry'

export class ClaustrumCredentialError extends Error {
  readonly ['class']: ClaustrumCredentialErrorClass

  constructor(
    public readonly code: string,
    errorClass: ClaustrumCredentialErrorClass,
    public readonly action: ClaustrumCredentialErrorAction,
  ) {
    super(`Claustrum credential request failed: ${code}`)
    this.name = 'ClaustrumCredentialError'
    this['class'] = errorClass
  }
}

type UnknownClassLogger = (errorClass: string) => void

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function credentialErrorAction(
  errorClass: ClaustrumCredentialErrorClass,
): ClaustrumCredentialErrorAction {
  switch (errorClass) {
    case 'permanent':
      return 'gone'
    case 'auth_required':
      return 'reauth'
    case 'context_overflow':
      return 'reduce_and_retry'
    case 'transient':
      return 'retry'
  }
}

export function asCredentialError(
  response: unknown,
  fallbackCode = 'invalid_response',
  logUnknownClass: UnknownClassLogger = (errorClass) => console.warn(errorClass),
): ClaustrumCredentialError {
  const result = isRecord(response) && isRecord(response.result) ? response.result : undefined
  const error = result && isRecord(result.error) ? result.error : undefined
  const rawClass = error?.class
  const rawCode = error?.code
  // The wire contract in `crates/credentials-module/src/read_surface.rs` carries BOTH
  // `class` and `code` on every error envelope. A frame missing `code` is therefore
  // malformed: even when `class` is itself in the wire set, the half-formed envelope
  // is not a valid permanent reason — preserving `class` would let a malicious or
  // broken peer drive a `gone` action with `{ error: { class: 'permanent' } }`.
  // Anthropic's cut-line rule (unknown or absent class → transient) generalises to
  // any malformed envelope; both fields must be present and class must be known.
  const hasValidClass = typeof rawClass === 'string' && (ERROR_CLASS_WIRE_SET as readonly string[]).includes(rawClass)
  const hasCode = typeof rawCode === 'string'
  const envelopeValid = hasValidClass && hasCode
  const errorClass: ClaustrumCredentialErrorClass = envelopeValid
    ? rawClass as ClaustrumCredentialErrorClass
    : 'transient'
  if (typeof rawClass !== 'string') logUnknownClass('unknown')
  else if (!hasValidClass) logUnknownClass(rawClass)
  const code = hasCode ? rawCode : fallbackCode
  return new ClaustrumCredentialError(code, errorClass, credentialErrorAction(errorClass))
}

export function hasCredentialError(response: unknown): boolean {
  return (
    isRecord(response) &&
    isRecord(response.result) &&
    isRecord(response.result.error)
  )
}

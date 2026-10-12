import { readFileSync } from 'node:fs'
import { STATUS_CODES } from 'node:http'
import { join } from 'node:path'
import type { APICallError } from 'ai'

export type Parsed = {
  type: 'api_error' | 'context_overflow'
  message: string
  statusCode?: number
  isRetryable?: boolean
  responseHeaders?: Record<string, string>
  responseBody?: string
}
export type Normalized = { name: string; data: Parsed }
export type RetryDecision =
  | { message: string; action?: Record<string, unknown> }
  | undefined

const directory = join(import.meta.dir, 'opencode1-error-policy')
const retry = readFileSync(join(directory, 'retry.ts.txt'), 'utf8')
const provider = readFileSync(join(directory, 'provider-error.ts.txt'), 'utf8')

function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  if (from < 0 || to <= from)
    throw new Error(`Missing pinned host source section: ${start}`)
  return source.slice(from, to)
}

const overflow = readFileSync(join(directory, 'overflow.ts.txt'), 'utf8')
const functions = [
  section(overflow, 'const patterns', 'export const isContextOverflowFailure'),
  retry.match(/^export const GO_UPSELL_.*$/gm)?.join('\n'),
  section(retry, 'export const RETRY_INITIAL_DELAY', 'export function policy'),
  section(
    provider,
    'function isOpenAiErrorRetryable',
    'export type ParsedStreamError',
  ),
  section(
    provider,
    'export type ParsedAPICallError',
    'export * as ProviderError',
  ),
]
  .join('\n')
  .replace(/^export /gm, '')

// The pinned function bodies are executed directly; framework scheduling is not needed.
export function loadHostPolicy() {
  const transformed = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    functions,
  )
  const create = new Function(
    'SessionV1',
    'iife',
    'isRecord',
    'STATUS_CODES',
    `${transformed}\nreturn { delay, retryable, parseAPICallError }`,
  )
  return create(
    {
      APIError: {
        isInstance: (error: Normalized) => error.name === 'APIError',
      },
      ContextOverflowError: {
        isInstance: (error: Normalized) =>
          error.name === 'ContextOverflowError',
      },
    },
    <T>(run: () => T) => run(),
    (value: unknown) =>
      value !== null && typeof value === 'object' && !Array.isArray(value),
    STATUS_CODES,
  ) as {
    delay(attempt: number, error?: Normalized, random?: number): number
    retryable(error: Normalized, provider: string): RetryDecision
    parseAPICallError(input: {
      providerID: string
      error: APICallError
    }): Parsed
  }
}

import { appendFileSync } from 'node:fs'

/** Test-only lifecycle diagnostics, written when OPENAI_AUTH_E2E_RELOAD_TRACE is set. */
export function setupTrace(step: string, directory?: string): void {
  const file = process.env.OPENAI_AUTH_E2E_RELOAD_TRACE
  if (!file) return
  try {
    appendFileSync(
      file,
      `${JSON.stringify({ event: 'setup-step', step, directory, at: Date.now() })}\n`,
    )
  } catch {
    // A missing diagnostic destination must not change setup's behaviour.
  }
}

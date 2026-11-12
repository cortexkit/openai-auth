import { mock } from 'bun:test'
import * as os from 'node:os'

/**
 * Make `os.homedir()` read HOME (USERPROFILE on Windows) at call time, as Node
 * does. Bun reads the home folder once at startup and keeps it, so a test
 * preload that floors HOME still leaves `homedir()` on the operator's real
 * home, and every default derived from it (Pi's ~/.pi/agent, the
 * ~/.local/state fallback) writes real files. Call this from a preload, before
 * any plugin module is imported; `fallback` is used when the variable is unset.
 * The OpenCode package's tests keep the same helper in their own home-floor.ts.
 */
export function followHomeEnvironment(fallback: string): void {
  const homedir = () => {
    const value =
      process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME
    return value ? value : fallback
  }
  const patched = { ...os, homedir }
  for (const name of ['node:os', 'os']) {
    mock.module(name, () => ({ ...patched, default: patched }))
  }
}

/**
 * Test-process floor for all path environment variables.
 *
 * This preload runs ONCE before any test file in the process. It sets a
 * process-wide safe temp directory for every path env that openai-auth reads.
 * The floor guarantees that even a fire-and-forget write that outlives a
 * test's afterEach (e.g. a background timer that fires after the env is
 * restored) resolves to a temp path — never to the operator's live default
 * under /tmp/opencode-openai-auth/.
 *
 * Individual tests still override these envs in beforeEach for per-test
 * isolation; their afterEach MUST restore to the floor value (not delete).
 * See the FLOOR_* exports below.
 *
 * After seeding each floor, the preload asserts the resolved path lives
 * under FLOOR_DIR and never under the operator's live defaults. A silent
 * pass here would let a future edit reintroduce the leak; the preload
 * throws instead so the harness fails to start, not the test.
 */

import { afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'

// Captured before HOME is floored below, so the live-default checks compare
// against the operator's real home rather than the floor.
const REAL_HOME = homedir()

// One unique temp dir per test process — survives the full suite run.
const FLOOR_DIR = mkdtempSync(join(tmpdir(), 'openai-auth-test-floor-'))

export const FLOOR_SIDEBAR_STATE_FILE = join(FLOOR_DIR, 'sidebar-state.json')
export const FLOOR_AUTH_FILE = join(FLOOR_DIR, 'openai-auth.json')
export const FLOOR_STATE_FILE = join(FLOOR_DIR, 'openai-auth-state.json')
export const FLOOR_LOG_FILE = join(FLOOR_DIR, 'openai-auth.log')
export const FLOOR_MODELS_CACHE = join(FLOOR_DIR, 'models.json')
// Custody manifest floor: resolved under FLOOR_DIR so even an in-flight read
// that outlives a test's afterEach (background timers, deferred cache lookups)
// points at a temp path, never at the operator's live default.
// The lock sidecar is exported because the manifest writer owns it, but tests
// only need the floor path to restore the env var cleanly.
export const FLOOR_CLAUSTRUM_HANDLES = join(FLOOR_DIR, 'opencode-handles.json')
export const FLOOR_CLAUSTRUM_HANDLES_LOCK = `${FLOOR_CLAUSTRUM_HANDLES}.lock`

// Set the floor values only if the env is not already set (a parent process
// or CI may have pre-configured them intentionally).
if (!process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE) {
  process.env.OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE = FLOOR_SIDEBAR_STATE_FILE
}
if (!process.env.OPENCODE_OPENAI_AUTH_FILE) {
  process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
}
if (!process.env.OPENCODE_OPENAI_AUTH_STATE_FILE) {
  process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
}
if (!process.env.OPENCODE_OPENAI_AUTH_LOG_FILE) {
  process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = FLOOR_LOG_FILE
}
if (!process.env.OPENCODE_OPENAI_AUTH_MODELS_CACHE) {
  process.env.OPENCODE_OPENAI_AUTH_MODELS_CACHE = FLOOR_MODELS_CACHE
}
if (!process.env.CLAUSTRUM_OPENCODE_HANDLES) {
  process.env.CLAUSTRUM_OPENCODE_HANDLES = FLOOR_CLAUSTRUM_HANDLES
}

// Directory roots. The leaf files above are not enough on their own: a test
// that removes a leaf (or never set one) falls back to a default derived from
// these roots, and on a developer machine those point at live data. The
// sessions file (openai-auth-sessions.json) is resolved from
// OPENCODE_CONFIG_DIR, then XDG_CONFIG_HOME, and the Claustrum connection file
// from XDG_RUNTIME_DIR, then HOME. So the roots are floored unconditionally,
// even when the shell already sets them: an inherited XDG_CONFIG_HOME is
// exactly the live directory this preload exists to keep tests out of.
//
// Bun's os.homedir() caches the home directory at startup and ignores a later
// HOME change, so flooring HOME only redirects code that reads process.env.HOME
// directly (the Claustrum client does). Plugin code resolves through the XDG
// and OPENCODE_* variables, which are read at call time.
export const FLOOR_ROOTS = {
  HOME: join(FLOOR_DIR, 'home'),
  XDG_CONFIG_HOME: join(FLOOR_DIR, 'xdg', 'config'),
  XDG_DATA_HOME: join(FLOOR_DIR, 'xdg', 'data'),
  XDG_STATE_HOME: join(FLOOR_DIR, 'xdg', 'state'),
  XDG_CACHE_HOME: join(FLOOR_DIR, 'xdg', 'cache'),
  XDG_RUNTIME_DIR: join(FLOOR_DIR, 'xdg', 'runtime'),
  OPENCODE_CONFIG_DIR: join(FLOOR_DIR, 'xdg', 'config', 'opencode'),
} as const
for (const [name, path] of Object.entries(FLOOR_ROOTS)) {
  mkdirSync(path, { recursive: true })
  process.env[name] = path
}

/**
 * Every environment variable the preload floors, with its floor value.
 * Captured after seeding, so an operator's pre-set leaf value is what gets
 * restored for that leaf.
 */
export const FLOOR_ENV: Readonly<Record<string, string>> = Object.freeze({
  OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE: envValue(
    'OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE',
  ),
  OPENCODE_OPENAI_AUTH_FILE: envValue('OPENCODE_OPENAI_AUTH_FILE'),
  OPENCODE_OPENAI_AUTH_STATE_FILE: envValue('OPENCODE_OPENAI_AUTH_STATE_FILE'),
  OPENCODE_OPENAI_AUTH_LOG_FILE: envValue('OPENCODE_OPENAI_AUTH_LOG_FILE'),
  OPENCODE_OPENAI_AUTH_MODELS_CACHE: envValue(
    'OPENCODE_OPENAI_AUTH_MODELS_CACHE',
  ),
  CLAUSTRUM_OPENCODE_HANDLES: envValue('CLAUSTRUM_OPENCODE_HANDLES'),
  ...FLOOR_ROOTS,
})

function envValue(name: string): string {
  const value = process.env[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`setup-env preload: ${name} is not set after seeding`)
  }
  return value
}

/**
 * Restore an environment variable a test changed. Use this in cleanup instead
 * of `delete process.env.X`: deleting a floored variable does not return it to
 * "unset", it returns it to the operator's live default, and background work
 * from an earlier loader then reads or writes live files. A test that needs a
 * variable genuinely unset can still delete it inside its own body; the
 * cleanup puts the floor back.
 */
export function restoreEnv(name: string, previous?: string): void {
  if (previous !== undefined) {
    process.env[name] = previous
  } else if (name in FLOOR_ENV) {
    process.env[name] = FLOOR_ENV[name]
  } else {
    delete process.env[name]
  }
}

/**
 * Unset a floored variable inside a test body, to exercise the code path that
 * runs when it is absent. The test's cleanup (or the backstop below) restores
 * the floor. Named separately from a bare `delete` so the floor-env guard test
 * can refuse the bare form everywhere without refusing this deliberate one.
 */
export function unsetEnv(name: string): void {
  delete process.env[name]
}

// Backstop for a cleanup that slips through with `delete` anyway (the
// floor-env guard test forbids the literal form, but not a computed key):
// after every test, put back any floored variable that is now missing.
afterEach(() => {
  for (const [name, value] of Object.entries(FLOOR_ENV)) {
    if (!process.env[name]) process.env[name] = value
  }
})

// Tests never need the network. A request that escapes its stub (typically
// background work from a loader that outlives the test that restored
// globalThis.fetch) would otherwise reach chatgpt.com with a fixture bearer,
// and a 401 there triggers a forced refresh against auth.openai.com. Loopback
// stays open for the RPC server tests. Tests that save and restore
// globalThis.fetch capture this guard, so restoring puts it back.
const realFetch = globalThis.fetch
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
export const NETWORK_GUARD_MESSAGE = 'network access is disabled in tests'
const guardedFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  )
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    return Promise.reject(
      new TypeError(`${NETWORK_GUARD_MESSAGE}: ${url.host}`),
    )
  }
  return realFetch(input, init)
}) as typeof fetch
globalThis.fetch = Object.assign(guardedFetch, realFetch)

// Preload assertions: every floor-resolved path must live under FLOOR_DIR
// AND must not be under the operator's live defaults. Resolved at preload
// time so a misconfigured env (a stale parent process, a stray export) is
// caught before any test can write to the operator's real config dir.
const HOME_CONFIG = join(REAL_HOME, '.config')
const HOME_LOCAL_SHARE = join(REAL_HOME, '.local', 'share')

function isUnder(child: string, parent: string): boolean {
  const c = resolve(child) + sep
  const p = resolve(parent) + sep
  return c.startsWith(p)
}

// Exported for tests so they can drive the assertion with a synthetic
// `~/.config`-shaped path and prove the preload guard refuses it. The
// preload itself cannot be re-driven after import (modules cache), so the
// guard logic lives in a small pure helper that the test imports directly.
export function assertFloor(
  label: string,
  path: string,
  lockPath?: string,
  opts: {
    homeConfig?: string
    homeLocalShare?: string
    floorDir?: string
  } = {},
): void {
  const floorDir = opts.floorDir ?? FLOOR_DIR
  const homeConfig = opts.homeConfig ?? HOME_CONFIG
  const homeLocalShare = opts.homeLocalShare ?? HOME_LOCAL_SHARE
  if (!isAbsolute(path)) {
    throw new Error(`setup-env preload: ${label} is not absolute: ${path}`)
  }
  if (!isUnder(path, floorDir)) {
    throw new Error(
      `setup-env preload: ${label} resolved outside FLOOR_DIR. ` +
        `expected under ${floorDir}, got ${path}`,
    )
  }
  if (isUnder(path, homeConfig) || isUnder(path, homeLocalShare)) {
    throw new Error(
      `setup-env preload: ${label} resolves under the operator's live default ` +
        `(${homeConfig} or ${homeLocalShare}). got ${path}`,
    )
  }
  if (lockPath) {
    if (!isAbsolute(lockPath)) {
      throw new Error(
        `setup-env preload: ${label} lock is not absolute: ${lockPath}`,
      )
    }
    if (!isUnder(lockPath, floorDir)) {
      throw new Error(
        `setup-env preload: ${label} lock resolved outside FLOOR_DIR. ` +
          `expected under ${floorDir}, got ${lockPath}`,
      )
    }
    if (isUnder(lockPath, homeConfig) || isUnder(lockPath, homeLocalShare)) {
      throw new Error(
        `setup-env preload: ${label} lock resolves under the operator's live default. got ${lockPath}`,
      )
    }
  }
}

function envPath(name: string): string {
  const value = process.env[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`setup-env preload: ${name} is not set after seeding`)
  }
  return value
}

assertFloor(
  'OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE',
  envPath('OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE'),
)
assertFloor('OPENCODE_OPENAI_AUTH_FILE', envPath('OPENCODE_OPENAI_AUTH_FILE'))
assertFloor(
  'OPENCODE_OPENAI_AUTH_STATE_FILE',
  envPath('OPENCODE_OPENAI_AUTH_STATE_FILE'),
)
assertFloor(
  'OPENCODE_OPENAI_AUTH_LOG_FILE',
  envPath('OPENCODE_OPENAI_AUTH_LOG_FILE'),
)
assertFloor(
  'OPENCODE_OPENAI_AUTH_MODELS_CACHE',
  envPath('OPENCODE_OPENAI_AUTH_MODELS_CACHE'),
)
assertFloor(
  'CLAUSTRUM_OPENCODE_HANDLES',
  envPath('CLAUSTRUM_OPENCODE_HANDLES'),
  FLOOR_CLAUSTRUM_HANDLES_LOCK,
)
for (const name of Object.keys(FLOOR_ROOTS)) {
  assertFloor(name, envPath(name))
}

// Belt-and-suspenders: remove the floor temp dir when the test process exits
// so each run doesn't leak a directory under /tmp.
process.on('exit', () => {
  try {
    rmSync(FLOOR_DIR, { recursive: true, force: true })
  } catch {}
})

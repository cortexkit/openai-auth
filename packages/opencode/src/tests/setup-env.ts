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

import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'

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

// Preload assertions: every floor-resolved path must live under FLOOR_DIR
// AND must not be under the operator's live defaults. Resolved at preload
// time so a misconfigured env (a stale parent process, a stray export) is
// caught before any test can write to the operator's real config dir.
const HOME = homedir()
const HOME_CONFIG = join(HOME, '.config')
const HOME_LOCAL_SHARE = join(HOME, '.local', 'share')

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

// Belt-and-suspenders: remove the floor temp dir when the test process exits
// so each run doesn't leak a directory under /tmp.
process.on('exit', () => {
  try {
    rmSync(FLOOR_DIR, { recursive: true, force: true })
  } catch {}
})

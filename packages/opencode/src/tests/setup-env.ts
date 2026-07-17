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
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// One unique temp dir per test process — survives the full suite run.
const FLOOR_DIR = mkdtempSync(join(tmpdir(), 'openai-auth-test-floor-'))

export const FLOOR_SIDEBAR_STATE_FILE = join(FLOOR_DIR, 'sidebar-state.json')
export const FLOOR_AUTH_FILE = join(FLOOR_DIR, 'openai-auth.json')
export const FLOOR_STATE_FILE = join(FLOOR_DIR, 'openai-auth-state.json')
export const FLOOR_LOG_FILE = join(FLOOR_DIR, 'openai-auth.log')
export const FLOOR_MODELS_CACHE = join(FLOOR_DIR, 'models.json')

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

// Belt-and-suspenders: remove the floor temp dir when the test process exits
// so each run doesn't leak a directory under /tmp.
process.on('exit', () => {
  try {
    rmSync(FLOOR_DIR, { recursive: true, force: true })
  } catch {}
})

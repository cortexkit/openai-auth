import { mkdirSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { followHomeEnvironment } from './home-floor'

// Captured before HOME is floored below.
const REAL_HOME = homedir()
followHomeEnvironment(REAL_HOME)

// Pi resolves its auth.json and the extension store through PI_CODING_AGENT_DIR.
// Each test file still gets its own folder per test from `isolatePiAgentDir()`;
// this process-wide default covers
// any file or background work outside that.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(
  join(tmpdir(), 'pi-test-agent-process-'),
)

// Pi's settings startup also reads OpenCode's default store and writes Pi
// process records under the state folder. Those paths come from these roots
// and from the home folder, so all of them are floored, even when the shell
// already sets them: an inherited value is exactly the operator's live folder.
const FLOOR_DIR = mkdtempSync(join(tmpdir(), 'pi-test-floor-'))
export const FLOOR_ROOTS = {
  HOME: join(FLOOR_DIR, 'home'),
  XDG_CONFIG_HOME: join(FLOOR_DIR, 'xdg', 'config'),
  XDG_DATA_HOME: join(FLOOR_DIR, 'xdg', 'data'),
  XDG_STATE_HOME: join(FLOOR_DIR, 'xdg', 'state'),
  XDG_CACHE_HOME: join(FLOOR_DIR, 'xdg', 'cache'),
  OPENCODE_CONFIG_DIR: join(FLOOR_DIR, 'xdg', 'config', 'opencode'),
} as const
export { FLOOR_DIR, REAL_HOME }

for (const [name, path] of Object.entries(FLOOR_ROOTS)) {
  mkdirSync(path, { recursive: true })
  process.env[name] = path
}

// A host that Thalamus starts sets CORTEXKIT_VAULT_HOST=thalamus, and a test
// process started inside one inherits it, which would run every vault test in
// hosted mode. Clear it here; tests that exercise hosted mode set it themselves.
// Children spawned without an `env` option still get the original value, so
// those that reach vault code pass `env` built from process.env.
delete process.env.CORTEXKIT_VAULT_HOST

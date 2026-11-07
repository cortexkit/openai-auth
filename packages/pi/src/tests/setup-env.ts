import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Pi resolves its auth.json and the extension store through PI_CODING_AGENT_DIR.
// Each test file still gets its own folder per test from `isolatePiAgentDir()`;
// this process-wide default covers
// any file or background work outside that.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(
  join(tmpdir(), 'pi-test-agent-process-'),
)

// A host that Thalamus starts sets CORTEXKIT_VAULT_HOST=thalamus, and a test
// process started inside one inherits it, which would run every vault test in
// hosted mode. Clear it here; tests that exercise hosted mode set it themselves.
// Children spawned without an `env` option still get the original value, so
// those that reach vault code pass `env` built from process.env.
delete process.env.CORTEXKIT_VAULT_HOST

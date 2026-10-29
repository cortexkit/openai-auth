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

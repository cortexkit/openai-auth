import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Pi 1.0.x resolves its auth.json through PI_CODING_AGENT_DIR (PI_AGENT_DIR
// steers only this extension's own store). Each test file still gets its own
// folder per test from `isolatePiAgentDir()`; this process-wide default covers
// any file or background work outside that.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(
  join(tmpdir(), 'pi-test-agent-process-'),
)

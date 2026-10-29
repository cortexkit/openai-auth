import { afterEach, beforeEach, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'

// Register in each test file so direct, filtered and subprocess test runs all
// isolate both native Pi auth and the extension store through Pi's own
// PI_CODING_AGENT_DIR setting.
export function isolatePiAgentDir(): () => string {
  let dir: string
  let previous: string | undefined
  beforeEach(() => {
    previous = process.env.PI_CODING_AGENT_DIR
    dir = mkdtempSync(join(tmpdir(), 'pi-test-agent-'))
    process.env.PI_CODING_AGENT_DIR = dir
    expect(resolve(getAgentDir())).toBe(resolve(dir))
    expect(resolve(getAgentDir())).not.toBe(resolve(homedir(), '.pi', 'agent'))
  })
  afterEach(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return () => dir
}

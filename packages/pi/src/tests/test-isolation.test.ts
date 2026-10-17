import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { getAgentDir, ModelRuntime } from '@earendil-works/pi-coding-agent'
import { isolatePiAgentDir } from './test-isolation.ts'

const testAgentDir = isolatePiAgentDir()

test('native Pi auth resolves inside the current test temp directory, never the real home', async () => {
  expect(resolve(getAgentDir())).toBe(resolve(testAgentDir()))
  expect(resolve(getAgentDir())).not.toBe(resolve(homedir(), '.pi', 'agent'))
  const runtime = await ModelRuntime.create({ refreshOnCreate: false })
  expect(await runtime.listCredentials()).toEqual([])
  expect(existsSync(join(testAgentDir(), 'auth.json'))).toBe(true)
})

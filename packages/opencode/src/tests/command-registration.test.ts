import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config, PluginInput } from '@opencode-ai/plugin'
import { MODAL_COMMANDS } from '../commands.ts'
import { CodexAuthPlugin } from '../index.ts'
import { FLOOR_AUTH_FILE, FLOOR_STATE_FILE } from './setup-env.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockPluginInput(
  overrides: Partial<PluginInput> = {},
): PluginInput {
  return {
    client: {
      auth: {
        set: async () => {},
      },
      session: {
        promptAsync: async () => {},
      },
    } as unknown as PluginInput['client'],
    project: { id: 'test', name: 'test' } as unknown as PluginInput['project'],
    directory: '',
    worktree: '/tmp/test-worktree',
    experimental_workspace: { register: () => {} },
    serverUrl: new URL('http://localhost:0'),
    $: {} as PluginInput['$'],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Guard: config hook command registration must stay in sync with MODAL_COMMANDS
//
// A command in MODAL_COMMANDS but absent from config.command is unreachable in
// the palette — the user can never invoke it. A command in config.command but
// absent from MODAL_COMMANDS is registered but command.execute.before won't
// intercept it, so it falls through to text. Both drift directions are caught.
// ---------------------------------------------------------------------------

describe('command-registration: config hook stays in sync with MODAL_COMMANDS', () => {
  let tmpDir: string
  let configFile: string
  let stateFile: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'openai-auth-cmdreg-'))
    configFile = join(tmpDir, 'openai-auth.json')
    stateFile = join(tmpDir, 'openai-auth-state.json')
    process.env.OPENCODE_OPENAI_AUTH_FILE = configFile
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = stateFile
  })

  afterEach(() => {
    // Restore to the floor (not delete) so any in-flight write resolves to a
    // temp path rather than the operator's live default.
    process.env.OPENCODE_OPENAI_AUTH_FILE = FLOOR_AUTH_FILE
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = FLOOR_STATE_FILE
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* */
    }
  })

  it('registered openai-* command keys exactly equal MODAL_COMMANDS (bidirectional)', async () => {
    const hooks = await CodexAuthPlugin(createMockPluginInput(), {
      experimentalWebSockets: false,
    })

    // Seed with a non-openai command to verify the hook merges, not clobbers.
    const config: Config = {
      command: {
        'some-other': { template: 'some-other', description: 'pre-existing' },
      },
    }
    await hooks.config?.(config)

    // The pre-existing non-openai command must survive (additive merge, not clobber).
    expect(config.command?.['some-other']).toBeDefined()

    // Extract the openai-* keys registered by the hook.
    const registeredOpenaiKeys = Object.keys(config.command ?? {}).filter((k) =>
      k.startsWith('openai-'),
    )

    // Derive the expected set from MODAL_COMMANDS — no hardcoded list.
    const expectedKeys = [...MODAL_COMMANDS].sort()
    const actualKeys = [...registeredOpenaiKeys].sort()

    // Direction 1: every MODAL_COMMANDS entry must be registered in config.command.
    // A missing entry means the command is wired for execution but unreachable in the palette.
    expect(actualKeys).toEqual(expectedKeys)

    // Direction 2: every registered openai-* key must be in MODAL_COMMANDS.
    // An extra entry means it's in the palette but command.execute.before won't intercept it.
    for (const key of registeredOpenaiKeys) {
      expect(MODAL_COMMANDS as string[]).toContain(key)
    }
  })
})

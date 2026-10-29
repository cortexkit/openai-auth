import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  enrollmentAuthority,
  hostEnrollmentPaths,
} from '@cortexkit/common-auth/claustrum'
import {
  deriveStatePath,
  vaultEnrollmentName,
  vaultPaths,
  vaultStateDir,
} from '@cortexkit/openai-auth-core/internal'
import { getPiAccountPaths, getPiAccountStoragePath } from '../paths'

const envNames = [
  'HOME',
  'USERPROFILE',
  'PI_AGENT_DIR',
  'PI_CODING_AGENT_DIR',
  'PI_OPENAI_AUTH_FILE',
  'PI_OPENAI_AUTH_STATE_FILE',
] as const
let saved: Record<string, string | undefined>
let root: string
let legacy: string
let current: string
let warnings: ReturnType<typeof spyOn<typeof console, 'warn'>>

beforeEach(() => {
  saved = Object.fromEntries(envNames.map((name) => [name, process.env[name]]))
  root =
    process.env.PI_PATHS_TEST_HOME ?? mkdtempSync(join(tmpdir(), 'pi-paths-'))
  process.env.HOME = root
  process.env.USERPROFILE = root
  for (const name of envNames.slice(2)) delete process.env[name]
  process.env.PI_CODING_AGENT_DIR = join(root, 'configured-agent')
  legacy = join(homedir(), '.pi', 'agent', 'openai-auth.json')
  current = join(root, 'configured-agent', 'openai-auth.json')
  warnings = spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warnings.mockRestore()
  for (const name of envNames) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
  rmSync(root, { recursive: true, force: true })
})

function seed(path: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'unchanged credentials', { mode: 0o600 })
}

function isolatedTest(name: string, run: () => unknown | Promise<unknown>) {
  test(name, async () => {
    if (process.env.PI_PATHS_TEST_HOME) return await run()
    // Native home-directory readers need HOME set before the process starts.
    const filter = `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`
    const child = Bun.spawn(
      [process.execPath, 'test', import.meta.path, '-t', filter],
      {
        env: { ...process.env, PI_PATHS_TEST_HOME: root },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    expect(`${stdout}\n${stderr}`).toContain(`(pass) ${name}`)
  })
}

isolatedTest(
  'Pi store follows tilde-expanded PI_CODING_AGENT_DIR, not PI_AGENT_DIR',
  async () => {
    // Set HOME before Pi loads, just as a real host process does.
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `import { getPiAccountPaths } from ${JSON.stringify(join(import.meta.dir, '..', 'paths.ts'))}; console.log(JSON.stringify(getPiAccountPaths()))`,
      ],
      {
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: '~/custom-agent',
          PI_AGENT_DIR: join(root, 'ignored'),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(stderr).toBe('')
    expect(code).toBe(0)
    expect(JSON.parse(stdout)).toEqual({
      configPath: join(root, 'custom-agent', 'openai-auth.json'),
      statePath: join(root, 'custom-agent', 'openai-auth-state.json'),
    })
  },
)

for (const setting of ['unset', 'absolute', '~', '~/x', 'relative'] as const) {
  isolatedTest(
    `setup Pi directory matches real Pi getAgentDir for ${setting}`,
    async () => {
      const env = { ...process.env }
      if (setting === 'unset') delete env.PI_CODING_AGENT_DIR
      else
        env.PI_CODING_AGENT_DIR =
          setting === 'absolute' ? join(root, 'absolute') : setting
      const expected =
        setting === 'unset'
          ? join(root, '.pi', 'agent')
          : setting === '~'
            ? root
            : setting === '~/x'
              ? join(root, 'x')
              : setting === 'absolute'
                ? join(root, 'absolute')
                : setting
      const child = Bun.spawn(
        [
          process.execPath,
          '-e',
          `import { getAgentDir } from '@earendil-works/pi-coding-agent'; import { resolvePiAgentDir } from ${JSON.stringify(join(import.meta.dir, '..', 'store-paths.ts'))}; console.log(JSON.stringify({pi: getAgentDir(), setup: resolvePiAgentDir()}))`,
        ],
        { env, stdout: 'pipe', stderr: 'pipe' },
      )
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(stderr).toBe('')
      expect(code).toBe(0)
      expect(JSON.parse(stdout)).toEqual({ pi: expected, setup: expected })
    },
  )
}

isolatedTest(
  'Pi store defaults to the home agent directory without a directory setting',
  () => {
    delete process.env.PI_CODING_AGENT_DIR
    expect(getPiAccountStoragePath()).toBe(legacy)
  },
)

for (const component of ['config', 'state'] as const) {
  isolatedTest(
    `Pi keeps a legacy-only ${component} store in place and logs once`,
    () => {
      const path = component === 'config' ? legacy : deriveStatePath(legacy)
      seed(path)
      for (let i = 0; i < 3; i++) {
        expect(getPiAccountPaths()).toEqual({
          configPath: legacy,
          statePath: deriveStatePath(legacy),
        })
      }
      expect(warnings).toHaveBeenCalledTimes(1)
      const log = warnings.mock.calls.flat().join(' ')
      expect(log).toContain('store in the legacy Pi agent directory')
      expect(log).toContain(legacy)
      expect(readFileSync(path, 'utf8')).toBe('unchanged credentials')
      expect(existsSync(current)).toBe(false)
      expect(existsSync(deriveStatePath(current))).toBe(false)
    },
  )

  isolatedTest(
    `Pi prefers an existing configured ${component} store over the legacy store`,
    () => {
      seed(legacy)
      const path = component === 'config' ? current : deriveStatePath(current)
      seed(path)
      expect(getPiAccountStoragePath()).toBe(current)
      expect(warnings).not.toHaveBeenCalled()
      expect(readFileSync(legacy, 'utf8')).toBe('unchanged credentials')
      expect(readFileSync(path, 'utf8')).toBe('unchanged credentials')
    },
  )
}

isolatedTest(
  'a legacy vault-only install stays in vault mode under a different Pi directory',
  async () => {
    const dir = vaultStateDir(deriveStatePath(legacy))
    const vault = vaultPaths(dir, 'pi')
    const name = vaultEnrollmentName('pi')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(
      vault.tokenPath,
      JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
      { mode: 0o600 },
    )
    writeFileSync(
      vault.statePath,
      JSON.stringify({
        version: 1,
        phase: 'approved',
        proposedName: name,
        approvedName: name,
        tokenGeneration: 1,
        updatedAt: 1,
      }),
      { mode: 0o600 },
    )
    const selected = getPiAccountPaths()
    expect(selected.configPath).toBe(legacy)
    expect(
      await enrollmentAuthority(
        hostEnrollmentPaths({
          stateDir: vaultStateDir(selected.statePath),
          host: 'pi',
        }),
        name,
      ),
    ).toBe('vault')
    expect(warnings).toHaveBeenCalledTimes(1)
    expect(existsSync(current)).toBe(false)
    expect(existsSync(deriveStatePath(current))).toBe(false)
    expect(existsSync(legacy)).toBe(false)
    expect(existsSync(deriveStatePath(legacy))).toBe(false)
  },
)

for (const record of ['tokenPath', 'statePath'] as const) {
  isolatedTest(
    `a legacy ${record} alone preserves the enrollment location`,
    () => {
      const vault = vaultPaths(vaultStateDir(deriveStatePath(legacy)), 'pi')
      seed(vault[record])
      expect(getPiAccountStoragePath()).toBe(legacy)
      expect(readFileSync(vault[record], 'utf8')).toBe('unchanged credentials')
      expect(warnings).toHaveBeenCalledTimes(1)
    },
  )
  isolatedTest(
    `a configured ${record} takes precedence over a legacy local store`,
    () => {
      seed(legacy)
      const vault = vaultPaths(vaultStateDir(deriveStatePath(current)), 'pi')
      seed(vault[record])
      expect(getPiAccountStoragePath()).toBe(current)
      expect(warnings).not.toHaveBeenCalled()
    },
  )
}

isolatedTest(
  'a lone legacy roster does not select an unenrolled vault location',
  () => {
    seed(vaultPaths(vaultStateDir(deriveStatePath(legacy)), 'pi').rosterPath)
    expect(getPiAccountStoragePath()).toBe(current)
    expect(warnings).not.toHaveBeenCalled()
  },
)

isolatedTest(
  'Pi explicit file overrides bypass directory discovery and legacy fallback',
  () => {
    seed(legacy)
    process.env.PI_OPENAI_AUTH_FILE = join(root, 'explicit.json')
    process.env.PI_OPENAI_AUTH_STATE_FILE = join(root, 'explicit-state.json')
    expect(getPiAccountPaths()).toEqual({
      configPath: process.env.PI_OPENAI_AUTH_FILE,
      statePath: process.env.PI_OPENAI_AUTH_STATE_FILE,
    })
    expect(warnings).not.toHaveBeenCalled()
    expect(existsSync(process.env.PI_OPENAI_AUTH_FILE)).toBe(false)
  },
)

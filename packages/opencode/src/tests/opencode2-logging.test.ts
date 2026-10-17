import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { poolFiles, seedPool } from './fixtures/opencode2-host'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

// Kept explicit so the expected threshold is independent of the logger engine.
const levels = ['error', 'warn', 'info', 'debug', 'trace'] as const
type Level = (typeof levels)[number]
const emitted: Record<Level, string[]> = {
  error: ['error'],
  warn: ['error', 'warn'],
  info: ['error', 'warn', 'info'],
  debug: ['error', 'warn', 'info', 'debug'],
  trace: ['error', 'warn', 'info', 'debug', 'trace'],
}

function fixture(stored?: Level) {
  const files = poolFiles()
  roots.push(files.dir)
  seedPool(files, 'main-first', [])
  if (stored) {
    const storage = JSON.parse(readFileSync(files.configPath, 'utf8'))
    storage.logging = { level: stored }
    writeFileSync(files.configPath, JSON.stringify(storage))
  }
  return files
}

function start(
  version: '1' | '2',
  files: ReturnType<typeof poolFiles>,
  envLevel?: Level,
  next?: Level,
) {
  const root = files.dir
  const env = { ...process.env }
  const logFile = join(root, `log-${version}-${next ?? 'startup'}.log`)
  for (const key of [
    'HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_CACHE_HOME',
    'XDG_RUNTIME_DIR',
    'OPENCODE_CONFIG_DIR',
  ]) {
    env[key] = join(root, key)
    mkdirSync(env[key], { recursive: true })
  }
  Object.assign(env, {
    NODE_ENV: 'test',
    OPENCODE_OPENAI_AUTH_FILE: files.configPath,
    OPENCODE_OPENAI_AUTH_STATE_FILE: files.statePath,
    OPENCODE_OPENAI_AUTH_LOG_FILE: logFile,
    OPENCODE_OPENAI_AUTH_MODELS_CACHE: join(root, 'models.json'),
    OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE: join(root, 'sidebar.json'),
    CLAUSTRUM_SUBC_CONNECTION: join(root, 'no-vault.json'),
  })
  if (envLevel) env.OPENCODE_OPENAI_AUTH_LOG_LEVEL = envLevel
  else delete env.OPENCODE_OPENAI_AUTH_LOG_LEVEL
  rmSync(logFile, { force: true })
  const result = Bun.spawnSync(
    [
      process.execPath,
      fileURLToPath(
        new URL('./fixtures/opencode2-logging.ts', import.meta.url),
      ),
      version,
      root,
      ...(next ? [next] : []),
    ],
    { env, stdout: 'pipe', stderr: 'pipe' },
  )
  expect({
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
  }).toEqual({ exitCode: 0, stderr: '' })
  return JSON.parse(result.stdout.toString())
}

for (const envLevel of [undefined, 'error'] as const) {
  for (const level of levels) {
    test(`OpenCode 2 logging ${level} persists, applies and restarts with ${envLevel ?? 'unset'} env`, () => {
      const files = fixture()
      const first = start('2', files, envLevel, level)
      expect(first.applied.emitted).toEqual(emitted[level])
      expect(
        JSON.parse(readFileSync(files.configPath, 'utf8')).logging.level,
      ).toBe(level)
      const restarted = start('2', files, envLevel)
      expect(restarted.startup.emitted).toEqual(emitted[level])
      expect(restarted.startup.section.lines).toContain(`Log level: ${level}`)
      expect(
        restarted.startup.section.actions.find(
          (a: { id: string }) => a.id === 'logging',
        ).knobs[0].value,
      ).toBe(level)
    })
  }
}

for (const row of [
  { name: 'stored with unset env', stored: 'debug' },
  { name: 'stored over conflicting env', env: 'trace', stored: 'warn' },
  { name: 'menu with unset env', stored: 'error', next: 'trace' },
  {
    name: 'menu over conflicting env',
    env: 'debug',
    stored: 'trace',
    next: 'error',
  },
] as const) {
  test(`OpenCode 2 log precedence matches OpenCode 1: ${row.name}`, () => {
    const env = 'env' in row ? row.env : undefined
    const next = 'next' in row ? row.next : undefined
    const oneFiles = fixture(row.stored)
    const twoFiles = fixture(row.stored)
    const one = start('1', oneFiles, env, next)
    const two = start('2', twoFiles, env, next)
    expect(two.startup.emitted).toEqual(emitted[row.stored])
    expect(two.startup).toEqual(one.startup)
    if (next) {
      expect(two.applied.emitted).toEqual(emitted[next])
      expect(two.applied).toEqual(one.applied)
      const oneRestart = start('1', oneFiles, env)
      const twoRestart = start('2', twoFiles, env)
      expect(twoRestart.startup.emitted).toEqual(emitted[next])
      expect(twoRestart.startup).toEqual(oneRestart.startup)
    }
  })
}

test('OpenCode 2 log strings retain OpenCode 1 credential and identity redaction', () => {
  const one = start('1', fixture('trace'))
  const two = start('2', fixture('trace'))
  for (const result of [one, two]) {
    expect(result.redacted).toContain('redaction-probe')
    expect(result.redacted).toContain('REDACTED')
    expect(result.redacted).toContain('"accountId":"main"')
    for (const secret of [
      'fixture-bearer-secret',
      'fixture-header-secret',
      'fixture-cookie-secret',
      'fixture-access-secret',
      'fixture-refresh-secret',
      'fixture-person@example.test',
      'fixture-chatgpt-secret',
      'fixture-organization-secret',
    ])
      expect(result.redacted).not.toContain(secret)
  }
  // Timestamps differ across host processes; the redacted message and fields do not.
  expect(two.redacted.slice(two.redacted.indexOf('redaction-probe'))).toBe(
    one.redacted.slice(one.redacted.indexOf('redaction-probe')),
  )
})

// Shared scaffolding for the account-pool migration tests: a legacy
// openai-auth install on disk, a file-backed stand-in for OpenCode's login
// slot (so several processes can share it), and the checks a crash row runs.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import {
  appendFile,
  copyFile,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { quotaCodec } from '@cortexkit/common-auth/quota'
import { openPoolStore, type PoolRow } from '@cortexkit/common-auth/store'
import {
  type AccountPaths,
  FallbackAccountManager,
  hashRefreshToken,
} from '@cortexkit/openai-auth-core/internal'
import {
  type HostSlotAdapter,
  isPoolPlaceholder,
  POOL_PLACEHOLDER_REFRESH,
  type PoolMigrationDeps,
  type PoolMigrationFenceDeps,
} from '../../core/pool-migration.ts'
import { legacyRefreshMain } from './legacy-main-refresh.ts'

/** A version fence with no older process running. */
export const OPEN_FENCE = async () => ({ open: true as const })

// Parsed files are inspected field by field.
// biome-ignore lint/suspicious/noExplicitAny: arbitrary parsed JSON
export type Json = Record<string, any>

export const FAR = 4_000_000_000_000
export const T0 = 1_900_000_000_000

/** An access token whose claims carry a ChatGPT account id. */
export function jwt(accountId: string, salt = ''): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    salt,
  })}.sig`
}

export function login(accountId: string, refresh: string, salt = '') {
  return {
    type: 'oauth' as const,
    access: jwt(accountId, salt),
    refresh,
    expires: FAR,
  }
}

export interface Harness {
  dir: string
  paths: AccountPaths
  authPath: string
  slot: HostSlotAdapter
  config(): Promise<Json>
  state(): Promise<Json>
  slotValue(): Promise<Json | undefined>
  setSlot(value: unknown): Promise<void>
  /** How many times anything wrote the placeholder through `slot.set`. */
  placeholderWrites(): Promise<number>
  bytes(): Promise<Record<string, string | null>>
  rows(): Promise<PoolRow[]>
  row(id: string): Promise<PoolRow | undefined>
  deps(
    extra?: Partial<PoolMigrationDeps & PoolMigrationFenceDeps>,
  ): PoolMigrationDeps & PoolMigrationFenceDeps
  cleanup(): void
}

async function readJson(path: string): Promise<Json | null> {
  if (!existsSync(path)) return null
  return JSON.parse(await readFile(path, 'utf8'))
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`)
  await rename(temp, path)
}

/**
 * OpenCode's `auth.json` as a file: `get`/`set`/`all` like `client.auth`.
 * Every `set` is appended to a log so tests can count placeholder writes.
 */
export function fileSlot(authPath: string): HostSlotAdapter {
  const logPath = `${authPath}.writes`
  return {
    async get(input) {
      const map = (await readJson(authPath)) ?? {}
      return map[input.path.id]
    },
    async set(input) {
      const map = (await readJson(authPath)) ?? {}
      map[input.path.id] = input.body
      await writeJson(authPath, map)
      await appendFile(logPath, `${JSON.stringify(input.body)}\n`)
      return true
    },
    async all() {
      return (await readJson(authPath)) ?? {}
    },
  }
}

export function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'pool-migration-'))
  const paths = {
    configPath: join(dir, 'openai-auth.json'),
    statePath: join(dir, 'openai-auth-state.json'),
  }
  const authPath = join(dir, 'auth.json')
  const slot = fileSlot(authPath)
  const store = () =>
    openPoolStore({
      provider: 'openai',
      configPath: paths.configPath,
      statePath: paths.statePath,
      quota: quotaCodec,
    })
  const rows = async () => {
    const load = await store().read()
    if (load.status !== 'ready') throw new Error(`pool is ${load.status}`)
    return load.rows
  }
  const text = async (path: string) =>
    existsSync(path) ? await readFile(path, 'utf8') : null
  return {
    dir,
    paths,
    authPath,
    slot,
    config: async () => (await readJson(paths.configPath)) ?? {},
    state: async () => (await readJson(paths.statePath)) ?? {},
    slotValue: async () => (await readJson(authPath))?.openai,
    setSlot: async (value) => {
      const map = (await readJson(authPath)) ?? {}
      map.openai = value
      await writeJson(authPath, map)
    },
    placeholderWrites: async () =>
      ((await text(`${authPath}.writes`)) ?? '')
        .split('\n')
        .filter((line) => line && isPoolPlaceholder(JSON.parse(line))).length,
    bytes: async () => ({
      config: await text(paths.configPath),
      state: await text(paths.statePath),
      auth: await text(authPath),
    }),
    rows,
    row: async (id) => (await rows()).find((row) => row.id === id),
    deps: (extra = {}) => ({
      paths,
      slot,
      legacyLocks: { timeoutMs: 10_000 },
      leaseWait: { timeoutMs: 300, pollMs: 20 },
      fence: OPEN_FENCE,
      ...extra,
    }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

export const MAIN_QUOTA = {
  primary: {
    usedPercent: 40,
    remainingPercent: 60,
    resetsAt: '2030-01-01T00:00:00.000Z',
    checkedAt: T0,
    windowMinutes: 300,
  },
  secondary: {
    usedPercent: 10,
    remainingPercent: 90,
    resetsAt: '2030-01-05T00:00:00.000Z',
    checkedAt: T0 + 1,
    windowMinutes: 10_080,
  },
}

/**
 * A legacy install as the current openai-auth writes it: main in the slot,
 * one OAuth and one API-key fallback in the config and state files, main's
 * quota and a refresh backoff in `state.main`, `mainAccountId` recorded by
 * the legacy `migrateIfNeeded`, and a few unrelated settings.
 */
export async function seedLegacyInstall(h: Harness): Promise<void> {
  await writeJson(h.paths.configPath, {
    version: 1,
    main: { type: 'opencode', provider: 'openai' },
    mainAccountId: 'acct-main',
    routing: { mode: 'fallback-first' },
    webSockets: true,
    accounts: [
      {
        id: 'fb1',
        type: 'oauth',
        accountId: 'acct-fb1',
        addedAt: 1,
        enabled: true,
      },
      {
        id: 'key1',
        type: 'api',
        baseURL: 'https://api.example.test/v1',
        authHeader: 'authorization-bearer',
        addedAt: 2,
      },
    ],
  })
  await writeJson(h.paths.statePath, {
    version: 1,
    main: {
      quota: MAIN_QUOTA,
      quotaCheckedAt: T0 + 1,
      lastRefreshError: {
        message: 'Token refresh failed: 500',
        checkedAt: T0,
        nextRetryAt: FAR,
        retryCount: 1,
        tokenHash: hashRefreshToken('r-main'),
      },
    },
    accounts: {
      fb1: {
        access: jwt('acct-fb1'),
        refresh: 'r-fb1',
        expires: FAR,
        lastRefreshedAt: T0,
      },
      key1: { apiKey: 'sk-key1' },
    },
  })
  await writeJson(h.authPath, {
    openai: login('acct-main', 'r-main'),
    anthropic: { type: 'api', key: 'unrelated' },
  })
}

/**
 * A token endpoint that rotates refresh tokens the way OpenAI's does: each
 * refresh token works once, and refreshing it returns a new one. It records
 * every token submitted, so a token refreshed twice (the second attempt
 * fails: the first spent it) shows up whichever caller made it.
 */
export function singleUseTokenEndpoint() {
  const submitted = new Map<string, number>()
  let issued = 0
  return {
    async refresh(token: string) {
      submitted.set(token, (submitted.get(token) ?? 0) + 1)
      if (
        !token ||
        token === POOL_PLACEHOLDER_REFRESH ||
        (submitted.get(token) ?? 0) > 1
      )
        throw new Error('invalid_grant: refresh token already used or unknown')
      issued++
      return {
        access: jwt('rotated', String(issued)),
        refresh: `${token}~${issued}`,
        expires: FAR + 3_600_000,
      }
    },
    /** Real refresh tokens submitted more than once. */
    refreshedTwice(): string[] {
      return [...submitted]
        .filter(
          ([token, count]) => count > 1 && token !== POOL_PLACEHOLDER_REFRESH,
        )
        .map(([token]) => token)
        .sort()
    },
    submitted(): string[] {
      return [...submitted.keys()].sort()
    },
  }
}

/**
 * Runs an older build's own refresh paths against a copy of the install (the
 * source is left as it is, for the run that follows): the background refresh
 * of every due roster row (the real `FallbackAccountManager`), then the
 * refresh of the slot credential (`legacyRefreshMain`, vendored from the
 * older plugin entry). The older build's clock is set past every token's
 * expiry and every recorded backoff, so each path refreshes whatever it would
 * ever refresh. Returns the refresh tokens that were refreshed twice.
 */
export async function refreshAsOlderBuild(
  source: Harness,
): Promise<{ refreshedTwice: string[]; submitted: string[] }> {
  const copy = harness()
  try {
    for (const [from, to] of [
      [source.paths.configPath, copy.paths.configPath],
      [source.paths.statePath, copy.paths.statePath],
      [source.authPath, copy.authPath],
    ] as const)
      if (existsSync(from)) await copyFile(from, to)
    const endpoint = singleUseTokenEndpoint()
    const manager = new FallbackAccountManager({
      paths: copy.paths,
      custody: { readManifest: async () => ({ ok: false, reason: 'absent' }) },
      now: () => FAR + 60_000,
      refreshFn: async ({ refreshToken }) => ({
        ...(await endpoint.refresh(refreshToken)),
        expiresIn: 3_600,
      }),
    })
    await manager.refreshDueAccounts()
    await legacyRefreshMain({
      paths: copy.paths,
      slot: copy.slot,
      refresh: endpoint.refresh,
    }).catch(() => {})
    return {
      refreshedTwice: endpoint.refreshedTwice(),
      submitted: endpoint.submitted(),
    }
  } finally {
    copy.cleanup()
  }
}

/** The legacy fallback manager's own usable set (real older-build code). */
export async function legacyUsableFallbackIds(h: Harness): Promise<string[]> {
  const manager = new FallbackAccountManager({
    paths: h.paths,
    custody: { readManifest: async () => ({ ok: false, reason: 'absent' }) },
    refreshFn: async () => {
      throw new Error('no refresh expected')
    },
  })
  return (await manager.getUsableFallbackAccounts())
    .map((account) => account.id)
    .sort()
}

/** Refresh tokens held by pool rows, one entry per row that holds one. */
export async function poolTokens(h: Harness): Promise<string[]> {
  return (await h.rows())
    .flatMap((row) =>
      row.credential?.type === 'oauth' ? [row.credential.refresh] : [],
    )
    .sort()
}

export const CRASH_EXIT_CODE = 17
const childScript = fileURLToPath(
  new URL('./pool-migration-child.ts', import.meta.url),
)

export interface ChildTask {
  dir: string
  mode: 'migrate' | 'adopt'
  /** Exit at the step with this 0-based index (counting every step). */
  exitAtIndex?: number
  /** Exit at the first step with this name. */
  exitAtName?: string
}

export interface ChildRun {
  pid: number | undefined
  code: number | null
  steps: string[]
  outcome?: Json
  output: string
}

/** Runs one migration or adoption in a separate process (see the child). */
export function runChild(task: ChildTask): Promise<ChildRun> {
  const child = spawn(process.execPath, [childScript, JSON.stringify(task)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })
  let out = ''
  child.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    out += chunk.toString()
  })
  return new Promise((resolve) => {
    child.on('exit', (code) => {
      const lines = out.split('\n')
      const steps = lines
        .filter((line) => line.startsWith('step:'))
        .map((line) => line.slice('step:'.length))
      const outcomeLine = lines.find((line) => line.startsWith('outcome:'))
      resolve({
        pid: child.pid,
        code,
        steps,
        output: out,
        ...(outcomeLine
          ? { outcome: JSON.parse(outcomeLine.slice('outcome:'.length)) }
          : {}),
      })
    })
  })
}

/** Lock timing shared by crash children and the runs that follow them. */
export const SHORT_LOCKS = {
  legacyLocks: {
    mainRefreshTtlMs: 1_000,
    fallbackTtlMs: 1_000,
    saveTtlMs: 1_000,
    renew: true,
    renewIntervalMs: 250,
    timeoutMs: 10_000,
    retryMs: 25,
  },
  store: {
    lockOptions: { ttlMs: 1_000, renewIntervalMs: 250, timeoutMs: 10_000 },
  },
} satisfies Partial<PoolMigrationDeps>

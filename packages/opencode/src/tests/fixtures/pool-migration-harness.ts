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
  isPoolMainPlaceholder,
  loadAccounts,
} from '@cortexkit/openai-auth-core/internal'
import { resolvePoolMainAccess } from '../../core/pool-main.ts'
import {
  type HostSlotAdapter,
  isPoolPlaceholder,
  POOL_PLACEHOLDER_REFRESH,
  type PoolMigrationDeps,
  type PoolMigrationFenceDeps,
} from '../../core/pool-migration.ts'
import { legacyRefreshMain } from './legacy-main-refresh.ts'
import { preTolerantRefreshDueAccounts } from './pool-migration-legacy-refresh.ts'
import type { LockTiming } from './pool-migration-lock-clock.ts'

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
        // Thirty days past FAR, well beyond the older build's clock in
        // `refreshAsOlderBuild` (FAR plus a minute), so a rotated token is
        // not due again within the same run.
        expires: FAR + 30 * 86_400_000,
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
 * Which older openai-auth build runs beside the migration:
 * - `pre-tolerant`: 0.11.0 and earlier, whose background refresh ignores
 *   `mainAccountId` (vendored in `pool-migration-legacy-refresh.ts`). The
 *   version fence keeps the migration from starting while one is alive.
 * - `tolerant`: the current core, whose background refresh skips the row
 *   `mainAccountId` shields (the real `FallbackAccountManager`), and which
 *   serves main from row `main` whenever the slot holds the placeholder.
 */
export type OlderBuild = 'pre-tolerant' | 'tolerant'

export interface OlderBuildRun {
  /** Real refresh tokens refreshed more than once. */
  refreshedTwice: string[]
  /** Every token submitted to the token endpoint. */
  submitted: string[]
  /** Where the build got a working main token from, if anywhere. */
  mainServedFrom: 'slot' | 'row main' | 'nowhere'
}

/**
 * Runs an older build's own refresh paths against a copy of the install (the
 * source is left as it is, for the run that follows): the background refresh
 * of every due roster row, then the main account's refresh. The older
 * build's clock is set past every token's expiry and every recorded backoff,
 * so each path refreshes whatever it would ever refresh.
 *
 * The main account: a tolerant build that finds the placeholder in the slot
 * serves main from row `main` through the plugin's own `resolvePoolMainAccess`
 * (refreshing the row as the main account, past the shield). Otherwise, and
 * always for a pre-tolerant build, it refreshes the slot through
 * `legacyRefreshMain` (vendored from the pre-tolerant plugin entry; the
 * tolerant entry's own slot refresh lives inside the plugin loader in
 * `index.ts` and cannot be imported). The tolerant one
 * also honours the main refresh backoff and re-reads the slot under its
 * lock, which only ever makes it refresh less, so the vendored path
 * over-counts rather than hides a double refresh.
 */
export async function refreshAsOlderBuild(
  source: Harness,
  build: OlderBuild,
): Promise<OlderBuildRun> {
  const copy = harness()
  try {
    for (const [from, to] of [
      [source.paths.configPath, copy.paths.configPath],
      [source.paths.statePath, copy.paths.statePath],
      [source.authPath, copy.authPath],
    ] as const)
      if (existsSync(from)) await copyFile(from, to)
    const endpoint = singleUseTokenEndpoint()
    const now = () => FAR + 60_000
    // The legacy writers stamp `lastRefreshedAt` as `expires - expiresIn`
    // and ignore a stamp more than five minutes ahead of the real clock. A
    // lifetime measured from FAR would put the stamp decades ahead and the
    // writer would keep the older token; measuring `expiresIn` from the
    // real clock puts the stamp at the real time of the refresh, so a
    // rotated token wins the writer's newer-token check.
    const refresh = async (token: string) => {
      const tokens = await endpoint.refresh(token)
      return {
        ...tokens,
        expiresIn: Math.floor((tokens.expires - Date.now()) / 1000),
      }
    }
    let mainServedFrom: OlderBuildRun['mainServedFrom'] = 'nowhere'
    const refreshSlot = async () => {
      await legacyRefreshMain({
        paths: copy.paths,
        slot: copy.slot,
        refresh: endpoint.refresh,
      }).then(
        () => {
          mainServedFrom = 'slot'
        },
        () => {},
      )
    }
    if (build === 'pre-tolerant') {
      await preTolerantRefreshDueAccounts({ paths: copy.paths, now, refresh })
      await refreshSlot()
    } else {
      const manager = new FallbackAccountManager({
        paths: copy.paths,
        now,
        refreshFn: async ({ refreshToken }) => refresh(refreshToken),
      })
      await manager.refreshDueAccounts()
      if (isPoolMainPlaceholder(await copy.slotValue())) {
        const served = await resolvePoolMainAccess({
          storage: await loadAccounts(copy.paths),
          now,
          refreshAccount: (account, storage) =>
            manager.refreshAccount(account, storage, { asPoolMain: true }),
        })
        if (served) mainServedFrom = 'row main'
      } else {
        await refreshSlot()
      }
    }
    return {
      refreshedTwice: endpoint.refreshedTwice(),
      submitted: endpoint.submitted(),
      mainServedFrom,
    }
  } finally {
    copy.cleanup()
  }
}

/** The legacy fallback manager's own usable set (real older-build code). */
export async function legacyUsableFallbackIds(h: Harness): Promise<string[]> {
  const manager = new FallbackAccountManager({
    paths: h.paths,
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
  /** Send lock timings to the parent without printing on passing tests. */
  traceLocks?: boolean
}

export interface ChildRun {
  pid: number | undefined
  code: number | null
  steps: string[]
  outcome?: Json
  output: string
  stderr: string
}

export interface ChildObserver {
  start(name: string): () => void
  step(name: string): void
  locks(timings: LockTiming[]): void
  registerCleanup?(stop: () => void): void
}

/** Runs one migration or adoption in a separate process (see the child). */
export function runChild(
  task: ChildTask,
  observer?: ChildObserver,
): Promise<ChildRun> {
  const spawned = observer?.start('child spawn')
  const child = spawn(process.execPath, [childScript, JSON.stringify(task)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })
  let reached: (() => void) | undefined
  let exited: (() => void) | undefined
  let closed: (() => void) | undefined
  let didExit = false
  observer?.registerCleanup?.(() => {
    if (!didExit) child.kill('SIGKILL')
  })
  child.on('spawn', () => {
    spawned?.()
    reached = observer?.start('child time to crash step')
  })
  child.on('exit', () => {
    didExit = true
    reached?.()
    exited?.()
    closed = observer?.start('child pipes close')
  })
  let out = ''
  let stderr = ''
  let buffered = ''
  let stepIndex = 0
  child.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    out += text
    if (!observer) return
    buffered += text
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    for (const line of lines) {
      if (line.startsWith('lock-clock:'))
        observer.locks(JSON.parse(line.slice('lock-clock:'.length)))
      if (!line.startsWith('step:')) continue
      const name = line.slice('step:'.length)
      observer.step(name)
      if (task.exitAtIndex === stepIndex || task.exitAtName === name) {
        reached?.()
        exited = observer.start('child exit after crash step')
        // Pipe delivery can follow exit under load; don't leave a phantom
        // unfinished exit phase when the OS already reported the exit.
        if (didExit) exited()
      }
      stepIndex++
    }
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
    out += chunk.toString()
  })
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    // Exit can precede the last pipe data. Close guarantees the child's error
    // stack and final migration step are collected before assertions run.
    child.on('close', (code) => {
      reached?.()
      exited?.()
      closed?.()
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
        stderr,
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

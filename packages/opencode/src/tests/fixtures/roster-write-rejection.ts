import { spyOn } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as fileLocks from '@cortexkit/common-auth/fs'
import { LockOwnershipError, lockPathFor } from '@cortexkit/common-auth/fs'
import { vaultPaths } from '@cortexkit/openai-auth-core/internal'
import {
  startMockDaemon,
  vaultLogin,
} from '../../../../core/src/tests/fixtures/mock-claustrum'

const dir = mkdtempSync(join(tmpdir(), 'roster-rejection-'))
process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = join(dir, 'plugin.log')
const { acquireOpenCodeVault } = await import('../../core/shared-vault')
const { flushForTest } = await import('../../logger')
const lockModule = (await import(
  new URL(
    'refresh-file-lock.js',
    import.meta.resolve('@cortexkit/common-auth/fs'),
  ).href
)) as Pick<typeof fileLocks, 'acquireRefreshFileLock'>
const acquire = lockModule.acquireRefreshFileLock
let expire = false
let expired: unknown
const failed = Promise.withResolvers<void>()
// Keep acquisition and fencing real; expire only this child's on-disk lease
// immediately before the store's ownership assertion, without waiting ten seconds.
const lockSpy = spyOn(lockModule, 'acquireRefreshFileLock').mockImplementation(
  async (options) => {
    const lock = await acquire(options)
    if (!lock || options.name !== 'claustrum-roster-write') return lock
    return {
      ...lock,
      async assertOwned() {
        if (expire) {
          const path = lockPathFor(options.path, options.name)
          const owner = JSON.parse(readFileSync(path, 'utf8'))
          writeFileSync(path, JSON.stringify({ ...owner, expiresAt: 0 }))
        }
        try {
          await lock.assertOwned()
        } catch (error) {
          if (!expired && error instanceof LockOwnershipError) {
            expired = {
              realOwnershipError: true,
              sameOwner:
                error.details.expectedOwnerId === error.details.observedOwnerId,
              observedExpiresAt: error.details.observedExpiresAt,
              name: error.details.name,
            }
            failed.resolve()
          }
          throw error
        }
      },
    }
  },
)
const unhandled: string[] = []
const onUnhandled = (error: unknown) => {
  unhandled.push(error instanceof Error ? error.name : String(error))
}
process.on('unhandledRejection', onUnhandled)
const daemon = await startMockDaemon({
  directory: dir,
  credentials: { a: vaultLogin('account-a') },
})
let now = Date.now()
const updateUsage = () => {
  daemon.insula = {
    reply: {
      result: [
        {
          provider: 'codex',
          account: 'account-a',
          fetchedAt: new Date(now).toISOString(),
          source: 'vault',
          usage: { primary: { usedPercent: 10, windowMinutes: 300 } },
        },
      ],
    },
  }
}
updateUsage()
const stateDir = join(dir, 'vault')
mkdirSync(stateDir, { mode: 0o700 })
writeFileSync(
  vaultPaths(stateDir, 'opencode').tokenPath,
  JSON.stringify({ token: 'ab'.repeat(32), token_generation: 1 }),
  { mode: 0o600 },
)
const lease = acquireOpenCodeVault(
  {
    host: 'opencode',
    stateDir,
    connectionFile: () => daemon.connectionFile,
    pollIntervalMs: 0,
    now: () => now,
  },
  {
    configPath: join(dir, 'accounts.json'),
    statePath: join(dir, 'state.json'),
  },
)
let interval: (() => void) | undefined
const setIntervalImpl = globalThis.setInterval
const intervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(((
  callback: () => void,
  delay: number,
) => {
  if (delay === 60_000) interval = callback
  return setIntervalImpl(callback, delay)
}) as typeof setInterval)
const pollStale = lease.vault.pollStale.bind(lease.vault)
let currentPoll: Promise<unknown> | undefined
const started = Promise.withResolvers<void>()
const pollSpy = spyOn(lease.vault, 'pollStale').mockImplementation((age) => {
  currentPoll = pollStale(age)
  started.resolve()
  return currentPoll as ReturnType<typeof pollStale>
})

try {
  // Finish discovery before arming the quota write, so the failure cannot be
  // mistaken for a failed discovery or an optional daemon read.
  lease.start()
  await lease.firstRoster
  expire = process.argv[2] === 'startup'
  await started.promise
  if (!expire) {
    if (!currentPoll || !interval) throw new Error('startup poll did not run')
    await currentPoll
    now += 5 * 60_000
    updateUsage()
    expire = true
    interval()
  }
  await failed.promise
  // Join the inner work, not the floating async callback that awaits it.
  // Rejection reporting for that outer promise runs on the next event-loop turn.
  await currentPoll?.catch(() => {})
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
  expire = false
  const recovered = (await lease.vault.pollStale(0)).every((row) => row.ok)
  expire = true
  const route = lease.vault.routes()[0]
  if (!route) throw new Error('recovery lost the vault route')
  const declineRejected = await lease.vault.decline(route.id).then(
    () => false,
    (error: unknown) => error instanceof LockOwnershipError,
  )
  await flushForTest()
  const warnings = readFileSync(join(dir, 'plugin.log'), 'utf8')
    .split('\n')
    .filter((line) => line.includes('WARN'))
  console.log(
    JSON.stringify({
      expired,
      unhandled,
      warnings,
      recovered,
      declineRejected,
    }),
  )
} finally {
  lease.release()
  pollSpy.mockRestore()
  intervalSpy.mockRestore()
  lockSpy.mockRestore()
  process.off('unhandledRejection', onUnhandled)
  await daemon.stop()
  rmSync(dir, { recursive: true, force: true })
}

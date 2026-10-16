import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  PoolMigrationDeps,
  PoolMigrationStep,
} from '../../core/pool-migration.ts'
import { createFailurePhaseClock } from '../failure-phase-clock.ts'
import { readEvictionMarker, readLease } from './pool-migration-lock-clock.ts'

/** Report transfer steps and held leases only when a test fails or overruns. */
export function createPoolTransferClock() {
  let directory: string | undefined
  const clock = createFailurePhaseClock(() => {
    if (!directory) return { locks: [] }
    try {
      const root = directory
      return {
        locks: readdirSync(root, { recursive: true })
          .map(String)
          .filter(
            (path) => path.endsWith('.lock') || path.endsWith('.lock.evicting'),
          )
          .map((path) => path.replace(/\.evicting$/, ''))
          .filter((path, index, paths) => paths.indexOf(path) === index)
          .map((path) => ({
            path,
            lease: readLease(join(root, path)),
            marker: readEvictionMarker(join(root, path)),
          })),
      }
    } catch (error) {
      return { lockSnapshotError: String(error) }
    }
  })
  return {
    ...clock,
    capture(path: string) {
      directory = path
    },
    deps<T extends Partial<PoolMigrationDeps>>(deps: T) {
      return {
        ...deps,
        onStep: (step: PoolMigrationStep) =>
          clock.phase(`migration step: ${step}`, async () => {
            await deps.onStep?.(step)
          }),
      }
    },
    restore() {
      directory = undefined
    },
  }
}

// A second process for the pool-migration crash and race rows. It runs one
// migration or adoption against the harness directory named in its JSON
// argument, prints `step:<name>` at every named step (the module's own steps
// and the pool store's write steps, prefixed `store:`), and exits with
// CRASH_EXIT_CODE when it reaches the requested step, so the observing test
// process survives the crash.
import { writeSync } from 'node:fs'
import { join } from 'node:path'
import { adoptHostSlotLogin, migrateToPool } from '../../core/pool-migration.ts'
import {
  type ChildTask,
  CRASH_EXIT_CODE,
  fileSlot,
  OPEN_FENCE,
  SHORT_LOCKS,
} from './pool-migration-harness.ts'

// Every line below is followed by process.exit. On macOS stdout to a pipe is
// asynchronous, so a console.log line can still be queued when the process
// exits and the parent reads it cut short. Write each line synchronously
// instead; a full non-blocking pipe answers EAGAIN until the parent drains it.
function emit(line: string) {
  const bytes = Buffer.from(`${line}\n`)
  let offset = 0
  while (offset < bytes.length) {
    try {
      offset += writeSync(1, bytes, offset)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error
    }
  }
}

const task = JSON.parse(process.argv[2] ?? '{}') as ChildTask
const locks =
  task.traceLocks ||
  task.exitAtIndex !== undefined ||
  task.exitAtName !== undefined
    ? (await import('./pool-migration-lock-clock.ts')).observeMigrationLocks()
    : undefined
const sendLocks = () => {
  if (locks) emit(`lock-clock:${JSON.stringify(locks.snapshot())}`)
}
// With tracing on, print the lock timings every five seconds as well. The
// parent captures this output and shows it only when the test fails or
// overruns, so passing runs stay quiet.
const lockDeadline = task.traceLocks ? setInterval(sendLocks, 5_000) : undefined
let index = 0
const reach = (name: string) => {
  const hit =
    task.exitAtIndex === index ||
    (task.exitAtName !== undefined && task.exitAtName === name)
  // A full snapshot at every write would add substantial serialization work
  // under the very CPU contention these clocks are meant to observe.
  if (hit) sendLocks()
  emit(`step:${name}`)
  index++
  if (hit) process.exit(CRASH_EXIT_CODE)
}

const deps = {
  paths: {
    configPath: join(task.dir, 'openai-auth.json'),
    statePath: join(task.dir, 'openai-auth-state.json'),
  },
  slot: fileSlot(join(task.dir, 'auth.json')),
  leaseWait: { timeoutMs: 300, pollMs: 20 },
  legacyLocks: SHORT_LOCKS.legacyLocks,
  store: {
    ...SHORT_LOCKS.store,
    onStep: (step: string, info: { operation: string }) =>
      reach(`store:${info.operation}:${step}`),
  },
  onStep: (step: string) => reach(step),
  fence: OPEN_FENCE,
}

try {
  const outcome =
    task.mode === 'migrate'
      ? await migrateToPool(deps)
      : await adoptHostSlotLogin(deps)
  emit(`outcome:${JSON.stringify(outcome)}`)
  sendLocks()
  process.exit(0)
} catch (error) {
  sendLocks()
  emit(`failed:${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
} finally {
  clearInterval(lockDeadline)
  locks?.restore()
}

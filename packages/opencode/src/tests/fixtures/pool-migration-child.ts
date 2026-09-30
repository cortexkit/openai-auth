// A second process for the pool-migration crash and race rows. It runs one
// migration or adoption against the harness directory named in its JSON
// argument, prints `step:<name>` at every named step (the module's own steps
// and the pool store's write steps, prefixed `store:`), and exits with
// CRASH_EXIT_CODE when it reaches the requested step, so the observing test
// process survives the crash.
import { join } from 'node:path'
import { adoptHostSlotLogin, migrateToPool } from '../../core/pool-migration.ts'
import {
  type ChildTask,
  CRASH_EXIT_CODE,
  fileSlot,
  SHORT_LOCKS,
} from './pool-migration-harness.ts'

const task = JSON.parse(process.argv[2] ?? '{}') as ChildTask
let index = 0
const reach = (name: string) => {
  console.log(`step:${name}`)
  const hit =
    task.exitAtIndex === index ||
    (task.exitAtName !== undefined && task.exitAtName === name)
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
}

try {
  const outcome =
    task.mode === 'migrate'
      ? await migrateToPool(deps)
      : await adoptHostSlotLogin(deps)
  console.log(`outcome:${JSON.stringify(outcome)}`)
  process.exit(0)
} catch (error) {
  console.log(`failed:${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
}

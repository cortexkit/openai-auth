// Process heartbeat: which plugin versions are running on this machine.
//
// Every plugin process that runs the auth loader leaves one small file,
// `<pid>.json`, in a shared directory under the user's state home, and removes
// it again on dispose. A later change that alters the on-disk account layout
// reads these files to learn which versions are live before it acts; a reader
// treats a file whose pid is no longer running as absent, so a crashed process
// leaves nothing it has to clean up.
//
// Writing it is best-effort. A failure is logged and never fails the loader,
// and nothing here runs on the request path.
//
// The file also carries `layouts`: for each OpenCode config folder this
// process resolved, whether it keeps that folder's runtime files in the
// config folder itself (`legacy`) or in the state home (`state-home`), see
// `runtime-layout.ts`. A process that runs on the legacy layout keeps its
// file until it exits, even after its last owner released it, because its
// paths stay fixed for its whole life and the move must wait for it.

import { randomUUID } from 'node:crypto'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hasLegacyRuntimeGeneration } from './runtime-process-state'

/** Where one process keeps one config folder's runtime files. */
export type ProcessLayout = 'legacy' | 'state-home'

export interface ProcessHeartbeat {
  pid: number
  version: string
  startedAt: number
  /** Config folder key (`runtimeLayoutLocation().key`) to its layout. */
  layouts: Record<string, ProcessLayout>
}

/**
 * The heartbeat directory, resolved the same way as the RPC directory:
 * `$XDG_STATE_HOME/cortexkit/openai-auth/processes`, with `~/.local/state` as
 * the state home when XDG_STATE_HOME is unset.
 */
export function processHeartbeatDir(): string {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
  return join(base, 'cortexkit', 'openai-auth', 'processes')
}

export function processHeartbeatPath(
  pid: number = process.pid,
  dir: string = processHeartbeatDir(),
): string {
  return join(dir, `${pid}.json`)
}

// One OpenCode process can host several plugin instances (one per project
// directory), all sharing one pid and therefore one file. The file stays until
// the last of them disposes.
let liveOwners = 0
let processStartedAt: number | undefined

// The layouts this process chose, one per config folder. Kept on the global
// object because OpenCode 2 may load more than one copy of this bundle into
// one process, and every copy must write the same heartbeat.
const layoutsKey = Symbol.for('@cortexkit/openai-auth/process-layouts')
const layoutState = globalThis as typeof globalThis & {
  [layoutsKey]?: Map<string, ProcessLayout>
}
const processLayouts = layoutState[layoutsKey] ?? new Map()
layoutState[layoutsKey] = processLayouts

function layoutsRecord(): Record<string, ProcessLayout> {
  return {
    ...Object.fromEntries(processLayouts),
    // Older generations did not record config-folder identities. A sentinel
    // blocks moves for every folder, including before the first setup finishes.
    ...(hasLegacyRuntimeGeneration() ? { '*': 'legacy' as const } : {}),
  }
}

function holdsLegacyLayout(): boolean {
  if (hasLegacyRuntimeGeneration()) return true
  for (const layout of processLayouts.values())
    if (layout === 'legacy') return true
  return false
}

export interface HeartbeatLogger {
  warn(message: string, meta?: Record<string, unknown>): unknown
}

export interface ProcessHeartbeatHandle {
  /** Where the heartbeat was written, or undefined when the write failed. */
  path: string | undefined
  /** Drop this owner; the file is removed when no owner in the process is left. */
  release(): Promise<void>
}

async function writeHeartbeatFile(
  dir: string,
  heartbeat: ProcessHeartbeat,
): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  // mkdir's mode does not apply to a directory that already exists.
  await chmod(dir, 0o700)
  const target = processHeartbeatPath(heartbeat.pid, dir)
  const legacyTarget = join(dir, `0${heartbeat.pid}.json`)
  // Pre-layout release handles can still unlink <pid>.json after a newer
  // location starts. Existing fences accept a decimal pid with a leading zero,
  // while those release handles only unlink the canonical name. The extra
  // legacy record blocks moves until this pid exits.
  const targets = hasLegacyRuntimeGeneration()
    ? [legacyTarget, target]
    : [target]
  if (!hasLegacyRuntimeGeneration()) {
    // A fresh process may reuse the pid of an exited legacy generation.
    await rm(legacyTarget, { force: true }).catch(() => {})
  }
  // Written to a temporary name and renamed into place, so a reader never
  // sees a half-written file.
  for (const path of targets) {
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(heartbeat)}\n`, {
        mode: 0o600,
      })
      await rename(temporary, path)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }
  return target
}

/**
 * Record this process as running `version`. Never throws: a failed write is
 * logged at warn, and the returned handle's release is then a no-op for the
 * file (the owner count is still kept, so another owner's file is not removed
 * early).
 */
export async function startProcessHeartbeat(input: {
  version: string
  logger: HeartbeatLogger
  now?: () => number
  pid?: number
  dir?: string
}): Promise<ProcessHeartbeatHandle> {
  const pid = input.pid ?? process.pid
  const dir = input.dir ?? processHeartbeatDir()
  processStartedAt ??= (input.now ?? Date.now)()
  liveOwners++
  let path: string | undefined
  try {
    path = await writeHeartbeatFile(dir, {
      pid,
      version: input.version,
      startedAt: processStartedAt,
      layouts: layoutsRecord(),
    })
  } catch (error) {
    input.logger.warn('process heartbeat not written', {
      dir,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  let released = false
  return {
    path,
    async release() {
      if (released) return
      released = true
      liveOwners = Math.max(0, liveOwners - 1)
      if (liveOwners > 0) return
      // A legacy-layout process keeps using the old paths until it exits.
      if (holdsLegacyLayout()) return
      await rm(processHeartbeatPath(pid, dir), { force: true }).catch(
        (error: unknown) => {
          input.logger.warn('process heartbeat not removed', {
            dir,
            error: error instanceof Error ? error.message : String(error),
          })
        },
      )
    },
  }
}

/**
 * Record which layout this process uses for one config folder. A `legacy`
 * choice is written to the heartbeat file at once, because another process
 * deciding whether it may move the files reads it; the caller makes the
 * choice and this write while it holds the layout lock. A `state-home`
 * choice only goes into the next heartbeat write. Throws when the write
 * fails.
 */
export async function recordProcessLayout(input: {
  key: string
  layout: ProcessLayout
  version: string
  now?: () => number
  pid?: number
  dir?: string
}): Promise<void> {
  const layout = hasLegacyRuntimeGeneration() ? 'legacy' : input.layout
  processLayouts.set(input.key, layout)
  if (layout !== 'legacy') return
  processStartedAt ??= (input.now ?? Date.now)()
  await writeHeartbeatFile(input.dir ?? processHeartbeatDir(), {
    pid: input.pid ?? process.pid,
    version: input.version,
    startedAt: processStartedAt,
    layouts: layoutsRecord(),
  })
}

/** Forget the process-wide owner count; for tests only. */
export function __resetProcessHeartbeatForTest(): void {
  liveOwners = 0
  processStartedAt = undefined
  processLayouts.clear()
}

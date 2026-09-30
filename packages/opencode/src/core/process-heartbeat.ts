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

import { randomUUID } from 'node:crypto'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ProcessHeartbeat {
  pid: number
  version: string
  startedAt: number
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
  // Written to a temporary name and renamed into place, so a reader never
  // sees a half-written file.
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(heartbeat)}\n`, {
      mode: 0o600,
    })
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
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

/** Forget the process-wide owner count; for tests only. */
export function __resetProcessHeartbeatForTest(): void {
  liveOwners = 0
  processStartedAt = undefined
}

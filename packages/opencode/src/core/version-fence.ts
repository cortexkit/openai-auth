// Decides whether the account-pool migration may run: only while every live
// openai-auth plugin process on this machine is the migrating version or
// newer. Older versions keep refreshing the main credential from OpenCode's
// login slot and every roster row by their own rules; the migration's safety
// argument holds only against versions that know about the pool.
//
// A process is found through either of two files it leaves on disk:
//
// - a heartbeat, `<state>/cortexkit/openai-auth/processes/<pid>.json` holding
//   `{ "pid", "version", "startedAt" }`, which versions from the tolerant
//   release on write;
// - an RPC port file, `<state>/cortexkit/openai-auth/rpc/<dir>/port-<pid>.json`,
//   which every plugin version writes (`<dir>` is `openai-auth-<hash>`, or the
//   unprefixed `<hash>` older versions used).
//
// A process counts as running while its pid is alive. A live pid with a port
// file but no heartbeat predates heartbeats, so it is an older version. The
// fence fails closed: any file or directory it cannot read, or a version it
// cannot parse, keeps it shut.

import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isOpenaiRpcStateDir } from '../rpc/port-file'

/** One live process that keeps the fence shut. */
export interface VersionFenceBlocker {
  /** `'unknown'` when a whole directory could not be read. */
  pid: number | 'unknown'
  /** The version its heartbeat names, or `'unknown'`. */
  version: string
  /** The file or directory that showed it. */
  detail: string
}

export type VersionFenceResult =
  | { open: true }
  | { open: false; blockers: VersionFenceBlocker[] }

export interface VersionFenceOptions {
  /** The XDG state base; defaults to `$XDG_STATE_HOME` or `~/.local/state`. */
  stateHome?: string
  /** Root holding the per-project RPC directories; defaults under the base. */
  rpcDir?: string
  /** The version that wants to migrate. */
  currentVersion: string
  isAlive?: (pid: number) => boolean
  /** This process, which never blocks itself. Defaults to `process.pid`. */
  selfPid?: number
}

function defaultStateHome(): string {
  return process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
}

/** Where a plugin process writes its heartbeat, `<pid>.json`. */
export function processHeartbeatDir(stateHome = defaultStateHome()): string {
  return join(stateHome, 'cortexkit', 'openai-auth', 'processes')
}

/** The root of the plugin's per-project RPC directories. */
export function rpcStateRoot(stateHome = defaultStateHome()): string {
  return join(stateHome, 'cortexkit', 'openai-auth', 'rpc')
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

type Semver = { core: [number, number, number]; pre: string[] }

function parseSemver(value: string): Semver | undefined {
  const match =
    /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      value.trim(),
    )
  if (!match) return undefined
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : [],
  }
}

/**
 * Semver precedence of `a` against `b` (negative, zero, positive), or
 * undefined when either is not a version. A pre-release sorts below its
 * release; build metadata is ignored.
 */
export function compareVersions(a: string, b: string): number | undefined {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (!left || !right) return undefined
  for (let i = 0; i < 3; i++) {
    const diff = (left.core[i] as number) - (right.core[i] as number)
    if (diff !== 0) return Math.sign(diff)
  }
  if (left.pre.length === 0 || right.pre.length === 0)
    return Math.sign(right.pre.length - left.pre.length)
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i]
    const y = right.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) {
      const diff = Number(x) - Number(y)
      if (diff !== 0) return Math.sign(diff)
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

type Listing =
  | { ok: true; names: string[] }
  | { ok: false; code: string | undefined; error: string }

/** A missing directory lists as empty; any other failure is reported. */
async function list(dir: string): Promise<Listing> {
  try {
    return { ok: true, names: await readdir(dir) }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: true, names: [] }
    return { ok: false, code, error: `${dir}: ${String(error)}` }
  }
}

type Heartbeat =
  | { kind: 'gone' }
  | { kind: 'unreadable' }
  | { kind: 'ok'; version: string }

async function readHeartbeat(path: string, pid: number): Promise<Heartbeat> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    // Removed between the listing and the read: that process has exited.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { kind: 'gone' }
    return { kind: 'unreadable' }
  }
  try {
    const value: unknown = JSON.parse(text)
    if (
      value !== null &&
      typeof value === 'object' &&
      (value as { pid?: unknown }).pid === pid &&
      typeof (value as { version?: unknown }).version === 'string'
    )
      return { kind: 'ok', version: (value as { version: string }).version }
  } catch {}
  return { kind: 'unreadable' }
}

/**
 * Whether the account-pool migration may run now. Never throws: anything it
 * cannot establish counts as a blocker.
 */
export async function migrationFenceOpen(
  options: VersionFenceOptions,
): Promise<VersionFenceResult> {
  const isAlive = options.isAlive ?? pidAlive
  const self = options.selfPid ?? process.pid
  const blockers = new Map<number | string, VersionFenceBlocker>()
  const block = (entry: VersionFenceBlocker) => {
    const key = entry.pid === 'unknown' ? `dir:${entry.detail}` : entry.pid
    if (!blockers.has(key)) blockers.set(key, entry)
  }
  const alive = (pid: number) => {
    try {
      return isAlive(pid)
    } catch {
      return true
    }
  }
  const pidFrom = (name: string, pattern: RegExp): number | undefined => {
    const match = pattern.exec(name)
    const pid = match ? Number(match[1]) : Number.NaN
    return Number.isSafeInteger(pid) && pid >= 1 ? pid : undefined
  }

  // Heartbeats: the version a live process says it runs.
  const heartbeatDir = processHeartbeatDir(options.stateHome)
  const withHeartbeat = new Set<number>()
  const heartbeats = await list(heartbeatDir)
  if (!heartbeats.ok)
    block({ pid: 'unknown', version: 'unknown', detail: heartbeats.error })
  for (const name of heartbeats.ok ? heartbeats.names : []) {
    const pid = pidFrom(name, /^(\d+)\.json$/)
    if (pid === undefined || pid === self) continue
    const path = join(heartbeatDir, name)
    const heartbeat = await readHeartbeat(path, pid)
    if (heartbeat.kind === 'gone') continue
    withHeartbeat.add(pid)
    if (!alive(pid)) continue
    if (heartbeat.kind === 'unreadable') {
      block({ pid, version: 'unknown', detail: path })
      continue
    }
    const order = compareVersions(heartbeat.version, options.currentVersion)
    if (order === undefined || order < 0)
      block({ pid, version: heartbeat.version, detail: path })
  }

  // Port files: every plugin version writes one per process. Only its name
  // matters (`port-<pid>.json`), so an unreadable body still names the pid.
  const rpcRoot = options.rpcDir ?? rpcStateRoot(options.stateHome)
  const projects = await list(rpcRoot)
  if (!projects.ok)
    block({ pid: 'unknown', version: 'unknown', detail: projects.error })
  for (const project of projects.ok ? projects.names : []) {
    if (!isOpenaiRpcStateDir(project)) continue
    const dir = join(rpcRoot, project)
    const ports = await list(dir)
    if (!ports.ok) {
      // A plain file with a directory's name is not a project directory.
      if (ports.code === 'ENOTDIR') continue
      block({ pid: 'unknown', version: 'unknown', detail: ports.error })
      continue
    }
    for (const name of ports.names) {
      const pid = pidFrom(name, /^port-(\d+)\.json$/)
      if (pid === undefined || pid === self || withHeartbeat.has(pid)) continue
      if (alive(pid))
        block({ pid, version: 'unknown', detail: join(dir, name) })
    }
  }

  // Directory listings come in no fixed order; report blockers by pid.
  const rank = (b: VersionFenceBlocker) =>
    b.pid === 'unknown' ? Number.POSITIVE_INFINITY : b.pid
  return blockers.size === 0
    ? { open: true }
    : {
        open: false,
        blockers: [...blockers.values()].sort((a, b) => rank(a) - rank(b)),
      }
}

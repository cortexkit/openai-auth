import { randomUUID } from 'node:crypto'
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { homedir, uptime } from 'node:os'
import { join } from 'node:path'
import { createManagedRpcStateDirPredicate } from '@cortexkit/common-auth/rpc'
import type { SettingsDecision } from './settings-decisions'
import { canonicalSettingsPath } from './settings-install'

/** The first OpenCode release that coordinates the move to a shared settings file. */
export const SETTINGS_ADOPTING_VERSION = '1.15.0'
const isOpenaiRpcStateDir = createManagedRpcStateDirPredicate('openai-auth-')

export function settingsProcessRoot(stateHome?: string): string {
  const base =
    stateHome ??
    (process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'))
  return join(base, 'cortexkit', 'openai-auth')
}

export function piProcessRecordDir(stateHome?: string): string {
  return join(settingsProcessRoot(stateHome), 'pi-processes')
}

/** A process can stop using old preferences only after every legacy instance exits. */
export function aggregateProcessSettings(
  decisions: Iterable<SettingsDecision>,
): SettingsDecision | undefined {
  let result: SettingsDecision | undefined
  for (const decision of decisions) {
    if (decision === 'legacy') return 'legacy'
    if (decision === 'shared' || result === undefined) result = decision
  }
  return result
}

export interface SettingsProcessRecord {
  pid: number
  version: string
  startedAt: number
  settings: SettingsDecision
}

type PiProcessState = {
  startedAt: number
  decisions: Map<string, SettingsDecision>
  writing: Promise<unknown>
}
const piKey = Symbol.for('@cortexkit/openai-auth/pi-settings-records')
const piGlobal = globalThis as typeof globalThis & {
  [piKey]?: Map<string, PiProcessState>
}
const piRecords = piGlobal[piKey] ?? new Map<string, PiProcessState>()
piGlobal[piKey] = piRecords

/**
 * Publish Pi's startup choice. A caller that may use old preferences holds the
 * shared settings-authority lock, which orders fence scans, moves and record
 * writes. Separate installs and completed moves do not require that lock.
 * Choices last for the process lifetime, including after an extension disposes.
 * A failed write throws so a caller that needs an old store can refuse to start.
 */
export async function recordPiProcessSettings(input: {
  configPath: string
  settings: SettingsDecision
  version: string
  stateHome?: string
  dir?: string
  pid?: number
  now?: () => number
}): Promise<string> {
  const pid = input.pid ?? process.pid
  const dir = input.dir ?? piProcessRecordDir(input.stateHome)
  const target = join(dir, `${pid}.json`)
  let state = piRecords.get(target)
  if (!state) {
    state = {
      startedAt: (input.now ?? Date.now)(),
      decisions: new Map(),
      writing: Promise.resolve(),
    }
    piRecords.set(target, state)
  }
  const identity = canonicalSettingsPath(input.configPath)
  if (!state.decisions.has(identity))
    state.decisions.set(identity, input.settings)
  const record: SettingsProcessRecord = {
    pid,
    version: input.version,
    startedAt: state.startedAt,
    settings: aggregateProcessSettings(
      state.decisions.values(),
    ) as SettingsDecision,
  }
  const write = state.writing
    .catch(() => {})
    .then(async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await chmod(dir, 0o700)
      const temporary = `${target}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, `${JSON.stringify(record)}\n`, {
          mode: 0o600,
        })
        await rename(temporary, target)
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {})
        throw error
      }
      return target
    })
  state.writing = write
  return write
}

export interface SettingsFenceBlocker {
  pid: number | 'unknown'
  version: string
  detail: string
}

export type SettingsFenceResult =
  | { open: true }
  | { open: false; blockers: SettingsFenceBlocker[] }

export interface SettingsFenceOptions {
  stateHome?: string
  rpcDir?: string
  selfPid?: number
  isAlive?: (pid: number) => boolean
  now?: () => number
  uptime?: () => number
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function adoptsSettings(version: string): boolean {
  const match =
    /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      version.trim(),
    )
  if (!match) return false
  const core = match.slice(1, 4).map(Number)
  if (!core.every(Number.isSafeInteger)) return false
  const adopting = SETTINGS_ADOPTING_VERSION.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const value = core[i] as number
    if (value !== adopting[i]) return value > (adopting[i] as number)
  }
  return match[4] === undefined
}

type RecordRead =
  | { kind: 'gone' }
  | { kind: 'unreadable' }
  | { kind: 'ok'; version: string; startedAt: unknown; settings: unknown }

async function readRecord(path: string, pid: number): Promise<RecordRead> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    return {
      kind:
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'gone'
          : 'unreadable',
    }
  }
  try {
    const value = JSON.parse(text)
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      value.pid === pid
    ) {
      return {
        kind: 'ok',
        version: typeof value.version === 'string' ? value.version : 'unknown',
        startedAt: value.startedAt,
        settings: value.settings,
      }
    }
  } catch {}
  return { kind: 'unreadable' }
}

/** Scan both hosts' records and OpenCode's independent evidence in RPC port files. */
export async function settingsFenceOpen(
  options: SettingsFenceOptions = {},
): Promise<SettingsFenceResult> {
  const root = settingsProcessRoot(options.stateHome)
  const self = options.selfPid ?? process.pid
  const staleBefore =
    (options.now ?? Date.now)() -
    (options.uptime ?? uptime)() * 1000 -
    5 * 60 * 1000
  const stale = (time: unknown) =>
    typeof time === 'number' && Number.isFinite(time) && time < staleBefore
  const alive = (pid: number) => {
    try {
      return (options.isAlive ?? pidAlive)(pid)
    } catch {
      return true
    }
  }
  const blockers: SettingsFenceBlocker[] = []
  const block = (pid: number | 'unknown', version: string, detail: string) => {
    if (
      !blockers.some(
        (entry) =>
          entry.pid === pid && (pid !== 'unknown' || entry.detail === detail),
      )
    )
      blockers.push({ pid, version, detail })
  }
  const list = async (dir: string, project = false): Promise<string[]> => {
    try {
      return await readdir(dir)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && !(project && code === 'ENOTDIR'))
        block('unknown', 'unknown', dir)
      return []
    }
  }
  const pidFrom = (name: string, pattern: RegExp) => {
    const match = pattern.exec(name)
    const pid = match ? Number(match[1]) : NaN
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
  }

  for (const host of ['processes', 'pi-processes']) {
    const dir = join(root, host)
    for (const name of await list(dir)) {
      const pid = pidFrom(name, /^(\d+)\.json$/)
      if (pid === undefined || pid === self) continue
      const path = join(dir, name)
      const record = await readRecord(path, pid)
      if (record.kind === 'gone') continue
      if (record.kind === 'ok' && stale(record.startedAt)) {
        await rm(path, { force: true }).catch(() => {})
        continue
      }
      if (!alive(pid)) continue
      if (record.kind === 'unreadable') {
        block(pid, 'unknown', path)
        continue
      }
      if (record.settings === 'separate') continue
      if (
        record.settings === 'legacy' ||
        (record.settings !== undefined && record.settings !== 'shared') ||
        (host === 'processes' && !adoptsSettings(record.version)) ||
        (host === 'pi-processes' && record.settings === undefined)
      )
        block(pid, record.version, path)
    }
  }

  // A fresh heartbeat cannot vouch for an older port after a pid has been reused.
  const rpc = options.rpcDir ?? join(root, 'rpc')
  for (const project of await list(rpc)) {
    if (!isOpenaiRpcStateDir(project)) continue
    const dir = join(rpc, project)
    for (const name of await list(dir, true)) {
      const pid = pidFrom(name, /^port-(\d+)\.json$/)
      if (pid === undefined || pid === self || !alive(pid)) continue
      const path = join(dir, name)
      const record = await readRecord(path, pid)
      if (record.kind === 'gone') continue
      if (record.kind === 'ok') {
        const time =
          record.startedAt === undefined
            ? await stat(path)
                .then((file) => file.mtimeMs)
                .catch(() => undefined)
            : record.startedAt
        if (stale(time)) continue
      }
      if (record.kind === 'unreadable' || !adoptsSettings(record.version))
        block(pid, record.kind === 'ok' ? record.version : 'unknown', path)
    }
  }
  blockers.sort(
    (a, b) =>
      (a.pid === 'unknown' ? Infinity : a.pid) -
      (b.pid === 'unknown' ? Infinity : b.pid),
  )
  return blockers.length ? { open: false, blockers } : { open: true }
}

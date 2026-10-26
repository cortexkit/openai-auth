// Moves the plugin's runtime files out of OpenCode's config folder, once.
//
// OpenCode 2 watches its config folder, and the plugin rewrites its runtime
// files there every few seconds: the account state file, the vault folder
// (enrollment and roster) and the Codex sessions files, each with lock
// directories, eviction markers and staged temporary files. They move to the
// state home (`account-paths.ts` names both folders); the settings file
// `openai-auth.json` stays where it is.
//
// The rules:
// - A process fixes its layout for a config folder once, at plugin start,
//   before it builds the vault, the account store or a sessions store, and
//   never switches while it runs. A live switch would race the writes the
//   process already has in flight against the old paths.
// - `layout.json` in the state-home folder makes that folder authoritative.
//   Without it, any old file keeps the config folder authoritative; with no
//   old file either (a fresh install) the marker is written straight away.
// - The move, and the fresh install's marker, wait while any other live
//   process could still write the old files: one that runs an older version,
//   or one that runs this version on the legacy layout for this config folder
//   (its heartbeat says so, `process-heartbeat.ts`). A process that starts
//   while one of those is alive takes the legacy layout too, and records it.
//   So the move happens at the first start after every OpenCode using that
//   config folder has been closed or restarted on this version.
// - Every decision is made holding the layout lock in the state-home folder,
//   and a legacy choice is written to the heartbeat before the lock is
//   released, so a process deciding later sees it.
// - The move holds the layout lock, then the store's `save` lock at the old
//   state file, the vault's `claustrum-roster-write` lock at the old roster
//   and the `sessions` lock at each old sessions file (the order of the lock
//   list in `pool-migration.ts`). It re-reads the heartbeats under all of
//   them right before copying. Each file is copied owner-only and made
//   durable, read back and compared byte for byte; the marker is written
//   after every copy, and only then are the old files removed. A crash before
//   the marker leaves the old files authoritative and the next start copies
//   again over the partial new ones. A crash after it leaves the new files
//   authoritative; the next start removes old copies identical to the new
//   ones and leaves any that differ. The marker then records that the old
//   files are dealt with, and old files are never read, copied, removed or
//   overwritten again: if some reappear (an older version ran again), each
//   process warns once and leaves them.
// - A failed move leaves the process on the legacy layout and logs the error
//   class once; the next start tries again. Nothing here runs on a request.

import type { Dirent } from 'node:fs'
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  acquireRefreshFileLock,
  type RefreshFileLock,
  writeJsonAtomic,
} from '@cortexkit/common-auth/fs'
import { vaultPaths, vaultStateDir } from '@cortexkit/openai-auth-core/internal'
import { createLogger } from '../logger'
import {
  ACCOUNT_STATE_FILE_NAME,
  accountPathsCollide,
  chosenAccountStatePath,
  decidedRuntimeLayout,
  OPENCODE1_CODEX_SESSIONS_FILE,
  OPENCODE2_CODEX_SESSIONS_FILE,
  RUNTIME_CONFIG_DIR_NOTE_FILE,
  RUNTIME_LAYOUT_MARKER_FILE,
  type RuntimeLayout,
  type RuntimeLayoutLocation,
  runtimeLayoutLocation,
  setRuntimeLayout,
} from './account-paths'
import { recordProcessLayout } from './process-heartbeat'
import { migrationFenceOpen, type VersionFenceResult } from './version-fence'

export type { RuntimeLayout }

/** Name of the lock held while a process decides or moves the layout. */
export const RUNTIME_LAYOUT_LOCK_NAME = 'runtime-layout'
const LOCK_TTL_MS = 10_000
/**
 * The layout lock is held only for a decision or a copy of a few small files;
 * a crashed holder's lease ends after `LOCK_TTL_MS`. Longer than both.
 */
const LAYOUT_LOCK_WAIT_MS = 30_000
/** The store's own `save` wait, which the other data locks share. */
const DATA_LOCK_WAIT_MS = 15_000
const LOCK_RETRY_MS = 50
// The same budget common-auth's `replaceWindowsFile` gives a rename that
// Windows refuses because another process has the file open.
const SHARING_RETRY_DELAYS_MS = [0, 10, 20, 40, 80, 100]
const SHARING_RETRY_BUDGET_MS = 500

/** The message logged once by a process that keeps the legacy layout. */
export const RUNTIME_LAYOUT_DEFERRED_MESSAGE =
  "openai-auth keeps its files in OpenCode's config folder until every running OpenCode using it has restarted on this version."

export interface RuntimeLayoutLogger {
  info(message: string, meta?: Record<string, unknown>): unknown
  warn(message: string, meta?: Record<string, unknown>): unknown
}

export interface RuntimeLayoutOptions {
  /** This build's version, for the version fence. */
  version: string
  log?: RuntimeLayoutLogger
  /** Defaults to `migrationFenceOpen` for `version` and the config folder. */
  fence?: (layoutKey: string) => Promise<VersionFenceResult>
  /**
   * Test seams, run at one step of the move. A step that throws stands in for
   * a crash there: nothing after it runs.
   */
  steps?: {
    afterCopy?: () => void | Promise<void>
    afterMarker?: () => void | Promise<void>
  }
  /** Test seam: how long to wait for the layout lock. */
  layoutLockWaitMs?: number
}

interface LayoutMarker {
  version: 1
  /** The config folder the files came from. */
  oldDir: string
  /** Set once the old files were removed or knowingly left in place. */
  oldFilesRemoved?: boolean
}

/** One runtime file and where it lives in each layout. */
interface LayoutFile {
  old: string
  next: string
}

/** The runtime files of one config folder, in both layouts. */
interface LayoutFiles {
  /** Undefined when a chosen state path is the old default state file. */
  state?: LayoutFile
  /** Undefined when a chosen state path keeps its vault in the old folder. */
  vault?: { old: string; next: string }
  sessions: LayoutFile[]
}

// Per-process bookkeeping, on the global object because OpenCode 2 may load
// more than one copy of this bundle into one process.
const stateKey = Symbol.for('@cortexkit/openai-auth/runtime-layout-runs')
const globalState = globalThis as typeof globalThis & {
  [stateKey]?: {
    runs: Map<string, Promise<RuntimeLayout>>
    logged: Set<string>
  }
}
const processState = globalState[stateKey] ?? {
  runs: new Map<string, Promise<RuntimeLayout>>(),
  logged: new Set<string>(),
}
globalState[stateKey] = processState

/** Test seam: forget this process's runs and one-time log lines. */
export function __resetRuntimeLayoutRunsForTest(): void {
  processState.runs.clear()
  processState.logged.clear()
}

function logOnce(key: string, write: () => void): void {
  if (processState.logged.has(key)) return
  processState.logged.add(key)
  write()
}

function errorClass(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && code) return code
  return error instanceof Error ? error.name : typeof error
}

class LayoutMoveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'LayoutMoveError'
  }
}

/**
 * Decide, once per process, where this config folder's runtime files live,
 * moving them first when that is safe. Call at plugin start before anything
 * resolves a runtime path. Resolves to the layout the resolver in
 * `account-paths.ts` now uses; it rejects only when another live process holds
 * the layout lock for longer than any move takes and no marker exists.
 */
export function prepareRuntimeLayout(
  options: RuntimeLayoutOptions,
): Promise<RuntimeLayout> {
  const location = runtimeLayoutLocation()
  const decided = decidedRuntimeLayout(location)
  if (decided) return Promise.resolve(decided)
  const runKey = `${location.stateHomeDir}\0${location.key}`
  let run = processState.runs.get(runKey)
  if (!run) {
    run = decide(location, options).finally(() => {
      processState.runs.delete(runKey)
    })
    processState.runs.set(runKey, run)
  }
  return run
}

async function decide(
  location: RuntimeLayoutLocation,
  options: RuntimeLayoutOptions,
): Promise<RuntimeLayout> {
  const log = options.log ?? createLogger('runtime-layout')
  const markerPath = join(location.stateHomeDir, RUNTIME_LAYOUT_MARKER_FILE)
  const files = await layoutFiles(location)

  const settle = async (layout: RuntimeLayout): Promise<RuntimeLayout> => {
    if (layout === 'legacy') {
      try {
        await recordProcessLayout({
          key: location.key,
          layout,
          version: options.version,
        })
      } catch (error) {
        logOnce(`${location.key}\0record`, () =>
          log.warn(
            'could not record that this process uses the legacy file layout',
            { configDir: location.configDir, errorClass: errorClass(error) },
          ),
        )
      }
    } else {
      await recordProcessLayout({
        key: location.key,
        layout,
        version: options.version,
      })
    }
    setRuntimeLayout(location, layout)
    return layout
  }

  // A finished move needs no lock: the marker never goes away again.
  const early = await readMarker(markerPath)
  if (early?.oldFilesRemoved) {
    await warnIfOldFilesReappeared(location, files, log)
    return settle('state-home')
  }

  let layoutLock: RefreshFileLock
  try {
    await ensureOwnerOnlyDir(location.stateHomeDir)
    layoutLock = await takeLock(
      RUNTIME_LAYOUT_LOCK_NAME,
      markerPath,
      options.layoutLockWaitMs ?? LAYOUT_LOCK_WAIT_MS,
    )
  } catch (error) {
    if (await readMarker(markerPath)) return settle('state-home')
    if (error instanceof LayoutMoveError && error.code === 'lock-timeout')
      throw new Error(
        `openai-auth could not decide where its runtime files live: another process has held ${RUNTIME_LAYOUT_LOCK_NAME} at ${markerPath} for too long. Restart OpenCode.`,
      )
    // The state home cannot be written at all, so no other process can move
    // the files there either.
    logOnce(`${location.key}\0failed`, () =>
      log.warn(
        "openai-auth's runtime files stay in OpenCode's config folder: the state folder is not usable; the move is tried again at the next start",
        { configDir: location.configDir, errorClass: errorClass(error) },
      ),
    )
    return settle('legacy')
  }

  try {
    const marker = await readMarker(markerPath)
    if (marker) {
      if (!marker.oldFilesRemoved)
        await finishOldFiles(location, files, markerPath, marker, options, log)
      return await settle('state-home')
    }

    const fence = options.fence ?? defaultFence(options.version)
    const gate = await fence(location.key)
    if (!gate.open) {
      logDeferral(location, gate.blockers, log)
      return await settle('legacy')
    }

    let markerWritten = false
    try {
      const outcome = await moveFiles(
        location,
        files,
        markerPath,
        fence,
        options,
        log,
        () => {
          markerWritten = true
        },
      )
      if (outcome.deferred) {
        logDeferral(location, outcome.blockers, log)
        return await settle('legacy')
      }
      if (outcome.moved)
        log.info(
          "openai-auth moved its runtime files out of OpenCode's config folder",
          {
            from: location.configDir,
            to: location.stateHomeDir,
          },
        )
      return await settle('state-home')
    } catch (error) {
      // Past the marker the new folder holds every file; whatever failed
      // after it is finished at the next start.
      if (markerWritten) return await settle('state-home')
      logOnce(`${location.key}\0failed`, () =>
        log.warn(
          "openai-auth's runtime files stay in OpenCode's config folder: moving them failed; the move is tried again at the next start",
          { configDir: location.configDir, errorClass: errorClass(error) },
        ),
      )
      return await settle('legacy')
    }
  } finally {
    await layoutLock.release().catch(() => {})
  }
}

function defaultFence(version: string) {
  return (layoutKey: string) =>
    migrationFenceOpen({ currentVersion: version, layoutKey })
}

function logDeferral(
  location: RuntimeLayoutLocation,
  blockers: unknown,
  log: RuntimeLayoutLogger,
): void {
  logOnce(`${location.key}\0deferred`, () =>
    log.info(RUNTIME_LAYOUT_DEFERRED_MESSAGE, {
      configDir: location.configDir,
      blockers,
    }),
  )
}

/**
 * Copy every old file, then write the marker, then remove the old files.
 * `deferred` when a process that could still write the old files showed up
 * since the first check.
 */
async function moveFiles(
  location: RuntimeLayoutLocation,
  files: LayoutFiles,
  markerPath: string,
  fence: (layoutKey: string) => Promise<VersionFenceResult>,
  options: RuntimeLayoutOptions,
  log: RuntimeLayoutLogger,
  onMarker: () => void,
): Promise<
  { deferred: true; blockers: unknown } | { deferred: false; moved: boolean }
> {
  const locks: RefreshFileLock[] = []
  let oldVaultEmptied = false
  try {
    if (files.state && (await exists(files.state.old)))
      locks.push(await takeLock('save', files.state.old, DATA_LOCK_WAIT_MS))
    if (files.vault && (await exists(files.vault.old)))
      locks.push(
        await takeLock(
          'claustrum-roster-write',
          vaultPaths(files.vault.old, 'opencode').rosterPath,
          DATA_LOCK_WAIT_MS,
        ),
      )
    for (const sessions of files.sessions)
      if (await exists(sessions.old))
        locks.push(await takeLock('sessions', sessions.old, DATA_LOCK_WAIT_MS))

    // Heartbeats read again under every lock, right before the copy: a
    // process that started since the first check and kept the legacy layout
    // has recorded it by now.
    const gate = await fence(location.key)
    if (!gate.open) return { deferred: true, blockers: gate.blockers }

    const present = await presentOldFiles(files)
    await removeUnmarkedNewFiles(files, present)
    for (const file of present) await copyVerified(file)
    await options.steps?.afterCopy?.()

    for (const lock of locks) await lock.assertOwned()
    if (!location.isDefaultConfigDir)
      await writePrivateText(
        join(location.stateHomeDir, RUNTIME_CONFIG_DIR_NOTE_FILE),
        `${JSON.stringify({ configDir: location.configDir }, null, 2)}\n`,
      )
    const marker: LayoutMarker = { version: 1, oldDir: location.configDir }
    await writeMarker(markerPath, marker)
    onMarker()
    await options.steps?.afterMarker?.()

    await removeOldCopies(location, present, log)
    oldVaultEmptied = true
    await writeMarker(markerPath, { ...marker, oldFilesRemoved: true })
    return { deferred: false, moved: present.length > 0 }
  } finally {
    for (const lock of locks.reverse()) await lock.release().catch(() => {})
    // The roster lock is released now, so the emptied old vault folder can
    // go; rmdir leaves a folder that still holds anything.
    if (oldVaultEmptied && files.vault)
      await rmdir(files.vault.old).catch(() => {})
  }
}

/**
 * A start after a crash that came after the marker: remove the old copies
 * that are identical to the new files, keep the rest, and record that the
 * old files are dealt with. Waits, like the move, while a process that could
 * still use the old files is alive.
 */
async function finishOldFiles(
  location: RuntimeLayoutLocation,
  files: LayoutFiles,
  markerPath: string,
  marker: LayoutMarker,
  options: RuntimeLayoutOptions,
  log: RuntimeLayoutLogger,
): Promise<void> {
  try {
    const fence = options.fence ?? defaultFence(options.version)
    const gate = await fence(location.key)
    if (!gate.open) return
    await removeOldCopies(location, await presentOldFiles(files), log)
    if (files.vault) await rmdir(files.vault.old).catch(() => {})
    await writeMarker(markerPath, { ...marker, oldFilesRemoved: true })
  } catch (error) {
    logOnce(`${location.key}\0cleanup`, () =>
      log.warn(
        "openai-auth could not finish removing its old files from OpenCode's config folder; it tries again at the next start",
        { configDir: location.configDir, errorClass: errorClass(error) },
      ),
    )
  }
}

async function layoutFiles(
  location: RuntimeLayoutLocation,
): Promise<LayoutFiles> {
  const oldState = join(location.configDir, ACCOUNT_STATE_FILE_NAME)
  const nextState = join(location.stateHomeDir, ACCOUNT_STATE_FILE_NAME)
  // A state file the user chose is never moved: when it is the old default
  // file itself, or keeps its vault in the old vault folder, that part stays.
  const chosen = chosenAccountStatePath()
  const keepState =
    chosen !== undefined && accountPathsCollide(chosen, oldState)
  const keepVault =
    chosen !== undefined &&
    accountPathsCollide(vaultStateDir(chosen), vaultStateDir(oldState))
  return {
    ...(keepState ? {} : { state: { old: oldState, next: nextState } }),
    ...(keepVault
      ? {}
      : {
          vault: {
            old: vaultStateDir(oldState),
            next: vaultStateDir(nextState),
          },
        }),
    sessions: [
      OPENCODE1_CODEX_SESSIONS_FILE,
      OPENCODE2_CODEX_SESSIONS_FILE,
    ].map((name) => ({
      old: join(location.configDir, name),
      next: join(location.stateHomeDir, name),
    })),
  }
}

/** Lock files, eviction markers and staged writes come and go with a writer. */
function isTransient(name: string): boolean {
  return name.includes('.lock') || name.endsWith('.tmp')
}

/** The regular, non-transient files directly in a folder. */
async function folderFiles(dir: string): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return entries
    .filter((entry) => entry.isFile() && !isTransient(entry.name))
    .map((entry) => entry.name)
    .sort()
}

/** Every runtime file that exists in the old layout, paired with its target. */
async function presentOldFiles(files: LayoutFiles): Promise<LayoutFile[]> {
  const present: LayoutFile[] = []
  if (files.state && (await exists(files.state.old))) present.push(files.state)
  if (files.vault) {
    const vault = files.vault
    for (const name of await folderFiles(vault.old))
      present.push({ old: join(vault.old, name), next: join(vault.next, name) })
  }
  for (const sessions of files.sessions)
    if (await exists(sessions.old)) present.push(sessions)
  return present
}

/**
 * Before the marker nothing uses the state-home folder, so a runtime file
 * there that has no old counterpart is left from an interrupted move whose
 * source has since gone. Remove it, or the marker would make it authoritative.
 */
async function removeUnmarkedNewFiles(
  files: LayoutFiles,
  present: LayoutFile[],
): Promise<void> {
  const wanted = new Set(present.map((file) => file.next))
  const candidates = files.sessions.map((file) => file.next)
  if (files.state) candidates.push(files.state.next)
  if (files.vault) {
    const vaultDir = files.vault.next
    for (const name of await folderFiles(vaultDir))
      candidates.push(join(vaultDir, name))
  }
  for (const path of candidates)
    if (!wanted.has(path))
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
}

async function copyVerified(file: LayoutFile): Promise<void> {
  const bytes = await readFile(file.old)
  const text = bytes.toString('utf8')
  // The private writer takes text; a file that is not valid UTF-8 would not
  // survive the round trip, so it is not copied at all.
  if (!Buffer.from(text, 'utf8').equals(bytes))
    throw new LayoutMoveError('not-utf8', `${file.old} is not UTF-8 text`)
  await writePrivateText(file.next, text)
  if (!(await readFile(file.next)).equals(bytes))
    throw new LayoutMoveError(
      'copy-mismatch',
      `${file.next} does not match ${file.old}`,
    )
}

/**
 * Remove each old file whose bytes equal its new copy. One that differs, or
 * that Windows will not let go of, stays where it is.
 */
async function removeOldCopies(
  location: RuntimeLayoutLocation,
  present: LayoutFile[],
  log: RuntimeLayoutLogger,
): Promise<void> {
  const kept: string[] = []
  for (const file of present) {
    if (!(await exists(file.old))) continue
    let same = false
    try {
      same = (await readFile(file.old)).equals(await readFile(file.next))
    } catch {
      // Unreadable on either side: not provably a copy, so it stays.
    }
    if (!same || !(await unlinkWithSharingRetry(file.old))) kept.push(file.old)
  }
  if (kept.length > 0)
    log.warn(
      "openai-auth left old files in OpenCode's config folder; it no longer reads them",
      { configDir: location.configDir, kept },
    )
}

async function warnIfOldFilesReappeared(
  location: RuntimeLayoutLocation,
  files: LayoutFiles,
  log: RuntimeLayoutLogger,
): Promise<void> {
  const found: string[] = []
  try {
    for (const file of [
      ...(files.state ? [files.state] : []),
      ...files.sessions,
    ])
      if (await exists(file.old)) found.push(file.old)
    if (files.vault && (await folderFiles(files.vault.old)).length > 0)
      found.push(files.vault.old)
  } catch {
    // Only a warning depends on this; an unreadable folder warns nothing.
  }
  if (found.length === 0) return
  logOnce(`${location.key}\0reappeared`, () =>
    log.warn(
      "openai-auth found runtime files in OpenCode's config folder again (an older version may have run). It does not use them and leaves them in place; its files are in the state folder",
      { configDir: location.configDir, stateDir: location.stateHomeDir, found },
    ),
  )
}

async function readMarker(path: string): Promise<LayoutMarker | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    // It exists, which is what makes the folder authoritative (the
    // resolver's own check is existence alone); see below.
    return { version: 1, oldDir: '', oldFilesRemoved: true }
  }
  try {
    const value = JSON.parse(text) as Partial<LayoutMarker> | null
    if (value && typeof value === 'object' && typeof value.oldDir === 'string')
      return {
        version: 1,
        oldDir: value.oldDir,
        ...(value.oldFilesRemoved === true ? { oldFilesRemoved: true } : {}),
      }
  } catch {}
  // A marker that cannot be parsed still makes the folder authoritative, and
  // nothing can tell whether the old files were dealt with: leave them alone.
  return { version: 1, oldDir: '', oldFilesRemoved: true }
}

async function writeMarker(path: string, marker: LayoutMarker): Promise<void> {
  await writePrivateText(path, `${JSON.stringify(marker, null, 2)}\n`)
}

/**
 * Owner-only, durable write through common-auth's atomic writer: mode 0600,
 * the file and then its folder synced on POSIX; the private-files ACL and a
 * file flush on Windows, where folder sync is not available.
 */
async function writePrivateText(path: string, text: string): Promise<void> {
  await ensureOwnerOnlyDir(dirname(path))
  await writeJsonAtomic(path, null, {
    serialize: () => text,
    durable: true,
    durability: 'file-only-on-windows',
  })
}

/**
 * On POSIX, create the folder as 0700 and tighten it if it exists (as the
 * heartbeat folder does). On Windows the private-files writer and the lock
 * create every missing folder with an owner-only ACL themselves.
 */
async function ensureOwnerOnlyDir(path: string): Promise<void> {
  if (process.platform === 'win32') return
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

async function takeLock(
  name: string,
  path: string,
  waitMs: number,
): Promise<RefreshFileLock> {
  const started = performance.now()
  for (;;) {
    const lock = await acquireRefreshFileLock({
      name,
      path,
      ttlMs: LOCK_TTL_MS,
      renew: true,
    })
    if (lock) return lock
    if (performance.now() - started >= waitMs)
      throw new LayoutMoveError('lock-timeout', `${name} lock at ${path}`)
    await new Promise((done) => setTimeout(done, LOCK_RETRY_MS))
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Unlink, retrying on Windows while another process has the file open. False
 * when the file is still there afterwards.
 */
async function unlinkWithSharingRetry(path: string): Promise<boolean> {
  const started = performance.now()
  for (const delay of SHARING_RETRY_DELAYS_MS) {
    if (delay > 0) await new Promise((done) => setTimeout(done, delay))
    try {
      await unlink(path)
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return true
      const sharing =
        process.platform === 'win32' &&
        (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES')
      if (!sharing || performance.now() - started >= SHARING_RETRY_BUDGET_MS)
        return false
    }
  }
  return false
}

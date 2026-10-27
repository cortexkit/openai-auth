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
//   `config-dir.json` names the config folder the state-home folder belongs
//   to; a folder that names another one is refused and left alone.
// - Only a process that resolves every runtime file at its default location
//   moves files or writes the marker. A process with OPENCODE_OPENAI_AUTH_FILE
//   naming a custom file or with OPENCODE_OPENAI_AUTH_STATE_FILE set follows
//   an existing marker for the files it does not override, and otherwise
//   stays on the legacy layout. If an override names a file of the state-home
//   folder, it stays on the legacy layout and that file is never touched.
// - The move, and the fresh install's marker, wait while any other live
//   process could still write the old files: one that runs an older version,
//   or one on the legacy layout (its heartbeat says so, `process-heartbeat.ts`).
//   A process that starts while one of those is alive takes the legacy layout
//   too. So the move happens at the first start after every OpenCode using
//   that config folder has been closed or restarted on this version.
// - Every decision is made holding the layout lock in the state-home folder.
//   A legacy choice is allowed only once it is in this process's heartbeat,
//   written while that lock is held, so a process deciding later sees it. A
//   process that cannot take the lock or write that record refuses to start
//   (`RuntimeLayoutRefusal`) rather than run unseen on the old files.
// - The move holds the layout lock, then the store's `save` lock at the old
//   state file, the vault's `claustrum-roster-write` lock at the old roster
//   and the `sessions` lock at each old sessions file (the order of the lock
//   list in `pool-migration.ts`). Under all of them it reads the heartbeats
//   again, refuses when an old file and its new place are one physical file,
//   and refuses when the state-home folder holds a runtime file that is not
//   one of the copies an unfinished move listed in `layout-moving.json`. Each file is copied owner-only and made durable,
//   read back and compared byte for byte; the marker is written after every
//   copy, and only then are the old files removed, each one after comparing
//   its bytes once more. A crash before the marker leaves the old files
//   authoritative and the next start copies again over the partial new ones.
//   A crash after it leaves the new files authoritative; the next start takes
//   the same locks and removes old copies identical to the new ones. Differing
//   credentials refuse the start: the old copy may hold the only live refresh
//   token. Differing sessions stay. An identical old credential that cannot
//   be removed (Windows may hold a file open), or that Windows keeps open so
//   it cannot be compared, is logged once as a cleanup
//   failure; the marker then does not record the old files as dealt with, so
//   the next start tries the removal again. Once the marker records that the
//   old files are dealt with, reappeared credentials refuse the start, while
//   each process warns once about reappeared sessions and leaves them alone.
// - A vault enrollment that is approved keeps one old file: the enrollment
//   state file stays in the old vault folder, byte for byte the copy that
//   moved, and only the old token is removed. Every version reads an approved
//   state without a token as vault mode with a missing token, never as local,
//   so an older version that still looks in the config folder refuses instead
//   of serving local credentials. The marker records that file's SHA-256.
//   Later starts accept those bytes there, and also any state an older
//   version rewrote it to that common-auth still reads as vault mode without
//   a token (approved, or blocked for the missing token) under this host's
//   enrollment name, as long as no token file is in the old vault folder: an
//   older version's `reconcile()` rewrites an approved state without a token
//   to blocked, and that file holds no secret. Anything else at that path is a
//   conflict like any other reappeared credential. Disconnect on this version
//   removes it (`removeMovedVaultStateLeftover`).
// - The layout lock is checked again before every destructive step, the
//   removal of the move's `layout-moving.json` and of the old vault folder
//   included; `layout-moving.json` is the last thing removed. A move
//   that fails leaves the process on the legacy layout (registered) and logs
//   the error class once; the next start tries again. Nothing here runs on a
//   request.

import { createHash } from 'node:crypto'
import { type Dirent, realpathSync } from 'node:fs'
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'
import {
  type ClaustrumEnrollmentPaths,
  readClaustrumEnrollmentStatus,
} from '@cortexkit/common-auth/claustrum'
import {
  acquireRefreshFileLock,
  type RefreshFileLock,
  writeJsonAtomic,
} from '@cortexkit/common-auth/fs'
import {
  vaultEnrollmentName,
  vaultPaths,
  vaultStateDir,
} from '@cortexkit/openai-auth-core/internal'
import { CODEX_SESSIONS_LOCK_NAME } from '../codex-sessions'
import { createLogger } from '../logger'
import {
  ACCOUNT_STATE_FILE_NAME,
  accountPathsCollide,
  chosenAccountStatePath,
  customAccountConfigPath,
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
/** Lists the copies an unfinished move has put in the state-home folder. */
export const RUNTIME_LAYOUT_MANIFEST_FILE = 'layout-moving.json'
const LOCK_TTL_MS = 10_000
/** The store's own `save` wait, which the other data locks share. */
const DATA_LOCK_WAIT_MS = 15_000
/**
 * How long a starting process waits for the layout lock: 70 seconds. A move
 * may wait `DATA_LOCK_WAIT_MS` (15 s) for each of its four data locks, and a
 * crashed holder's lease ends after `LOCK_TTL_MS` (10 s); 4 × 15 s + 10 s.
 */
const LAYOUT_LOCK_WAIT_MS = 4 * DATA_LOCK_WAIT_MS + LOCK_TTL_MS
const LOCK_RETRY_MS = 50
/** A marker read that fails for a reason other than absence is retried. */
const MARKER_READ_ATTEMPTS = 5
const MARKER_READ_RETRY_MS = 50
// The same budget common-auth's `replaceWindowsFile` gives a rename that
// Windows refuses because another process has the file open.
const SHARING_RETRY_DELAYS_MS = [0, 10, 20, 40, 80, 100]
const SHARING_RETRY_BUDGET_MS = 500

/** The message logged once by a process that keeps the legacy layout. */
export const RUNTIME_LAYOUT_DEFERRED_MESSAGE =
  "openai-auth keeps its files in OpenCode's config folder until every running OpenCode using it has restarted on this version."

/** Logged, and shown once in `/openai`, when old session files appear again. */
export const RUNTIME_LAYOUT_REAPPEARED_MESSAGE =
  "openai-auth found runtime files in OpenCode's config folder again (an older version may have run). It does not use them and leaves them in place; its files are in its state folder."

/**
 * Plugin start stops when it cannot settle a safe runtime layout: it could
 * not take the layout lock or write its heartbeat (so other processes could
 * not see which files it uses), could not trust the marker, found conflicting
 * credentials, or found a state-home folder owned by another config folder.
 */
export class RuntimeLayoutRefusal extends Error {
  constructor(
    readonly stateDir: string,
    readonly errorClass: string,
    message = refusalMessage(stateDir, errorClass),
  ) {
    super(message)
    this.name = 'RuntimeLayoutRefusal'
  }
}

function refusalMessage(stateDir: string, errorClass: string): string {
  // The private-files check refused the folder itself: it is a link, or
  // others can reach it. Creating or writing it is not the problem.
  if (errorClass === 'ERR_PRIVATE_FILES_SECURITY')
    return `openai-auth cannot start: ${stateDir} is not a folder only your user can access, or it is a link, so the plugin will not use it (${errorClass}). Replace it with a plain folder of your own, then restart OpenCode.`
  return `openai-auth cannot start: it could not settle where its runtime files live in ${stateDir} (${errorClass}). Check that this folder can be created and written by your user, then restart OpenCode.`
}

function foreignFolder(stateDir: string, identity: string) {
  return new RuntimeLayoutRefusal(
    stateDir,
    'foreign-folder',
    `openai-auth cannot start: ${stateDir} belongs to another OpenCode config folder, not ${identity}. It was left untouched. Move it aside, then restart OpenCode.`,
  )
}

function credentialConflict(stateDir: string, file: LayoutFile) {
  return new RuntimeLayoutRefusal(
    stateDir,
    'credential-conflict',
    `openai-auth cannot start: runtime credentials conflict between ${file.old} and ${file.next}. Keep the newer one, delete the other, then restart OpenCode.`,
  )
}

export interface RuntimeLayoutLogger {
  info(message: string, meta?: Record<string, unknown>): unknown
  warn(message: string, meta?: Record<string, unknown>): unknown
}

export interface RuntimeLayoutOptions {
  /** This build's version, for the version fence. */
  version: string
  log?: RuntimeLayoutLogger
  /** Defaults to `migrationFenceOpen` for `version`, with the layout checks. */
  fence?: () => Promise<VersionFenceResult>
  /**
   * Test seams, run at one step of the move. A step that throws stands in for
   * a crash there: nothing after it runs.
   */
  steps?: {
    afterCopy?: () => void | Promise<void>
    afterMarker?: () => void | Promise<void>
    /**
     * Runs right before each removal of an old file, of the move's
     * `layout-moving.json` and of the old vault folder, ahead of the lease
     * check that guards it.
     */
    beforeRemove?: (path: string) => void | Promise<void>
  }
  /** Test seam: how long to wait for the layout lock. */
  layoutLockWaitMs?: number
}

interface LayoutMarker {
  version: 1
  /** The identity of the config folder the files came from. */
  oldDir?: string
  /** Set once the old files were removed or knowingly left in place. */
  oldFilesRemoved?: boolean
  /**
   * SHA-256 (hex) of the approved enrollment state file the move leaves in
   * the old vault folder; absent when the move left none there.
   */
  keptVaultState?: string
}

/** One runtime file and where it lives in each layout. */
interface LayoutFile {
  old: string
  next: string
}

/** The runtime files of one config folder, in both layouts. */
interface LayoutFiles {
  state: LayoutFile
  vault: { old: string; next: string }
  sessions: LayoutFile[]
}

// Per-process bookkeeping, on the global object because OpenCode 2 may load
// more than one copy of this bundle into one process.
const stateKey = Symbol.for('@cortexkit/openai-auth/runtime-layout-runs')
const globalState = globalThis as typeof globalThis & {
  [stateKey]?: {
    runs: Map<string, Promise<RuntimeLayout>>
    logged: Set<string>
    notice?: { text: string; shown: boolean }
  }
}
const processState = globalState[stateKey] ?? {
  runs: new Map<string, Promise<RuntimeLayout>>(),
  logged: new Set<string>(),
}
globalState[stateKey] = processState

/** Test seam: forget this process's runs, log lines and notice. */
export function __resetRuntimeLayoutRunsForTest(): void {
  processState.runs.clear()
  processState.logged.clear()
  processState.notice = undefined
}

/**
 * The status line `/openai` shows once per process when old runtime files
 * appeared again in OpenCode's config folder; undefined after that, and when
 * there is nothing to report.
 */
export function takeRuntimeLayoutNotice(): string | undefined {
  const notice = processState.notice
  if (!notice || notice.shown) return undefined
  notice.shown = true
  return notice.text
}

function logOnce(key: string, write: () => void): void {
  if (processState.logged.has(key)) return
  processState.logged.add(key)
  write()
}

function errorClass(error: unknown): string {
  if (error instanceof RuntimeLayoutRefusal) return error.errorClass
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && code) return code
  return error instanceof Error ? error.name : typeof error
}

/**
 * The name of the file an error is about, without its folder, and the
 * private-file stage when there is one, for a log line.
 */
function errorFile(error: unknown): { file?: string; stage?: string } {
  const { path, stage } = (error ?? {}) as { path?: unknown; stage?: unknown }
  return {
    ...(typeof path === 'string' && path ? { file: basename(path) } : {}),
    ...(typeof stage === 'string' && stage ? { stage } : {}),
  }
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
 * An old credential file identical to its new copy that could not be
 * removed. Not a refusal: the start goes on in the state home, and the marker
 * is left without `oldFilesRemoved` so the next start removes it.
 */
class OldCredentialKeptError extends LayoutMoveError {
  constructor(readonly path: string) {
    super('old-credential-kept', `${path} could not be removed`)
  }
}

/** The one warning for old files a move or a later start failed to remove. */
function logCleanupFailure(
  location: RuntimeLayoutLocation,
  log: RuntimeLayoutLogger,
  step: string,
  error: unknown,
): void {
  logOnce(`${location.key}\0cleanup`, () =>
    log.warn(
      "openai-auth could not finish removing its old files from OpenCode's config folder; it tries again at the next start",
      {
        configDir: location.configDir,
        step,
        errorClass: errorClass(error),
        ...errorFile(error),
      },
    ),
  )
}

/**
 * Decide, once per process, where this config folder's runtime files live,
 * moving them first when that is safe. Call at plugin start before anything
 * resolves a runtime path. Resolves to the layout the resolver in
 * `account-paths.ts` now uses; rejects with `RuntimeLayoutRefusal` when the
 * plugin must not start.
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
    run = decide(location, options)
      .catch((error: unknown) => {
        // Anything not handled on the way stops the start the same way.
        if (error instanceof RuntimeLayoutRefusal) throw error
        throw new RuntimeLayoutRefusal(location.stateHomeDir, errorClass(error))
      })
      .finally(() => {
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
  const stateDir = location.stateHomeDir
  const markerPath = join(stateDir, RUNTIME_LAYOUT_MARKER_FILE)
  const files = layoutFiles(location)
  const overrides = overridePaths()
  const overriding = overrides.length > 0
  const overrideInDestination = overrides.some((path) =>
    insideOrSame(path, stateDir),
  )
  const fence = options.fence ?? defaultFence(options.version)

  const stateHome = async (): Promise<RuntimeLayout> => {
    await recordProcessLayout({
      key: location.key,
      layout: 'state-home',
      version: options.version,
    })
    setRuntimeLayout(location, 'state-home')
    return 'state-home'
  }

  // Read-only first: whose folder this is, and whether the move is done.
  let marker = await readMarker(markerPath, stateDir)
  await assertOwnFolder(location, marker)
  if (marker?.oldFilesRemoved && !overrideInDestination) {
    await noticeReappearedFiles(location, files, overrides, marker, log)
    // A move that stopped right after its last marker write left its
    // `layout-moving.json`; it is removed below, under the layout lock.
    const manifestLeft = await exists(
      join(stateDir, RUNTIME_LAYOUT_MANIFEST_FILE),
    ).catch(() => true)
    if (!manifestLeft) return stateHome()
  }

  // A state-home folder that is OpenCode's config folder itself (a link or a
  // mount) gets no chmod or note of its own; the move then stays legacy.
  const aliased = await samePhysical(location.configDir, stateDir)
  let layoutLock: RefreshFileLock
  try {
    if (!aliased) await ensureOwnerOnlyDir(stateDir)
    layoutLock = await takeLock(
      RUNTIME_LAYOUT_LOCK_NAME,
      markerPath,
      options.layoutLockWaitMs ?? LAYOUT_LOCK_WAIT_MS,
    )
  } catch (error) {
    // Only an existing marker settles the layout without the lock.
    marker = await readMarker(markerPath, stateDir)
    if (marker && !overrideInDestination) return stateHome()
    throw new RuntimeLayoutRefusal(stateDir, errorClass(error))
  }

  const lock = layoutLock
  const legacy = async (): Promise<RuntimeLayout> => {
    try {
      await lock.assertOwned()
      await recordProcessLayout({
        key: location.key,
        layout: 'legacy',
        version: options.version,
      })
    } catch (error) {
      throw new RuntimeLayoutRefusal(stateDir, errorClass(error))
    }
    setRuntimeLayout(location, 'legacy')
    return 'legacy'
  }

  try {
    marker = await readMarker(markerPath, stateDir)
    await assertOwnFolder(location, marker)
    if (!aliased) await writeOwnerNote(location)

    if (overrideInDestination) {
      logOnce(`${location.key}\0override`, () =>
        log.warn(
          "openai-auth keeps its runtime files in OpenCode's config folder: a path set by OPENCODE_OPENAI_AUTH_STATE_FILE or OPENCODE_OPENAI_AUTH_FILE is inside its state folder, which it never touches",
          { stateDir, overrides },
        ),
      )
      return await legacy()
    }
    if (marker) {
      if (!marker.oldFilesRemoved && !overriding && !aliased)
        await finishOldFiles(location, files, markerPath, marker, lock, {
          fence,
          log,
          steps: options.steps,
        })
      else if (marker.oldFilesRemoved)
        await removeLeftoverManifest(location, lock, options.steps, log)
      return await stateHome()
    }
    // Only a process that resolves every runtime file at its default place
    // moves them; with an override it follows a marker or stays legacy.
    if (overriding) return await legacy()
    if (aliased) {
      logOnce(`${location.key}\0aliased`, () =>
        log.warn(
          "openai-auth keeps its runtime files in OpenCode's config folder: its state folder is that same folder",
          { configDir: location.configDir, stateDir },
        ),
      )
      return await legacy()
    }
    const gate = await fence()
    if (!gate.open) {
      logDeferral(location, gate.blockers, log)
      return await legacy()
    }

    let markerStarted = false
    try {
      const outcome = await moveFiles(location, files, markerPath, lock, {
        fence,
        log,
        steps: options.steps,
        onMarker: () => {
          markerStarted = true
        },
      })
      if (outcome.kind === 'deferred') {
        logDeferral(location, outcome.blockers, log)
        return await legacy()
      }
      if (outcome.kind === 'refused') {
        logOnce(`${location.key}\0refused`, () =>
          log.warn(
            "openai-auth keeps its runtime files in OpenCode's config folder: it will not move them",
            { reason: outcome.reason, paths: outcome.paths, stateDir },
          ),
        )
        return await legacy()
      }
      if (outcome.moved)
        log.info(
          "openai-auth moved its runtime files out of OpenCode's config folder",
          { from: location.configDir, to: stateDir },
        )
      return await stateHome()
    } catch (error) {
      if (error instanceof RuntimeLayoutRefusal) throw error
      // Once the marker write began, the marker on disk decides.
      if (markerStarted && (await readMarker(markerPath, stateDir)))
        return await stateHome()
      logOnce(`${location.key}\0failed`, () =>
        log.warn(
          "openai-auth's runtime files stay in OpenCode's config folder: moving them failed; the move is tried again at the next start",
          { configDir: location.configDir, errorClass: errorClass(error) },
        ),
      )
      return await legacy()
    }
  } finally {
    await lock.release().catch(() => {})
  }
}

function defaultFence(version: string) {
  return () => migrationFenceOpen({ currentVersion: version, layoutMove: true })
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

/** Every path an override in effect resolves to; empty without overrides. */
function overridePaths(): string[] {
  const state = chosenAccountStatePath()
  if (state === undefined) return []
  const config = customAccountConfigPath()
  return [state, vaultStateDir(state), ...(config ? [config] : [])]
}

/** True when `path` is `folder` itself or anything inside it. */
function insideOrSame(path: string, folder: string): boolean {
  const between = relative(realOrNearest(folder), realOrNearest(path))
  if (between === '') return true
  if (!between.startsWith('..') && !isAbsolute(between)) return true
  return accountPathsCollide(path, folder)
}

/**
 * The real path of `path`, or of its nearest existing ancestor with the rest
 * appended, so a path that does not exist yet compares with real ones.
 */
function realOrNearest(path: string): string {
  let current = resolve(path)
  const rest: string[] = []
  for (;;) {
    try {
      return join(realpathSync.native(current), ...rest)
    } catch {}
    const parent = dirname(current)
    if (parent === current) return resolve(path)
    rest.unshift(basename(current))
    current = parent
  }
}

type MoveOutcome =
  | { kind: 'deferred'; blockers: unknown }
  | { kind: 'refused'; reason: string; paths: string[] }
  | { kind: 'moved'; moved: boolean }

/**
 * Copy every old file, then write the marker, then remove the old files.
 * Holds the data locks throughout; the caller holds the layout lock.
 */
async function moveFiles(
  location: RuntimeLayoutLocation,
  files: LayoutFiles,
  markerPath: string,
  layoutLock: RefreshFileLock,
  input: {
    fence: () => Promise<VersionFenceResult>
    log: RuntimeLayoutLogger
    steps?: RuntimeLayoutOptions['steps']
    onMarker: () => void
  },
): Promise<MoveOutcome> {
  const stateDir = location.stateHomeDir
  const locks = await takeDataLocks(location, files)
  let oldVaultEmptied = false
  try {
    // Heartbeats read again under every lock, right before the copy: a
    // process that started since the first check and kept the legacy layout
    // has recorded it by now.
    const gate = await input.fence()
    if (!gate.open) return { kind: 'deferred', blockers: gate.blockers }

    const aliases = await physicalAliases(location, files)
    if (aliases.length > 0)
      return { kind: 'refused', reason: 'same-physical-file', paths: aliases }

    // A runtime file in the state-home folder that no unfinished move of ours
    // listed was put there by someone else (an override, by hand): leave it.
    const listed = await readManifest(stateDir)
    const foreign = (await destinationFiles(files)).filter(
      (path) => !listed.has(path),
    )
    if (foreign.length > 0)
      return { kind: 'refused', reason: 'destination-in-use', paths: foreign }

    const present = await presentOldFiles(files)
    await layoutLock.assertOwned()
    await writeManifest(stateDir, [
      ...new Set([...listed, ...present.map((file) => file.next)]),
    ])
    // Copies an earlier, interrupted move left whose source has since gone.
    const wanted = new Set(present.map((file) => file.next))
    for (const path of listed) {
      if (wanted.has(path)) continue
      await layoutLock.assertOwned()
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
    for (const file of present) {
      await layoutLock.assertOwned()
      await copyVerified(file)
    }
    await input.steps?.afterCopy?.()

    await layoutLock.assertOwned()
    for (const lock of locks) await lock.assertOwned()
    const keptVaultState = await keepableVaultState(files, present)
    const marker: LayoutMarker = {
      version: 1,
      oldDir: location.key,
      ...(keptVaultState ? { keptVaultState } : {}),
    }
    input.onMarker()
    await writeMarker(markerPath, marker)
    await input.steps?.afterMarker?.()

    await layoutLock.assertOwned()
    try {
      await removeOldCopies(location, present, layoutLock, {
        log: input.log,
        keptVaultState,
        steps: input.steps,
      })
    } catch (error) {
      if (!(error instanceof OldCredentialKeptError)) throw error
      // The copies are verified and the marker is written, so this process
      // runs on the new files; the marker stays without `oldFilesRemoved` and
      // the next start removes what is left.
      logCleanupFailure(location, input.log, 'remove-old-copies', error)
      return { kind: 'moved', moved: present.length > 0 }
    }
    oldVaultEmptied = true
    await layoutLock.assertOwned()
    await writeMarker(markerPath, { ...marker, oldFilesRemoved: true })
    await removeManifestOwned(stateDir, layoutLock, input.steps)
    return { kind: 'moved', moved: present.length > 0 }
  } finally {
    for (const lock of locks.reverse()) await lock.release().catch(() => {})
    // The roster lock is released now, so the emptied old vault folder can
    // go; rmdir leaves a folder that still holds anything.
    if (oldVaultEmptied)
      await removeOldVaultFolder(files, layoutLock, input.steps)
  }
}

/**
 * A start after a crash that came after the marker: under the same locks as
 * the move, remove identical old copies and refuse conflicting credentials.
 * Differing session files stay in place. Waits, like the move, while a process
 * that could still use the old files is alive.
 */
async function finishOldFiles(
  location: RuntimeLayoutLocation,
  files: LayoutFiles,
  markerPath: string,
  marker: LayoutMarker,
  layoutLock: RefreshFileLock,
  input: {
    fence: () => Promise<VersionFenceResult>
    log: RuntimeLayoutLogger
    steps?: RuntimeLayoutOptions['steps']
  },
): Promise<void> {
  let locks: RefreshFileLock[] = []
  let done = false
  // Which step failed, for the warning below.
  let step = 'fence'
  try {
    // Read first so a closed fence does not wait for the data locks, and
    // again under them, as the move does: a process that started meanwhile
    // and kept the legacy layout has recorded it by then.
    if (!(await input.fence()).open) return
    step = 'data-locks'
    locks = await takeDataLocks(location, files)
    step = 'fence'
    if (!(await input.fence()).open) return
    step = 'same-file-check'
    const aliases = await physicalAliases(location, files)
    if (aliases.length > 0) {
      logOnce(`${location.key}\0cleanup-aliased`, () =>
        input.log.warn(
          "openai-auth leaves its old files in OpenCode's config folder: they are the same files as its new ones",
          { paths: aliases },
        ),
      )
      return
    }
    step = 'remove-old-copies'
    await layoutLock.assertOwned()
    await removeOldCopies(location, await presentOldFiles(files), layoutLock, {
      log: input.log,
      keptVaultState: marker.keptVaultState,
      steps: input.steps,
    })
    done = true
    step = 'marker'
    await layoutLock.assertOwned()
    await writeMarker(markerPath, { ...marker, oldFilesRemoved: true })
    step = 'manifest'
    await removeManifestOwned(location.stateHomeDir, layoutLock, input.steps)
  } catch (error) {
    if (error instanceof RuntimeLayoutRefusal) throw error
    logCleanupFailure(location, input.log, step, error)
  } finally {
    for (const lock of locks.reverse()) await lock.release().catch(() => {})
    if (done) await removeOldVaultFolder(files, layoutLock, input.steps)
  }
}

/**
 * Remove the `layout-moving.json` a move left behind when it stopped after
 * marking its old files dealt with; the caller holds the layout lock. A
 * failure is logged and retried at the next start.
 */
async function removeLeftoverManifest(
  location: RuntimeLayoutLocation,
  layoutLock: RefreshFileLock,
  steps: RuntimeLayoutOptions['steps'],
  log: RuntimeLayoutLogger,
): Promise<void> {
  try {
    await removeManifestOwned(location.stateHomeDir, layoutLock, steps)
  } catch (error) {
    logOnce(`${location.key}\0manifest`, () =>
      log.warn(
        `openai-auth could not remove ${RUNTIME_LAYOUT_MANIFEST_FILE} from its state folder; it tries again at the next start`,
        { stateDir: location.stateHomeDir, errorClass: errorClass(error) },
      ),
    )
  }
}

/** Remove the move's manifest once the layout lock is confirmed still held. */
async function removeManifestOwned(
  stateDir: string,
  layoutLock: RefreshFileLock,
  steps: RuntimeLayoutOptions['steps'],
): Promise<void> {
  const path = join(stateDir, RUNTIME_LAYOUT_MANIFEST_FILE)
  if (!(await exists(path))) return
  await steps?.beforeRemove?.(path)
  await layoutLock.assertOwned()
  await removeManifest(stateDir)
}

/**
 * Remove the old vault folder if it is empty, once the layout lock is
 * confirmed still held. Best effort: rmdir leaves a folder that still holds
 * anything, such as the enrollment state file a vault-mode move keeps.
 */
async function removeOldVaultFolder(
  files: LayoutFiles,
  layoutLock: RefreshFileLock,
  steps: RuntimeLayoutOptions['steps'],
): Promise<void> {
  try {
    await steps?.beforeRemove?.(files.vault.old)
    await layoutLock.assertOwned()
    await rmdir(files.vault.old)
  } catch {}
}

/**
 * The move's data locks at the old paths, in the order of the lock list in
 * `pool-migration.ts`: `save` at the state file, `claustrum-roster-write` at
 * the vault roster, `sessions` at each sessions file. Taken whether or not
 * the file exists yet, so a writer about to create one waits too; nothing is
 * created in a config folder or vault folder that does not exist.
 */
async function takeDataLocks(
  location: RuntimeLayoutLocation,
  files: LayoutFiles,
): Promise<RefreshFileLock[]> {
  const locks: RefreshFileLock[] = []
  try {
    if (await exists(location.configDir)) {
      locks.push(await takeLock('save', files.state.old, DATA_LOCK_WAIT_MS))
      if (await exists(files.vault.old))
        locks.push(
          await takeLock(
            'claustrum-roster-write',
            vaultPaths(files.vault.old, 'opencode').rosterPath,
            DATA_LOCK_WAIT_MS,
          ),
        )
      for (const sessions of files.sessions)
        locks.push(
          await takeLock(
            CODEX_SESSIONS_LOCK_NAME,
            sessions.old,
            DATA_LOCK_WAIT_MS,
          ),
        )
    }
    return locks
  } catch (error) {
    for (const lock of locks.reverse()) await lock.release().catch(() => {})
    throw error
  }
}

function layoutFiles(location: RuntimeLayoutLocation): LayoutFiles {
  const oldState = join(location.configDir, ACCOUNT_STATE_FILE_NAME)
  const nextState = join(location.stateHomeDir, ACCOUNT_STATE_FILE_NAME)
  return {
    state: { old: oldState, next: nextState },
    vault: { old: vaultStateDir(oldState), next: vaultStateDir(nextState) },
    sessions: [
      OPENCODE1_CODEX_SESSIONS_FILE,
      OPENCODE2_CODEX_SESSIONS_FILE,
    ].map((name) => ({
      old: join(location.configDir, name),
      next: join(location.stateHomeDir, name),
    })),
  }
}

const SHA256_HEX = /^[0-9a-f]{64}$/

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** OpenCode's vault enrollment state file, in both layouts. */
function vaultStateFile(files: LayoutFiles): LayoutFile {
  return {
    old: vaultPaths(files.vault.old, 'opencode').statePath,
    next: vaultPaths(files.vault.next, 'opencode').statePath,
  }
}

/** The name OpenCode enrolls with the vault under. */
const OPENCODE_ENROLLMENT_NAME = vaultEnrollmentName('opencode')

/**
 * A token path that no one writes, beside the state-home copy of the
 * enrollment state, for reading that copy as if its token were gone. Should a
 * file ever be there, common-auth reads the state as approved, which
 * `vaultModeWithoutToken` does not accept: the move then removes the old state
 * file as it does any other.
 */
const NO_TOKEN_FILE = 'opencode-enrollment-no-token.json'

/**
 * True when common-auth's own reader takes the enrollment files at `paths` for
 * vault mode with the token missing, under OpenCode's enrollment name: the
 * state is approved, or blocked because the token is missing, and there is no
 * token file. A token file, another enrollment name, a pending or denied
 * state, or a file the reader rejects (malformed, not owner-only) is false.
 */
async function vaultModeWithoutToken(
  paths: ClaustrumEnrollmentPaths,
): Promise<boolean> {
  try {
    const status = await readClaustrumEnrollmentStatus(
      paths,
      OPENCODE_ENROLLMENT_NAME,
    )
    return (
      status.state === 'blocked' &&
      status.code === 'missing_token' &&
      status.proposedName === OPENCODE_ENROLLMENT_NAME
    )
  } catch {
    return false
  }
}

/**
 * The SHA-256 of the enrollment state file this move copied, when that state
 * keeps the host in vault mode once the old token is gone: approved, or
 * blocked because the token is missing, under OpenCode's enrollment name.
 * common-auth's `enrollmentAuthority` reads such a state with no token next
 * to it as 'vault', so leaving it in the old vault folder keeps an older
 * version in vault mode. Any other state (pending, denied, unreadable)
 * protects nothing, and the old copy is removed as usual.
 */
async function keepableVaultState(
  files: LayoutFiles,
  present: LayoutFile[],
): Promise<string | undefined> {
  const state = vaultStateFile(files)
  if (!present.some((file) => file.old === state.old)) return undefined
  // The copy, verified byte for byte against the old file, read the way an
  // older version will read the old one after the move removes its token.
  const keepable = await vaultModeWithoutToken({
    statePath: state.next,
    tokenPath: join(files.vault.next, NO_TOKEN_FILE),
  })
  return keepable ? sha256(await readFile(state.next)) : undefined
}

/** True when `path` holds exactly the bytes whose SHA-256 is `hash`. */
async function isKeptVaultState(
  path: string,
  hash: string | undefined,
): Promise<boolean> {
  if (!hash) return false
  try {
    return sha256(await readFile(path)) === hash
  } catch {
    return false
  }
}

/**
 * True when the old vault folder's enrollment state file is the one a move
 * left there on purpose (the marker recorded a hash): still exactly those
 * bytes, or rewritten by an older version to another state common-auth reads
 * as vault mode without a token (see `vaultModeWithoutToken`), with no token
 * file next to it. Such a file holds no secret.
 */
async function isVaultStateLeftover(
  files: LayoutFiles,
  keptVaultState: string | undefined,
): Promise<boolean> {
  if (!keptVaultState) return false
  const old = vaultPaths(files.vault.old, 'opencode')
  if (await isKeptVaultState(old.statePath, keptVaultState)) return true
  return vaultModeWithoutToken(old)
}

/**
 * After Disconnect, remove the enrollment state file a move left in the old
 * vault folder, so an older version no longer reads this host as enrolled.
 * Acts only for this config folder's state-home vault folder (`vaultDir`),
 * only when the marker records that the move left such a file, and only on a
 * file `isVaultStateLeftover` accepts; anything else there stays. The emptied
 * old vault folder goes too.
 */
export async function removeMovedVaultStateLeftover(
  vaultDir: string,
): Promise<void> {
  const location = runtimeLayoutLocation()
  const files = layoutFiles(location)
  if (resolve(vaultDir) !== resolve(files.vault.next)) return
  const stateDir = location.stateHomeDir
  const marker = await readMarker(
    join(stateDir, RUNTIME_LAYOUT_MARKER_FILE),
    stateDir,
  )
  if (!marker?.keptVaultState || marker.oldDir !== location.key) return
  const leftover = vaultStateFile(files).old
  if (!(await isVaultStateLeftover(files, marker.keptVaultState))) return
  await unlink(leftover).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
  await rmdir(files.vault.old).catch(() => {})
}

/** Lock files, eviction markers and staged writes come and go with a writer. */
function isTransient(name: string): boolean {
  return name.includes('.lock') || name.includes('.tmp')
}

/** The regular, non-transient files directly in a folder. */
async function folderFiles(dir: string): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
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
  if (await exists(files.state.old)) present.push(files.state)
  for (const name of await folderFiles(files.vault.old))
    present.push({
      old: join(files.vault.old, name),
      next: join(files.vault.next, name),
    })
  for (const sessions of files.sessions)
    if (await exists(sessions.old)) present.push(sessions)
  return present
}

/** Every runtime file that exists in the state-home layout. */
async function destinationFiles(files: LayoutFiles): Promise<string[]> {
  const found: string[] = []
  if (await exists(files.state.next)) found.push(files.state.next)
  for (const name of await folderFiles(files.vault.next))
    found.push(join(files.vault.next, name))
  for (const sessions of files.sessions)
    if (await exists(sessions.next)) found.push(sessions.next)
  return found
}

/**
 * Old paths that are the same physical file or folder as their new place (a
 * link or a mount): moving those would copy a file onto itself and then
 * delete it.
 */
async function physicalAliases(
  location: RuntimeLayoutLocation,
  files: LayoutFiles,
): Promise<string[]> {
  const pairs: [string, string][] = [
    [location.configDir, location.stateHomeDir],
    [files.vault.old, files.vault.next],
    [files.state.old, files.state.next],
    ...files.sessions.map((file): [string, string] => [file.old, file.next]),
  ]
  for (const name of await folderFiles(files.vault.old))
    pairs.push([join(files.vault.old, name), join(files.vault.next, name)])
  const aliased: string[] = []
  for (const [old, next] of pairs)
    if (await samePhysical(old, next)) aliased.push(old)
  return aliased
}

/** True when both paths exist and are one file or folder (device and inode). */
async function samePhysical(a: string, b: string): Promise<boolean> {
  const id = async (path: string) => {
    try {
      const info = await stat(path, { bigint: true })
      // A file system without inode numbers cannot prove anything here.
      return info.ino === 0n ? undefined : `${info.dev}:${info.ino}`
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
      throw error
    }
  }
  const left = await id(a)
  return left !== undefined && left === (await id(b))
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
 * Remove each old file whose bytes equal its new copy, comparing again right
 * before every unlink attempt. Differing credentials refuse the start because
 * the old copy may hold the only live refresh token. Differing sessions, or
 * session files that Windows will not let go of, stay with a warning. An
 * identical credential file that cannot be removed, or one Windows keeps open
 * so it cannot be compared, throws
 * `OldCredentialKeptError` once every other file was tried, so the caller
 * leaves the marker without `oldFilesRemoved` and the next start tries again.
 * The enrollment state file a move leaves on purpose (`isVaultStateLeftover`)
 * stays and is not reported; so does that file whenever the marker records a
 * kept state and its bytes equal the state-home copy. The caller holds the
 * data locks.
 */
async function removeOldCopies(
  location: RuntimeLayoutLocation,
  present: LayoutFile[],
  layoutLock: RefreshFileLock,
  input: {
    log: RuntimeLayoutLogger
    keptVaultState: string | undefined
    steps?: RuntimeLayoutOptions['steps']
  },
): Promise<void> {
  const kept: string[] = []
  const credentialsKept: string[] = []
  const files = layoutFiles(location)
  const keptState = vaultStateFile(files).old
  // The enrollment state file comes last: whether it may stay depends on the
  // old token being gone, and the token is one of the files removed here.
  const ordered = [
    ...present.filter((file) => file.old !== keptState),
    ...present.filter((file) => file.old === keptState),
  ]
  for (const file of ordered) {
    await layoutLock.assertOwned()
    if (file.old === keptState) {
      if (await isVaultStateLeftover(files, input.keptVaultState)) continue
      // An old credential still in place means another try at the next
      // start; the state file is judged then, beside what is left by then.
      if (credentialsKept.length > 0) continue
      // The move left a state file here on purpose. Whenever the leftover
      // check above rejects it (a read that failed for a moment is enough),
      // a copy identical to the state-home one must still stay: removing it
      // would make an older version read this host as local. Differing bytes
      // are judged below.
      if (input.keptVaultState && (await sameBytes(file.old, file.next)))
        continue
    }
    const credentials =
      file.old === files.state.old || insideOrSame(file.old, files.vault.old)
    if (
      !(await unlinkIfIdentical(file, location.stateHomeDir, credentials, () =>
        beforeRemove(file.old, layoutLock, input.steps),
      ))
    )
      (credentials ? credentialsKept : kept).push(file.old)
  }
  if (kept.length > 0)
    input.log.warn(
      "openai-auth left old files in OpenCode's config folder; it no longer reads them",
      { configDir: location.configDir, kept },
    )
  const [first] = credentialsKept
  if (first !== undefined) throw new OldCredentialKeptError(first)
}

/** True when both files can be read and hold the same bytes. */
async function sameBytes(a: string, b: string): Promise<boolean> {
  try {
    return (await readFile(a)).equals(await readFile(b))
  } catch {
    return false
  }
}

/** The test seam, then the lease check that must come right before a removal. */
async function beforeRemove(
  path: string,
  layoutLock: RefreshFileLock,
  steps: RuntimeLayoutOptions['steps'],
): Promise<void> {
  await steps?.beforeRemove?.(path)
  await layoutLock.assertOwned()
}

/**
 * On Windows, a file another process has open (an antivirus scan, an indexer,
 * a writer that has not closed it yet) can refuse to be read or removed for a
 * moment. These codes do not say whether the file exists or what it holds.
 */
function isWindowsSharingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return (
    process.platform === 'win32' &&
    (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES')
  )
}

/**
 * Unlink `file.old` only while its bytes equal `file.next`, retrying on
 * Windows while another process has either file open. `guard` runs right
 * before every unlink attempt and throws when the removal must not happen.
 * True when the file is gone. False when it stays: a session file that
 * differs or cannot be read, or a file Windows kept open past the retry
 * budget, whether for the comparison or for the removal. Differing
 * credentials, or credentials unreadable for any other reason, throw
 * `credentialConflict`.
 */
async function unlinkIfIdentical(
  file: LayoutFile,
  stateDir: string,
  credentials: boolean,
  guard: () => Promise<void>,
): Promise<boolean> {
  const started = performance.now()
  for (const delay of SHARING_RETRY_DELAYS_MS) {
    if (delay > 0) await new Promise((done) => setTimeout(done, delay))
    let same: boolean
    try {
      same = (await readFile(file.old)).equals(await readFile(file.next))
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'ENOENT' &&
        !(await exists(file.old))
      )
        return true
      // A file Windows holds open is not evidence that the two copies differ:
      // compare again shortly, and past the budget leave the old file for the
      // next start, as when the unlink itself is refused.
      if (isWindowsSharingError(error)) {
        if (performance.now() - started >= SHARING_RETRY_BUDGET_MS) return false
        continue
      }
      // Unreadable on either side for another reason: credentials are
      // ambiguous, while a session file can safely stay without being used.
      if (credentials) throw credentialConflict(stateDir, file)
      return false
    }
    if (!same) {
      if (credentials) throw credentialConflict(stateDir, file)
      return false
    }
    await guard()
    try {
      await unlink(file.old)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      if (
        !isWindowsSharingError(error) ||
        performance.now() - started >= SHARING_RETRY_BUDGET_MS
      )
        return false
    }
  }
  return false
}

async function noticeReappearedFiles(
  location: RuntimeLayoutLocation,
  files: LayoutFiles,
  overrides: string[],
  marker: LayoutMarker,
  log: RuntimeLayoutLogger,
): Promise<void> {
  // A file an override names is this process's own, wherever it is.
  const own = (path: string) =>
    overrides.some((override) => accountPathsCollide(override, path))
  if (!own(files.state.old) && (await exists(files.state.old)))
    throw credentialConflict(location.stateHomeDir, files.state)
  if (!own(files.vault.old)) {
    const keptState = vaultStateFile(files).old
    for (const name of await folderFiles(files.vault.old)) {
      const old = join(files.vault.old, name)
      // The enrollment state file the move left on purpose, as it moved or as
      // an older version rewrote it without leaving vault mode.
      if (
        old === keptState &&
        (await isVaultStateLeftover(files, marker.keptVaultState))
      )
        continue
      if (!own(old))
        throw credentialConflict(location.stateHomeDir, {
          old,
          next: join(files.vault.next, name),
        })
    }
  }
  const found: string[] = []
  try {
    for (const file of files.sessions)
      if (await exists(file.old)) found.push(file.old)
  } catch {
    // Only a warning depends on this; an unreadable folder warns nothing.
  }
  if (found.length === 0) return
  logOnce(`${location.key}\0reappeared`, () => {
    processState.notice = {
      text: `${RUNTIME_LAYOUT_REAPPEARED_MESSAGE} Old folder: ${location.configDir}`,
      shown: false,
    }
    log.warn(RUNTIME_LAYOUT_REAPPEARED_MESSAGE, {
      configDir: location.configDir,
      stateDir: location.stateHomeDir,
      found,
    })
  })
}

/**
 * The marker, or undefined when it does not exist. It is written atomically
 * after all copies are verified, so malformed contents mean outside damage,
 * not evidence that the move completed. Other read failures are retried
 * briefly, then refuse the start: they prove neither presence nor absence.
 */
async function readMarker(
  path: string,
  stateDir: string,
): Promise<LayoutMarker | undefined> {
  let text: string | undefined
  let failure: unknown
  for (let attempt = 0; attempt < MARKER_READ_ATTEMPTS; attempt++) {
    if (attempt > 0)
      await new Promise((done) => setTimeout(done, MARKER_READ_RETRY_MS))
    try {
      text = await readFile(path, 'utf8')
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
      failure = error
    }
  }
  if (text === undefined)
    throw new RuntimeLayoutRefusal(stateDir, errorClass(failure))
  try {
    const value = JSON.parse(text) as Partial<LayoutMarker> | null
    if (value && typeof value === 'object' && !Array.isArray(value))
      return {
        version: 1,
        ...(typeof value.oldDir === 'string' ? { oldDir: value.oldDir } : {}),
        ...(value.oldFilesRemoved === true ? { oldFilesRemoved: true } : {}),
        ...(typeof value.keptVaultState === 'string' &&
        SHA256_HEX.test(value.keptVaultState)
          ? { keptVaultState: value.keptVaultState }
          : {}),
      }
  } catch {}
  throw new RuntimeLayoutRefusal(
    stateDir,
    'malformed-marker',
    `openai-auth cannot start: ${path} is malformed. The old files are still in OpenCode's config folder. Delete layout.json, then restart OpenCode.`,
  )
}

/**
 * Refuse a state-home folder whose `config-dir.json` or marker names another
 * config folder: its files belong to that folder's OpenCode.
 */
async function assertOwnFolder(
  location: RuntimeLayoutLocation,
  marker: LayoutMarker | undefined,
): Promise<void> {
  const stateDir = location.stateHomeDir
  if (marker?.oldDir !== undefined && marker.oldDir !== location.key)
    throw foreignFolder(stateDir, location.key)
  let text: string
  try {
    text = await readFile(join(stateDir, RUNTIME_CONFIG_DIR_NOTE_FILE), 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return
    throw new RuntimeLayoutRefusal(stateDir, errorClass(error))
  }
  let owner: unknown
  try {
    owner = (JSON.parse(text) as { configDir?: unknown } | null)?.configDir
  } catch {}
  if (owner !== location.key) throw foreignFolder(stateDir, location.key)
}

/** Name this folder's config folder, once; the caller holds the layout lock. */
async function writeOwnerNote(location: RuntimeLayoutLocation): Promise<void> {
  const path = join(location.stateHomeDir, RUNTIME_CONFIG_DIR_NOTE_FILE)
  if (await exists(path)) return
  await writePrivateText(
    path,
    `${JSON.stringify({ version: 1, configDir: location.key }, null, 2)}\n`,
  )
}

/** The copies an unfinished move listed; empty when there is none. */
async function readManifest(stateDir: string): Promise<Set<string>> {
  let text: string
  try {
    text = await readFile(join(stateDir, RUNTIME_LAYOUT_MANIFEST_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
    throw error
  }
  // A manifest that does not parse proves nothing about whose files these
  // are; the destination check then treats them as someone else's.
  try {
    const value = JSON.parse(text) as { files?: unknown } | null
    if (Array.isArray(value?.files))
      return new Set(
        value.files.filter((path): path is string => typeof path === 'string'),
      )
  } catch {}
  return new Set()
}

async function writeManifest(stateDir: string, paths: string[]): Promise<void> {
  await writePrivateText(
    join(stateDir, RUNTIME_LAYOUT_MANIFEST_FILE),
    `${JSON.stringify({ version: 1, files: paths }, null, 2)}\n`,
  )
}

async function removeManifest(stateDir: string): Promise<void> {
  await unlink(join(stateDir, RUNTIME_LAYOUT_MANIFEST_FILE)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    },
  )
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
    let lock: RefreshFileLock | null = null
    try {
      lock = await acquireRefreshFileLock({
        name,
        path,
        ttlMs: LOCK_TTL_MS,
        renew: true,
      })
    } catch (error) {
      // On Windows a holder that releases while this attempt reads its lock
      // file makes the attempt fail with ENOENT: the lock is free, so try
      // again rather than fail.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
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
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
}

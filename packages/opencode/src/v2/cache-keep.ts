// Prompt-cache keep-warm on OpenCode 2.
//
// OpenCode 2 runs setup once per location, and one server process can hold
// several locations over the same account store. Keep-warm has to run once
// per store, not once per location: one manager, one timer and one target per
// session. So the manager lives in a process-wide registry keyed by the
// store's paths, like the session-account registry (`session-accounts.ts`).
// Each location holds it through `acquireCacheKeep` and brings its own pool
// source, vault, settings and capture hook. The manager is OpenCode 1's
// (`createCacheKeepManager` in `core/cachekeep.ts`), so the TTL profiles,
// caps, backoff, clock window, sustain and subagent limits are the same.
//
// A target is the final owned agent-loop HTTP request as the host sends it,
// keyed by the host's session id. It keeps the body, the headers a replay
// needs (never a credential), the pool row or vault route that served it,
// the ChatGPT account it was served as and which store served it. It never
// keeps a token. Every warm:
// - goes only to the account that serves the session now, read from the
//   session-account registry. A session with no recorded account, or one now
//   served by another account, is dropped and waits for its next real request;
// - resolves a fresh credential through a live location: the pool row's
//   token in local mode, or a new `vault.send` receipt in vault mode;
// - refuses a credential from the other store than the capture's, and backs
//   off. After enrolling with the vault or disconnecting from it, only the
//   next capture warms;
// - checks that the credential still signs in as the captured ChatGPT
//   account. A different login on the same row drops the target unsent.
//
// The holder count works like `acquireOpenCodeVault` (`core/shared-vault.ts`).
// A warm reads its dependencies from a location that still holds the
// manager, never from a released one. The last release stops the manager and
// waits a bounded time for a warm in flight to end.

import { resolve } from 'node:path'
import type { CacheKeepLogger } from '@cortexkit/common-auth/cachekeep'
import type { Attempt } from '@cortexkit/common-auth/opencode2'
import {
  type AccountPaths,
  type AccountStorage,
  cacheKeepSettings,
  type OpenAiVault,
} from '@cortexkit/openai-auth-core/internal'
import {
  CACHE_KEEP_CAPS,
  type CacheKeepWindow,
  createCacheKeepManager,
  getCacheKeepWindow,
  type OpenAICacheKeepManager,
  type OpenAICacheKeepMeta,
} from '../core/cachekeep'
import type { PoolAccountSource } from '../core/pool-account-source'
import type { OpenAIAttemptData } from './adapter'
import type { ActiveAccounts } from './session-accounts'

/**
 * The longest the last release waits for a warm in flight, matching the
 * five-second limit setup's shutdown already keeps.
 */
export const CACHE_KEEP_JOIN_MS = 5_000

/**
 * The request headers a warm replays. Everything here describes the client,
 * the conversation or the turn. Credentials (`authorization`, `cookie`) and
 * the account header are left out: the account header is sent from the
 * capture's own field, and the bearer is resolved fresh for every warm.
 */
const REPLAY_HEADERS = [
  'accept',
  'originator',
  'session-id',
  'thread-id',
  'user-agent',
  'version',
  'x-client-request-id',
  'x-codex-beta-features',
  'x-codex-turn-metadata',
  'x-codex-window-id',
  'x-openai-internal-codex-responses-lite',
  'x-opencode-parent-session-id',
  'x-parent-session-id',
] as const

/** Headers the host puts on a subagent's requests, naming its parent session. */
const PARENT_HEADERS = ['x-opencode-parent-session-id', 'x-parent-session-id']

/** The keep-warm settings a location reads, from the `/openai` Cache section. */
export interface CacheKeepSettingsView {
  enabled: boolean
  subagents: boolean
  sustain: boolean
  /** The clock window; undefined means warm at any hour. */
  window: CacheKeepWindow | undefined
}

/** The saved keep-warm settings, read the way OpenCode 1 reads them. */
export function cacheKeepSettingsOf(
  storage: AccountStorage | null,
): CacheKeepSettingsView {
  const stored = cacheKeepSettings(storage)
  return {
    enabled: stored?.enabled === true,
    subagents: stored?.subagents === true,
    sustain: stored?.sustain === true,
    window: getCacheKeepWindow(
      storage ? { ...storage, cachekeep: stored } : storage,
    ),
  }
}

/** What one location lends the shared manager while it holds it. */
export interface CacheKeepLocation {
  /** This location's pool source; a local-mode warm takes its token here. */
  source: Pick<PoolAccountSource, 'accessFor'>
  /** The account settings, read for each local-mode token. */
  storage: () => Promise<AccountStorage | null>
  /** This location's vault; a vault-mode warm gets a new receipt here. */
  vault: Pick<OpenAiVault, 'authority' | 'owns' | 'send'>
  /** The account serving each session now (the session-account registry). */
  accounts: ActiveAccounts
  /** This location's live keep-warm settings. */
  settings: () => CacheKeepSettingsView
  /**
   * The session's parent session, or undefined for a top-level session. A
   * throw leaves the request uncaptured.
   */
  parentOf?: (sessionID: string) => Promise<string | undefined>
  fetch: typeof fetch
  log?: CacheKeepLogger
}

/**
 * How the store's manager is built. Only the first location to acquire a
 * store's manager supplies these; in production every location passes the
 * same clock and timers.
 */
export interface CacheKeepManagerSetup {
  now: () => number
  /** Where a warm goes when its capture has no URL; captures always have one. */
  codexResponsesUrl: string
  setIntervalImpl?: typeof globalThis.setInterval
  clearIntervalImpl?: typeof globalThis.clearInterval
  /** How long the last release waits for a warm in flight. */
  joinTimeoutMs?: number
}

/** One owned HTTP request at the post-installer seam. */
export interface CacheKeepCaptureInput {
  /** The host's session id; the target key. */
  sessionID: string
  kind: string
  /** The final Request the host sends. */
  request: Request
  /** The account attempt that request belongs to. */
  attempt: Attempt<OpenAIAttemptData>
}

/** One location's hold on its store's keep-warm manager. */
export interface CacheKeepLease {
  readonly manager: OpenAICacheKeepManager
  /**
   * Tracks an owned agent-loop request while keep-warm is on. Never throws:
   * a capture that cannot be made logs one warning and the request goes on.
   */
  capture(input: CacheKeepCaptureInput): Promise<void>
  /** Drops a session's target, for a session the host deleted. */
  forget(sessionID: string): void
  /**
   * Releases this location's hold. The last release stops the manager and
   * resolves once a warm in flight has ended, or after the join limit.
   */
  release(): Promise<void>
}

type Holder = { location: CacheKeepLocation }
type Entry = {
  manager: OpenAICacheKeepManager
  holders: Holder[]
  joinTimeoutMs: number
}

// OpenCode 1 and OpenCode 2 are separate bundle entries that one process may
// load more than once, so the registry lives on a process-wide symbol.
const registryKey = Symbol.for('@cortexkit/openai-auth/opencode2-cache-keep')
const processState = globalThis as typeof globalThis & {
  [registryKey]?: Map<string, Entry>
}
const entries = processState[registryKey] ?? new Map<string, Entry>()
processState[registryKey] = entries

function createEntry(setup: CacheKeepManagerSetup): Entry {
  const holders: Holder[] = []
  // The newest holder lends the dependencies: after a location reloads, the
  // reloaded one serves its warms.
  const live = () => holders.at(-1)?.location
  const need = () => {
    const location = live()
    if (!location) throw new Error('no location holds keep-warm')
    return location
  }
  const drop = (sessionKey: string, reason: string) => {
    manager.remove(sessionKey)
    live()?.log?.debug(`cachekeep dropped target (${reason})`, { sessionKey })
  }
  const localAccess = async (
    accountId: string,
    target: { meta: OpenAICacheKeepMeta },
  ) => {
    // A target captured through the vault never reads a local token, even
    // when a pool row has the same id.
    if (target.meta.credentialMode !== 'local')
      throw new Error(
        'a target captured in vault mode is not warmed with a local credential',
      )
    const location = need()
    const access = await location.source.accessFor(
      accountId,
      await location.storage(),
    )
    if (!access) throw new Error(`pool row ${accountId} has no usable token`)
    return { token: access.token, identity: access.row.identity }
  }
  const manager: OpenAICacheKeepManager = createCacheKeepManager({
    ...CACHE_KEEP_CAPS,
    now: setup.now,
    ...(setup.setIntervalImpl
      ? { setIntervalImpl: setup.setIntervalImpl }
      : {}),
    ...(setup.clearIntervalImpl
      ? { clearIntervalImpl: setup.clearIntervalImpl }
      : {}),
    codexResponsesUrl: setup.codexResponsesUrl,
    fetchImpl: ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      need().fetch(input, init)) as typeof fetch,
    logger: {
      debug: (message, data) => live()?.log?.debug(message, data),
      warn: (message, data) => live()?.log?.warn(message, data),
    },
    getWindow: () => live()?.settings().window,
    getSustain: () => live()?.settings().sustain === true,
    getMainToken: (target) => localAccess('main', target),
    refreshFallback: (accountId, target) => localAccess(accountId, target),
    vault: {
      owns: (routeId) => live()?.vault.owns(routeId) === true,
      authority: () => need().vault.authority(),
      // Each warm reads the enrollment authority afresh and asks for its own
      // receipt. Undefined is the vault's own "refused before sending".
      send: async (routeId, dispatch, options) => {
        const location = need()
        if ((await location.vault.authority()) !== 'vault') return undefined
        return location.vault.send(routeId, dispatch, options)
      },
    },
    // Asked before every warm. Settings turned off since the capture, and a
    // session with no recorded account, drop the target. Another account
    // than the captured one drops it inside the manager.
    activeAccount: (sessionID, target) => {
      const location = live()
      const settings = location?.settings()
      if (!location || !settings?.enabled) {
        drop(target.sessionKey, 'keep-warm is off')
        return undefined
      }
      if (target.isSubagent && !settings.subagents) {
        drop(target.sessionKey, 'subagent warming is off')
        return undefined
      }
      const active =
        sessionID === undefined
          ? undefined
          : location.accounts.activeAccount(sessionID)
      if (active === undefined) {
        drop(target.sessionKey, 'no account recorded for the session')
        return undefined
      }
      return active
    },
    verifyCredential: ({ target, mode, identity }) => {
      if (target.meta.credentialMode !== mode)
        throw new Error(
          `a target captured in ${target.meta.credentialMode ?? 'an unknown'} mode is not warmed with a ${mode} credential`,
        )
      if (identity !== target.meta.chatgptAccountId) {
        drop(target.sessionKey, 'the account signs in as another login now')
        throw new Error('the account signs in as another login now')
      }
    },
  })
  return {
    manager,
    holders,
    joinTimeoutMs: setup.joinTimeoutMs ?? CACHE_KEEP_JOIN_MS,
  }
}

/** The headers a warm replays from a captured request. */
function replayHeadersOf(headers: Headers): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const name of REPLAY_HEADERS) {
    const value = headers.get(name)
    if (value) kept[name] = value
  }
  return kept
}

/**
 * Gives one location a hold on the keep-warm manager this process keeps for
 * the account store. The first holder builds it; later ones share it.
 */
export function acquireCacheKeep(
  paths: AccountPaths,
  location: CacheKeepLocation,
  setup: CacheKeepManagerSetup,
): CacheKeepLease {
  // Relative and absolute paths to the same store give the same key, as for
  // the session pins and the session-account registry.
  const key = JSON.stringify([
    resolve(paths.configPath),
    resolve(paths.statePath),
  ])
  let entry = entries.get(key)
  if (!entry) {
    entry = createEntry(setup)
    entries.set(key, entry)
  }
  const owned = entry
  const holder: Holder = { location }
  owned.holders.push(holder)
  let released = false

  const capture = async (input: CacheKeepCaptureInput) => {
    try {
      const settings = location.settings()
      if (released || !settings.enabled || input.kind !== 'primary') return
      const data = input.attempt.data
      const credentialMode =
        data?.kind === 'pool'
          ? 'local'
          : data?.kind === 'vault'
            ? 'vault'
            : undefined
      if (!credentialMode) return
      const headers = input.request.headers
      const isSubagent =
        PARENT_HEADERS.some((name) => headers.has(name)) ||
        (location.parentOf !== undefined &&
          (await location.parentOf(input.sessionID)) !== undefined)
      if (isSubagent && !settings.subagents) return
      const bodyText = await input.request.clone().text()
      if (released) return
      const chatgptAccountId = headers.get('chatgpt-account-id') ?? undefined
      owned.manager.track({
        sessionKey: input.sessionID,
        bodyText,
        accountId: input.attempt.accountId,
        isSubagent,
        meta: {
          replayHeaders: replayHeadersOf(headers),
          ...(chatgptAccountId ? { chatgptAccountId } : {}),
          routingSessionId: input.sessionID,
          url: input.request.url,
          credentialMode,
        },
      })
    } catch (error) {
      location.log?.warn('cachekeep capture failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return {
    manager: owned.manager,
    capture,
    forget: (sessionID) => owned.manager.remove(sessionID),
    async release() {
      if (released) return
      released = true
      const index = owned.holders.indexOf(holder)
      if (index >= 0) owned.holders.splice(index, 1)
      if (owned.holders.length > 0) return
      if (entries.get(key) === owned) entries.delete(key)
      // Stopping aborts a warm in flight; the tick it runs in then ends at
      // its next step. `tick()` returns that running tick, so awaiting it
      // joins the warm. With none running it is an empty tick.
      owned.manager.stop()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          owned.manager.tick().catch(() => {}),
          new Promise<void>((done) => {
            timer = setTimeout(done, owned.joinTimeoutMs)
            timer.unref?.()
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

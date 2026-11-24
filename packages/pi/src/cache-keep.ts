import type { AccountKey } from '@cortexkit/common-auth/limits'
import { watchServerSentEvents } from '@cortexkit/common-auth/opencode2'
import { isQuotaMap } from '@cortexkit/common-auth/quota'
import {
  type AccountStorage,
  CACHE_KEEP_CAPS,
  cacheKeepSettings,
  createCacheKeepManager,
  createLogger,
  getCacheKeepWindow,
  hasVaultRoutingAccessor,
  isRecord,
  type OpenAICacheKeepManager,
  type OpenAICacheKeepManagerOptions,
  type OpenAICacheKeepMeta,
  type OpenAiVault,
  type SessionActivityStore,
  shouldCaptureSessionCache,
  VaultBillingAttempt,
} from '@cortexkit/openai-auth-core/internal'
import { planOrdered } from '@cortexkit/openai-auth-core/pool-routing'
import { piCodexAccountId } from './codex-wire.ts'
import { getPiStickyRouting } from './routing.ts'

interface PiCapture {
  sessionKey: string
  accountId: string
  bodyText: string
  meta: OpenAICacheKeepMeta
}

interface PiCacheKeepOptions {
  now: () => number
  endpoint: string
  fetchImpl: typeof fetch
  vault: OpenAiVault
  activity: SessionActivityStore
  settings: () => AccountStorage | undefined
  resolveLocal: (accountId: string) => Promise<string>
  accountKey: (accountId: string) => AccountKey | undefined
  busy: (sessionId: string) => boolean
}

/** Pi owns the serving bindings and captures; common-auth owns all scheduling. */
export class PiCacheKeep {
  readonly manager: OpenAICacheKeepManager
  private readonly bindings = new Map<
    string,
    { accountId: string; pin: string | undefined; meta: OpenAICacheKeepMeta }
  >()
  private readonly log = createLogger('cachekeep')

  constructor(private readonly options: PiCacheKeepOptions) {
    const { vault } = options
    const getStored = () => cacheKeepSettings(options.settings())
    const activeAccount = (sessionId: string | undefined) => {
      if (sessionId === undefined) throw new Error('Missing Pi warm session')
      const binding = this.bindings.get(sessionId)
      if (!binding || !this.enabled(sessionId)) {
        this.manager.remove(sessionId)
        return undefined
      }
      // A changed pin invalidates the capture even if the foreground has not
      // reached the newly pinned account yet. Empty means no matching account.
      return getPiStickyRouting(sessionId) !== binding.pin
        ? ''
        : binding.accountId
    }
    this.manager = createCacheKeepManager({
      ...CACHE_KEEP_CAPS,
      host: 'pi',
      credentialIdentity: piCodexAccountId,
      logger: this.log,
      now: options.now,
      codexResponsesUrl: options.endpoint,
      fetchImpl: options.fetchImpl,
      getWindow: () => getCacheKeepWindow({ cachekeep: getStored() }),
      getSustain: () => getStored()?.sustain === true,
      activeAccount: (id) => {
        if (id && options.busy(id))
          throw new Error('The Pi session is not idle')
        return activeAccount(id)
      },
      vault: {
        owns: (id) => vault.owns(id),
        authority: () => vault.authority(),
        reportUsage: (...args) => vault.reportUsage(...args),
        send: async (id, send, request) => {
          const authority = await vault.authority()
          return authority === 'vault' || authority === 'host'
            ? vault.send(id, send, request)
            : undefined
        },
      },
      resolveLocal: ({ accountId, meta }) => {
        if (!accountId || meta.credentialMode !== 'local')
          throw new Error('A vault capture cannot use a local credential')
        return options.resolveLocal(accountId)
      },
      verifyCredential: async ({ target, mode }) => {
        const authority = await vault.authority()
        const sessionId = target.sessionKey
        const current = this.bindings.get(sessionId)?.meta === target.meta
        const sameAccount =
          current && activeAccount(sessionId) === target.accountId
        if (current && !sameAccount) this.manager.remove(sessionId)
        if (
          !sameAccount ||
          options.busy(sessionId) ||
          mode !== target.meta.credentialMode ||
          (mode === 'local'
            ? authority !== 'local'
            : authority !== 'vault' && authority !== 'host')
        )
          throw new Error('The Pi warm no longer matches its serving session')
      },
      activity: {
        store: options.activity,
        accountKey: ({ target }) =>
          target.accountId &&
          this.bindings.get(target.sessionKey)?.meta === target.meta &&
          activeAccount(target.sessionKey) === target.accountId
            ? options.accountKey(target.accountId)
            : undefined,
      },
      observeBillingSend: (...args) => this.billing(...args),
    })
  }

  enabled(sessionId: string): boolean {
    return shouldCaptureSessionCache(
      sessionId,
      cacheKeepSettings(this.options.settings())?.enabled === true,
    )
  }

  served(sessionId: string, accountId: string) {
    const binding = this.bindings.get(sessionId)
    if (binding) {
      binding.accountId = accountId
      binding.pin = getPiStickyRouting(sessionId)
    }
  }

  capture(capture: PiCapture) {
    const { sessionKey, accountId, meta } = capture
    if (this.enabled(sessionKey) && this.manager.track(capture).tracked) {
      this.bindings.set(sessionKey, {
        accountId,
        pin: getPiStickyRouting(sessionKey),
        meta,
      })
    } else this.forget(sessionKey)
    const tracked = new Set(
      this.manager.status().targets.map((target) => target.sessionKey),
    )
    for (const key of this.bindings.keys()) {
      if (!tracked.has(key)) this.bindings.delete(key)
    }
  }

  forget(sessionId: string) {
    this.manager.remove(sessionId)
    this.bindings.delete(sessionId)
  }

  stop() {
    this.manager.stop()
    this.bindings.clear()
  }

  private billing(
    ...[target, body, receipt, attempt]: Parameters<
      NonNullable<OpenAICacheKeepManagerOptions['observeBillingSend']>
    >
  ) {
    if (!receipt.credentialId || !hasVaultRoutingAccessor()) return undefined
    const model: unknown = JSON.parse(body).model
    if (typeof model !== 'string') return undefined
    const route = this.options.vault
      .routes()
      .find(({ id }) => id === target.accountId)
    const tier =
      route &&
      planOrdered({
        rows: [
          {
            id: route.id,
            kind: route.kind,
            ...(isQuotaMap(route.quota) ? { quota: route.quota } : {}),
          },
        ],
        now: this.options.now(),
        placement: 'roster',
        mainId: null,
        rateLimitMarks: new Map(),
        refreshBackoff: new Map(),
        killswitch: new Map(),
        requestPull: () => {},
      })
    const record = new VaultBillingAttempt(
      target.sessionKey,
      receipt,
      'keep_warm',
      model,
      attempt,
      (sessionId) => this.manager.warming(sessionId),
      route !== undefined &&
        tier?.kind === 'send' &&
        tier.tiers[route.id] === 'free',
    )
    return {
      response: (response: Response) => observeWarmBilling(record, response),
      failed: () => record.end(false, false),
    }
  }
}

/** Bill the background HTTP response as it is drained; nothing reaches Pi's stream. */
function observeWarmBilling(record: VaultBillingAttempt, response: Response) {
  const { status, statusText, headers } = response
  if (!response.ok || !response.body) {
    record.end(false, true, status)
    return response
  }
  let output = false
  const reader = response.body
    .pipeThrough(
      watchServerSentEvents(
        ({ data }) => {
          try {
            const event: unknown = JSON.parse(data)
            record.event(event)
            if (isRecord(event) && typeof event.type === 'string')
              output ||= event.type.endsWith('.delta')
          } catch {
            // Ignore malformed events; the adapter still drains the original bytes.
          }
        },
        () => {},
      ),
    )
    .getReader()
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read()
          if (next.done) {
            controller.close()
            record.end(output, true, status)
          } else controller.enqueue(next.value)
        } catch (error) {
          controller.error(error)
          record.end(output, false, status)
        }
      },
      cancel(reason) {
        record.end(output, false, status, true)
        return reader.cancel(reason)
      },
    }),
    { status, statusText, headers },
  )
}

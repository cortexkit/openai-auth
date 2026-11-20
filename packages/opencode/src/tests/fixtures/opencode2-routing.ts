import { mock, spyOn } from 'bun:test'
import type { ClaustrumScopedAttempt } from '@cortexkit/common-auth/claustrum'
import {
  type ChooseAccountInput,
  placeholderSecret,
} from '@cortexkit/common-auth/opencode2'
import type { QuotaMap } from '@cortexkit/common-auth/quota'
import type { PoolRow } from '@cortexkit/common-auth/store'
import type { AccountStorage } from '@cortexkit/openai-auth-core/internal'
import {
  createOpenAIAdapter,
  type OpenAIAdapterDeps,
  type PoolAccess,
} from '../../v2/adapter'
import { SessionPins } from '../../v2/pins'
import { installPoolHooks } from '../../v2/setup'
import { fakeOpenCode2Host, scope } from './opencode2-host'

export const routingKey = Symbol.for('cortexkit.routing')
const original = Object.getOwnPropertyDescriptor(globalThis, routingKey)

export function restoreRoutingAccessor() {
  if (original) Object.defineProperty(globalThis, routingKey, original)
  else Reflect.deleteProperty(globalThis, routingKey)
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === 'object')
    return value as Record<string, unknown>
}

const refusalCodes = [
  'account_limit_exhausted',
  'account_selection_refused',
  'account_selection_final',
]

// The plugin_replies in 01-first-placement.json and 06-refusals.json are the
// module's HTTP replies. The JS bridge unwraps them before accountFor resolves:
// Thalamus opencode2-plugin/thalamus/routing.ts:209-223.
export function relayAccessorAnswer(body: unknown, ask: unknown) {
  const reply = record(body)
  const choice = record(reply?.choice)
  if (
    choice &&
    typeof choice.account_id === 'string' &&
    (choice.credential_id === undefined ||
      typeof choice.credential_id === 'string') &&
    (choice.hold === undefined ||
      Number.isFinite(record(choice.hold)?.retry_after_ms))
  )
    return choice

  const refused = record(reply?.refused)
  if (record(ask)?.refusals !== true || !refused) return null
  const { code, routing_code, reason, retry_after_secs, resets_at_ms } = refused
  if (typeof code !== 'string' || !refusalCodes.includes(code)) return null
  return {
    refused: {
      code,
      ...(typeof routing_code === 'string' && { routing_code }),
      ...(typeof reason === 'string' &&
        /^[a-z0-9._-]{1,64}$/.test(reason) && {
          reason,
        }),
      ...(typeof retry_after_secs === 'number' &&
        Number.isFinite(retry_after_secs) &&
        retry_after_secs >= 0 && { retry_after_secs }),
      ...(typeof resets_at_ms === 'number' &&
        Number.isSafeInteger(resets_at_ms) &&
        resets_at_ms >= 0 && { resets_at_ms }),
    },
  }
}

export function quotaMap(
  usedPercent: number,
  checkedAt = Date.now(),
): QuotaMap {
  return {
    limits: [
      {
        scope: 'all',
        label: 'primary',
        kind: 'reading',
        usedPercent,
        checkedAt,
        windowMinutes: 300,
      },
    ],
  }
}

export function fixture(
  vaultMode = true,
  mode: 'ordered' | 'sticky-balanced' = 'ordered',
  now: () => number = Date.now,
  deps: Pick<OpenAIAdapterDeps, 'limits' | 'log' | 'sessionAccounts'> = {},
) {
  const rows: PoolRow[] = [
    {
      id: 'main',
      type: 'oauth',
      enabled: true,
      candidate: true,
      hasEntry: true,
      needsFirstReading: false,
      identity: 'local-account',
      credentialEpoch: 1,
      credential: {
        type: 'oauth',
        access: 'local-token',
        refresh: 'local-refresh',
        expires: Date.now() + 3600_000,
      },
      quota: quotaMap(10, now()),
    },
  ]
  const source: PoolAccess = {
    current: async () => ({ active: true, rows }),
    peek: () => ({ active: true, rows }),
    prepareTokens: async () => {},
    usableToken: () => 'local-token',
    refreshBackoffFor: () => new Map(),
    requestReading: () => {},
    recordSnapshot: mock(() => {}),
  }
  const routes = ['a', 'b'].map((id) => ({
    id: `vault:${id}`,
    identity: `account-${id}`,
    credentialId: `credential-${id}`,
    kind: 'oauth' as const,
    quota: quotaMap(10, now()),
  }))
  const refused = new Set<string>()
  const authorized: string[] = []
  const pins = new SessionPins()
  const storage: AccountStorage = {
    version: 1,
    accounts: [],
    routing: { mode },
  }
  const openai = createOpenAIAdapter({
    ...deps,
    now,
    source,
    storage: async () => storage,
    pins,
    vault: {
      routes: () => routes,
      identities: () => new Set(routes.map((route) => route.identity)),
      enrolled: () => vaultMode,
      authority: async () => (vaultMode ? 'vault' : 'local'),
      snapshot: () => undefined,
      authorize: async (id) => {
        authorized.push(id)
        if (refused.has(id)) return undefined
        const route = routes.find((route) => route.id === id)
        if (!route) throw new Error(`Unknown fixture route ${id}`)
        return {
          credentialId: route.credentialId,
          credentialType: 'oauth',
          accountIdentity: route.identity,
          accountIdentitySource: 'asserted',
          accessToken: `${id}-token`,
          recordVersion: 1,
          expiresAtMs: null,
        } satisfies ClaustrumScopedAttempt
      },
      reportFailure: async () => {},
      recordSnapshot: async () => {},
      reportUsage: () => {},
      requestReading: () => {},
      grantReach: () => undefined,
      name: 'openai-auth-opencode',
    },
  })
  const request: ChooseAccountInput = {
    providerID: 'openai',
    modelID: 'gpt-6',
    sessionID: 'fleet-session',
    agent: 'build',
    kind: 'primary',
    phase: 'request',
  }
  return { openai, pins, storage, routes, refused, authorized, request, source }
}

export async function placementRequest(
  answers: readonly unknown[],
  options: {
    decodeAnswer?: (body: unknown, ask: unknown) => unknown
    report?: (payload: Record<string, unknown>) => unknown
    now?: () => number
    log?: OpenAIAdapterDeps['log']
    mode?: 'ordered' | 'sticky-balanced'
    sessionAccounts?: OpenAIAdapterDeps['sessionAccounts']
    extraTimerDelays?: readonly number[]
  } = {},
) {
  const secondAsk = Promise.withResolvers<void>()
  const accountFor = mock(async (request: unknown) => {
    const index = accountFor.mock.calls.length - 1
    if (index === 1) secondAsk.resolve()
    return options.decodeAnswer
      ? options.decodeAnswer(answers[index], request)
      : answers[index]
  })
  Reflect.set(globalThis, routingKey, () => ({
    accountFor,
    report: options.report,
  }))
  const env = fixture(true, options.mode ?? 'sticky-balanced', options.now, {
    log: options.log,
    sessionAccounts: options.sessionAccounts,
  })
  const host = fakeOpenCode2Host()
  const installation = await installPoolHooks(host.ctx, env.openai.adapter, {
    warn() {},
    info() {},
  })
  env.openai.attach(installation)
  const controller = new AbortController()
  const providerFetch = mock((request: Request) =>
    request.headers.get('authorization'),
  )
  const scheduled = Promise.withResolvers<{ delay: number; wake: () => void }>()
  const timerDelays = [0, 3000, 5000, 6000, ...(options.extraTimerDelays ?? [])]
  const realSetTimeout = globalThis.setTimeout
  const timers = spyOn(globalThis, 'setTimeout').mockImplementation(((
    run: () => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay !== undefined && timerDelays.includes(delay)) {
      scheduled.resolve({ delay, wake: run })
      const timer = realSetTimeout(() => {}, delay)
      clearTimeout(timer)
      return timer
    }
    return realSetTimeout(run, delay, ...args)
  }) as typeof setTimeout)
  return {
    ...env,
    host,
    accountFor,
    secondAsk: secondAsk.promise,
    controller,
    providerFetch,
    wait: scheduled.promise,
    async waitBeforeSend(sent: Promise<string | null>) {
      const wait = await Promise.race([scheduled.promise, sent])
      if (!wait || typeof wait !== 'object')
        throw new Error('request sent before the placement wait')
      return wait
    },
    async send(kind: ChooseAccountInput['kind'] = 'primary') {
      const draft = await host.fire('http.request', {
        ...scope(env.request.sessionID, kind),
        request: new Request('https://codex.test/responses', {
          headers: { authorization: `Bearer ${placeholderSecret('openai')}` },
          signal: controller.signal,
        }),
      })
      return providerFetch(draft.request)
    },
    async dispose() {
      controller.abort()
      timers.mockRestore()
      await installation.dispose()
      env.openai.dispose()
    },
  }
}

import { randomUUID } from 'node:crypto'
import {
  acquireLimitsRegistry,
  createPoolLimitsAdapter,
  type IdentityBinding,
  isIdentityCompatible,
  type LimitsClock,
  type LimitsCommand,
  LimitsEnvelopeConflictError,
  LimitsEnvelopeUnsupportedError,
  type LimitsNamespace,
  LimitsPersistenceRefusal,
  type LimitsRegistry,
  type PersistenceAdapter,
} from '@cortexkit/common-auth/limits'
import { createVaultLimitsAdapter } from '@cortexkit/common-auth/limits/vault'
import type { PoolStore } from '@cortexkit/common-auth/store'
import {
  limitAccountId,
  limitsBindingProjection,
  poolLimitsNamespace,
  vaultLimitsNamespace,
} from './limit-identity'
import {
  LimitRecoveryLatch,
  type RecoveryEvidence,
  type RecoveryRead,
} from './limit-recovery'

const ACQUIRE_MS = 5_000
const RETRY_MS = 1_000
const FAILURE_RUN_MS = 60_000
const defaultClock: LimitsClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}
type Source =
  | { kind: 'pool'; configPath: string; statePath: string; store: PoolStore }
  | { kind: 'vault'; rosterPath: string }
export type OpenAiLimitsOptions = {
  source: Source
  log?: (message: string) => void
  isAccessRestrictive?: (state: unknown) => boolean
}
type LeaseOptions = {
  namespace: string
  adapter: () => Promise<PersistenceAdapter>
  log: (message: string) => void
  isAccessRestrictive: (state: unknown) => boolean
}
export type LimitsProbe = {
  readonly binding: IdentityBinding
  readonly baseRevision: number
  readonly evidence?: RecoveryEvidence
  readonly registry: LimitsRegistry
}
export type LimitsDispatch = {
  readonly status: 'ready' | 'absent' | 'changed' | 'blocked'
  readonly snapshot?: LimitsNamespace
}

class NamespaceLease {
  owners = 0
  registry: LimitsRegistry | undefined
  readonly recovery: LimitRecoveryLatch
  private adapter: PersistenceAdapter | undefined
  private acquiring: Promise<void> | undefined
  private releasing: Promise<void> | undefined
  private deadline: number | undefined
  private fallback = false
  private fallbackResolve!: () => void
  readonly fallbackSignal = new Promise<void>((resolve) => {
    this.fallbackResolve = resolve
  })
  private failureAt: number | undefined
  private retryAt = 0
  private retryDelay = RETRY_MS
  private failureTimer: unknown
  private latestRead: RecoveryRead | undefined
  private adoptedBindings: readonly IdentityBinding[] = []
  private readonly controls = new Map<string, LimitsCommand>()
  projection: string | undefined
  private readonly producerId = randomUUID()

  constructor(
    readonly options: LeaseOptions,
    readonly clock: LimitsClock,
    private readonly dropped: () => void,
  ) {
    this.recovery = new LimitRecoveryLatch(options.log)
  }

  private stopTracking(): void {
    if (this.fallback) return
    this.fallback = true
    this.clock.clearTimeout(this.failureTimer)
    this.fallbackResolve()
    this.options.log(
      'OpenAI limits tracking is unavailable; serving without timed marks for this process.',
    )
    const registry = this.registry
    this.registry = undefined
    this.adapter = undefined
    this.latestRead = undefined
    if (registry) this.releasing = registry.dispose().catch(() => {})
  }

  private wait(delay: number): Promise<void> {
    return new Promise((resolve) =>
      this.clock.setTimeout(resolve, Math.max(0, delay)),
    )
  }

  async bounded<T>(promise: Promise<T>, until: number): Promise<T | undefined> {
    let timer: unknown
    try {
      return await Promise.race([
        promise,
        this.fallbackSignal.then(() => undefined),
        new Promise<undefined>((resolve) => {
          timer = this.clock.setTimeout(
            () => resolve(undefined),
            Math.max(0, until - this.clock.now()),
          )
        }),
      ])
    } finally {
      this.clock.clearTimeout(timer)
    }
  }

  private recordFailure(): void {
    if (!this.registry || this.fallback) return
    const now = this.clock.now()
    if (this.failureAt === undefined) {
      this.failureAt = now
      this.failureTimer = this.clock.setTimeout(
        () => this.stopTracking(),
        FAILURE_RUN_MS,
      )
    }
    this.retryAt = now + this.retryDelay
    this.retryDelay = Math.min(FAILURE_RUN_MS, this.retryDelay * 2)
    if (now - this.failureAt >= FAILURE_RUN_MS) this.stopTracking()
  }

  private recordSuccess(): void {
    this.failureAt = undefined
    this.retryAt = 0
    this.retryDelay = RETRY_MS
    this.clock.clearTimeout(this.failureTimer)
    this.failureTimer = undefined
  }

  private async makeAdapter(): Promise<PersistenceAdapter> {
    const adapter = await this.options.adapter()
    // This observer forwards views and errors unchanged. Envelope interpretation,
    // repair and replacement belong exclusively to common-auth's native adapter.
    return {
      namespace: adapter.namespace,
      read: async (previous) => {
        this.adoptRead()
        if (this.registry && this.clock.now() < this.retryAt)
          throw this.registry.lastFailure ?? new Error('limits-reload-backoff')
        try {
          const view = await adapter.read(previous)
          this.latestRead = this.recovery.capture(view, this.clock.now())
          const adoptable =
            !previous ||
            view.snapshot.generation !== previous.generation ||
            view.snapshot.revision >= previous.revision
          if (view.authoritative && !view.degradedAgreement && adoptable)
            this.recordSuccess()
          else if (!view.authoritative || view.degradedAgreement)
            this.recordFailure()
          return view
        } catch (error) {
          this.recordFailure()
          throw error
        }
      },
      commit: async (commands, previous) => {
        this.adoptRead()
        const result = await adapter.commit(commands, previous)
        this.latestRead = this.recovery.capture(result, this.clock.now())
        return result
      },
      subscribe: adapter.subscribe?.bind(adapter),
    }
  }

  async ready(sourceReady: boolean): Promise<void> {
    if (!sourceReady || this.fallback || this.registry) return
    if (!this.acquiring) {
      this.acquiring = this.acquire().finally(() => {
        this.acquiring = undefined
      })
    }
    await this.acquiring
  }

  private async acquire(): Promise<void> {
    await this.releasing
    this.deadline ??= this.clock.now() + ACQUIRE_MS
    while (!this.fallback && !this.registry) {
      if (this.clock.now() >= this.deadline) {
        this.stopTracking()
        return
      }
      const attempt = (async () => {
        this.adapter ??= await this.makeAdapter()
        return acquireLimitsRegistry({
          adapter: this.adapter,
          clock: this.clock,
          isAccessRestrictive: this.options.isAccessRestrictive,
          onAbandon: () => this.stopTracking(),
          onRejected: (command) => {
            this.controls.delete(
              JSON.stringify([command.producerId, command.operationId]),
            )
          },
        })
      })()
      try {
        const registry = await this.bounded(attempt, this.deadline)
        if (!registry || this.fallback) {
          this.stopTracking()
          void attempt.then((late) => late.dispose()).catch(() => {})
          return
        }
        this.registry = registry
        if (registry.abandoned) {
          this.stopTracking()
          return
        }
        this.adoptRead()
      } catch (error) {
        if (
          error instanceof LimitsEnvelopeConflictError ||
          error instanceof LimitsEnvelopeUnsupportedError
        ) {
          this.stopTracking()
          return
        }
        if (
          error instanceof LimitsPersistenceRefusal &&
          error.code === 'pool-not-ready'
        ) {
          // Readiness may race the caller's projection. An inactive store has
          // not attempted tracking and must not spend the cold-start budget.
          this.deadline = undefined
          this.adapter = undefined
          return
        }
        await this.wait(
          Math.min(RETRY_MS, Math.max(0, this.deadline - this.clock.now())),
        )
      }
    }
  }

  adoptRead(): void {
    const registry = this.current()
    if (
      registry &&
      this.latestRead &&
      this.recovery.adopt(this.latestRead, registry.snapshot)
    ) {
      this.projection = limitsBindingProjection(this.latestRead.view.bindings)
      this.adoptedBindings = this.latestRead.view.bindings
      for (const operation of registry.snapshot.operationIds)
        this.controls.delete(
          JSON.stringify([operation.producerId, operation.operationId]),
        )
    }
  }

  current(): LimitsRegistry | undefined {
    if (this.registry?.abandoned) this.stopTracking()
    return this.registry
  }

  snapshot(): LimitsNamespace | undefined {
    this.adoptRead()
    return this.current()?.snapshot
  }

  enqueue(command: LimitsCommand): void {
    const registry = this.current()
    if (registry) {
      if (command.type !== 'mark')
        this.controls.set(
          JSON.stringify([command.producerId, command.operationId]),
          command,
        )
      registry.enqueue(command)
    } else if (command.type === 'mark') this.dropped()
  }

  dropSignal(): void {
    this.dropped()
  }

  observe(binding: IdentityBinding | undefined): LimitsProbe | undefined {
    this.adoptRead()
    const registry = this.current()
    if (!registry || !binding) return undefined
    return {
      ...registry.observe(binding),
      registry,
      evidence: this.recovery.candidate(binding, this.clock.now()),
    }
  }

  afterProbe(
    probe: LimitsProbe | undefined,
    success: boolean,
    parsedLimit: boolean,
  ): void {
    if (
      !probe?.evidence ||
      !success ||
      parsedLimit ||
      this.current() !== probe.registry
    )
      return
    this.adoptRead()
    const live = probe.registry.snapshot.marks.some(
      (mark) =>
        limitAccountId(mark.key.account) ===
          limitAccountId(probe.binding.account) &&
        mark.entries.some((entry) => entry.until > this.clock.now()),
    )
    if (live || !this.recovery.consume(probe.evidence)) return
    this.enqueue({
      type: 'clear',
      producerId: this.producerId,
      operationId: randomUUID(),
      binding: probe.binding,
      baseRevision: probe.baseRevision,
      keys: [{ scope: { kind: 'pool' }, window: 'account' }],
      cause: 'rate-limit',
      evidenceAt: probe.evidence.evidenceAt,
    })
  }

  dispatchAtBound(expected: IdentityBinding): LimitsDispatch {
    this.adoptRead()
    const snapshot = this.current()?.snapshot
    if (!snapshot) return { status: 'ready' }
    const current = this.adoptedBindings.find(
      (binding) =>
        limitAccountId(binding.account) === limitAccountId(expected.account),
    )
    const controlled = [...this.controls.values()].some(
      (command) =>
        limitAccountId(command.binding.account) ===
        limitAccountId(expected.account),
    )
    const restricted = snapshot.access.some(
      (access) =>
        limitAccountId(access.account) === limitAccountId(expected.account) &&
        this.options.isAccessRestrictive(access.state),
    )
    // After the request's reload budget is spent, the adopted projection can
    // only block dispatch. The request separately checks the current binding.
    return {
      status:
        !current ||
        !isIdentityCompatible(current, expected) ||
        controlled ||
        restricted
          ? 'blocked'
          : 'ready',
      snapshot,
    }
  }

  async release(): Promise<void> {
    if (--this.owners !== 0) return
    await this.acquiring
    if (this.owners !== 0) return
    const registry = this.current()
    this.registry = undefined
    this.clock.clearTimeout(this.failureTimer)
    if (registry) {
      this.releasing = registry.dispose()
      await this.releasing
    }
    this.adapter = undefined
    this.projection = undefined
    this.deadline = undefined
  }
}

/** One bound shared by selection-time and final-send projection reconciliation. */
export class OpenAiLimitsRequest {
  private projectionDeadline: number | undefined
  constructor(private readonly lease: NamespaceLease) {}

  snapshot(): LimitsNamespace | undefined {
    return this.lease.snapshot()
  }

  async reloadForBindings(
    bindings: () => readonly IdentityBinding[],
  ): Promise<void> {
    for (;;) {
      this.lease.adoptRead()
      const registry = this.lease.current()
      if (!registry) return
      const projection = limitsBindingProjection(bindings())
      if (projection === this.lease.projection) return
      this.projectionDeadline ??= this.lease.clock.now() + ACQUIRE_MS
      if (this.lease.clock.now() >= this.projectionDeadline) return
      await this.lease.bounded(registry.reload(), this.projectionDeadline)
      this.lease.adoptRead()
      if (this.lease.clock.now() >= this.projectionDeadline) return
      // A transient read failure cannot spin at a frozen decision clock.
      if (registry.degradedAgreement) return
    }
  }

  async beforeDispatch(
    expected: IdentityBinding | undefined,
    bindings: () => readonly IdentityBinding[],
    accountId = expected?.account.accountId,
  ): Promise<LimitsDispatch> {
    await this.reloadForBindings(bindings)
    const checkCurrent = (): 'ready' | 'absent' | 'changed' => {
      if (!accountId) return 'ready'
      const current = bindings().find(
        (binding) => binding.account.accountId === accountId,
      )
      if (!current) return expected ? 'absent' : 'ready'
      if (
        expected &&
        (limitAccountId(current.account) !== limitAccountId(expected.account) ||
          !isIdentityCompatible(current, expected))
      )
        return 'changed'
      return 'ready'
    }
    let status = checkCurrent()
    if (status !== 'ready') return { status }
    const registry = this.lease.current()
    if (!registry || !expected) return { status: 'ready' }
    if (
      this.projectionDeadline !== undefined &&
      this.lease.clock.now() >= this.projectionDeadline
    )
      return this.lease.dispatchAtBound(expected)
    const deadline =
      this.projectionDeadline ?? this.lease.clock.now() + ACQUIRE_MS
    let view = await this.lease.bounded(
      registry.beforeDispatch(expected),
      deadline,
    )
    if (view?.blocked && this.lease.current()) {
      await this.lease.bounded(registry.reload(), deadline)
      view = await this.lease.bounded(
        registry.beforeDispatch(expected),
        deadline,
      )
    }
    status = checkCurrent()
    if (status !== 'ready') return { status }
    if (!this.lease.current()) return { status: 'ready' }
    this.lease.adoptRead()
    return {
      status: !view || view.blocked ? 'blocked' : 'ready',
      snapshot: view?.snapshot,
    }
  }
}

export class OpenAiLimitsOwner {
  private disposed = false
  constructor(private readonly lease: NamespaceLease) {
    lease.owners++
  }
  get namespace(): string {
    return this.lease.options.namespace
  }
  get registry(): LimitsRegistry | undefined {
    return this.lease.current()
  }
  /** Call only for an owned request, after source readiness has completed. */
  async forRequest(sourceReady: boolean): Promise<OpenAiLimitsRequest> {
    if (this.disposed) throw new Error('limits-owner-disposed')
    await this.lease.ready(sourceReady)
    return new OpenAiLimitsRequest(this.lease)
  }
  snapshot(): LimitsNamespace | undefined {
    return this.lease.snapshot()
  }
  observe(binding: IdentityBinding | undefined): LimitsProbe | undefined {
    return this.lease.observe(binding)
  }
  enqueue(command: LimitsCommand): void {
    this.lease.enqueue(command)
  }
  /** A parsed signal with no bindable account must not become a local mark. */
  dropSignal(): void {
    this.lease.dropSignal()
  }
  afterProbe(
    probe: LimitsProbe | undefined,
    success: boolean,
    parsedLimit = false,
  ): void {
    this.lease.afterProbe(probe, success, parsedLimit)
  }
  async reload(): Promise<void> {
    const registry = this.lease.current()
    if (registry) await registry.reload()
    this.lease.adoptRead()
  }
  async flush(): Promise<void> {
    await this.lease.current()?.flush()
  }
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.lease.release()
  }
}

/** @internal Isolated clocks and adapter factories keep lifecycle tests deterministic. */
export function createLimitsLeaseManager(clock: LimitsClock = defaultClock) {
  const leases = new Map<string, NamespaceLease>()
  let dropped = false
  return {
    acquire(options: LeaseOptions): OpenAiLimitsOwner {
      let lease = leases.get(options.namespace)
      if (!lease) {
        lease = new NamespaceLease(options, clock, () => {
          if (dropped) return
          dropped = true
          options.log(
            'OpenAI limit signal dropped because timed-mark tracking is unavailable.',
          )
        })
        leases.set(options.namespace, lease)
      }
      return new OpenAiLimitsOwner(lease)
    },
  }
}
const processKey = Symbol.for('@cortexkit/openai-auth/limits-leases/v1')
const processState = globalThis as typeof globalThis & {
  [processKey]?: ReturnType<typeof createLimitsLeaseManager>
}
const manager = processState[processKey] ?? createLimitsLeaseManager()
processState[processKey] = manager

export function acquireOpenAiLimits(
  options: OpenAiLimitsOptions,
): OpenAiLimitsOwner {
  const { source } = options
  const namespace =
    source.kind === 'pool'
      ? poolLimitsNamespace(source.configPath, source.statePath)
      : vaultLimitsNamespace(source.rosterPath)
  const log = options.log ?? (() => {})
  return manager.acquire({
    namespace,
    log,
    isAccessRestrictive: options.isAccessRestrictive ?? (() => false),
    adapter: () =>
      source.kind === 'pool'
        ? createPoolLimitsAdapter({
            namespace,
            store: source.store,
            logger: { warn: log },
          })
        : createVaultLimitsAdapter({
            namespace,
            path: source.rosterPath,
            logger: { warn: log },
          }),
  })
}

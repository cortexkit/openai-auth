import {
  applyLimitsCommands,
  createLimitsNamespace,
  type IdentityBinding,
  type LimitsClock,
  type LimitsCommand,
  type LimitsNamespace,
  type LimitsPersistenceSnapshot,
  type PersistenceAdapter,
} from '@cortexkit/common-auth/limits'

export async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

export class TestLimitsClock implements LimitsClock {
  time = 100_000
  private id = 0
  private timers = new Map<number, { at: number; run: () => void }>()
  now = () => this.time
  setTimeout = (run: () => void, delay: number): number => {
    const id = ++this.id
    this.timers.set(id, { at: this.time + delay, run })
    return id
  }
  clearTimeout = (id: unknown): void => {
    this.timers.delete(id as number)
  }
  async tick(ms: number): Promise<void> {
    const target = this.time + ms
    await settle()
    for (;;) {
      const next = [...this.timers]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      this.time = next[1].at
      this.timers.delete(next[0])
      next[1].run()
      await settle()
    }
    this.time = target
    await settle()
  }
}

export function binding(
  namespace: string,
  id = 'a',
  epoch = '1',
): IdentityBinding {
  return {
    account: { namespace, accountId: id, incarnation: epoch },
    credentialEpoch: epoch,
    identity: `wire-${id}`,
  }
}

export function mark(
  binding: IdentityBinding,
  until: number,
  evidenceAt: number,
  baseRevision = 0,
): LimitsCommand {
  return {
    type: 'mark',
    binding,
    until,
    evidenceAt,
    baseRevision,
    producerId: 'test',
    operationId: `${binding.account.accountId}-${until}-${evidenceAt}`,
    mergeLaw: 'max-until',
    cause: 'rate-limit',
    scope: { kind: 'pool' },
    window: 'account',
  }
}

export function memoryAdapter(namespace: string, clock: TestLimitsClock) {
  const state = {
    snapshot: createLimitsNamespace(
      namespace,
      'generation-1',
    ) as LimitsNamespace,
    bindings: [binding(namespace)],
    authoritative: true,
    reads: 0,
    commits: 0,
    commands: [] as LimitsCommand[],
    error: undefined as unknown,
    beforeRead: undefined as (() => Promise<void>) | undefined,
    beforeCommit: undefined as (() => Promise<void>) | undefined,
  }
  const view = (): LimitsPersistenceSnapshot => ({
    snapshot: state.snapshot,
    bindings: state.bindings,
    authoritative: state.authoritative,
  })
  const adapter: PersistenceAdapter = {
    namespace,
    async read() {
      state.reads++
      await state.beforeRead?.()
      if (state.error) throw state.error
      return view()
    },
    async commit(commands) {
      state.commits++
      state.commands.push(...commands)
      await state.beforeCommit?.()
      const result = applyLimitsCommands(state.snapshot, commands, {
        now: clock.now(),
        bindings: state.bindings,
        authorizeEpoch: (a, b) => a.credentialEpoch === b.credentialEpoch,
      })
      state.snapshot = result.snapshot
      return { ...view(), outcomes: result.outcomes }
    },
  }
  return { state, adapter, view }
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

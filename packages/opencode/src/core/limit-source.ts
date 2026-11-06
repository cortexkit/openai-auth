import {
  type AccountKey,
  createSessionActivityStore,
  type IdentityBinding,
  type LimitsNamespace,
  sameAccount,
} from '@cortexkit/common-auth/limits'
import {
  acquireOpenAiLimits,
  type OpenAiLimitsOwner,
  type OpenAiLimitsRequest,
  type OpenAiVault,
  vaultLimitsBinding,
} from '@cortexkit/openai-auth-core/internal'
import type { PoolAccountSource } from './pool-account-source'
import {
  settlesWithin,
  VAULT_FIRST_ROSTER_WAIT_MS,
} from './pool-account-source'

/** Reuse one request deadline; a later readiness step never starts a new wait. */
export async function withinVaultDeadline<T>(
  deadline: number,
  run: () => Promise<T>,
): Promise<T | undefined> {
  const remaining = deadline - performance.now()
  if (remaining <= 0) return undefined
  let value: T | undefined
  await settlesWithin(
    run().then((result) => {
      value = result
    }),
    remaining,
  )
  return value
}

export interface OpenCodeLimitSourceOptions {
  pool: PoolAccountSource
  vault: Pick<
    OpenAiVault,
    'authority' | 'enrolled' | 'awaitRequestRoster' | 'snapshot' | 'routes'
  > & { paths: Pick<OpenAiVault['paths'], 'rosterPath'> }
  log?: (message: string) => void
}

/** Shared request readiness and custody selection for both OpenCode hosts. */
export class OpenCodeLimitSource {
  readonly activity = createSessionActivityStore()
  private vaultOwner: OpenAiLimitsOwner | undefined
  private disposed = false
  private disposal: Promise<void> | undefined

  constructor(private readonly options: OpenCodeLimitSourceOptions) {}

  async forRequest(
    vaultDeadline = performance.now() + VAULT_FIRST_ROSTER_WAIT_MS,
  ): Promise<OpenAiLimitsRequest | undefined> {
    if (this.disposed) return undefined
    const authority = this.options.vault.enrolled()
      ? await withinVaultDeadline(vaultDeadline, () =>
          this.options.vault.authority(),
        )
      : await this.options.vault.authority()
    if (this.disposed || !authority || authority === 'unreadable')
      return undefined
    if (authority === 'local') return this.options.pool.limitsForRequest()
    return withinVaultDeadline(vaultDeadline, () =>
      this.vaultRequest(vaultDeadline),
    )
  }

  private async vaultRequest(
    deadline: number,
  ): Promise<OpenAiLimitsRequest | undefined> {
    await this.options.vault.awaitRequestRoster()
    if (this.disposed || performance.now() >= deadline) return undefined
    // Enrollment can change while discovery runs. Never acquire a local store
    // on the vault path, even if discovery returns no usable routes.
    if ((await this.options.vault.authority()) !== 'vault') return undefined
    if (this.disposed || performance.now() >= deadline) return undefined
    if (
      !this.options.vault.snapshot() ||
      !this.options.vault.routes().some((route) => route.kind === 'oauth')
    )
      return undefined
    this.vaultOwner ??= acquireOpenAiLimits({
      source: {
        kind: 'vault',
        rosterPath: this.options.vault.paths.rosterPath,
      },
      log: this.options.log,
    })
    const request = await this.vaultOwner.forRequest(true)
    if (this.disposed || performance.now() >= deadline) return undefined
    await request.reloadForBindings(() => this.ownershipBindings())
    return request
  }

  owner(): OpenAiLimitsOwner | undefined {
    return this.options.vault.enrolled()
      ? this.vaultOwner
      : this.options.pool.limitsOwner()
  }

  bindings(): IdentityBinding[] {
    if (this.disposed) return []
    const vault = this.options.vault
    const owner = this.vaultOwner
    if (vault.enrolled()) {
      if (!owner) return []
      const active = new Set(
        vault
          .routes()
          .filter((route) => route.kind === 'oauth')
          .map((route) => route.id),
      )
      return (vault.snapshot()?.rows ?? []).flatMap((row) =>
        active.has(row.routeId)
          ? [vaultLimitsBinding(owner.namespace, row)]
          : [],
      )
    }
    return this.options.pool.limitsBindings()
  }

  /**
   * Registry reloads compare persisted OAuth ownership, not route eligibility.
   * Rows excluded from routing remain in the roster the registry reads. Omitting
   * those rows from this comparison would cause repeated reloads of unchanged
   * ownership. Only bindings() filters routable accounts, and an empty route
   * set never starts registry readiness.
   */
  ownershipBindings(): IdentityBinding[] {
    if (this.disposed) return []
    if (!this.options.vault.enrolled())
      return this.options.pool.limitsBindings()
    const owner = this.vaultOwner
    return owner
      ? (this.options.vault.snapshot()?.rows ?? [])
          .filter((row) => row.credentialType === 'oauth')
          .map((row) => vaultLimitsBinding(owner.namespace, row))
      : []
  }

  accountKey(accountId: string): AccountKey | undefined {
    return this.bindings().find(
      (binding) => binding.account.accountId === accountId,
    )?.account
  }

  marks(): Map<string, number> {
    const bindings = this.bindings()
    return bindings.length
      ? projectOpenCodeMarks(this.owner()?.snapshot(), bindings)
      : new Map()
  }

  forget(sessionId: string): void {
    this.activity.forgetSession(sessionId)
  }

  /** Release limits before the caller closes its pool store or vault consumer. */
  dispose(): Promise<void> {
    this.disposed = true
    this.disposal ??= (async () => {
      await this.vaultOwner?.dispose()
      await this.options.pool.dispose()
    })()
    return this.disposal
  }
}

/** A detached view, never a second writable timed-mark authority. */
export function projectOpenCodeMarks(
  snapshot: LimitsNamespace | undefined,
  bindings: readonly IdentityBinding[],
  now = Date.now(),
): Map<string, number> {
  const marks = new Map<string, number>()
  for (const binding of bindings) {
    for (const mark of snapshot?.marks ?? []) {
      if (mark.key.scope.kind !== 'pool' || mark.key.window !== 'account')
        continue
      if (!sameAccount(binding.account, mark.key.account)) continue
      for (const entry of mark.entries) {
        if (
          entry.until > now &&
          entry.until > (marks.get(binding.account.accountId) ?? 0)
        )
          marks.set(binding.account.accountId, entry.until)
      }
    }
  }
  return marks
}

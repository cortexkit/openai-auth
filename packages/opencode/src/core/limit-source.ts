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

  async forRequest(): Promise<OpenAiLimitsRequest | undefined> {
    if (this.disposed) return undefined
    const authority = await this.options.vault.authority()
    if (this.disposed || authority === 'unreadable') return undefined
    if (authority === 'local') return this.options.pool.limitsForRequest()
    await this.options.vault.awaitRequestRoster()
    if (this.disposed) return undefined
    // Enrollment can change while discovery runs. Never acquire a local store
    // on the vault path, even if discovery returns no usable routes.
    if ((await this.options.vault.authority()) !== 'vault') return undefined
    if (!this.options.vault.snapshot()) return undefined
    this.vaultOwner ??= acquireOpenAiLimits({
      source: {
        kind: 'vault',
        rosterPath: this.options.vault.paths.rosterPath,
      },
      log: this.options.log,
    })
    const request = await this.vaultOwner.forRequest(true)
    await request.reloadForBindings(() => this.bindings())
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
      const active = new Set(vault.routes().map((route) => route.id))
      return (vault.snapshot()?.rows ?? []).flatMap((row) =>
        active.has(row.routeId)
          ? [vaultLimitsBinding(owner.namespace, row)]
          : [],
      )
    }
    return this.options.pool.limitsBindings()
  }

  accountKey(accountId: string): AccountKey | undefined {
    return this.bindings().find(
      (binding) => binding.account.accountId === accountId,
    )?.account
  }

  marks(): Map<string, number> {
    return projectOpenCodeMarks(this.owner()?.snapshot(), this.bindings())
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

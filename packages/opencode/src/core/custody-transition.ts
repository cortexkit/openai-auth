import { createHash } from 'node:crypto'
import type { AccountStorage } from './accounts.ts'

export type ClaustrumMode = 'local' | 'claustrum'

export type CustodyTransitionState = {
  manifestRevision: string
  storeGeneration: string
  fingerprints: {
    main?: string
    fallbacks: Record<string, string>
  }
}

export function custodySlotFingerprint(
  access: string,
  refresh: string,
): string {
  const accessBytes = Buffer.from(access, 'utf8')
  const refreshBytes = Buffer.from(refresh, 'utf8')
  const accessLength = Buffer.allocUnsafe(4)
  const refreshLength = Buffer.allocUnsafe(4)
  accessLength.writeUInt32BE(accessBytes.length)
  refreshLength.writeUInt32BE(refreshBytes.length)
  return createHash('sha256')
    .update(accessLength)
    .update(accessBytes)
    .update(refreshLength)
    .update(refreshBytes)
    .digest('hex')
}

export function accountStoreGeneration(
  storage: Pick<AccountStorage, 'accounts'>,
): string {
  const rows = storage.accounts
    .filter((account) => account.type === 'oauth')
    .map((account) => ({
      id: account.id,
      enabled: account.enabled !== false,
      accountId: account.accountId ?? '',
      access: account.access ?? '',
      refresh: account.refresh,
      expires: account.expires ?? null,
    }))
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    )

  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

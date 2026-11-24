import {
  formatQuota,
  isQuotaMap,
  projectQuota,
} from '@cortexkit/common-auth/quota'
import { redactStrings } from '@cortexkit/openai-auth-core/internal'

export function piQuotaStatusText(
  label: string,
  position: number,
  identity: string | undefined,
  quota: unknown,
  now: number,
): string {
  // Menu labels can be emails or contain provider identity or credential data.
  const safeLabel =
    !label ||
    /[@\p{Cc}]/u.test(label) ||
    (identity && label.includes(identity)) ||
    redactStrings(label) !== label
      ? `account ${position}`
      : label
  const limits = isQuotaMap(quota)
    ? quota.limits.filter(
        ({ scope, label }) =>
          scope === 'all' && (label === 'primary' || label === 'secondary'),
      )
    : []
  return `${safeLabel} · ${formatQuota(projectQuota({ limits }), { now })}`
}

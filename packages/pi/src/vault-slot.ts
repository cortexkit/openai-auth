import { join } from 'node:path'
import { openPiSlot, type PiSlot } from '@cortexkit/common-auth/pi-slot'
import { vaultStateDir } from '@cortexkit/openai-auth-core/internal'
import { getAgentDir } from '@earendil-works/pi-coding-agent'

/**
 * Pi reads this non-secret API-key placeholder from auth.json while the vault
 * serves. Unlike an OAuth entry, it needs no refresh; it is never sent upstream.
 */
export const VAULT_PLACEHOLDER_KEY = 'openai-auth-vault-mode-not-a-credential'

export const VAULT_SLOT_REFUSAL =
  'Request refused locally: Pi has not loaded the credential vault placeholder. Reopen the session or disconnect Pi from the vault in /openai; local credentials are not used while connected.'

export function openVaultSlot(statePath: string): PiSlot {
  return openPiSlot({
    authPath: join(getAgentDir(), 'auth.json'),
    provider: 'openai-codex',
    // Keep the old path so common-auth can delete any legacy credential copy.
    stashPath: join(vaultStateDir(statePath), 'pi-openai-codex-login.json'),
    placeholderKey: VAULT_PLACEHOLDER_KEY,
  })
}

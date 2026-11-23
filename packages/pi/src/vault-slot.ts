import { join } from 'node:path'
import { openPiSlot, type PiSlot } from '@cortexkit/common-auth/pi-slot'
import { vaultStateDir } from '@cortexkit/openai-auth-core/internal'
import { getAgentDir, VERSION } from '@earendil-works/pi-coding-agent'

/**
 * Pi uses this non-secret API-key placeholder while the vault serves.
 * Unlike an OAuth entry, it needs no refresh; it is never sent upstream.
 */
export const VAULT_PLACEHOLDER_KEY = 'openai-auth-vault-mode-not-a-credential'

export const VAULT_SLOT_REFUSAL =
  'Request refused locally: Pi has not loaded the credential vault placeholder. Reopen the session or disconnect Pi from the vault in /openai; local credentials are not used while connected.'

let warnedMissingBridge = false

export async function installHostedVaultKey(registry: object): Promise<void> {
  // Pi resolves stored OAuth before the configured provider key. Use its
  // in-memory credential override so it does not refresh the saved login.
  const runtime = 'runtime' in registry ? registry.runtime : undefined
  if (
    runtime &&
    typeof runtime === 'object' &&
    'setRuntimeApiKey' in runtime &&
    typeof runtime.setRuntimeApiKey === 'function'
  ) {
    await runtime.setRuntimeApiKey('openai-codex', VAULT_PLACEHOLDER_KEY)
    return
  }
  if (!warnedMissingBridge) {
    warnedMissingBridge = true
    console.warn(
      `Pi ${VERSION} does not expose the in-memory credential override. Hosted OpenAI Codex requests with an expired native login may not reach the vault.`,
    )
  }
}

export function openVaultSlot(statePath: string): PiSlot {
  return openPiSlot({
    authPath: join(getAgentDir(), 'auth.json'),
    provider: 'openai-codex',
    // Keep the old path so common-auth can delete any legacy credential copy.
    stashPath: join(vaultStateDir(statePath), 'pi-openai-codex-login.json'),
    placeholderKey: VAULT_PLACEHOLDER_KEY,
  })
}

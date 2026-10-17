import type { VaultGrantReach } from '@cortexkit/common-auth/claustrum'

/**
 * The hint for a connected host the vault serves no account, when the vault
 * did not say what this host is granted (a vault from before it reported
 * grants, or nothing listed yet).
 */
export const VAULT_EMPTY_ACCESS_HINT =
  'No ChatGPT login in the vault has the `openai-native` category, or the grant is missing. Check `ck auth status` for categories and `ck auth grant` for the grant.'

/**
 * The `ck` command that lets a host read the vault's OpenAI logins, exactly as
 * docs/vault.md ("Connecting a host") and the Connect instructions print it.
 * `name` is the host's enrollment name, for example `openai-auth-opencode`.
 */
export function vaultGrantCommand(name: string): string {
  return `ck auth grant --principal enrolled:${name} --selector-kind category --selector openai-native --operation read`
}

/** The fix when a grant exists but reaches no login (logins lacking the category). */
export const VAULT_RECLASSIFY_COMMAND = 'ck auth reclassify --from-registry'

/**
 * Why the vault serves this host no account, and the exact fix. The vault
 * tells the two causes apart only when it reports this host's grants:
 * `grants === 0` means there is no grant at all, while `grants > 0` means a
 * grant that matches no login. When it does not report them (`reach`
 * undefined), the general hint naming both causes is kept.
 */
export function vaultEmptyAccessHint(
  name: string,
  reach: VaultGrantReach | undefined,
): string {
  if (reach === undefined) return VAULT_EMPTY_ACCESS_HINT
  if (reach.grants === 0)
    return `The vault has no grant letting ${name} read OpenAI accounts. Grant it with \`${vaultGrantCommand(name)}\`.`
  return `The vault's grant for ${name} reaches no ChatGPT login: no login has the \`openai-native\` category. \`${VAULT_RECLASSIFY_COMMAND}\` fills empty category sets from the vault's defaults; then check the CATEGORIES column with \`ck auth status\`.`
}

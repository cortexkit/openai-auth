# Claustrum vault

[Claustrum](https://github.com/cortexkit/claustrum) is CortexKit's local credential vault. It keeps your logins and refreshes them in one place, so no plugin holds a refresh token. The OpenAI accounts held in the vault can serve OpenCode and Pi in place of your own accounts.

## Connecting a host

Each host enrolls under its own name, `openai-auth-opencode` for OpenCode and `openai-auth-pi` for Pi, so either can be revoked alone. OpenCode 1 and OpenCode 2 share the `openai-auth-opencode` enrollment and its files.

**Connect** (in the `opencode auth login` menu, the Vault section of `/openai`, or the Vault section of Pi's `openai` command) proposes the enrollment and tells you what to run:

```text
Enrollment request <id> for openai-auth-opencode is waiting for approval. Approve it with:
  ck auth enroll approve --request-id <id>
and let it read your OpenAI accounts with:
  ck auth grant --principal enrolled:openai-auth-opencode --selector-kind category --selector openai-native --operation read
```

Pi shows the same commands with `openai-auth-pi`, and tells you when the approval lands.

The token the vault then issues is kept owner-only in `openai-auth-vault/` next to the account state file. **Disconnect** forgets it.

The Vault section of `/openai` shows whether this host is connected, the OpenAI accounts the vault serves it, and the last error. Each vault account can be disabled (it stays listed and is never sent from this host) or enabled again; on Pi, disabling applies to Pi alone.

## Activating an enrolled OpenCode host

An enrolled host also offers **ChatGPT accounts in the vault** in `/login openai` and `opencode auth login`. It needs no browser or ChatGPT sign-in and creates no local account: OpenCode stores only the plugin's non-routable placeholder, so requests can use the vault.

On OpenCode 1, activation requires an empty `openai` slot in `auth.json`; any existing record, malformed JSON or unreadable file is refused without changing it. A missing file on a fresh install is allowed. Enrollment is checked again when activation completes; invalid or unreadable enrollment is refused. Vault activation does not create a main account.

For OpenCode 2, see [OpenCode 2](opencode-2.md#vault-only-hosts).

## Vault mode

While the host holds a vault token (vault mode), the vault's accounts are the only ones used:

- They route through the same [routing modes and limits](accounts-and-routing.md) as local accounts.
- Each request fetches its token from the vault, and a token the provider rejects is reported back to the vault.
- No local account (a pool row, OpenCode's slot login, Pi's own login) is sent with, refreshed, polled or warmed, and the local pool files are left exactly as they are.
- The sidebar, `/openai` and the `opencode auth login` menu list the vault accounts only.
- A request no vault account can serve (the vault is unreachable, or serves no usable account) is refused locally, naming the cause and the remedy: connect accounts in the vault, or disconnect this host from the vault.

Disconnect ends vault mode: the local accounts serve again at once, with nothing to migrate.

### OpenCode's login slot in vault mode

In vault mode a login written into OpenCode's own `openai` slot stays there, unused, and nothing moves into the [account pool](accounts-and-routing.md#the-account-pool): neither the move of an install that has not migrated yet nor the adoption of a later login runs. Once the host disconnects, the slot login is adopted into the pool (on the next request, or within about a minute) and an unmigrated install migrates. An install that has not migrated is still served from the vault in vault mode; a login through OpenCode 2's own sign-in on such an install is refused until the host disconnects.

Do not delete the slot value as a repair: OpenCode 1 needs its OAuth placeholder to install the plugin's fetch.

### Pi in vault mode

On Pi, use `openai-codex/<model>` in both local and vault mode. Before Pi reloads auth, the plugin saves Pi's original `auth.json` login in an owner-only stash under its vault state directory and puts a non-secret placeholder in Pi's `auth.json`, so Pi cannot refresh that login while the vault serves. Disconnect restores the original entry before forgetting Pi's vault token. If another Pi login was added while connected, disconnect reports a conflict and keeps both that login and the stashed original without overwriting either.

## API keys in the vault

Static OpenAI API keys held in the vault (`apikey:openai`) are not used: they are never listed, read or routed. Every request this plugin sends goes to the ChatGPT Codex endpoint, which takes ChatGPT logins, not platform API keys, so only the vault's OpenAI logins serve.

## Leftovers from earlier versions

An install that used the vault custody of earlier versions may still hold its tombstones (in accounts, or in OpenCode's slot) and the `claustrum.mode` setting. They are never sent; the auth doctor lists them, with the remedy: connect the vault, or sign in to the account again.

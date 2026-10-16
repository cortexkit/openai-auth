# Claustrum vault

[Claustrum](https://github.com/cortexkit/claustrum) is CortexKit's local credential vault. It keeps your logins and refreshes them in one place, so no plugin holds a refresh token. The OpenAI accounts held in the vault can serve OpenCode and Pi instead of separately stored local logins.

## Connecting a host

Each application enrolls under its own name, `openai-auth-opencode` for OpenCode and `openai-auth-pi` for Pi, so either can be revoked alone. OpenCode versions 1 and 2 share the `openai-auth-opencode` enrollment and its files.

**Connect** (in `opencode auth login`, the Vault section of the plugin's [`/openai` slash-command menu](commands.md#the-openai-command), or Pi's `openai` menu) sends an enrollment request for the vault owner to approve with the vault's [`ck` command-line tool](https://github.com/cortexkit/claustrum). It prints the approval and account-access commands:

```text
Enrollment request <id> for openai-auth-opencode is waiting for approval. Approve it with:
  ck auth enroll approve --request-id <id>
and let it read your OpenAI accounts with:
  ck auth grant --principal enrolled:openai-auth-opencode --selector-kind category --selector openai-native --operation read
```

Pi's commands identify its separate enrollment, `openai-auth-pi`, instead of OpenCode's. Pi reports when the vault owner approves its request.

After approval, the vault issues a token authorizing OpenCode or Pi to use the vault, not a ChatGPT login. It is stored owner-only in `openai-auth-vault/` next to the account state file. **Disconnect** removes the local token and enrollment-state file, not the vault's accounts or approved enrollment. OpenCode 1 and 2 share this connection, so disconnecting OpenCode affects both; disconnecting Pi affects only Pi.

The Vault section of `/openai` shows OpenCode's connection, available OpenAI accounts and last error. Disabling an account prevents OpenCode from using it without deleting it from the vault; Pi's menu controls Pi separately.

## Activating an enrolled OpenCode host

After enrollment, choose **ChatGPT accounts in the vault** in `/login openai` or `opencode auth login` to use logins already held by the vault. This opens no browser and creates no local ChatGPT account. OpenCode stores only a **placeholder**, a non-secret login marker that enables the plugin's vault routing rather than supplying a real ChatGPT token.

On OpenCode 1 (the 1.x series), activation requires an empty `openai` entry in `auth.json` (its login slot). Any existing record, malformed JSON or unreadable file is refused without changing it; a missing file on a fresh install is allowed. Enrollment is checked again when activation completes.

For OpenCode 2's vault activation command and login method, see [Vault-only hosts](opencode-2.md#vault-only-hosts).

## Vault mode

While OpenCode or Pi holds a vault token (**vault mode**), its requests use only vault accounts:

- They route through the same [routing modes and limits](accounts-and-routing.md) as local accounts.
- Each request fetches its token from the vault, and a token the provider rejects is reported back to the vault.
- No local account (a pool row, OpenCode's slot login, Pi's own login) is sent with, refreshed, polled or warmed, and the local pool files are left exactly as they are.
- On OpenCode 1, the sidebar, `/openai` and the `opencode auth login` menu list vault accounts only.
- A request no vault account can serve is refused locally. The request error explains the cause and remedy: make accounts available in the vault, or disconnect the affected OpenCode or Pi installation.

Disconnecting OpenCode makes its local pool eligible again; disconnecting Pi restores its local login and fallbacks. OpenCode may still need to transfer its old slot login into the pool, as described below.

### OpenCode's login slot in vault mode

In OpenCode's vault mode, real logins in OpenCode 1's `openai` slot stay unused. Neither the initial main login nor later replacements are transferred from that slot into the [account pool](accounts-and-routing.md#the-account-pool). After OpenCode disconnects, the slot login moves into the pool on the next request or a periodic check, within about a minute. Use the vault login method while connected; [OpenCode 2's browser and headless pool logins](opencode-2.md#signing-in) refuse to add local credentials until OpenCode disconnects.

Do not delete OpenCode 1's placeholder as a repair: OpenCode 1 installs the plugin's request handler (its custom `fetch`) only for a provider with an OAuth login. The placeholder supplies that login record without a real token.

### Pi in vault mode

On Pi, use `openai-codex/<model>` in both local and vault mode. Before Pi reloads auth, the plugin saves Pi's original `auth.json` login in an owner-only stash under its vault state directory and puts a non-secret placeholder in Pi's `auth.json`, so Pi cannot refresh that login while the vault serves. Disconnecting Pi restores the original entry before removing Pi's vault token. If another Pi login was added while connected, disconnect reports a conflict and keeps both that login and the stashed original without overwriting either.

## API keys in the vault

Static OpenAI API keys held in the vault (`apikey:openai`) are not used: they are never listed, read or routed. Every request this plugin sends goes to the ChatGPT Codex endpoint, which takes ChatGPT logins, not platform API keys, so only the vault's OpenAI logins serve.

## Leftovers from earlier versions

Earlier vault integrations replaced local credentials with **tombstones**, non-secret markers that are not usable logins. These can remain in account rows or OpenCode's slot, along with an old `claustrum.mode` setting; they are never sent or refreshed. **Auth doctor**, the credential diagnostics in `opencode auth login`, lists them and suggests connecting OpenCode to the vault or signing in again.

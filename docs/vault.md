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

The grant reaches only vault logins that carry the `openai-native` category, for both `openai-auth-opencode` and `openai-auth-pi`. Check the CATEGORIES column with `ck auth status`. A login added before the vault assigned categories shows none; `ck auth reclassify --from-registry` fills every empty category set from the vault's defaults, without removing any category. To add the category to one login, run `ck auth set-category <credential-id> --add openai-native`.

Pi's commands identify its separate enrollment, `openai-auth-pi`, instead of OpenCode's. Pi reports when the vault owner approves its request.

Errors that reconnecting cannot fix stop immediately rather than reconnecting or waiting for approval. If Connect reports `unknown_method`, update the Claustrum vault to a version that supports connecting plugins before trying again. Protocol/configuration refusals are not evidence that a ChatGPT credential is gone and do not delete accounts or ask them to sign in again.

After approval, the vault issues a token authorizing OpenCode or Pi to use the vault, not a ChatGPT login. It is stored owner-only in `openai-auth-vault/` next to the account state file. For OpenCode that folder is in the plugin's state folder by default, `~/.local/state/cortexkit/openai-auth/opencode/openai-auth-vault/` (see [Where the files live](configuration.md#where-the-files-live)); versions before this one kept it in OpenCode's config folder, and the plugin moves it once with the state file, without changing the enrollment. For Pi it is in Pi's agent directory. **Disconnect** removes the local token and enrollment-state file, not the vault's accounts or approved enrollment. OpenCode 1 and 2 share this connection, so disconnecting OpenCode affects both; disconnecting Pi affects only Pi.

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
- The OpenCode sidebar lists vault accounts only, including accounts that need sign-in or are unavailable. It keeps their last quota reading and shows your `/openai` on/off choice separately from the vault's state. A **blocked** account is below its configured quota floor and will not route. On OpenCode 1 and 2, `/openai` lists vault accounts only. On OpenCode 1, the `opencode auth login` menu does too.
- A request no vault account can serve is refused locally. The request error explains the cause and remedy: make accounts available in the vault, or disconnect the affected OpenCode or Pi installation.

### When the vault serves no account

When the vault lists no OpenAI account for OpenCode or Pi, the request error, Connect and the Vault section of the menu name the cause and the exact fix, as long as the vault reports what the application is granted:

- **No grant.** Nothing lets the application read your OpenAI accounts. Run the grant command from [Connecting a host](#connecting-a-host), for example `ck auth grant --principal enrolled:openai-auth-opencode --selector-kind category --selector openai-native --operation read` (with `openai-auth-pi` for Pi).
- **A grant that reaches no login.** The grant exists, but no login in the vault has the `openai-native` category. Run `ck auth reclassify --from-registry`, which fills only empty category sets from the vault's defaults, then check the CATEGORIES column with `ck auth status`.

An older vault does not report grants. The message then names both checks: the categories with `ck auth status`, and the grant with `ck auth grant`.

In vault mode, "main" in the **Main first** and **Fallback first** routing modes means the vault's default OpenAI account, `chatgpt:openai`; see [routing](accounts-and-routing.md#routing).

Routing → **Set order** shows the vault accounts by the same names as Accounts (email first) and changes this host's vault roster. This works on OpenCode 1, OpenCode 2 and Pi, including unavailable or disabled roster rows. It never reorders the local pool; other local-account actions remain refused while connected. Stale account names or route ids from the other mode are refused without writing an order.

Insula background quota includes its `credits` spend pool as well as usage windows, workspace spending limits and saved resets, so [prepaid-credit routing](accounts-and-routing.md#prepaid-credits) need not wait for a model request. Credits keep Insula's fetch time. An absent credits pool preserves the prior reading without renewing it. Insula's `unlimited` boolean is used when present. Older builds omit it: a balance-less pool then preserves a known unlimited reading; without one it is shown as available credits, not unlimited. An explicit `false` does replace a prior unlimited verdict.

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

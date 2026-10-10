# Vault-mode menu action audit

Vault enrollment is exclusive: once this host has a vault enrollment token approved by the operator, local account management is unavailable. `readVaultMenu` reads that enrollment state through the vault client, even when the vault daemon is offline. The Accounts section instead says: **Accounts are managed in the vault with ck. Disconnect to use local accounts.** This is read-only text, not a selectable action.

This inventory covers the `@cortexkit/common-auth` 0.13.0 builders installed under `packages/core/node_modules/@cortexkit/common-auth/dist` and the OpenCode/Pi host sections. Version 0.13.0 is the shared-menu release required by all three package manifests. A setting may still live in the plugin's config file; that does not make it a local account or credential mutation. Vault account creation, sign-in and removal belong to `ck`, not this plugin.

## Complete action inventory

| Surface / section | Reachable action (ID) | Classification in vault mode | Disposition |
| --- | --- | --- | --- |
| OpenCode and Pi `/openai`: Accounts | Add account (`add`) | OAuth login and local pool add/credential replacement | Hidden; stale apply refused |
| Both: Accounts row | Enable / Disable (`enable`, `disable`) | Local pool row enablement | Hidden; stale apply refused |
| Both: Accounts row | Move (`move`) | Local pool roster reorder | Hidden; stale apply refused |
| Both: Accounts row | Remove (`remove`) | Deletes a local row and credential | Hidden; stale apply refused |
| Both: Quota | Check now / Check this account (`check`) | Vault quota polling; the connected implementation never invokes the host's local quota checker | Retained for routable vault accounts |
| Both: Routing | Change mode (`mode`) | Plugin routing preference | Retained |
| Both: Routing | Set order (`order`) | Local pool roster reorder, not a routing preference | Hidden; stale apply refused |
| Both: Limits | Turn killswitch on/off (`killswitch`) | Plugin setting | Retained |
| Both: Limits row | Set floors (`floors`), including clearing floors with empty inputs | Plugin killswitch floors keyed by vault route ID | Retained for vault rows; stale local-row apply refused |
| OpenCode: Cache | Turn keep-warm on/off (`enabled`) | Plugin setting | Retained |
| OpenCode: Cache | Turn subagent warming on/off (`subagents`) | Plugin setting | Retained |
| OpenCode: Cache | Turn sustain on/off (`sustain`) | Plugin setting | Retained |
| OpenCode: Cache | Set/clear warm window (`window`) | Plugin setting | Retained |
| OpenCode: Diagnostics | Turn request dumps on/off (`dump`) | Plugin setting | Retained |
| OpenCode: Diagnostics | Set log level (`logging`) | Plugin setting | Retained |
| OpenCode: Reset credits row | Preview / Spend a reset credit / Retry last redemption (`preview`, `spend`, `retry`) | Uses a local reset target; can refresh local credentials or persist a local quota reading. This is not a vault reset API | Hidden; stale apply refused without resolving a target |
| Both: This session | Clear sticky pin (`clear-pin`) | Plugin session state | Retained |
| Both: Vault | Connect (`connect`) / Disconnect (`disconnect`) | Host vault enrollment/token management | Retained as appropriate for enrollment state |
| Both: Vault row | Enable / Disable on this host (`enable`, `disable`) | Consumer's vault route accept/decline interlock, not local pool enablement | Retained |
| Pi: Pi login | No actions; stored quota display only | Read-only display; `/login` is a separate Pi command | No action to hide |
| Terminal `opencode auth login`: account menu | Add account (`add-account`) | OAuth login and local pool add/credential replacement | Hidden; stale selection refused |
| Terminal | Re-authenticate account (`reauthenticate`) | Local credential replacement | Hidden; stale selection refused |
| Terminal | Remove account (`remove-account`) | Local account/credential deletion | Hidden; stale selection refused |
| Terminal | Enable or disable account (`toggle-account`) | Local pool row enablement | Hidden; stale selection refused |
| Terminal | Check quotas (`check-quotas`) | Vault polling while enrolled; local polling/recording only when disconnected | Retained |
| Terminal | Auth doctor (`doctor`) and nested Apply repair confirmations | Inspects local credentials and may restore the host slot, prune orphan state, or clear refresh backoff | Hidden, including before pool migration; stale selection refused |
| Terminal | Delete all accounts (`delete-all`) | Deletes unprotected local rows/credentials | Hidden; stale selection refused |
| Terminal | Connect to the Claustrum vault (`vault-connect`) | Vault enrollment | Retained |
| All menus | Cancel, back, escape; confirmation decline | UI navigation, no mutation | Unchanged |

There is no dialog-level re-authenticate, delete-all or repair action in the installed shared command builder. Those actions are terminal-menu actions. `Auth current` is not a separate action in the installed builder: it is represented by Re-authenticate account. `Apply repairs` is nested under Auth doctor, not a standalone top-level option. The direct browser/headless/API-key auth methods, Pi `/login`, and the existing vault placeholder auth method are outside these menus and are not changed here.

## Enforcement and compatibility

- `packages/core/src/vault-command-menu.ts` filters section actions during construction, suppresses vault-row account actions, replaces Routing to omit local reorder, and suppresses the local Reset credits section before its builder runs. It checks current enrollment at apply and returns error code `vault-local-action` with the message “Nothing was changed: accounts are managed in the vault with ck. Disconnect to use local accounts.” This prevents local account, order, reset and local-floor choices captured before enrollment from running afterward.
- `packages/core/src/vault-account-menu.ts` retains only vault quota polling and the caller's vault enrollment action while connected. Every captured local action checks enrollment again before execution.
- `packages/opencode/src/auth/methods.ts` opens the vault terminal menu even without a migrated local pool or a local credential; it does not fall through to local login or the pre-migration doctor. Its connected status callback does not load legacy local accounts.
- Disconnection uses the original local menu builders, login input validation, confirmations, locks and protections. Tests compare complete Accounts/Routing models on Pi and the full non-Vault model on OpenCode against the original local menu.

The previous reset-label test and its two mutation rows verified that local reset targets were still listed with labels explaining that they were not serving requests. Those checks were retired deliberately: offering local reset targets, even with warning labels, violates exclusive vault mode. The replacement test and mutation prove those actions are absent. Existing reset refusal assertions now require the fixed vault refusal rather than a later missing-token error; terminal quota selections now select the first action because local management options are no longer present.

## Verification record

All required gates ran on Linux with Bun 1.4.2: `bun run types` (TypeScript 7.0.2, all three packages), `bun run lint` and `bun run format:check` (Biome 2.5.15, 233 files), `bun run build` (three packages; 26 installed dependency ranges and 6 package manifests checked), and `bun run test` (core 167 passed; OpenCode 1,464 passed / 22 skipped; Pi 38 passed; zero failures). The 22 skips are the suite's existing environment-gated cases. `ckdev-mutate check` passed using the available runner, version 0.9.8.

The three changed vault test files also passed under Bun 1.3.14 (OpenCode 67 tests and Pi 13 tests). Each of the following new mutation rows ran separately under both Bun 1.3.14 and Bun 1.4.2. Every unmutated named test passed; every deliberate break was **CAUGHT**, with exactly its named test failing and zero collateral failures. Other tests were filtered, not broadly replayed during a mutation.

| Mutation row | What its deliberately broken guard exposes |
| --- | --- |
| `menu-vault-accounts-no-add` | OpenCode local OAuth add action |
| `menu-vault-accounts-no-row-writes` | Local enable/disable, move and remove actions |
| `menu-vault-routing-no-reorder` | Local roster ordering |
| `menu-vault-reset-no-local-actions` | Local reset-credit targets |
| `menu-vault-stale-local-apply` | Loss of the explicit fixed stale-dialog refusal |
| `menu-vault-terminal-no-local-actions` | Local terminal account management and doctor |
| `menu-vault-terminal-stale-local-apply` | OAuth starting from a stale terminal add choice |
| `menu-pi-vault-accounts-no-add` | Pi local OAuth add action |
| `menu-vault-terminal-no-local-login-fallback` | Local login fallback despite enrollment |
| `menu-vault-terminal-no-premigration-doctor` | Local doctor before pool migration despite enrollment |
| `menu-vault-terminal-no-local-status-read` | Legacy local account reads in connected status |

Bun 1.3.14 was downloaded as Linux verification tooling and transferred through the worktree because the remote runner cannot fetch dependencies and resets its home directory for each job. Each older-runtime replay provisioned `$HOME/.local/share/mise/installs/bun/1.3.14/bin` and set `PATH` to that directory; the reported version was checked. Temporary tooling was removed before delivery. No package manifests or lockfiles changed.

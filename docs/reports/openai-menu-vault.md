# Vault-aware `/openai` menu verification

## Implementation and safety

Accounts, Quota and Limits use common-auth's replacement slots, keeping their ids and order. Local account operations still delegate to the built-in menu over the real local roster; synthetic vault rows cannot enter a local reorder or account write. Vault floors delegate to the built-in settings writer using the **vault route id**.

The existing auth-login menu implementation now lives in `packages/core/src/vault-account-menu.ts`, shared with the command menu. Ownership comes from `vault.identities()`, not from whether an account currently routes. Cold and declined vault accounts therefore still set aside their local copies. Enabled, active vault routes come from `vault.routes()`; their labels, state and quota come from the vault roster. A quota check uses `vault.pollQuota`. Host-wide checks that already poll the vault do not poll it twice.

The supplied base had no reusable quota-age renderer in the implementation (although ARCHITECTURE.md described an age display). The new shared formatter is used by both the auth-login quota display and the command replacements. It considers the oldest actual window reading and marks readings older than fifteen minutes. Per the disconnected-output compatibility requirement, the disconnected command still uses the original built-in output, including its old naming and quota formatting. Connected means an approved enrollment.

### Reset investigation: safe to label, no credential changes

On a migrated OpenCode install, the resolver first calls its pool access dependency (`packages/opencode/src/index.ts:549-551`), wired to `poolSource.rowAccess` at `:3093-3097`. `rowAccess` uses `accessFor` (`packages/opencode/src/core/pool-account-source.ts:1032`):

- Token preparation skips a vault-owned local row (`:700-710`). It does **not** refresh that row.
- `usableToken` refuses a vault-owned row (`:758-770`), even when its local access token is still valid.
- `rowAccess` returns the row with **no token**, not an absent pool result. The resolver therefore takes `poolResetTarget`, which throws `token_unavailable` at `packages/opencode/src/index.ts:491`; it does not fall through to the legacy refresh resolver.
- Preview calls the resolver before usage or credit requests (`packages/core/src/commands.ts`, `buildResetPreviewRow`). Spend calls preview, or the resolver for retry/in-flight state (`spendResetCredit`); the redemption coordinator resolves again before any credit consumption (`packages/core/src/reset-credits.ts:950`, `:1031-1036`). All these paths refuse the shadowed row before using a bearer.

The added integration test covers preview, spend and retry for both an expired and a live shadowed local credential. All six calls refuse; no refresh or usage request is added and the credential state file remains byte-identical. Only reset labels changed. No vault account was added to reset, and no reset token handling or redemption logic changed. Pi has no reset section.

### Floors already apply to vault accounts

OpenCode 1 applies `killswitchPassesPolicy` to every target with the non-main target's id (`packages/opencode/src/core/pool-request.ts:279-287`). OpenCode 2 does the same (`packages/opencode/src/v2/adapter.ts:425-433`), as does Pi (`packages/pi/src/pool-request.ts:157-165`). Vault targets use their vault route id, so the menu reads and sets `killswitch.accounts[routeId]`. The menu also displays effective inherited floors using the existing `getKillswitchThresholdsForAccount`, without materializing them into local account files.

Request routing, token refresh, vault send/authorization and reset redemption sources are unchanged.

## Red assertions and mutation controls

Before replacing the production menu, the new tests produced these failures against the original menu implementation:

| Behaviour | Failing assertion |
| --- | --- |
| Accounts/count/ownership | Expected to contain `3 account(s) can route, 2 local row(s) set aside.`; received `2 account(s), 2 enabled.` |
| Quota roster | Expected `['main', 'ufuk', 'vault:chatgpt-main', 'vault:chatgpt-ufuk', 'vault:chatgpt-live']`; received `['main', 'ufuk']` |
| Stale quota | Expected to contain `quota read 3d ago`; received `primary 93% left` |
| Naming | Expected `main`; received `chatgpt-main` |
| Cold/declined ownership | Expected to contain `1 account(s) can route, 2 local row(s) set aside.`; received `2 account(s), 2 enabled.` |
| Vault quota polls | Expected the three vault route ids in the poll log; received `[]` |
| Vault floor edit | Expected `result.ok` to be `true`; received `false` (vault route action unavailable) |
| Reset label | Expected to contain `set aside (served by vault beatricelau0414@gmail.com)`; received `Main account` |

Additional controlled regressions produced these assertions:

- Pi without shared vault wiring: expected `['local', 'vault:oauth:openai:work~4d2b77a79f']`; received `['local']`.
- Dependency restored to the old range: expected `^0.11.7`; received `^0.11.4`.
- Local actions using synthetic roster ids: expected move `result.ok === true`; received `false`.
- Duplicate host-wide quota polls: expected each of two vault route ids once; received both twice.
- Disconnected replacement fence removed: the exact pinned text changed from `2 account(s), 2 enabled.` to `2 account(s) can route, 0 local row(s) set aside.`, and the unlabelled row and old quota formatting changed.

Disconnected compatibility and existing reset refusal are preserved properties, not changes that should fail on main. The disconnected literal assertion already passed before implementation. Its non-vacuity control above proves that the pinned output notices accidental replacement. The reset integration test proves the existing safe path rather than changing it to match new redemption behaviour.

All twelve new catalogue controls were replayed individually with Bun 1.4.2 on Linux. Each run executed exactly its named test: one failure, no other failures, with the other tests filtered out. Before each mutation the live files were staged and `git diff --stat` was empty; during each mutation it showed one file changed, one insertion and one deletion; after `git checkout -- <path> && touch <path>` it was empty again. `ckdev-mutate 0.9.5 check` validates the entire catalogue, including existing anchors. The Pi wiring anchor includes the preceding `store` line because `vault: pool.vault` also occurs in its Vault extra.

## Verification

- Installed common-auth 0.11.7 locally with Bun 1.4.2; all three manifests require `^0.11.7`. Frozen install on Linux checked 481 installs across 583 packages with no changes.
- TypeScript 7.0.2: `bun run types` passed for all three packages (`tsc`, configured with `noEmit`).
- Biome 2.5.15: `bun run lint` passed, 222 files checked.
- `ckdev-mutate 0.9.5 check`: all anchors and exact test names verified.
- Linux core suite: 166 passed, 0 failed, 12 files.
- Linux OpenCode suite after build: 1388 passed, 18 skipped; the packaging suite could not initialize because remote `tar` returned `Cannot open: Function not implemented`. The same error occurred with native `/tmp`; no production change was made for this runner limitation. An initial attempt before remote build also correctly refused missing build artifacts.
- Linux Pi suite: 30 passed, 0 failed, 3 files.
- `bun run build` passed on Linux and locally (local artifacts were needed for the real-host tests); installed-ranges checked 24 dependencies, local-dependency guard checked 4 manifests.
- Per the brief, the real-host suites ran locally in `packages/opencode`: `OPENAI_AUTH_OPENCODE1_E2E=1 bun test src/tests/opencode1-e2e.test.ts` passed 1 test; `OPENAI_AUTH_OPENCODE2_E2E=1 bun test src/tests/opencode2-e2e.test.ts` passed 13 tests. Linux cannot perform their network install.
- The failed remote packaging target was checked once locally against the same local build: `bun test src/tests/opencode2-packaging.test.ts`, 5 passed, 0 failed. This additional local exception is specifically the remote tar syscall limitation, not a substitute for the Linux behavioural suites.
- Sidekick reviewed comments in seven requested files; unclear comments about ownership, read projections and delegated actions were clarified.

## Rendered connected example

Fixture: two shadowed local rows and three active vault accounts, including one vault-only account. The main identity's local and vault quota reading is three days old. These are deterministic test identities, not operator credentials. The dump directory is the Linux runner's test-process default.

```text
## OpenAI accounts

### Accounts
3 account(s) can route, 2 local row(s) set aside.
- main: OAuth · enabled · chatgpt-main · primary 93% left · set aside (served by vault beatricelau0414@gmail.com) · quota read 3d ago
- ufuk: OAuth · enabled · chatgpt-ufuk · primary 15% left · set aside (served by vault gmail)
- beatricelau0414@gmail.com: Vault · login · active · enabled · primary 93% left · quota read 3d ago
- gmail: Vault · login · active · enabled · primary 15% left
- live: Vault · login · active · enabled · primary 15% left

### Quota
Scope: all.
- main: primary 93% left · set aside (served by vault beatricelau0414@gmail.com) · quota read 3d ago
- ufuk: primary 15% left · set aside (served by vault gmail)
- beatricelau0414@gmail.com: primary 93% left · quota read 3d ago
- gmail: primary 15% left
- live: primary 15% left

### Routing
Mode: Main first.
Roster order: main, ufuk.

### Limits
Killswitch: off.
With the killswitch on, an account whose quota falls below one of its floors is not used.
- main: no floors · set aside (served by vault beatricelau0414@gmail.com)
- ufuk: no floors · set aside (served by vault gmail)
- beatricelau0414@gmail.com: no floors
- gmail: no floors
- live: no floors

### Cache
Cache keep-warm is not available in this process.

### Diagnostics
Request dumps: off, written to /motor-home/tmp/opencode-openai-auth-dumps.
Log level: info.

### Reset credits
A reset credit restores an exhausted account's quota. Preview fetches the account's current quota and credits.
- Main account · set aside (served by vault beatricelau0414@gmail.com)
- ufuk · set aside (served by vault gmail)

### This session
No current session.

### Vault
OpenCode (openai-auth-opencode): connected to the Claustrum vault.
The vault serves 3 OpenAI accounts; 3 can route now.
- beatricelau0414@gmail.com: login, active, enabled
- gmail: login, active, enabled
- live: login, active, enabled

Open the OpenCode TUI to change these settings.
```

## Rendered disconnected example

The same local store, with no approved vault enrollment. This output is pinned byte-for-byte (the environment-dependent dump directory is interpolated from the settings, not derived from the rendered menu).

```text
## OpenAI accounts

### Accounts
2 account(s), 2 enabled.
- chatgpt-main: OAuth · enabled · chatgpt-main · primary 93% left
- ufuk: OAuth · enabled · chatgpt-ufuk · primary 15% left

### Quota
Scope: all.
- chatgpt-main: primary 93% left
- ufuk: primary 15% left

### Routing
Mode: Main first.
Roster order: main, ufuk.

### Limits
Killswitch: off.
With the killswitch on, an account whose quota falls below one of its floors is not used.
- chatgpt-main: no floors
- ufuk: no floors

### Cache
Cache keep-warm is not available in this process.

### Diagnostics
Request dumps: off, written to /motor-home/tmp/opencode-openai-auth-dumps.
Log level: info.

### Reset credits
A reset credit restores an exhausted account's quota. Preview fetches the account's current quota and credits.
- Main account
- ufuk

### This session
No current session.

### Vault
OpenCode (openai-auth-opencode): not connected to the Claustrum vault.

Open the OpenCode TUI to change these settings.
```

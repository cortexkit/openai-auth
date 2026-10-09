# Vault-aware `/openai` menu verification

## Implementation and safety

Accounts, Quota and Limits use common-auth's replacement slots, keeping their ids and order. Local account operations still delegate to the built-in menu over the real local roster; synthetic vault rows cannot enter a local reorder or account write. Vault floors delegate to the built-in settings writer using the **vault route id**.

The existing auth-login menu implementation now lives in `packages/core/src/vault-account-menu.ts`, shared with the command menu. Ownership comes from `vault.identities()`, not from whether an account currently routes. Cold and declined vault accounts therefore still set aside their local copies. Enabled, active vault routes come from `vault.routes()`; their labels, state and quota come from the vault roster. A quota check uses `vault.pollQuota`. Host-wide checks that already poll the vault do not poll it twice.

The supplied base had no reusable quota-age renderer in the implementation (although ARCHITECTURE.md described an age display). The new shared formatter is used by both the auth-login quota display and the command replacements. It considers the oldest actual window reading and marks readings older than fifteen minutes. The disconnected command retains its original quota formatting. Unlabelled local rows display their local account id with or without a vault object, while recorded identity details and labelled rows remain unchanged. Connected means an approved enrollment.

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

At the initial delivery, disconnected compatibility and existing reset refusal were preserved properties, not changes that should fail on main. The original test comparing the entire disconnected menu with expected literal text already passed before implementation. The naming revision updates exactly the three unlabelled `main` names in that expected text; every other character stays exact. Its non-vacuity control still proves that accidental replacement changes the account count and quota-age output. The reset integration test proves the existing safe path rather than changing it to match new redemption behaviour.

At the initial delivery, all twelve new catalogue controls were replayed individually with Bun 1.4.2 on Linux. Each run executed exactly its named test: one failure, no other failures, with the other tests filtered out. Before each mutation the live files were staged and `git diff --stat` was empty; during each mutation it showed one file changed, one insertion and one deletion; after `git checkout -- <path> && touch <path>` it was empty again. `ckdev-mutate 0.9.5 check` validates the entire catalogue, including existing anchors. The Pi wiring anchor includes the preceding `store` line because `vault: pool.vault` also occurs in its Vault extra.

## Initial verification

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

The same local store, with no approved vault enrollment. The test compares this entire expected output byte-for-byte. Compared with the original disconnected output, only the unlabelled account names change: `main` replaces its raw ChatGPT identity in Accounts, Quota and Limits. Recorded identity details, quota text, headings, counts, section order and every other line remain unchanged. The environment-dependent dump directory is interpolated from settings, not derived from the rendered menu. The normalization is a read-only openai-auth menu view, not a common-auth or account-file change.

```text
## OpenAI accounts

### Accounts
2 account(s), 2 enabled.
- main: OAuth · enabled · chatgpt-main · primary 93% left
- ufuk: OAuth · enabled · chatgpt-ufuk · primary 15% left

### Quota
Scope: all.
- main: primary 93% left
- ufuk: primary 15% left

### Routing
Mode: Main first.
Roster order: main, ufuk.

### Limits
Killswitch: off.
With the killswitch on, an account whose quota falls below one of its floors is not used.
- main: no floors
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

## Naming-only revision

Unlabelled rows now use their local account id in every command menu, including an unenrolled vault and a context with no vault object at all. This resolves the previously conflicting naming and disconnected-compatibility requirements. The expected disconnected text above changes only the three `chatgpt-main` item names to `main`; the recorded identity in the Accounts detail still reads `chatgpt-main`. Quota formatting, account counts, actions and all other rendered text remain unchanged.

The display normalization runs in openai-auth's read-only menu-store adapter before any vault-specific projection. It neither changes common-auth nor writes a label into the account files. The no-vault-object test additionally compares both local files before and after opening the menu; Pi has its own disconnected-name test.

Before this revision's implementation, the revised full-output assertion failed with exactly three changed lines: expected `main` in Accounts, Quota and Limits, received `chatgpt-main`. The new no-vault-object assertion independently failed with `Expected: "main"; Received: "chatgpt-main"`.

The local-name catalogue anchor was re-anchored to the shared label assignment. The disconnected-output control now names the revised test, and a new `menu-unlabelled-without-vault` control guards the absent-vault branch. All catalogue anchors and exact test names pass `ckdev-mutate 0.9.5 check` after these updates. Three controls were replayed on Linux with Bun 1.4.2, each running exactly one named test, with one failure and fourteen other tests filtered out:

- `menu-local-id-name`: restoring identity-first naming failed `an unlabelled local is named by its roster id when connected` (`Expected: "main"; Received: "chatgpt-main"`).
- `menu-unlabelled-without-vault`: returning the unformatted store view failed `unlabelled rows use their ids even without a vault object` with the same assertion.
- `menu-no-vault-output`: forcing disconnected replacement sections failed `disconnected output is byte-identical apart from unlabelled row names`; names remained `main`, but the count and quota-age text changed.

For all three, the live files were held in the index before mutation. `git diff --stat` was empty before, showed one file changed with one insertion and one deletion during the break, and was empty after `git checkout -- <path> && touch <path>`. The restored OpenCode menu suite passed all fifteen tests; the Pi vault suite passed all twelve.

Revision gates (Linux unless noted):

- TypeScript 7.0.2: `bun run types`, all three packages passed with `noEmit` configured.
- Biome 2.5.15: `bun run lint`, 222 files checked with no changes.
- `ckdev-mutate 0.9.5 check`: all catalogue anchors and exact test names verified. The initial moved one-line naming anchor failed with `ANCHOR_MISSING`; it was fixed to the formatted label assignment before the passing run.
- `bun run build`: passed; 24 dependency ranges and four local manifests checked.
- Core suite: 166 passed, zero failures, twelve files.
- Pi suite: 31 passed, zero failures, three files.
- Full OpenCode suite: 1387 passed, eighteen skipped, three failures. One was the known remote tar `Function not implemented` packaging initialization error. Two unchanged tests also failed in this full run: `BackgroundQuotaRefresh > two concurrent ticks against a real lock file refresh only once` observed zero calls at its 100 ms deadline, and `auth account menu with vault accounts > auth menu Check quotas polls vault accounts into roster and skips shadowed locals` observed an extra `Bearer main-token` poll. Both tests passed when rerun in isolation on Linux (two passed, zero failures); neither was changed to fit the failure.
- The revised OpenCode build and packaging target were checked once locally because of the existing remote tar limitation: five passed, zero failures, nine expectations. Real-host e2e tests were not repeated for this naming-only follow-up; their prior successful results above belong to the initial delivery.
- Comment review covered the six revised files; the explanation of display-only names and disconnected expected text was clarified.

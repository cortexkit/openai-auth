# Dead-code inventory — October 2026

Inventory taken before editing, against `b1e9a4c82f7522a34d68f085957b42c6a65a514a` (1.0.2).
The pool store, vault consumer and shared account menu now come from
`@cortexkit/common-auth`. An unused export is not necessarily unused code.

## Evidence rules

- The AFT static-analysis tool (`aft_inspect`) reports 10 dead symbols and 45 unused exports. Exact-name searches
  across the repository (including tests and scripts) found only definitions for
  the 10 dead symbols. Callgraph callers, with tests included, confirm zero callers
  for `pollPoolRowsOnce`, `addPoolAccount`, `disablePoolAccount`,
  `removeAllPoolAccountsExceptMain`, `formatPoolDeleteAll`, `swapPoolAccounts`,
  `formatAuthDoctorReport`, `setAsideDetail` and `poolFormat`;
  `enablePoolAccount` was checked lexically because its graph query was busy;
  `removePoolAccount` has only the dead delete-all helper as its caller.
- The package manifests export OpenCode's root, server, TUI and TUI preferences,
  and Pi's root, not arbitrary source files. Neither entry re-exports the deleted
  helpers. No dynamic import, string-key dispatch or re-export names them; the
  exact-name search includes non-TypeScript files as well as TypeScript.
- `packages/opencode/scripts/build-tui.ts:10-47` builds the import closure of
  `src/tui.tsx`; it no longer has a separately maintained shared-file list. None
  of the deleted symbols is in that closure through an import or barrel export.
- `packages/core/src/tests/export-manifest.ts` is the authoritative root/internal
  export list, enforced by `export-manifest.test.ts`. The deleted core helpers
  are not in it. Shared primitives added below must be recorded there.
- Source line references below describe the baseline, not post-deletion offsets.
  Callgraph evidence is checked against lexical references because method
  dispatch and type-only imports are not reliable dead-code signals.

## Deletions and migration boundary

| Symbol or file | Why it looks dead / replacement | Evidence and exception check | Verdict |
| --- | --- | --- | --- |
| OpenCode `core/pool-accounts.ts`: `pollPoolRowsOnce` | Old standalone menu quota poll; shared menu uses store readings | Zero callers; exact-name search only definition; not an entry/TUI/manifest export | Delete |
| Same: `addPoolAccount`, `PoolLogin`, `PoolAddOutcome` | Superseded by common-auth account-menu login/store add/replace | Only definitions and references inside dead add helper | Delete |
| Same: `disablePoolAccount`, `enablePoolAccount`, `POOL_USER_DISABLED_REASON`, `poolDuplicateIdentityRefused` | Common-auth account-menu/store handles row writes and duplicate identity errors | No external references; helper calls form only this dead cluster | Delete |
| Same: `removeAllPoolAccountsExceptMain`, `formatPoolDeleteAll`, `PoolRemoveAllOutcome`, `poolRosterIds`, `swapPoolAccounts`, `SWAP_ATTEMPTS` | Common-auth account-menu handles removal/reorder | No external references; roster reader is used only by dead remove-all/swap | Delete |
| Same: `removePoolAccount`, `PoolRowOutcome`, `isFailure` | Common-auth menu invokes store.remove directly with the host protection callback | Only caller is dead remove-all; `commands.ts:438` and `auth/methods.ts:391` use `poolRemovalRefusal` instead | Delete |
| Same: `poolRemovalRefusal`, `POOL_MAIN_REMOVAL_REFUSED`, `poolTransferRemovalRefused` | Looks adjacent to dead menu code but protects live writes | `commands.ts:438`, `auth/methods.ts:391` pass it to common-auth; protects main and pending transfer | Keep: migration of OpenCode's OAuth login slot and protection of its main account |
| Same: `openAccountPool`, `poolMigrated`, `migratedPoolRows`, `poolSettingsLocks`, legacy lock options | Host still opens/reads the migrated store and passes settings extra locks | `index.ts:110-115`, commands and auth menu imports; lock coordination is not obsolete | Keep |
| OpenCode `auth/doctor.ts:411`: `formatAuthDoctorReport` | Old formatted terminal report; common-auth menu renders findings/actions | Zero callers, exact-name search only definition; tests call createAuthDoctorReport | Delete; retain doctor construction and repairs |
| Core `vault-account-menu.ts:97`: `setAsideDetail`, `SET_ASIDE` | Old mixed local/vault listing; connected menu deliberately does not read local store | Zero callers; not root/internal export manifest; SET_ASIDE only used here | Delete |
| Pi `pool-source.ts:209`: `poolFormat` | Old config discriminator; current source trusts store.read and initializes on its result | Zero callers, exact-name search only definition; no entry export | Delete |
| Core `accounts.ts`: `_clampPercent`, captured `_setRefreshLockRenewalTimeout` / `_clearRefreshLockRenewalTimeout` | Unreferenced remnants of old refresh implementation | TypeScript unused hints; exact-name repository search only definitions; no manifest entries | Delete |
| Core `FallbackAccountManager` and legacy fallback roster | Pool path supersedes selection, but legacy request/background paths still exist | internal manifest; index.ts:2152-2176 constructs it and pauses it for vault/pool; :4532-4592 seeds/ticks legacy only when pool inactive; refresh-all-quota calls refreshAccount | Keep: supported pre-pool execution |
| Core `saveAccounts` and raw-roster preservation | No production callers of exported full writer; tests exercise lossless legacy writes | internal manifest and accounts-store tests (including load-dropped entries); mutateAccounts shares preservation | Keep: used test seam/invariant, not delete-only coverage |
| Core `migrateIfNeeded`, load/config/state normalization, placeholder/tombstone recognition | Pre-pool formats still require reading/adoption | accounts.ts:1964-2057 slot-to-roster migration; pool migration and host slot use recognized marker values | Keep: 0.11 → 1.x support |
| Core/common-auth refresh-file-lock and legacy locks in pool migration | Old refreshers may still be running during upgrade | refreshPoolRow holds legacy extra locks; transfer adoption coordinates the host slot | Keep: cross-version lock ordering |
| OpenCode `BackgroundQuotaRefresh`, `refreshMainWithLease` | Pool path has its own refresher, not proof the legacy branches never execute | background-quota-refresh.ts:114-147 has pool branch; index.ts:2614-2625 calls slot refresh and resolves pooled main on MainAccountInPoolError; :2191-2199 and :3190-3197 wire quota/reset deps | Keep: pool polling and pre-pool execution; no migration path removed |
| OpenCode version fence | Could look like old-host bookkeeping | pool migration refuses unsafe old writers before moving credentials | Keep unchanged |

## Remaining unused-export hints

These are live implementations, not dead runtime code. Keep them rather than
turning a caller-count hint into a deletion. They are not newly exposed by this
change.

| Symbols (paths relative to package src) | Evidence | Verdict |
| --- | --- | --- |
| OpenCode auth/doctor `readRetiredCustodyMode`, `findStoredMainCredential` | Internal calls at doctor.ts:163,327,369; retired mode informs repairs | Keep: doctor runtime |
| OpenCode commands `parseCacheKeepWindow` | commands.ts:272 parses menu input | Keep: runtime |
| OpenCode background-quota-refresh `runUnderBackgroundLease` | Calls at :76,137 | Keep: runtime lease |
| OpenCode host-slot `opencodeAuthIsEnvBacked` | Calls at :328,340 | Keep: supported slot handling |
| OpenCode pool-account-source `POOL_TOKEN_MIN_VALIDITY_MS`, `POOL_PULL_RETRY_MS`, `quotaReadAt` | Source-local token/poll/reading policy | Keep: runtime |
| Both sources `oauthAccess` | Source-local credential projection, duplicated exactly | Fold into core |
| OpenCode pool-sidebar `sidebarQuotaFromPoolMap` | Calls at :105,129,142 | Keep: sidebar projection |
| OpenCode process-heartbeat `processHeartbeatDir` | Calls at :36,95 construct the directory used to write process heartbeats; version-fence has a separate same-named reader helper | Keep: live process heartbeat writer |
| OpenCode sticky-routing `MIN_WEIGHT` | Used at :249,253 after eligibility filtering | Keep: legacy routing runtime |
| OpenCode dump `DUMP_SECRET_KEYS`, `DUMP_SCHEMA_KEYS`, `bodySummary` | dump.ts:104-106 passes them into dump utility | Keep: diagnostic runtime |
| OpenCode v2 adapter `DEFAULT_LIMIT_MARK_MS`, `limitOfEvent` | Calls at :335,906 | Keep: OpenCode 2 runtime |
| OpenCode v2 codex-wire `responsesLiteHttpBody`, endpoint `codexBaseURL`, login `POOL_HEADLESS_METHOD` | Calls at :233, :15, :115 respectively | Keep: OpenCode 2 runtime |
| OpenCode v2 pins `MAX_SESSION_PINS` | Constructor default at :43; host-specific eviction bound | Keep |
| Pi main-account `MAIN_PULL_RETRY_MS` | Poll throttle at :148 | Keep |
| Pi paths `getPiConfigDir`, `getPiAccountStoragePath`, `getPiAccountStatePath` | Paths compose one another at :17,22,30,32 | Keep |
| Pi pool-source `POOL_READ_BUDGET_MS`, `POOL_PULL_RETRY_MS` | Source-local read/poll limits | Keep |
| Pi runtime `FIRST_READING_WAIT_MS`, `blockedMessage` | Calls at :728,628 | Keep |
| Actual test seams: resetSettingsForTest, ttlForModel, __resetProcessHeartbeatForTest, resetDumpStateForTest, resetModelCostsForTest, resetNotificationsForTest, setPiStickyRouting, sidebar test setters/readers/drain, boot quota/menu accessors, resetOAuthStateForTest, logger flush/reset | Named tests import these; export manifest includes core seams | Keep: tests actually use them |

## Duplication inventory

| Symbol/file pair | Evidence / host differences | Verdict |
| --- | --- | --- |
| OpenCode pool-account-source / Pi pool-source: oauth projection, refresh failure backoff, refreshBackoffFor | Identical credential shape and provider-vs-local failure policy (:265-279 / :189-203, :913-979 / :746-812); source-local maps/loggers remain host-owned | Fold pure primitives into core |
| Same: pending observations, account identity key, file freshness key | Identical bounded pending queue and stat key; each host still owns its snapshot/lifecycle | Fold primitives into core |
| Same: startRead, storeFor, refresh/write authority | Similar syntax but tightly coupled to source snapshots, migration/initialization, vault authority and provider hooks | Keep host methods; do not merge different lifecycle contracts |
| OpenCode pool-request / Pi pool-request: killswitch map (per-row remaining-quota floor verdict) | Identical windows projection and main-row threshold choice (:303-315 / :157-169) | Fold into core; retain sending, vault marks and refresh policy adapters |
| OpenCode v2/pins / Pi routing: placement shape and place algorithm | Same isPinValid/pendingBytesForPins logic; OpenCode updates LRU and evicts, Pi owns a process-local unbounded map | Fold decision algorithm/type into core with host-owned persistence callback |
| OpenCode raw-ws-bun / raw-ws-node / Pi raw-ws-node | Frame syntax overlaps, but sockets, upgrade handshake, event/error/close lifecycle and host adapter interfaces differ | Keep separate: runtime APIs differ; no transport behavior change |
| Other inspector duplicates (OAuth errors, legacy fixture, sidebar budget, commands) | Outside pool/host folding scope or intentionally simulating old writers | Keep |

## Tests, mutation catalogue and verification

No test imports any deleted helper. No deletion-only test needs removal; all
legacy migration, roster-preservation, fence, refresh, menu and host tests stay.
The internal export manifest will gain only the shared primitives, not lose a
kept legacy/test export. The deliberate source replacements in `mutations.toml`
do not target the deleted helpers;
validate the entire catalogue with `ckdev-mutate check` after extraction and
re-anchor any moved target if validation identifies one.

## Outcome

The deletion commit removes the orphaned menu helpers; the extraction commit
moves shared reader state into `pool-source-state.ts`, pin placement into
`pool-session-pins.ts`, and request floor verdicts into `pool-routing.ts`.
Migration of 0.11.x config/state and the OpenCode login slot, legacy refresh-lock
coordination, placeholder/tombstone recognition, the version fence and the test
accessors listed above all remain. No baseline behavior test was removed or weakened.
Six direct shared-state tests were added. The export manifest gained the shared
values/types only.

All 223 existing deliberate source replacements in `mutations.toml` still match
their intended source text (the anchors) and name existing tests;
none targeted a deleted or moved statement, so no removal/re-anchor was needed.
A 224th control guards the extracted pending-reading credential-epoch check.

### Line counts against the baseline

`git diff b1e9a4c --numstat -- packages` counts physical lines, including comments
and the added test/manifest entries. Gross removals include host copies moved to
core; net change includes their single shared implementation.

| Package | Lines removed | Lines added | Net reduction |
| --- | ---: | ---: | ---: |
| Core | 39 | 417 | -378 (shared implementation and tests added) |
| OpenCode | 609 | 39 | 570 |
| Pi | 258 | 36 | 222 |
| Total | 906 | 492 | 414 |

Excluding the 126 new test lines and 12 new manifest lines, runtime-source net
reduction is 552 lines. No packaging or dependency manifest/lockfile changed.

### Gates

All build/test/lint commands ran on the Linux build server with eight vCPUs
(`linux,8c`). The fresh npm install additionally enabled network access
(`linux,8c,net`). Versions: Bun 1.4.2, TypeScript 7.0.2, Biome 2.5.15,
ckdev-mutate 0.12.0, Node 24.21.0, npm 11.19.0.

- `bun run build`: passed all three packages, declarations and TUI build
  (134 generated TUI files); installed-range gate checked 26 dependencies and
  local-dependency gate checked six manifests.
- `bun run types`: passed all three package TypeScript checks.
- `bun run lint`: passed, 256 files checked.
- `bun run test`: core 231 passed in 18 files; OpenCode 1,529 passed, 26 skipped
  in 88 files (including packaging tests); Pi 74 passed in six files. Zero
  failures. The opt-in real-host tests were then enabled separately.
- `OPENAI_AUTH_OPENCODE1_E2E=1 OPENAI_AUTH_OPENCODE2_E2E=1 bun test
  packages/opencode/src/tests/opencode1-e2e.test.ts
  packages/opencode/src/tests/opencode2-e2e.test.ts`: 22 passed, zero failures.
- `ckdev-mutate check`: all 224 catalogue anchors and exact test names passed.
- Fresh consumer: `npm pack --ignore-scripts` for both host packages, followed
  by `npm install --ignore-scripts --no-audit --no-fund <both tarballs>` into
  an empty project (253 packages installed). Plain Node with no inherited
  `NODE_PATH`/`NODE_OPTIONS` imported OpenCode root/server and Pi root: three
  imports passed. npm warned that the latest allowed `@opentui/core` requires
  Node >=26.4.0; imports still passed on Node 24.21.0. TUI runtime packaging is
  additionally covered by the existing suite.
- The AFT static inspector after extraction was partial: its graph of callers
  for this worktree was unavailable, so dead-code/duplicate analysis could not
  complete. Its local host diagnostics did not recognize the newly exported core
  members. Remote build/types and exact export-manifest tests passed; these
  compiler/test gates are authoritative, not that inconsistent analyzer view.

### Non-vacuity of the moved epoch guard

The live files were staged and `git diff --stat` was empty. Replacing the
credential-epoch predicate in `packages/core/src/pool-source-state.ts` with
`false || // NON-VACUITY BREAK` produced one file changed, one insertion and one
deletion. Running the six direct shared-state tests failed only
`shared pool source state > does not replay a reading onto a replaced credential epoch`.
The five other tests passed (the last checks retry times only for rows lacking
a bearer that the host can send a request with):

- `projects OAuth credentials and leaves absent credentials empty`
- `bounds the queue and reapplies readings before persistence catches up`
- `does not replay a reading onto another identity or after its lifetime`
- `distinguishes provider backoff from a short local lock retry`
- `reports backoff only for rows the host cannot currently send with`

The first test was initially named "projects OAuth credentials and does not invent
API-key access"; it was renamed to describe its actual absent-credential assertion,
not a claim to test API-key credentials. No test name from the baseline commit changed.
`git checkout -- packages/core/src/pool-source-state.ts && touch
packages/core/src/pool-source-state.ts` restored the file; `git diff --stat` was
empty again. The restored six-test run passed with zero failures.

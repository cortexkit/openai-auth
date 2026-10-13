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
| OpenCode | 652 | 359 | 293 |
| Pi | 258 | 36 | 222 |
| Total | 949 | 812 | 137 |

Excluding test files and `export-manifest.ts`, runtime-source net reduction is
524 lines after the stability follow-up below. No packaging or dependency
manifest/lockfile changed.

### Initial single-run gates

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

## Stability follow-up

The original single green suite did not establish order independence. Review
found intermittent full-suite failures, so the follow-up first measured the
exact reviewed trees without changing source, assertions or deadlines.

### Paired measurement

Base: `47a7fae77bca2a89e835be4c940ec584352c25c9`.
Candidate: `efe09c1a99d04d8f0374534eb928fad422cb6d0a` (the cleanup merged on
that base, plus the reviewer's comment-only changes). These Git commits were
checked out only in the isolated worker checkout, leaving the operator's main
checkout untouched. The worker's task branch was restored afterward.

Each run used Linux with eight vCPUs, Bun 1.4.2, no additional environment, and
this command from the repository root:

```sh
bun install --frozen-lockfile && bun run build && cd packages/opencode && bun test
```

Order was base 1, candidate 1, base 2, candidate 2, through pair 6. Every
install/build passed. Complete output and the assertion/predecessor dump are
kept outside Git at
`~/.local/state/cortexkit/evidence/openai-auth/dead-code-stability-2026-10/`.
The adjacent `SHA256SUMS` manifest identifies the archived bytes; the evidence
hash table below cites the files used in this report. The preceding test is
retained with each assertion block to expose cross-test state leaks.

| Pair | Base pass / fail | Base test time | Candidate pass / fail | Candidate test time |
| --- | --- | --- | --- | --- |
| 1 | 1529 / 0 | 84.75 s | 1528 / 1 | 114.84 s |
| 2 | 1527 / 2, plus one between-test error | 141.37 s | 1526 / 3 | 159.57 s |
| 3 | 1529 / 0 | 136.06 s | 1529 / 0 | 80.71 s |
| 4 | 1529 / 0 | 91.77 s | 1528 / 1 | 100.19 s |
| 5 | 1529 / 0 | 82.78 s | 1529 / 0 | 100.36 s |
| 6 | 1529 / 0 | 82.58 s | 1529 / 0 | 91.25 s |

Every run discovered 1,555 tests in 88 files and skipped the same 26 tests.
The complete outputs are stored losslessly as `.log.gz` archives (use
`gzip -dc <file.log.gz>` to read them). Evidence directories are ignored, and
the unpublished commit `ae05b73849d5c981db4a572dd53699726c4dc8cc`, which added
archives and an assertion dump, was replaced with report/ignore changes only.
Those evidence files are never added in the rewritten task branch's history.
Base had one failing run in six; candidate had three. No BackgroundQuotaRefresh
assertion failed in these twelve runs. Three preliminary candidate-only runs
were clean, but are not included in this paired measurement.

Base's captured faults were a migration-completion race (`migratedAt` was still
undefined after waiting only for the placeholder) and a vault-mode source test
that exceeded Bun's unchanged five-second test limit. These are demonstrated
pre-existing failures, not evidence that every candidate-only failure was
pre-existing.

### Product bug: a stopped host could still reload its accounts

The strongest candidate failure was the setup-failure test: its one-shot
`PoolAccountSource.load` rejection was consumed, but the setup under test
resolved. The preceding HTTP/WebSocket quota test had already stopped its host.
Temporary diagnostics recorded a construction stack per source and the caller
of every load/dispose. An ordered 28-test host run recorded **11 loads after
disposal from nine different source instances**. Their callers were the
migration and adoption callbacks in `v2/setup.ts`, not the new core helpers.
The full diagnostic is `diagnostic-ordered-01.log.gz` in the external evidence
store (SHA-256 below).
That diagnostic run's one-shot spy was consumed by its intended source; the
post-disposal loads themselves, plus the controlled regression below, establish
the leak without pretending that this run reproduced the exact spy collision.

The old shutdown sequence stopped the lifecycle's timer but did not join its
running migration/adoption. Those callbacks launched `void source.load()` after
finishing, including after the source had been disposed. The source's drain
joined quota writes, polls and refreshes, but omitted an in-flight read. An older
host could therefore reload files and consume process-wide test spies while a
later host was starting. This is a real product ownership bug, not just a test
failure: host cleanup returned while its account work was still active.

The lifecycle/setup shutdown logic and source dispose/drain logic were not
changed by the extraction. The extracted functions remain synchronous, the maps
remain source-instance fields, and `poolFileKey` performs stat calls only when
called by a host reader; it has no module-level stat or shared cache. There is
no demonstrated changed lock/await boundary in the fold. The evidence supports
a pre-existing disposal hole exposed by timing, not a new shared mutable map.

The repair addresses host shutdown and source disposal:

- Migration/adoption reloads belong to the lifecycle promise instead of being
  fire-and-forget, and a closing host schedules no late reload.
- Shutdown stops future work first and joins the lifecycle and cached in-flight
  source read as well as quota work. `SETTLE_ON_DISPOSE_MS` in `v2/setup.ts`
  still limits shutdown to five seconds so a stuck provider cannot hold exit.
  It clears the shutdown timer when the drain finishes.
- A stopped lifecycle does not start a new adoption after a pending migration,
  authority check or version fence finishes. Already-entered transfers retain
  their existing locks and migration protocol.
- Disposed sources start no new reads or authority checks, and a read completing
  after disposal cannot publish a fresh snapshot or queue another first poll.

A controlled held-adoption test failed on the old implementation: cleanup had
already returned before the adoption was released. No deadline was changed.
The new lifecycle, read-drain and adoption-drain tests also have isolated red
controls, listed below.

### Fixture ownership and readiness

Two OpenCode 2 fixtures registered `stop` before file removal but executed
cleanups in reverse, so account files were deleted before their host stopped.
Removal is registered before stop, so reverse cleanup awaits host shutdown
before deleting its files. The active-connection fixture now gives
its fake slot an isolated path; otherwise its adoption locks used the real
fallback slot path shared by other fixtures. Assertions about credentials,
feedback and migration remain unchanged.

The vault fixture waited for a quota-containing **file**, then slept 100 ms.
The consumer publishes that file before reloading its own routing snapshot;
under load, a file could look ready while admission still saw unknown quota and
correctly produced generic `no-account`. The fixture now borrows a read-only
lease to the same host consumer, waits for the same credential/quota property
in its live snapshot, and releases that lease. It does not start a second
consumer, send a probe request, retry a failed send, or increase the existing
five-second readiness deadline. All original refusal/authorization assertions
stay intact. Waiting for the live roster replaces the file-based readiness
proxy without relaxing those assertions.

### Captured RPC timeout cascade

An intermediate full validation then captured a different failure:
`rpc-server > keeps RPC ports discoverable and applies with each project captured context`
timed out at 5,000 ms. Its async callback continued with process-wide fetch and
timer overrides; later SDK tests got the wrong response, followed by a chain of
keep-warm failures. The complete output is
`repaired-attempt-03.log.gz` in the external evidence store (SHA-256 below).

The follow-up scope included this additional teardown leak, without changing
RPC assertions or deadlines. RPC tests now use the existing
request-test scope to join their callbacks and loader work before the next test
starts; their finally blocks drain loader work before restoring global fetch,
timers or paths. A loader that fails during fixture construction is disposed.
No RPC assertions, names or deadlines changed.

A deliberate 5,100 ms callback delay, marked `NON-VACUITY BREAK` to identify the
temporary behavior break, exceeded Bun's
unchanged 5,000 ms limit. Only the RPC owner failed; all eleven other RPC,
request-scope and SDK tests passed. The teardown error named the RPC test whose
callback exceeded the deadline.
`rpc-timeout-red.log.gz` in that store (SHA-256 below) retains
the complete output. The delay was removed before any commit.

### Red controls and restoration

Each control staged the live files, confirmed an empty `git diff --stat`, applied
the marked break, captured a non-empty diff, ran the tests, and restored the
specific file with `git checkout -- <path> && touch <path>`; touching invalidates
mtime-based source caches after restoration. Every post-restore diff was empty.

| Break | Exact failed test | Other controls |
| --- | --- | --- |
| Remove the lifecycle join from host cleanup | `OpenCode 2 entry: logins > cleanup joins a running adoption before releasing its source` | Both direct source-disposal tests passed |
| Omit the source's read from its drain and completion predicate | `pool source disposal > settled joins a read that exceeded the request budget` | Adoption drain and disposed-source read prohibition passed |
| Keep the lifecycle scheduling flag live after disposal | `the migration in the background > does not start follow-up adoption after disposal during migration` | Adoption drain and both source-disposal tests passed |
| Force the RPC callback beyond its unchanged deadline | `rpc-server > keeps RPC ports discoverable and applies with each project captured context` | Five other RPC tests, four scope tests and both SDK parser tests passed |

The three source controls are in `mutations.toml`; all 227 catalogue anchors and
exact names remain valid. The timeout control was run manually to verify that
only the RPC test failed; it is not a permanent delay or a claim that a filtered
CI run observes downstream tests.

### Earlier partial verification boundary

Types passed for all three packages (TypeScript 7.0.2), lint passed for 257 files
(Biome 2.5.15). Tests for pool shutdown, active-credential/vault fixtures and
migration contracts passed: 70 tests in five files, plus 12 RPC/scope/SDK tests
in three files. Final restored-control runs passed four source/lifecycle tests
and the same twelve RPC/scope/SDK tests. Scoped diagnostics covered all five
requested source/test files with zero errors or warnings; the callgraph portion
of the inspector remained unavailable. Build, declarations, TUI and
packaging checks ran during the full validations. Dependencies and lockfiles
remain unchanged.

Six consecutive clean full runs were the agreed validation target for this
intermittent issue. That target is **not achieved**. After the RPC repair,
full candidate run 1 passed **1,533 tests**, with 26 skips and no failures, in
89.86 s. Run 2 passed 1,532 tests and had exactly one failure:

`one host vault per process > OpenCode 2 setups on different pool stores do not share a consumer`

This checks that OpenCode 2 setups using different account files have separate
vault network clients and state, rather than accidentally sharing one client.

It exceeded the unchanged five-second test limit at 5,703.02 ms. Its existing
request-test scope drained and named the owner; no later test failed. The
immediately preceding same-store sharing test passed in 3,465.13 ms. Full logs
are `repaired-final-01.log.gz` and `repaired-final-02.log.gz` in the external
evidence store (SHA-256 below).
The validation stopped on this failure, without retrying it or broadening the
repair to the shared-vault fixture. The review had agreed to stop at the next
unrelated failure after fixing RPC teardown, rather than expanding this repair
indefinitely. This delivery is
a coherent source/teardown repair with captured evidence, **not** a claim that
the complete suite was stable at that point. The remaining shared-vault timeout
was the subject of the subsequent diagnosis and final paired comparison below.

### External evidence hashes

All filenames below are relative to
`~/.local/state/cortexkit/evidence/openai-auth/dead-code-stability-2026-10/`;
`SHA256SUMS` is the manifest in that directory. The hashes were calculated from
the original worker copies, which the reviewer confirmed were copied
byte-for-byte. Neither the archives nor `assertions.md` belongs in this public
repository. New follow-up evidence is kept under ignored `.evidence/` for the
same external archival step.

| File | SHA-256 |
| --- | --- |
| `base-01.log.gz` | `0b4a62dc51089a2871afa105269dc86b8959e5f8ea8cdb513744585658cfba5d` |
| `base-02.log.gz` | `39301b56deb753dea4e72141fde6b6ecd389b918ca2b7dfcda4590aac6e58001` |
| `base-03.log.gz` | `f94162abaa4e89fcc91efc2c7c4ed9e7510655ac1ead6d7e5674b6d7558078c6` |
| `base-04.log.gz` | `79993a944542f0fe55b1f6dbf1e8f81a682f034f5a6713fe1ff25095db6f7886` |
| `base-05.log.gz` | `b25ddeaf388cfb2ed4876f0ce3918ef03d09bca59aa96da3ff3d9c007316a17c` |
| `base-06.log.gz` | `bac0eed84b1f27a8071b38ed891fe45778f91839e4436b868b49747d54fca4fd` |
| `candidate-01.log.gz` | `8f3d1c116dcdab1bfe5d24ce8e9997984495cae5734b60241c4d0ad7fb45fc2c` |
| `candidate-02.log.gz` | `3be898b3bfa6eec12abc4cc0ea2cc30afd372dfc37bdc9db271793fc0c3285b8` |
| `candidate-03.log.gz` | `d6b1314d7c341fd4991b0df10cf9f8866e0e7d454180693177406c70c5616f48` |
| `candidate-04.log.gz` | `701f1b08bd7f1e9590135d9a46b451d4391d2d16a5ad2b6a0504a610e67a733a` |
| `candidate-05.log.gz` | `3b144f4951bb66734d717fa7c96f3ec18f84d641e0d0bc9d16f52d98fba19c20` |
| `candidate-06.log.gz` | `d4685be0c9b2d44f44a9d9fdfd9337e2a234c9141b05136228d73a5da1f6cd1e` |
| `diagnostic-ordered-01.log.gz` | `c5dee7924e105d25d4c914c3f3e9c1cacc93068cc8659fc8c485063f923b1eb1` |
| `diagnostic-shutdown-01.log.gz` | `82e9c67f802369e15034ce49ddb4acfa313bd86d4f911b410fc4e9090161ce94` |
| `adoption-join-red.log.gz` | `bdbb1b21f9bd8041f24d133f6c110761eaeda5b234fea41561a13b6985aadeec` |
| `read-join-red.log.gz` | `a6a72f0b896720c74545f162a3b1356c787dbe92f49a5b8c3ead4e2aeeef2849` |
| `lifecycle-phase-red.log.gz` | `94754ed317eb4afa3d21f811fc00405a00b692727400a2861b1a5a3a1b5cf8e2` |
| `rpc-timeout-red.log.gz` | `5fd69180f2e4c809066a69f257476670be6e14c5cb8613daf6b543509c3a58c7` |
| `repaired-attempt-01.log.gz` | `45d94a80fd20c6840c45d498f5387b1cb7ce716bcf5538f57941ea5ae1e1f6d4` |
| `repaired-attempt-02.log.gz` | `87973048d4424e7c3e64f9a6d37a382ba70e1b1b3ce4f8046a42ff3593de5fb8` |
| `repaired-attempt-03.log.gz` | `4dff519b72eb227671e25e959a967079eebbeef64d11655dee5711c4863e79f4` |
| `repaired-final-01.log.gz` | `9147c8ede82df08ebbc46256ddb1852008f95e1077027fc4dfca457e26c6c2ef` |
| `repaired-final-02.log.gz` | `0309bb0e7fff1caf11a0e126fba848fe8dcbdc9fb0469709b9a03694536fa5d4` |
| `post-rpc-full-runs.log.gz` | `b6f7db990aab66ebdf227e272f355f2267ce45a08bd85524b319731882f15757` |
| `assertions.md` | `f3df1fb2a9a73517df2e28bb1fffff3d3a9eccefe977d62d9f3fd360b2d9d6ed` |

## Final review: shared-vault readiness and paired result

### What the remaining timeout was waiting on

The earlier failure had no failed consumer-identity assertion: Bun ended the
callback after five seconds while its async work was still pending. The captured
block names `OpenCode 2 setups on different pool stores do not share a consumer`
and includes the scope's owner report; the immediately preceding same-store
test passed in 3,465.13 ms. The private evidence file
`.evidence/shared-vault-prior-assertion.txt` records that preceding result, the
scope error and the Bun timeout; it is staged locally for external archival
rather than published in Git (SHA-256 below).

Observational start/close/poll traces were added temporarily, then removed.
Both an eight-test file run and a full-suite run reached the target case. They
showed two distinct consumer objects created for the two pool stores, both live
until normal cleanup, no calls from unknown earlier instances, and closing only
after readiness completed. The evidence does **not** show the earlier
post-disposal source-loading bug recurring here.

Instead, `ready()` performed work rather than merely waiting: after observing
one roster row, it called `pollStale(0)` on every consumer. Zero age treats even a
fresh quota reading as stale. The case calls `ready()` after the first setup,
after the second setup, and once more: **five forced quota passes**, in addition
to the two startup freshness checks. These passes authorize, fetch usage and
write/reload the shared roster, although the case's actual contract is consumer
separation and exactly two discovery calls. In the full trace the second
consumer's parallel forced passes took about 26.6 ms, compared with about
1.2–1.5 ms for the first, consistent with the extra shared-file work.

The original slow run did not contain stage timings, so its exact stalled await
cannot be reconstructed. The reached traces and deterministic control establish
the unnecessary readiness work and its removal; they do not prove that an old
lease was closing during acquisition. Production consumer registry keys,
reference counting, discovery and quota scheduling were left unchanged.

`ready()` now observes one row **with quota in each consumer's live snapshot**.
Startup owns the first quota pass. The helper does not trigger fresh quota
writes on every readiness check. No existing consumer-isolation, list-count,
connection-count or request assertion changed, and neither the Bun deadline nor
`waitFor`'s deadline was raised.

Two deterministic regressions protect both requirements: observing a warm
consumer must start no new quota work, and a cold consumer must not be called
ready before its live quota reading arrives:

- Restoring a forced `pollStale(0)` after the observer made only
  `one host vault per process > readiness of a warm consumer starts no extra quota pass`
  fail: one pass became three after two checks. The other nine tests passed.
- Removing the live-quota predicate made only
  `one host vault per process > readiness waits for quota in the live consumer snapshot`
  fail while its startup usage request was held behind a promise. The warm
  no-extra-pass control passed. No sleep or elapsed-time expectation decides
  this control.

Both temporary changes deliberately violated those requirements and were marked
`NON-VACUITY BREAK`, applied after staging the live file
and confirming an empty diff, and restored with checkout/touch. The first diff
had two inserted lines; the second had one insertion and one deletion. Both
post-restore diffs were empty. The restored ten-test file passed, types passed
for all three packages, lint checked 257 files, and all **229** mutation anchors
and exact test names passed `ckdev-mutate check`.

### Six final alternating pairs

Base: `47a7fae77bca2a89e835be4c940ec584352c25c9`.
Final code candidate: `407eb97cc61c91cdac2698408215eedbe5913205`.
The candidate was immutable throughout this measurement; later report edits do
not change its code. The sequence was base 1, candidate 1, base 2, candidate 2,
base 3, candidate 3, base 4, candidate 4, base 5, candidate 5, base 6, candidate 6.
Every run
used `linux,8c`, Bun 1.4.2, and the same install/build/full-test command shown
above. All twelve frozen installs and builds passed, including declarations and
TUI generation. Package and lockfile contents were unchanged.

| Pair | Base test passes / failures | Base time | Candidate test passes / failures | Candidate time |
| --- | --- | --- | --- | --- |
| 1 | 1529 / 0 | 97.61 s | 1535 / 0 | 92.49 s |
| 2 | 1529 / 0 | 76.86 s | 1535 / 0 | 107.59 s |
| 3 | 1529 / 0 | 94.58 s | 1535 / 0 | 76.83 s |
| 4 | 1529 / 0 | 75.41 s | 1534 / 1 | 137.55 s |
| 5 | 1529 / 0 | 83.81 s | 1535 / 0 | 71.46 s |
| 6 | 1529 / 0 | 105.22 s | 1535 / 0 | 82.55 s |

Base discovered 1,555 tests in 88 files; candidate discovered 1,561 tests in 89
files. Each skipped the same 26 tests. The six extra candidate tests are the
added shutdown/readiness regressions. The case that checks separate vault
clients for different pool stores, and both new readiness controls, passed in
every candidate run.

**The final candidate is still worse by the agreed observed failure criterion:**
base had zero failing runs out of six, candidate had one. In candidate run 4,
`routing > a served 401 is reported with the exact record version, and the account goes cold`
timed out at 5,010.86 ms under Bun's unchanged five-second limit. Its existing
scope drained and named the callback; no later test failed. The preceding
sticky-balanced routing test passed in 3,333.40 ms. This was not a shared-vault
readiness or consumer-identity failure.

The complete block is `final-review-assertion.txt`; the complete run is
`final-review-candidate-04.log`. Neither was retried. No further source or test
fix was added after the paired measurement. The outcome is reported as a failed
merge/stability criterion, not explained away as noise or claimed to be a clean
six-run proof. Investigation of that remaining routing timeout is outside this
completed measurement.

### New private evidence for archival

New outputs are currently under ignored `.evidence/` in the worker checkout,
not in Git. They are listed in `.evidence/SHA256SUMS.final-review`, SHA-256
`7303e55e1f6c5e2aaf7daddcb9aeb3174c47318a69cab57c9f0cad2d8dcd6606`.
The reviewer can copy those files to
`~/.local/state/cortexkit/evidence/openai-auth/dead-code-stability-2026-10/`,
preserving the earlier `SHA256SUMS` manifest. The new manifest has a distinct
name to avoid overwriting it. Before archival, the same filenames can be read
from the worker's `.evidence/` directory.

| New evidence file | SHA-256 |
| --- | --- |
| `shared-vault-prior-assertion.txt` | `fc53a640490649a999e4b18cb7eb50e4222893e236d1a4f483b41cd8b4ddfe34` |
| `shared-vault-alone-trace.log` | `3cacf1da34c330afe76d517aeda6bdd71dad57fc9fd0f8d6e7f0e7bfceb74e96` |
| `shared-vault-full-trace.log` | `443b4c5e84033f4a801410bfa82800150c647fe0d61f2d55315bb70637407f95` |
| `shared-vault-timeline.txt` | `00a9983859d558cc2c80f71abbb2a16fc79844c93fc3929a05845bd4dd3e9099` |
| `shared-vault-extra-poll-red.log` | `c05ca23220f9abcd21a97e82eec3f1b22e5147cc1421a6b02f50ec6dd493df27` |
| `shared-vault-live-quota-red.log` | `7bdd35b21383bd845afdc29440c895d5439a793c8f7d9d4a17273a34cd4e1ae1` |
| `final-review-base-01.log` | `ecd34a4fb6b9c7bc304e2c2b4261cec66269359bd39f0f3ba954ad7c3fe9f4f2` |
| `final-review-base-02.log` | `e28d76682d3a8aef373366d3cd161c0c8e2037e1ef2d88e8a45fa9aa549bc42b` |
| `final-review-base-03.log` | `43ba6ffb2f587d30f92a3396e8d5dc44a611fda6bed9b74746adb1c286a4388c` |
| `final-review-base-04.log` | `aa8d955c4bc49fddf67e0bcc490dbbe3af81629561b8624a5105c91ba7563019` |
| `final-review-base-05.log` | `55c1c02039fa299fbdc4eccee99313b32233501297e04c5504c2d7c4474163db` |
| `final-review-base-06.log` | `29a37456358149dfacc30b37a8e8eaa4d9a3e57b81060b33c89fb2015e78e0d0` |
| `final-review-candidate-01.log` | `55705792dbf3e4aae544c96f775370c486f13eb7a5c86a5faafbf17ebb6727bd` |
| `final-review-candidate-02.log` | `a3f3d7ded02f1e3f503b0f63da9d97c6376c93e7e467359763b10dc7dab26af5` |
| `final-review-candidate-03.log` | `772d1507cb8ff2e1773634254a364581cacdf15024370f5a7c204476445b6f4b` |
| `final-review-candidate-04.log` | `2d608a94b110e18d14b6d0ce1025abaec866a343f315a39432b285b5cbc06ca6` |
| `final-review-candidate-05.log` | `774ac55a4fb904a35b372c658acd9d1f4de4d1270d166fc61fb9abdc3929fd27` |
| `final-review-candidate-06.log` | `ba9ca2ca807ea0bc8cde7b994fd146fc96e26d4474e733838581d9d173a6b170` |
| `final-review-summary.json` | `52df61830d14a977d62d385ac05a9f9f93ad7142ff0b1f4ae757f528c2620cb4` |
| `final-review-assertion.txt` | `d3a47bfefd7a6d1d6ff92b76e42079b11b4c80ab56db4370ab4fa3a119cee09b` |

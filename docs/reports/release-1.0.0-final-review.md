# Final release review: openai-auth 1.0.0

## Verdict and scope

This repository supplies ChatGPT-account authentication plugins for OpenCode (both its 1.x and 2.x host APIs) and the Pi coding agent. A **native login** is the credential stored by the host itself; the **local pool** holds additional plugin-managed accounts; the **vault** is Claustrum's separately managed account service.

The contract used for this review is:

1. When enrollment authority is vault or unreadable, use only vault accounts. Do not route, refresh, poll, warm, display or modify native/local credentials, and keep their files byte-identical. If the vault cannot serve, decline locally with fixed recovery/disconnection instructions.
2. When authority is local, local accounts work and no vault credential is authorized or sent.
3. Sidebar, quota and roster bookkeeping must not delay or fail a model request.
4. OpenCode 2 handles only requests prepared with this plugin's own login; other connections pass through unchanged.
5. Account migration and adoption of a new native login pause while enrolled and resume after disconnect.
6. Tokens must not appear in log lines, emitted error messages or interprocess menu payloads.
7. Detached background work must not produce an unhandled promise rejection.

**Historical review verdict: hold the candidate pending four fixes and one design decision.** The four confirmed implementation findings below are now addressed by normal regression tests (see the resolution section). Finding 3 is **accepted design, approved by the release owner**: Ufuk chose the same Pi provider names, so enrollment moves the native entry aside and installs a non-secret placeholder to prevent Pi refreshing it before the plugin runs. Byte-identical restoration and conflict-safe preservation, not byte identity while enrolled, are its guarantees.

Reviewed candidate: `3b2b4b97f0a047d4e0dfdd02b5f37e17250860af` (provided `origin/main`, before review-only additions). No product code, manifests, lockfiles, generated assets or existing test expectations were changed. Added tests assert the requested contract and **are intentionally red on the candidate**. All credentials in fixtures and excerpts are synthetic. Severity below distinguishes security/isolation violations from availability and specification discrepancies.

Coverage includes OpenCode 1 loader, requests, OAuth/menu login and migration/adoption; OpenCode 2 setup/login/adapter and active-connection ownership; Pi provider/runtime, menu, pool and native slot; and the installed `@cortexkit/common-auth@0.14.1` enrollment, consumer, OpenCode 2 registration/installation and `pi-slot` implementations. In this Bun workspace the dependency is under `packages/{opencode,pi}/node_modules/@cortexkit/common-auth/dist`, not root `node_modules/@cortexkit/common-auth/dist`. Dependency citations use those package-scoped paths (both resolve to the installed locked package).

## Reproduction commands

All builds, checks and suites below ran on Linux with `runon: "linux,8c"`, no network. Tool versions: Bun `1.4.2 (744846f84)`, TypeScript `7.0.2`, Biome `2.5.15`. Run from repository root:

```sh
# Existing candidate suites need generated packaging artifacts on the runner.
bun run build
bun run test

# Added contract reproductions; expected exit 1, not a green regression suite.
(cd packages/opencode && bun test src/tests/review-1.0)
(cd packages/pi && bun test src/tests/review-1.0)

bun run typecheck
bun run lint
```

The findings do not require a live account, vault daemon or external service. They use real plugin/core/dependency code with temporary files and deterministic host/network inputs. The token finding also uses Pi's real `streamSimple` transport, not a fabricated rejection from a mocked plugin method. Every failed assertion is an observable output/file property, rather than a silent guard test; no source mutation is needed to demonstrate these failures.

## Confirmed findings

### 1. OpenCode 1 can send its native login after enrollment lands during auth lookup

- **Severity:** High (vault/local credential isolation). **Hold:** Yes.
- **Locations:** `packages/opencode/src/index.ts:4695`, `:4727`, `:4752`, `:5133`; the common send primitive at `:3303` has no enrollment check. The `vault.assertHostSlot(currentAuth)` guard at `:4752` rejects use of a native credential when vault custody serves, but runs only on installs already migrated to the local account pool.
- **Exact sequence:** Start a legacy/unmigrated install with migration disabled and an unexpired native OAuth login. Complete a local request first (positive control: exactly `Bearer review-local-access` reaches the fake provider). On the next request the initial authority read returns local. While `getAuth()` resolves, an enrollment token is written. The request then continues through the native main path and sends that same local bearer even though enrollment now exists. This represents another process enrolling the host across the await; the fixture places that event directly in the auth lookup to avoid timing-dependent sleeps.
- **Test:** `packages/opencode/src/tests/opencode1-authority.test.ts`, `OpenCode1 enrollment during host auth lookup prevents a local model send`.
- **Captured red output:**

```text
error: expect(received).toEqual(expected)
- []
+ [
+   "Bearer review-local-access",
+ ]
(fail) OpenCode1 enrollment during host auth lookup prevents a local model send
```

The positive local-request control matters: a first version without draining startup quota/source work passed without sending a local request. A background native-auth lookup could trigger the fixture's enrollment before the request's initial authority read; that experiment did not establish that the intended transition window was reached. The committed test drains startup work and first proves the local send path is live, then reproduces enrollment during the request's later auth lookup.

### 2. OpenCode 1's vault loader still requires the unused local account store to parse

- **Severity:** Medium (availability and wrong remediation). **Hold:** Yes under the fixed vault-refusal/independent-vault-path criterion.
- **Locations:** `packages/opencode/src/index.ts:1894-1920` and `:1951-1990`, `:4702`. Loader mode is known before the unconditional local `loadAccounts` call; requests also load local storage before branching on authority.
- **Exact input:** Write a valid private enrollment token and set the unused local `openai-auth.json` to `{broken`. No daemon is reachable in this fixture. The requested behavior is a locally declined vault request with the fixed message explaining vault recovery/disconnection, while preserving the unused file. Instead the auth loader rejects, so no request adapter or fixed vault refusal is available. The same unconditional read precedes serving even if the daemon is healthy; the test's directly observed failure is loader rejection, not a claim that it dispatched a local request.
- **Test:** Same file, `OpenCode1 vault loader declines locally even when the unused local account file is malformed`.
- **Captured red output:**

```text
error: expect(received).toBeUndefined()
Received: Error: OpenAI auth store at <temporary directory>/openai-auth.json
is corrupt or unreadable: JSON Parse error: Expected '}'. Fix or remove it to continue.
(fail) OpenCode1 vault loader declines locally even when the unused local account file is malformed
```

Reading routing settings is not itself counted as local credential routing. The defect is that a local-store parse failure prevents the required vault-only request/refusal path and tells an enrolled user to modify a local file that should be irrelevant to credential service.

### 3. Pi enrollment intentionally replaces its native login in auth.json

- **Disposition:** accepted design, approved by the release owner. The same provider names require reversible replacement; no product change is requested for this behavior.
- **Locations:** `packages/pi/src/index.ts:206`, `:215`; `packages/pi/src/runtime.ts:355-375`; `packages/pi/src/vault-slot.ts:18-24`; `packages/pi/node_modules/@cortexkit/common-auth/dist/pi-slot/slot.js:335-362`.
- **Exact sequence:** Set `PI_AGENT_DIR` to a temporary Pi agent directory. Write `auth.json` with an expired native `openai-codex` OAuth entry and an unrelated provider entry. Enroll the host (`authority() === 'vault'`), construct the runtime with the production `openVaultSlot`, then call `syncVaultSlot()` (as startup/session synchronization does). The helper stashes the original entry and replaces its value with the non-secret API-key placeholder. The unrelated entry is preserved, but the native login file is not byte-identical while connected.
- **Review-only test removed:** `Pi vault synchronization keeps native auth.json byte-identical while enrolled` asserted the rejected contract. Existing `vault-mode.test.ts` regressions “disconnect restores the original Pi entry byte-identical before removing enrollment” and “a foreign Pi login makes disconnect report a conflict and overwrite neither login” are the approved guarantees.
- **Captured red output:**

```text
error: expect(received).toBe(expected)
- "openai-codex": {"type":"oauth","access":"review-native-access","refresh":"review-native-refresh","expires":1},
+ "openai-codex": {"type":"api_key","key":"openai-auth-vault-mode-not-a-credential"},
(fail) Pi vault synchronization keeps native auth.json byte-identical while enrolled
```

Existing Pi tests explicitly require this swap to keep Pi from refreshing its native login *before* invoking the plugin stream. They also prove byte-identical restoration on disconnect and conflict-safe preservation. Those are valuable guarantees, but restoration after disconnect is not byte identity while connected. This report does not recommend removing the slot guard without replacing its protection against Pi's pre-provider refresh.

### 4. Pi's queued local quota write crosses enrollment

- **Severity:** Medium (local-file isolation). **Hold:** Yes under the stated no-modification criterion.
- **Location:** `packages/pi/src/pool-source.ts:559`, `:579-589`; its queued `then(() => store.recordQuota(...))` does not recheck enrollment. `runtime.ts:251` supplies the synchronous vault hint used by this source.
- **Exact sequence:** Create a local pool row `work` with an unexpired token; read local authority and load the source; drain its first quota attempt. Capture config bytes. Call `recordSnapshot` for that row with a complete primary quota frame (`usedPercent: 63`). Before the queued promise callback runs, write a valid enrollment token and confirm authority is vault. Drain source work. The write still commits `needsFirstReading: false` and the new quota reading to the local config. The test wires `vaultMode` to the real `vault.enrolled()` guard, not a stale mock value.
- **Test:** Same Pi file, `Pi queued local quota observation does not write after enrollment`.
- **Captured red output:**

```text
error: expect(received).toBe(expected)
- "needsFirstReading": true
+ "needsFirstReading": false,
+ "quota": { "limits": [ ... "usedPercent": 63 ... ] }
(fail) Pi queued local quota observation does not write after enrollment
```

This is not a claim that Pi starts a new quota HTTP poll after enrollment. The producer began locally; its deferred persistence modifies the file while the host is connected. To keep the file byte-identical during enrollment, the deferred store operation must check that authority is still local immediately before committing, not only when the observation is queued.

### 5. Pi forwards an upstream error containing the bearer to the user

- **Severity:** High (credential disclosure in error output; conditional on upstream/transport echo). **Hold:** Yes under the absolute no-token-in-errors criterion.
- **Locations:** `packages/pi/src/runtime.ts:629-642`, `:772-789` (both generated and forwarded error messages); installed Pi transport `node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js` formats provider error messages. The plugin does not strip its current token from the emitted error event.
- **Exact input:** In local mode, give the real Pi stream adapter a synthetic, parseable ChatGPT JWT. Quota responds with an available primary window. The fake model endpoint returns HTTP 401 JSON `{"error":{"message":"Invalid API key: <the complete supplied JWT>"}}`. The test positively asserts exactly one model send and an error event, then checks that event serialization contains no token. It contains the complete JWT in `error.errorMessage`.
- **Test:** Same Pi file, `Pi request error does not expose the bearer echoed by the transport`.
- **Captured red output (event JSON abbreviated, compared JWT complete):**

```text
error: expect(received).not.toContain(expected)
Expected to not contain: "eyJhbGciOiJub25lIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoicmV2aWV3LW5hdGl2ZS1zZWNyZXQifSwic2FsdCI6IiJ9.signature"
Received: ..."errorMessage":"Invalid API key: eyJhbGciOiJub25lIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoicmV2aWV3LW5hdGl2ZS1zZWNyZXQifSwic2FsdCI6IiJ9.signature"...
(fail) Pi request error does not expose the bearer echoed by the transport
```

The committed test compares the complete generated token. This does not assert OpenAI normally echoes OAuth JWTs; it demonstrates that a provider/proxy error can violate the stated invariant with an ordinary HTTP error body. The initial test using a non-JWT bearer did not reach the model endpoint (Pi rejects it during account extraction); the final test uses a valid synthetic identity and the explicit send counter to avoid that false positive for redaction.

## What was checked and found correct

These are bounded positive observations, not a claim that the five counterexamples above are harmless. The named tests below passed in the existing suites on the candidate; source inspection fills in the dependency and host boundaries they exercise.

### 1. Vault-only stable mode and refusal behavior

- **Shared authority:** `common-auth/dist/claustrum/enrollment.js:353-413` treats valid token/approved state as vault; approved state without token remains vault; unsafe/malformed state is unreadable rather than local. `packages/core/src/vault.ts:296-319` uses a fresh async authority read and a fail-closed synchronous cache when enrollment files change. Passed: `vault-enrollment-audit.test.ts` — “the synchronous mode guard stays closed until authority reads unchanged enrollment files”, “approved ceremony without a token remains vault-only with Disconnect”, and “unreadable enrollment hides local dialog actions and refuses stale writes and polls”. Pi's corresponding missing-token/unreadable cases also passed in `vault-mode.test.ts`.
- **OpenCode 1 stable requests:** `index.ts:4709-4719`, `:4540-4603` and `core/pool-request.ts:259-290,378-432` omit local targets in non-local authority. `vault-mode.test.ts` passed “an unshadowed local row never routes in vault mode: only vault accounts are candidates” and both empty/unreachable no-send cases. `shared-vault.test.ts` passed “a vault-mode session makes no local refresh or poll, serves only from the vault, and leaves the local files byte-identical”. These do not cover the transition window in finding 1 or corrupt local storage in finding 2.
- **OpenCode 2 stable requests:** `v2/setup.ts:237-310`, `v2/adapter.ts:578-609,680-704,737-742` select vault-only candidates and prevent local credential preparation. Passed `opencode2-vault.test.ts`: “never routes a pool row the vault does not hold, and leaves the pool files byte-identical”, “never refreshes the token of a pool row, whether or not the vault holds its account”, “never polls the quota of a pool row, whether or not the vault holds its account, from the first read on”, empty/refused cases, bounded-unresponsive-daemon case and unmigrated vault service. Existing direct unreadable-request coverage on OpenCode 2 is thinner than stable vault coverage; source checks use `!== 'local'`, not an equality with `'vault'`.
- **Pi stable requests:** `runtime.ts:610-627,660-678,730-745` refuses a non-placeholder resolved native credential, waits a bounded initial roster budget, then uses only vault routes. Passed `packages/pi/src/tests/vault-mode.test.ts`: “neither Pi's login nor a pool row the vault does not hold is sent with, refreshed or polled, and the pool files stay byte-identical”, empty/unreachable cases, “a non-placeholder resolved credential refuses locally even with a healthy vault”, and approval during storage-read/native-quota-queue cases. Its native `auth.json` swap is separately identified in finding 3; the stable pool-file guarantee does not prevent finding 4.
- **Pi native auth path:** `vault-slot.ts:18-24` calls `join(getAgentDir(), 'auth.json')`, independently of pool config/state overrides. Installed Pi `node_modules/@earendil-works/pi-coding-agent/dist/config.js:491-508` uses `PI_AGENT_DIR` (expanding a leading tilde) or its default home agent directory; Pi's own `getAuthPath()` uses the same join. The existing “the vault slot uses Pi auth.json independently of pool file overrides” test passed, and the new slot test uses the production helper with a temporary `PI_AGENT_DIR`.
- **Cache warming:** `packages/opencode/src/core/cachekeep.ts` checks authority at dispatch as well as token resolution. Passed `vault-enrollment-audit.test.ts` — “enrollment during a local warm token await prevents dispatch”. No local warm dispatch was observed in stable vault mode.
- **Menus and actions:** Shared vault account/menu builders read authority anew; OpenCode/Pi host adapters keep local Accounts/Quota/Limits actions empty while non-local and refuse stale writes. Passed `vault-command-menu.test.ts` — “stale local dialog writes in vault mode refuse with a fixed message and byte-identical pool files”; Pi `vault.test.ts` — “vault mode hides local-writing Pi dialog actions and a stale add refuses without changing pool bytes” and “in vault mode the shared Accounts Quota and Limits slots list only the vault accounts”. Diagnostics and Disconnect remain available. Roster discovery in menus is bounded even when the daemon never answers.
- **Fixed declines:** `core/src/vault.ts:130-148` defines the credential-free unreachable/empty/refused instructions; host routing emits them on ordinary no-vault-service cases, rather than sending a local credential. Quota admission is intentionally a distinct refusal, not mislabelled empty roster (`request-vault-audit.test.ts` and `vault-mode.test.ts` quota-attribution tests passed).

### 2. Local mode and disconnect recovery

Local authority enables the native/local pool paths; the consumer's `isCustodyActive` guard prevents disconnected credential service. `common-auth/dist/claustrum/consumer.js:103-110,169-183` drops inactive custody and refuses authorization. The installed consumer cannot authorize a vault credential without the host's enrollment token and active enrollment. The plugin can still inspect enrollment/stash metadata to decide or reconcile mode; “no vault path” was checked as no vault credential authorization/dispatch, not as no metadata reads at all.

Passed: OpenCode `vault-mode.test.ts` source test restores token service, refresh and polling after leaving vault mode; `opencode2-vault.test.ts` — “routes the pool rows again once this host disconnects”; Pi `vault-mode.test.ts` — “disconnecting restores local routing: Pi's login serves again”. Pi `pool-routing.test.ts` covered model dispatch in all three routing modes, local refresh, quota recording, first readings and legacy-account conversion.

### 3. Non-blocking bookkeeping

Inspected OpenCode request/sidebar queues (`index.ts:4604-4628,4672-4684`), pool quota recording, and Pi response/WebSocket recording (`runtime.ts:526-569`). Request observations do not await quota persistence. `core/src/vault.ts:528-543` absorbs failed async quota writes; the common-auth consumer's own `recordQuota` awaits its roster write, but plugin request observers detach that operation.

Passed all six `hot-path-bookkeeping.test.ts` tests, including “main-first: returns within the bound while the sidebar and store locks are held, and the bookkeeping lands after release” (also fallback-first and sticky-balanced), failed sidebar writes, deferred legacy save-lock bookkeeping, and “a WebSocket quota push whose sidebar write fails raises no unhandled rejection”. Also passed all three migrated store-lock tests in `pool-request.test.ts` and the two advisory-save-failure tests in `accounts-store.test.ts`. These positively exercise failed/held writes rather than only an unlocked success path. No request-blocking sidebar/quota-write defect was confirmed. First vault-roster discovery remains explicitly bounded to the existing two-second allowance; that is credential availability, not a hidden unbounded bookkeeping wait.

### 4. OpenCode 2 owns only its login connection

Inspected `common-auth/dist/opencode2/integration.js:59-143`: plugin methods return integration placeholders after awaited login storage, never their real access/refresh values. Pool refresh accepts only this integration's placeholder; vault refresh additionally checks its method ID. The browser and device-code pool login methods both belong to this plugin, so accepting either one's placeholder is not counted as a violation of request ownership.

The actual transport ownership gate is in `common-auth/dist/opencode2/install.js:128-130,507-566,567-576,638-713`, not in login registration. It reads the **prepared request credential**, uses exact placeholder equality, leaves HTTP/WebSocket drafts unchanged when their bearer is not this plugin's exact placeholder, and ignores feedback whose request was not selected by the plugin. Passed all nine `opencode2-active-connection.test.ts` tests: API-key pass-through, own placeholder routing, empty-pool refusal, switching connections, other-integration/no-connection pass-through, preservation of built-in ChatGPT login/refresh, prepared-request credential precedence, and exact-vs-near-miss bearer matching. These test model/HTTP/WS/retry/context/compaction effects, not just a method-ID label.

### 5. Migration and login adoption pause/resume; login guards

OpenCode host lifecycle is paused on any non-local authority (`index.ts:1585`; `core/pool-lifecycle.ts:205-280`). It serializes transfer of legacy account data into the pool and adoption of a later native login into a pool row; both resume after disconnect. Low-level transfer utilities are not themselves host authority gates; correctness depends on the lifecycle entry points.

Passed `pool-lifecycle-plugin.test.ts` — “a never-migrated install is served from the vault without migrating, and migrates once the host disconnects” and “a slot login landing in vault mode is neither used nor adopted, the local files stay byte-identical, and it is adopted after disconnect”. Corresponding `pool-lifecycle.test.ts` migration/adoption pause/resume cases passed. OpenCode 2 setup's pre-existing active host login is never copied into the pool. Pi local legacy conversion occurs only when its pool is not set aside, and local conversion works after mode returns local.

OpenCode 1 `auth/methods.ts:271-341,506-580` gates slot writes, OAuth start and callback completion separately; vault activation uses its own non-secret placeholder and refuses unreadable/occupied slots. All `vault-login.test.ts` activation cases passed, including unreadable enrollment/auth files. OpenCode 2 `v2/login.ts:66-117,159-189` checks authority before OAuth and before storage; its migrated-pool authorization/completion enrollment tests passed. No further login-write defect was established; the request-time auth-lookup race in finding 1 is a separate boundary.

### 6. Token safety outside the confirmed Pi stream leak

- Core logs delegate to common-auth redaction and add identity-field masking (`core/src/logger.ts:26-49`). Installed `logger/redact.js` masks credential-shaped keys, Bearer/`sk-`/JWT/`ckh_` patterns. `logger-identity.test.ts` passed both log-line and direct-redact identity assertions. `provider.ts:114-146,189-194` uses fixed status/malformed-response errors instead of raw HTTP bodies for refresh/usage failures.
- Menu payload sealing projects fields, removes credential-shaped keys and redacts strings in installed `commands/seam.js:123-170,282-301`; ordinary unexpected exceptions become generic user-facing failures rather than raw errors. `openai-menu.test.ts` — “no credential reaches a payload” passed for both opened and applied payloads; `core/src/tests/scrub-knobs.test.ts` passed nested-credential removal and path-only warning assertions. Pi's “lists the pool rows, and Pi login with its quota in a section of its own” test checks serialized menu data against native/pool tokens and passed.
- `claustrum/custody.js:139-171` replaces arbitrary scoped-client failures with fixed unavailable text; enrollment validation uses fixed messages. Scoped retry/failure logs carry IDs, versions and disposition, not bearer values.
- Finite string-pattern redaction is not proof for every arbitrary opaque secret embedded in operator labels or exotic errors. No second confirmed log/menu leak was found. Finding 5 bypasses the menu/log seam entirely and is directly reproduced.

### 7. Detached/background work and rejection handling

Inspected ordinary refresh/poll/store-failure paths, not just their call sites. Pi `main-account.ts:143-190` catches poll failures and resolves an outcome; `pool-source.ts:579-592,661-712` catches queued writes/refresh failures before cleanup. Vault snapshot writes absorb rejection (`core/src/vault.ts:528-543`), `requestReading` catches/reports failures, common-auth consumer roster ticks catch ordinary refresh errors (`claustrum/consumer.js:141-160`), and the post-401 roster refresh has a rejection handler (`:230-235`). Pi background slot synchronization has a catch with fixed notification text (`index.ts:188-195`); OpenCode lifecycle queues and session subscriptions catch their failures.

Passed core `vault-request-reading.test.ts` — “vault requestReading reports rejected quota polls without an unhandled rejection and releases deduplication”, OpenCode's failed quota/sidebar and real expired-sidebar-lease deletion tests, plus the existing Pi refresh/slot-failure cases. The new reproduction runs likewise produced no unexpected unhandled-rejection error outside their named assertions. Unhandled promises were **not** counted merely because a call uses `void`: the production callee's catch matters. Rejected injected `authority()`/`recordSnapshot()` implementations would not prove that the actual enrollment/consumer implementation rejects on the ordinary failure inputs examined here; those speculative cases were not reported as defects.

## Recheck of the five fix commits

| Commit | What was rechecked | Candidate evidence |
| --- | --- | --- |
| `3fa8ed5` | Shared enrollment authority; OpenCode 2 login start/completion guards; unreadable menu mode; keep-warm enrollment await; bounded menu roster discovery; vault notice precedence; quota-refusal attribution; setup lease cleanup | All seven `vault-enrollment-audit.test.ts` cases passed; `opencode2-plugin.test.ts` passed “a migrated pool refuses an ordinary login completed after enrollment without changing pool bytes”, “an enrolled migrated host refuses ordinary authorization before OAuth starts” and “setup releases its vault lease when loading the source throws”; quota-attribution tests passed. Finding 1 demonstrates a different, still-unguarded OpenCode 1 request await. |
| `6926919` | Terminal Connect/Disconnect intent remains the selected action when enrollment changes while the menu is open | `vault.test.ts` passed “a stale terminal Connect choice never disconnects a newly enrolled host”; inspected `auth/methods.ts` explicit action dispatch rather than toggling based on the later state. |
| `4c1fb3e` | Pi native-quota guards across storage/queue awaits; both disconnect failure orderings; slot restoration/reapproval reconciliation | Pi `vault-mode.test.ts` passed approval during request/refresh-all storage reads, queued native quota refusal, token/ceremony-removal failure, restore-before/after-move failure, failed disconnect reload, and competing-runtime restore/reapproval cases. Finding 4 concerns the separate deferred **pool quota persistence** queue, not the fixed native-quota send guard. |
| `38a2d7e` | Pi steady background slot sync bypasses the auth lock; explicit/unknown/failure transitions still reconcile | Passed “steady local and vault sync ticks take no Pi auth locks” and “explicit slot sync and recovery after failure take Pi auth locks”. These use the real helper lock counter, including positive transition/explicit controls. No new interval/timeout setting was proposed. |
| `b8982d9` | Merge preserves both host fixes and Pi uses the shared vault authority/cache rather than a second enrollment read/cache | `runtime.ts:300-306` delegates both mode and fresh authority to `OpenAiVault`; the merged OpenCode/Pi suites above passed. `3b2b4b9` itself updates the source text matched by a Pi mutation-test registry entry, not product behavior. |

## Verification record and limits

| Check | Observed result |
| --- | --- |
| `bun run build` | Passed in the final baseline job: 26 installed dependency ranges, six package manifests, all three packages built, types emitted, 134 TUI files generated. Build artifacts were not committed. |
| Core existing suite (`bun run test`, core stage) | 168 passed, zero failed, 13 files, 3,648 assertions. |
| OpenCode existing suite, after build in the **same** remote job | 1,480 passed, 18 skipped, zero failed, 1,498 tests across 82 files. The two newly added red tests were excluded with the exact name filter below. |
| Pi existing suite | 59 passed, zero failed, 265 assertions; final filtered run scanned six files and excluded the three new tests. |
| New OpenCode 1 review suite | **Two intended failures**, zero passes, four assertions, one file; process exit 1. Both fail at the requested contract assertion, not an import/fixture failure. |
| New Pi review suite | **Three intended failures**, zero passes, eight assertions, one file; process exit 1. Token test's positive send/error controls pass first. |
| `bun run typecheck` | Passed all three package `tsc` scripts, TypeScript 7.0.2, no emit. Initial review-harness signature omissions were corrected before final results. |
| `bun run lint` | Passed, Biome 2.5.15, 238 files, no fixes applied in final check. Formatting edits were limited to the two new test files. |

Exact final existing-host-suite command (after `bun run build` in the same job):

```sh
(cd packages/opencode && bun test src/tests --test-name-pattern '^(?!OpenCode1 enrollment during host auth lookup|OpenCode1 vault loader declines).*') &&
(cd packages/pi && bun test src/tests --test-name-pattern '^(?!Pi vault synchronization keeps|Pi queued local quota observation|Pi request error does not expose).*')
```

Caveats and non-findings:

- Remote jobs do not preserve the local cached build or another remote job's generated files. Two attempts to run the entire OpenCode suite without an in-job build failed its explicit missing-`dist`/`tui-compiled` fences. These were corrected by building and testing in one job, not by weakening those tests.
- One earlier built full-suite run had a transient `OpenCode2AuthError: openai primary request refused (no-account)` in “in vault mode a never-migrated install is served from the vault, a login on it is refused with the reason, and nothing is migrated, stored or adopted”. Its isolated rerun passed all 12 tests in that file, and the final built full existing-host run passed the same case. This remains a suite stability observation, not a separately established release defect with a new deterministic reproduction.
- Real-host OpenCode 1/2 E2E suites are opt-in and were skipped; no claim is made that a native host process or Desktop executable was exercised in this review. Pi's existing real `ModelRuntime`/startup tests did run. Fake OpenCode host hooks exercise plugin integration/transport ownership, not every native-host ordering.
- Only installed common-auth 0.14.1 and Pi 1.0.4 behavior was reviewed. No outbound network, live Claustrum, real OAuth ceremony or real user credentials were used. The core, OpenCode and Pi package manifests still name 0.11.0; the requested prospective 1.0.0 review did not edit release metadata.
- No new mutation controls or root mutation registry changes were requested or made. The five new tests fail against untouched product code. Existing tests were not renamed/reversed to match a different contract.

## Resolution

- OpenCode 1 re-reads authority after host auth lookup and at the common physical-send boundary; a local attempt crossed by enrollment takes the vault route or its fixed refusal.
- Non-local OpenCode 1 loaders and requests treat local account storage as optional settings, ignoring parse failures rather than requiring repair. Valid settings still control routing and cache warming; local credentials never become candidates. The malformed-file regression asserts fixed refusal, no send, and unchanged bytes.
- Pi's queued quota observations recheck the fail-closed mode guard before persistence. The deferred-write audit also fences both hosts' pool commits after provider/lock waits, legacy OpenCode settings and refresh persistence, and local sidebar commits. Each boundary has a regression with a positive reached-commit control.
- Shared credential redaction masks the exact attempt bearer plus credential-shaped strings in Pi generated/forwarded errors, OpenCode 1 HTTP/stream/transport errors, and owned OpenCode 2 HTTP/WebSocket/retry errors. Foreign OpenCode 2 connections remain unchanged. No timeout or retry policy is changed.
- Pi regressions now live in `packages/pi/src/tests/request-isolation.test.ts`; OpenCode 1 regressions live beside its normal request tests. The original red captures above remain historical evidence, not the current suite result.
- Finding 3 is accepted design, approved by the release owner; its byte-identical disconnect restore and conflict tests remain unchanged.

The verification record above describes the original review candidate. Fix verification and cross-version mutation results are recorded in the delivery commit and accompanying delivery record.

## Fix verification

All executable gates ran offline on Linux. Bun was `1.4.2 (744846f84)`, TypeScript `7.0.2`, Biome `2.5.15`; full suites used eight vCPUs. The runner supplied the locked OpenCode 1 `1.18.30` and OpenCode 2 `2.0.22` host fixtures. Both E2E opt-ins were enabled: two real OpenCode 1 cases and sixteen real OpenCode 2 cases ran, with no skipped tests.

| Gate | Result |
| --- | --- |
| `bun run types` | Passed the three package typechecks. |
| `bun run lint` | Passed, 243 files, no fixes. |
| `bun run build` | Passed all three packages, 26 installed ranges, six package manifests, types and 134 TUI files. |
| Core suite | 176 passed, zero failed, 15 files. |
| OpenCode suite including both real hosts | A built full run passed all 1,514 tests across 84 files. The final full recheck passed 1,513 and encountered the transient vault quota-admission failure below; that exact real-host case then passed unchanged in isolation. |
| Pi suite | Final run: 68 passed, zero failed, six files, 294 assertions. |
| `ckdev-mutate check` | All 187 catalogue anchors and exact test names verified; runner `0.9.8` on Linux (`0.10.0` also checked locally). |

The final OpenCode 2 real-host vault/401 case briefly refused the first two turns with `quota-unknown` / `no-account`; no model send occurred. The isolated rerun passed all twelve assertions with no source, fixture, timeout or retry-policy change. This is retained as a suite-stability observation, not hidden by changing an expectation. The full run had otherwise passed every OpenCode test, including the remaining seventeen real-host cases.

The Pi vault-menu fixture now seeds its local row **before** enrollment, because the store's new commit fence correctly rejects seeding through runtime account APIs while enrolled. Its menu, quota-floor apply and exclusive-account expectations are unchanged. The rejected native-file byte-identity review test was removed as explicitly approved; restoration and conflict tests were not changed.

### Mutation replay

Each control below was **CAUGHT** under both Bun `1.3.14 (0d9b296a)` and `1.4.2 (744846f84)` by `ckdev-mutate run --only <id> --allow-dirty`. Each selected baseline ran one test and passed; each mutant failed only that named test. Seven other OpenCode tests or eight other Pi tests were filtered out, so this is a focused proof, not a broad catalogue replay.

| Control | Exact test that went red |
| --- | --- |
| `opencode1-local-dispatch-authority` | `OpenCode1 enrollment during request body await prevents physical local dispatch` |
| `opencode1-vault-unused-corrupt-store` | `OpenCode1 vault loader declines locally even when the unused local account file is malformed` |
| `pi-quota-enrollment-commit` | `Pi deferred recordQuota refuses persistence when enrollment lands at commit` |
| `pi-transport-error-bearer-redaction` | `Pi request error does not expose the bearer echoed by the transport` |

Manual replays also recorded the safe staging/restore sequence. Live implementation files were staged first and the unstaged diff was empty. During the breaks, `git diff --stat` showed respectively: `index.ts` one insertion/one deletion; `index.ts` one insertion; `pool-source.ts` one insertion/one deletion; `runtime.ts` one insertion/four deletions. Each file was restored with `git checkout -- <path> && touch <path>` and the unstaged diff was empty again. No break remains in production code. Bun 1.3.14's Linux archive was fetched locally and transferred for offline execution; the temporary payload was removed and no manifest or lockfile changed.

## Streaming hot-path revision

`redactCredentialFrame` now returns immediately when the raw frame does not contain `"error"`. Ordinary delta events therefore require no JSON parse. Candidate envelopes still take the existing parse and exact-credential/token-pattern redaction path; a normal model-text delta whose literal text is `error` is parsed but not rewritten. Byte-level regression coverage also preserves a successful SSE stream across split UTF-8 bytes, mixed line endings, heartbeat comments and data-line whitespace.

### Before/after measurement

Reproducer: `bun scripts/benchmark-credential-redaction.ts before` with the prefilter temporarily removed, then the same command with `after` after restoring it. Both measurements ran on the offline Linux runner with two vCPUs and Bun `1.4.2`. The script constructs a realistic 2,000-event Codex stream: 1,999 `response.output_text.delta` events, followed by either `response.completed` (including full output text and `error: null`) or a terminal `response.failed` carrying an echoed synthetic credential. Payloads are pre-encoded outside the timed region: 397,523 successful-stream bytes and 397,586 failed-stream bytes.

Each variant had ten warmup pairs and sixty measured raw/wrapped pairs, with execution order alternating. Every source chunk contains one SSE event. Source chunks are delivered by an unpaced pull-driven in-memory stream, so this measures CPU and stream-bookkeeping overhead rather than network/model latency. Per-chunk latency is elapsed time from source enqueue to consumer read, with 120,000 chunk observations per mode/variant. Added times are paired wrapper-minus-raw samples, not differences between independent medians. Parse counters run separately, outside timing.

| Phase / terminal event | JSON parses / wrapped stream | Raw total ms, median / p95 | Wrapped total ms, median / p95 | Added total ms, median / p95 |
| --- | ---: | ---: | ---: | ---: |
| Before / completed | 2,000 | 0.321 / 0.417 | 2.391 / 4.147 | 2.064 / 3.716 |
| After / completed | 1 | 0.317 / 0.391 | 1.855 / 2.993 | 1.521 / 2.604 |
| Before / failed | 2,000 | 0.318 / 0.402 | 2.343 / 2.636 | 2.020 / 2.316 |
| After / failed | 1 | 0.315 / 0.392 | 1.730 / 1.979 | 1.408 / 1.624 |

| Phase / terminal event | Raw chunk latency µs, median / p95 | Wrapped chunk latency µs, median / p95 | Added chunk latency µs, median / p95 |
| --- | ---: | ---: | ---: |
| Before / completed | 0.070 / 0.100 | 1.984 / 3.697 | 1.913 / 3.597 |
| After / completed | 0.070 / 0.090 | 1.522 / 2.805 | 1.443 / 2.715 |
| Before / failed | 0.070 / 0.081 | 1.934 / 3.216 | 1.863 / 3.135 |
| After / failed | 0.070 / 0.081 | 1.413 / 2.475 | 1.343 / 2.385 |

The successful stream still parses its completed frame because its legitimate `error: null` field passes the cheap filter; none of its 1,999 delta frames is parsed. Median added whole-stream time decreased by approximately 26% for completion and 30% for failure. **The wrapper is not free:** it still adds a measured median 1.521 ms per successful 2,000-event stream (p95 2.604 ms), plus median 1.443 µs/p95 2.715 µs of paired per-chunk latency. UTF-8 decoding/re-encoding, SSE boundary/line scanning and the extra stream/promise layer remain unchanged. These synthetic CPU-bound measurements do not claim production-network percentile latency or establish a performance threshold.

A focused non-vacuity control temporarily removed the prefilter after staging the live implementation: `git diff --stat` was empty before, showed one insertion/one deletion in `packages/core/src/util/credential-redaction.ts` during the break, and was empty after `git checkout -- <path> && touch <path>`. Only `ordinary delta frames bypass JSON parsing entirely` failed (one parse instead of zero; nine other tests filtered out). The `codex-sse-delta-no-json-parse` row in `mutations.toml` records the exact prefilter removal and the named test that must fail.

### Revision verification

- Linux eight-vCPU run: all three package typechecks passed with TypeScript 7.0.2; the benchmark script also passed a separate strict `tsc --noEmit` check. Biome 2.5.15 checked 244 files with no fixes, and all three packages built.
- OpenCode full suite with both real-host E2E opt-ins enabled: **1,514 passed, zero failed, zero skipped**, 84 files and 6,013 assertions. All two OpenCode 1 and sixteen OpenCode 2 real-host cases ran; this revision's full run was green, including the previously intermittent vault/401 case.
- Core credential-redaction regressions: ten passed, 22 assertions. Pi request-isolation regressions: nine passed, 29 assertions.
- `ckdev-mutate check` passed all 188 catalogue rows. The original four controls and `codex-sse-delta-no-json-parse` were all **CAUGHT** on Linux under both Bun 1.3.14 and 1.4.2, each with a passing selected baseline and only its named mutant failure. The transferred Bun archive was removed; no dependency manifest or lockfile changed.

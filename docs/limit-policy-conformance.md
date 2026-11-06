# Shared limit-policy conformance

This ledger tracks the OpenAI limit-policy contract across OpenCode 1 (OC1), OpenCode 2 (OC2), and Pi. The dependency-surface audit below verifies the published shared-library API, not host behavior. **All 210 host evidence cells are pending; this document does not yet declare conformance.**

## Published shared-library surface

The audited artifact is **`@cortexkit/common-auth@0.38.0`**, npm gitHead `9d1b086e05f179e960ea8892479999bfd7fd5fdd`, fetched with `npm pack @cortexkit/common-auth@0.38.0 --ignore-scripts --json`. Its registry tarball is <https://registry.npmjs.org/@cortexkit/common-auth/-/common-auth-0.38.0.tgz>.

- SHA-1: `c0f8cd2f48ceec73ce06482896bb1ce205f95925`.
- npm integrity: `sha512-YDXtwuuj/gz4h/bPO+UAVItjo3ZMYw9DhccEf4DWAk8dr+Rk/uo/cVUeTRbC4xXE7FXTeBr1HaRnyG7drZIg3w==`.
- The downloaded archive matched both registry hashes; all **316 published `dist/` files** and `package.json` were byte-identical to the installed 0.38.0 dependency. The artifact audit passed **322 assertions**.
- Public imports and declaration/runtime-member checks passed **124 surface assertions** with Bun 1.4.2 on Linux. These checks establish availability, not adoption behavior. No foreign source checkout, unpublished candidate, or source-only export was used as published-dist proof.

All subpaths below have both `import` and `types` targets in the published `package.json`. Paths in the evidence column are relative to that package, not this repository.

| Public import | Verified surface | Published dist evidence |
|---|---|---|
| `@cortexkit/common-auth/limits` | Runtime exports `canonicalLimitsPath`, `LimitsEnvelopeConflictError`, `LimitsEnvelopeUnsupportedError`, and `acquireLimitsRegistry`; declarations export `LimitsRegistry`, `LimitsRegistryOptions`, and `LimitsAbandonReason`. | `dist/limits/index.js` and `.d.ts`; `path.js`/`.d.ts`; `envelope.js`/`.d.ts`; `registry.js`/`.d.ts` |
| `@cortexkit/common-auth/limits` | `LimitsRegistry.abandoned` is a readonly instance property of type `LimitsAbandonReason` or `undefined`, not a standalone named export. `LimitsRegistryOptions.onAbandon?: (reason: LimitsAbandonReason) => void` is an acquire option; runtime acquisition wires the callback, the registry has the getter, and abandonment invokes the listener. | `dist/limits/registry.d.ts:18–35`; `registry.js:88–117,442–480` |
| `@cortexkit/common-auth/limits/vault` | Runtime and declaration export `createVaultLimitsAdapter`, with exported `VaultLimitsAdapterOptions`; separate public vault subpath, not a private implementation import. | `dist/limits/vault.js` and `.d.ts` → `vault-adapter.js` and `.d.ts` |
| `@cortexkit/common-auth/opencode2` | Runtime and declaration exports `installOpenCode2Auth`, `OpenCode2AuthError`, and installer **`MAX_RETRY_HOLD_MS = 3_621_000` ms**. `RetryHold`, `RetryWaitThenReselect`, `RetryDisposition`, `RetryWake`, and `ChooseAccountResult` are exported types, not runtime values. Their declarations carry `hold`, `waitThenReselect`, `hostRetry`, and `wake`/`kind` directives. | `dist/opencode2/index.js` and `.d.ts`; `install.js:6`, `install.d.ts:4`; `types.d.ts` |
| `@cortexkit/common-auth/commands` | Exported `RoutingSectionOptions` has `sameAccountWait?: boolean`; `createCommandMenu` is a runtime export. The implementation gates the menu on `options.routing?.sameAccountWait`. Choices are `Don't wait` (`0`), `15 minutes` (`15`), and `Until the cache expires` (`max`); default/invalid selection displays 15 minutes. This does not claim the plugin has enabled the option yet. | `dist/commands/index.js` and `.d.ts`; `builtins.d.ts:43–48`; `builtins.js:471–508` |

### Other cited shared facilities

The same surface audit checked these public exports so later adapters need no private dist imports:

| Public import | Verified runtime exports | Verified declaration-only surface |
|---|---|---|
| `@cortexkit/common-auth/limits` | `windowRouter`, `limitPresets`, `confirmedAffinity`, `earliestPoolEngine`, `statusVaultOrder`, `decideAfterLimit`, `scanTerminalReset`, `buildRefusal` | `LimitAxes`, `LimitCandidate`, `HoldFacts`, `LimitDecision`, `TerminalFacts`, `WaitCheckpoint`; candidate `admitted`/`placementEligible`/`ready` and terminal `source`/`reason` fields in `dist/limits/decide.d.ts` |
| `@cortexkit/common-auth/limits` | `createPoolLimitsAdapter`, `clearLimitsAfterProbe`, `markFromSignal`, `markIsActive`, `resolveNamedWindowReset`, `resolveReset`, `toOpenCode2LimitSignal` | `IdentityBinding`, `LimitsCommand`, `PersistenceAdapter`, `AccountKey`, `LimitSignal`, `PoolLimitsAdapterOptions`; adapter `namespace`/`store` and vault `namespace`/`path` options; registry methods `observe`, `enqueue`, `beforeDispatch`, `reload`, `flush`, `dispose` in `dist/limits/registry.d.ts` |
| `@cortexkit/common-auth/limits` | `readMaxSameAccountWait`, `sameAccountHoldFacts`, `holdWaitMaxS`, **`MAX_SAME_ACCOUNT_HOLD_MS = 3_621_000` ms**, `createSessionActivityStore`, `effectiveCacheTtlMs`, `waitForPi` | `SessionActivityStore` methods `recordAccepted`, `get`, `forgetSession`; `SessionActivity.accountKey`/`lastAcceptedAt`/`ttlMs` in `dist/limits/activity.d.ts` |
| `@cortexkit/common-auth/limits` | `formatDuration`, `formatReset`, `registerLimitMessages`, `UnsafeWordingError` | Public declarations in `dist/limits/index.d.ts` |
| `@cortexkit/common-auth/routing` | **`QUOTA_STALENESS_MS = 900_000` ms** (15 minutes); not a `/limits` export | Public declaration in `dist/routing/index.d.ts` |
| `@cortexkit/common-auth/store` | `openPoolStore` | Exported `PoolStore`; optional `PoolStore.updateLimitsNamespace?` in `dist/store/pool.d.ts` |
| `@cortexkit/common-auth/routing-accessor` | `askRouting`, `reportRouting` | Public declarations in `dist/routing-accessor/index.d.ts` |
| `@cortexkit/common-auth/claustrum` | `ClaustrumConsumer`, `readVaultRoster`, `reorderVaultRoster`, `mutateVaultRoster` | Public declarations in `dist/claustrum/index.d.ts` |

`terminalRefusalDecision` is an internal shared helper reached through public `decideAfterLimit`, not a promised public import. `recordAccepted` belongs to the activity store; `beforeDispatch`/`observe`/`reload`/`flush`/`dispose` belong to the acquired registry. Plugin helpers such as `ttlForModel`, `limitOfEvent`, and projection reload/recovery-latch facilities are not claimed as shared-library exports. `window-router` is a preset ID, not the exported `windowRouter` value; `hold_wait_max_s` is a routing-advice field, not a named export. Availability of `mutateVaultRoster`/`updateLimitsNamespace` is not permission to add plugin-side envelope repair; native 0.38.0 handling owns it.

## Evidence rules

- Each host cell must name a repository-relative test file and the exact test name, with its verified result. A non-applicable cell must explain the host boundary and cite the exact test that enforces it. `Pending` is neither a pass nor a non-applicability claim.
- `R` reproduces the supplied baseline through the expanded preset; `D` is a deliberate adoption change; `B` is preserved and tested at the plugin/host boundary. `R+D` preserves baseline vectors and adds explicit changed sub-vectors.
- A parser test, shared-library vector, adjacent reroute test, or another host's test cannot stand in for the owning host's evidence. Boundary rows also need tests of their interactions with the new same-account holds, terminal waits/refusals, and registry fences where those features apply.
- For changed hold behavior, retain the original vector without eligible cache and add a separate fitting-cache/all-blockers companion. Do not make the original pass by adding a ready account, fresh reset, or session record.
- Expected wire bodies, messages, durations, and headers must be independent literals or separately stated equations, not values computed by the production helper being tested.
- OA-1 (HTTP dual-field precedence), OA-3/5/6/7/8, OA-12 (equality and invalid explicit reset), OA-17 (equality and model switch), OA-43 (floor equality), OA-55, and OA-57 require those exact vectors, not nearby examples.

### State-ownership exceptions

OC1 evidence for OA-17–21/23–25 must distinguish migrated registry paths from the unmigrated process-local `QuotaManager`. Legacy OA-21/23 does **not** claim cross-process persistence, registry fences, window/cause/`evidenceAt` metadata, tombstones, or delayed-command rejection. Its claims are whole-account expiry/max-until/equality, authoritative healthy-present-window clear, and verified-replacement clear. Legacy tests must not acquire a registry or add metadata to manufacture those guarantees.

For registry paths, expired-probe recovery means a real successful probe of the same account, with no new parsed limit, can clear a previously observed, now-expired mark once. The clear carries that mark's captured identity/evidence fence; ordinary healthy requests, an unrelated account's success, and probes while the mark is live do not earn a clear.

Pi produces and consumes quota readings, not timed marks, and acquires no limits registry. Mark/registry non-applicability needs Pi boundary evidence, including zero acquire/reload calls on first request and projection change, and write-free healthy requests. This does not exempt Pi's routing, activity, wait, wake, output, or custody behavior.

## OA-1–70 host ledger

The adoption column includes the deliberate changes to OA-23/32/36/38/49/50/58/61 and both OA-25 key-change companions. The summaries identify obligations; they do not replace the full vectors or the additional acceptance cases listed below.

| OA | Adoption | Required result / owning boundary | OC1 | OC2 | Pi |
|---|---|---|---|---|---|
| OA-1 | R | OC2 positive absolute body reset wins relative body reset and header. | Pending | Pending | Pending |
| OA-2 | R | Positive relative body reset uses the parser sample, not a fixed 60 seconds. | Pending | Pending | Pending |
| OA-3 | R | Past positive body reset gives hint zero and suppresses header; unnamed future resolution falls through to 60 seconds. | Pending | Pending | Pending |
| OA-4 | R | Headerless, empty-body 429 stays generic with a 60-second mark; no unrelated primary borrowing. | Pending | Pending | Pending |
| OA-5 | R | Numeric Retry-After 1.5 is exactly 1500 ms, without rounding or jitter. | Pending | Pending | Pending |
| OA-6 | R | Header zero is accepted; nonfuture expiry falls through to exact named cache or 60 seconds. | Pending | Pending | Pending |
| OA-7 | R | OC2's numeric-only parser rejects date, invalid, and negative Retry-After values. | Pending | Pending | Pending |
| OA-8 | R | OC2 does not start reading retry-after-ms. | Pending | Pending | Pending |
| OA-9 | R | Capacity/code/generic reasons never become primary; default remains 60 seconds. | Pending | Pending | Pending |
| OA-10 | R | Future explicit reset beats cached reset; storing a mark has no hold cap. | Pending | Pending | Pending |
| OA-11 | R | Only exact primary/secondary may borrow a future cached reset; this resolver has no freshness/headroom check. | Pending | Pending | Pending |
| OA-12 | R | Invalid/past/equal reset falls through and never borrows another window. | Pending | Pending | Pending |
| OA-13 | R | Named failed-frame signal belongs to the sending account; the mark is account-wide. | Pending | Pending | Pending |
| OA-14 | B | OC1 WS admission marks then yields a retryable body error; malformed dropped frame is not output. | Pending | Pending | Pending |
| OA-15 | B | Raw upgrade preserves status/headers/body; native API falls back to HTTP; no new raw OC1 Retry-After parser. | Pending | Pending | Pending |
| OA-16 | R | Auth/unrelated failure creates no exhaustion signal or timed mark; status routing remains possible. | Pending | Pending | Pending |
| OA-17 | R | Whole-account mark is active only before its deadline; equality expires, model switch does not bypass it, B is unaffected. | Pending | Pending | Pending |
| OA-18 | R | Max-until retains later reset; shorter cannot shorten and equal is idempotent across parsed reasons. | Pending | Pending | Pending |
| OA-19 | R | Legacy healthy present-window reading clears only without exhausted sibling; no windows is not health. Migrated/OC2 clear only by earned expired-probe recovery. | Pending | Pending | Pending |
| OA-20 | R | Verified replacement clears old identity; same refresh/unknown identity does not. Migrated clear is fenced; legacy clear is process-local. | Pending | Pending | Pending |
| OA-21 | R | Canonical local store shares, different store tuple isolates; registry paths add cross-process persistence/convergence, with the legacy exception above. | Pending | Pending | Pending |
| OA-22 | R | Same roster shares; different roster and pool namespaces isolate even reused route IDs. | Pending | Pending | Pending |
| OA-23 | D | Registry paths replace the never-released map with schema-safe release/flush/handoff/hydration and durability; legacy exception remains explicit. | Pending | Pending | Pending |
| OA-24 | R | Healthy quota/success never clears a migrated/OC2 live mark; expired-probe recovery is separately gated. | Pending | Pending | Pending |
| OA-25 | R+D | Replacement never inherits old mark; refresh/rotation retains it. Stable account/incarnation fences: same-identity relogin drops the mark; same-identity rows no longer share it. | Pending | Pending | Pending |
| OA-26 | R | Pi frames are token-attributed quota readings; Pi produces/consumes no timed marks. | Pending | Pending | Pending |
| OA-27 | R | Ordered OC1 configured statuses advance once per account without requiring exhaustion; only a separate confirmed/cache companion may hold. | Pending | Pending | Pending |
| OA-28 | R | Ordered OC1/Pi out-of-list status passes through before reduction. In-list/no-next invokes the decision: confirmed fitting reset holds, otherwise byte-exact provider response. | Pending | Pending | Pending |
| OA-29 | B | Indeterminate possibly-sent throw never authorizes another account send; preserve prior readable response where applicable. | Pending | Pending | Pending |
| OA-30 | B | Unreplayable request gets at most one main attempt or blocks; no failover/hold replay. | Pending | Pending | Pending |
| OA-31 | R | OC1 sticky unknown/unconfirmed 429 keeps pin and original failure, with no normalized retry duration. | Pending | Pending | Pending |
| OA-32 | D | Confirmed exhaustion migrates without fitting hold facts; separate eligible same-account cache companion holds rather than moving to B. | Pending | Pending | Pending |
| OA-33 | R | Sticky permanent 401/403 migrates without exhaustion mark or hold, even with fitting cache, confirmed reading, or usage-limit body. | Pending | Pending | Pending |
| OA-34 | B | Quota-pending detour may serve B without moving A's pin. | Pending | Pending | Pending |
| OA-35 | B | Startup poll joins at most 5 seconds then rereads admission; it is not a limit hold. | Pending | Pending | Pending |
| OA-36 | D | Replace placement-first mark Retry-After with fresh setting-capped terminal scan; stale/unknown gets host hint only, zero is non-retryable without header. | Pending | Pending | Pending |
| OA-37 | R | Unknown/incomplete keeps byte-exact OpenAI-shaped local 429, 5-second hint and priority; no 300-second quota wait. | Pending | Pending | Pending |
| OA-38 | D | Preserve killswitch/exhaustion cause; fresh max-per-account/min-across-account reset and setting cap separate truthful reset from retry delay. | Pending | Pending | Pending |
| OA-39 | R | Preserve distinct local auth causes, plain-text 401 without header, and login guard. | Pending | Pending | Pending |
| OA-40 | B | Exhausted last-path provider probe differs from local all-exhausted refusal; no forced hold without cache facts. | Pending | Pending | Pending |
| OA-41 | B | Free quota precedes eligible prepaid credits, then separate exhausted last path; preserve pin behavior. | Pending | Pending | Pending |
| OA-42 | B | Credits need fresh eligible evidence and never override killswitch/spending cap. | Pending | Pending | Pending |
| OA-43 | B | Strict floor equality, default floors, and whole account-specific override remain admission predicates. | Pending | Pending | Pending |
| OA-44 | B | OC1 no-output WS marks plus retryable stream error; host may reissue but fetch loop never resends. | Pending | Pending | Pending |
| OA-45 | B | Unfinished calls/allowed empty reasoning remain replayable despite envelopes/emittedOutput. | Pending | Pending | Pending |
| OA-46 | B | Finished-calls-only synthetic completion preserves tools/results, with no replay, normal onComplete, or failed continuation. | Pending | Pending | Pending |
| OA-47 | B | Other output forbids replay but still marks; preserve existing terminal body. | Pending | Pending | Pending |
| OA-48 | B | Preserve stock/native runtime distinction; experimental native runtime makes no automatic same-turn recovery promise. | Pending | Pending | Pending |
| OA-49 | D | OC2 feedback precedes choice; no eligible hold queues B with zero delay, eligible cache/confirmed reset gives one targeted A hold. | Pending | Pending | Pending |
| OA-50 | D | OC2 lifecycle WS frame is not output; same conditional single-hold overlay, otherwise reroute B with zero delay. | Pending | Pending | Pending |
| OA-51 | R | No new hold facts/alternative queues A and preserves host delay/live mark; never implicit hold or terminal. Preserve the single-account 1234-ms witness. | Pending | Pending | Pending |
| OA-52 | B | Fresh OC2 all-marked escape removes temporary exclusions only, never marks/floors/custody; no request-phase sleep. | Pending | Pending | Pending |
| OA-53 | R | Latest-foreign/mixed attribution leaves host retry before output veto; no plugin quota hold/reroute. | Pending | Pending | Pending |
| OA-54 | R | Owned attributable nonmixed output-started forces retry false; mark may still publish. | Pending | Pending | Pending |
| OA-55 | R | Preserve OC2 failed-event reason allow-list and quota/lifecycle/output facts; usage_limit_reached confirms without reset, rate_limit_exceeded never confirms; no OC1 synthetic rule. | Pending | Pending | Pending |
| OA-56 | R | Retry undefined/throw leaves host and commits no choice; real fresh custody/admission refusal stays distinct; new veto uses typed channel. | Pending | Pending | Pending |
| OA-57 | R | Pi ordered uses captured status before publication even with non-error buffered head; setup throw supplies no status. | Pending | Pending | Pending |
| OA-58 | D | Pi confirmed exhaustion migrates if hold cannot fit; eligible cache/confirmed reset waits on A with spinner/Escape before publication. | Pending | Pending | Pending |
| OA-59 | R | Pi sticky unknown 429 stays untimed retain/original event; permanent 401/403 may migrate but never waits; no manufactured countdown. | Pending | Pending | Pending |
| OA-60 | B | After Pi selected head/rest publication, drain/end only; never re-enter routing. | Pending | Pending | Pending |
| OA-61 | D | Preserve auth causes; quota gains known-reset bounded terminal wait and safe final text; unknown reset never advertises scheduled wait. | Pending | Pending | Pending |
| OA-62 | B | Pi first-reading startup join/reread and incomplete error remain separate from quota wait. | Pending | Pending | Pending |
| OA-63 | R | Unreachable vault without usable receipt keeps bounded startup/incomplete/custody refusal, never local fallback. | Pending | Pending | Pending |
| OA-64 | R | Listed but unusable/old empty roster preserves no-usable-vault-account cause. | Pending | Pending | Pending |
| OA-65 | R | Zero grants preserves no-grant guidance and host principal template, without local fallback. | Pending | Pending | Pending |
| OA-66 | R | Grant with no ChatGPT login preserves category/reclassification guidance. | Pending | Pending | Pending |
| OA-67 | R | Authorization refusals keep custody cause; may skip unsent vault candidate, never infer exhaustion or use local credentials. | Pending | Pending | Pending |
| OA-68 | B | Kept receipt during outage preserves original version/identity; recovery returns to fresh custody, not a quota hold. | Pending | Pending | Pending |
| OA-69 | B | Kept 401 invalidates without report/retry; live once-only newer-receipt recovery and exact served-version report remain custody-owned. | Pending | Pending | Pending |
| OA-70 | B | Reachable refusal, identity/type/enrollment change, and OAuth headroom at or below 60 seconds cannot masquerade as outage or quota wait. | Pending | Pending | Pending |

### Additional acceptance evidence still required

A first owned request is the plugin's first outbound provider request in a new process/temporary home. With an eligible roster, it must reach the fake provider's sentinel with the actual bearer/account attribution after source, custody, and quota readiness, plus registry hydration or decided fallback where applicable; no warm-up request or manual retry is allowed. Projection reload means registry-owning paths reload when the roster's route/row identity binding changes, even inside the 1000-ms freshness interval, then validate the current binding before sending. Repeated changes have a per-request 5000-ms reload bound; mark/quota-only writes do not trigger reload, and Pi/legacy OC1 never acquire or reload a registry.

Completing the OA cells also requires evidence for these additional coverage categories: first-owned-request readiness and projection reload; settings; all-blocker/cache hold bounds; dispatch-sampled accepted activity; terminal scan/provenance; routing accessor caps/keys; registry lifecycle/envelopes/recovery; detached writes and per-account controls; zero speculative commits; real SDK/output delivery; single-wait wake/revalidation; refusal safety and provider pass-through; whole-host regressions; OC1 pending hold/wake; whole-account mark targets and earned clears; OC2 terminal-account selection; and pre-send terminal decisions. These labels are not complete test vectors; the filled ledger must record the actual cases and results. None is established by the dependency audit.

OA-51's owning witness remains `packages/opencode/src/tests/opencode2-retry-choice.test.ts` → `last account keeps the host wait and is not chosen twice`: one account, 429 `usage_limit_reached`, host delay 1234 ms. Transport-continuation tests are separate regressions, not substitutes for that vector. The cell remains pending until the host result is recorded.

Release evidence must separately record OS, locked host version, exact command/results, and fresh-process first-owned local/vault sends. Unit tests or a Linux-only result do not establish the Linux/macOS/Windows release matrix. The short repository gate, `scripts/gate.sh --fast`, is a build/typecheck/packaging check, not completion of this ledger.

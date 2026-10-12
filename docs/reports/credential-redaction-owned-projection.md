# Credential diagnostics: lexical scans and owned error projections

Baseline: unreleased `origin/main` at `131116d7d836fc0f72f728ff440d503a72be2163` (not the published 1.0.1). Tests were added before the affected implementation was changed. Additional baseline replays restored the new implementation saved in Git's staging index afterwards; no baseline or mutation was committed.

## Baseline results

**RED** means a regression assertion failed; **GREEN** means it passed. These labels distinguish credential disclosure from caller execution or a boundary throwing unexpectedly; they are not generic security verdicts.

On Bun 1.4.2, the combined baseline audit and Pi isolation run had **19 pass, 17 fail** (36 tests). The failures below distinguish credential disclosure, caller execution, and a boundary throwing unexpectedly. The original implementation was replayed for `peer later-frame BOM preserves healthy visible bytes`, the live-SSE cancellation test, and the inherited-Error accessor test: **2 pass, 1 fail**, with only the accessor test failing.

| Requested class | Baseline evidence | Change |
| --- | --- | --- |
| Duplicate JSON keys | RED: `audit duplicate keys cannot conceal credentials in HTTP or SSE errors`; raw first duplicate retained the credential. All four peer variants (`literal`, `escaped`, `http-sse`, `sse`) separately failed. | Scan lexical JSON strings, including discarded duplicate values and keys, rather than reconstructing only surviving parsed values. |
| Escaped diagnostics | RED: `audit raw and escape-decoded diagnostics are scanned independently` retained the Unicode spelling. The peer HTTP body containing SSE also failed independently. | Scan raw and JSON-escape-decoded text separately; decoding does not depend on `JSON.parse`. |
| Header names | RED: `audit non-ok header names cannot contain credentials` returned `x-relay-attempt-credential-7f3e9a1c2b`. | Drop credential-bearing names on non-ok responses, still scrubbing values and preserving retry metadata. Header names are case-normalized by Fetch, so the exact credential comparison uses its lower-case spelling. |
| Thrown objects | RED: own getter/toJSON execution, direct Proxy traps, proxied Error prototype traps, and inherited Error accessors. The proxied-prototype baseline ran 4 traps; the inherited-Error baseline ran 1 getter. The callable and bare Symbol inputs threw TypeError instead of producing an Error; these were boundary failures, not observed token disclosures. The owned-projection structural control also rejected Bun's native source-location fields. | Always create a fresh Error. Inspect only own data descriptors after excluding proxies throughout the prototype chain. Drop original prototypes, inherited accessors, arbitrary symbols, causes, callables, platform objects, and unrelated fields. |
| Cancel | GREEN: existing live-SSE cancellation rejection scrubbing, forwarding the caller reason, and reader release; GREEN: completed-stream cancellation never invokes the upstream cancel hook. | No cancellation-policy change. The async helper resolves only after reading a non-ok body, so it cannot return an unread error response for the caller to cancel. Its agreed counterpart, a non-ok body read rejection, was RED (`Read rejected <credential>`) and is now caught/projected. |
| BOM | Peer later-frame BOM: GREEN, byte-identical. Leading BOM: RED, first three UTF-8 bytes were lost. | Keep BOM characters in the decoder; temporarily skip only the initial BOM for SSE field recognition, then restore it. Later BOMs are not treated as a new stream start. |
| Nested/wrapped Response | RED: the Response subclass's status getter ran and threw the credential. Reused-body and nested-Response companions are checked after the subclass control passes. | Use captured native Response accessors/body methods and native Headers iteration, not provider overrides. Catch/project body consumption failures. Responses nested in thrown diagnostics are discarded, not traversed. |
| JWT regex time | GREEN: repeated-trial measurements below showed approximately linear growth through 131,072 characters; the incomplete-token and overlapping-prefix controls passed. | Logger unchanged, as required when the performance issue is not reproduced. |
| Pi partial message | Fetch throw before a start event: GREEN. Shared partial from an earlier start event, later populated with transport error text: RED; the start alias retained `opaque-shared-partial-secret` while the cloned error event was scrubbed. | Scrub the pi-ai-owned error message itself before yielding it; do not leave earlier shared partials pointing at the raw message. Visible model content is not scrubbed. |

### Peer-input portability

The peer's `anthropic-auth/packages/core/verification-inputs/provider-panel-controls.mjs` was copied read-only into the isolated task checkout. It supplied concrete test inputs, not implementation code; the temporary copy was removed after porting and was neither executed nor committed.

- `http-duplicate-literal`, `http-duplicate-escaped`, `http-sse-escaped`, `sse-duplicate-escaped`: independently RED on the baseline and GREEN after the fix.
- `header-name`: credential-bearing diagnostic name RED; retry-after and safe headers retained by the regression control.
- `headers-expando`, `inherited-data`, `thrown-url-slot`: GREEN baseline; no original platform object or inherited token escaped.
- `callable-expando`, `thrown-symbol`: RED baseline due to an undefined JSON serialization reaching the text scrubber and throwing TypeError; now produce safe owned Errors.
- `thrown-stream-slot`: **GREEN on Bun 1.4.2**, **GREEN on Node 24.21.0**, both before and after. Each standalone run executed one assertion on a real thrown object's own body descriptor. Node executed a bundle of the actual redactor, not a mock. Unlike the peer implementation, this implementation already dropped that plain-object stream slot.
- `cancel-rejection-200`: GREEN; exercised by the existing live-SSE cancel/release test.
- `cancel-rejection-401`: **not applicable**. The peer returns an unread non-ok response synchronously; ours resolves only after eagerly reading it. There is no returned response to cancel at that moment. Retaining eager consumption preserves the existing async API; its agreed read-rejection counterpart failed before the fix.
- `later-frame-bom-success`: independently GREEN on the baseline and after the fix. A leading-BOM companion was RED.
- `proxied-prototype-trap`: RED. A direct thrown Proxy trap companion also went RED.
- `framer-options-proxy-trap`: **not applicable**; no exported configurable SSE framer/options object exists here.
- `nested-response-scope-accounting`: **not applicable**; these stateless exports have no disposable response scope or `settled` lifetime accounting promise.
- `healthy-http-success-lazy`, `healthy-visible-stream-bytes`, `healthy-plain-error-scrub`: all GREEN baseline and after. HTTP-mode success returns the identical unread object; successful SSE deltas containing credential-looking text remain unchanged.

## Retained classification contract

`redactCredentialError` owns all output: a fresh `Error` with its standard Error prototype, an own scrubbed message/name, and only bounded primitive classification data in newly allocated containers. Text fields are capped at 16,384 UTF-16 code units **after** scrubbing, so truncation cannot leave the start of a credential at the limit. Native stack/source-location fields are discarded as well. Provider-defined getters, toJSON methods, functions and platform payloads are not traversed or returned. Native DOMException message/name are read through captured intrinsic accessors.

The allowlist is `status`, `statusCode`, `status_code`, `code`, `type`, `isRetryable`, numeric reset fields, `error`/`data` classification (`type`, `code`, `message`, reset fields, and one nested `error`), owned `responseHeaders` with `retry-after-ms`/`retry-after`, scrubbed bounded `responseBody`, and an own `request_id`. Request values, URL, cause, provider detail and custom `resetAt` fields do not cross the boundary. The two known AI SDK Boolean brand symbols are copied only when they are **own data equal to true**; arbitrary symbols are not copied. These Boolean brands are classification data, not an original prototype or callable.

- Installed `@ai-sdk/provider` 4.0.21, `dist/index.js:35-37,42-62`: `APICallError.isInstance` reads `Symbol.for('vercel.ai.error.AI_APICallError')`; the parent brand is `Symbol.for('vercel.ai.error')`. Its fields include `statusCode`, `isRetryable`, `responseHeaders`, and `data`. Keeping only the name would lose SDK retry recognition. `credential-projection.test.ts` uses the real installed `APICallError.isInstance`, not a copied brand predicate, and verifies status, retry-after, and quota classification survive.
- `packages/opencode/src/response-stream-error.ts`: `ProviderResponseStreamError` is an API error with an explicit `isRetryable` Boolean. The projection tests cover pre-output retryable errors and non-retryable terminal/overflow controls, preserving **exact** `TERMINAL_AFTER_OUTPUT_MESSAGE` and `OVERSIZED_FRAME_MESSAGE` text.
- `packages/opencode/src/tests/ws-pool.test.ts:2894-2942`: the OpenCode 1.18.30 message retry-pattern inventory is copied from its retry policy. Matching status/overload/transport/timeout/retry wording can override a non-retryable flag. The fixed terminal/overflow messages and original classification tests remain in force; provider diagnostic causes cannot be appended to those messages by projection.
- `packages/opencode/src/ws.ts:1021-1059`: quota recognition reads `error.type`/top-level `type`, `status`/`status_code`, and `resets_at`/`resets_in_seconds`. The projection and lexical frame tests prove the same window/reset decisions with positive, independently asserted expected values. In-band quota marking happens before redaction (`ws.ts:711-751`, `ws-pool.ts:361-369`, `index.ts:2933-2968`), and reactive HTTP fallback reads response status, not the thrown object's prototype (`index.ts:5248-5273`).
- Overflow is signaled by WebSocket close 1009, causing HTTP fallback and a non-retryable fixed diagnostic (`ws.ts:854-882`, `ws-pool.ts:400-412`). Output-shape decisions precede error projection. Existing usage-limit, overflow, terminal-after-output and tool-call recovery suites all pass.
- `packages/pi/src/pool-request.ts:197-248,352-379`: Pi routing uses captured HTTP status and quota state (not diagnostic prototype). Its `onResponse` attribution is unchanged. Installed pi-ai 1.0.4 emits an SSE start only after successful fetch; WebSocket and later transport errors can update the same shared partial object. Error-event cloning was the alias leak.
- OpenCode's post-redaction abort checks now accept `Error` or native `DOMException` named `AbortError`. The original constructor assertions in integration/pool tests were changed deliberately: provider prototypes and native DOMException identity are no longer retained. Assertions now pin SDK recognition, retryability, name, owned prototype, abort propagation, and unchanged routing/send counts. A mutation disabling projected-abort recognition fails the existing reactive-fallback control.

SSE envelope classification and the ordinary/Unicode-delta no-JSON-parse fast paths remain unchanged; successful frames are not globally scanned. The four exported signatures and eager non-ok response consumption semantics remain unchanged.

## Follow-up controls and exact host policy

The second peer audit's three classes were all RED against 131116d (4 failing tests):

- A token wrapped inside a Bearer value retained its suffix: `Rejected [credential]-\ncredential-7f3e9a1c2b`. Newline, CRLF and mixed whitespace are tested, with and without the Bearer prefix. A literal-token fast path plus a whitespace-normalized span scan removes the whole known token before generic Bearer matching can consume only the prefix.
- Re-serialization changed `900719925474099312345` to `900719925474099300000`, `1.2300` to `1.23`, and `1e+005` to `100000`. Lexical rewriting now preserves every unrelated number's original spelling. A numeric credential in a bare JSON value was also RED; that affected scalar becomes a quoted redaction marker rather than leaking or producing invalid JSON.
- Provider request ids were not promoted from headers/body into an own Error field. The projection now owns `request_id`, preferring an existing own string field, then `x-request-id`, then the root body's `request_id`. Credentials in ids are scrubbed. Numeric body ids are extracted from their raw source lexemes into strings so large ids do not round.

The final scalar follow-up was RED on the original implementation for numeric retry metadata. It also independently failed for Boolean `true` after number handling was added. String, number, Boolean and null literal values are now handled lexically; any credential-equal scalar in an error frame becomes `[credential]`. Unrelated retry metadata is unchanged, and ordinary successful delta frames still bypass all rewriting.

### Keep-warm

The actual shared cachekeep manager retains non-ok response text (first 600 characters) and thrown fetch errors in warning fields. Before this change, **local and vault HTTP and thrown-error controls were RED**: warning `responseBody`/`error` contained both the opaque warm bearer and its CRLF-wrapped form. Warm body-read failures are a **GREEN companion**: the shared manager already discards those failures, logs an empty successful usage result, and does not retain the error text. The tests assert that the source pull did run; No raw error text is retained in that case, so no redaction marker is required. The first test draft's marker assertion was corrected after confirming the manager discards the rejection.

The per-attempt dispatch in `core/cachekeep.ts` now calls `redactCredentialResponse(..., accessToken, 'event-stream')` and catches/project errors with that same attempt token, before the shared manager or vault can consume provider diagnostics. Both custody controls assert a physical send with the selected authorization, safe manager logs and safe manager status. Existing cachekeep JSON/SSE usage/attribution tests and real vault 401-report/version/backoff tests remain in the full suite. The inspected warm adapter has no separate response-body dump, sidebar notification, or host response-value sink; normal request-path dumping is not called by its direct fetch. This conclusion is scoped to the adapter and installed common manager, not arbitrary injected caller loggers.

### Host source, delay and overflow equivalence

Exact MIT-licensed OpenCode v1.18.30 snapshots of `session/retry.ts`, `provider/error.ts`, and `llm/src/provider-error.ts` are checked in under `packages/opencode/src/tests/fixtures/opencode1-error-policy/` with their license and source URLs. The fixture executes the original pure functions and overflow matcher, not a copied approximate predicate. Framework timer scheduling is not part of this fixture. The adapter passes `{name: 'APIError' | 'ContextOverflowError', data: parsed}` records to the retry functions after the actual provider parser selects the category; real SDK identity is checked independently before parsing.

The actual policy reads normalized status/retryability/message **and responseBody**, and gives `retry-after-ms` precedence over `retry-after`. An empty headers object means uncapped exponential backoff, unlike missing headers (30-second cap). The provider parser checks `context_length_exceeded` in body error code (or status 413 or the actual message overflow matcher). The initial projection omitted responseBody, retry-after-ms and empty-header presence; retaining them prevents changes to overflow, retry and delay decisions.

`credential-host-policy.test.ts` executes the actual functions on the original and projection and independently asserts expected retry, overflow and delay values for:

- retryable 429, millisecond precedence (1250 ms), seconds only (2500 ms), no headers (30,000 ms), empty and unrelated headers (128,000 ms at attempt 7);
- FreeUsageLimitError and GoUsageLimitError with workspace/limitName metadata;
- context_length_exceeded, a late overflow code in a large body, a retry marker after 70,000 padding bytes, a large Go-usage body, and a non-retryable 400;
- a readable small body with secret removal and unchanged numeric lexemes.

The body cap is **65,536 UTF-8 bytes**, separately from the 16,384-code-unit message/name limit. The 64 KiB working bound retains ordinary short error fixtures while preventing complete partial outputs from being retained indefinitely. Bodies at/below the cap remain full, readable and scrubbed. Larger bodies become compact owned JSON containing error code/type, matched retry phrases and Free/Go markers, and bounded Go workspace/limitName metadata (256 code units each). The overflow code and late retry markers therefore survive outside the retained raw-text window. Diagnostic rendering and unrelated body fields are deliberately not preserved in oversized projections.

`numeric scalar aliases are scrubbed without rounding or masking unrelated numeric ids` failed on semantic aliases (`1e+005`/`100000.00` for credential `100000`, and `123e-2` for `1.23`). Decimal canonicalization compares digit strings and scale without floating-point conversion; unrelated adjacent-digit ids keep their exact bytes. Exponent arithmetic is bounded to 16 significant exponent digits, with raw exact matching still available outside that comparison. Numeric body request ids are extracted after redaction, so an encoded credential does not reappear through the support-id field.

`Pi fetch throws are owned before pi-ai reads diagnostic getters` failed when its real pi-ai fetch received a Proxy rejection: the library executed **13** Proxy callbacks while inspecting the exception. The fetch wrapper now projects rejections with the attempt token **before** pi-ai receives them; synchronous/iterator/outer runtime catches also use the owned Error helper instead of `instanceof`/`String` conversion of caller objects. The shared-error-message alias fix remains necessary for transports that do not use fetch.

## Performance measurements

### SSE wrapping

Command: `bun scripts/benchmark-credential-redaction.ts before` / `after-final`, on the offline Linux runner (2 vCPUs), Bun 1.4.2. Each variant uses 60 measured alternating raw/wrapped pairs, 10 warmups, and 2,000 pre-encoded events (2,001 for escaped-completed). These are unpaced microbenchmarks, not provider/network latency measurements. Successful byte counts and error redaction byte counts are checked by the script. Each wrapped stream still performs **one JSON parse**, with normal delta fast paths unchanged.

| Variant | Wrapped total before median / p95 (ms) | Wrapped total after median / p95 (ms) | Added chunk latency before median / p95 (µs) | Added chunk latency after median / p95 (µs) |
| --- | ---: | ---: | ---: | ---: |
| completed | 1.608 / 2.718 | 1.929 / 2.631 | 1.272 / 2.264 | 1.533 / 2.445 |
| failed | 1.622 / 2.078 | 1.831 / 2.176 | 1.253 / 1.974 | 1.363 / 2.254 |
| escaped-completed | 1.681 / 2.467 | 1.715 / 2.604 | 1.342 / 2.215 | 1.373 / 2.325 |

Median total increases were 0.321, 0.209 and 0.034 ms per full stream, respectively; tails vary with the shared runner. The stronger guards are not represented as a performance improvement.

### JWT scanning

Command: `bun scripts/benchmark-credential-jwt.ts`, before and after, Bun 1.4.2 on Linux. For each shape/size: 20 warmup trials, **100 measured trials with 100 calls each**, reporting per-call median/p95. `overlapping` is the peer's `eyJ-` repetition; `incomplete` has a long eyJ prefix/payload with no closing signature segment. The logger implementation was not changed.

| Shape / chars | Before median / p95 (µs) | After median / p95 (µs) |
| --- | ---: | ---: |
| overlapping / 512 | 0.334 / 0.433 | 0.333 / 0.402 |
| overlapping / 2,048 | 0.694 / 1.202 | 0.481 / 0.837 |
| overlapping / 8,192 | 1.920 / 3.052 | 1.680 / 2.843 |
| overlapping / 32,768 | 6.418 / 10.341 | 6.453 / 11.192 |
| overlapping / 131,072 | 25.428 / 39.336 | 25.874 / 63.086 |
| incomplete / 516 | 0.176 / 0.378 | 0.333 / 0.410 |
| incomplete / 2,052 | 0.473 / 0.813 | 0.474 / 0.530 |
| incomplete / 8,196 | 1.657 / 3.042 | 3.809 / 4.247 |
| incomplete / 32,772 | 6.411 / 10.963 | 6.448 / 15.091 |
| incomplete / 131,076 | 25.417 / 39.527 | 25.381 / 37.758 |

The largest-step median growth is approximately proportional to input length, not quadratic. This is empirical evidence for these concrete shapes, not a proof about every possible regex input. Installed common-auth 0.14.2 uses an eyJ word/dot/hyphen scan rather than a regex requiring three complete JWT segments.

## Mutation proofs and verification

All **24 new `credential-audit-*` rows** and five maintained earlier rows (`credential-decoded-json-value-redaction`, the missing/plain content-type rows, `pi-transport-error-bearer-redaction`, `pi-caller-sse-mode`) report **CAUGHT on both Bun 1.3.14 and 1.4.2**: 58 targeted replays. `ckdev-mutate check` verifies the complete catalogue's anchors and exact test names. Linux runner: ckdev-mutate 0.9.8 (local installed CLI is 0.11.0). These are targeted proofs, not a broad mutation audit.

For every new row, a separate manual replay staged the live source, captured an empty unstaged diff, applied the exact `NON-VACUITY BREAK`, captured a non-empty `git diff --stat`, ran only the named test on both Bun versions, restored with `git checkout -- <path> && touch <path>`, and captured the empty diff again. Every selected final mutant produced **0 pass / 1 fail**, naming only its expected test; other tests were filtered, not falsely claimed as passing. Full unmutated suites establish those other tests separately.

Two mutation drafts exposed weaknesses in the controls rather than implementation defects:

- Changing only TextDecoder's ignoreBOM option survived on Bun 1.3.14 (1 passing selected test). The final BOM control explicitly omits the preserved BOM prefix and fails on both versions. The surviving option mutation's source diff was independently captured/restored, and a same-file proxy control and corrected BOM control both fail.
- The first projected-abort mutation targeted a migrated-routing callback that the selected legacy reactive test did not defend. It was retargeted to the actual reactive branch and caught. Later, the Pi caller-mode mutant survived final event collection because in-place partial scrubbing now repairs those aliases. The existing Pi response-mode test was strengthened with an **immutable response-text snapshot at the fetch boundary before pi-ai parses it**; wrong mode now fails at that snapshot on both versions. A draft snapshot in onResponse was rejected because pi-ai supplies response metadata there, not a Response; no wrong-reason failure is used as the final proof.

Authoritative final implementation gates:

- Bun 1.4.2 / TypeScript 7.0.2: `bun run types` (three package tsc checks) and explicit script `tsc --noEmit --skipLibCheck --target esnext --module preserve --moduleResolution bundler --types bun` passed.
- Biome 2.5.15: `bun run lint`, **253 files**, passed.
- `bun run build`: three packages, **26 dependency ranges / 6 manifests**, all passed. Standard tsdown/TypeScript-7 experimental-API warnings remain informational.
- `bun run test`, Linux **8 vCPUs**: core **225 pass**, OpenCode **1528 pass / 26 skip**, Pi **74 pass**, no failures.
- Explicitly enabled real-host e2e, Linux **8 vCPUs**: OpenCode 1.18.30 **4 pass**, OpenCode 2.0.22 **18 pass**, **22 total**, no skips or failures. Runs use the built plugin and locked native host binaries, with loopback provider/vault fixtures.
- Bun 1.3.14 restored targeted suites: **90 tests / 7 files**, all passed.
- Standalone thrown-stream-slot: **1 check passed on Bun 1.4.2**, **1 check passed on Node 24.21.0**, both before and after.

No manifests or locks changed. The remote npm cache initially lacked the locked host tarballs; the fixture dependencies were fetched locally with npm 11.19.1 (`npm ci --ignore-scripts --os=linux --cpu=x64 --prefix ...`, 5 packages per host), after which offline remote e2e ran successfully. An unnecessary temporary archive attempt failed on read-only dependency-directory metadata and was removed; no shared dependency source was edited. Earlier remote test attempts without an in-job build failed packaging prerequisites; final jobs build first. Seven initial OpenCode failures concerned intentionally removed provider/DOMException prototypes or the real abort-recognition regression; updated assertions preserve the meaningful retry/reroute properties, and the abort checks were fixed rather than weakening those controls.

Named mutation evidence is committed in `credential-redaction-mutation-evidence.json` (25 successful manual proofs, plus the explicitly undefended draft BOM-option control with same-file successful controls). The delivery declaration carries the same rows. Final Pi snapshot changes are test-only; subsequent types/lint, the full **74-test Pi suite**, and both-version mutation replay passed. Scoped inspection has authoritative diagnostics for **11/11 source files, 0 errors or warnings**; unrelated graph-analysis categories are unavailable in this task checkout and are not represented as clean.

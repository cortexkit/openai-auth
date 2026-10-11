# Credential redaction at error boundaries

## Changes and red-first checks

- Non-OK responses rewrite every header value with the same exact-credential and
  JWT redactor used for the body and status text. Ordinary `content-type` and
  `retry-after` values survive; stale `content-length` is removed. A diagnostic
  header is dropped only if rewriting it throws. Iteration uses the original
  headers so dropping one header cannot skip the next diagnostic.
- SSE cancellation forwards the caller's reason unchanged, sanitizes a rejected
  cancellation with `redactCredentialError`, and releases the upstream reader in
  `finally`.
- The frame candidate gate recognizes escaped JSON error fields and typed error
  envelopes. Parsing still decides whether to redact; successful model output
  remains byte-identical, including CJK and surrogate-pair emoji escapes.
- Parsed non-OK JSON bodies and genuine SSE error envelopes recursively redact
  decoded string values, including exact credentials, JWTs and Bearer patterns.
  JSON is reserialized only when a value changes; otherwise original whitespace
  and escaping survive. Non-JSON HTTP bodies retain the text-redaction path.
  Numeric status/usage fields and usage-limit codes are unchanged.

Before implementation, the new header, cancellation, and escaped-key wrapper
tests all failed on Bun 1.4.2 (10 passing, exactly these three failing). Each test
uses an opaque attempt credential and a JWT-shaped credential; the header and
cancellation tests also include a separate JWT echo to exercise shape redaction.
The successful SSE byte-identity test now includes escaped CJK and emoji deltas
across seven-byte chunks, plus escaped credential-looking model and tool content.
Ordinary and escaped deltas have parse-bypass tests. The later decoded-value
HTTP and SSE tests also failed before that fix (15 passing, exactly these two
failing), revealing the opaque token, JWT and Bearer text after JSON decoding.
They now assert sanitized nested arrays/objects while retaining HTTP 429,
`retry-after`, `usage_limit_reached`, reset time and usage counts. HTTP JSON and
SSE error frames with no credential retain their original whitespace/escapes.

## Can error headers escape into OpenCode?

Installed `@opencode-ai/plugin` 1.18.34 and `@opencode/plugin` 2.0.22 are plugin
interfaces, not host implementation source. Their AI SDK provider 3.0.8 defines
`APICallError.responseHeaders`; the installed OpenAI provider 3.0.88 uses provider
3.0.14 with the same field. In installed
`@ai-sdk/provider-utils/src/response-handler.ts` (4.0.40, lines 35–99), the
non-OK JSON response handler extracts headers and supplies them to `APICallError`
for empty bodies, parsed errors, and parsing failures. The constructor preserves
them (`@ai-sdk/provider/src/errors/api-call-error.ts`, lines 7–54). They are not
part of the constructor's message, but remain structured error data.

The locked real-host fixtures install `opencode-ai` 1.18.30 and `@opencode/cli`
2.0.22. Their platform packages contain compiled binaries without host source
or source maps. The following downstream conclusions therefore use the public
source tags corresponding to those installed binary versions, not a claim that
the plugin-interface packages implement the hosts:

- **OpenCode 1: yes, headers can reach a user through JSON CLI output.**
  [`parseAPICallError`](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/provider/error.ts#L183-L191)
  forwards the headers;
  [`MessageV2.fromError`](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/message-v2.ts#L679-L704)
  constructs an `APIError` retaining `responseHeaders`.
  The processor assigns that error to the assistant message and publishes it in
  [`session.error`](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/processor.ts#L613-L638).
  [`run --format json`](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/cli/cmd/run.ts#L678-L690)
  serializes the full event error via
  [`emit("error", { error: props.error })`](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/cli/cmd/run.ts#L781-L790).
  The ordinary CLI display uses only the message. The message-update path also
  publishes the whole message
  ([`Session.updateMessage`](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/session.ts#L629-L633));
  database serialization was not independently established here and is not
  needed for the affirmative JSON-output conclusion.
- **OpenCode 2: headers do not survive the normal structured session-error
  conversion.**
  [`toSessionError`](https://github.com/anomalyco/opencode/blob/v2.0.22/packages/core/src/session/to-session-error.ts#L28-L59)
  maps provider failures through
  [`providerError`](https://github.com/anomalyco/opencode/blob/v2.0.22/packages/core/src/session/to-session-error.ts#L88-L96),
  copying the message, HTTP status and optional body, not headers. The
  [`SessionError` schema](https://github.com/anomalyco/opencode/blob/v2.0.22/packages/schema/src/session-error.ts#L7-L12)
  has no headers field. This is a negative conclusion for that session-error
  boundary, not an assertion about every debug log or internal error object.

Header redaction is unconditional on non-OK responses regardless of whether a
particular host currently exposes the structured diagnostics.

## Streaming benchmark

Command: `bun scripts/benchmark-credential-redaction.ts <label>`, Bun 1.4.2,
Linux runner with 8 vCPUs. All three runs used 10 warmups and 60 measured paired
raw/wrapped rounds, alternating order. Payload bytes were identical between
phases. `completed` and `failed` retain the original 1,999 deltas plus terminal
event; `escaped-completed` adds exactly 2,000 deltas of JSON-escaped `你好🙂`
plus a successful terminal event. Chunks are pre-encoded, one SSE event per
source chunk, pull-driven without network pacing. Added costs are paired
wrapped-minus-raw measurements, not differences of aggregate quantiles.

| Phase | Variant | Added stream ms median / p95 | Added chunk µs median / p95 | JSON parses / stream |
| --- | --- | --- | --- | --- |
| Before fixes | completed | 1.836 / 2.097 | 1.693 / 2.565 | 1 |
| Before fixes | failed | 1.863 / 2.207 | 1.723 / 2.714 | 1 |
| Before fixes | escaped-completed | 1.734 / 1.992 | 1.643 / 2.334 | 1 |
| Broad `error` or `\\u` gate | completed | 2.372 / 3.174 | 2.064 / 4.238 | 1 |
| Broad `error` or `\\u` gate | failed | 1.962 / 2.413 | 1.803 / 3.036 | 1 |
| Broad `error` or `\\u` gate | escaped-completed | 2.537 / 3.858 | 2.354 / 4.358 | 2,001 |
| Narrowed gate, before decoded-value fix | completed | 2.241 / 3.837 | 1.973 / 3.837 | 1 |
| Narrowed gate, before decoded-value fix | failed | 2.193 / 3.361 | 1.944 / 3.386 | 1 |
| Narrowed gate, before decoded-value fix | escaped-completed | 2.095 / 3.488 | 1.843 / 3.276 | 1 |
| Final, with decoded-value fix | completed | 2.013 / 2.885 | 1.783 / 3.487 | 1 |
| Final, with decoded-value fix | failed | 2.034 / 3.115 | 1.702 / 3.256 | 1 |
| Final, with decoded-value fix | escaped-completed | 2.146 / 3.495 | 1.864 / 4.238 | 1 |

The broad gate increased escaped-stream median added cost by about 46% and
p95 by about 94%, and parsed all 2,000 deltas. That is material, so the gate was
narrowed and remeasured. The final candidate patterns recognize actual `error`
keys or `type: error` values with literal or escaped ASCII letters, preceded by
a cheap `\\u00` check. They include partially escaped `o`, `y`, and `p` as well
as `e`, `r`, and `t`: restricting to the latter three would miss valid JSON such
as `{"err\\u006fr":...}` or `{"t\\u0079pe":"err\\u006fr",...}`. They do not
parse Unicode-escaped model deltas, even deltas containing `\\u0065`.

The narrowed gate parses only the terminal event. With the decoded-value fix,
the escaped variant's median added cost is about 0.13 ms above the ordinary
completed variant in the same run. Across-run timings are noisy (notably
ordinary-stream p95); these are microbenchmark costs, not claims about
end-to-end provider latency.

## Verification

All final types, lint, build, full package suites and both real-host E2E suites
ran on the Linux runner with 8 vCPUs, Bun 1.4.2:

- `bun run types`: TypeScript 7.0.2, all three package typechecks passed.
- `./node_modules/.bin/tsc --noEmit --skipLibCheck --target esnext --module preserve --moduleResolution bundler --types bun scripts/benchmark-credential-redaction.ts`:
  passed with the locked TypeScript 7.0.2 toolchain. The root scripts directory
  has no tsconfig, so the editor's inferred-project missing Node/Bun ambient
  types are not an authoritative script check.
- `bun run lint`: Biome 2.5.15, 244 files checked, no errors.
- `bun run build`: passed for all three packages, including 26 installed-range
  dependency checks, 6 local-package manifest checks and 134 compiled TUI files.
- `bun run test`: core 189 passed across 15 files; OpenCode 1,499 passed,
  22 intentionally skipped across 84 files; Pi 69 passed across 6 files.
- `OPENAI_AUTH_OPENCODE1_E2E=1 OPENAI_AUTH_OPENCODE2_E2E=1 bun test --cwd packages/opencode ./src/tests/opencode1-e2e.test.ts ./src/tests/opencode2-e2e.test.ts`:
  18 passed across both real-host files, 189 assertions. The locked Linux x64
  host binaries were fetched locally with npm 11.19.1 using
  `npm ci --ignore-scripts --os=linux --cpu=x64 --prefix <fixture>` for each
  fixture. No manifest or lockfile changed; execution was remote.
- Focused `credential-redaction.test.ts`: 17 passed, 100 assertions on both Bun
  1.4.2 and 1.3.14. The additional Bun 1.3.14 check ran locally using the
  already-installed mise executable.
- Scoped editor diagnostics: zero errors/warnings in the core implementation
  and tests; structural analysis was unavailable, and Bun assertion typings
  produced two non-error `await` hints.
- Comment review examined all five changed files and flagged no unclear comments.

`ckdev-mutate` 0.10.0 verified catalogue anchors and exact test names. Each row
below was replayed individually with `ckdev-mutate run --only <id> --allow-dirty`
on **both Bun 1.3.14 and 1.4.2**, with a passing baseline and result **CAUGHT**:

| Control | Bun 1.3.14 | Bun 1.4.2 |
| --- | --- | --- |
| credential-non-ok-header-redaction | CAUGHT | CAUGHT |
| credential-sse-cancel-rejection-redaction | CAUGHT | CAUGHT |
| credential-sse-escaped-error-redaction | CAUGHT | CAUGHT |
| credential-decoded-json-value-redaction | CAUGHT | CAUGHT |
| codex-sse-delta-no-json-parse | CAUGHT | CAUGHT |

Catalogue replays run locally because the runner mutates and restores the
worktree. These are targeted catches, not a broad mutation audit. Separate
Linux mutation probes confirmed the named regressions: unchanged headers,
unscrubbed cancellation rejection, missed escaped keys, text-only JSON matching
(each HTTP/SSE assertion separately), forced Unicode-delta parsing, and mutable
header iteration that skips a header after deletion. Before each direct probe,
the live implementation was staged and the unstaged diff was empty. Every
mutation produced a nonempty `credential-redaction.ts` diff (1 insertion,
1 deletion), and `git checkout -- <path> && touch <path>` restored an empty
unstaged diff. No mutation remains in the implementation.

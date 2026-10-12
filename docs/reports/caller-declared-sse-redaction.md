# Caller-declared SSE credential redaction

## Consumer behavior established before changing product code

All three streaming consumers parse successful response bodies as SSE without
requiring a `text/event-stream` response header:

- **OpenCode 1:** installed `@ai-sdk/openai` 3.0.88 selects
  `createEventSourceResponseHandler` in Responses `doStream` (installed
  `packages/opencode/node_modules/@ai-sdk/openai/src/responses/openai-responses-language-model.ts`,
  around line 1083). Installed `@ai-sdk/provider-utils` 4.0.40
  `src/response-handler.ts:101–119` checks only for a body, then invokes
  `parseJsonEventStream`. Its `src/parse-json-event-stream.ts:18–29` decodes
  bytes and feeds `EventSourceParserStream`, with no response-header gate.
  The installed utilities live under
  `node_modules/.bun/@ai-sdk+provider-utils@4.0.40+d6123d32214422cb/node_modules/@ai-sdk/provider-utils/`.
  `stream-content-type.test.ts` serves seven-byte chunks over loopback and
  asserts the actual response header is absent or exactly `text/plain`.
  Both SDK calls throw a parsed error containing the sent message and code.
  The real OpenCode 1.18.30 host also exposes that streamed error in JSON CLI
  output under both headers.
- **OpenCode 2:** the installed `@opencode/cli` 2.0.22 fixture contains its
  launcher, package manifest and platform executable, not native-driver source.
  The corresponding public source binds the Responses HTTP route to SSE
  ([Responses protocol](https://github.com/anomalyco/opencode/blob/v2.0.22/packages/ai/src/protocols/openai-responses.ts#L317-L339)),
  passes body bytes to the framer
  ([HTTP transport](https://github.com/anomalyco/opencode/blob/v2.0.22/packages/ai/src/route/transport/http.ts#L98-L139)),
  and decodes SSE without a response content-type predicate
  ([framing](https://github.com/anomalyco/opencode/blob/v2.0.22/packages/ai/src/route/framing.ts#L36-L82)).
  These links are matching-tag source, not installed source maps. The real-host
  tests independently establish the behavior: a 200 loopback response carrying
  an SSE error, under either header, reaches the native driver's `retry` hook
  with the provider's error message. The mock refuses once; the host retries
  successfully, so observing only final CLI output would miss the parsed error.
- **Pi:** installed `@earendil-works/pi-ai` 1.0.4
  `dist/api/openai-codex-responses.js:322–338,478–484` passes successful HTTP
  responses into `processStream` and `parseSSE`; `parseSSE` at lines 582–630
  reads body bytes and `data:` lines without checking response content-type.
  Pi's `request-isolation.test.ts` sends through the real `streamSimple`
  implementation to a loopback server and verifies actual headers. Both raw
  streams produce the sent error message before the runtime wrapper is involved.

The source paths above are installed dependency paths, not committed source.
Before product changes, the two SDK parser tests and four real-host parser cases
established header-independent parsing. The OpenCode 1 host reports the error;
OpenCode 2 reports it at its retry boundary. Pi's raw-stream assertions also
passed, while its whole-runtime no-secret assertions revealed that its shared
`start.partial` message retained the credential even though the final error
message was sanitized.

## Change and red-first regressions

`redactCredentialResponse(response, credential, mode)` has a closed internal
`'event-stream' | 'http'` mode, defaulting to HTTP. Two-argument non-stream calls
still work; successful HTTP responses retain their original response/body
without acquiring a reader. Non-OK HTTP redaction is unchanged in either mode.
Caller-declared SSE responses always take the existing streaming scrubber,
regardless of provider headers. No response content-type is invented or changed.

All four OpenCode 1 model-send branches (ordinary/vault WebSocket responses,
HTTP without a string body, and buffered HTTP) declare SSE mode. OpenCode 2's
native-driver response hook declares SSE mode. Pi wraps its chosen model fetch
before `pi-ai` parses the response, preserving the caller's fetch implementation
and its properties. This keeps echoed secrets out of shared partial messages,
not just the final error event. Pi's parsed-error redactor remains in place for
non-HTTP transports and thrown errors. The streaming benchmark also explicitly
declares SSE mode so it continues to measure the scrubber rather than HTTP
pass-through.

Before implementation on Bun 1.4.2:

- Core: 17 passed, exactly the two new explicit-SSE missing/plain-header tests
  failed, displaying the opaque exact credential and a separate JWT.
- OpenCode integration: exactly four new missing/plain-header tests failed
  (two per entry), exposing both the attempt credential and a JWT.
- Pi: both new runtime tests failed on the no-secret assertion for
  `start.partial`; raw-SDK parser and sanitized-final-error assertions passed.

The successful-stream byte-identity test now runs with absent, `text/plain`, and
`text/event-stream` headers. It compares actual returned bytes against the
original pre-encoded bytes across seven-byte UTF-8 boundaries, including CJK,
emoji, literal/escaped credential-looking text, a JWT, tool argument content,
and `error: null`. Only genuine error envelopes are rewritten.

## Mutation evidence

`ckdev-mutate` 0.11.0 checked all 198 catalogue anchors/test names. Each new row
was replayed with a passing baseline using
`ckdev-mutate run --only <id> --allow-dirty` on both installed Bun versions:

| Control | Bun 1.3.14 | Bun 1.4.2 |
| --- | --- | --- |
| credential-sse-missing-content-type | CAUGHT | CAUGHT |
| credential-sse-plain-content-type | CAUGHT | CAUGHT |
| opencode1-caller-sse-mode | CAUGHT | CAUGHT |
| opencode2-caller-sse-mode | CAUGHT | CAUGHT |
| pi-caller-sse-mode | CAUGHT | CAUGHT |
| pi-transport-error-bearer-redaction (parsed-event fallback) | CAUGHT | CAUGHT |

These are targeted catches, not a broad catalogue audit. The mutation tool runs
locally because it edits/restores the worktree; Bun 1.3.14 was selected with its
already-installed mise binary directory, without changing repository config.
Reports are outside build directories at
`/tmp/openai-auth-bg-dd82-mutation-bun{1314,142}-{missing,plain,oc1,oc2,pi}.json`.

Separate Linux Bun 1.4.2 probes of the five new controls used the staged live
implementation, confirmed an empty unstaged diff, introduced a temporary defect
annotated `NON-VACUITY BREAK`, captured a nonempty 1-insertion/1-deletion diff,
then restored with `git checkout -- <path>` and `touch <path>` and confirmed an
empty diff. The defects and their exact regression names were:

- Skip wrapping when content-type is absent:
  `explicit SSE mode scrubs credentials with missing content-type`.
- Skip wrapping when content-type is `text/plain`:
  `explicit SSE mode scrubs credentials with text/plain content-type`.
- Change the buffered OpenCode 1 send to HTTP mode:
  `OpenCode1 streaming sends scrub errors with missing content-type`.
- Change the OpenCode 2 response hook to HTTP mode:
  `through the OpenCode 2 entry scrubs streaming errors with missing content-type through the response hook`.
- Change Pi's model fetch to HTTP mode:
  `Pi runtime parses and scrubs SSE errors with missing content-type`.

Each core probe ran all 20 tests: exactly its listed test failed, with the other
19 passing, including byte identity and the other header case. Each caller
probe ran only its listed regression and failed that test alone.

The existing `pi-transport-error-bearer-redaction` control now targets the
late-event regression rather than the HTTP-error regression. The new fetch
scrubber already removes HTTP echoes, making bypass of the later parsed-event
redactor harmless for that HTTP test. The late-event test directly supplies a
provider event without an HTTP wrapper and still needs the parsed-event
redactor; no existing test assertion was weakened or reversed. Its separate
Linux probe failed only `Pi late-event error masks every occurrence of an opaque
attempt credential` (10 tests filtered out), with a 1-insertion/4-deletion
`runtime.ts` diff during the break and an empty unstaged diff after restoration.
Both Bun replay reports also exist with the `pi-fallback.json` suffix.

## Final verification

Required package and host gates ran together on the Linux runner with 8 vCPUs,
Bun 1.4.2. Locked Linux host fixture binaries were installed locally with npm
11.19.1 using `npm ci --ignore-scripts --os=linux --cpu=x64 --prefix <fixture>`;
no package manifest or lockfile changed.

- `bun run types`: TypeScript 7.0.2, all three package typechecks passed.
- `./node_modules/.bin/tsc --noEmit --skipLibCheck --target esnext --module preserve --moduleResolution bundler --types bun scripts/benchmark-credential-redaction.ts`:
  TypeScript 7.0.2, the separately checked benchmark script passed.
- `bun run lint` and `bun run format:check`: Biome 2.5.15, 245 files each,
  no errors or fixes.
- `bun run build`: passed for all three packages, including 26 installed-range
  checks, 6 local-package manifest checks and 134 compiled TUI files.
- `bun run test`: core 192 passed across 15 files; OpenCode 1,505 passed and
  26 intentionally skipped across 85 files; Pi 71 passed across 6 files.
- `OPENAI_AUTH_OPENCODE1_E2E=1 OPENAI_AUTH_OPENCODE2_E2E=1 bun test --cwd packages/opencode ./src/tests/opencode1-e2e.test.ts ./src/tests/opencode2-e2e.test.ts`:
  22 passed, 207 assertions, across both real-host files.
- Scoped editor diagnostics: zero errors/warnings in
  `packages/core/src/util/credential-redaction.ts`,
  `packages/core/src/tests/credential-redaction.test.ts`,
  `packages/opencode/src/v2/setup.ts`, `packages/pi/src/runtime.ts`, and
  `packages/opencode/src/tests/stream-content-type.test.ts`. Structural analysis
  was unavailable; authoritative repository typechecks passed. Three Bun
  assertion `await` hints were non-errors.
- Comment review of the staged source/catalogue/test changes examined 14 files
  and flagged no unclear comments. A separate report review flagged two scope
  descriptions, now clarified with exact probe tests and diagnostic file names.

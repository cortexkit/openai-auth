# OpenCode 1.18.30 error-policy source fixtures

These are unmodified MIT-licensed source snapshots from the `v1.18.30` tag of `anomalyco/opencode`:

- `retry.ts.txt`: https://raw.githubusercontent.com/anomalyco/opencode/v1.18.30/packages/opencode/src/session/retry.ts
- `provider-error.ts.txt`: https://raw.githubusercontent.com/anomalyco/opencode/v1.18.30/packages/opencode/src/provider/error.ts
- `overflow.ts.txt`: https://raw.githubusercontent.com/anomalyco/opencode/v1.18.30/packages/llm/src/provider-error.ts
- `LICENSE.txt`: https://raw.githubusercontent.com/anomalyco/opencode/v1.18.30/LICENSE

`../opencode1-error-policy.ts` extracts and executes the original pure retry, delay, provider parsing, and overflow-matcher function bodies with Bun's TypeScript transpiler. It omits framework imports and Effect scheduling, not the policy functions. The extracted retry and provider-parser functions call `iife` to execute a callback immediately; the retry fallback calls `isRecord` to check for a JSON object containing a message. `SessionV1` category predicates accept the normalized records constructed by the tests (`APIError` or `ContextOverflowError`); they are not replacements for upstream retry or overflow matching. Before normalization, every original and projected error must pass the **real installed AI SDK's** `APICallError.isInstance` check.

The controls assert independent expected retry/overflow Booleans and numeric delays before comparing original and projected decisions. The separate real-host e2e suites run the locked OpenCode executables and built plugin rather than this extraction.

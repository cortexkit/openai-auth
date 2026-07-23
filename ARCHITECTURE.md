# Architecture

## Pattern Overview

**Overall:** Multi-account OAuth plugin with Codex request rewriting, reactive account fallback, push-based quota tracking, prompt-cache stabilization, idle cache keep-warm, and a separate TUI sidebar communicating over a loopback RPC.

**Key Characteristics:**
- Registers as the built-in `openai` provider; OpenCode loads external server plugins after its internal ones, so this package transparently supersedes OpenCode's internal OpenAI auth hook.
- Rewrites OpenAI Responses requests into Codex's wire shape (headers, body, tools, turn metadata) so the Codex backend treats traffic as if it came from the official Codex CLI.
- Reactive (not preemptive) account fallback: a `401`/`403`/`429` triggers a retry on the next usable account, respecting routing mode. Enforce the killswitch as a hard circuit-breaker directly on the request path to block requests or filter candidates before spending when cached quota falls below configured thresholds.
- Push-only quota tracking: quota comes from `x-codex-*` HTTP response headers or `codex.rate_limits` WS frames — no extra polling during normal traffic.
- Three transport modes share the cache-stabilizer behavior: HTTP/SSE, native WebSocket, and a hand-rolled RFC 6455 WebSocket (Bun.connect or node:net/node:tls).
- TUI sidebar reads a serialized `sidebar-state.json` snapshot pushed by the auth loader; the loader and TUI exchange dialogs/notifications over a loopback HTTP RPC bound to a per-process token.
- Plugin is split into a generic, provider-agnostic core (`core/`) and Codex-specific seams (`provider.ts`, `oauth.ts`) so the same shape could host another OAuth provider.

## Layers

**Provider injection seam:**
- Purpose: Generic types (`ProviderRefreshFn`, `ProviderQuotaFn`, `ProviderHttpError`) plus the two Codex-specific fns (`codexRefreshFn`, `whamUsageFn`).
- Location: `packages/opencode/src/core/provider.ts`
- Contains: Token-refresh function type, quota-fetch function type, error shape carrying `status` + `retryAfter`, Codex OAuth constants, Codex HTTP refresh impl, Codex `wham/usage` quota fetch impl.
- Depends on: `core/backoff.ts` (`parseRetryAfter`); dynamic-imported `quota-normalize.ts` (avoids a load-time cycle).
- Used by: `FallbackAccountManager` and `QuotaManager` constructors; `index.ts` plugin loader.

**Accounts and fallback storage:**
- Purpose: Atomic, multi-account JSON store with file locks, retry/backoff state, killswitch config, routing mode, persisted quota, log level, and dump/cachekeep toggles.
- Location: `packages/opencode/src/core/accounts.ts`, `packages/opencode/src/core/atomic-write.ts`, `packages/opencode/src/core/refresh-file-lock.ts`
- Contains: `loadAccounts`/`migrateIfNeeded` (serialized under the shared save lock to coordinate concurrent migrations and mutations), `mutateAccounts` (authoritative read-modify-write for structural mutations and scalar writes to prevent concurrent union-merge resurrection of deleted accounts/secrets), `saveAccounts` (test seeding only), `saveAccountState` (updates state secrets, gated by config roster to prevent resurrection of deleted account secrets), `FallbackAccountManager` (background refresh, `getUsableFallbackAccounts`, `markUsed`), `OAuthAccount`/`ApiKeyAccount` types, single-writer eviction-marker file lock, atomic JSON write (temp + rename, mode `0o600`).
- Depends on: `core/oauth.ts` (`extractAccountId`), `core/provider.ts` (`ProviderQuotaFn`), `core/backoff.ts`.
- Used by: Plugin loader, CLI (`cli.ts`), `/openai-account`/`/openai-routing`/`/openai-killswitch` commands, every quota push.

**Quota cache and policy:**
- Purpose: In-memory cache of main + per-fallback quota snapshots, dedup of inflight fetches, refresh-after math, backoff gating, and mid-stream rate-limit marks.
- Location: `packages/opencode/src/core/quota-manager.ts`
- Contains: `QuotaManager` class with `getMain`/`setMain`/`getFallback`/`setFallback`/`seedFallbacksFromAccounts`/`isBackedOff`/`isFallbackBackedOff`, rate limit marking (`markRateLimited`, `isRateLimited`, `rateLimitedUntil`), stable-identity policy peeks (`peekMainForPolicy`, `peekFallbackForPolicy`) to prevent token refreshes from invalidating cached quota, token-fingerprint helpers, `refreshAllQuota` orchestration. Policies drop cached window snapshots when their reset timestamps are in the past.
- Depends on: `core/accounts.ts` types, `core/provider.ts` (`ProviderQuotaFn` injection).
- Used by: Plugin loader (push updates), `refresh-all-quota.ts` (active polling for `/openai-quota`).

**Backoff and retry policy:**
- Purpose: Classify refresh and quota errors as transient vs non-transient, build retry records, expose `*BackoffActive` checks.
- Location: `packages/opencode/src/core/backoff.ts`
- Contains: `isTransientRefreshError`, `isTransientQuotaError`, `buildRefreshOperationError`, `buildQuotaOperationError`, `hashRefreshToken`, `refreshBackoffActive`, `quotaBackoffActive`, `parseRetryAfter`.
- Depends on: `node:crypto`.
- Used by: `accounts.ts`, `quota-manager.ts`, `refresh-file-lock.ts`, plugin loader (`refreshMainWithLease`).

**OAuth flow:**
- Purpose: PKCE generation, OAuth authorize-URL building, local callback HTTP server, device-code flow, JWT/account-id extraction, fallback-account onboarding.
- Location: `packages/opencode/src/core/oauth.ts`
- Contains: `CLIENT_ID`, `ISSUER`, `OAUTH_PORT`, PKCE helpers, `startOAuthServer`, `waitForOAuthCallback`, `beginDeviceAuth`, `completeDeviceAuth`, `buildAuthorizeUrl`, `flowCleanup`, `parseJwtClaims`, `extractAccountIdFromClaims`, `beginAccountLogin`, `upsertAccount`.
- Depends on: `node:http`, `node:timers/promises`, `version.ts`.
- Used by: Plugin loader (`/login openai` `methods`), CLI (`login`), `/openai-account add`.

**Cache keep-warm:**
- Purpose: Track idle main-agent (and optionally subagent) sessions and replay the last real request as a `store:false` shadow request just before Codex evicts the prompt cache. Employs model-aware TTL (raising GPT-5.6 TTL to 30 min from the 5-min default), gpt-5.6 subagent 2-warm caps, a process clock-bound window (outside of which warming and capture are skipped), and extended subagent idle bounds (75 min for GPT-5.6 subagents).
- Location: `packages/opencode/src/core/cachekeep.ts`
- Contains: `CacheKeepManager` class (target map, timer, idle caps, backoff), `buildKeepwarmCapture`, `buildKeepwarmBody`, model-aware TTL matcher (`isGpt56Model`, `ttlForModel`), clock window checker (`isWithinCacheKeepWindow`), SSE/JSON usage extraction.
- Depends on: `core/accounts.ts` (`findCachekeepFallbackAccount` exported from `index.ts`), `quota-normalize.ts`.
- Used by: Plugin loader (per-instance wiring); `/openai-cachekeep` command.

**Request transformation:**
- Purpose: Convert OpenAI Responses calls into Codex-shaped wire requests (UUIDv7 thread/turn ids, Codex turn-metadata header, OAuth/ChatGPT account headers, client_metadata, tool normalization, cache-stabilizer injection, key-reordering via `orderCodexBody` to match Codex wire serialization), with an opt-in Responses Lite shape for eligible GPT-5.6 models. Responses Lite trades capabilities for compact requests by disabling parallel tool calls, moving system instructions and tools into developer messages prefixing the input sequence, excluding hosted tools, and stripping details from images. Preserves OpenCode's native `max` reasoning variant on the wire and filters legacy experimental `-pro` model entries from the OAuth catalog. Resolves and preserves model/variant context for synthetic command replies to prevent model regression.
- Location: `packages/opencode/src/index.ts` (`prepareCodexRequest`, `maybeInjectCacheStabilizerTool`, `normalizeCodexTool`, `getCodexSessionMetadata`, `loadCodexSessions`/`saveCodexSessions`), `packages/opencode/src/hosted-web-search.ts` (provider-hosted web-search tool + replay rewrite + SSE translation), `packages/opencode/src/prompt-context.ts` (`resolvePromptContext`), `packages/opencode/src/response-stream-error.ts`.
- Depends on: `util/uuid-v7.ts`, `util/stable-json.ts`, `util/record.ts`, `config.ts`.
- Used by: Plugin loader `sendWithAccessToken`, `fetch` override.

**Transports:**
- Purpose: Run Codex requests over HTTP or WebSocket, with a session-keyed pool for the WebSocket path and Codex-style incremental streaming when the hand-rolled client is enabled. WebSocket connection starts with a prompt-prewarming phase (sending a `generate: false` body to populate the session's prompt cache and establish continuation state) before sending the main turn. Intercepts rate-limit notifications on both prewarm and main connections via the `onRateLimitReached` callback to mark the account rate-limited. Applies a no-replay gate (forces a retryable `ResponseStreamError` only if no text was yet emitted, enabling a same-turn fallback reroute on the stock `@ai-sdk/openai` runtime, else closes the stream to prevent duplication, double-billing, or re-running side-effecting tools; note that same-turn rerouting is bypassed under the experimental native runtime `OPENCODE_EXPERIMENTAL_NATIVE_LLM=1` where the errored body rejects with a non-retryable error, though the mark still steers the next turn off that account).
- Location: `packages/opencode/src/ws.ts` (WS connect/stream, header ordering, idle timeout, retryable terminal hook, mid-stream event parser), `packages/opencode/src/ws-pool.ts` (per-account pool, continuation state, `OpenAIWebSocketPool`), `packages/opencode/src/raw-ws.ts` (runtime selection), `packages/opencode/src/raw-ws-bun.ts` (`Bun.connect`), `packages/opencode/src/raw-ws-node.ts` (`node:net`/`node:tls`), `packages/opencode/src/util/proxy-env.ts`.
- Depends on: `dump.ts`, `hosted-web-search.ts`, `quota-normalize.ts`, `response-stream-error.ts`, `util/error.ts`, `util/record.ts`.
- Used by: Plugin loader `sendWithAccessToken`.

**RPC (loader ↔ TUI):**
- Purpose: Loopback HTTP server so the TUI can drain queued notifications and dispatch `apply` calls back to the auth loader (which already holds QuotaManager / FallbackAccountManager / storage).
- Location: `packages/opencode/src/rpc/rpc-server.ts`, `packages/opencode/src/rpc/port-file.ts`, `packages/opencode/src/rpc/rpc-client.ts`, `packages/opencode/src/rpc/rpc-dir.ts`, `packages/opencode/src/rpc/protocol.ts`, `packages/opencode/src/rpc/notifications.ts`.
- Contains: 32-byte hex token, 1 MiB body cap, timed-out HTTP requests (2s), per-process port files (`port-<pid>.json`), pid-based discovery (drops dead pids), SHA-256(project-dir) `XDG_STATE_HOME/cortexkit/openai-auth/rpc/<hash>/` for cross-process dir resolution, queue with monotonic IDs and per-session TUI-connected tracking.
- Depends on: `node:crypto`, `node:http`, `node:fs/promises`.
- Used by: Plugin loader (server + notifications push), `tui.tsx` (RPC client polling + dialog delivery).

**TUI sidebar:**
- Purpose: Render an OpenCode sidebar slot showing main/fallback quota bars, routing/killswitch/health state, and the command dialog surfaces. The TUI does not own any auth state — it reads `sidebar-state.json`, resolves the session-safe active account via `resolveSessionSidebarRouting`, and pushes commands via RPC.
- Location: `packages/opencode/src/tui.tsx`, `packages/opencode/src/tui/entry.mjs`, generated `packages/opencode/src/tui-compiled/`, `packages/opencode/src/tui/command-dialogs.tsx`, `packages/opencode/src/sidebar-state.ts`, `packages/opencode/src/tui-preferences.ts`.
- Depends on: `@opentui/core`, `@opentui/solid`, `solid-js`, `jsonc-parser`.
- Used by: OpenCode's TUI plugin loader (`./tui` export).

**Quota normalization:**
- Purpose: One place to coerce three quota shapes (HTTP `x-codex-*` headers, WS `codex.rate_limits` frame, wham/usage JSON) into the shared `OAuthQuotaSnapshot`, including reset-timestamp coercion (epoch seconds/ms/ISO).
- Location: `packages/opencode/src/quota-normalize.ts`
- Contains: `normalizeQuotaHeaders`, `normalizeWsFrame`, `normalizeWham`, `toResetIso`.
- Used by: Plugin loader (push), `refresh-all-quota.ts`, `cachekeep.ts`, `provider.ts` (dynamic import to avoid a cycle).

**Model cost restoration:**
- Purpose: Restore real model costs from a local cache or a remote catalog (`models.dev`) when cost zeroing is disabled.
- Location: `packages/opencode/src/model-costs.ts`
- Contains: `loadModelsDevCosts`, `resetModelCostsForTest`, `toSdkCost` with strict price validation, `modelsCachePath` checking `OPENCODE_OPENAI_AUTH_MODELS_CACHE`/`OPENCODE_MODELS_PATH` env vars and falling back to XDG cache, and catalog caching with a timeout-backed fetch.
- Depends on: `node:fs/promises`, `node:os`, `node:path`.
- Used by: `packages/opencode/src/index.ts` models provider hook.

**Settings and logging:**
- Purpose: Resolve plugin settings from env + config file, and provide a leveled, secret-redacting, size-rotating logger.
- Location: `packages/opencode/src/config.ts`, `packages/opencode/src/logger.ts`, `packages/opencode/src/dump.ts`.
- Contains: `getSettings`, `getConfigDir`, `getConfigPath`, `DEFAULT_CODEX_API_ENDPOINT`; leveled logger with redaction (Bearer/sk-/JWT, secret/api-key/password/token-like keys), 5 MiB log rotation keeping 3 generations; request-dump writer with redaction for `authorization`/`chatgpt-account-id`/`cookie`/`set-cookie` and body diffing.
- Depends on: `node:os`, `node:path`, `node:fs`.
- Used by: Plugin loader, command implementations, every logger channel (`transport`, `quota`, `refresh`, `accounts`, `cachekeep`, `rpc`, `dump`, `sidebar`, `commands`, `rpc-tui`).

**Utilities:**
- Purpose: Small, dependency-free helpers shared by every layer.
- Location: `packages/opencode/src/util/` (`error.ts`, `proxy-env.ts`, `record.ts`, `stable-json.ts`, `uuid-v7.ts`, `open-url.ts`).
- Contains: `errorMessage`, `ProxyEnv.getProxyForUrl` (Bun honors `HTTPS_PROXY`/`HTTP_PROXY`), `isRecord`, `stableStringify`, `uuidV7` (UUIDv7 with ms timestamp prefix), cross-platform `openUrl`.
- Used by: Everywhere.

**Commands (dialogs):**
- Purpose: Per-slash-command payload builders producing `OpenDialogPayload` (text + knobs) and applying user selections to storage. Copies the command context copy per invocation to prevent concurrent sessions from crossing feedback.
- Location: `packages/opencode/src/commands.ts`
- Contains: Command name constants (`OPENAI_*_COMMAND_NAME`), `MODAL_COMMANDS`, `CommandContext` DI shape, `buildDialogPayload`, `applyCommand`, `executeQuotaCommand`/`executeAccountCommand`/`executeRoutingCommand`/`executeKillswitchCommand`/`executeDumpCommand`/`executeLoggingCommand`/`executeCachekeepCommand`/`executeResetCommand`.
- Depends on: `core/accounts.ts`, `core/cachekeep.ts`, `core/oauth.ts`, `core/refresh-all-quota.ts`, `core/reset-credits.ts`, `quota-manager.ts`, `rpc/protocol.ts`, `logger.ts`, `config.ts`.
- Used by: Plugin loader (`auth.loader`), RPC `apply` dispatch.

**CLI (`openai-auth`):**
- Purpose: Manage fallback accounts from a shell — useful on headless machines or in scripts.
- Location: `packages/opencode/src/cli.ts`
- Contains: `login`/`list`/`remove` subcommands, browser or device-code (`--headless`) OAuth flow, self-fallback rejection (refuses to add the main account as a fallback).
- Depends on: `core/accounts.ts`, `core/oauth.ts`, `util/open-url.ts`.
- Used by: The published `openai-auth` CLI (run via `npx @cortexkit/opencode-openai-auth`).

**Pi extension (sibling package):**
- Purpose: Same Codex OAuth capability for the Pi coding agent (separate OpenAI Codex Responses API surface).
- Location: `packages/pi/src/index.ts`, `packages/pi/src/raw-ws-node.ts`
- Contains: Provider registration (`openai-codex`), model list (`gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark`), custom streaming wrapper, hand-rolled WebSocket shim.
- Depends on: `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `node:net`/`node:tls`.
- Used by: Pi extension loader.

## Data Flow

**OAuth login + token refresh (main account):**

1. User runs `/login openai` and picks "ChatGPT Pro/Plus (browser)" or "(headless)" — `packages/opencode/src/index.ts` `auth.methods`.
2. `startOAuthServer` + `generatePKCE` + `buildAuthorizeUrl` open the authorize URL — `packages/opencode/src/core/oauth.ts`.
3. `waitForOAuthCallback` (browser) or `beginDeviceAuth` + `completeDeviceAuth` (headless) completes the flow.
4. `migrateIfNeeded` seeds the multi-account store on first run, serializing operations under the shared save lock to coordinate concurrent migrations and mutations — `packages/opencode/src/core/accounts.ts`.
5. `auth.loader` constructs `QuotaManager`, `FallbackAccountManager`, and (if any fallback accounts) starts `fallbackManager.startBackgroundRefresh()`.
6. Each refresh runs through `codexRefreshFn` with file-lock + lease concurrency — `core/refresh-file-lock.ts`, `index.ts` `refreshMainWithLease`. Refreshed token persistence retries up to 3 times to prevent transient file locks or API write errors from invalidating sessions.

**Reactive fallback (per request):**

1. Plugin loader `auth.fetch` resolves the session affinity ID from the request's headers (`x-session-affinity`, `x-opencode-session`, `x-session-id`, `session-id`) and determines the routing mode (purely mode-driven: `main-first` or `fallback-first`). If `fallback-first` mode is active and the request is replayable, it proactively tries usable fallback accounts before the main account.
2. Strips any existing `authorization` header, refreshes an expired main token via `refreshMainWithLease`, or refreshes a fallback via `fallbackManager.refreshAccount`. Derives the main ChatGPT identity from the access token JWT to ensure correct quota/killswitch tracking after a main-account switch.
3. If a proactive fallback serves, its response is used. If a proactive fallback request throws a transport error (both caller-aborts and indeterminate transport failures), routing halts immediately and the error propagates to prevent request duplication and double-billing. Otherwise (or under `main-first` mode), checks if the primary account is blocked by the killswitch (verifying cached quota against configured thresholds) or by a mid-stream rate-limit mark. If blocked, it synthesizes a 429 response carrying a `Retry-After` header derived from the earliest known reset time across all accounts (or the mid-stream mark's own reset time, whichever is tighter).
4. If the request is not blocked by the killswitch, calls `sendWithAccessToken` which rewrites headers/body via `prepareCodexRequest`, picks HTTP or WS transport, and optionally tracks the body for cachekeep — `packages/opencode/src/index.ts`.
5. If the primary request fails with a fallback status (`401`/`403`/`429`), is blocked by the killswitch, or encounters mid-stream rate-limit exhaustion before streaming starts, and the request is replayable, `tryFallbackAccounts` reactively iterates usable fallback accounts (filtering candidates below their killswitch thresholds and unconditionally excluding those with active mid-stream rate-limit marks) and retries each candidate — `packages/opencode/src/index.ts`. Indeterminate transport failures on reactive fallbacks halt routing immediately to prevent duplication. If a fallback attempt fails, its advisory quota headers are pushed to the cache. Reactive fallback is skipped if the proactive gate already tried all fallbacks in `fallback-first` mode.
6. The final response's `x-codex-*` headers are normalized via `normalizeQuotaHeaders` and pushed into `QuotaManager` (main or per-account). The loader then calls `writeRequestSidebarRouting` to write the routing snapshot to `sidebar-state.json`. If a session ID is present, it registers the active account to that session in `activeRouting` (pruned to 128 entries and 1 hour age); otherwise, it falls back to legacy routing. The TUI sidebar resolves the active account for its session via `resolveSessionSidebarRouting`.

**Quota push (no extra polling during normal traffic):**

1. HTTP path — `normalizeQuotaHeaders(finalResponse.headers)` runs inside the `fetch` override.
2. WS path — `codex.rate_limits` in-band frame fires `onQuota` in `ws.ts`, which calls back into `pushQuota` carrying the connection's per-request access token, internal quota account key, and the served ChatGPT account ID header to prevent cross-account leakage.
3. `pushQuota` writes to `QuotaManager.setMain`/`setFallback` (discarding stale main frames and past-expired windows) and triggers `writeMachineSidebarState` (updates machine-global state in the sidebar snapshot using `setSidebarMachineState`).
4. `/openai-quota` command additionally calls `refreshAllQuota` to actively fetch `wham/usage` for main + every fallback (respecting per-account backoff).

**Slash command (TUI dialog):**

1. OpenCode TUI fires `command.execute.before` for `/openai-*`.
2. The plugin returns `cleanAbort()` (sentinel throw) so OpenCode does NOT execute any built-in command — `packages/opencode/src/index.ts`.
3. The plugin pushes an `open-dialog` notification via `pushNotification` (`packages/opencode/src/rpc/notifications.ts`).
4. TUI's `tui.tsx` polls the loader's loopback RPC (`/rpc/pending-notifications`), receives the dialog, and renders it via `command-dialogs.tsx`.
5. User clicks Apply → TUI POSTs `/rpc/apply` → loader's `apply` calls `buildDialogPayload`, mutates storage via `mutateAccounts`, and returns updated knobs for the TUI to re-render.

**`/openai-reset` credit redemption:**

1. The account list reuses each account's valid L1 access token to fetch `wham/usage` and reset-credit inventory in parallel, producing a per-account preview. Only exhausted accounts with an applicable, eligible credit and a stable ChatGPT account identity can continue.
2. Selecting an account opens an explicit L2 confirmation bound to its stable `chatgptAccountId`; the dialog states that one reset credit will be spent and that the action is irreversible.
3. Confirmation resolves the target again and rejects the redemption if its ChatGPT identity no longer matches the bound identity.
4. A new attempt re-fetches quota and credits and re-checks exhaustion and applicable-credit preconditions immediately before claiming a credit. Under the persisted-pair retry rule (3a), an explicit retry instead requires an active in-flight attempt and reuses its `creditId` and `redeemRequestId` pair.
5. `consumeResetCredit` sends the explicit credit ID and redemption UUID to the consume endpoint in a POST bounded by a 60-second timeout. The read-only credit-list GET is bounded by a 15-second timeout; an abort surfaces as an `http_error` list failure.
6. Terminal server outcomes (`reset`, `already_redeemed`, `nothing_to_reset`, `no_credit`) clear the matching in-flight pair and persist `lastOutcome`; only the credit-spending `reset` and `already_redeemed` outcomes start cooldown. HTTP and ambiguous outcomes preserve the pair so a retry can reuse the same identifiers; an expired unreconciled pair requires an explicit replay, while corrupt local state is recorded as locally ambiguous instead of issuing a consume request.
7. A successful or already-redeemed outcome runs the normal targeted quota refresh for the selected account, pushes the result through `QuotaManager`, refreshes the sidebar snapshot, and fetches the remaining applicable-credit count.

Server-side deduplication of a repeated `redeem_request_id` is verified live (2026-07-23): replaying a consumed `(redeem_request_id, credit_id)` returns `already_redeemed` with `windows_reset: 0`, the account's available-credit count does not decrement a second time, and the response carries the original redemption's `redeemed_at`. Replaying a consumed identifier is therefore safe — the server dedupes on it and never spends another credit — which is the invariant the retry path relies on.

**Cache keep-warm (idle session):**

1. Every main-agent (and optionally subagent) request is captured by `buildKeepwarmCapture` from `sendWithAccessToken`. Outside of the configured clock window, capture is skipped.
2. `cacheKeepManager.track` stores the body + replay headers per session, computing `cacheExpiresAt` using model-aware TTL (30 min for GPT-5.6 models, 5 min otherwise).
3. A 60s timer fires; if the current hour is within the clock window, it checks each tracked session. For sessions within `leadMs` of expiry and within their respective idle caps (1 h main, 30 min subagent, or 75 min for GPT-5.6 subagents), it calls `buildKeepwarmBody(body)` (`store:false`, token caps removed) and replays via `fetchImpl`.
4. Successful warms increment `warmCount`. A GPT-5.6 subagent session is immediately removed/evicted from tracking once its `warmCount` reaches the 2-warm cap.
5. Failures trigger a 10-min backoff per session.

## Key Abstractions

**`CodexAuthPlugin` (the plugin itself):**
- Purpose: Entry point for OpenCode's plugin system. Returns `Hooks` (auth, provider, tool, event, dispose).
- Location: `packages/opencode/src/index.ts`
- Pattern: Factory; accepts `PluginInput` + `CodexAuthPluginOptions`; wires the auth loader, the WebSocket pool, the RPC server, and the global `__openaiAuthCacheKeepManager`.

**`FallbackAccountManager`:**
- Purpose: Owns the in-memory fallback state, background refresh, and `getUsableFallbackAccounts` (killswitch + routing aware).
- Location: `packages/opencode/src/core/accounts.ts`
- Pattern: Constructor-injected `refreshFn` (`codexRefreshFn`) and `quotaManager`; background timer with on-demand `markUsed` to refresh before the next request.

**`QuotaManager`:**
- Purpose: Single source of truth for in-memory main + per-fallback quota. Inflight dedup per fingerprint so concurrent calls with different tokens never cross-pollute.
- Location: `packages/opencode/src/core/quota-manager.ts`
- Pattern: Push-only (no `fetchQuotaFn` injected — quota comes via `setMain`/`setFallback`); active refresh is orchestrated by `refreshAllQuota`.

**`CacheKeepManager`:**
- Purpose: Idle prompt-cache warmer with per-session targets, idle caps (1 h main / 30 min subagent, extended to 75 min for GPT-5.6 subagents), clock window checks, and 10-min backoff after a failed warm.
- Location: `packages/opencode/src/core/cachekeep.ts`
- Pattern: Target map keyed by session id; interval timer; bounded (`maxTargets`, `maxBytes`) so a long-lived process cannot leak; model-aware TTL adjustment (30-min TTL for GPT-5.6 models) and gpt-5.6 subagent 2-warm limits.

**Reset credit redemption coordinator:**
- Purpose: Preview reset-credit eligibility and redeem exactly one explicit credit for an exhausted account after identity-bound confirmation.
- Location: `packages/opencode/src/core/reset-credits.ts`; command orchestration in `packages/opencode/src/commands.ts` `executeResetCommand`.
- Pattern: Persisted `(creditId, redeemRequestId)` claim before the consume POST; confirm-time identity and new-attempt precondition checks; terminal-only finalization with bounded, identifier-stable retry for ambiguous outcomes.

**`OpenAIWebSocketPool` / `createWebSocketFetch`:**
- Purpose: Session-keyed WebSocket pool with continuation chaining (`previous_response_id`), per-account discriminator so a switch forces a fresh socket, and stream-failure retries.
- Location: `packages/opencode/src/ws-pool.ts`
- Pattern: `Map<accountDiscriminator, PoolEntry>`; lazy WS upgrades; pool entry owns its `turnID`/`turnStartedAt` so a single user turn keeps one Codex turn id across the whole tool loop.

**Loopback RPC server:**
- Purpose: Notification queue + apply dispatch between loader and TUI.
- Location: `packages/opencode/src/rpc/`
- Pattern: HTTP server on `127.0.0.1:<ephemeral>` with a 32-byte bearer token written to `port-<pid>.json`; client discovers via pid-liveness scan of the dir.

**Sidebar snapshot:**
- Purpose: Loader → TUI surface for quota/killswitch/routing without coupling the TUI to the auth storage schema.
- Location: `packages/opencode/src/sidebar-state.ts`
- Pattern: Promise-chained writes (no interleaved/stale writes); file path bound at loader-run time; `normalizeSidebarState` is the tolerant-read entry point so a malformed file never crashes the TUI. Writes machine-wide quota state via `setSidebarMachineState` and session-specific active routing records via `upsertSidebarActiveRouting`, preserving concurrency through a file-level write lock and a promise serialization chain.

## Entry Points

**Plugin entry:**
- Location: `packages/opencode/src/index.ts` (`CodexAuthPlugin`)
- Triggers: OpenCode loads `@cortexkit/opencode-openai-auth` per `~/.config/opencode/opencode.json` `plugin` field.
- Responsibilities: Returns `Hooks`; `provider.models` filters the OpenAI model list (allow-list + GPT >5.4 fallback) and zeroes OAuth costs; `auth.loader` does the heavy lifting on first OAuth request; `auth.fetch` is the per-request wrapper; `command.execute.before` returns `cleanAbort` for `/openai-*`; `tool.web_search` registers `HostedWebSearchTool`; `event` cleans session state on `session.deleted`; `dispose` closes WS, stops cachekeep, stops background refresh.

**CLI entry:**
- Location: `packages/opencode/src/cli.ts`
- Triggers: The `openai-auth` CLI (run via `npx @cortexkit/opencode-openai-auth`).
- Responsibilities: Manages fallback accounts (`login [--headless]`, `list`, `remove`); rejects adding the main account as a fallback.

**TUI entry:**
- Location: `packages/opencode/src/tui/entry.mjs` (exported as `./tui`; dispatches to the precompiled or raw TUI)
- Triggers: OpenCode TUI loads the plugin per its `oc-plugin: ["server", "tui"]` field.
- Responsibilities: Renders the sidebar (quota, fallback accounts, routing, health, pacing); polls the loader RPC for dialogs; dispatches Apply; reads/writes `tui-preferences.jsonc`.

**Pi extension entry:**
- Location: `packages/pi/src/index.ts` (`cortexKitPiOpenAIAuth`)
- Triggers: Pi loads the extension per its `pi.extensions` field.
- Responsibilities: Registers the `openai-codex` provider with model list, OAuth login/refresh, custom streaming wrapper that swaps `globalThis.WebSocket` for the hand-rolled client.

## Error Handling

**Strategy:** Fail-soft with structured retry; never break a request because of a quota or logging concern.

- Refresh errors: classified transient by `isTransientRefreshError`; build a `nextRetryAt` and store it in `refresh.lastRefreshError`. A `refreshBackoffActive` check short-circuits future refresh attempts for the same token hash.
- Quota errors: classified by `isTransientQuotaError`; `quotaBackoffActive` gates future quota fetches per account.
- Token-refresh race: file lock + lease token hash in storage prevent two processes from refreshing the same main token simultaneously; late processes either join or wait via `waitForConcurrentMainRefresh`.
- HTTP/WS stream failures: `response-stream-error.ts` `ResponseStreamError`; WS retries up to 5 times (`streamRetries`); `websocket_connection_limit_reached` falls back to HTTP for the session.
- Mid-stream rate-limiting / quota exhaustion: parsed from `response.failed` frames carrying `rate_limit_reached_type`. If `emitted` is false, triggers a retryable `ResponseStreamError` enabling a same-turn fallback reroute. If `emitted` is true, closes the stream without retrying (no-replay gate) to prevent text duplication or double-billing, and marks the account rate-limited using reset math resolved exclusively from that window's last-known cached reset, falling back to a bounded, self-correcting default if unknown (rather than borrowing from the other window).
- 401/403/429 mid-request: handled by `tryFallbackAccounts` (reactive); the original body must be a string (else skip fallback).
- Storage corruption: `loadAccounts` is wrapped to throw a clear actionable message rather than a raw `JSON.parse` error.
- CLI self-fallback rejection: the CLI refuses to add the main account as a fallback (would re-route a `429` onto the same account).
- Reserved account ID rejection: `"main"` is a reserved ID (case-insensitive); the CLI and OAuth callback login path assert and reject any fallback account using this label to avoid colliding with the primary account's tracking.
- Background refresh concurrency: `FallbackAccountManager` catches `AccountRemovedDuringRefreshError` to gracefully skip updates for fallback accounts removed from storage during a background refresh operation.
- Token persistence retry: `persistMainAuthTokens` retries writing refreshed main auth tokens up to 3 times to handle transient client/storage update lock contentions.
- All catch paths around quota/sidebar/RPC are best-effort by design; failures are logged at `warn` and swallowed so a sidebar/dump/RPC hiccup never crashes a turn.

## Cross-Cutting Concerns

**Logging:** Leveled logger at `packages/opencode/src/logger.ts`. Channels: `transport`, `quota`, `refresh`, `accounts`, `cachekeep`, `rpc`, `rpc-tui`, `dump`, `sidebar`, `commands`. Redacts Bearer/sk-/JWT tokens, secret/api-key/password/token-like headers, ChatGPT stable ID (`chatgpt-account-id`/`chatgptAccountId`), and any value matching the secret-key patterns, while keeping the internal account ID visible. Log files, request dumps, and the default dump directory are restricted to private permissions (`0o600` for files, `0o700` for directories). Credentials and tokens are redacted from request dump bodies as well as log files. File rotates at 5 MiB keeping 3 generations; default file `tmpdir/opencode-openai-auth.log` (override `OPENCODE_OPENAI_AUTH_LOG_FILE`). Log level is settable at runtime via `/openai-logging` (persisted) or env `OPENCODE_OPENAI_AUTH_LOG_LEVEL`.

**Caching:** Two layers.
- **In-memory quota cache:** `QuotaManager` (per-account fingerprint; 5-min refresh-after default; `respectBackoff` gates active polling).
- **Prompt cache keep-warm:** `CacheKeepManager` tracks per-session last request and replays as `store:false` before the Codex ~5-min eviction window.

**Storage:** Config and state are stored in two separate files under `$OPENCODE_CONFIG_DIR`: config at `openai-auth.json` (default `~/.config/opencode/openai-auth.json`, overridable via `OPENCODE_OPENAI_AUTH_FILE`) containing settings and metadata without credentials, and state at `openai-auth-state.json` (overridable via `OPENCODE_OPENAI_AUTH_STATE_FILE`) containing access/refresh tokens and API keys. Atomic writes via `writeJsonAtomic` (temp + `rename`, mode `0o600`). File-level locks at `<config>.save.lock` and `<config>.main-refresh.lock` coordinate cross-process refresh and quota seed. A separate `openai-auth-sessions.json` persists Codex UUIDv7 thread/turn ids for prompt-cache continuity. Sidebar state lives at `tmpdir/opencode-openai-auth/sidebar-state.json` (override `OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE`). Loopback RPC port files live in `$XDG_STATE_HOME/cortexkit/openai-auth/rpc/<sha256(projectDir)>/port-<pid>.json`.

**Configuration resolution (`config.ts`):** Env wins over config file wins over default. The `webSearch` cache fix is default-on and gated by a NEGATIVE env (`CORTEXKIT_OPENAI_AUTH_NO_WEB_SEARCH`). Booleans accept `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off`/empty. Settings are memoized per process; tests call `resetSettingsForTest`.

**Versioning & build:** `packages/opencode/src/version.ts` exposes `PackageVersion` (currently `0.3.4`); the TUI plugin header reads `package.json` at runtime via `import.meta.url` so the version badge tracks the package version without baking it into the dist. Use `packages/opencode/scripts/build-tui.ts` during the build to precompile TUI Solid JSX source files into `packages/opencode/src/tui-compiled/` using the `@opentui/solid` compiler transform, binding Solid/OpenTUI imports to the host's virtual runtime registry (`opentui:runtime-module:<specifier>`) so the TUI shares the host's single Solid/OpenTUI runtime. The release pipeline is tag-driven (`.github/workflows` + `scripts/release.sh`); see `README.md` for the exact command surface.

**Formatting/linting:** Biome 2.4.16 (single quotes, no semicolons, trailing commas, 2-space indent). Lefthook runs `biome check` on staged files. Tests run via `bun test src/tests`; typecheck via `tsc`.

# Architecture

## Pattern Overview

**Overall:** Multi-account OAuth plugin with Codex request rewriting, reactive account fallback, push-based quota tracking, prompt-cache stabilization, idle cache keep-warm, and a separate TUI sidebar communicating over a loopback RPC.

**Key Characteristics:**
- Registers as the built-in `openai` provider; OpenCode loads external server plugins after its internal ones, so this package transparently supersedes OpenCode's internal OpenAI auth hook.
- Rewrites OpenAI Responses requests into Codex's wire shape (headers, body, tools, turn metadata) so the Codex backend treats traffic as if it came from the official Codex CLI.
- Reactive (not preemptive) account fallback: a `401`/`403`/`429` triggers a retry on the next usable account, respecting routing mode and killswitch thresholds.
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
- Contains: `loadAccounts`/`saveAccounts`/`migrateIfNeeded`, `FallbackAccountManager` (background refresh, `getUsableFallbackAccounts`, `markUsed`), `OAuthAccount`/`ApiKeyAccount` types, single-writer eviction-marker file lock, atomic JSON write (temp + rename, mode `0o600`).
- Depends on: `core/oauth.ts` (`extractAccountId`), `core/provider.ts` (`ProviderQuotaFn`), `core/backoff.ts`.
- Used by: Plugin loader, CLI (`cli.ts`), `/openai-account`/`/openai-routing`/`/openai-killswitch` commands, every quota push.

**Quota cache and policy:**
- Purpose: In-memory cache of main + per-fallback quota snapshots, dedup of inflight fetches, refresh-after math, and backoff gating.
- Location: `packages/opencode/src/core/quota-manager.ts`
- Contains: `QuotaManager` class with `getMain`/`setMain`/`getFallback`/`setFallback`/`seedFallbacksFromAccounts`/`isBackedOff`/`isFallbackBackedOff`, token-fingerprint helpers, `refreshAllQuota` orchestration.
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
- Purpose: Track idle main-agent (and optionally subagent) sessions and replay the last real request as a `store:false` shadow request just before Codex evicts the prompt cache (~5 min).
- Location: `packages/opencode/src/core/cachekeep.ts`
- Contains: `CacheKeepManager` class (target map, timer, idle caps, backoff), `buildKeepwarmCapture`, `buildKeepwarmBody`, SSE/JSON usage extraction.
- Depends on: `core/accounts.ts` (`findCachekeepFallbackAccount` exported from `index.ts`), `quota-normalize.ts`.
- Used by: Plugin loader (per-instance wiring); `/openai-cachekeep` command.

**Request transformation:**
- Purpose: Convert OpenAI Responses calls into Codex-shaped wire requests (UUIDv7 thread/turn ids, Codex turn-metadata header, OAuth/ChatGPT account headers, client_metadata, tool normalization, cache-stabilizer injection).
- Location: `packages/opencode/src/index.ts` (`prepareCodexRequest`, `maybeInjectCacheStabilizerTool`, `normalizeCodexTool`, `getCodexSessionMetadata`, `loadCodexSessions`/`saveCodexSessions`), `packages/opencode/src/hosted-web-search.ts` (provider-hosted web-search tool + replay rewrite + SSE translation), `packages/opencode/src/response-stream-error.ts`.
- Depends on: `util/uuid-v7.ts`, `util/stable-json.ts`, `util/record.ts`, `config.ts`.
- Used by: Plugin loader `sendWithAccessToken`, `fetch` override.

**Transports:**
- Purpose: Run Codex requests over HTTP or WebSocket, with a session-keyed pool for the WebSocket path and Codex-style incremental streaming when the hand-rolled client is enabled.
- Location: `packages/opencode/src/ws.ts` (WS connect/stream, header ordering, idle timeout, retryable terminal hook), `packages/opencode/src/ws-pool.ts` (per-account pool, continuation state, `OpenAIWebSocketPool`), `packages/opencode/src/raw-ws.ts` (runtime selection), `packages/opencode/src/raw-ws-bun.ts` (`Bun.connect`), `packages/opencode/src/raw-ws-node.ts` (`node:net`/`node:tls`), `packages/opencode/src/util/proxy-env.ts`.
- Depends on: `dump.ts`, `hosted-web-search.ts`, `quota-normalize.ts`, `response-stream-error.ts`, `util/error.ts`, `util/record.ts`.
- Used by: Plugin loader `sendWithAccessToken`.

**RPC (loader ↔ TUI):**
- Purpose: Loopback HTTP server so the TUI can drain queued notifications and dispatch `apply` calls back to the auth loader (which already holds QuotaManager / FallbackAccountManager / storage).
- Location: `packages/opencode/src/rpc/rpc-server.ts`, `packages/opencode/src/rpc/port-file.ts`, `packages/opencode/src/rpc/rpc-client.ts`, `packages/opencode/src/rpc/rpc-dir.ts`, `packages/opencode/src/rpc/protocol.ts`, `packages/opencode/src/rpc/notifications.ts`.
- Contains: 32-byte hex token, 1 MiB body cap, timed-out HTTP requests (2s), per-process port files (`port-<pid>.json`), pid-based discovery (drops dead pids), SHA-256(project-dir) `XDG_STATE_HOME/cortexkit/openai-auth/rpc/<hash>/` for cross-process dir resolution, queue with monotonic IDs and per-session TUI-connected tracking.
- Depends on: `node:crypto`, `node:http`, `node:fs/promises`.
- Used by: Plugin loader (server + notifications push), `tui.tsx` (RPC client polling + dialog delivery).

**TUI sidebar:**
- Purpose: Render an OpenCode sidebar slot showing main/fallback quota bars, routing/killswitch/health state, and the command dialog surfaces. The TUI does not own any auth state — it reads `sidebar-state.json` and pushes commands via RPC.
- Location: `packages/opencode/src/tui.tsx`, `packages/opencode/src/tui/command-dialogs.tsx`, `packages/opencode/src/sidebar-state.ts`, `packages/opencode/src/tui-preferences.ts`.
- Depends on: `@opentui/core`, `@opentui/solid`, `solid-js`, `jsonc-parser`.
- Used by: OpenCode's TUI plugin loader (`./tui` export).

**Quota normalization:**
- Purpose: One place to coerce three quota shapes (HTTP `x-codex-*` headers, WS `codex.rate_limits` frame, wham/usage JSON) into the shared `OAuthQuotaSnapshot`, including reset-timestamp coercion (epoch seconds/ms/ISO).
- Location: `packages/opencode/src/quota-normalize.ts`
- Contains: `normalizeQuotaHeaders`, `normalizeWsFrame`, `normalizeWham`, `toResetIso`.
- Used by: Plugin loader (push), `refresh-all-quota.ts`, `cachekeep.ts`, `provider.ts` (dynamic import to avoid a cycle).

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
- Purpose: Per-slash-command payload builders producing `OpenDialogPayload` (text + knobs) and applying user selections to storage.
- Location: `packages/opencode/src/commands.ts`
- Contains: Command name constants (`OPENAI_*_COMMAND_NAME`), `MODAL_COMMANDS`, `CommandContext` DI shape, `buildDialogPayload`, `applyCommand`, `executeQuotaCommand`/`executeAccountCommand`/`executeRoutingCommand`/`executeKillswitchCommand`/`executeDumpCommand`/`executeLoggingCommand`/`executeCachekeepCommand`.
- Depends on: `core/accounts.ts`, `core/cachekeep.ts`, `core/oauth.ts`, `core/refresh-all-quota.ts`, `quota-manager.ts`, `rpc/protocol.ts`, `logger.ts`, `config.ts`.
- Used by: Plugin loader (`auth.loader`), RPC `apply` dispatch.

**CLI (`openai-auth`):**
- Purpose: Manage fallback accounts from a shell — useful on headless machines or in scripts.
- Location: `packages/opencode/src/cli.ts`
- Contains: `login`/`list`/`remove` subcommands, browser or device-code (`--headless`) OAuth flow, self-fallback rejection (refuses to add the main account as a fallback).
- Depends on: `core/accounts.ts`, `core/oauth.ts`, `util/open-url.ts`.
- Used by: The published `openai-auth` binary.

**Pi extension (sibling package):**
- Purpose: Same Codex OAuth capability for the Pi coding agent (separate OpenAI Codex Responses API surface).
- Location: `packages/pi/src/index.ts`, `packages/pi/src/raw-ws-node.ts`
- Contains: Provider registration (`openai-codex`), model list (`gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark`), `loginOpenAICodex`/`refreshOpenAICodexToken`, custom streaming wrapper, hand-rolled WebSocket shim.
- Depends on: `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `node:net`/`node:tls`.
- Used by: Pi extension loader.

## Data Flow

**OAuth login + token refresh (main account):**

1. User runs `/login openai` and picks "ChatGPT Pro/Plus (browser)" or "(headless)" — `packages/opencode/src/index.ts` `auth.methods`.
2. `startOAuthServer` + `generatePKCE` + `buildAuthorizeUrl` open the authorize URL — `packages/opencode/src/core/oauth.ts`.
3. `waitForOAuthCallback` (browser) or `beginDeviceAuth` + `completeDeviceAuth` (headless) completes the flow.
4. `migrateIfNeeded` seeds the multi-account store on first run — `packages/opencode/src/core/accounts.ts`.
5. `auth.loader` constructs `QuotaManager`, `FallbackAccountManager`, and (if any fallback accounts) starts `fallbackManager.startBackgroundRefresh()`.
6. Each refresh runs through `codexRefreshFn` with file-lock + lease concurrency — `core/refresh-file-lock.ts`, `index.ts` `refreshMainWithLease`.

**Reactive fallback (per request):**

1. Plugin loader `auth.fetch` selects the active primary (main or a fallback via `routing.activeId`) — `packages/opencode/src/index.ts`.
2. Strips any existing `authorization` header, refreshes an expired main token via `refreshMainWithLease`, or refreshes a fallback via `fallbackManager.refreshAccount`.
3. `sendWithAccessToken` rewrites headers/body via `prepareCodexRequest`, picks HTTP or WS transport, optionally tracks the body for cachekeep — `packages/opencode/src/index.ts`.
4. If the response status is in the fallback set (`401`/`403`/`429`) AND the request is replayable, `tryFallbackAccounts` iterates `getUsableFallbackAccounts` (killswitch-aware, routing-mode-ordered) and retries each candidate — `packages/opencode/src/index.ts`.
5. The final response's `x-codex-*` headers are normalized via `normalizeQuotaHeaders` and pushed into `QuotaManager` (main or per-account), then `setSidebarState` writes `sidebar-state.json` for the TUI.

**Quota push (no extra polling during normal traffic):**

1. HTTP path — `normalizeQuotaHeaders(finalResponse.headers)` runs inside the `fetch` override.
2. WS path — `codex.rate_limits` in-band frame fires `onQuota` in `ws.ts`, which calls back into `pushQuota` carrying the connection's per-request access token + accountId.
3. `pushQuota` writes to `QuotaManager.setMain`/`setFallback` and triggers `writeSidebarState` (snapshot to disk).
4. `/openai-quota` command additionally calls `refreshAllQuota` to actively fetch `wham/usage` for main + every fallback (respecting per-account backoff).

**Slash command (TUI dialog):**

1. OpenCode TUI fires `command.execute.before` for `/openai-*`.
2. The plugin returns `cleanAbort()` (sentinel throw) so OpenCode does NOT execute any built-in command — `packages/opencode/src/index.ts`.
3. The plugin pushes an `open-dialog` notification via `pushNotification` (`packages/opencode/src/rpc/notifications.ts`).
4. TUI's `tui.tsx` polls the loader's loopback RPC (`/rpc/pending-notifications`), receives the dialog, and renders it via `command-dialogs.tsx`.
5. User clicks Apply → TUI POSTs `/rpc/apply` → loader's `apply` calls `buildDialogPayload`, mutates storage via `saveAccounts`, and returns updated knobs for the TUI to re-render.

**Cache keep-warm (idle session):**

1. Every main-agent (and optionally subagent) request is captured by `buildKeepwarmCapture` from `sendWithAccessToken`.
2. `cacheKeepManager.track` stores the body + replay headers per session, computing `cacheExpiresAt` from the latest activity.
3. A 60s timer fires; for each tracked session within `leadMs` of expiry and within `maxIdleWarmMs`/`maxSubagentIdleMs`, it calls `buildKeepwarmBody(body)` (`store:false`, token caps removed) and replays via `fetchImpl`.
4. Failures trigger a 10-min backoff per session.

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
- Purpose: Idle prompt-cache warmer with per-session targets, idle caps (1 h main / 30 min subagent), and 10-min backoff after a failed warm.
- Location: `packages/opencode/src/core/cachekeep.ts`
- Pattern: Target map keyed by session id; interval timer; bounded (`maxTargets`, `maxBytes`) so a long-lived process cannot leak.

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
- Pattern: Promise-chained writes (no interleaved/stale writes); file path bound at loader-run time; `normalizeSidebarState` is the tolerant-read entry point so a malformed file never crashes the TUI.

## Entry Points

**Plugin entry:**
- Location: `packages/opencode/src/index.ts` (`CodexAuthPlugin`)
- Triggers: OpenCode loads `@cortexkit/opencode-openai-auth` per `~/.config/opencode/opencode.json` `plugin` field.
- Responsibilities: Returns `Hooks`; `provider.models` filters the OpenAI model list (allow-list + GPT >5.4 fallback) and zeroes OAuth costs; `auth.loader` does the heavy lifting on first OAuth request; `auth.fetch` is the per-request wrapper; `command.execute.before` returns `cleanAbort` for `/openai-*`; `tool.web_search` registers `HostedWebSearchTool`; `event` cleans session state on `session.deleted`; `dispose` closes WS, stops cachekeep, stops background refresh.

**CLI entry:**
- Location: `packages/opencode/src/cli.ts`
- Triggers: The `openai-auth` binary (`packages/opencode/package.json` `bin`).
- Responsibilities: Manages fallback accounts (`login [--headless]`, `list`, `remove`); rejects adding the main account as a fallback.

**TUI entry:**
- Location: `packages/opencode/src/tui.tsx` (exported as `./tui`)
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
- 401/403/429 mid-request: handled by `tryFallbackAccounts` (reactive); the original body must be a string (else skip fallback).
- Storage corruption: `loadAccounts` is wrapped to throw a clear actionable message rather than a raw `JSON.parse` error.
- CLI self-fallback rejection: the CLI refuses to add the main account as a fallback (would re-route a `429` onto the same account).
- All catch paths around quota/sidebar/RPC are best-effort by design; failures are logged at `warn` and swallowed so a sidebar/dump/RPC hiccup never crashes a turn.

## Cross-Cutting Concerns

**Logging:** Leveled logger at `packages/opencode/src/logger.ts`. Channels: `transport`, `quota`, `refresh`, `accounts`, `cachekeep`, `rpc`, `rpc-tui`, `dump`, `sidebar`, `commands`. Redacts Bearer/sk-/JWT tokens, secret/api-key/password/token-like headers, and any value matching the secret-key patterns. File rotates at 5 MiB keeping 3 generations; default file `tmpdir/opencode-openai-auth.log` (override `OPENCODE_OPENAI_AUTH_LOG_FILE`). Log level is settable at runtime via `/openai-logging` (persisted) or env `OPENCODE_OPENAI_AUTH_LOG_LEVEL`.

**Caching:** Two layers.
- **In-memory quota cache:** `QuotaManager` (per-account fingerprint; 5-min refresh-after default; `respectBackoff` gates active polling).
- **Prompt cache keep-warm:** `CacheKeepManager` tracks per-session last request and replays as `store:false` before the Codex ~5-min eviction window.

**Storage:** Single JSON file per process at `$OPENCODE_CONFIG_DIR/openai-auth.json` (default `~/.config/opencode/openai-auth.json`, overridable via `OPENCODE_OPENAI_AUTH_FILE`). Atomic writes via `writeJsonAtomic` (temp + `rename`, mode `0o600`). File-level locks at `<config>.lock` and `<config>.main-refresh.lock` coordinate cross-process refresh and quota seed. A separate `openai-auth-sessions.json` persists Codex UUIDv7 thread/turn ids for prompt-cache continuity. Sidebar state lives at `tmpdir/opencode-openai-auth/sidebar-state.json` (override `OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE`). Loopback RPC port files live in `$XDG_STATE_HOME/cortexkit/openai-auth/rpc/<sha256(projectDir)>/port-<pid>.json`.

**Configuration resolution (`config.ts`):** Env wins over config file wins over default. The `webSearch` cache fix is default-on and gated by a NEGATIVE env (`CORTEXKIT_OPENAI_AUTH_NO_WEB_SEARCH`). Booleans accept `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off`/empty. Settings are memoized per process; tests call `resetSettingsForTest`.

**Versioning & build:** `packages/opencode/src/version.ts` exposes `PackageVersion` (currently `0.1.1`); the TUI plugin header reads `package.json` at runtime via `import.meta.url` so the version badge tracks the package version without baking it into the dist. The release pipeline is tag-driven (`.github/workflows` + `scripts/release.sh`); see `README.md` for the exact command surface.

**Formatting/linting:** Biome 2.4.16 (single quotes, no semicolons, trailing commas, 2-space indent). Lefthook runs `biome check` on staged files. Tests run via `bun test src/tests`; typecheck via `tsc`.
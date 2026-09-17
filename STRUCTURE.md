# Codebase Structure

## Directory Layout

```
[project-root]/
├── packages/
│   ├── opencode/                  # @cortexkit/opencode-openai-auth (OpenCode plugin + CLI + TUI)
│   │   ├── src/                   # All plugin source
│   │   │   ├── core/              # Generic, provider-agnostic core
│   │   │   ├── rpc/               # Loopback HTTP RPC between loader and TUI
│   │   │   ├── tests/             # Co-located bun tests
│   │   │   ├── tui/               # TUI sidebar Solid components
│   │   │   ├── util/              # Small dependency-free helpers
│   │   │   ├── index.ts           # CodexAuthPlugin entry
│   │   │   ├── cli.ts             # `openai-auth` binary
│   │   │   ├── codex-http.ts      # HTTP fallback sanitization for WebSocket downgrades
│   │   │   ├── commands.ts        # /openai-* dialog builders
│   │   │   ├── config.ts          # Settings resolution (env > file > default)
│   │   │   ├── logger.ts          # Leveled, redacting, rotating logger
│   │   │   ├── model-costs.ts     # Dev catalog parser and cost restorer
│   │   │   ├── sidebar-state.ts   # Loader→TUI snapshot and sticky-pin state
│   │   │   ├── tui-preferences.ts # Shared tui-preferences.jsonc reader/writer/watcher
│   │   │   ├── tui.tsx            # TUI sidebar component
│   │   │   ├── ws.ts              # Low-level WS connect/stream
│   │   │   ├── ws-pool.ts         # Per-account WS pool with continuation state
│   │   │   ├── raw-ws.ts          # Runtime-aware RawWebSocket selector
│   │   │   ├── raw-ws-bun.ts      # Bun.connect-backed hand-rolled client
│   │   │   ├── raw-ws-node.ts     # node:net/node:tls-backed hand-rolled client
│   │   │   ├── raw-ws-upgrade.ts  # HTTP upgrade status & header parser for rejected handshakes
│   │   │   ├── hosted-web-search.ts # Provider-hosted web_search tool + replay/SSE translation
│   │   │   ├── response-stream-error.ts # Stream error type for WS/HTTP
│   │   │   ├── prompt-context.ts  # Assistant model/variant resolver for synthetic replies
│   │   │   ├── dump.ts            # Optional transport request dumps for cache debugging
│   │   │   ├── version.ts         # Package version (mirrors package.json)
│   │   │   └── WEBSOCKET.md       # Developer reference for WebSocket flow/lifetime/retries
│   │   ├── scripts/               # Package-specific build scripts
│   │   │   └── build-tui.ts       # Precompiles TUI Solid JSX into tui-compiled/
│   │   ├── package.json
│   │   ├── README.md
│   │   ├── tsconfig.json
│   │   ├── tsconfig.build.json
│   │   └── bunfig.toml
│   ├── core/                      # @cortexkit/openai-auth-core (private shared core, never published)
│   │   ├── src/                   # Shared store, OAuth, quota, commands, logger (no env reads, no host paths)
│   │   │   ├── util/              # error.ts, record.ts, open-url.ts (shared helpers)
│   │   │   ├── tests/             # Core bun tests + export-manifest gate
│   │   │   ├── index.ts           # Command seam (buildDialogPayload, applyCommand)
│   │   │   ├── internal.ts        # Host support (store, OAuth, quota, logger, protocol)
│   │   │   ├── accounts.ts / provider.ts / quota-manager.ts / oauth.ts # Store, seams, quota
│   │   │   ├── commands.ts / protocol.ts / paths.ts # Shared bodies, wire types, file names
│   │   │   └── quota-normalize.ts / reset-credits.ts / refresh-all-quota.ts # Quota + reset
│   │   ├── package.json
│   │   ├── README.md
│   │   └── tsconfig.json
│   └── pi/                        # @cortexkit/pi-openai-auth (Pi coding-agent extension)
│       ├── src/
│       │   ├── tests/             # Extension tests
│       │   │   └── index.test.ts
│       │   ├── index.ts           # Pi extension entry (registers openai-codex provider)
│       │   └── raw-ws-node.ts     # node:net/node:tls-backed hand-rolled WS client
│       ├── package.json
│       ├── README.md
│       ├── tsconfig.json
│       └── tsconfig.build.json
├── scripts/                       # Release + dev tooling
│   ├── dev.ts                     # Build + symlink into .opencode/plugins/, run tsc --watch
│   ├── dev-clean.ts               # Remove the dev symlink
│   ├── analyze-cache-cliffs.mjs   # Cache cliff analyzer for dumped sessions
│   ├── find-order-dependent-tests.mjs # Scanner for order-dependent tests
│   ├── measure-store-contention.mjs # Account-store lock contention benchmark under load
│   ├── release.sh                 # Tag-driven release driver
│   ├── wait-release.sh            # Poll for the GitHub release to appear
│   └── version-sync.mjs           # Sync package versions
├── .github/                       # Issue templates + release workflow
├── biome.json                     # Formatter/linter config
├── lefthook.yml                   # Pre-commit biome check
├── mise.toml                      # Tooling versions
├── package.json                   # Workspace root (bun workspaces)
├── bun.lock
└── README.md                      # User-facing documentation
```

## Directory Purposes

**`packages/opencode/src/core/`:**
- Purpose: Host-owned core. Owns cache keep-warm, sticky routing, background quota polling, and account-path resolution. The generic store, OAuth flow, quota bookkeeping, reset path, shared command bodies, and logger live in `packages/core/src/` so both hosts run the same code.
- Contains: `account-paths.ts`, `background-quota-refresh.ts`, `cachekeep.ts`, `sticky-routing.ts`.
- Key files:
  - `packages/opencode/src/core/account-paths.ts` — host path resolver (`getAccountStoragePath`, `getAccountStatePath`, `getAccountPaths`, `accountPathsCollide`) over the shared file names in `packages/core/src/paths.ts`
  - `packages/opencode/src/core/background-quota-refresh.ts` — `BackgroundQuotaRefresh` (periodic jittered poller for idle account quota with cross-process lease lock)
  - `packages/opencode/src/core/sticky-routing.ts` — cold-session candidate selection, sustainable window weighting, and sticky-break classification
  - `packages/opencode/src/core/cachekeep.ts` — `CacheKeepManager` (idle prompt-cache warmer with model-aware TTLs, subagent 2-warm limits, clock windows, idle pruning, and main-only sustain)

**`packages/core/src/`:**
- Purpose: Private shared core (`@cortexkit/openai-auth-core`, never published; each host bundles it). Holds the account store, OAuth flow, reset-credit state machine, quota bookkeeping, logger, and shared slash-command bodies. Reads no env vars and resolves no host paths — every store entry point takes an `AccountPaths` (`{ configPath, statePath }`) the host resolves.
- Contains: `accounts.ts`, `atomic-write.ts`, `backoff.ts`, `commands.ts`, `index.ts` (command seam), `internal.ts` (host support), `logger.ts`, `oauth.ts`, `paths.ts`, `protocol.ts`, `provider.ts`, `quota-manager.ts`, `quota-normalize.ts`, `refresh-all-quota.ts`, `refresh-file-lock.ts`, `reset-credits.ts`, `util/`.
- Key files:
  - `packages/core/src/index.ts` — command seam (`buildDialogPayload`, `applyCommand`; the only way to run a command body so knob scrubbing cannot be bypassed)
  - `packages/core/src/internal.ts` — host support (store, OAuth, quota, logger, protocol re-exports; importing from here is visibly reaching past the seam)
  - `packages/core/src/commands.ts` — shared command bodies with module-private `execute*` fns and `scrubKnobs`
  - `packages/core/src/protocol.ts` — command/RPC wire types (`OpenDialogPayload`, `ApplyRequest`, `ApplyResult`)
  - `packages/core/src/paths.ts` — shared file names (`ACCOUNT_FILE_NAME`, `ACCOUNT_STATE_FILE_NAME`) and `deriveStatePath`
  - `packages/core/src/provider.ts` — Codex-specific injection seam (`codexRefreshFn`, `whamUsageFn`)

**`packages/opencode/src/rpc/`:**
- Purpose: Loopback HTTP RPC between the auth loader and the TUI sidebar.
- Contains: `rpc-server.ts` (bearer-token HTTP server, 1 MiB body cap), `port-file.ts` (`port-<pid>.json` write + discovery), `rpc-client.ts` (TUI-side client with 2s timeout), `rpc-dir.ts` (`XDG_STATE_HOME/cortexkit/openai-auth/rpc/openai-auth-<sha256(projectDir)>/` with startup sweeps for dead port files and empty project directories), `notifications.ts` (queue + per-session TUI-connected tracking), `protocol.ts` (wire types).
- Key files: `packages/opencode/src/rpc/rpc-server.ts`, `packages/opencode/src/rpc/rpc-client.ts`, `packages/opencode/src/rpc/notifications.ts`.

**`packages/opencode/src/tests/`:**
- Purpose: Co-located bun tests (every `*.test.ts` exercises a sibling source file).
- Contains: 30+ test files plus a `setup-env.ts`.
- Key files: `packages/opencode/src/tests/integration.test.ts`, `packages/core/src/tests/oauth.test.ts`, `packages/opencode/src/tests/cachekeep.test.ts`, `packages/opencode/src/tests/rpc-server.test.ts`.

**`packages/opencode/src/tui/`:**
- Purpose: TUI sidebar Solid components and entry loader (separated from `tui.tsx` to keep the top-level entry small).
- Contains: `command-dialogs.tsx`, `entry.mjs`.
- Key files: `packages/opencode/src/tui/command-dialogs.tsx`, `packages/opencode/src/tui/entry.mjs`.

**`packages/opencode/src/util/`:**
- Purpose: Small, host-only helpers.
- Contains: `proxy-env.ts`, `stable-json.ts`, `uuid-v7.ts` (shared helpers `error.ts`, `record.ts`, `open-url.ts` live in `packages/core/src/util/`).
- Key files: `packages/opencode/src/util/uuid-v7.ts` (Codex session/turn id parity), `packages/opencode/src/util/stable-json.ts` (cache key parity).

**`packages/opencode/scripts/`:**
- Purpose: Package-specific build and helper scripts.
- Contains: `build-tui.ts`.
- Key files: `packages/opencode/scripts/build-tui.ts`.

**`packages/pi/src/`:**
- Purpose: Sibling package exposing the same Codex OAuth capability to the Pi coding agent.
- Contains: `index.ts` (Pi extension entry, provider registration, custom streaming wrapper), `raw-ws-node.ts`.
- Key files: `packages/pi/src/index.ts`.

**`scripts/`:**
- Purpose: Release + local dev tooling.
- Contains: `dev.ts` (build + symlink into `.opencode/plugins/` + tsc --watch), `dev-clean.ts` (remove the symlink), `analyze-cache-cliffs.mjs` (cache cliff analyzer for dumped sessions), `find-order-dependent-tests.mjs` (scanner for order-dependent tests), `measure-store-contention.mjs` (account-store lock contention benchmark under load / correlated arrival), `release.sh` (tag-driven release driver), `wait-release.sh` (poll for the GitHub release), `version-sync.mjs` (sync package versions).
- Key files: `scripts/dev.ts`, `scripts/release.sh`, `scripts/analyze-cache-cliffs.mjs`, `scripts/find-order-dependent-tests.mjs`, `scripts/measure-store-contention.mjs`.

## Key File Locations

**Entry Points:**
- `packages/opencode/src/index.ts` — OpenCode plugin (server hook). The plugin registers as `openai` provider.
- `packages/opencode/src/cli.ts` — `openai-auth` CLI (manages fallback accounts; executed via `npx @cortexkit/opencode-openai-auth`).
- `packages/opencode/src/tui/entry.mjs` — TUI export shim; loads the precompiled TUI for packaged hosts and raw TSX for compatible local loaders.
- `packages/opencode/src/tui.tsx` — TUI sidebar source; compiled into `src/tui-compiled/` during the package build.
- `packages/pi/src/index.ts` — Pi extension entry.

**Configuration:**
- `packages/opencode/src/config.ts` — settings resolution (env > file > default), memoization invalidation (`refreshSettings`), `DEFAULT_CODEX_API_ENDPOINT`, env-var constants.
- `packages/opencode/package.json` — `bin.openai-auth` entry point, `oc-plugin` field declaring `["server", "tui"]`, exports map (`./tui`, `./tui-prefs`).
- `packages/opencode/src/tui-preferences.ts` — shared `tui-preferences.jsonc` reader/writer/watcher (used by the TUI sidebar slot config).
- `biome.json` — formatter/linter config.
- `lefthook.yml` — pre-commit biome check.
- `mise.toml` — tooling versions.

**Core Logic:**
- `packages/core/src/accounts.ts` — multi-account store, `FallbackAccountManager`.
- `packages/opencode/src/core/account-paths.ts` — host state-path resolver over the shared file names in `packages/core/src/paths.ts`.
- `packages/core/src/oauth.ts` — PKCE, OAuth flow, JWT parsing.
- `packages/core/src/quota-manager.ts` — quota cache, backoff, and mid-stream rate limit marking.
- `packages/opencode/src/core/background-quota-refresh.ts` — periodic background quota refresher with jittered interval, freshness gate, and cross-process lease lock.
- `packages/opencode/src/core/sticky-routing.ts` — cold-session candidate selection, sustainable window weighting, and sticky-break classification.
- `packages/opencode/src/core/cachekeep.ts` — prompt-cache warmer with model-aware TTL, clock window, subagent warm caps, and main-only sustain that bypasses idle pruning but not memory/LRU caps.
- `packages/core/src/reset-credits.ts` — reset-credit listing, eligibility checks, persisted redemption claims, bounded consume requests, and terminal-outcome finalization.
- `packages/opencode/src/prompt-context.ts` — assistant model/variant resolver for synthetic command replies.
- `packages/core/src/provider.ts` — Codex injection seam (`codexRefreshFn`, `whamUsageFn`).
- `packages/core/src/backoff.ts` — retry/backoff math.
- `packages/core/src/refresh-file-lock.ts` — generation-fenced single-writer eviction-marker lock.
- `packages/opencode/src/codex-http.ts` — HTTP fallback sanitization for WebSocket downgrades.
- `packages/opencode/src/ws-pool.ts` — per-account WebSocket pool with continuation chaining, refusal cleanup, and HTTP relay fallback for oversized frames (1009).
- `packages/opencode/src/ws.ts` — low-level WS connect/stream, response lifecycle logging, and oversized frame classification.
- `packages/opencode/src/response-stream-error.ts` — retryable and terminal stream error shape for WS/HTTP.
- `packages/opencode/src/WEBSOCKET.md` — developer reference for WebSocket flow, lifetime, and retry strategies.
- `packages/opencode/src/raw-ws-bun.ts` / `packages/opencode/src/raw-ws-node.ts` / `packages/opencode/src/raw-ws-upgrade.ts` — hand-rolled RFC 6455 clients and HTTP upgrade response parser.
- `packages/opencode/src/hosted-web-search.ts` — provider-hosted `web_search` tool + replay/SSE translation.
- `packages/core/src/quota-normalize.ts` — HTTP/WS/wham → `OAuthQuotaSnapshot`.
- `packages/opencode/src/commands.ts` — host command surface (`hostCommandBodies` for killswitch/dump/logging/cachekeep over the shared bodies in `packages/core/src/commands.ts`).
- `packages/opencode/src/sidebar-state.ts` — loader→TUI snapshot, tolerant reader, and SHA-256-keyed sticky session assignments with seven-day TTL.
- `packages/opencode/src/dump.ts` — optional transport request dumps with tool schema preservation for cache debugging.
- `packages/core/src/logger.ts` — redaction + rotation engine; `packages/opencode/src/logger.ts` — host destination shim (log file + env level, exit flush).
- `packages/opencode/src/model-costs.ts` — model cost resolution and restoration from `models.dev` catalog.

**Tests:**
- `packages/opencode/src/tests/` — co-located bun tests (`*.test.ts`).
- `packages/core/src/tests/` — shared-core bun tests, including `export-manifest.test.ts` (fails when the `index.ts`/`internal.ts` exports drift from `export-manifest.ts`).
- `packages/core/src/tests/reset-credits.test.ts` — reset-credit listing and consumption, redemption preconditions, and atomic persisted redemption state.
- `packages/opencode/src/tests/background-quota-refresh.test.ts` — background quota poller tests, lease renewal, and snapshot timestamp merging.
- `packages/opencode/src/tests/sticky-routing.test.ts` — sticky-balanced selection, sustainable spend weighting, and sticky break decisions.
- `packages/opencode/bunfig.toml` — bun test config.
- Run: `bun run test` (root) → `cd packages/opencode && bun run test`.

## Naming Conventions

**Files:** lowercase-kebab or lowercase-flat. Top-level files use bare lowercase names (`index.ts`, `cli.ts`, `codex-http.ts`, `commands.ts`, `config.ts`, `logger.ts`, `model-costs.ts`, `quota-normalize.ts`, `sidebar-state.ts`, `ws-pool.ts`, `hosted-web-search.ts`, `response-stream-error.ts`, `raw-ws-bun.ts`, `raw-ws-node.ts`, `raw-ws-upgrade.ts`, `version.ts`). Subdirectory files share the directory name as a prefix where it helps (`core/accounts.ts`, `core/oauth.ts`, `rpc/rpc-server.ts`, `rpc/port-file.ts`, `util/uuid-v7.ts`).
Example: `packages/opencode/src/core/cachekeep.ts`, `packages/opencode/src/rpc/rpc-server.ts`.

**Directories:** lowercase-kebab. Subdirectories group by layer (`core/`, `rpc/`, `tests/`, `tui/`, `util/`).
Example: `packages/opencode/src/core/`, `packages/opencode/src/rpc/`, `packages/opencode/src/util/`.

**Tests:** co-located `*.test.ts` next to the file under test.
Example: `packages/opencode/src/tests/accounts-store.test.ts` tests `packages/core/src/accounts.ts`.

**Types/classes:** PascalCase (`CodexAuthPlugin`, `FallbackAccountManager`, `QuotaManager`, `CacheKeepManager`, `OpenAIWebSocketPool`, `ResponseStreamError`).
Example: `packages/opencode/src/core/cachekeep.ts` exports `CacheKeepManager`.

**Command name constants:** SCREAMING_SNAKE_CASE prefixed with `OPENAI_` (`OPENAI_QUOTA_COMMAND_NAME`, `OPENAI_ACCOUNT_COMMAND_NAME`, `OPENAI_ROUTING_COMMAND_NAME`, `OPENAI_KILLSWITCH_COMMAND_NAME`, `OPENAI_DUMP_COMMAND_NAME`, `OPENAI_LOGGING_COMMAND_NAME`, `OPENAI_CACHEKEEP_COMMAND_NAME`, `OPENAI_RESET_COMMAND_NAME`).
Example: `packages/opencode/src/commands.ts`.

**Environment variables:** SCREAMING_SNAKE_CASE with the `CORTEXKIT_OPENAI_AUTH_*` and `OPENCODE_OPENAI_AUTH_*` prefixes (negative-prefixed `CORTEXKIT_OPENAI_AUTH_NO_WEB_SEARCH` for the default-on cache fix).
Example: `CORTEXKIT_OPENAI_AUTH_WEBSOCKETS`, `CORTEXKIT_OPENAI_AUTH_RAW_WS`, `OPENCODE_OPENAI_AUTH_DUMP_DIR`.

**RPC methods:** lowercase, dash-separated (`pending-notifications`, `apply`). JSON-RPC-shaped bodies.

**Model IDs:** GPT-style dotted identifiers that pass `gpt-X.Y` or major versions like `gpt-X`; the allow-list at `packages/opencode/src/index.ts` (`ALLOWED_MODELS`) and the regex `^gpt-(\d+(?:\.\d+)?)` with `> 5.4` fallback define which models surface to the TUI (explicitly disallowing the bare `gpt-5.6` and `gpt-6` while accepting `gpt-6-astra` and `-luna`, `-sol`, and `-terra` variants).

## Where to Add New Code

**New OAuth provider (replace Codex with another):** add the refresh + quota fns to `packages/core/src/provider.ts` next to `codexRefreshFn` / `whamUsageFn`; inject them into `FallbackAccountManager` + `QuotaManager` in `packages/opencode/src/index.ts` `auth.loader`. The generic core stays untouched.

**New `/openai-*` slash command:** add the command name constant in `packages/core/src/commands.ts` (`OPENAI_*_COMMAND_NAME`), add it to `MODAL_COMMANDS`, implement the `executeXxxCommand` body there (keep it module-private so it runs only via `buildDialogPayload`/`applyCommand` and knob scrubbing cannot be bypassed). Only when the command needs live host state (cachekeep manager, memoized settings) put its body in `packages/opencode/src/commands.ts` as a `hostCommandBodies` entry instead. The TUI dialog content lives in `packages/opencode/src/tui/command-dialogs.tsx`.

**New storage key (under the existing JSON file):** extend `AccountStorage` in `packages/core/src/accounts.ts`, bump `version`, and update the config through `mutateAccounts` (atomic read-modify-write). Account operations preserve existing transport settings. Do not use `saveAccounts` (which union-merges the account list and can resurrect concurrently-removed accounts) except for test seeding. Gating of state writes on the config roster is handled automatically by `saveAccountState`. Note that `"main"` is a reserved account ID (case-insensitive) and cannot be used as a label for fallback accounts.

**New transport (gRPC, etc.):** create a new file under `packages/opencode/src/` mirroring `ws.ts` + `ws-pool.ts`; integrate in `packages/opencode/src/index.ts` `sendWithAccessToken` next to the HTTP/WS branch. Update `packages/opencode/src/raw-ws.ts` only if you need a new runtime-specific client.

**New quota source (e.g. a different HTTP endpoint):** add a normalizer to `packages/core/src/quota-normalize.ts` (`normalizeXxx` returning `OAuthQuotaSnapshot`); expose it on `packages/core/src/provider.ts` as a new `ProviderQuotaFn` shape; inject into `QuotaManager` via `fetchQuotaFn` (currently `undefined` — push-only) and call it from `refresh-all-quota.ts`.

**New shared util:** add to `packages/core/src/util/` when both hosts need it, otherwise `packages/opencode/src/util/`. Keep the file dependency-free (node: builtins only).

**New test:** add `*.test.ts` next to the source file it exercises, under `packages/opencode/src/tests/` for host code or `packages/core/src/tests/` for shared-core code. Bun test only — no jest/vitest.

**New script:** add to `scripts/` and wire into the `scripts` block of the root `package.json`. Release-driving scripts go through `scripts/release.sh`.

**New package (sibling to `opencode` or `pi`):** create `packages/<name>/` with its own `package.json`, `src/`, `tsconfig.json`, `tsconfig.build.json`, and add it under `workspaces` in the root `package.json`. Mirror the existing `opencode` or `pi` layout — Bun workspaces, `bun run build`, `bun run typecheck`.

**New plugin command constant / TUI preferences key:** add to `packages/opencode/src/tui-preferences.ts` (`DEFAULT_PREFS` + a typed key under the `PLUGIN_KEY = 'openai-auth'` top-level key in `~/.config/opencode/tui-preferences.jsonc`); the schema-validated reader will accept the new key automatically because `resolveOpenaiAuthPrefs` per-key defaults.

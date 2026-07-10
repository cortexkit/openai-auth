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
│   │   │   ├── commands.ts        # /openai-* dialog builders
│   │   │   ├── config.ts          # Settings resolution (env > file > default)
│   │   │   ├── logger.ts          # Leveled, redacting, rotating logger
│   │   │   ├── quota-normalize.ts # HTTP/WS/wham → OAuthQuotaSnapshot
│   │   │   ├── sidebar-state.ts   # Loader→TUI snapshot file
│   │   │   ├── tui-preferences.ts # Shared tui-preferences.jsonc reader/writer/watcher
│   │   │   ├── tui.tsx            # TUI sidebar component
│   │   │   ├── ws.ts              # Low-level WS connect/stream
│   │   │   ├── ws-pool.ts         # Per-account WS pool with continuation state
│   │   │   ├── raw-ws.ts          # Runtime-aware RawWebSocket selector
│   │   │   ├── raw-ws-bun.ts      # Bun.connect-backed hand-rolled client
│   │   │   ├── raw-ws-node.ts     # node:net/node:tls-backed hand-rolled client
│   │   │   ├── hosted-web-search.ts # Provider-hosted web_search tool + replay/SSE translation
│   │   │   ├── response-stream-error.ts # Stream error type for WS/HTTP
│   │   │   ├── dump.ts            # Optional transport request dumps for cache debugging
│   │   │   └── version.ts         # Package version (mirrors package.json)
│   │   ├── package.json
│   │   ├── README.md
│   │   ├── tsconfig.json
│   │   ├── tsconfig.build.json
│   │   └── bunfig.toml
│   └── pi/                        # @cortexkit/pi-openai-auth (Pi coding-agent extension)
│       ├── src/
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
- Purpose: Generic, provider-agnostic core. Owns the multi-account store, file locks, retry/backoff math, quota cache/refresh orchestration, OAuth flow primitives, cache keep-warm, and atomic-write helpers. The Codex-specific bits (`codexRefreshFn`, `whamUsageFn`, JWT/account-id extraction) are injected via the `provider.ts` seam or live in `oauth.ts` so the layer can stay provider-agnostic.
- Contains: `accounts.ts`, `atomic-write.ts`, `backoff.ts`, `cachekeep.ts`, `oauth.ts`, `provider.ts`, `quota-manager.ts`, `refresh-all-quota.ts`, `refresh-file-lock.ts`.
- Key files:
  - `packages/opencode/src/core/accounts.ts` — `loadAccounts`/`mutateAccounts` (authoritative read-modify-write), `saveAccounts` (test seeding only), `saveAccountState` (updates state secrets, gated by config roster), `FallbackAccountManager`, account types
  - `packages/opencode/src/core/quota-manager.ts` — in-memory quota cache + backoff
  - `packages/opencode/src/core/cachekeep.ts` — `CacheKeepManager` (idle prompt-cache warmer)
  - `packages/opencode/src/core/oauth.ts` — PKCE, callback server, device-code flow, JWT parsing
  - `packages/opencode/src/core/backoff.ts` — refresh/quota backoff math + `hashRefreshToken`
  - `packages/opencode/src/core/refresh-file-lock.ts` — single-writer eviction-marker lock
  - `packages/opencode/src/core/provider.ts` — Codex-specific injection seam (`codexRefreshFn`, `whamUsageFn`)

**`packages/opencode/src/rpc/`:**
- Purpose: Loopback HTTP RPC between the auth loader and the TUI sidebar.
- Contains: `rpc-server.ts` (bearer-token HTTP server, 1 MiB body cap), `port-file.ts` (`port-<pid>.json` write + discovery), `rpc-client.ts` (TUI-side client with 2s timeout), `rpc-dir.ts` (`XDG_STATE_HOME/cortexkit/openai-auth/rpc/<sha256(projectDir)>/`), `notifications.ts` (queue + per-session TUI-connected tracking), `protocol.ts` (wire types).
- Key files: `packages/opencode/src/rpc/rpc-server.ts`, `packages/opencode/src/rpc/rpc-client.ts`, `packages/opencode/src/rpc/notifications.ts`.

**`packages/opencode/src/tests/`:**
- Purpose: Co-located bun tests (every `*.test.ts` exercises a sibling source file).
- Contains: 30+ test files plus a `setup-env.ts`.
- Key files: `packages/opencode/src/tests/integration.test.ts`, `packages/opencode/src/tests/oauth.test.ts`, `packages/opencode/src/tests/cachekeep.test.ts`, `packages/opencode/src/tests/rpc-server.test.ts`.

**`packages/opencode/src/tui/`:**
- Purpose: TUI sidebar Solid components (separated from `tui.tsx` to keep the top-level entry small).
- Contains: `command-dialogs.tsx`.
- Key files: `packages/opencode/src/tui/command-dialogs.tsx`.

**`packages/opencode/src/util/`:**
- Purpose: Small, dependency-free helpers shared by every layer.
- Contains: `error.ts`, `proxy-env.ts`, `record.ts`, `stable-json.ts`, `uuid-v7.ts`, `open-url.ts`.
- Key files: `packages/opencode/src/util/uuid-v7.ts` (Codex session/turn id parity), `packages/opencode/src/util/stable-json.ts` (cache key parity).

**`packages/pi/src/`:**
- Purpose: Sibling package exposing the same Codex OAuth capability to the Pi coding agent.
- Contains: `index.ts` (Pi extension entry, provider registration, custom streaming wrapper), `raw-ws-node.ts`.
- Key files: `packages/pi/src/index.ts`.

**`scripts/`:**
- Purpose: Release + local dev tooling.
- Contains: `dev.ts` (build + symlink into `.opencode/plugins/` + tsc --watch), `dev-clean.ts` (remove the symlink), `analyze-cache-cliffs.mjs` (cache cliff analyzer for dumped sessions), `release.sh` (tag-driven release driver), `wait-release.sh` (poll for the GitHub release), `version-sync.mjs` (sync package versions).
- Key files: `scripts/dev.ts`, `scripts/release.sh`, `scripts/analyze-cache-cliffs.mjs`.

## Key File Locations

**Entry Points:**
- `packages/opencode/src/index.ts` — OpenCode plugin (server hook). The plugin registers as `openai` provider.
- `packages/opencode/src/cli.ts` — `openai-auth` CLI (manages fallback accounts; executed via `npx @cortexkit/opencode-openai-auth`).
- `packages/opencode/src/tui.tsx` — TUI sidebar (exported as `./tui`; loaded by OpenCode's TUI).
- `packages/pi/src/index.ts` — Pi extension entry.

**Configuration:**
- `packages/opencode/src/config.ts` — settings resolution (env > file > default), `DEFAULT_CODEX_API_ENDPOINT`, env-var constants.
- `packages/opencode/package.json` — `bin.openai-auth` entry point, `oc-plugin` field declaring `["server", "tui"]`, exports map (`./tui`, `./tui-prefs`).
- `packages/opencode/src/tui-preferences.ts` — shared `tui-preferences.jsonc` reader/writer/watcher (used by the TUI sidebar slot config).
- `biome.json` — formatter/linter config.
- `lefthook.yml` — pre-commit biome check.
- `mise.toml` — tooling versions.

**Core Logic:**
- `packages/opencode/src/core/accounts.ts` — multi-account store, `FallbackAccountManager`.
- `packages/opencode/src/core/oauth.ts` — PKCE, OAuth flow, JWT parsing.
- `packages/opencode/src/core/quota-manager.ts` — quota cache + backoff.
- `packages/opencode/src/core/cachekeep.ts` — prompt-cache warmer.
- `packages/opencode/src/core/provider.ts` — Codex injection seam (`codexRefreshFn`, `whamUsageFn`).
- `packages/opencode/src/core/backoff.ts` — retry/backoff math.
- `packages/opencode/src/core/refresh-file-lock.ts` — single-writer eviction-marker lock.
- `packages/opencode/src/ws-pool.ts` — per-account WebSocket pool.
- `packages/opencode/src/ws.ts` — low-level WS connect/stream.
- `packages/opencode/src/raw-ws-bun.ts` / `packages/opencode/src/raw-ws-node.ts` — hand-rolled RFC 6455 clients.
- `packages/opencode/src/hosted-web-search.ts` — provider-hosted `web_search` tool + replay/SSE translation.
- `packages/opencode/src/quota-normalize.ts` — HTTP/WS/wham → `OAuthQuotaSnapshot`.
- `packages/opencode/src/sidebar-state.ts` — loader→TUI snapshot file + tolerant reader.
- `packages/opencode/src/dump.ts` — optional transport request dumps for cache debugging.
- `packages/opencode/src/logger.ts` — leveled, secret-redacting, size-rotating logger.

**Tests:**
- `packages/opencode/src/tests/` — co-located bun tests (`*.test.ts`).
- `packages/opencode/bunfig.toml` — bun test config.
- Run: `bun run test` (root) → `cd packages/opencode && bun run test`.

## Naming Conventions

**Files:** lowercase-kebab or lowercase-flat. Top-level files use bare lowercase names (`index.ts`, `cli.ts`, `commands.ts`, `config.ts`, `logger.ts`, `quota-normalize.ts`, `sidebar-state.ts`, `ws-pool.ts`, `hosted-web-search.ts`, `response-stream-error.ts`, `raw-ws-bun.ts`, `raw-ws-node.ts`, `version.ts`). Subdirectory files share the directory name as a prefix where it helps (`core/accounts.ts`, `core/oauth.ts`, `rpc/rpc-server.ts`, `rpc/port-file.ts`, `util/uuid-v7.ts`).
Example: `packages/opencode/src/core/cachekeep.ts`, `packages/opencode/src/rpc/rpc-server.ts`.

**Directories:** lowercase-kebab. Subdirectories group by layer (`core/`, `rpc/`, `tests/`, `tui/`, `util/`).
Example: `packages/opencode/src/core/`, `packages/opencode/src/rpc/`, `packages/opencode/src/util/`.

**Tests:** co-located `*.test.ts` next to the file under test.
Example: `packages/opencode/src/tests/accounts-store.test.ts` tests `packages/opencode/src/core/accounts.ts`.

**Types/classes:** PascalCase (`CodexAuthPlugin`, `FallbackAccountManager`, `QuotaManager`, `CacheKeepManager`, `OpenAIWebSocketPool`, `ResponseStreamError`).
Example: `packages/opencode/src/core/cachekeep.ts` exports `CacheKeepManager`.

**Command name constants:** SCREAMING_SNAKE_CASE prefixed with `OPENAI_` (`OPENAI_QUOTA_COMMAND_NAME`, `OPENAI_ACCOUNT_COMMAND_NAME`, `OPENAI_ROUTING_COMMAND_NAME`, `OPENAI_KILLSWITCH_COMMAND_NAME`, `OPENAI_DUMP_COMMAND_NAME`, `OPENAI_LOGGING_COMMAND_NAME`, `OPENAI_CACHEKEEP_COMMAND_NAME`).
Example: `packages/opencode/src/commands.ts`.

**Environment variables:** SCREAMING_SNAKE_CASE with the `CORTEXKIT_OPENAI_AUTH_*` and `OPENCODE_OPENAI_AUTH_*` prefixes (negative-prefixed `CORTEXKIT_OPENAI_AUTH_NO_WEB_SEARCH` for the default-on cache fix).
Example: `CORTEXKIT_OPENAI_AUTH_WEBSOCKETS`, `CORTEXKIT_OPENAI_AUTH_RAW_WS`, `OPENCODE_OPENAI_AUTH_DUMP_DIR`.

**RPC methods:** lowercase, dash-separated (`pending-notifications`, `apply`). JSON-RPC-shaped bodies.

**Model IDs:** GPT-style dotted identifiers that pass `gpt-X.Y`; the allow-list at `packages/opencode/src/index.ts` (`ALLOWED_MODELS`) and the regex `^gpt-(\d+\.\d+)` with `> 5.4` fallback define which models surface to the TUI.

## Where to Add New Code

**New OAuth provider (replace Codex with another):** add the refresh + quota fns to `packages/opencode/src/core/provider.ts` next to `codexRefreshFn` / `whamUsageFn`; inject them into `FallbackAccountManager` + `QuotaManager` in `packages/opencode/src/index.ts` `auth.loader`. The generic core stays untouched.

**New `/openai-*` slash command:** add the command name constant in `packages/opencode/src/commands.ts` (`OPENAI_*_COMMAND_NAME`), add it to `MODAL_COMMANDS`, implement `executeXxxCommand`, and wire it into `buildDialogPayload`. The TUI dialog content lives in `packages/opencode/src/tui/command-dialogs.tsx`.

**New storage key (under the existing JSON file):** extend `AccountStorage` in `packages/opencode/src/core/accounts.ts`, bump `version`, and update the config through `mutateAccounts` (atomic read-modify-write). Account operations preserve existing transport settings. Do not use `saveAccounts` (which union-merges the account list and can resurrect concurrently-removed accounts) except for test seeding. Gating of state writes on the config roster is handled automatically by `saveAccountState`.

**New transport (gRPC, etc.):** create a new file under `packages/opencode/src/` mirroring `ws.ts` + `ws-pool.ts`; integrate in `packages/opencode/src/index.ts` `sendWithAccessToken` next to the HTTP/WS branch. Update `packages/opencode/src/raw-ws.ts` only if you need a new runtime-specific client.

**New quota source (e.g. a different HTTP endpoint):** add a normalizer to `packages/opencode/src/quota-normalize.ts` (`normalizeXxx` returning `OAuthQuotaSnapshot`); expose it on `packages/opencode/src/core/provider.ts` as a new `ProviderQuotaFn` shape; inject into `QuotaManager` via `fetchQuotaFn` (currently `undefined` — push-only) and call it from `refresh-all-quota.ts`.

**New shared util:** add to `packages/opencode/src/util/`. Keep the file dependency-free (node: builtins only).

**New test:** add `*.test.ts` next to the source file it exercises, under `packages/opencode/src/tests/`. Bun test only — no jest/vitest.

**New script:** add to `scripts/` and wire into the `scripts` block of the root `package.json`. Release-driving scripts go through `scripts/release.sh`.

**New package (sibling to `opencode` or `pi`):** create `packages/<name>/` with its own `package.json`, `src/`, `tsconfig.json`, `tsconfig.build.json`, and add it under `workspaces` in the root `package.json`. Mirror the existing `opencode` or `pi` layout — Bun workspaces, `bun run build`, `bun run typecheck`.

**New plugin command constant / TUI preferences key:** add to `packages/opencode/src/tui-preferences.ts` (`DEFAULT_PREFS` + a typed key under the `PLUGIN_KEY = 'openai-auth'` top-level key in `~/.config/opencode/tui-preferences.jsonc`); the schema-validated reader will accept the new key automatically because `resolveOpenaiAuthPrefs` per-key defaults.
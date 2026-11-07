# Codebase Structure

A Bun workspace of three TypeScript packages. This file is a map; to find a specific symbol, search the code rather than this document. `ARCHITECTURE.md` explains how the parts work.

## Workspace

```text
packages/
  core/       @cortexkit/openai-auth-core: private shared code, bundled into both npm packages
  opencode/   @cortexkit/opencode-openai-auth: the OpenCode 1 plugin (package root) and OpenCode 2 plugin (./server)
  pi/         @cortexkit/pi-openai-auth: the Pi extension
scripts/      gate.sh (local checks), release.sh, version-sync.mjs, build-time dependency checks, benchmarks
docs/         user documentation, linked from README.md
.github/      CI (ci.yml), release (release.yaml), issue templates
```

Each package keeps its tests in `src/tests/`. `@cortexkit/common-auth` (the library every CortexKit auth plugin shares) is a build-time dependency: its account store, vault consumer, limit policy, OpenCode 2 installer, command menu and sidebar are bundled in.

## `packages/core/src`

- `index.ts`: the command seam (`buildDialogPayload`, `applyCommand`), kept small because it runs credential scrubbing; `internal.ts`: everything else the hosts import. `src/tests/export-surface.test.ts` fails when the seam exposes a command body or a store, OAuth or reset entry point.
- `accounts.ts`: the account store types and the legacy fallback manager. `oauth.ts`: PKCE, browser and device logins, JWT claims. `provider.ts`: token refresh and the `wham/usage` quota fetch.
- `pool-routing.ts`: the routing every host uses (OpenCode on a migrated install, Pi always). `pool-session-pins.ts`, `pool-source-state.ts`, `pool-quota.ts`: sticky placement and pool state shared by OpenCode 2 and Pi.
- `limit-*.ts`, `routing-wait.ts`, `session-cache-activity.ts`, `quota-refusal.ts`: the shared limit policy as openai-auth adopts it.
- `quota-manager.ts`, `quota-normalize.ts`, `refresh-all-quota.ts`, `insula-quota.ts`: quota cache, intake and polling.
- `vault.ts`, `vault-*.ts`: Claustrum vault accounts, vault routing and the vault menu.
- `commands.ts`: the `/openai` menu. `reset-credits.ts`: reset-credit redemption.
- `util/`: credential redaction, error text, URL opening.

## `packages/opencode/src`

- `index.ts`: the OpenCode 1 plugin: auth loader, fetch override, legacy path, model rules, `/openai` hook. `bin.ts` and `setup.ts`: the `opencode-openai-auth setup` command.
- `codex-request.ts`, `codex-body.ts`, `codex-sessions.ts`: the Codex request shape and the per-session thread ids.
- `ws.ts`, `ws-pool.ts`, `raw-ws*.ts`, `codex-http.ts`: OpenCode 1's WebSocket transport and its HTTP fallback.
- `core/`: host-owned machinery: `pool-request.ts` (one request over the pool or vault), `pool-account-source.ts`, `pool-migration.ts`, `pool-lifecycle.ts`, `host-slot.ts`, `version-fence.ts`, `process-heartbeat.ts`, `runtime-layout.ts`, `account-paths.ts`, `limit-source.ts`, `shared-vault.ts`, `cachekeep.ts`, `background-quota-refresh.ts`.
- `v2/`: the OpenCode 2 plugin: `server.ts` (entry), `setup.ts` (wiring), `adapter.ts` (answers common-auth's installer), `codex-wire.ts` and `frame-*.ts` (request and frame rewrites), `login.ts`, `models.ts`, `pins.ts`, `session-accounts.ts`, `cache-keep.ts`, `control-plane.ts`, `menu.ts`, `sidebar-publisher.ts`.
- `auth/`: the `/login openai` methods and the `opencode auth login` account menu (`methods.ts`), and the doctor checks (`doctor.ts`).
- `sidebar-state.ts`: the sidebar snapshot file and the OpenCode 1 session pins. `tui.tsx`, `tui/`: the sidebar and dialogs (OpenCode 1 in `tui.tsx`, OpenCode 2 in `tui/v2.tsx`). `rpc/`: the loopback RPC between server and TUI.
- `config.ts`: settings from environment and `openai-auth.json`. `logger.ts`, `dump.ts`, `dump-size.ts`: the log file and request dumps.
- `scripts/build-tui.ts`: precompiles the TUI into `src/tui-compiled/` at build time.

## `packages/pi/src`

- `index.ts`: registers the `openai-codex` provider and the `/openai` command.
- `runtime.ts`, `pool-request.ts`, `pool-source.ts`, `main-account.ts`: routing each request across Pi's own login and the pool, and vault mode.
- `store-paths.ts`, `paths.ts`: where Pi's store lives. `vault-slot.ts`: the placeholder Pi's `auth.json` holds in vault mode. `raw-ws-node.ts`: the WebSocket shim. `routing.ts`: in-memory session pins.

## Where to add new code

- **Routing or admission behaviour:** `packages/core/src/pool-routing.ts`, so OpenCode 1, OpenCode 2 and Pi all get it. The legacy OpenCode 1 path in `packages/opencode/src/index.ts` changes only for fixes.
- **A Codex request rewrite:** `packages/opencode/src/codex-request.ts`. OpenCode 2 reaches it through `v2/codex-wire.ts`; check both the HTTP body and the WebSocket frame.
- **A `/openai` menu item:** `packages/core/src/commands.ts` for something every host has. A host-only item goes in the host's menu options: `packages/opencode/src/commands.ts` for OpenCode, `packages/pi/src/commands.ts` for Pi.
- **A setting:** stored in `openai-auth.json` and written only through the pool store's `updateSettings`. Environment overrides go in `packages/opencode/src/config.ts`.
- **A new runtime file:** name it in `packages/opencode/src/core/account-paths.ts` and add it to the move in `runtime-layout.ts`, or OpenCode 2 will watch it in the config folder.
- **A quota source:** a normalizer in `packages/core/src/quota-normalize.ts` returning the shared snapshot shape.
- **Vault behaviour:** the consumer itself is `@cortexkit/common-auth/claustrum`; this plugin's side is `packages/core/src/vault.ts`.
- **A test:** `src/tests/*.test.ts` in the package whose code it covers. Real-host suites are `packages/opencode/src/tests/opencode1-e2e.test.ts` and `opencode2-e2e.test.ts`.

## Conventions

- Files are kebab-case; tests are `*.test.ts` under each package's `src/tests/`.
- Bun runs the tests (`bun run test` at the root runs all three packages). TypeScript is checked with `tsc`, and formatting and lint are Biome.
- `scripts/gate.sh --fast` runs the quick checks; `scripts/gate.sh` runs the full suites, the packaging checks and both real-host suites, as CI does.
- The OpenCode and Pi test preloads (`src/tests/setup-env.ts`) point state and config paths at temporary folders and clear `CORTEXKIT_VAULT_HOST`, so no test touches live accounts or runs in hosted mode by accident. A child process spawned without an `env` option gets the environment the test process started with, so tests that spawn children pass `env` built from `process.env`.

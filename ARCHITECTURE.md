# Architecture

openai-auth lets coding agents use ChatGPT subscriptions (the Codex backend at `chatgpt.com/backend-api/codex`) with more than one account. It signs requests with a ChatGPT login instead of an API key, chooses which account serves each request, follows each account's quota, and moves work to another account when one runs out. It can also take its accounts from the Claustrum vault instead of holding credentials itself.

It runs in three hosts:

- **OpenCode 1**, as `@cortexkit/opencode-openai-auth` (`packages/opencode`). The package root is the OpenCode 1 plugin. It replaces OpenCode's built-in `openai` auth hook and sends every request itself.
- **OpenCode 2**, through the same package's `./server` export (`packages/opencode/src/v2/server.ts`). OpenCode 2 sends requests itself, over its own OpenAI driver; the plugin edits them through host hooks.
- **Pi**, as `@cortexkit/pi-openai-auth` (`packages/pi`), registering the `openai-codex` provider.

Both npm packages bundle two pieces of shared code at build time: `@cortexkit/openai-auth-core` (`packages/core`, private, never published) and `@cortexkit/common-auth`, the library all CortexKit auth plugins share. At run time they load three packages that must exist once per install: `@cortexkit/private-files`, `@cortexkit/claustrum-client` and `@cortexkit/subc-client` (kept external in each build script).

Paths below are relative to the repository root.

## Where state lives

On OpenCode (both versions share the files):

- **Settings and the account roster:** `openai-auth.json` in OpenCode's config folder (`OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`), or the file `OPENCODE_OPENAI_AUTH_FILE` names. It holds no credential.
- **The runtime folder:** the state file `openai-auth-state.json` (tokens), the vault folder `openai-auth-vault/` (enrollment, roster) and the Codex sessions files (`openai-auth-sessions.json` for OpenCode 1, `openai-auth-sessions-opencode2.json` for OpenCode 2). They live in `$XDG_STATE_HOME/cortexkit/openai-auth/opencode/` (default `~/.local/state`) for the config folder `~/.config/opencode`, and in `.../opencode-<16 hex>/` for any other config folder. Older installs kept them in the config folder; a one-time move takes them out (see Runtime folder move). `OPENCODE_OPENAI_AUTH_STATE_FILE` overrides the state file.
- **Machine-wide, beside the runtime folders** in `$XDG_STATE_HOME/cortexkit/openai-auth/`: `sidebar-state.json` (the sidebar snapshot and seven-day session pins; `OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE` overrides it), `processes/<pid>.json` (process heartbeats) and `rpc/` (loopback RPC port files).
- **OpenCode's own login slot:** OpenCode 1's `auth.json`, key `openai`. Before the pool migration it holds the main account's login; after it, a placeholder that is never sent. OpenCode 2's credential table only ever receives a placeholder.

On Pi, `openai-auth.json` lives in Pi's agent folder (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`; `PI_OPENAI_AUTH_FILE` overrides it). The state file and vault folder sit beside it (`PI_OPENAI_AUTH_STATE_FILE` overrides the state file). Pi's own login stays in Pi's `auth.json`. None of Pi's files move.

`packages/opencode/src/core/account-paths.ts` and `packages/pi/src/store-paths.ts` are the only places these rules are written. The store code takes both paths as arguments and resolves nothing, so a lock and the write it guards can never disagree about which file they mean.

## Terms

- **Account pool, row:** the shared account store from `@cortexkit/common-auth/store`. Each account is a row with its credential, its ChatGPT identity and its quota. Row `main` is the account that used to be OpenCode's own login; the others are fallbacks.
- **Migrated install, legacy path:** an OpenCode install whose accounts have moved into the pool. Before that, OpenCode 1 serves the main account from its login slot and fallbacks from the old roster (the legacy path in `packages/opencode/src/index.ts`); OpenCode 2 serves nothing from the plugin.
- **Placeholder:** a fixed non-secret value written into a host's login slot so the host routes requests through the plugin. It's never sent to a provider.
- **Vault mode:** the host is enrolled with the Claustrum vault. Only the OpenAI accounts the vault grants this host are used; local accounts are left untouched on disk.
- **Hosted mode:** Thalamus started the host with `CORTEXKIT_VAULT_HOST=thalamus` and provides a vault connection. It's vault mode without an enrollment of the host's own.
- **Route:** a vault account as a routing row. It holds no token.
- **Receipt:** what the vault returns for one send: a token and the record version it came from.
- **Roster:** the vault accounts this host saw on its last list, with their quota, order and declined state (`<host>-roster.json` in the vault folder). It holds no token.
- **Routing mode:** `main-first`, `fallback-first` or `sticky-balanced`, set in `/openai` → Routing.
- **Pin:** in sticky-balanced, the account a session was placed on.
- **Admission:** whether an account may serve a request now, judged from its quota, killswitch floors, limit marks and credential.
- **Killswitch floor:** a minimum percentage of a quota window an account must keep; below it, the account is not admitted.
- **Limit mark:** a record that an account hit a usage or rate limit, with when it resets.
- **Confirmed reset:** a reset time the provider stated. Only a confirmed reset can keep a session waiting on the same account.
- **Owned request:** a request the plugin acts on: its placeholder is the active credential. Every other request passes through untouched.
- **Output started:** the provider has sent part of the answer (text, reasoning or a tool call) that the host may already have shown or acted on.

## Code map

| Layer | Where | Role |
|---|---|---|
| OpenCode 1 plugin | `packages/opencode/src/index.ts` | Auth loader and fetch override, legacy path, model rules, quota recording, sidebar writes, the `/openai` command hook. |
| OpenCode 1 request path | `packages/opencode/src/core/pool-request.ts` | Routes one request over pool rows or vault routes. |
| Codex wire | `packages/opencode/src/codex-request.ts`, `codex-sessions.ts` | Rewrites requests into Codex's shape; keeps each session's thread id across restarts. |
| OpenCode 1 transports | `packages/opencode/src/ws.ts`, `ws-pool.ts`, `raw-ws*.ts` | Optional WebSocket transport with continuation, prewarm and HTTP fallback. |
| OpenCode 2 plugin | `packages/opencode/src/v2/` | `setup.ts` wires the pool, vault and hooks; `adapter.ts` answers common-auth's OpenCode 2 installer; `codex-wire.ts` rewrites HTTP bodies and WebSocket frames. |
| Pi extension | `packages/pi/src/` | `index.ts` registers the provider; `runtime.ts` and `pool-request.ts` route each request; `pool-source.ts` reads Pi's pool. |
| Shared core | `packages/core/src/` | Account store wrappers, OAuth, routing rules, limits, quota, the vault, reset credits, the `/openai` menu, redaction. |
| Pool and migration | `packages/opencode/src/core/pool-*.ts`, `host-slot.ts`, `version-fence.ts`, `process-heartbeat.ts` | Reading the pool for requests, migrating into it, adopting later logins. |
| Runtime layout | `packages/opencode/src/core/runtime-layout.ts`, `account-paths.ts` | The one-time move of runtime files out of OpenCode's config folder. |
| Keep-warm | `packages/opencode/src/core/cachekeep.ts`, `v2/cache-keep.ts` | Replays a session's last request to keep its prompt cache alive. |
| Sidebar and RPC | `packages/opencode/src/sidebar-state.ts`, `tui.tsx`, `tui/`, `rpc/`, `v2/sidebar-publisher.ts` | The quota sidebar, its state file, and the loopback RPC between server and TUI. |
| Setup | `packages/opencode/src/bin.ts`, `setup.ts` | `opencode-openai-auth setup`, over `@cortexkit/common-auth/setup`. |

`STRUCTURE.md` has the directory map and where to add new code.

## A request, per host

**OpenCode 1.** The auth loader returns a `fetch` that receives every OpenAI request. It reads the vault's authority first. In vault or hosted mode the request goes to `servePooled`, which routes over vault routes alone. Otherwise, if OpenCode's slot holds the pool placeholder and the install is migrated, `servePooled` routes over pool rows. Otherwise the legacy path serves the slot's own login and the old fallback roster. Each path rewrites the request into Codex's shape, sends it (HTTP, or WebSocket when `webSockets` is on), records quota from the response, and writes the sidebar.

**OpenCode 2.** `v2/setup.ts` runs once per location (project). It builds the pool source over the same files OpenCode 1 uses, starts the migration lifecycle, connects the vault, and installs common-auth's OpenCode 2 hooks with openai-auth's adapter. The host sends the request; the hooks choose the account (`chooseAccount`), set its bearer and `chatgpt-account-id`, rewrite the body or WebSocket frame, read quota from headers and `codex.rate_limits` frames, and decide retries. Title, compaction and generate requests follow the session's current account (`v2/session-accounts.ts`). An install that hasn't migrated yet migrates on the first OpenCode 2 start, behind the same version fence as on OpenCode 1. Until then the pool serves nothing, pool requests are refused locally, and a credential that isn't the plugin's placeholder passes through untouched.

**Pi.** Pi hands each `openai-codex` request to the extension with the token of Pi's own login. That login is routed as row `main` and the pool rows are fallbacks (`packages/pi/src/main-account.ts`). The runtime picks the account and streams through pi-ai's Codex stream with that account's token; pi-ai derives `chatgpt-account-id` from the token. In vault mode Pi's slot holds a placeholder and only vault routes serve.

## Codex wire shape

`prepareCodexRequest` (`packages/opencode/src/codex-request.ts`) makes a request look like it came from the official Codex CLI: Codex headers and client version (`CODEX_VERSION`), a UUIDv7 thread id per host session and turn id per user turn, turn metadata, and Codex's body key order. The thread id doubles as the prompt-cache key, so `codex-sessions.ts` stores it per session (thread ids only, never a token) and a restart keeps the cache.

- **Reasoning effort:** for the models in `MID_CONVERSATION_EFFORT_MODELS`, the request keeps the effort the session opened with, and a later change travels as a `configuration_update` input item before the new user turn. A changed request-level effort would invalidate the cached prefix.
- **Responses Lite:** a compact request shape for the models the backend marks Lite (`RESPONSES_LITE_MODELS`). It's off unless the `responsesLite` setting is on.
- **Models:** `codexOAuthModelListed` and `codexOAuthModelLimit` in `packages/opencode/src/index.ts` decide which models a ChatGPT login is offered and their context windows. OpenCode 2 applies the same rules through `v2/models.ts`. Pi registers its own fixed model list.

## Transports and no replay

OpenCode 1 sends over HTTP by default. With `webSockets` on, a session reuses a socket (`ws-pool.ts`), prewarms a new user turn, and chains turns with `previous_response_id`; `rawWebSocket` switches to the hand-rolled client in `raw-ws-bun.ts` or `raw-ws-node.ts`. A socket that can't serve falls back to HTTP for the session, and a request too big for a WebSocket frame (close 1009) is sent again over HTTP if nothing has streamed yet. OpenCode 2 uses the host's own HTTP and WebSocket transports. Pi uses pi-ai's Codex stream with a WebSocket shim (`packages/pi/src/raw-ws-node.ts`).

**No replay after output.** The host keeps what it has shown and runs tool calls as they arrive, so sending a request again after output started would duplicate text and re-run tools. So:

- On OpenCode 1's WebSocket path, a failed attempt surfaces as a retryable error only while no output frame has arrived (`emittedOutput` in `ws.ts`). OpenCode then sends the request again, and routing can move it to another account. After output, the stream ends with the fixed `TERMINAL_AFTER_OUTPUT_MESSAGE`, which OpenCode does not retry.
- On OpenCode 2, an attempt refused before output can retry on another account. After output, the turn continues only when the reply was cut mid-read (an HTTP body read failure, or a WebSocket that dropped with no terminal frame), on the same account, after routing and quota are checked again. The host then keeps the shown output. A limit, payment refusal, error status, account change or mixed session still ends the turn.
- Pi sends again only when an attempt failed before streaming its first event.

## Accounts and the pool migration

The pool is one store for both OpenCode hosts and Pi's own copy for Pi. `PoolAccountSource` (`packages/opencode/src/core/pool-account-source.ts`) is what a request reads, under one rule: a request waits on a store lock only to get a usable token. Rows are read lock-free into memory and re-read only when the files changed. A token inside its refresh window is refreshed in the background; a request waits only for an expired one. Quota from responses is merged in memory at once and written to the store in the background.

The migration (`packages/opencode/src/core/pool-migration.ts`) moves the slot's login and the old roster into the pool and writes the placeholder into the slot. It never runs on the request path; `pool-lifecycle.ts` runs it in the background and retries on a backoff, then keeps adopting logins that later land in the slot.

- **Crash safety:** the slot keeps the only unmoved copy of its credential until the pool holds it and a reload proved it. The placeholder is written only if the slot still holds the exact pair that was read, and a durable pending-transfer record says whether an interrupted transfer happened.
- **The version fence** (`version-fence.ts`): the migration runs only while every live openai-auth process is this version or newer, because older versions refresh the slot's token by their own rules and OpenAI refresh tokens are single-use. Processes are found by heartbeats and RPC port files. A record older than this boot (by more than five minutes) doesn't count, since a reused pid isn't the old process.
- **Paused in vault mode:** no migration or adoption runs while the host is enrolled, so the slot and account files stay byte-identical.

## Vault mode and hosted mode

`OpenAiVault` (`packages/core/src/vault.ts`) is one host's view of its OpenAI accounts in the Claustrum vault, built on common-auth's `ClaustrumConsumer`. OpenCode and Pi enroll separately (`openai-auth-opencode`, `openai-auth-pi`), only from setup surfaces: Connect in `/openai` → Vault, the `opencode auth login` menu, or `opencode-openai-auth setup`. The operator approves the request with `ck`.

- **Exclusive:** while enrolled, the vault's routes are the only accounts routed. No pool row, slot login or Pi login is used, refreshed, polled or warmed. A request no vault account can serve is refused locally with a fixed vault-mode message; there is no fallback to local accounts.
- **One token per send:** a route holds no token. Each send asks the vault (`send`), so a revoked enrollment or a changed record takes effect on the next request. A 401 on a served credential is reported to the vault with the record version that send used, and nothing else is reported.
- **Last good token:** when the vault can't be reached, common-auth's consumer reuses the token it last served each account, in memory only, until that token expires. An explicit vault refusal drops it at once.
- **First roster:** a request in vault mode waits at most 2 seconds (`VAULT_FIRST_ROSTER_WAIT_MS`) for the vault's first account list.
- **Quota:** read from insula when insula has a reading for the account, else polled from the provider. Quota from responses is recorded into the roster, and the `x-codex-*` headers of each vault-served reply are also reported to the vault, so insula sees them without polling.

Hosted mode follows `vaultAuthority` from common-auth. When the environment has exactly `CORTEXKIT_VAULT_HOST=thalamus`, the authority is `host`. The consumer then connects only through the client Thalamus installs at `globalThis[Symbol.for('cortexkit.vault')]` (plugin id `openai-auth`). It reads no enrollment token file and refuses Connect, Disconnect and setup with common-auth's `VAULT_HOST_CONNECT_REFUSAL`. Menus show "Served by Thalamus". With the marker set and no relay, requests are refused as in vault mode. Synchronous checks use `isVaultHosted()` in `vault.ts`.

## Routing and admission

`packages/core/src/pool-routing.ts` holds the routing both hosts use, over common-auth's routing library. The library judges admission and order, places and moves sticky sessions, and decides when a pinned session must leave its account. openai-auth adds what the library has no input for:

- **The last path:** when admission leaves no account, the request still goes to one whose quota reads exhausted, because the reading may be stale and the provider has the final say. An account refused for unknown quota never takes this path; unknown quota blocks.
- **No-replay gate:** a request that can't be sent twice goes to one account and is never retried on another.
- **Prepaid credits:** an account whose free quota is used up but whose workspace credits are usable serves only when no account has free quota left.

The ordered modes try the next admitted account on a configured fallback status (default 401, 403 and 429). Sticky-balanced keeps a session on its pin until the account is confirmed unable to serve. It places a new session on the account with the least quota pressure, counting the pending bytes of other sessions just placed (`packages/core/src/pool-session-pins.ts`). Pins live in `sidebar-state.json` for seven days on OpenCode 1. OpenCode 2 keeps them in memory (`v2/pins.ts`) and only projects them to the sidebar file. Pi keeps them in memory for the process.

On OpenCode 1 and 2 in vault mode, when Thalamus's routing accessor (`globalThis[Symbol.for('cortexkit.routing')]`) is present, a primary request asks it which account to use (`packages/core/src/vault-routing.ts`). Pi doesn't ask. openai-auth sends its own same-account wait cap as `hold_wait_max_s`, takes only the account the answer names, and ignores any delay it suggests. Without the accessor, nothing changes and nothing is parsed.

## Limits and same-account waits

The shared limit policy (`@cortexkit/common-auth/limits`, adopted in `packages/core/src/limit-*.ts` and `packages/opencode/src/core/limit-source.ts`) records limit marks per account and per login, and decides after a limit whether to wait on the same account or switch.

- **Proof of exhaustion:** only a named failed frame or a `usage_limit_reached` error proves an account is exhausted. A bare 429 is a short cooldown, not exhaustion.
- **Wait or switch:** a session waits on its account only when the provider confirmed the reset and the reset comes before the session's prompt cache would expire. Switching accounts loses the cache. The cap is the routing setting **Longest wait on the same account** (`routing.maxSameAccountWait`: don't wait, 15 minutes by default, or until the cache expires). The cache lifetime is 30 minutes for GPT-5.6 and later and 5 minutes for older models (`ttlForModel` in `packages/core/src/session-cache-activity.ts`). A session waits at most once per user turn.
- **Per host:**
  - OpenCode 1 doesn't wait inside the plugin; it returns a 429 with `Retry-After`, and OpenCode's retry goes to the same account.
  - OpenCode 2 holds the retry through the host's retry hook.
  - Pi waits in the plugin with a countdown that Escape cancels, and doesn't wait without a screen.
  - Before a send that follows a wait, every host checks admission, the credential and the ChatGPT identity again.
- **Persistence:** marks are stored with the pool or the vault roster through common-auth's registry. Loading them is time-boxed, and if tracking can't load, the request is still served with tracking off.

Refusal texts are fixed and carry no account label or number, because OpenCode 1's retry policy matches error text and could retry a local refusal forever.

## Quota

Quota arrives three ways and is normalized into one snapshot shape (`packages/core/src/quota-normalize.ts`):

- **Response headers:** `x-codex-*` on HTTP responses.
- **WebSocket frames:** `codex.rate_limits`, attributed to the account that opened the socket, never to a shared global.
- **Polling:** `wham/usage` (`whamUsageFn` in `packages/core/src/provider.ts`), or insula in vault mode.

Readings carry their own time and merge per window by the newer reading. A background poll (`packages/opencode/src/core/background-quota-refresh.ts`) refreshes idle accounts under a cross-process lease, so only one process polls at a time. Unknown quota blocks admission, so every account gets a poll as soon as a process sees it. Workspace credits and the spend-control budget are read with the windows. The request path never waits on quota bookkeeping.

## Cache keep-warm

The Codex backend evicts an unused prompt cache after a while. Keep-warm (off by default; `/openai` → Cache) replays a session's last real request with `store: false` and its output-token caps removed, shortly before the cache would expire. The schedule, caps and backoff are common-auth's `CacheKeepManager`; `packages/opencode/src/core/cachekeep.ts` holds the Codex parts (which headers to replay, body capping, the GPT-5.6 lifetime and subagent policy). OpenCode 2 runs one manager per account store in the process (`v2/cache-keep.ts`). A warm goes only to the account that serves the session now, with a fresh credential, and only if that credential still signs in as the captured ChatGPT account. A successful warm counts as cache activity for the same-account wait. Pi has no keep-warm.

## Commands, sidebar and RPC

`/openai` is the one command on all three hosts (`createOpenAiMenu` in `packages/core/src/commands.ts`): accounts, quota, routing, killswitch floors, cache, diagnostics, vault, reset credits and session pins. It's built on common-auth's shared command menu. Each host adds what only it has: OpenCode its keep-warm, dumps and logging; Pi its own login. Until an install is migrated, `/openai` shows only why.

On OpenCode 1, the server process writes `sidebar-state.json` and the TUI (`packages/opencode/src/tui.tsx`) reads it. The `/openai` dialog travels over a loopback HTTP RPC (`packages/opencode/src/rpc/`) on `127.0.0.1` with a per-process bearer token; port files live under the RPC folder per project. On OpenCode 2, `v2/control-plane.ts` registers the command and `tui/v2.tsx` drains the dialog for the displayed session. The sidebar component is common-auth's shared quota sidebar.

## Runtime folder move

OpenCode 2 watches its config folder, so files the plugin rewrites every few seconds must not live there. `packages/opencode/src/core/runtime-layout.ts` moves the state file, the vault folder and the sessions files to the runtime folder once, at plugin start:

- **One layout per process:** a process fixes its layout for a config folder before it builds the vault, the store or a sessions store, and never switches while it runs, because a live switch would race writes already in flight.
- **When it may move:** only while no live process could still write the old files (an older version, or one on the legacy layout, read from the heartbeats). A process that can't record its choice in its heartbeat refuses to start.
- **How:** under the layout lock and every data lock it copies, byte-verifies, writes `layout.json` last, and removes only byte-identical old files. A process with a path override never moves files.
- **After the move:** an old state or vault file that reappears refuses the start with a fixed message naming both paths. A reappeared sessions file only warns.

## Logging, dumps and redaction

The logger (`packages/core/src/logger.ts`, file set by `packages/opencode/src/logger.ts`) writes to `opencode-openai-auth.log` in the temp folder by default (`OPENCODE_OPENAI_AUTH_LOG_FILE`, `OPENCODE_OPENAI_AUTH_LOG_LEVEL`). It redacts bearer tokens, JWTs, API keys and ChatGPT account ids, and rotates the file at 5 MiB. Request dumps (`packages/opencode/src/dump.ts`, off by default) go to `opencode-openai-auth-dumps` in the temp folder, capped at 512 MiB with the oldest removed first, and are redacted the same way. Error bodies are scrubbed by `packages/core/src/util/credential-redaction.ts` before they reach the host. Transport lifecycle and stream failures log at normal levels whether or not dumps are on.

## Load-bearing invariants

1. **No replay after output.** A request whose output started is never sent again by the plugin, except OpenCode 2's same-account continuation of a cut read. Replaying duplicates shown text and re-runs tools.
2. **Vault mode is exclusive.** Enrolled or hosted, no local account is used, refreshed, polled, warmed or written, and a request no vault account serves is refused, never sent locally.
3. **The request path never waits on bookkeeping.** Quota writes, sidebar writes, usage reports and `lastUsed` stamps run after the reply is handed back and never block or fail a request.
4. **Unknown quota blocks.** Admission never treats a missing reading as headroom.
5. **One refresh per token family.** OpenAI refresh tokens are single-use, so two refreshes of one token log the account out. Token refreshes take the store's locks, and the pool migration waits behind the version fence so an older version never refreshes a token the pool also refreshes.
6. **Fixed refusal texts.** Refusals carry no account label, id, number or provider text, because OpenCode 1 retries errors whose text matches its patterns.
7. **Path rules live in one place.** Only `account-paths.ts` and `store-paths.ts` resolve file locations; store code takes paths as arguments.
8. **Credentials never cross into logs, dumps, the sidebar, RPC payloads or menus.** Menu payloads project account fields explicitly, and every output path is redacted.

## Failure handling

- **Vault unreachable:** the last good token serves each account until it expires; then the request is refused with a fixed message.
- **No account can serve:** the last path tries an exhausted account. With none, the request is refused locally; on OpenCode 1 the refusal is a 429 whose `Retry-After` comes from the blocking reset.
- **Store lock contention:** request-path reads stay lock-free and fall back to the last snapshot; background writes log at warn. A request waits on a lock only to refresh an expired token.
- **Limits state unreadable:** requests are served with tracking off and a warning logged once.
- **WebSocket failure:** before output, retried or moved to HTTP; after output, ended with the fixed message (OpenCode 1).
- **Sidebar, RPC or dump failure:** logged at warn and ignored; a turn never fails for them.

## Further reading

`docs/` has the user documentation: `accounts-and-routing.md`, `vault.md`, `transports.md`, `cache-keep-warm.md`, `commands.md`, `configuration.md`, `opencode-2.md`, `troubleshooting.md`, and `limit-policy-conformance.md` (the per-host limit behaviour ledger). `docs/development.md` and `docs/release.md` cover working on and releasing the plugin. `packages/opencode/src/WEBSOCKET.md` describes the OpenCode 1 WebSocket transport.

# CortexKit OpenAI Auth for OpenCode

ChatGPT Plus/Pro OAuth support for [OpenCode](https://opencode.ai), maintained by CortexKit.

This plugin lets OpenCode talk to the OpenAI **Codex** backend (`https://chatgpt.com/backend-api/codex/responses`) using a ChatGPT Plus/Pro subscription instead of a pay-as-you-go API key. It rewrites OpenCode's outbound OpenAI requests into Codex's request shape, filters the model list to OAuth-eligible models, zeroes provider costs for those models, and adds a prompt-cache stabilizer that keeps tool-continuation requests on the backend's cached path.

On top of single-account auth it adds a full account-management layer: multiple ChatGPT accounts with automatic fallback when one is rate-limited, live quota visibility, a per-account killswitch, an idle prompt-cache keep-warm, and interactive in-TUI control surfaces for all of it.

The plugin intentionally registers the built-in `openai` provider id. OpenCode loads external server plugins after its internal ones, so this package supersedes OpenCode's internal OpenAI auth hook without any change to your model configuration.

## Package

| Package | Agent | Purpose |
| --- | --- | --- |
| `@cortexkit/opencode-openai-auth` | OpenCode | ChatGPT Plus/Pro OAuth, Codex request rewriting, model filtering, prompt-cache stabilizer, multi-account fallback, quota tracking, cache keep-warm, and an optional OpenAI Responses WebSocket transport. |

## Install

Add the plugin to your OpenCode configuration (`~/.config/opencode/opencode.json`):

```json
{
  "plugin": ["@cortexkit/opencode-openai-auth"]
}
```

Pinning is strongly recommended for any OpenCode plugin:

```json
{
  "plugin": ["@cortexkit/opencode-openai-auth@0.1.0"]
}
```

After changing plugin config, restart OpenCode.

> [!TIP]
> If OpenCode keeps using an old build, clear OpenCode's plugin cache with `rm -rf ~/.cache/opencode` and restart.

### Authenticate

Log in with OpenCode's normal auth command and pick the `openai` provider:

```text
/login openai
```

Three methods are offered:

- **ChatGPT Pro/Plus (browser)** — opens the OpenAI authorization page and completes the login through a local callback. Use this on a machine with a browser.
- **ChatGPT Pro/Plus (headless)** — device-code flow for remote or headless machines: you're shown a code to enter at the OpenAI device page from any browser.
- **Manually enter API Key** — falls back to a standard pay-as-you-go OpenAI API key (no OAuth, normal billing).

The account you log in with via `/login openai` is your **main** account, stored and refreshed by OpenCode's own auth store. Additional **fallback** accounts are managed separately (see [Multiple accounts](#multiple-accounts)).

## Multiple accounts

The plugin supports more than one ChatGPT account: a single **main** account (the one from `/login openai`, held in OpenCode's auth store) plus any number of **fallback** accounts (held in the plugin's own account store). When the main account hits a rate limit, traffic automatically rolls over to a healthy fallback for the rest of the limit window, then returns.

- **Add a fallback** in the TUI with `/openai-account add [label]` (runs the same browser/headless OAuth flow as login), or from a shell with the `openai-auth` CLI (see [CLI](#cli)).
- **Remove** a fallback with `/openai-account remove <id>`.
- Each account is identified by its stable ChatGPT account id, so the same account is never added twice.

Which account serves is decided by [routing](#routing) mode. There is no manual active-account selector: `sticky-balanced` creates a session pin automatically, while the other modes follow their configured order. A request that a fallback can serve is buffered so the retry is safe, and selection skips accounts the [killswitch](#killswitch) has gated out.

### Routing

`/openai-routing` controls how the main and fallback accounts are ordered:

| Mode | Behavior |
| --- | --- |
| `main-first` (default) | Send on the main account; on a `401`/`403`/`429`, transparently retry on the next usable fallback. |
| `fallback-first` | Try usable fallback accounts first (preserving the main account's quota), and fall through to the main account only if no fallback can serve. |
| `sticky-balanced` | For a cold session, choose the account with the lowest projected pressure against its usable quota. Keep that account pinned for the session. |

`sticky-balanced` does not rebalance mid-session. A pin stays in place until fresh quota confirms exhaustion or the account has a permanent authentication failure (`401`/`403`). A transient failure, stale or unknown quota, and `429` without confirmed exhaustion retain the pin; there is no Retry-After hold. This avoids changing an account while a session's continuation and cache context still belong to the first account.

Pins use a SHA-256 hash of the session id as their key in the machine-global sidebar state and expire after seven days. Cold placement excludes accounts with stale or unknown quota from weighted selection. If every account is excluded, it fails open to the configured mode order. Equal projected-pressure scores break deterministically by configured order, then account id; a shared pending-byte bridge makes simultaneous cold placements account for each other. Subagents receive independent pins, and a resumed subagent reuses its own pin. `/openai-routing reset` clears only the current session's pin, so the next placement may legitimately choose the same account again.

### Killswitch

`/openai-killswitch` hard-blocks requests for an account once its quota drops below a threshold, instead of letting the request through and burning the last of a window:

- `/openai-killswitch on` / `off` — enable or disable hard-blocking.
- `/openai-killswitch set <acct>:<5h>,<1w> ...` — set per-account 5-hour and weekly cutoff percentages (e.g. `main:5,10 work-alt:5,10`).

## Quota

Codex reports usage on **two rolling windows** — a 5-hour primary window and a weekly secondary window. The plugin reads quota **passively, per turn**, from whichever transport is in use, so there is no extra polling during normal work:

- **HTTP/SSE** — `x-codex-*` response headers on every reply.
- **WebSocket** — the in-band `codex.rate_limits` frame.

`/openai-quota` shows the current 5h and weekly used-percent for every account. When you run it, it additionally polls the explicit usage endpoint for the main account **and every fallback** so even never-routed accounts show fresh numbers. Quota for the active account is also rendered in the OpenCode sidebar (used %, reset countdown, and a pacing estimate).

## Cache keep-warm

`/openai-cachekeep` keeps the Codex prompt cache warm while a session is idle, so the next real turn after a gap hits the cache instead of paying a cold-start. Codex evicts a session's prompt cache after roughly five minutes of inactivity; keep-warm replays the latest real request as a tiny shadow request (it generates no stored turn — `store: false`) just before the cache would expire.

- `/openai-cachekeep on` / `off` — enable or disable. The setting is **persisted**, so it stays on across restarts and applies to every session until you turn it off.
- `/openai-cachekeep subagents on` / `off` — also keep subagent sessions warm (off by default). Useful when the same subagent is reused repeatedly. Subagent sessions warm only while recently active (a 30-minute idle cap, versus one hour for the main session).
- `/openai-cachekeep sustain on` / `off` — bypass main-session idle pruning. It defaults to off, is main-agent-only, and does not change subagent limits.
- `/openai-cachekeep` — show status: enabled state, subagent mode, tracked sessions, and last-warm cost.

Keep-warm only ever runs for **main-agent** sessions unless subagent mode is on, and it never warms an account that is not serving that session. `sustain` is orthogonal to the clock window: the configured window still controls capture and warming. `sustain` bypasses only the main idle-pruning bound; the target-count, memory-byte, and LRU caps still apply. Subagent idle and warm-count limits remain unchanged.

Cost matters. A GPT-5.6 session needs about two warms per hour, roughly 1K output tokens per hour at about a 99.4% cache hit rate. Non-5.6 sessions need about twelve warms per hour, which is the higher-cost case.

`sustain` deliberately does not use the sibling `anthropic-auth` plugin's `always` term. In that plugin, `always` means ignore the clock schedule; here, `sustain` means bypass main idle pruning. They control different axes.

### Sustain prerequisite: Magic Context

Before enabling sustain for a main-session model, update `~/.config/cortexkit/magic-context.jsonc` with Magic Context's supported schema. Preserve existing per-model entries and set only models used by sustained **main** sessions to `"never"`:

```jsonc
{
  "cache_ttl": {
    "default": "5m",
    "openai/gpt-5.6-sol": "never"
  }
}
```

Magic Context does not run in subagent sessions, so no subagent exception is needed. This setting is required because keeping a cache alive indefinitely falsifies an elapsed-time heuristic that assumes a cache is cold and therefore safe to mutate for free.

## Logging

The plugin writes a leveled, secret-redacting, size-rotating log:

| Setting | Where | Default | Purpose |
| --- | --- | --- | --- |
| Log level | `/openai-logging` (TUI) or `OPENCODE_OPENAI_AUTH_LOG_LEVEL` | `info` | One of `error`, `warn`, `info`, `debug`, `trace`. `/openai-logging` changes it immediately without a restart and persists it. |
| Log file | `OPENCODE_OPENAI_AUTH_LOG_FILE` | OS temp dir: `opencode-openai-auth.log` | Destination file. Rotates at 5 MB, keeping three older generations. |

Token values and authorization/cookie headers are redacted from the log. Conversation/request bodies are never written to it (transport request dumps are a separate, explicit opt-in — see [`dump`](#configuration)).

## Slash commands

All commands open an interactive control surface in the TUI (a selectable dialog), and also accept the explicit argument forms below.

| Command | Arguments | Purpose |
| --- | --- | --- |
| `/openai-quota` | — | Show 5h + weekly quota for all accounts (polls the usage endpoint). |
| `/openai-account` | `add [label]` · `remove <id>` · `order <a> <b>` | List and manage accounts; add runs OAuth, order swaps fallback positions. |
| `/openai-routing` | `main-first` · `fallback-first` · `sticky-balanced` · `reset` | Set account preference order, enable sticky balanced routing, or clear the current session pin. |
| `/openai-killswitch` | `on` · `off` · `set <acct>:<5h>,<1w> ...` | Hard-block accounts below per-window quota thresholds. |
| `/openai-cachekeep` | `on` · `off` · `subagents on` · `subagents off` · `sustain on` · `sustain off` | Idle prompt-cache keep-warm; optional subagent mode and main-only idle-pruning bypass. |
| `/openai-logging` | `<level>` | Set log level (`error`/`warn`/`info`/`debug`/`trace`) live. |
| `/openai-dump` | `on` · `off` | Toggle transport request dumps for cache debugging. |

## CLI

The package exposes an `openai-auth` command for managing fallback accounts from a shell (useful on headless machines or in scripts). Run it with `npx` — no global install needed:

```text
npx @cortexkit/opencode-openai-auth login [--label <name>] [--headless]   # add a fallback account via OAuth
npx @cortexkit/opencode-openai-auth list                                   # list fallback accounts
npx @cortexkit/opencode-openai-auth remove <id>                            # remove a fallback account
```

`login` uses the browser flow by default; `--headless` uses the device-code flow. These manage **fallback** accounts only — the main account comes from `/login openai`.

## Configuration

Settings come from two sources. **Environment variables take precedence over the config file**, and any unset value falls back to the default.

Config file: `~/.config/opencode/openai-auth.json` (the directory follows `OPENCODE_CONFIG_DIR` / `XDG_CONFIG_HOME`; override the full path with `OPENCODE_OPENAI_AUTH_FILE`).

```json
{
  "webSearch": true,
  "webSockets": false,
  "rawWebSocket": false,
  "responsesLite": false,
  "dump": false,
  "codexApiEndpoint": "https://chatgpt.com/backend-api/codex/responses"
}
```

| Setting | Config field | Environment variable | Default | Purpose |
| --- | --- | --- | --- | --- |
| Prompt-cache fix | `webSearch` | `CORTEXKIT_OPENAI_AUTH_NO_WEB_SEARCH` (set to disable) | `true` | Appends a native `web_search` tool to the wire request so Codex keeps tool-continuation requests on the stable prompt cache. See [Why `web_search`](#why-web_search). |
| WebSocket transport | `webSockets` | `CORTEXKIT_OPENAI_AUTH_WEBSOCKETS` | `false` | Use the Codex Responses WebSocket transport instead of plain HTTP. See [Transports](#transports). |
| Hand-rolled WS client | `rawWebSocket` | `CORTEXKIT_OPENAI_AUTH_RAW_WS` | `false` | When WebSockets are enabled, use the hand-rolled raw TCP/TLS client that surfaces Codex-style incremental streaming. Bun uses `Bun.connect`; Node/OpenCode Desktop uses `node:net`/`node:tls`. |
| Responses Lite | `responsesLite` | `CORTEXKIT_OPENAI_AUTH_RESPONSES_LITE` | `false` | Send `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` requests in Codex's Responses Lite shape — the wire format the Codex CLI itself uses for these models. Lite carries tools inline in the input, so it bypasses the `web_search` prompt-cache stabilizer for these models (see [Why `web_search`](#why-web_search)). |
| Request dumps | `dump` | `CORTEXKIT_OPENAI_AUTH_DUMP` | `false` | Write final Codex request bodies and redacted request metadata for cache debugging. Bodies may contain prompt/session content. |
| Dump directory | `dumpDir` | `OPENCODE_OPENAI_AUTH_DUMP_DIR` | OS temp dir: `opencode-openai-auth-dumps` | Destination for `.body.json`, `.meta.json`, and `.request.json` dump files. |
| Codex endpoint | `codexApiEndpoint` | `CORTEXKIT_OPENAI_AUTH_CODEX_ENDPOINT` | `https://chatgpt.com/backend-api/codex/responses` | Send rewritten Codex requests to a compatible proxy/relay instead of ChatGPT's backend endpoint. |

Booleans accept `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off`/empty. The `webSearch` negative env var (`CORTEXKIT_OPENAI_AUTH_NO_WEB_SEARCH`), when set to a truthy value, disables the cache fix and always wins over the config file.

The same `openai-auth.json` file also holds the managed **account store** (accounts, routing, killswitch thresholds, quota cache, log level, and cache-keep state). Those keys are written by the slash commands and the CLI — edit them through the commands rather than by hand. The plugin distinguishes the two: a settings-only file is never overwritten with account data, and account operations preserve your transport settings.

Example — opt into the WebSocket transport via the config file:

```json
{
  "webSockets": true,
  "rawWebSocket": true
}
```

Example — disable the cache fix for one run via env:

```sh
CORTEXKIT_OPENAI_AUTH_NO_WEB_SEARCH=1 opencode
```

Example — route OAuth/Codex traffic through a local Codex-compatible proxy:

```sh
CORTEXKIT_OPENAI_AUTH_CODEX_ENDPOINT=http://127.0.0.1:8899/v1/responses opencode
```

Example — capture request bodies while debugging cache behavior:

```sh
CORTEXKIT_OPENAI_AUTH_DUMP=1 opencode
```

Turn dumps off after debugging; `.body.json` files contain the full rewritten prompt/request body.

Analyze cache cliffs for a dumped OpenCode session:

```sh
bun run analyze:cache -- --session ses_... --no-timeline
```

For raw consecutive request-body comparisons, include wire context:

```sh
bun run analyze:cache -- --session ses_... --no-timeline --wire-context 180
```

## Transports

The plugin can reach the Codex backend over plain HTTP or over the OpenAI Responses WebSocket. The transport choice does **not** affect prompt-cache behavior (the cache fix applies to all three) or quota tracking (both transports report quota per turn); it only affects connection style and streaming.

| Transport | Enable with | Streaming | Notes |
| --- | --- | --- | --- |
| HTTP (default) | — | Server-sent events | Simplest and the default. One request/response per turn step. |
| Native WebSocket | `webSockets: true` | Coarse | Uses the runtime's native WebSocket with a session-keyed connection pool and `previous_response_id` continuation chaining. Native clients can batch frames, so streaming is coarser than Codex's raw client. |
| Hand-rolled WebSocket | `webSockets: true` + `rawWebSocket: true` | Codex-style incremental | A hand-rolled RFC 6455 client. Bun uses `Bun.connect`; Node/OpenCode Desktop uses `node:net`/`node:tls`. Exists only to surface Codex-style incremental streaming (token-by-token rather than batched); it is not required for the cache fix. |

WebSocket continuation chaining relies on `previous_response_id`, which only resolves on the connection that produced it. A dropped or reconnected socket discards its continuation and starts a fresh chain.

## Why `web_search`

The Codex/OAuth backend has a prompt-cache quirk: on tool-continuation requests whose `tools` array contains **only** custom `function`-type tools (no OpenAI-native tool type), the cached prefix intermittently drops to zero mid-turn, re-billing the full prefix as uncached. Measured on a clean build, this happens on roughly 8–20% of tool-bearing requests across every transport.

Appending a single native `web_search` tool to the wire `tools` array flips every tool-bearing request onto the backend's stable cache path and eliminates the drops. The behavior is specific to `web_search` — adding other native tools (image generation, extra dummy function tools) does not fix it — and it is independent of transport.

Two things make this safe:

- The model does not invoke `web_search` on coding tasks, so it acts as an invisible cache anchor. (It is server-executed, so a hypothetical invocation would run a real search — acceptable given it never fires in practice.)
- Beyond removing the drops, anchoring the request also roughly doubles the steady cached prefix, so it is a net cost win, not just a stability fix.

The fix is on by default. Disable it only for diagnostics, with `webSearch: false` or `CORTEXKIT_OPENAI_AUTH_NO_WEB_SEARCH=1`.

## Development

Workspace layout:

```text
packages/opencode  OpenCode plugin
scripts            Release and dev tooling
```

Install dependencies:

```bash
bun install
```

Run checks:

```bash
bun run typecheck
bun run test
bun run build
bun run lint
bun run format:check
```

Inspect package contents before publishing:

```bash
bun run pack:opencode:dry
```

Test a local build with OpenCode:

```bash
bun run dev
```

This builds the plugin, symlinks the output into `.opencode/plugins/`, and starts `tsc --watch`. Restart OpenCode after starting the dev script and after rebuilds. Clean the local dev symlink with:

```bash
bun run dev:clean
```

## Release

This repo uses CortexKit's tag-driven release workflow.

Preview a release:

```bash
./scripts/release.sh 0.2.0 --dry
```

Create and push the release tag:

```bash
./scripts/release.sh 0.2.0
```

Wait for GitHub Actions:

```bash
./scripts/wait-release.sh v0.2.0
```

The release workflow runs checks, publishes `@cortexkit/opencode-openai-auth` to npm with provenance (npm Trusted Publishing / OIDC), and creates the GitHub release.

> [!NOTE]
> npm Trusted Publishing can only be configured after the package already exists on npm, so the **first** version must be published manually (`npm publish --access public` from `packages/opencode/`). Configure OIDC trusted publishing for the package afterward; subsequent tagged releases then publish through the workflow. The publish job already skips any version that is already on npm.

## License

MIT

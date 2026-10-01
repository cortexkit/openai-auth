# CortexKit OpenAI Auth for OpenCode

ChatGPT Plus/Pro OAuth support for [OpenCode](https://opencode.ai), maintained by CortexKit.

This plugin lets OpenCode talk to the OpenAI **Codex** backend (`https://chatgpt.com/backend-api/codex/responses`) using a ChatGPT Plus/Pro subscription instead of a pay-as-you-go API key. It rewrites OpenCode's outbound OpenAI requests into Codex's request shape, filters the model list to OAuth-eligible models, and zeroes provider costs for those models.

On top of single-account auth it adds a full account-management layer: multiple ChatGPT accounts with automatic fallback when one is rate-limited, live quota visibility, a per-account killswitch, an idle prompt-cache keep-warm, and interactive in-TUI control surfaces for all of it.

The plugin intentionally registers the built-in `openai` provider id. OpenCode loads external server plugins after its internal ones, so this package supersedes OpenCode's internal OpenAI auth hook without any change to your model configuration.

## Package

| Package | Agent | Purpose |
| --- | --- | --- |
| `@cortexkit/opencode-openai-auth` | OpenCode | ChatGPT Plus/Pro OAuth, Codex request rewriting, model filtering, multi-account fallback, quota tracking, cache keep-warm, and an optional OpenAI Responses WebSocket transport. |

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
  "plugin": ["@cortexkit/opencode-openai-auth@0.11.0"]
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

- **Add a fallback** from the Accounts section of [`/openai`](#the-openai-command) (browser or device-code sign-in), or from `opencode auth login`.
- **Remove, disable or reorder** accounts from the same section.
- Each account is identified by its stable ChatGPT account id, so the same account is never added twice.

Which account serves is decided by [routing](#routing) mode. There is no manual active-account selector: `sticky-balanced` creates a session pin automatically, while the other modes follow their configured order. A request that a fallback can serve is buffered so the retry is safe, and selection skips accounts the [killswitch](#killswitch) has gated out.

### Routing

The Routing section of `/openai` controls how the main and fallback accounts are ordered:

| Mode | Behavior |
| --- | --- |
| `ordered` | Try the accounts in roster order (set the order in the same section). |
| `main-first` (default) | Send on the main account; on a `401`/`403`/`429`, transparently retry on the next usable fallback. |
| `fallback-first` | Try usable fallback accounts first (preserving the main account's quota), and fall through to the main account only if no fallback can serve. |
| `sticky-balanced` | For a cold session, choose the account with the lowest projected pressure against its usable quota. Keep that account pinned for the session. |

`sticky-balanced` does not rebalance mid-session. A pin stays in place until fresh quota confirms exhaustion or the account has a permanent authentication failure (`401`/`403`). A transient failure, stale or unknown quota, and `429` without confirmed exhaustion retain the pin; there is no Retry-After hold. This avoids changing an account while a session's continuation and cache context still belong to the first account.

Pins use a SHA-256 hash of the session id as their key in the machine-global sidebar state and expire after seven days. Cold placement excludes accounts with stale or unknown quota from weighted selection. If every account is excluded, it fails open to the configured mode order. Equal projected-pressure scores break deterministically by configured order, then account id; a shared pending-byte bridge makes simultaneous cold placements account for each other. Subagents receive independent pins, and a resumed subagent reuses its own pin. The **This session** section of `/openai` clears only the current session's pin, so the next placement may legitimately choose the same account again.

### Killswitch

The killswitch hard-blocks requests for an account once its quota drops below a floor, instead of letting the request through and burning the last of a window. The Limits section of `/openai` turns it on or off and sets each account's floors: the minimum percent left in the 5-hour (`primary`) and weekly (`secondary`) windows. A window without a floor never blocks.

Thresholds saved by earlier versions (a `main` block, `5h`/`1w` names, accounts inheriting `main` or the 5%/10% defaults) are rewritten as explicit per-account floors the first time `/openai` saves a setting, so the same quota blocks the same requests.

## Quota

Codex reports usage on **two rolling windows** — a 5-hour primary window and a weekly secondary window. The plugin reads quota **passively, per turn**, from whichever transport is in use, so there is no extra polling during normal work:

- **HTTP/SSE** — `x-codex-*` response headers on every reply.
- **WebSocket** — the in-band `codex.rate_limits` frame.

The Quota section of `/openai` shows every account's windows and credit budget; **Check now** polls the usage endpoint for the main account **and every fallback** so even never-routed accounts show fresh numbers. Quota for the active account is also rendered in the OpenCode sidebar (used %, reset countdown, and a pacing estimate).

## Cache keep-warm

The Cache section of `/openai` keeps the Codex prompt cache warm while a session is idle, so the next real turn after a gap hits the cache instead of paying a cold-start. Codex evicts a session's prompt cache after roughly five minutes of inactivity; keep-warm replays the latest real request as a tiny shadow request (it generates no stored turn — `store: false`) just before the cache would expire.

- **Keep-warm on/off** — the setting is **persisted** (`cacheKeep.enabled`), so it stays on across restarts and applies to every session until you turn it off.
- **Subagent warming** — also keep subagent sessions warm (off by default). Useful when the same subagent is reused repeatedly. Subagent sessions warm only while recently active (a 30-minute idle cap, versus one hour for the main session).
- **Sustain** — bypass main-session idle pruning. It defaults to off, is main-agent-only, and does not change subagent limits.
- **Warm window** — warm only between local hours, such as `9-18` or `22-6`; empty warms at any hour.
- The section lists the timer, the tracked sessions and the TTL.

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
| Log level | Diagnostics section of `/openai` (TUI) or `OPENCODE_OPENAI_AUTH_LOG_LEVEL` | `info` | One of `error`, `warn`, `info`, `debug`, `trace`. The menu changes it immediately without a restart and persists it. |
| Log file | `OPENCODE_OPENAI_AUTH_LOG_FILE` | OS temp dir: `opencode-openai-auth.log` | Destination file. Rotates at 5 MB, keeping three older generations. |

Token values and authorization/cookie headers are redacted from the log. Conversation/request bodies are never written to it (transport request dumps are a separate, explicit opt-in — see [`dump`](#configuration)).

## The `/openai` command

One command, `/openai`, opens one menu in the TUI. Its sections, in order:

| Section | What it does |
| --- | --- |
| Accounts | List accounts; add one (browser or device-code sign-in), disable, enable, move or remove one. Row `main`, the account OpenCode signs in with, is never removed. |
| Quota | Every account's windows and credit budget; **Check now** polls them. |
| Routing | The routing mode and the roster order. |
| Limits | The killswitch and each account's floors. |
| Cache | Prompt-cache keep-warm, subagent warming, sustain and the warm window. |
| Diagnostics | Request dumps and the log level. |
| Reset credits | Preview an account, spend one reset credit after explicit confirmation, or retry the last redemption. |
| This session | The session's sticky pin, and clearing it. |
| Vault | Whether this host is connected to the Claustrum vault, the OpenAI accounts the vault serves it, and the last error. **Connect** asks the vault to enroll this host; **Disconnect** forgets its token. Each vault account can be disabled (it stays listed and is never sent from this host) or enabled again. |

Settings the menu changes are saved through the account pool's store, under the names `routing.mode`, `killswitch.{enabled,accounts}`, `logging.level`, `cacheKeep.*` and `dump.enabled`. The menu needs the account pool: until every OpenCode process on the machine runs a version that understands it and the accounts have moved, `/openai` shows only that notice and the processes still holding the move back.

The eight earlier commands (`/openai-account`, `/openai-quota`, `/openai-routing`, `/openai-killswitch`, `/openai-cachekeep`, `/openai-dump`, `/openai-logging`, `/openai-reset`) are gone; their actions are sections of the menu.

### From a terminal, without a TUI session

Once a credential exists (OpenCode's own or a stored account), `opencode auth login` offers an account menu for this provider:

```text
Add account               add an account (device code when no browser is available)
Re-authenticate           sign an account in again, replacing its credential
Remove account            remove one account (not main)
Enable or disable account
Check quotas              poll every account's quota now
Auth doctor               report problems with the stored credentials, and offer repairs
Connect to the Claustrum vault   serve OpenAI accounts held in the vault
Delete all accounts       remove every account except main
```

This is the path for headless machines, where `/openai` is out of reach. The first login on a new machine goes straight to sign-in as usual. Before the accounts have moved to the account pool, the menu shows only that notice and the doctor.

### The Claustrum vault

The OpenAI accounts held in a [Claustrum](https://github.com/cortexkit/claustrum) vault can serve beside your own accounts, once the accounts have moved to the account pool. Each host enrolls under its own name, `openai-auth-opencode` for OpenCode and `openai-auth-pi` for Pi, so either can be revoked alone. Connect (in `opencode auth login`, or the Vault section of `/openai`) proposes the enrollment and tells you what to run:

```text
Enrollment request <id> for openai-auth-opencode is waiting for approval. Approve it with:
  ck auth enroll approve --request-id <id>
and let it read your OpenAI accounts with:
  ck auth grant --principal enrolled:openai-auth-opencode --selector-kind category --selector openai-native --operation read
```

The token the vault then issues is kept owner-only in `openai-auth-vault/` next to the account state file. The vault accounts route through the same routing modes and limits as your own; each request fetches its token from the vault, and a token the provider rejects is reported back to the vault. An account you also signed in to here is served by the vault only (one account, one owner). While the vault serves accounts, a login written into OpenCode's own `openai` slot is refused rather than served beside them: remove it, or disconnect.

An install that used the vault custody of earlier versions may still hold its tombstones (in accounts, or in OpenCode's slot) and the `claustrum.mode` setting. They are never sent; the auth doctor lists them, with the remedy: connect the vault, or sign in to the account again.

One quirk worth knowing: the menu prints `Failed to authorize` when it returns, even when the action succeeded. The menu writes its own changes and deliberately reports nothing back as a sign-in, because a fallback account must not be filed as the main credential. Check the result with `/openai`.

## Configuration

Settings come from two sources. **Environment variables take precedence over the config file**, and any unset value falls back to the default.

Config file: `~/.config/opencode/openai-auth.json` (the directory follows `OPENCODE_CONFIG_DIR` / `XDG_CONFIG_HOME`; override the full path with `OPENCODE_OPENAI_AUTH_FILE`).

```json
{
  "webSockets": false,
  "rawWebSocket": false,
  "responsesLite": false,
  "dump": false,
  "codexApiEndpoint": "https://chatgpt.com/backend-api/codex/responses"
}
```

| Setting | Config field | Environment variable | Default | Purpose |
| --- | --- | --- | --- | --- |
| WebSocket transport | `webSockets` | `CORTEXKIT_OPENAI_AUTH_WEBSOCKETS` | `false` | Use the Codex Responses WebSocket transport instead of plain HTTP. See [Transports](#transports). |
| Hand-rolled WS client | `rawWebSocket` | `CORTEXKIT_OPENAI_AUTH_RAW_WS` | `false` | When WebSockets are enabled, use the hand-rolled raw TCP/TLS client that surfaces Codex-style incremental streaming. Bun uses `Bun.connect`; Node/OpenCode Desktop uses `node:net`/`node:tls`. |
| Responses Lite | `responsesLite` | `CORTEXKIT_OPENAI_AUTH_RESPONSES_LITE` | `false` | Send `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` requests in Codex's Responses Lite shape — the wire format the Codex CLI itself uses for these models. |
| Request dumps | `dump` | `CORTEXKIT_OPENAI_AUTH_DUMP` | `false` | Write final Codex request bodies and redacted request metadata for cache debugging. Bodies may contain prompt/session content. |
| Dump directory | `dumpDir` | `OPENCODE_OPENAI_AUTH_DUMP_DIR` | OS temp dir: `opencode-openai-auth-dumps` | Destination for `.body.json`, `.meta.json`, and `.request.json` dump files. |
| Codex endpoint | `codexApiEndpoint` | `CORTEXKIT_OPENAI_AUTH_CODEX_ENDPOINT` | `https://chatgpt.com/backend-api/codex/responses` | Send rewritten Codex requests to a compatible proxy/relay instead of ChatGPT's backend endpoint. |

Booleans accept `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off`/empty.

The `webSearch` setting and `CORTEXKIT_OPENAI_AUTH_NO_WEB_SEARCH` have been removed, along with the `web_search` tool the plugin used to add to requests; a config file that still sets `webSearch` loads normally and the key is ignored.

The same `openai-auth.json` file also holds the managed **account store** (accounts, routing, killswitch thresholds, quota cache, log level, and cache-keep state). Those keys are written by `/openai` — change them there rather than by hand. The plugin distinguishes the two: a settings-only file is never overwritten with account data, and account operations preserve your transport settings.

Example — opt into the WebSocket transport via the config file:

```json
{
  "webSockets": true,
  "rawWebSocket": true
}
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
| Hand-rolled WebSocket | `webSockets: true` + `rawWebSocket: true` | Codex-style incremental | A hand-rolled RFC 6455 client. Bun uses `Bun.connect`; Node/OpenCode Desktop uses `node:net`/`node:tls`. Exists only to surface Codex-style incremental streaming (token-by-token rather than batched). |

WebSocket continuation chaining relies on `previous_response_id`, which only resolves on the connection that produced it. A dropped or reconnected socket discards its continuation and starts a fresh chain.

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

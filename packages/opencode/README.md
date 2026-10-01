# @cortexkit/opencode-openai-auth

ChatGPT Plus/Pro OAuth support for [OpenCode](https://opencode.ai).

This OpenCode plugin lets OpenCode talk to the OpenAI Codex backend using a ChatGPT Plus/Pro subscription instead of a pay-as-you-go API key. It rewrites OpenCode's outbound OpenAI requests into Codex's request shape, filters the model list to OAuth-eligible models, and zeroes provider costs for those models.

The plugin registers the built-in `openai` provider id. OpenCode loads external plugins after its built-ins, so this package supersedes OpenCode's internal OpenAI auth hook without any change to your model configuration.

## Install

```json
{
  "plugin": ["@cortexkit/opencode-openai-auth@0.11.0"]
}
```

Restart OpenCode after changing plugin config, then authenticate:

```text
/login openai
```

## OpenCode 2

On OpenCode 2 (`@opencode/cli`, tested on 2.0.21) list the same package under `plugins`; OpenCode 2 loads its `./server` entry. OpenCode 2's own OpenAI driver sends the requests, and the plugin chooses the account from the shared account pool and sets its credential through OpenCode 2's session hooks. Logins (`opencode auth login openai`) go into the pool; OpenCode 2 keeps only a placeholder. The `/openai` menu, the sidebar, keep-warm and OpenCode 1's Codex request shaping are not available there yet. See the [repository README](https://github.com/cortexkit/openai-auth#opencode-2) for the details.

## Features

- ChatGPT Plus/Pro OAuth login (browser and headless device flows), plus a manual API-key fallback.
- Codex request rewriting for OAuth requests, with Codex identity parity.
- OAuth model filtering and zero-cost display.
- Multiple ChatGPT accounts with automatic reactive fallback on rate limits, `main-first`, `fallback-first`, or sticky-balanced routing, and a per-account quota killswitch.
- Per-turn quota tracking (5-hour + weekly windows) on both transports, with a sidebar readout and an explicit all-accounts refresh.
- Idle prompt-cache keep-warm, with an optional subagent mode and main-only sustain mode.
- Leveled, secret-redacting, rotating log file.
- One interactive `/openai` menu in the TUI, including account management and headless device-code authentication.
- Optional OpenAI Responses WebSocket transport (HTTP is the default).

## Commands

One command, `/openai`, opens one menu in the TUI: Accounts (add with browser or device-code sign-in, disable, enable, move, remove), Quota, Routing, Limits (the killswitch and per-account floors), Cache (keep-warm), Diagnostics (request dumps, log level), Reset credits, This session (the sticky pin) and Vault (connect this host to the Claustrum vault, whose OpenAI accounts then serve beside yours; disconnect; disable or enable each vault account). The menu works on the account pool; until the accounts have moved to it, `/openai` shows only that notice and the processes holding the move back. The earlier per-feature commands (`/openai-account`, `/openai-quota`, `/openai-routing`, `/openai-killswitch`, `/openai-cachekeep`, `/openai-dump`, `/openai-logging`, `/openai-reset`) are gone.

On a headless machine, where `/openai` is out of reach, `opencode auth login` offers the account actions — add, re-authenticate, remove, enable or disable, check quotas, the auth doctor, connect to the Claustrum vault (it prints the `ck auth enroll approve` and `ck auth grant` commands to run, and waits for the approval), or delete every account except `main`. It prints `Failed to authorize` on return even when the action succeeded, because the menu writes its own changes and reports none of them as a sign-in; confirm with `/openai`.

## Configuration

Settings resolve as environment variable → config file (`~/.config/opencode/openai-auth.json`) → default.

| Config field | Environment variable | Default | Purpose |
| --- | --- | --- | --- |
| `webSockets` | `CORTEXKIT_OPENAI_AUTH_WEBSOCKETS` | `false` | Use the Codex Responses WebSocket transport instead of HTTP. |
| `rawWebSocket` | `CORTEXKIT_OPENAI_AUTH_RAW_WS` | `false` | Use the hand-rolled raw TCP/TLS client with Codex-style incremental streaming. Bun uses `Bun.connect`; Node/OpenCode Desktop uses `node:net`/`node:tls`. |
| `responsesLite` | `CORTEXKIT_OPENAI_AUTH_RESPONSES_LITE` | `false` | Send `gpt-5.6-sol`/`-terra`/`-luna` requests in Codex's Responses Lite shape, matching the Codex CLI. |
| `dump` | `CORTEXKIT_OPENAI_AUTH_DUMP` | `false` | Dump final Codex request bodies for cache debugging. |
| `dumpDir` | `OPENCODE_OPENAI_AUTH_DUMP_DIR` | OS temp dir: `opencode-openai-auth-dumps` | Directory for request dump files. |
| `codexApiEndpoint` | `CORTEXKIT_OPENAI_AUTH_CODEX_ENDPOINT` | `https://chatgpt.com/backend-api/codex/responses` | Send rewritten Codex requests to a compatible proxy/relay instead of ChatGPT's backend endpoint. |

See the [repository README](https://github.com/cortexkit/openai-auth#readme) for transport differences.

`sticky-balanced` places a cold session by least projected quota pressure, then keeps its SHA-256-keyed sidebar-state pin for up to seven days. It does not rebalance mid-session or use a Retry-After hold; it migrates only after confirmed exhaustion or permanent auth failure. Stale or unknown quota is excluded from weighted placement; when the killswitch is enabled, accounts below their per-account threshold are also excluded from both weighted placement AND the mode-fallback fail-open branch — that branch otherwise orders by `resetCreditsApplicable` first, then configured order, then account id. Subagents have separate pins and reuse them when resumed.

Sustain (the Cache section of `/openai`) defaults off, applies only to main sessions, remains subject to the clock window and memory/LRU caps, and never warms non-active accounts. It costs about two GPT-5.6 warms per hour per session (about 1K output tokens/hour at about 99.4% cache hit); non-5.6 sessions warm about twelve times per hour. Before enabling it for a main-session model, preserve existing entries in `~/.config/cortexkit/magic-context.jsonc` and set that model's `cache_ttl` to `"never"`; Magic Context does not run in subagents. `sustain` means bypass main idle pruning, unlike the sibling anthropic plugin's `always`, which means ignore the clock schedule.

## License

MIT

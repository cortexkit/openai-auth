# @cortexkit/opencode-openai-auth

ChatGPT Plus/Pro OAuth support for [OpenCode](https://opencode.ai).

This OpenCode plugin lets OpenCode talk to the OpenAI Codex backend using a ChatGPT Plus/Pro subscription instead of a pay-as-you-go API key. It rewrites OpenCode's outbound OpenAI requests into Codex's request shape, filters the model list to OAuth-eligible models, zeroes provider costs for those models, and adds a prompt-cache stabilizer.

The plugin registers the built-in `openai` provider id. OpenCode loads external plugins after its built-ins, so this package supersedes OpenCode's internal OpenAI auth hook without any change to your model configuration.

## Install

```json
{
  "plugin": ["@cortexkit/opencode-openai-auth@0.1.0"]
}
```

Restart OpenCode after changing plugin config, then authenticate:

```text
/login openai
```

## Features

- ChatGPT Plus/Pro OAuth login (browser and headless device flows), plus a manual API-key fallback.
- Codex request rewriting for OAuth requests, with Codex identity parity.
- OAuth model filtering and zero-cost display.
- Prompt-cache stabilizer (`web_search`) that keeps tool-continuation requests on the backend's cached path (on by default).
- Multiple ChatGPT accounts with automatic reactive fallback on rate limits, `main-first`, `fallback-first`, or sticky-balanced routing, and a per-account quota killswitch.
- Per-turn quota tracking (5-hour + weekly windows) on both transports, with a sidebar readout and an explicit all-accounts refresh.
- Idle prompt-cache keep-warm, with an optional subagent mode and main-only sustain mode.
- Leveled, secret-redacting, rotating log file.
- Interactive in-TUI control surfaces for every command, plus an `openai-auth` CLI for managing fallback accounts headlessly.
- Optional OpenAI Responses WebSocket transport (HTTP is the default).

## Commands

Each opens an interactive dialog in the TUI and also accepts explicit arguments:

| Command | Arguments | Purpose |
| --- | --- | --- |
| `/openai-quota` | — | Show 5h + weekly quota for all accounts. |
| `/openai-account` | `add [label]` · `remove <id>` · `order <a> <b>` | Manage main + fallback accounts. |
| `/openai-routing` | `main-first` · `fallback-first` · `sticky-balanced` · `reset` | Routing order, sticky balanced session pins, or clear the current pin. |
| `/openai-killswitch` | `on` · `off` · `set <acct>:<5h>,<1w> ...` | Hard-block accounts below quota thresholds. |
| `/openai-cachekeep` | `on` · `off` · `subagents on` · `subagents off` · `sustain on` · `sustain off` | Idle prompt-cache keep-warm; sustain bypasses only main idle pruning. |
| `/openai-logging` | `<level>` | Set log level live. |
| `/openai-dump` | `on` · `off` | Toggle transport request dumps. |

CLI (fallback accounts only; the main account comes from `/login openai`). Run via `npx` — no global install needed:

```text
npx @cortexkit/opencode-openai-auth login [--label <name>] [--headless]
npx @cortexkit/opencode-openai-auth list
npx @cortexkit/opencode-openai-auth remove <id>
```

## Configuration

Settings resolve as environment variable → config file (`~/.config/opencode/openai-auth.json`) → default.

| Config field | Environment variable | Default | Purpose |
| --- | --- | --- | --- |
| `webSearch` | `CORTEXKIT_OPENAI_AUTH_NO_WEB_SEARCH` (set to disable) | `true` | Inject the `web_search` prompt-cache stabilizer. |
| `webSockets` | `CORTEXKIT_OPENAI_AUTH_WEBSOCKETS` | `false` | Use the Codex Responses WebSocket transport instead of HTTP. |
| `rawWebSocket` | `CORTEXKIT_OPENAI_AUTH_RAW_WS` | `false` | Use the hand-rolled raw TCP/TLS client with Codex-style incremental streaming. Bun uses `Bun.connect`; Node/OpenCode Desktop uses `node:net`/`node:tls`. |
| `responsesLite` | `CORTEXKIT_OPENAI_AUTH_RESPONSES_LITE` | `false` | Send `gpt-5.6-sol`/`-terra`/`-luna` requests in Codex's Responses Lite shape, matching the Codex CLI. Bypasses the `web_search` stabilizer for these models. |
| `dump` | `CORTEXKIT_OPENAI_AUTH_DUMP` | `false` | Dump final Codex request bodies for cache debugging. |
| `dumpDir` | `OPENCODE_OPENAI_AUTH_DUMP_DIR` | OS temp dir: `opencode-openai-auth-dumps` | Directory for request dump files. |
| `codexApiEndpoint` | `CORTEXKIT_OPENAI_AUTH_CODEX_ENDPOINT` | `https://chatgpt.com/backend-api/codex/responses` | Send rewritten Codex requests to a compatible proxy/relay instead of ChatGPT's backend endpoint. |

See the [repository README](https://github.com/cortexkit/openai-auth#readme) for transport differences and why `web_search` is needed.

`sticky-balanced` places a cold session by least projected quota pressure, then keeps its SHA-256-keyed sidebar-state pin for up to seven days. It does not rebalance mid-session or use a Retry-After hold; it migrates only after confirmed exhaustion or permanent auth failure. Stale or unknown quota is excluded from weighted placement; when the killswitch is enabled, accounts below their per-account threshold are also excluded from both weighted placement AND the mode-fallback fail-open branch — that branch otherwise orders by `resetCreditsApplicable` first, then configured order, then account id. Subagents have separate pins and reuse them when resumed.

`/openai-cachekeep sustain on|off` defaults off, applies only to main sessions, remains subject to the clock window and memory/LRU caps, and never warms non-active accounts. It costs about two GPT-5.6 warms per hour per session (about 1K output tokens/hour at about 99.4% cache hit); non-5.6 sessions warm about twelve times per hour. Before enabling it for a main-session model, preserve existing entries in `~/.config/cortexkit/magic-context.jsonc` and set that model's `cache_ttl` to `"never"`; Magic Context does not run in subagents. `sustain` means bypass main idle pruning, unlike the sibling anthropic plugin's `always`, which means ignore the clock schedule.

## License

MIT

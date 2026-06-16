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
- Optional OpenAI Responses WebSocket transport (HTTP is the default).

## Configuration

Settings resolve as environment variable → config file (`~/.config/opencode/openai-auth.json`) → default.

| Config field | Environment variable | Default | Purpose |
| --- | --- | --- | --- |
| `webSearch` | `CORTEXKIT_OPENAI_AUTH_NO_WEB_SEARCH` (set to disable) | `true` | Inject the `web_search` prompt-cache stabilizer. |
| `webSockets` | `CORTEXKIT_OPENAI_AUTH_WEBSOCKETS` | `false` | Use the Codex Responses WebSocket transport instead of HTTP. |
| `rawWebSocket` | `CORTEXKIT_OPENAI_AUTH_RAW_WS` | `false` | Use the hand-rolled raw TCP/TLS client with Codex-style incremental streaming. Bun uses `Bun.connect`; Node/OpenCode Desktop uses `node:net`/`node:tls`. |
| `imageGeneration` | `CORTEXKIT_OPENAI_AUTH_IMAGE_GENERATION` | `false` | Declare Codex's native `image_generation` tool. |
| `dump` | `CORTEXKIT_OPENAI_AUTH_DUMP` | `false` | Dump final Codex request bodies for cache debugging. |
| `dumpDir` | `OPENCODE_OPENAI_AUTH_DUMP_DIR` | OS temp dir: `opencode-openai-auth-dumps` | Directory for request dump files. |

See the [repository README](https://github.com/cortexkit/openai-auth#readme) for transport differences and why `web_search` is needed.

## License

MIT

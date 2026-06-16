# CortexKit OpenAI Auth for OpenCode

ChatGPT Plus/Pro OAuth support for [OpenCode](https://opencode.ai), maintained by CortexKit.

This repository extracts OpenCode's built-in OpenAI/Codex OAuth handling into a standalone OpenCode plugin so CortexKit can iterate on Codex HTTP/WebSocket transport behavior independently from OpenCode core.

The plugin intentionally registers the built-in `openai` provider id. OpenCode loads external server plugins after internal plugins, so this package is designed to supersede OpenCode's internal OpenAI auth hook without changing user model configuration.

## Package

| Package | Agent | Purpose |
| --- | --- | --- |
| `@cortexkit/opencode-openai-auth` | OpenCode | OpenCode plugin for ChatGPT Plus/Pro OAuth, Codex request rewriting, model filtering, and OpenAI Responses WebSocket transport. |

## Install

Add the plugin to your OpenCode configuration:

```json
{
  "plugin": ["@cortexkit/opencode-openai-auth"]
}
```

After changing plugin config, restart OpenCode.

## Configuration

Settings come from two sources. **Environment variables take precedence over the config file**, and any unset value falls back to the default.

Config file: `~/.config/opencode/openai-auth.json` (the directory follows `OPENCODE_CONFIG_DIR` / `XDG_CONFIG_HOME`; override the full path with `OPENCODE_OPENAI_AUTH_FILE`).

```json
{
  "webSearch": true,
  "webSockets": false,
  "rawWebSocket": false,
  "imageGeneration": false
}
```

| Setting | Config field | Environment variable | Default | Purpose |
| --- | --- | --- | --- | --- |
| Prompt-cache fix | `webSearch` | `CORTEXKIT_OPENAI_AUTH_NO_WEB_SEARCH` (set to disable) | `true` | Injects a native `web_search` tool so Codex keeps tool-continuation requests on the stable prompt cache. The model does not invoke it on coding tasks; turning it off reintroduces intermittent cache "cliffs" (cached tokens dropping to 0 mid-turn). |
| WebSocket transport | `webSockets` | `CORTEXKIT_OPENAI_AUTH_WEBSOCKETS` | `false` | Use the Codex Responses WebSocket transport instead of plain HTTP. |
| Hand-rolled WS client | `rawWebSocket` | `CORTEXKIT_OPENAI_AUTH_RAW_WS` | `false` | When WebSockets are enabled, use a hand-rolled `Bun.connect` client that surfaces Codex-style incremental streaming. |
| Image generation | `imageGeneration` | `CORTEXKIT_OPENAI_AUTH_IMAGE_GENERATION` | `false` | Declare Codex's native `image_generation` tool. |

Booleans accept `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off`/empty.

## Transport

The plugin includes the OpenAI Responses WebSocket transport and request handling needed for stable Codex sessions. HTTP is the default; enable WebSockets with `webSockets`, and the hand-rolled streaming client with `rawWebSocket`.

## Development

```sh
bun run typecheck
bun run build
```

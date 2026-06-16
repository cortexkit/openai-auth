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

## Transport

The plugin includes the OpenAI Responses WebSocket transport and request handling needed for stable Codex sessions.

## Development

```sh
bun run typecheck
bun run build
```

# CortexKit OpenCode OpenAI Auth

Standalone OpenCode plugin extracted from OpenCode's built-in OpenAI/Codex auth handling.

## Features

- ChatGPT Plus/Pro OAuth login for provider `openai`.
- Codex endpoint request rewriting for OAuth requests.
- OpenAI OAuth model filtering and zero-cost display.
- OpenAI Responses WebSocket transport and Codex request handling.

The plugin registers provider `openai`, matching OpenCode's built-in OpenAI auth hook. OpenCode loads external plugins after built-ins, so this package is intended to override the built-in hook while preserving the same provider id and request behavior.

WebSocket transport is enabled by the plugin.

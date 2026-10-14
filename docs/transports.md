# Transports

These settings apply to OpenCode 1. On [OpenCode 2](opencode-2.md), OpenCode 2's own OpenAI driver sends the requests over HTTP or its own WebSocket.

The plugin reaches the Codex backend over plain HTTP or over the OpenAI Responses WebSocket. The transport choice does not affect prompt-cache behavior or quota tracking (both transports report quota per turn); it only affects connection style and streaming.

| Transport | Enable with | Streaming | Notes |
| --- | --- | --- | --- |
| HTTP (default) | — | Server-sent events | Simplest and the default. One request and response per turn step. |
| Native WebSocket | `webSockets: true` | Coarse | Uses the runtime's native WebSocket with a session-keyed connection pool and `previous_response_id` continuation chaining. Native clients can batch frames, so streaming is coarser than Codex's raw client. |
| Hand-rolled WebSocket | `webSockets: true` + `rawWebSocket: true` | Codex-style incremental | A hand-rolled RFC 6455 client. Bun uses `Bun.connect`; Node and OpenCode Desktop use `node:net`/`node:tls`. It exists only to surface Codex-style incremental streaming (token by token rather than batched). |

The settings and their environment variables are listed in [Configuration](configuration.md#settings).

WebSocket continuation chaining relies on `previous_response_id`, which only resolves on the connection that produced it. A dropped or reconnected socket discards its continuation and starts a fresh chain.

## HTTP fallback

With the WebSocket transport on, some requests still go over HTTP:

- requests without a `session-id` or `x-session-affinity` header, and title requests;
- a request whose session socket is busy, or whose session is already in fallback mode;
- after WebSocket stream or setup failures have been retried up to 5 times, the session uses HTTP until its pool entry is idle-pruned;
- a `websocket_connection_limit_reached` error switches that session to HTTP at once.

A WebSocket that fails after its first event fails as retryable, rather than replaying partial output. Socket lifetimes and the full flow are described in [`packages/opencode/src/WEBSOCKET.md`](../packages/opencode/src/WEBSOCKET.md).

# OpenAI Responses WebSocket

Enabled by the CortexKit OpenAI Auth plugin.

## Flow

1. A streamed `POST /responses` request arrives.
2. If it has no `session-id` or `x-session-affinity` header, use HTTP.
3. Title requests use HTTP.
4. If that session's socket is busy or already in fallback mode, use HTTP.
5. Otherwise, reuse its open socket or open a new one.
6. Prewarm fresh user turns with `generate: false`.
7. Send `response.create` with `previous_response_id` when a valid same-socket continuation exists.
8. Return WebSocket events as SSE.

## Lifetime

- Connect timeout: 15 seconds.
- Idle timeout: 5 minutes.
- After a completed response, keep the socket for reuse.
- Reuse a socket for up to 55 minutes, then replace it on the next request.

## Retries

- Retry WebSocket stream/setup failures up to 5 times, then use HTTP for that session until the pool entry is idle-pruned.
- `websocket_connection_limit_reached` switches that session to HTTP fallback immediately.
- If a WebSocket fails after its first event, fail it as retryable rather than replaying partial output in transport.
- Abort or cancel closes the socket.

## Next Steps

- Optional second WebSocket for concurrent requests in one session. Currently these use HTTP.

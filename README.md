# CortexKit OpenAI Auth for OpenCode

ChatGPT Plus/Pro OAuth support for [OpenCode](https://opencode.ai), maintained by CortexKit.

This plugin lets OpenCode talk to the OpenAI **Codex** backend (`https://chatgpt.com/backend-api/codex/responses`) using a ChatGPT Plus/Pro subscription instead of a pay-as-you-go API key. It rewrites OpenCode's outbound OpenAI requests into Codex's request shape, filters the model list to OAuth-eligible models, zeroes provider costs for those models, and adds a prompt-cache stabilizer that keeps tool-continuation requests on the backend's cached path.

The plugin intentionally registers the built-in `openai` provider id. OpenCode loads external server plugins after its internal ones, so this package supersedes OpenCode's internal OpenAI auth hook without any change to your model configuration.

## Package

| Package | Agent | Purpose |
| --- | --- | --- |
| `@cortexkit/opencode-openai-auth` | OpenCode | ChatGPT Plus/Pro OAuth, Codex request rewriting, model filtering, prompt-cache stabilizer, and an optional OpenAI Responses WebSocket transport. |

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

OAuth tokens are stored and refreshed by OpenCode's own auth store.

## Configuration

Settings come from two sources. **Environment variables take precedence over the config file**, and any unset value falls back to the default.

Config file: `~/.config/opencode/openai-auth.json` (the directory follows `OPENCODE_CONFIG_DIR` / `XDG_CONFIG_HOME`; override the full path with `OPENCODE_OPENAI_AUTH_FILE`).

```json
{
  "webSearch": true,
  "webSockets": false,
  "rawWebSocket": false,
  "dump": false
}
```

| Setting | Config field | Environment variable | Default | Purpose |
| --- | --- | --- | --- | --- |
| Prompt-cache fix | `webSearch` | `CORTEXKIT_OPENAI_AUTH_NO_WEB_SEARCH` (set to disable) | `true` | Appends a native `web_search` tool to the wire request so Codex keeps tool-continuation requests on the stable prompt cache. See [Why `web_search`](#why-web_search). |
| WebSocket transport | `webSockets` | `CORTEXKIT_OPENAI_AUTH_WEBSOCKETS` | `false` | Use the Codex Responses WebSocket transport instead of plain HTTP. See [Transports](#transports). |
| Hand-rolled WS client | `rawWebSocket` | `CORTEXKIT_OPENAI_AUTH_RAW_WS` | `false` | When WebSockets are enabled, use the hand-rolled raw TCP/TLS client that surfaces Codex-style incremental streaming. Bun uses `Bun.connect`; Node/OpenCode Desktop uses `node:net`/`node:tls`. |
| Request dumps | `dump` | `CORTEXKIT_OPENAI_AUTH_DUMP` | `false` | Write final Codex request bodies and redacted request metadata for cache debugging. Bodies may contain prompt/session content. |
| Dump directory | `dumpDir` | `OPENCODE_OPENAI_AUTH_DUMP_DIR` | OS temp dir: `opencode-openai-auth-dumps` | Destination for `.body.json`, `.meta.json`, and `.request.json` dump files. |

Booleans accept `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off`/empty. The `webSearch` negative env var (`CORTEXKIT_OPENAI_AUTH_NO_WEB_SEARCH`), when set to a truthy value, disables the cache fix and always wins over the config file.

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

The plugin can reach the Codex backend over plain HTTP or over the OpenAI Responses WebSocket. The transport choice does **not** affect prompt-cache behavior (the cache fix applies to all three); it only affects connection style and streaming.

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

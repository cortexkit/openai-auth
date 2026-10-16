# Configuration

## What the OpenCode plugin does

The OpenCode plugin, `@cortexkit/opencode-openai-auth`, sends OpenCode's OpenAI requests to the Codex backend (`https://chatgpt.com/backend-api/codex/responses`) with a ChatGPT Plus or Pro login. It rewrites OpenCode's outbound OpenAI requests into Codex's request shape, filters the model list to the models a ChatGPT login can use, and zeroes provider costs for those models.

The plugin intentionally registers the built-in `openai` provider id. OpenCode loads external server plugins after its internal ones, so this package supersedes OpenCode's internal OpenAI auth hook without any change to your model configuration.

| Package | Host | Purpose |
| --- | --- | --- |
| `@cortexkit/opencode-openai-auth` | OpenCode 1 and 2 | ChatGPT Plus/Pro OAuth, Codex request rewriting, model filtering, multiple accounts, quota tracking, cache keep-warm, and an optional OpenAI Responses WebSocket transport. |
| `@cortexkit/pi-openai-auth` | Pi | Overrides Pi's built-in `openai-codex` provider with a CortexKit provider backed by Pi's OpenAI Codex Responses transport and OAuth primitives, adding multiple accounts, routing, quota limits and the vault. |

## Settings

The settings below apply to the OpenCode plugin. They come from two sources: **environment variables take precedence over the config file**, and any unset value falls back to the default.

Config file: `~/.config/opencode/openai-auth.json`. The directory follows `OPENCODE_CONFIG_DIR`, then `XDG_CONFIG_HOME`; `OPENCODE_OPENAI_AUTH_FILE` overrides the full path. A missing, unreadable or malformed config file falls back to the environment and the defaults.

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
| WebSocket transport | `webSockets` | `CORTEXKIT_OPENAI_AUTH_WEBSOCKETS` | `false` | Use the Codex Responses WebSocket transport instead of plain HTTP. See [Transports](transports.md). |
| Hand-rolled WebSocket client | `rawWebSocket` | `CORTEXKIT_OPENAI_AUTH_RAW_WS` | `false` | When WebSockets are enabled, use the hand-rolled raw TCP/TLS client that surfaces Codex-style incremental streaming. Bun uses `Bun.connect`; Node and OpenCode Desktop use `node:net`/`node:tls`. |
| Responses Lite | `responsesLite` | `CORTEXKIT_OPENAI_AUTH_RESPONSES_LITE` | `false` | Send requests for the models Codex marks for Responses Lite (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna` and `gpt-6.1-sol`) in Codex's Responses Lite shape, the wire format the Codex CLI itself uses for these models. |
| Request dumps | `dump` | `CORTEXKIT_OPENAI_AUTH_DUMP` | `false` | Write final Codex request bodies and redacted request metadata for cache debugging. Bodies may contain prompt and session content. The config field also accepts `{ "enabled": true }`, the form the plugin's [`/openai` slash-command menu](commands.md#the-openai-command) saves. See [Troubleshooting](troubleshooting.md#request-dumps). |
| Dump directory | `dumpDir` | `OPENCODE_OPENAI_AUTH_DUMP_DIR` | OS temp dir: `opencode-openai-auth-dumps` | Destination for `.body.json`, `.meta.json` and `.request.json` dump files. |
| Codex endpoint | `codexApiEndpoint` | `CORTEXKIT_OPENAI_AUTH_CODEX_ENDPOINT` | `https://chatgpt.com/backend-api/codex/responses` | Send rewritten Codex requests to a compatible proxy or relay instead of ChatGPT's backend endpoint. |

Booleans accept `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off`/empty, in any case. Any other value is ignored, and the config file or the default decides.

The `webSearch` setting and `CORTEXKIT_OPENAI_AUTH_NO_WEB_SEARCH` have been removed, along with the `web_search` tool the plugin used to add to requests; a config file that still sets `webSearch` loads normally and the key is ignored.

### Other environment variables

| Environment variable | Purpose |
| --- | --- |
| `OPENCODE_OPENAI_AUTH_FILE` | Full path of the config file, which also holds the account store. |
| `OPENCODE_OPENAI_AUTH_STATE_FILE` | Full path of the account state file. By default it is `openai-auth-state.json` next to the config file (or `<config file>.state.json` when the config file has another name). It must not be the config file itself. |
| `OPENCODE_CONFIG_DIR`, `XDG_CONFIG_HOME` | Where the config directory is, as for OpenCode itself. |
| `OPENCODE_OPENAI_AUTH_LOG_LEVEL`, `OPENCODE_OPENAI_AUTH_LOG_FILE` | Log level and log file; see [Troubleshooting](troubleshooting.md#logging). |
| `OPENCODE_AUTH_CONTENT` | OpenCode's own variable for supplying its login; how the plugin treats it is described in [Accounts and routing](accounts-and-routing.md#the-account-pool). |

### Examples

Opt into the WebSocket transport with the config file:

```json
{
  "webSockets": true,
  "rawWebSocket": true
}
```

Route Codex traffic through a local Codex-compatible proxy:

```sh
CORTEXKIT_OPENAI_AUTH_CODEX_ENDPOINT=http://127.0.0.1:8899/v1/responses opencode
```

## The account store

The account store combines `openai-auth.json` with its companion state file (`openai-auth-state.json` by default; see `OPENCODE_OPENAI_AUTH_STATE_FILE` above). Together they hold accounts, routing, [killswitch quota floors](accounts-and-routing.md#killswitch), quota cache, log level and cache keep-warm state. Change these through `/openai` rather than by hand: account operations preserve transport settings, and a settings-only file is never overwritten with account data. See [Accounts and routing](accounts-and-routing.md#the-account-pool).

## Pi

The settings above are the OpenCode plugin's; the Pi extension does not read them. Its account store is `openai-auth.json` in Pi's agent directory (`~/.pi/agent` unless `PI_AGENT_DIR` says otherwise); `PI_OPENAI_AUTH_FILE` overrides the store's path and `PI_OPENAI_AUTH_STATE_FILE` the state file's path.

The Pi provider catalog includes `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini` and `gpt-5.3-codex-spark`.

## Manual install

Use `npx @cortexkit/opencode-openai-auth setup` for the guided install. The steps below are the manual fallback.

### OpenCode 1

Add the plugin to your OpenCode configuration (`~/.config/opencode/opencode.json`):

```json
{
  "plugin": ["@cortexkit/opencode-openai-auth"]
}
```

Pinning is strongly recommended for any OpenCode plugin:

```json
{
  "plugin": ["@cortexkit/opencode-openai-auth@1.0.4"]
}
```

After changing plugin config, restart OpenCode. If OpenCode keeps using an old build, clear its plugin cache (see [Troubleshooting](troubleshooting.md#opencode-keeps-using-an-old-build)).

For OpenCode 2, see [OpenCode 2](opencode-2.md#manual-install).

### Signing in on OpenCode 1

Log in with OpenCode's normal auth command and pick the `openai` provider:

```text
/login openai
```

The local login methods are:

- **ChatGPT Pro/Plus (browser)**: opens the OpenAI authorization page and completes the login through a local callback. Use this on a machine with a browser.
- **ChatGPT Pro/Plus (headless)**: device-code flow for remote or headless machines. You are shown a code to enter at the OpenAI device page from any browser.
- **Manually enter API Key**: falls back to a standard pay-as-you-go OpenAI API key (no OAuth, normal billing).

After the vault owner approves OpenCode's [enrollment request](vault.md#connecting-a-host), OpenCode also offers **ChatGPT accounts in the vault**; see [vault activation](vault.md#activating-an-enrolled-opencode-host).

The account you sign in to with a local ChatGPT method is your **main** account. It is held in OpenCode's own auth store until it moves into the shared [account pool](accounts-and-routing.md#the-account-pool). Additional **fallback** accounts are managed separately (see [Multiple accounts](accounts-and-routing.md#multiple-accounts)).

### Installing on Pi

Requires Pi 1.0.1 or newer. Install with Pi's package manager:

```bash
pi install npm:@cortexkit/pi-openai-auth@1.0.4
```

For an unpinned install:

```bash
pi install npm:@cortexkit/pi-openai-auth
```

To try the Pi extension for one run without changing Pi settings:

```bash
pi -e npm:@cortexkit/pi-openai-auth
```

Restart Pi after installing, then authenticate through Pi's normal login flow:

```text
/login openai-codex
```

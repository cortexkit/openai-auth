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
| Responses Lite | `responsesLite` | `CORTEXKIT_OPENAI_AUTH_RESPONSES_LITE` | `false` | Send requests for the models Codex marks for Responses Lite (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-6.1-sol` and `gpt-6.1-terra`) in Codex's Responses Lite shape, the wire format the Codex CLI itself uses for these models. |
| Request dumps | `dump` | `CORTEXKIT_OPENAI_AUTH_DUMP` | `false` | Write final Codex request bodies and redacted request metadata for cache debugging. Bodies may contain prompt and session content. The config field also accepts `{ "enabled": true }`, the form the plugin's [`/openai` slash-command menu](commands.md#the-openai-command) saves. See [Troubleshooting](troubleshooting.md#request-dumps). |
| Dump directory | `dumpDir` | `OPENCODE_OPENAI_AUTH_DUMP_DIR` | OS temp dir: `opencode-openai-auth-dumps` | Destination for `.body.json`, `.meta.json` and `.request.json` dump files. |
| Dump retention cap | `dumpMaxBytes` | `OPENCODE_OPENAI_AUTH_DUMP_MAX_BYTES` | `536870912` (512 MiB) | Retain this many dump-artifact bytes, evicting whole dumps oldest first. `0` disables the cap. Applies to both OpenCode 1 and 2. |
| Codex endpoint | `codexApiEndpoint` | `CORTEXKIT_OPENAI_AUTH_CODEX_ENDPOINT` | `https://chatgpt.com/backend-api/codex/responses` | Send rewritten Codex requests to a compatible proxy or relay instead of ChatGPT's backend endpoint. |

On both OpenCode versions, `gpt-6.1-terra` inherits missing reasoning variants from the host's `gpt-6.1-sol` model. This makes variants such as `xhigh` available even when the host's Terra catalog entry is incomplete; Terra's existing variant definitions and custom overrides take precedence.

Booleans accept `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off`/empty, in any case. Any other value is ignored, and the config file or the default decides.

`dumpMaxBytes` accepts a nonnegative safe integer in bytes (a JSON number in the config file). An invalid value, including an empty environment variable, negative number, fraction, or unit suffix such as `512MiB`, falls back to 512 MiB and logs one warning per process. An explicitly set environment variable takes precedence even when invalid. `0` means **unlimited**, not zero retained bytes; use it only if you manage cleanup yourself.

Both OpenCode versions use the same directory and retention settings. The default directory is `opencode-openai-auth-dumps` inside Node's OS temporary directory:

| OS | Default dump directory |
| --- | --- |
| Linux | `/tmp/opencode-openai-auth-dumps` |
| macOS | `$TMPDIR/opencode-openai-auth-dumps`, normally `/var/folders/<user-specific directories>/T/opencode-openai-auth-dumps` |
| Windows | `%TEMP%\opencode-openai-auth-dumps`, normally `%USERPROFILE%\AppData\Local\Temp\opencode-openai-auth-dumps` |

OS temporary-directory environment overrides can change these locations; `dumpDir` / `OPENCODE_OPENAI_AUTH_DUMP_DIR` selects an explicit destination on every OS. Retention is best-effort background cleanup after successful writes, at most once every five minutes. Dumps younger than one minute and the just-written dump are protected, so usage can exceed the cap (including for a single oversized request). Another eligible successful write must trigger a sweep to reclaim excess bytes; while idle, the excess can persist. Only recognized dump artifacts are evicted; unrelated files and symlinks are left alone. The Diagnostics section of `/openai` shows a read-only size snapshot and the cap while dumps are on. It counts top-level regular files without reading their contents or traversing subdirectories, only when the menu is built, not on requests.

The `webSearch` setting and `CORTEXKIT_OPENAI_AUTH_NO_WEB_SEARCH` have been removed, along with the `web_search` tool the plugin used to add to requests; a config file that still sets `webSearch` loads normally and the key is ignored.

### Other environment variables

| Environment variable | Purpose |
| --- | --- |
| `OPENCODE_OPENAI_AUTH_FILE` | Full path of the config file, which also holds the account store. |
| `OPENCODE_OPENAI_AUTH_STATE_FILE` | Full path of the account state file. The vault folder `openai-auth-vault/` sits next to it. By default the state file is `openai-auth-state.json` in the plugin's state folder (see [Where the files live](#where-the-files-live)). When `OPENCODE_OPENAI_AUTH_FILE` names a custom config file, the default is `<config file>.state.json` next to it, or `openai-auth-state.json` when the custom file is named `openai-auth.json`. The plugin never moves a state file you name here. It must not be the config file itself. |
| `OPENCODE_CONFIG_DIR`, `XDG_CONFIG_HOME` | Where the config directory is, as for OpenCode itself. |
| `XDG_STATE_HOME` | Base of the plugin's state folder; `~/.local/state` when unset. |
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

## Where the files live

The settings file `openai-auth.json` stays in OpenCode's config folder, where you edit it. The files the plugin rewrites while it runs are kept in its state folder, out of OpenCode's config folder, because OpenCode 2 watches that folder for changes. Those files are:

- the account state file `openai-auth-state.json`, which holds the OAuth tokens;
- the vault folder `openai-auth-vault/`, which holds the enrollment token, the enrollment state and the vault roster;
- the Codex sessions files `openai-auth-sessions.json` (OpenCode 1) and `openai-auth-sessions-opencode2.json` (OpenCode 2);
- the lock folders and temporary files of each of these.

The state folder is `cortexkit/openai-auth` under `XDG_STATE_HOME`, or under `.local/state` in your home folder when `XDG_STATE_HOME` is unset. That is the same rule on every OS, and the same folder that already holds `sidebar-state.json`:

| OS | Default state folder |
| --- | --- |
| Linux | `~/.local/state/cortexkit/openai-auth/` |
| macOS | `~/.local/state/cortexkit/openai-auth/`, that is `/Users/<you>/.local/state/cortexkit/openai-auth/` |
| Windows | `%USERPROFILE%\.local\state\cortexkit\openai-auth\` |

The plugin creates these folders and files owner-only: mode `0700` for folders and `0600` for files on Linux and macOS, and an access list that grants only your user on Windows.

When `OPENCODE_CONFIG_DIR` names a folder other than OpenCode's default one (`opencode` in `XDG_CONFIG_HOME`, else in `~/.config`), the files go in a subfolder of the state folder named after that config folder, `config-<16 hex characters>`, so two config folders never share a file. A `config-dir.json` file in the subfolder names the config folder it belongs to.

`OPENCODE_OPENAI_AUTH_STATE_FILE`, and a custom config file named by `OPENCODE_OPENAI_AUTH_FILE`, keep the state file and its vault folder where they say (see the table above). The sessions files still go in the state folder.

### The move from OpenCode's config folder

Versions before this one kept these files in OpenCode's config folder. At its first start, the plugin copies them into the state folder, checks every copy byte for byte, records the move in `layout.json` in the state folder, and then removes the old files. Vault enrollment comes along unchanged.

The move waits while any other OpenCode process that uses the same config folder could still write the old files, because a sign-in token written to the old folder after the move would be lost. Such a process is one running an older version of the plugin, or one that started while such a process was running. While the move waits, the plugin keeps using the old files and logs once: "openai-auth keeps its files in OpenCode's config folder until every running OpenCode using it has restarted on this version." **The move happens at the first start after every OpenCode using that config folder has been closed or restarted on this version.**

If the move fails, for example because the disk is full, the plugin keeps using the old files, logs the error once, and tries again at the next start. Once the move is done, the plugin never reads or deletes files in the old location. If some appear there again, for example because an older version ran, it logs a warning naming the folder and leaves them alone.

### Downgrading

A version from before the move looks only in OpenCode's config folder, so after the move it finds no accounts and no vault enrollment. Nothing is lost. To go back to an older version, do one of these:

- move `openai-auth-state.json`, `openai-auth-vault/` and the sessions files from the state folder back into OpenCode's config folder, and delete `layout.json` from the state folder so a later upgrade moves them again;
- or set `OPENCODE_OPENAI_AUTH_STATE_FILE` to the state file in the state folder, for example `~/.local/state/cortexkit/openai-auth/openai-auth-state.json`. The older version then reads the state file and the vault folder from there.

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
  "plugin": ["@cortexkit/opencode-openai-auth@1.7.0"]
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
pi install npm:@cortexkit/pi-openai-auth@1.7.0
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

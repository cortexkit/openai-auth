# Configuration

## What the OpenCode plugin does

The OpenCode plugin, `@cortexkit/opencode-openai-auth`, sends OpenCode's OpenAI requests to the Codex backend (`https://chatgpt.com/backend-api/codex/responses`) with a ChatGPT Plus or Pro login. It rewrites OpenCode's outbound OpenAI requests into Codex's request shape, filters the model list to the models a ChatGPT login can use, and zeroes provider costs for those models.

The plugin intentionally registers the built-in `openai` provider id. OpenCode loads external server plugins after its internal ones, so this package supersedes OpenCode's internal OpenAI auth hook without any change to your model configuration.

| Package | Host | Purpose |
| --- | --- | --- |
| `@cortexkit/opencode-openai-auth` | OpenCode 1 and 2 | ChatGPT Plus/Pro OAuth, Codex request rewriting, model filtering, multiple accounts, quota tracking, cache keep-warm, and an optional OpenAI Responses WebSocket transport. |
| `@cortexkit/pi-openai-auth` | Pi | Overrides Pi's built-in `openai-codex` provider with a CortexKit provider backed by Pi's OpenAI Codex Responses transport and OAuth primitives, adding multiple accounts, routing, quota limits and the vault. |

## Settings

OpenCode 1, OpenCode 2 and Pi share preferences in `openai-auth.jsonc`, separate from their account stores. The file accepts JSON with comments and uses readable `snake_case` setting names. Settings are user-only; a project's `.cortexkit` folder cannot override them. Each host reads only the settings it supports.

| OS | Default shared settings file |
| --- | --- |
| Linux | `~/.config/cortexkit/openai-auth.jsonc` |
| macOS | `~/.config/cortexkit/openai-auth.jsonc`, not `~/Library` |
| Windows | `%APPDATA%\cortexkit\openai-auth.jsonc`, falling back to `%USERPROFILE%\AppData\Roaming\cortexkit\openai-auth.jsonc` |

An absolute `XDG_CONFIG_HOME` overrides the base on every OS: `<XDG_CONFIG_HOME>/cortexkit/openai-auth.jsonc`. Empty or relative values do not choose the shared settings folder.

| Environment variable | Purpose |
| --- | --- |
| `OPENCODE_OPENAI_AUTH_SETTINGS_FILE` | Opt OpenCode 1 or 2 into an explicit shared settings file. |
| `PI_OPENAI_AUTH_SETTINGS_FILE` | Opt Pi into an explicit shared settings file. Pi does not read `OPENCODE_` variables. |

Only an absolute path counts for either variable; an empty or relative value is ignored. An absolute override wins over the separate-install rule below, but is ignored with a warning if it names this install's config or state file, or either host's default config or state file. An account store cannot double as the settings file.

### Separate installs

Without an explicit settings-file opt-in, an install is **separate** when its resolved config file is a different file from that host's default `openai-auth.json`. OpenCode's default is `<XDG_CONFIG_HOME>/opencode/openai-auth.json` when `XDG_CONFIG_HOME` is absolute, otherwise `~/.config/opencode/openai-auth.json`, on every OS. Pi's default is `~/.pi/agent/openai-auth.json`; its resolved file is checked after Pi's agent-folder fallback described [below](#pi). Identity follows real paths, including links; a file not yet created is compared through its nearest existing parent.

A state-file override alone does not make an install separate, and neither does an override naming the default config file. A genuinely different config file selected by `OPENCODE_CONFIG_DIR`, `OPENCODE_OPENAI_AUTH_FILE`, `PI_CODING_AGENT_DIR` or `PI_OPENAI_AUTH_FILE` does. A separate install never reads the shared settings file: it keeps reading and writing preferences in its old account store, and its menus keep saving there.

### The one-time settings move

At startup, a default install moves preferences from both hosts' default config files, OpenCode's first and Pi's second. It leaves the source stores unchanged, including their credentials and state. Preferences that differ between the two hosts are preserved as host-specific values; per-account floors retain their host tags. An explicit settings-file opt-in moves only that host's own non-default config file. An opt-in on the default config file moves nothing and reads the selected settings file, or defaults if it is missing.

The move leaves a best-effort `<source>.MOVED_READPLEASE` note beside each old store, for example `openai-auth.json.MOVED_READPLEASE`. It names the target in `Settings moved to <target>.` and warns that a rollback loses changes made after the move. An older package still reads its old store, not the shared file. **Upgrade both packages together, before creating the settings file by hand, then close every OpenCode and Pi process and start them again.** An existing target counts as a completed move, however it was created; old preferences are not imported over it.

The move waits for processes that could still write preferences in an old store. A process whose move is blocked or fails keeps reading and writing its old store for its whole life and retries only at the next start. Restarting processes one at a time can therefore keep the move waiting. Diagnostics explains whether settings are shared, separate, or still in the old store.

If a process cannot take the lock coordinating the settings move or record that it uses the old store, and no move is complete and a source is present, the plugin refuses to start rather than write preferences invisibly to other processes. The error names the folder and cause: the records folder is `<XDG_STATE_HOME>/cortexkit/openai-auth`, or `~/.local/state/cortexkit/openai-auth` when unset. Fix the named folder or lock problem and restart. OpenCode registers no plugin hooks or menu on this refusal; Pi registers no provider, but keeps a read-only `/openai` Diagnostics view of the refusal.

This coordination of running processes has limits, even with the restart step above:

- A process under a different `XDG_STATE_HOME` against the same store is invisible, as is a Pi release that wrote no process record. Close those processes too before restarting on the upgraded packages.
- An older package that is installed but not running is invisible. If it runs after the other host has moved, it still edits its old store; those edits are not imported when it is upgraded later, because the shared file already exists.
- Two environments can classify one config file differently. A process with `OPENCODE_CONFIG_DIR` pointing at a non-default folder is separate, while another process whose `XDG_CONFIG_HOME` makes that same folder the default can move from it. After the move, the separate process and the default-install process stop sharing preferences: edits in either no longer reach the other.

Other limits to keep in mind:

- Two processes editing per-account floors in the same instant can lose one edit, because the floors list is replaced as a whole.
- A floor stored above 100 moves as `100`. This changes admission only for a fully unused window. A stored negative floor moves as `0`, so it no longer enlarges the sticky router's spendable share.
- Removing the shared file normally gives declared defaults without importing the old stores again, because a note names the target. A move that left no note naming its target, either because every note failed or because a source kept an older note for another target, can run again after the shared file is removed. A menu edit can create the shared file again.

A host with no config file of its own, such as a vault-only Pi, reads the shared values after the move too, including the old store's `routing.mode` and `killswitch.enabled` preferences (now `routing_mode` and `killswitch_enabled`). For example, an OpenCode store using `sticky-balanced` with the killswitch on makes that Pi use both values instead of its previous defaults. It does not gain the other host's local per-account floors or single-store vault floor entries.

If the settings file cannot be read or parsed **at start**, **the killswitch is on with the default floors (5% primary, 10% secondary) until the file is fixed**. Diagnostics names the file and its problems. An unreadable or unparseable file during a running process keeps its last-good snapshot. After a successful move, an omitted setting uses its declared default, never the old store's saved value.

### OpenCode transport and diagnostics settings

The settings below apply to OpenCode. Transport and dump environment variables take precedence over the resolved file values; unset values use the defaults. The shared file uses the names below; the legacy config fields apply only to separate installs or processes still using an old store. That legacy config file is `~/.config/opencode/openai-auth.json`; its directory follows `OPENCODE_CONFIG_DIR`, then `XDG_CONFIG_HOME`, and `OPENCODE_OPENAI_AUTH_FILE` overrides the full path.

```jsonc
{
  "schema_version": 1,
  "web_sockets": false,
  "raw_web_socket": false,
  "responses_lite": false,
  "request_dumps": false,
  "codex_api_endpoint": "https://chatgpt.com/backend-api/codex/responses"
}
```

| Setting | Shared setting | Legacy config field | Environment variable | Default | Purpose |
| --- | --- | --- | --- | --- | --- |
| WebSocket transport | `web_sockets` | `webSockets` | `CORTEXKIT_OPENAI_AUTH_WEBSOCKETS` | `false` | Use the Codex Responses WebSocket transport instead of plain HTTP. See [Transports](transports.md). |
| Hand-rolled WebSocket client | `raw_web_socket` | `rawWebSocket` | `CORTEXKIT_OPENAI_AUTH_RAW_WS` | `false` | When WebSockets are enabled, use the hand-rolled raw TCP/TLS client that surfaces Codex-style incremental streaming. Bun uses `Bun.connect`; Node and OpenCode Desktop use `node:net`/`node:tls`. |
| Responses Lite | `responses_lite` | `responsesLite` | `CORTEXKIT_OPENAI_AUTH_RESPONSES_LITE` | `false` | Send requests for the models Codex marks for Responses Lite (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-6.1-sol` and `gpt-6.1-terra`) in Codex's Responses Lite shape, the wire format the Codex CLI itself uses for these models. |
| Request dumps | `request_dumps` | `dump` | `CORTEXKIT_OPENAI_AUTH_DUMP` | `false` | Write final Codex request bodies and redacted request metadata for cache debugging. Bodies may contain prompt and session content. The legacy field also accepts `{ "enabled": true }`, the form the old-store [`/openai` slash-command menu](commands.md#the-openai-command) saves. See [Troubleshooting](troubleshooting.md#request-dumps). |
| Dump directory | `dump_dir` | `dumpDir` | `OPENCODE_OPENAI_AUTH_DUMP_DIR` | `""` (OS temp dir: `opencode-openai-auth-dumps`) | Destination for `.body.json`, `.meta.json` and `.request.json` dump files. |
| Dump retention cap | `dump_max_bytes` | `dumpMaxBytes` | `OPENCODE_OPENAI_AUTH_DUMP_MAX_BYTES` | `536870912` (512 MiB) | Retain this many dump-artifact bytes, evicting whole dumps oldest first. `0` disables the cap. Applies to both OpenCode 1 and 2. |
| Codex endpoint | `codex_api_endpoint` | `codexApiEndpoint` | `CORTEXKIT_OPENAI_AUTH_CODEX_ENDPOINT` | `https://chatgpt.com/backend-api/codex/responses` | Send rewritten Codex requests to a compatible proxy or relay instead of ChatGPT's backend endpoint. |

On both OpenCode versions, `gpt-6.1-terra` inherits missing reasoning variants from the host's `gpt-6.1-sol` model. This makes variants such as `xhigh` available even when the host's Terra catalog entry is incomplete; Terra's existing variant definitions and custom overrides take precedence.

Boolean environment variables accept `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off`/empty, in any case. Any other value is ignored, and the resolved file value or the default decides. In the shared file, use JSON booleans `true` or `false`.

`dump_max_bytes` (legacy `dumpMaxBytes`) accepts a nonnegative safe integer in bytes (a JSON number in the file). An invalid value, including an empty environment variable, negative number, fraction, or unit suffix such as `512MiB`, falls back to 512 MiB and logs one warning per process. An explicitly set environment variable takes precedence even when invalid. `0` means **unlimited**, not zero retained bytes; use it only if you manage cleanup yourself.

Both OpenCode versions use the same directory and retention settings. The default directory is `opencode-openai-auth-dumps` inside Node's OS temporary directory:

| OS | Default dump directory |
| --- | --- |
| Linux | `/tmp/opencode-openai-auth-dumps` |
| macOS | `$TMPDIR/opencode-openai-auth-dumps`, normally `/var/folders/<user-specific directories>/T/opencode-openai-auth-dumps` |
| Windows | `%TEMP%\opencode-openai-auth-dumps`, normally `%USERPROFILE%\AppData\Local\Temp\opencode-openai-auth-dumps` |

OS temporary-directory environment overrides can change these locations; `dump_dir` (legacy `dumpDir`) / `OPENCODE_OPENAI_AUTH_DUMP_DIR` selects an explicit destination on every OS. Retention is best-effort background cleanup after successful writes, at most once every five minutes. Dumps younger than one minute and the just-written dump are protected, so usage can exceed the cap (including for a single oversized request). Another eligible successful write must trigger a sweep to reclaim excess bytes; while idle, the excess can persist. Only recognized dump artifacts are evicted; unrelated files and symlinks are left alone. The Diagnostics section of `/openai` shows a read-only size snapshot and the cap while dumps are on. It counts top-level regular files without reading their contents or traversing subdirectories, only when the menu is built, not on requests.

The `webSearch` setting and `CORTEXKIT_OPENAI_AUTH_NO_WEB_SEARCH` have been removed, along with the `web_search` tool the plugin used to add to requests; a config file that still sets `webSearch` loads normally and the key is ignored.

### Routing wait and log level

The shared `max_same_account_wait` takes `"off"` (**Don't wait**), `"15m"` (**15 minutes**, default) or `"cache"` (**Until the cache expires**). The move and Routing menu map these to and from the old store's `routing.maxSameAccountWait` values `0`, `15` and `"max"`. Invalid or absent values use the default; numeric strings are not accepted. A same-account hold requires confirmed exhaustion with every reset fitting the accepted session's cache lifetime. The killswitch takes precedence: with a positive floor on an exhausted window (including the default 5%/10% floors), the account is not admitted and cannot hold or wake on that account. Disable the killswitch or set that window's floor to zero to allow a cache-preserving hold. See [Routing](accounts-and-routing.md#routing).

On OpenCode, `log_level` accepts `"error"`, `"warn"`, `"info"`, `"debug"`, `"trace"` or `"default"` (the default). `"default"`, or removing the setting, uses `OPENCODE_OPENAI_AUTH_LOG_LEVEL`, else `info`. A saved level other than `"default"` overrides that environment variable. The log level follows the shared file while the process runs: an external edit is applied when the settings watch sees it, normally within its one-second poll period plus reload time. A menu edit takes effect immediately in the editing process. A process still using its old store keeps its previous log-level timing.

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

Opt into the WebSocket transport with the shared settings file (use the legacy fields in the table for a separate install):

```json
{
  "web_sockets": true,
  "raw_web_socket": true
}
```

Route Codex traffic through a local Codex-compatible proxy:

```sh
CORTEXKIT_OPENAI_AUTH_CODEX_ENDPOINT=http://127.0.0.1:8899/v1/responses opencode
```

## The account store

The account store combines `openai-auth.json` with its companion state file (`openai-auth-state.json` by default; see `OPENCODE_OPENAI_AUTH_STATE_FILE` above). It keeps accounts, credentials, quota cache and runtime state. After the settings move, preferences such as routing, [killswitch quota floors](accounts-and-routing.md#killswitch), log level and cache keep-warm settings come only from the shared file; old preference keys remain in the store but are no longer used or updated. Separate installs and processes waiting for the move still use their old store for preferences. The main account's refresh lease and backoff are state, not preferences, and remain in `openai-auth.json`. Use `/openai` to manage accounts and settings; a shared settings file is never overwritten with account data. See [Accounts and routing](accounts-and-routing.md#the-account-pool).

## Where the files live

OpenCode's account config file `openai-auth.json` stays in its config folder; the shared preferences are in `openai-auth.jsonc` at the path [above](#settings). The runtime files below are kept in the state folder, out of OpenCode's config folder, because OpenCode 2 watches that folder for changes:

- the account state file `openai-auth-state.json`, which holds the OAuth tokens;
- the vault folder `openai-auth-vault/`, which holds the enrollment token, the enrollment state and the vault roster;
- the Codex sessions files `openai-auth-sessions.json` (OpenCode 1) and `openai-auth-sessions-opencode2.json` (OpenCode 2);
- the lock folders and temporary files of each of these.

The plugin's state folder is `cortexkit/openai-auth` under `XDG_STATE_HOME`, or under `.local/state` in your home folder when `XDG_STATE_HOME` is unset. That is the same rule on every OS, and the same folder that already holds `sidebar-state.json`. The runtime files of one OpenCode config folder go in a subfolder of it:

- `opencode/` for the config folder `.config/opencode` in your home folder;
- `opencode-<16 hex characters>/` for any other config folder, for example one named by `OPENCODE_CONFIG_DIR` or reached through a different `XDG_CONFIG_HOME`. The characters are the start of the SHA-256 of the config folder's real path, so two config folders never share a file.

| OS | Runtime folder for the default config folder |
| --- | --- |
| Linux | `~/.local/state/cortexkit/openai-auth/opencode/` |
| macOS | `~/.local/state/cortexkit/openai-auth/opencode/`, that is `/Users/<you>/.local/state/cortexkit/openai-auth/opencode/` |
| Windows | `%USERPROFILE%\.local\state\cortexkit\openai-auth\opencode\` |

Each runtime folder holds `config-dir.json`, which names the config folder it belongs to. If it names a different one, the plugin refuses to start and leaves the folder alone. The plugin creates these folders and files owner-only: mode `0700` for folders and `0600` for files on Linux and macOS, and an access list that grants only your user on Windows.

`OPENCODE_OPENAI_AUTH_STATE_FILE`, and a custom config file named by `OPENCODE_OPENAI_AUTH_FILE`, keep the state file and its vault folder where they say (see the table above), and the plugin never moves or deletes them.

### The move from OpenCode's config folder

Versions before this one kept these files in OpenCode's config folder. At its first start, the plugin copies them into the runtime folder, checks every copy byte for byte, records the move in `layout.json` in the runtime folder, and then removes the old files, comparing each one with its copy again just before removing it. Vault enrollment comes along unchanged.

Only an OpenCode started without `OPENCODE_OPENAI_AUTH_STATE_FILE` and without a custom `OPENCODE_OPENAI_AUTH_FILE` moves the files. With either set, the plugin uses the moved sessions files once another start has moved them, and keeps every file in OpenCode's config folder until then. It also keeps them there, and touches nothing, when one of those paths points inside the runtime folder, when the runtime folder holds a runtime file the plugin did not put there, or when the runtime folder and OpenCode's config folder are the same folder (through a link or a mount).

The move waits while any other OpenCode process could still write the old files, because a sign-in token written to the old folder after the move would be lost. Such a process is one running an older version of the plugin, or one that started while such a process was running. While the move waits, the plugin keeps using the old files and logs once: "openai-auth keeps its files in OpenCode's config folder until every running OpenCode using it has restarted on this version." A process that starts while the move must wait also keeps the old files for its whole life, so restarting OpenCode processes one at a time can keep the move waiting. **To let it happen, close every OpenCode on the machine, then start OpenCode again.** Only OpenCode moves these files; Pi keeps its own files where they are.

If the move fails before writing `layout.json`, for example because the disk is full, the plugin keeps using the old files, logs the error once, and tries again at the next start. If it cannot record that it uses the old files, or cannot use or read its state folder at all, it refuses to start and names the folder and the error, rather than run where other OpenCode processes cannot see it. A malformed `layout.json` also refuses the start: the copies cannot be trusted. The refusal names the marker path and asks you to delete `layout.json` and restart OpenCode. Before doing so, check that the old runtime files are still in OpenCode's config folder. A marker damaged after completed cleanup does not prove the old files remain; keep the runtime folder intact if no old copies exist.

After the marker is written, an old state file or any vault file whose bytes differ from its new copy is a credential conflict, both during the move's cleanup and when a later start retries cleanup. An old credential file that matches its copy but cannot be removed yet (on Windows, another program may still have it open) is logged once, and the next start tries the removal again. An old state or vault file that reappears after a finished move is also a conflict, even if its bytes match. The one exception is the vault enrollment state file of an approved enrollment: the move removes the old token but leaves that file in the old vault folder, byte for byte as it moved. Later starts accept that file there as long as it still says this OpenCode's enrollment is approved, or blocked only because its token is missing, and no token file is in the old vault folder. An older version that runs after the move rewrites the file that way, and the file holds no secret. Anything else there, such as an enrollment request in progress, a file that cannot be read as an enrollment state, another enrollment's name, or a token file next to it, is a conflict. Disconnect removes the file. The plugin refuses to start and names both paths: keep the newer one, delete the other, and restart OpenCode. It never merges the copies or chooses by timestamp: the old copy may hold the only live successor to a single-use OAuth refresh token. A file named by this process's override remains its own and is not a conflict. Differing or reappeared session files are left alone with a warning; reappeared sessions are also shown once in the Diagnostics section of `/openai`.

Here, newer means the copy written by the most recent successful sign-in or token refresh, not simply the file with the later modification time. If you cannot establish which copy holds the live credential, do not guess or resume both copies.

What the move cannot see: it finds other OpenCode processes through the heartbeat and port files they leave in the state folder. Each port file must carry its own current-or-newer plugin version; a live process with an unversioned or older port file blocks the move even if a heartbeat with the same process id names a newer version. A short-lived tool from an older version that runs during the move and leaves neither, such as an older `opencode auth login`, can still write to the old folder without being seen by the fence. A differing or reappeared old credential file then refuses the next start as described above. A process is recognized by its process id alone, so an id reused by an unrelated process can delay the move.

### Downgrading

A version from before the move looks only in OpenCode's config folder, so after the move it finds no accounts and no vault token. Nothing is lost. If OpenCode was connected to the vault, an older version finds the enrollment state the move left without its token, so it stays in vault mode and refuses requests until the folder is moved back. To go back to an older version, do one of these:

- move `openai-auth-state.json`, `openai-auth-vault/` and the sessions files from the runtime folder back into OpenCode's config folder, and delete `layout.json` from the runtime folder so a later upgrade moves them again;
- or set `OPENCODE_OPENAI_AUTH_STATE_FILE` to the state file in the runtime folder, for example `~/.local/state/cortexkit/openai-auth/opencode/openai-auth-state.json`. The older version then reads the state file and the vault folder from there.

Close every OpenCode process before switching versions or moving credentials. Do not run an older version against the old copies while a newer version uses the runtime folder: refreshing either copy can spend the token held by the other. If the old version recreates the state file or vault files in the config folder, a later upgrade refuses to start until you resolve the two-path conflict above. Delete `layout.json` only for the explicit move-back procedure or the malformed-marker recovery, not to bypass a credential conflict.

## Pi

Pi reads its supported preferences from the same shared settings file as OpenCode, unless it is a separate install or its process is still waiting for the settings move. The OpenCode transport and diagnostics settings do not enable those features on Pi. Pi's account store is `openai-auth.json` in its agent directory (`~/.pi/agent` unless `PI_CODING_AGENT_DIR` says otherwise, with `~` expanded by Pi); `PI_OPENAI_AUTH_FILE` overrides the store's path and `PI_OPENAI_AUTH_STATE_FILE` the state file's path. `PI_AGENT_DIR` is not used. If only `~/.pi/agent` has an existing store (settings, account state, or a vault enrollment token/state file), the extension keeps using it there and logs a warning to stderr once per process. A cached vault roster alone does not count as an enrollment. If the configured directory already has a store, it wins; if neither has one, the configured directory is used. Credentials are never copied or moved between directories.

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
  "plugin": ["@cortexkit/opencode-openai-auth@1.15.1"]
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
pi install npm:@cortexkit/pi-openai-auth@1.15.1
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

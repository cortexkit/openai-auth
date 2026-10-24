# Troubleshooting

## Logging

The OpenCode plugin writes a leveled, secret-redacting, size-rotating log:

| Setting | Where | Default | Purpose |
| --- | --- | --- | --- |
| Log level | Diagnostics section of the plugin's [`/openai` slash-command menu](commands.md#the-openai-command) or `OPENCODE_OPENAI_AUTH_LOG_LEVEL` | `info` | One of `error`, `warn`, `info`, `debug`, `trace`. The menu changes it immediately, without a restart, and saves it. |
| Log file | `OPENCODE_OPENAI_AUTH_LOG_FILE` | OS temp dir: `opencode-openai-auth.log` (Windows: `opencode-openai-auth/opencode-openai-auth.log` inside the temp dir) | Destination file. It rotates at 5 MB, keeping three older generations. On Windows, a custom path must be in a folder only that user can access. A refused write drops log lines, not requests or commands; shutdown warns at most once. |

Token values and authorization and cookie headers are redacted from the log. Conversation and request bodies are never written to it; request dumps are a separate, explicit opt-in.

## Request dumps

Request dumps write the final Codex request bodies and redacted request metadata, for debugging prompt-cache behavior. Turn them on from the Diagnostics section of `/openai`, with `"dump": true` in the config file, or for one run:

```sh
CORTEXKIT_OPENAI_AUTH_DUMP=1 opencode
```

Each request produces `.body.json`, `.meta.json` and `.request.json` files in the dump directory (OS temp dir: `opencode-openai-auth-dumps`, or `dumpDir` / `OPENCODE_OPENAI_AUTH_DUMP_DIR`; see [Configuration](configuration.md#settings)).

OpenCode 1 and 2 share a default **512 MiB** dump retention cap. Set `OPENCODE_OPENAI_AUTH_DUMP_MAX_BYTES` (or `dumpMaxBytes` in the config) to a nonnegative integer byte count to change it; `0` disables cleanup. Invalid values use the default with one warning. The background sweep evicts the oldest whole dumps, at most once every five minutes after successful writes. Recent dumps are protected for one minute, and the newest write is kept, so usage can exceed the cap. Another eligible successful write must trigger a sweep to reclaim excess bytes; while idle, the excess can persist. Unrelated files are not removed. The Diagnostics dump line shows the directory's current size and cap when you open `/openai`; it does not scan the directory during requests. See [Configuration](configuration.md#settings) for default paths on Linux, macOS and Windows.

Turn dumps off after debugging: `.body.json` files contain the full rewritten prompt and request body. Turning them off through `/openai` updates the shared config file; all OpenCode 1 and 2 processes using that file pick up the change at their next dump decision, without restarting. The check is stat-gated: unchanged config is not reread, and an explicit `CORTEXKIT_OPENAI_AUTH_DUMP` override still wins (restart a process launched with `CORTEXKIT_OPENAI_AUTH_DUMP=1` without that override to turn it off). Turning dumps off does not delete existing files. To analyze a **cache cliff**, a sudden drop in prompt-cache hits between turns, see [Development](development.md#analyzing-cache-cliffs).

## OpenCode keeps using an old build

Clear OpenCode's plugin cache and restart OpenCode:

```sh
rm -rf ~/.cache/opencode
```

## Problems with stored credentials

The **Auth doctor** in the `opencode auth login` menu checks stored credentials and offers repairs; see [Commands](commands.md#from-a-terminal-without-a-tui-session). If it reports an [untagged pool placeholder](accounts-and-routing.md#the-account-pool) or [old vault tombstone](vault.md#leftovers-from-earlier-versions), a login has been replaced by a marker, not a usable token. Follow the linked migration or vault guidance to restore access.

## `Failed to authorize` after the account menu

The `opencode auth login` account menu saves your change itself, then reports a failed sign-in to prevent OpenCode from recording an extra account as its main login. OpenCode prints `Failed to authorize` for that response, even though the menu change was saved. Open the plugin's `/openai` menu to see the result.

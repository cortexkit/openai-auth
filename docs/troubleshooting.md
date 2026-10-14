# Troubleshooting

## Logging

The OpenCode plugin writes a leveled, secret-redacting, size-rotating log:

| Setting | Where | Default | Purpose |
| --- | --- | --- | --- |
| Log level | Diagnostics section of [`/openai`](commands.md#the-openai-command) or `OPENCODE_OPENAI_AUTH_LOG_LEVEL` | `info` | One of `error`, `warn`, `info`, `debug`, `trace`. The menu changes it immediately, without a restart, and saves it. |
| Log file | `OPENCODE_OPENAI_AUTH_LOG_FILE` | OS temp dir: `opencode-openai-auth.log` (Windows: `opencode-openai-auth/opencode-openai-auth.log` inside the temp dir) | Destination file. It rotates at 5 MB, keeping three older generations. On Windows, a custom path must be in a folder only that user can access. A refused write drops log lines, not requests or commands; shutdown warns at most once. |

Token values and authorization and cookie headers are redacted from the log. Conversation and request bodies are never written to it; request dumps are a separate, explicit opt-in.

## Request dumps

Request dumps write the final Codex request bodies and redacted request metadata, for debugging prompt-cache behavior. Turn them on from the Diagnostics section of `/openai`, with `"dump": true` in the config file, or for one run:

```sh
CORTEXKIT_OPENAI_AUTH_DUMP=1 opencode
```

Each request produces `.body.json`, `.meta.json` and `.request.json` files in the dump directory (OS temp dir: `opencode-openai-auth-dumps`, or `dumpDir` / `OPENCODE_OPENAI_AUTH_DUMP_DIR`; see [Configuration](configuration.md#settings)).

Turn dumps off after debugging: `.body.json` files contain the full rewritten prompt and request body. To analyze the cache cliffs in a dumped session, see [Development](development.md#analyzing-cache-cliffs).

## OpenCode keeps using an old build

Clear OpenCode's plugin cache and restart OpenCode:

```sh
rm -rf ~/.cache/opencode
```

## Problems with stored credentials

The **Auth doctor** in the `opencode auth login` menu reports problems with the stored credentials and offers repairs; see [Commands](commands.md#from-a-terminal-without-a-tui-session). Leftovers it lists, such as disabled untagged placeholders and old vault tombstones, are described in [Accounts and routing](accounts-and-routing.md#the-account-pool) and [Claustrum vault](vault.md#leftovers-from-earlier-versions).

## `Failed to authorize` after the account menu

The `opencode auth login` account menu prints `Failed to authorize` when it returns, even when the action succeeded. Check the result with `/openai`; the reason is explained in [Commands](commands.md#from-a-terminal-without-a-tui-session).

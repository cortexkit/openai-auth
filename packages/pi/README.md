# @cortexkit/pi-openai-auth

The Pi package of [CortexKit OpenAI Auth](https://github.com/cortexkit/openai-auth). It overrides Pi's built-in `openai-codex` provider so Pi can use a ChatGPT Plus or Pro subscription through the OpenAI Codex backend, with several accounts and sticky routing, usage limits per account and optional Claustrum vault integration. The OpenCode package is [`@cortexkit/opencode-openai-auth`](https://www.npmjs.com/package/@cortexkit/opencode-openai-auth).

> This plugin is not affiliated with or endorsed by OpenAI. Using a subscription this way may be against OpenAI's terms, and OpenAI may limit or suspend accounts. You use it at your own risk; the authors accept no responsibility for any action the provider takes.

## Install

Requires Pi 1.0.1 or newer. The extension is tested with Pi 1.5.2, the version pinned in the workspace lockfile. See [Install](https://github.com/cortexkit/openai-auth#install) in the repository README; installing with Pi's own package manager is described in [Configuration](https://github.com/cortexkit/openai-auth/blob/main/docs/configuration.md#installing-on-pi).

## Documentation

- [Configuration](https://github.com/cortexkit/openai-auth/blob/main/docs/configuration.md#pi)
- [Accounts and routing](https://github.com/cortexkit/openai-auth/blob/main/docs/accounts-and-routing.md#pi)
- [Commands](https://github.com/cortexkit/openai-auth/blob/main/docs/commands.md#pi)
- [Claustrum vault](https://github.com/cortexkit/openai-auth/blob/main/docs/vault.md#pi-in-vault-mode)

When Thalamus starts Pi, the plugin leaves the saved Pi login untouched and uses
the vault. If Pi does not expose its in-memory credential override, a saved
expired login may prevent Pi from reaching the plugin. Pi 1.5.2 was verified
with the override.

Pi's default compaction starts only above the same Codex OAuth input limit as
OpenCode. The model's output limit is separate. Custom compaction settings
still belong to Pi.

After a request is served, Pi's status line shows the serving
account's last 5-hour and 7-day quota readings and reset times. Email labels
appear as account numbers in `/openai` menu order.

Pi writes `pi-openai-auth.log` next to its account state file. On a shared
settings install, `/openai` → Diagnostics changes the log level or enables
redacted HTTP and WebSocket request dumps without restarting Pi. Dumps are off
by default and may still contain prompt content. The default dump directory is
`pi-openai-auth-dumps` next to the account state file; Pi's `dump_dir` and
`dump_max_bytes` settings control the destination and retention cap.

## License

MIT

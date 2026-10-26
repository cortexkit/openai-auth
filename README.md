# CortexKit OpenAI Auth

CortexKit OpenAI Auth lets [OpenCode](https://opencode.ai) (versions 1 and 2) and Pi use a ChatGPT Plus or Pro subscription through the OpenAI Codex backend, instead of a pay-as-you-go API key. It ships as two packages: `@cortexkit/opencode-openai-auth` for OpenCode and `@cortexkit/pi-openai-auth` for Pi.

## Why use it

OpenCode and Pi can already sign in to ChatGPT. This plugin adds:

- Several ChatGPT accounts, with sticky routing that keeps each session on one account instead of rebalancing every turn.
- Prompt-cache keep-warm, so an idle session's next turn still hits the cache.
- Optional [Claustrum](https://github.com/cortexkit/claustrum) vault integration: Claustrum is CortexKit's local credential vault, which keeps the logins and refreshes them in one place so no plugin holds a refresh token.
- Usage limits per account, with a killswitch that blocks requests below a chosen minimum remaining quota.
- The plugin's `/openai` slash-command menu and a sidebar showing the usage left on each account.
- Rate-limit reset credits, previewed and spent from the menu.
- A WebSocket transport, with plain HTTP as the default and fallback.

## Disclaimer

> This plugin is not affiliated with or endorsed by OpenAI. Using a subscription this way may be against OpenAI's terms, and OpenAI may limit or suspend accounts. You use it at your own risk; the authors accept no responsibility for any action the provider takes.

## Install

```sh
npx @cortexkit/opencode-openai-auth setup
```

The setup command detects OpenCode and Pi, registers the plugin, and offers a connection to the optional Claustrum vault or local sign-in.

Then start OpenCode and run `/openai`.

## Documentation

- [Configuration](docs/configuration.md): settings, environment variables and manual install.
- [Accounts and routing](docs/accounts-and-routing.md): multiple accounts, routing modes, quota and the killswitch.
- [Claustrum vault](docs/vault.md): what the vault is, connecting OpenCode or Pi, and vault mode.
- [Commands](docs/commands.md): the `/openai` menu, the `opencode auth login` menu and the Pi command.
- [Cache keep-warm](docs/cache-keep-warm.md): keeping idle sessions' prompt cache warm.
- [OpenCode 2](docs/opencode-2.md): install and differences from OpenCode 1.
- [Transports](docs/transports.md): HTTP and the WebSocket transports.
- [Troubleshooting](docs/troubleshooting.md): logging, request dumps and clearing the plugin cache.
- [Development](docs/development.md): working on this repository and running its tests.
- [Release](docs/release.md): publishing a new version.

## License

MIT

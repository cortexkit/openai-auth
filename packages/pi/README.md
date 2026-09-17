# @cortexkit/pi-openai-auth

Pi package for CortexKit OpenAI Codex OAuth support. It overrides Pi's built-in `openai-codex` provider with a CortexKit provider extension backed by Pi's OpenAI Codex Responses transport and OAuth primitives.

The Pi provider catalog includes `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, and `gpt-5.3-codex-spark`.

This package is part of the CortexKit OpenAI Auth monorepo, which supports both OpenCode (`@cortexkit/opencode-openai-auth`) and Pi (`@cortexkit/pi-openai-auth`).

## Install

Install with Pi's package manager:

```bash
pi install npm:@cortexkit/pi-openai-auth@0.1.0
```

For an unpinned install:

```bash
pi install npm:@cortexkit/pi-openai-auth
```

To try it for one run without changing Pi settings:

```bash
pi -e npm:@cortexkit/pi-openai-auth
```

Restart Pi after installing, then authenticate through Pi's normal login flow:

```text
/login openai-codex
```

## Commands

The extension registers three commands in Pi:

- `openai-account` — list configured fallback accounts, `openai-account add [label]` to add a fallback account via OAuth (browser or `--headless`), or `openai-account remove <id>` to remove one.
- `openai-quota` — show the quota last recorded for each stored fallback account.
- `openai-routing` — set the routing order (`main-first`, `fallback-first`, `sticky-balanced`) or reset session pins.

These manage the account store. **Pi requests do not yet route through it** — the
extension streams through the credential Pi itself supplies, so a routing choice is
recorded but does not move traffic between accounts, and quota shows the last values
written to the store rather than fetching current ones. The OpenCode plugin is where
routing is live today. The store format is shared between the two, so what you configure
here is what Pi will use once its request path reads it.

## License

MIT

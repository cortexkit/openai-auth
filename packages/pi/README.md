# @cortexkit/pi-openai-auth

Pi package for CortexKit OpenAI Codex OAuth support. It overrides Pi's built-in `openai-codex` provider with a CortexKit provider extension backed by Pi's OpenAI Codex Responses transport and OAuth primitives.

The Pi provider catalog includes `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, and `gpt-5.3-codex-spark`.

This package is part of the CortexKit OpenAI Auth monorepo, which supports both OpenCode (`@cortexkit/opencode-openai-auth`) and Pi (`@cortexkit/pi-openai-auth`).

## Install

Requires Pi 1.0.1 or newer.

Install with Pi's package manager:

```bash
pi install npm:@cortexkit/pi-openai-auth@0.11.0
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

The extension registers one command in Pi, `openai`, which opens a menu: Accounts (add a fallback account via OAuth, disable, enable, move or remove one), Quota (check now), Routing (`ordered`, `main-first`, `fallback-first`, `sticky-balanced`, and the roster order), Limits (the killswitch and per-account floors), Pi login (the quota of the account you signed in to Pi with, routed as `main`), This session (clear the session's pin) and Vault.

The Vault section connects Pi to a [Claustrum](https://github.com/cortexkit/claustrum) vault: Connect proposes the enrollment `openai-auth-pi` and shows the `ck auth enroll approve --request-id <id>` and `ck auth grant --principal enrolled:openai-auth-pi --selector-kind category --selector openai-native --operation read` commands to run; Pi tells you when the approval lands. While Pi is connected (vault mode), the OpenAI accounts the vault serves it are the only ones routed, each request fetching its token from the vault; Pi's own login and the pool are neither used, refreshed nor polled. In vault mode the models are offered under the `openai-codex-vault` provider instead of `openai-codex`, so pick `openai-codex-vault/<model>`: Pi refreshes and stores the stored `openai-codex` login whenever one of its models is used, so those models are withdrawn while connected. Disconnect forgets Pi's token; each vault account can be disabled or enabled on Pi alone.

## How requests are routed

Every request goes out with one account's token, chosen by the routing mode:

- `main-first` tries your Pi login first, then the fallbacks in order; `fallback-first` tries the fallbacks first and your Pi login last. When an account answers with a rate-limit or auth error before anything was streamed, the next one is tried.
- `sticky-balanced` keeps each Pi session on one account, spreading sessions by remaining quota, and moves a session for good only when its account is confirmed exhausted.

Your Pi login stays where Pi keeps it: Pi refreshes it and the extension only uses the token Pi hands it. Fallback accounts live in the extension's own store (`openai-auth.json` in Pi's agent directory, `~/.pi/agent` unless `PI_AGENT_DIR` says otherwise, or the file `PI_OPENAI_AUTH_FILE` names), are refreshed there, and a fallback that is the same ChatGPT account as your Pi login is never used twice. An account is used only once its quota is known: each account's quota is checked as soon as the extension sees it, and quota from every response keeps it current. A store written by an earlier version is converted to the account-pool format the first time it is read, keeping its accounts.

## License

MIT

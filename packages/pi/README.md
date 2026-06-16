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

## License

MIT

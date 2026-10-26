# Development

## Workspace layout

```text
packages/core      Shared, host-independent code (@cortexkit/openai-auth-core, not published)
packages/opencode  OpenCode plugin (@cortexkit/opencode-openai-auth)
packages/pi        Pi extension (@cortexkit/pi-openai-auth)
scripts            Release and development tooling
```

[`STRUCTURE.md`](../STRUCTURE.md) maps the files in more detail, and [`ARCHITECTURE.md`](../ARCHITECTURE.md) describes how the pieces fit together.

## Checks

Install dependencies:

```bash
bun install
```

Run the checks (the build refuses dependencies that resolve outside the repository):

```bash
bun run typecheck
bun run test
bun run build
bun run lint
bun run format:check
```

Inspect package contents before publishing:

The Node bundles keep `jsonc-parser` as a declared runtime dependency: its UMD entry uses relative `require` calls that Bun's bundler leaves unresolved when inlined. The packed-package tests check the external dependency allowlist and load the installed package with plain Node.

```bash
bun run pack:opencode:dry
bun run pack:pi:dry
```

## Testing a local build with OpenCode

```bash
bun run dev
```

This builds the OpenCode plugin, symlinks the output into `.opencode/plugins/`, and starts `tsc --watch`. Restart OpenCode after starting the dev script and after rebuilds. Remove the local dev symlink with:

```bash
bun run dev:clean
```

## Analyzing cache cliffs

To inspect a **cache cliff**, a sudden drop in prompt-cache reuse between turns, enable [request dumps](troubleshooting.md#request-dumps) and run:

```sh
bun run analyze:cache -- --session ses_... --no-timeline
```

To print previous and current request-body text around the first differing byte, add `--wire-context` with the number of surrounding bytes:

```sh
bun run analyze:cache -- --session ses_... --no-timeline --wire-context 180
```

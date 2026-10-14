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

With [request dumps](troubleshooting.md#request-dumps) turned on, analyze the cache cliffs of a dumped OpenCode session:

```sh
bun run analyze:cache -- --session ses_... --no-timeline
```

For raw consecutive request-body comparisons, include wire context:

```sh
bun run analyze:cache -- --session ses_... --no-timeline --wire-context 180
```

## Mutation catalogue

[`mutations.toml`](../mutations.toml) lists deliberate breaks of production code, each with the named test that must fail when it is applied, so a guard cannot quietly stop guarding. A per-row `list_command` discovers the Bun test names without running the test bodies and verifies that each expected name still exists. `ckdev-mutate` replays them: it runs each named test on the clean tree, applies the break, requires the test to fail for the recorded reason, and restores the file. A row is for a silent, costly failure (a credential lost or leaked, a reset credit spent twice, output replayed, an account lost in a crash, a wire contract), not for style. Run it from a clean tree; CI replays the rows a pull request touches, the full catalogue on main, and the full catalogue with `--broad` nightly.

```bash
cargo install --locked --git https://github.com/cortexkit/commons --rev 9d6b663dac487bb982c7bfd18a96eee2292164ad cortexkit-mutate
ckdev-mutate check --strict
ckdev-mutate run --all
```

The revision matches `CKDEV_MUTATE_REV` in `.github/workflows/ci.yml`.

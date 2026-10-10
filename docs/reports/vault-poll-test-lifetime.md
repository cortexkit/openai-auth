# Attribution of the unreachable-vault quota poll

## Finding: a test lifetime leak, not a vault-mode product regression

The full Linux OpenCode suite reproduced the poll with a unique access token and
refresh token on the unreachable-vault test's local `main` row. A unique bearer
alone was not sufficient to identify the plugin: a surviving loader resolves
`OPENCODE_OPENAI_AUTH_FILE` lazily and can read a later fixture's row.

Temporary instrumentation therefore captured each `PoolAccountSource`'s paths
and creation stack **at construction**, then printed that origin alongside its
current paths when pulling the unique bearer. In the decisive Bun 1.4.2 full
run, the two sources originated here (line numbers before this fix):

- `dump.test.ts:987`, `dumps final WebSocket prewarm and main bodies when enabled`.
- `dump.test.ts:432`, `rotates HTTP turn metadata for a new user turn and keeps it during tool continuations`.

Both creation stacks passed through `dump.test.ts:1041` (`pluginFetch`) and
`:1084` (`withDumpEnv`). Neither was the unreachable-vault test's plugin.
Captured origin/current-path evidence from that run:

```text
origin configPath: /motor-home/tmp/openai-auth-dump-test-ly2zXe/missing.json
origin configPath: /motor-home/tmp/openai-auth-dump-test-oOVzB5/missing.json
origin statePath: /motor-home/tmp/openai-auth-test-floor-NbkCUm/openai-auth-state.json
current configPath: /motor-home/tmp/openai-vault-AplyCr/openai-auth.json
current statePath: /motor-home/tmp/openai-vault-AplyCr/openai-auth-state.json
pull id: main; identity: chatgpt-main; reason: admission
access: never-answer-/motor-home/tmp/openai-vault-AplyCr-token
refresh: never-answer-/motor-home/tmp/openai-vault-AplyCr-refresh
Expected to not contain: "Bearer never-answer-/motor-home/tmp/openai-vault-AplyCr-token"
Received: [ "Bearer never-answer-/motor-home/tmp/openai-vault-AplyCr-token",
            "Bearer never-answer-/motor-home/tmp/openai-vault-AplyCr-token" ]
```

The dump tests restored shared fetch and account paths without stopping all
loaders. The fix owns every dump plugin and request through
`createRequestTestScope`, captures plugin work, and disposes/drains it **before**
restoring network or paths. Existing restart-test disposal is retained. No
production code, enrollment predicate, or terminal-menu behavior changed.
All temporary product/fixture telemetry was removed.

The vault test still forbids model sends, its row's refresh, and its row's quota
poll. Its credentials now identify that row uniquely; the ambiguous assertion
against the ubiquitous `main-token` was replaced, not relaxed into accepting
local polls.

## Full Linux runs and the menu-change comparison

All full runs used `cd packages/opencode && bun test`, Bun 1.4.2
(`744846f84`), with `bun run build` first in the same Linux job. The runner does
not retain build artifacts between jobs.

| Tree | Full runs | Result |
| --- | ---: | --- |
| `0b2ef3b`, unmodified | 3 | 2 clean passes; 1 failure of the original unreachable-vault assertion (`Received: [ "Bearer main-token" ]`). Passing runs: 1459 pass, 22 skip; failing run: 1458 pass, 22 skip, 1 fail; 1481 tests/80 files. |
| `e5228b1` with unique credentials and temporary attribution telemetry, no lifetime fix | 6 | The unreachable-vault test failed in 2/6, passed in 4/6. One full run was entirely green. Of the other five, three also failed a subprocess stderr assertion because the initial broad telemetry wrote to stderr; one also failed pool-surfaces, and one separate run failed the reset-menu wire assertion. The later, origin-only telemetry run failed **only** the unreachable-vault test and conclusively identified the dump sources above. |
| Task fix on `e5228b1` | 3 consecutive | All clean: 1465 pass, 22 skip, 0 fail, 5704 assertions; 1487 tests/80 files. Durations: 70.05 s, 67.20 s, 72.26 s. |

The original failure on `0b2ef3b` predates the `e5228b1` terminal-menu change.
The captured instances came from dump tests, not the vault terminal menu. The
comparison and instance evidence do not implicate that menu change. These
small run counts establish reproduction, not a statistical flake-rate estimate.

An initial current-tree full invocation without Linux build artifacts failed
packaging checks (1455 pass, 22 skip, 5 fail, 1 error); it is excluded from the
comparison above. An older-baseline command whose temporary log directory did
not exist executed no tests and is also excluded.

## Gates and non-vacuity

- Linux `bun run types`: passed all three workspace TypeScript checks;
  TypeScript 7.0.2, Bun 1.4.2.
- Linux `bun run lint`: Biome 2.5.15, 233 files checked, no fixes.
- Linux `bun run build`: passed all package builds, 26 installed dependency
  ranges and six package manifests checked.
- Linux focused dump/vault tests: 71 pass, 0 fail, 494 assertions on **both**
  Bun 1.4.2 and Bun 1.3.14 (`0d9b296a`).
- `ckdev-mutate check`: passed locally, ckdev-mutate 0.9.8; all catalogue
  anchors and exact test names verified (155 controls, 160 expected-red test
  selectors). No product mutation row was added because this is a fixture-only
  fix. Comment review examined both changed test files and flagged no comments.
- New regression: `request dumps > disposes every dump loader before restoring
  the shared network and account paths`. Two real plugin loaders install two
  injected quota timers; both must be cleared while fixture fetch and paths
  remain installed. Removing fixture disposal with a `NON-VACUITY BREAK` made
  exactly this selected test fail on **both** Bun versions: expected timer
  count 0, received 2; 0 pass, 21 filtered out, 1 fail. Restored runs: 1 pass,
  21 filtered out, 0 fail, four assertions on each version.
- Safe mutation sequence: staged live files; empty `git diff --stat`; mutated
  `dump.test.ts` showed `3 ++-` (two insertions, one deletion); tested; restored
  from the index and touched the file; empty `git diff --stat` again.

The Linux runner refused the mutation job before execution with
`runner_disk_full` (135,418,245,120 free bytes, 137,438,953,472-byte floor).
The parent authorized the two one-off local targeted mutation/restoration
checks; no Linux mutation result is claimed. The required three consecutive
full Linux suites had already passed. No shared caches were deleted.

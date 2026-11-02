# Standing rules for workers

Standing rules for workers. Anything not listed here comes to the coordinating agent for this repository (OAIAUTH) as a question.

## Build and test
- This Bun workspace has three packages: `core`, `opencode` and `pi` under `packages/`. The full gate enforces the Bun version in `mise.toml` and Node 24, as in CI, fetching the pinned Bun into ignored `target/scratch/gate-tools` when needed; no hand install is needed. `--fast` uses and logs the installed local toolchain without fetching Bun.
- Run only the tests for the files and behaviour you changed, by file or by name (`bun test <file> -t <name>`), plus `scripts/gate.sh --fast`, which runs the short checks locally; run it before every commit. For a bug fix, show one test failing without the fix. Run those filtered tests on the build server with the AFT bash tool's `runon` option (`linux,4c`), or on the Mac when they need macOS or something the build server can't install (an unpublished candidate tarball).
- Remote Linux jobs cannot change files git tracks (writes, deletes, `sed -i`, formatter rewrites all fail with "Operation not permitted"). Show a fix failing without it locally, or in a scratch copy under `$TMPDIR`, never by reverting a tracked file inside a job. Regenerate tracked fixtures locally, or name them in `runon` `return_paths`.
- Never run a whole package suite or the full gate (`scripts/gate.sh` without `--fast`); the head runs the full gate once over several merged deliveries. If a test outside your change looks broken, rerun only that test by name on the base commit, never the suite. A filtered run that takes more than about 15 minutes means the filter is too broad: narrow it rather than wait.
- For reference, the head's full gate installs the locked OpenCode 1 and 2 hosts once with `npm ci --ignore-scripts`, then runs all three package suites and both real-host suites in parallel on `linux,8c,net`.
- The real-host suites run from `packages/opencode`: `OPENAI_AUTH_OPENCODE1_E2E=1 bun test src/tests/opencode1-e2e.test.ts` and `OPENAI_AUTH_OPENCODE2_E2E=1 bun test src/tests/opencode2-e2e.test.ts`. Tests use isolated temporary homes; no provider credentials are needed.
- `bun run types` typechecks all three packages. `bun run build` first checks installed dependency ranges, local dependency paths and single-copy dependencies, then builds core, OpenCode (including the compiled TUI) and Pi. Build before running tests that inspect packaged output.
- Show each fix's test failing without the fix (revert the fix, run the test, restore it), and quote the failure line in the report.
- Windows runs in CI only. If a change touches file permissions, locks, paths or process spawning, say so in the report, so the coordinating agent runs the Windows workflow before merging.

## Report-only tasks
- A task that only writes a report under `.cortexkit/internal-docs/` changes no product code: skip the gate, commit nothing, and deliver with the existing HEAD. The report reaches the head when the task is settled.

## Pre-approved (do it, then report it)
- Regenerate `bun.lock` after a manifest change you were asked to make.
- Add test seams and test-only helpers, kept out of the published types.
- Format with Biome, and fix lint in files you touch.
- Update docs and comments that describe behaviour you changed.
- Fix a test whose expectation contradicts the brief, and say why in the report.
- Merge `main` into your branch when it moved, keeping both sides.

## Never
- Loosen an assertion, skip a test, or raise a timeout without measurements showing how long each phase takes and where the time goes.
- Commit a candidate tarball path, or force-add anything under `.cortexkit/`. Only `.cortexkit/WORKER.md` is tracked, through the `.gitignore` exception.
- Read or write the operator's real config, OpenCode or Pi folders, or vault. Tests use temporary homes.
- Push, tag, publish, or post on GitHub.
- Change these without asking: user-visible wording beyond the brief, config keys, stored formats or migrations, what reaches a provider or the vault, security boundaries.

## Comments
Explain the reason for a reader with no context. No task ids, slice names or references to this conversation.

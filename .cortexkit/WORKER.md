# Standing rules for workers

Standing rules for workers. Anything not listed here comes to the coordinating agent for this repository (OAIAUTH) as a question.

## Build and test
- This Bun workspace has three packages: `core`, `opencode` and `pi` under `packages/`. The full gate enforces the Bun version in `mise.toml` and Node 24, as in CI; `--fast` uses and logs the installed local toolchain.
- Run builds and test suites on the build server using the AFT bash tool's `runon` option (`runon: "linux,16c,net"` for the full gate, `linux,4c` for one package). Run on the Mac only what needs macOS, or what the build server can't install (an unpublished candidate tarball), and the fast gate below. In that case run one suite at a time.
- Before delivering, run `scripts/gate.sh` remotely and report its final line. `scripts/gate.sh --fast` runs the short checks locally; run it before every commit. The full gate installs the locked OpenCode 1 and 2 hosts once with `npm ci --ignore-scripts`, then runs all three package suites and both real-host suites in parallel.
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

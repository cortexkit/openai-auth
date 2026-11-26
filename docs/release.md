# Release

This repository uses CortexKit's tag-driven release workflow. One version number covers both published packages, `@cortexkit/opencode-openai-auth` and `@cortexkit/pi-openai-auth`.

## Shared-auth adoption

The [core](../packages/core/package.json), [OpenCode](../packages/opencode/package.json) and [Pi](../packages/pi/package.json) manifests declare the dependency ranges. Use [bun.lock](../bun.lock) for the exact versions built into the release, including shared auth and the vault clients. These are dependency versions, not the version to pass to the release script. Users still install through setup; no separate common-auth installation or credential migration is required.

Release notes should call out these user-visible changes:

- **Longest wait on the same account**, under Routing, defaults to **15 minutes**, with **Don't wait** and **Until the cache expires** alternatives. A same-account hold waits for a reset time confirmed by the provider or fresh quota readings, only while the session's cache remains usable. Credentials, quota and cache are checked again before sending after the wait. Any suggested delay in a quota-refusal message uses fresh quota information and is capped by the selected wait bound.
- OpenCode 2 allows one hold per user turn in total, not once per account or request kind; the next user prompt restores the allowance. If a session mixes requests using plugin-managed credentials with requests using another plugin's or the host's credentials, OpenCode 2 itself decides whether and when to retry. The auth plugin does not add holds or account reroutes to that mixed session.
- OpenCode persists account-wide limit marks for the same pool or vault roster across restarts; ordinary healthy responses do not erase live marks. Pi uses a cancellable countdown before output, without persisting timed marks. Killswitch, credential and output-safety checks remain authoritative: waiting never bypasses them.

Before release, run the release matrix with the locked [OpenCode 1](../packages/opencode/src/tests/fixtures/opencode1-host/package-lock.json) and [OpenCode 2](../packages/opencode/src/tests/fixtures/opencode2-host/package-lock.json) fixtures on Linux, macOS and Windows, plus Pi's fresh-process provider-stream tests. Record the commands, counts and first provider result from a new host process, separately for local and vault credentials. Require the expected response and bearer without a warm-up request. `scripts/gate.sh --fast` and Linux-only runs do not exercise that full matrix. Windows runs in CI, and workflow changes require approval from the repository's CI maintainer.

## Publishing

Preview a release:

```bash
./scripts/release.sh 0.2.0 --dry
```

The dry run shows what the version sync would change, without committing, tagging or pushing.

Create and push the release tag:

```bash
./scripts/release.sh 0.2.0
```

The script refuses an existing tag or a dirty working tree, and asks before releasing from a branch other than `main` or `master`. It syncs the version into both `package.json` files, `packages/opencode/src/version.ts` and the pinned install lines in the documentation (`scripts/version-sync.mjs`), runs the format check, lint, typecheck, tests and build, then commits, tags and pushes.

Wait for GitHub Actions:

```bash
./scripts/wait-release.sh v0.2.0
```

It polls the workflow every 5 seconds for up to 900 seconds (`--max-wait <seconds>` or `MAX_WAIT_SECONDS` changes the limit). It exits 0 on success, 1 if the workflow failed and 2 on timeout. If the GitHub CLI (`gh`) fails, the script reports the query error and passes through the exit code.

The release workflow runs checks, publishes both packages to npm with provenance (npm Trusted Publishing / OIDC), and creates the GitHub release. The publish job skips publishing a package when its version is already on npm.

> [!NOTE]
> npm Trusted Publishing can only be configured after a package already exists on npm, so the **first** version of a package must be published manually (`npm publish --access public` from its directory under `packages/`). Configure OIDC trusted publishing for the package afterward; later tagged releases then publish through the workflow.

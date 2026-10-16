# Release

This repository uses CortexKit's tag-driven release workflow. One version number covers both published packages, `@cortexkit/opencode-openai-auth` and `@cortexkit/pi-openai-auth`.

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

It polls the workflow every 5 seconds for up to 900 seconds (`--max-wait <seconds>` or `MAX_WAIT_SECONDS` changes the limit) and exits 0 on success, 1 on failure and 2 on timeout.

The release workflow runs checks, publishes both packages to npm with provenance (npm Trusted Publishing / OIDC), and creates the GitHub release. The publish job skips publishing a package when its version is already on npm.

> [!NOTE]
> npm Trusted Publishing can only be configured after a package already exists on npm, so the **first** version of a package must be published manually (`npm publish --access public` from its directory under `packages/`). Configure OIDC trusted publishing for the package afterward; later tagged releases then publish through the workflow.

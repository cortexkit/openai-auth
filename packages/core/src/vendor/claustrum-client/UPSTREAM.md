# @cortexkit/claustrum-client vendoring

This directory is a vendoring of `@cortexkit/claustrum-client` from
[`cortexkit/claustrum`][repo], pinned at merge commit
`1828f35cca9c69b8fdd80edda3ba01196de4bda7` (PR #52).

**Do not swap to `@cortexkit/claustrum-client@0.1.0`.** It is on npm, and it
is *older* than this snapshot: it was built from commit `2d5e217`, which
predates eight client commits including `1828f35` itself. Installing it would
remove the served-identity fields the custody code reads for `accountId`, the
ancestor-walk permission hardening, and the manifest writer lock. A published
version is not by itself the signal to swap; being at or after `1828f35` is.

CKCRED will cut `0.2.0` from current master, which includes everything through
`1828f35`, and will say so with the version and commit. At that point the swap
is a version bump.

The seven production files (`detect.ts`, `errors.ts`, `handles.ts`,
`identity.ts`, `index.ts`, `manifest-lock.ts`, `wire.ts`) are copied
byte-for-byte from `.opencode/vendor-src/claustrum-client-1828f35/src/`.
**Do not edit them
in place** — they are a snapshot of the upstream source.

Review this pin on or before 2026-10-04. Check the candidate release's source
commit rather than its version number: the ordering that matters is whether it
contains `1828f35`, and `0.1.0` is the counter-example proving a higher version
number does not imply it.

The three test files in `src/tests/` (upstream) were NOT copied; the
opencode test suite owns its own tests under `src/tests/custody.test.ts`.

## Upstream metadata

- **Repository:** [`cortexkit/claustrum`][repo]
- **Source path:** `packages/client/src/`
- **Pinned commit:** `1828f35cca9c69b8fdd80edda3ba01196de4bda7` (PR #52 in `cortexkit/claustrum`)
- **License:** MIT (see vendored source headers and the repo `LICENSE`)
- **Source of truth:** the `.opencode/vendor-src/claustrum-client-1828f35/`
  tree inside this worktree; the golden `check:claustrum-golden` script
  confirms the fixture byte-for-byte against upstream.

## Diff vs the prior pin (`d69ceed`)

- **`wire.ts`** — `ServedCredential` now decodes optional identity metadata:
  `accountId`, `email`, `orgName`, `projectId`, and `credentialId`.
- **`handles.ts`** — new handle-file parser and validation surface, re-exported
  by `index.ts`.
- **`manifest-lock.ts`** — updated to use the shared handle-file types.
- **`src/tests/handles.test.ts`** — new upstream test file. It is not vendored;
  the opencode suite owns its integration coverage.

[repo]: https://github.com/cortexkit/claustrum

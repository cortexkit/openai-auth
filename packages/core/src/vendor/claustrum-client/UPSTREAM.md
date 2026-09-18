# @cortexkit/claustrum-client vendoring

This directory is a vendoring of `@cortexkit/claustrum-client` from
[`cortexkit/claustrum`][repo], pinned at merge commit
`1828f35cca9c69b8fdd80edda3ba01196de4bda7` (PR #52). The pin is
temporary: once `@cortexkit/claustrum-client` is published on the registry
at or after `1828f35cca9c69b8fdd80edda3ba01196de4bda7`, this directory is
removed and the dependency becomes a normal package import.

The seven production files (`detect.ts`, `errors.ts`, `handles.ts`,
`identity.ts`, `index.ts`, `manifest-lock.ts`, `wire.ts`) are copied
byte-for-byte from `.opencode/vendor-src/claustrum-client-1828f35/src/`.
**Do not edit them
in place** — they are a snapshot of the upstream source. The replacement
condition is: swap to a published `@cortexkit/claustrum-client` release
when one exists at or after `1828f35cca9c69b8fdd80edda3ba01196de4bda7`, at which point this directory is
removed and the dependency flips to a normal package import.

Review this pin on or before 2026-10-04; if `@cortexkit/claustrum-client` is not published by then, decide whether to keep vendoring or drop the feature.

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

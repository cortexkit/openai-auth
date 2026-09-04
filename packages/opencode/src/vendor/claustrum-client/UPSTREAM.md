# @cortexkit/claustrum-client vendoring

This directory is a vendoring of `@cortexkit/claustrum-client` from
[`cortexkit/claustrum`][repo], pinned at commit `d69ceed` (PR #28 in
the upstream repository — the cut-line that exposed `manifest-lock.ts`
to consumers). The pin is temporary: once `@cortexkit/claustrum-client`
is published on the registry at or after `d69ceed`, the vendoring becomes
the published dependency and this directory
is removed.

The six production files (`detect.ts`, `errors.ts`, `identity.ts`,
`index.ts`, `manifest-lock.ts`, `wire.ts`) are copied byte-for-byte from
`.opencode/vendor-src/claustrum-client-d69ceed/src/`. **Do not edit them
in place** — they are a snapshot of the upstream source. The replacement
condition is: swap to a published `@cortexkit/claustrum-client` release
when one exists at or after `d69ceed`, at which point this directory is
removed and the dependency flips to a normal package import.

Review this pin on or before 2026-10-04; if `@cortexkit/claustrum-client` is not published by then, decide whether to keep vendoring or drop the feature.

The two test files in `src/tests/` (upstream) were NOT copied; the
opencode test suite owns its own tests under `src/tests/custody.test.ts`.

## Upstream metadata

- **Repository:** [`cortexkit/claustrum`][repo]
- **Source path:** `src/`
- **Pinned commit:** `d69ceed` (PR #28 in `cortexkit/claustrum`)
- **License:** MIT (see vendored source headers and the repo `LICENSE`)
- **Source of truth:** the `.opencode/vendor-src/claustrum-client-d69ceed/`
  tree inside this worktree; the golden `check:claustrum-golden` script
  confirms the fixture byte-for-byte against upstream.

## Diff vs the prior pin (`2c2e713`)

- **`index.ts`** — `manifest-lock.ts` re-export added; no other public
  API changes.
- **`manifest-lock.ts`** — **new file** added to the production set.
  The previously-vendored 2c2e713 contained only the `wire.ts` +
  `detect.ts` + `errors.ts` + `identity.ts` transport surface; the
  manifest-lock primitive moved into the public export at `d69ceed`
  so this consumer can read/write the opencode-handles manifest under
  a tenant-bound lock without depending on an external module.
- **`src/tests/client.test.ts`** — new upstream test file. Not vendored
  (the opencode suite owns its own coverage for the integration).
- **`src/tests/manifest-lock.test.ts`** — new upstream test file. Not
  vendored for the same reason.

[repo]: https://github.com/cortexkit/claustrum

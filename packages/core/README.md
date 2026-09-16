# @cortexkit/openai-auth-core

Private workspace package. It holds the OpenAI account store, the OAuth flow, the
reset-credit state machine, the quota bookkeeping, the logger and the shared slash-command
bodies that both the OpenCode plugin and the Pi extension run.

It is never published. Each host bundles it into its own published artefact, so this
package has no `files` list, no `bin` and no tarball of its own.

Two entry points:

- `@cortexkit/openai-auth-core` — the command seam. `buildDialogPayload` and `applyCommand`
  are the only way to run a command body, so the credential scrubbing they perform cannot
  be bypassed. The `execute*` bodies stay module-private.
- `@cortexkit/openai-auth-core/internal` — everything else a host still needs directly:
  the account store, OAuth primitives, the reset path, the logger and the RPC payload types.
  An import from here is a host visibly reaching past the seam.

The package reads no environment variable and resolves no host path. Every store entry
point takes an `AccountPaths` (`{ configPath, statePath }`) as a required argument, and
each host resolves its own paths and passes them in.

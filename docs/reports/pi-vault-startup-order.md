# Pi 1.0.4 vault startup ordering

## Measurement

`packages/pi/src/tests/startup-order.test.ts` uses the installed
`@earendil-works/pi-coding-agent` 1.0.4 SDK and its real extension loader,
`ModelRuntime`, `AgentSession.bindExtensions`, and first `ModelRuntime.streamSimple`
request. The fixture starts with vault enrollment already on disk and an expired
`openai-codex` OAuth login in Pi's `auth.json`. It does not run an interactive
command. The production extension is loaded from its source, not a mock factory.
Observers wrap and delegate the real provider auth methods, registry refresh,
slot synchronization, and runtime start. No Pi files are edited.

Bun 1.4.2 (744846f84), one test, 12 assertions, passed. The recorded sequence was:

```text
registry.refresh:oauth
factory:start
slot.sync:api_key
factory:end
registry.refresh:api_key
session_start
registry.refresh:api_key
registry.refresh:api_key
apiKey.check:api_key  (six calls)
slot.sync:api_key
apiKey.check:api_key
apiKey.resolve:api_key
transport:codex
```

The earliest opportunity is the **async extension factory**, not `session_start`.
It awaits the slot swap before returning to Pi. `session_start` then awaits the
registry reload before returning. The first request's resolved credential is the
placeholder, the Codex request uses only the vault's token, and the OAuth token
endpoint is never called (zero refresh attempts). Quota is hydrated through the
vault before this first request to isolate auth ordering from the independent
first-quota-reading refusal; this does not resolve Pi's credentials.

Pi performs an initial registry refresh before loading extensions. That is an
auth-availability check, not OAuth `toAuth`, credential resolution, or token
refresh: none of those observers fired before the swap. The test records this
pre-factory refresh explicitly rather than claiming the extension runs before
all registry activity.

## Startup source and limits

In the installed `@earendil-works/pi-coding-agent` 1.0.4 sources:

- `dist/core/sdk.js:75-81` creates the runtime before loading resources.
- `dist/core/extensions/loader.js:510-533` awaits extension factories.
- `dist/core/model-runtime.js:184-193` checks availability via `checkAuth`.
- The normal CLI calls `createAgentSessionServices` from `dist/main.js:587-605`.
  `dist/core/agent-session-services.js:56-70,111-112` creates the runtime, awaits
  resource loading, then refreshes again after registering extension providers.
- `dist/core/agent-session.js:2594-2616` emits and awaits `session_start` when
  extensions are bound. Print mode binds before prompting.

The dynamic measurement above is the SDK path, not an interactive terminal run.
The normal CLI's inspected startup uses the same ordering. The separate CLI
`auth` subcommands branch before session resource loading (`dist/main.js:457-459`);
`auth check` can resolve or refresh credentials without loading any extension.
No extension hook can protect that separate command before it runs. This change
does not modify Pi or claim to intercept that non-session path.

## Mutation control

The catalogue control `pi-vault-slot-startup-awaits-swap` removes the await from the production factory's
slot synchronization. Only the named startup-order test fails:
`factory:end` precedes `slot.sync:api_key` (received sequence position 2, expected
later than position 5). The separate session hook can still finish the swap
before a request; the assertion specifically protects the earlier factory
boundary, rather than mistaking that later recovery for early initialization.

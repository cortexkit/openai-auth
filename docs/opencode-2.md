# OpenCode 2

The OpenCode package, `@cortexkit/opencode-openai-auth`, runs on OpenCode 2 (`@opencode/cli`, tested on 2.0.22).

## Manual install

OpenCode 2 loads the plugin from the package's `./server` entry. OpenCode 1 also prefers that entry over the package root, so the entry carries the same OpenCode 1 plugin as the root as well. List the package under `plugins`:

```json
{
  "plugins": ["@cortexkit/opencode-openai-auth@1.0.5"]
}
```

or run `opencode plugin add @cortexkit/opencode-openai-auth`.

## Signing in

Sign in with `opencode auth login openai` (or the TUI) and pick **ChatGPT (openai-auth pool, browser)** or **ChatGPT (openai-auth pool, headless)**.

A pool login stores ChatGPT credentials in the shared [account pool](accounts-and-routing.md#the-account-pool) and gives OpenCode 2 a **placeholder**, a non-secret marker instead of those credentials. The plugin handles only requests whose Authorization bearer matches that marker. API keys, environment keys and OpenCode's built-in ChatGPT logins pass through unchanged. Selecting the pool login as the active OpenAI connection enables pool routing; selecting another credential bypasses it. If no pool account can serve, the request is refused locally, never sent with the marker.

### Vault-only hosts

To use only the [Claustrum vault](vault.md), enroll OpenCode first, then choose **ChatGPT accounts in the vault**, or run `opencode2 auth login openai --method openai-auth-vault` (use your OpenCode 2 executable's name). This activates vault routing without browser sign-in or a local pool account; OpenCode 2 stores only the placeholder. OpenCode 1 and 2 share the `openai-auth-opencode` enrollment and its token/state files; vault login refuses until that enrollment is approved.

## How it differs from OpenCode 1

- **OpenCode 2 sends the requests itself**, through its own OpenAI driver over HTTP or its WebSocket. The plugin picks the account and sets that account's `Authorization` and `chatgpt-account-id` through OpenCode 2's session hooks (`@cortexkit/common-auth/opencode2`), and edits the requests only where OpenCode 1's behaviour needs it (below).
- **Codex client identity.** Every pool request and every plugin-managed WebSocket handshake carries the identity OpenCode 1 sends: `version` (`0.159.0`), `originator: codex_exec` and Codex's `user-agent`. It is the same for every request of a session, so OpenCode 2 keeps reusing the session's WebSocket.
- **Mid-conversation reasoning effort.** OpenCode 2 carries an effort change for `gpt-6-astra`, `gpt-6-sol` and `gpt-6-luna` itself: the request keeps the session's first effort and the change goes in as a `configuration_update` item, so the conversation stays cached. OpenCode 2.0.22 does the same for `gpt-6.1-sol`; OpenCode 2.0.21 does not, so the plugin applies the same rule to `gpt-6.1-sol` (on 2.0.22 it finds the host's request already in that shape and changes nothing). Over HTTP the item rides every request after the change, just before the turn's user message; over the WebSocket it goes on the frame that starts the turn, and the server keeps it for the turn's tool steps. OpenCode 2.0.21 sends the turn whose effort changed as a full request rather than a continuation; the turns after it chain again on the same socket. Responses keep reporting the session's first effort, as on OpenCode 1.
- **One account pool for both OpenCode versions.** OpenCode 2 uses OpenCode 1's pool files (`~/.config/opencode/openai-auth.json` and its state file). If the main login is still in OpenCode 1's `auth.json`, the first plugin start moves it into pool row `main`. Migration waits until every running OpenCode process uses this plugin version or newer, so every process understands the pool. Until migration finishes, requests using the pool placeholder are refused locally.
- **Logins land in the pool.** The plugin's browser and headless pool logins appear alongside OpenCode 2's built-in ChatGPT methods, whose refresh handlers stay intact. Signing in again replaces an existing pool account's credential. A new login becomes `main` if the pool has no `main`; otherwise it adds an account. OpenCode 2 stores only the placeholder, not the pool's tokens. A ChatGPT login OpenCode 2 already holds is never copied into the pool: OpenCode 2 keeps ownership of its refresh tokens. Choose a pool login for a separate OAuth sign-in. While OpenCode is connected to the vault, pool login is refused before the browser opens and writes nothing.
- **Routing** follows the same [account-order and quota-guard settings](accounts-and-routing.md#routing). A session's background work, such as generating its title or compacting its context, uses its assigned account. These session-to-account assignments, or **pins**, live in the server process; after a server restart, accounts are chosen again.
- **Rate limits.** A usage-limit or rate-limit refusal marks the refusing account limited. If no output has started, the request is retried on another account. Once output starts, it is never retried.
- **Quota** from the `x-codex-*` response headers and `codex.rate_limits` frames is recorded on the account that served.
- **Claustrum vault accounts** replace the pool's own while OpenCode is connected to the vault. OpenCode 1 and 2 share one enrollment; connect with setup or OpenCode 1's `opencode auth login` menu. No pool account is used, refreshed or polled while connected, and only ChatGPT logins are used, never API keys. Each request asks the vault for its token; if the vault refuses, another vault account is tried before anything is sent. If none can serve, the request is refused locally. An HTTP 401 is reported against the exact vault credential version used; a refused WebSocket handshake reaches no reporting hook. A vault account starts serving after its first background quota reading.
- **Responses Lite** (`responsesLite: true`) applies to HTTP requests for the Lite models. Over the WebSocket the standard request shape is sent: the Lite shape moves `tools` and `instructions` into the input, which would put the server's view of the conversation out of step with OpenCode 2's own continuation.
- **Models**: the same allow and deny lists and context caps as on OpenCode 1.

## Model costs

On OpenCode 2, models show OpenCode's own prices, even when you use the plugin's ChatGPT accounts (on OpenCode 1 they show as free), and Pro reasoning models are not hidden. OpenCode 2's model-list hook can't tell which credential is in use when it runs, so changing costs there would also change them for an OpenAI API key.

## The `/openai` menu

On OpenCode 2, [`/openai`](commands.md#the-openai-command) shows the same sections as on OpenCode 1: Accounts, Quota, Routing, Limits, This session and Vault. From it you can add accounts (browser or headless sign-in), turn accounts on and off, remove them after confirming, set their order and the routing mode, check quota, set quota floors and the killswitch, and clear the current session's account pin. The main account can't be removed; to replace the main login, use `opencode auth login`.

While connected to the [vault](vault.md), the menu shows only vault accounts, and local account changes are refused. Quota checks, routing, floors, the killswitch and clearing a pin still work. Cache, Diagnostics and Reset credits show "Not available on OpenCode 2 yet."

## Not on OpenCode 2 yet

The menu's vault enrollment and per-host account controls, the sidebar, [cache keep-warm](cache-keep-warm.md), [request dumps](troubleshooting.md#request-dumps), diagnostics actions, [reset-credit preview and redemption](accounts-and-routing.md#reset-credits), OpenCode 1's extra conversation headers and Codex-specific tool formatting are not implemented on OpenCode 2 yet.

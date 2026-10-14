# OpenCode 2

The same package, `@cortexkit/opencode-openai-auth`, runs on OpenCode 2 (`@opencode/cli`, tested on 2.0.22).

## Manual install

OpenCode 2 loads the plugin from the package's `./server` entry. OpenCode 1 also prefers that entry over the package root, so the entry carries the same OpenCode 1 plugin as the root as well. List the package under `plugins`:

```json
{
  "plugins": ["@cortexkit/opencode-openai-auth@1.0.3"]
}
```

or run `opencode plugin add @cortexkit/opencode-openai-auth`.

## Signing in

Sign in with `opencode auth login openai` (or the TUI) and pick **ChatGPT (openai-auth pool, browser)** or **ChatGPT (openai-auth pool, headless)**.

Only requests whose host-prepared Authorization bearer exactly matches the pool placeholder are served by the plugin. API keys, environment keys and OpenCode's own ChatGPT logins pass through unchanged, without pool quota or attribution. Switching the selected OpenAI connection between a pool login and another credential changes whether the next request uses pool routing or passes through. A placeholder with no usable pool account is refused locally, never sent upstream.

### Vault-only hosts

For an enrolled host that uses only the [Claustrum vault](vault.md), choose **ChatGPT accounts in the vault**, or run `opencode2 auth login openai --method openai-auth-vault` (use your OpenCode 2 executable's name). This activates vault routing without OAuth or a pool account. The host's credential row holds only the placeholder, under the vault method's ID. An unenrolled host is refused with a fixed message; enrollment uses the same `openai-auth-opencode` name and files as OpenCode 1.

## How it differs from OpenCode 1

- **OpenCode 2 sends the requests itself**, through its own OpenAI driver over HTTP or its WebSocket. The plugin picks the account and sets that account's `Authorization` and `chatgpt-account-id` through OpenCode 2's session hooks (`@cortexkit/common-auth/opencode2`), and edits the requests only where OpenCode 1's behaviour needs it (below).
- **Codex client identity.** Every pool request and every owned WebSocket handshake carries the identity OpenCode 1 sends: `version` (`0.159.0`), `originator: codex_exec` and Codex's `user-agent`. It is the same for every request of a session, so OpenCode 2 keeps reusing the session's WebSocket. (The backend refuses `gpt-6.1-sol` from a client stating an older version, such as `0.158.0`; in a probe on 2026-10-01 it served a request that stated no version at all.)
- **Mid-conversation reasoning effort.** OpenCode 2 carries an effort change for `gpt-6-astra`, `gpt-6-sol` and `gpt-6-luna` itself: the request keeps the session's first effort and the change goes in as a `configuration_update` item, so the conversation stays cached. OpenCode 2.0.22 does the same for `gpt-6.1-sol`; OpenCode 2.0.21 does not, so the plugin applies the same rule to `gpt-6.1-sol` (on 2.0.22 it finds the host's request already in that shape and changes nothing). Over HTTP the item rides every request after the change, just before the turn's user message; over the WebSocket it goes on the frame that starts the turn, and the server keeps it for the turn's tool steps. OpenCode 2.0.21 sends the turn whose effort changed as a full request rather than a continuation; the turns after it chain again on the same socket. Responses keep reporting the session's first effort, as on OpenCode 1.
- **One account pool for both hosts.** The [account pool](accounts-and-routing.md#the-account-pool) is the shared on-disk store for local ChatGPT accounts and their credentials. OpenCode 2 reads and writes the same files as OpenCode 1 (`~/.config/opencode/openai-auth.json` and its state file). An install whose accounts are not in the shared account pool yet (the main login still in OpenCode 1's own login store) moves them there on the first OpenCode 2 start, the same way OpenCode 1 does: OpenCode 1's `openai` login (`~/.local/share/opencode/auth.json`) becomes row `main`, and the move waits until no older openai-auth process is running. Until then, requests using the pool placeholder are refused locally.
- **Logins land in the pool.** The two pool login methods are registered alongside OpenCode 2's built-in ChatGPT methods, leaving their refresh handlers intact. Signing in again with an account the pool already holds replaces that account's credential; the first login of a pool with no `main` account becomes `main`; any other login adds an account. OpenCode 2 itself only stores a placeholder that works against nothing. A ChatGPT login OpenCode 2 already holds is never copied into the pool: its single-use refresh tokens remain owned by the host. Choose a pool login to complete a separate OAuth flow with its own token family. While the host is connected to the vault, a pool login is refused before the browser opens and nothing is written to the pool.
- **Routing** follows the same settings (`main-first`, `fallback-first`, `sticky-balanced`, the killswitch and quota floors). A session's side requests (title, compaction, generate) go to the session's account. Sticky pins live in the server process, so a restarted server places its sessions again.
- **Rate limits.** A usage-limit or rate-limit refusal that arrives before any output is retried at once on another account, and that account is marked limited. Once output has started, a request is never retried.
- **Quota** from the `x-codex-*` response headers and `codex.rate_limits` frames is recorded on the account that served.
- **Claustrum vault accounts** replace the pool's own while this host is connected to the vault, with OpenCode 1's rules: enroll from OpenCode 1 (`opencode auth login`, Connect); OpenCode 2 uses the same enrollment. No pool account is used, refreshed or polled while connected, and only ChatGPT logins are used, never API keys. Each request on a vault account asks the vault for that request's token; if the vault refuses, the request goes to the next vault account before anything is sent, and is refused locally when none is left. A 401 on that request is reported to the vault against the exact record version it used (HTTP only: a refused WebSocket handshake reaches no hook). A vault account starts serving once it has a quota reading, taken in the background shortly after OpenCode 2 starts the plugin.
- **Responses Lite** (`responsesLite: true`) applies to HTTP requests for the Lite models. Over the WebSocket the standard request shape is sent: the Lite shape moves `tools` and `instructions` into the input, which would put the server's view of the conversation out of step with OpenCode 2's own continuation.
- **Models**: the same allow and deny lists and context caps as on OpenCode 1.

## Not on OpenCode 2 yet

The `/openai` menu and the sidebar (account management works from OpenCode 1, or `opencode auth login` there), [cache keep-warm](cache-keep-warm.md), request dumps, reset credits, cost zeroing, and Codex request shaping such as turn-metadata headers, `thread-id` and `x-codex-*` headers, and tool normalisation. Only requests using the selected pool placeholder are served from the pool and vault; other OpenAI credentials remain under the host's control.

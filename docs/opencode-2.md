# OpenCode 2

The OpenCode package, `@cortexkit/opencode-openai-auth`, runs on OpenCode 2 (`@opencode/cli`, tested on 2.0.22).

## Manual install

OpenCode 2 loads the plugin from the package's `./server` entry. OpenCode 1 also prefers that entry over the package root, so the entry carries the same OpenCode 1 plugin as the root as well. List the package under `plugins`:

```json
{
  "plugins": ["@cortexkit/opencode-openai-auth@1.6.0"]
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
- **Codex request shape over HTTP.** Pool requests sent over HTTP carry the same conversation headers and tool formatting as on OpenCode 1: each session keeps one conversation id, each of your messages starts a new turn while the tool steps of that turn stay in it, and tool definitions are sent in Codex's format. A session keeps its conversation id after a server restart, so OpenAI can keep using the prompt it cached for that conversation.
- **Codex request shape over the WebSocket.** Pool requests sent over OpenCode 2's WebSocket get OpenCode 1's WebSocket request shape: the session's conversation id, Codex's tool format and field order, and the same turns. Each of your messages starts a new turn. A tool step stays in its turn, and so does a request OpenCode 2 sends again on another account after a refusal. The conversation goes out exactly as OpenCode 2 built it, apart from the effort item described below, so OpenAI's copy stays the one OpenCode 2 continues from. The connection itself is opened as before, so OpenCode 2 keeps one WebSocket per account.
- **Mid-conversation reasoning effort.** OpenCode 2 carries an effort change for `gpt-6-astra`, `gpt-6-sol` and `gpt-6-luna` itself: the request keeps the session's first effort and the change goes in as a `configuration_update` item, so the conversation stays cached. OpenCode 2.0.22 does the same for `gpt-6.1-sol`; OpenCode 2.0.21 does not, so the plugin applies the same rule to `gpt-6.1-sol` (on 2.0.22 it finds the host's request already in that shape and changes nothing). Over HTTP the item rides every request after the change, just before the turn's user message; over the WebSocket it goes on the frame that starts the turn, and the server keeps it for the turn's tool steps. OpenCode 2.0.21 sends the turn whose effort changed as a full request rather than a continuation; the turns after it chain again on the same socket. Responses keep reporting the session's first effort, as on OpenCode 1.
- **One account pool for both OpenCode versions.** OpenCode 2 uses OpenCode 1's [pool and state files](accounts-and-routing.md#the-account-pool), with the same home-directory defaults and environment overrides on Windows, Linux and macOS. If the main login is still in OpenCode 1's `auth.json`, the first plugin start moves it into pool row `main`. Migration waits until every running OpenCode process uses this plugin version or newer, so every process understands the pool. Until migration finishes, requests using the pool placeholder are refused locally.
- **Logins land in the pool.** The plugin's browser and headless pool logins appear alongside OpenCode 2's built-in ChatGPT methods, whose refresh handlers stay intact. Signing in again replaces an existing pool account's credential. A new login becomes `main` if the pool has no `main`; otherwise it adds an account. OpenCode 2 stores only the placeholder, not the pool's tokens. A ChatGPT login OpenCode 2 already holds is never copied into the pool: OpenCode 2 keeps ownership of its refresh tokens. Choose a pool login for a separate OAuth sign-in. While OpenCode is connected to the vault, pool login is refused before the browser opens and writes nothing.
- **Routing** follows the same [account-order and quota-guard settings](accounts-and-routing.md#routing). A session's background work, such as generating its title or compacting its context, uses its assigned account. These session-to-account assignments, or **pins**, live in the server process; after a server restart, accounts are chosen again.
- **New sessions are placed by session count, not request size**, on both HTTP and WebSocket. OpenCode 2 asks for an account before the request exists, so its size is not available when choosing the account.
- **HTTP cache keep-warm** is available in the Cache section of `/openai`, with the same settings and limits as on OpenCode 1. The plugin's warming is invisible to the session; OpenCode 2's own `warming` sends a model-visible keep-alive message. Both can be on: a host keep-alive immediately discards the plugin's saved request for that session, stopping the plugin's warming until the next real request. If you turn off OpenCode's warming, the plugin waits for the session's next real request before warming it again. See [cache keep-warm](cache-keep-warm.md).
- **Rate limits.** A usage-limit or rate-limit refusal marks the refusing account limited. Before output, the retry hook chooses the next account once and keeps it for that attempt, without choosing a second time. Another account retries at once; if only the refused account can serve, OpenCode keeps its own retry decision and wait. An empty choice changes no session pin, pending input bytes or active account. A kept choice discarded by a model/agent change or session cleanup releases its pending reservation and vault receipt before another choice for that session. Primary choices and kept retries reserve live pending bytes before credential authorization yields, so concurrent sessions across projects still spread. Retry choices publish their committed pin and active account only when the account's headers are used; unused reservations are released without touching another session. Once output starts, it is never retried.
- **Quota** from the `x-codex-*` response headers and `codex.rate_limits` frames is recorded on the account that served.
- **Claustrum vault accounts** replace the pool's own while OpenCode is connected to the vault. OpenCode 1 and 2 share one enrollment; connect with setup or OpenCode 1's `opencode auth login` menu. No pool account is used, refreshed or polled while connected, and only ChatGPT logins are used, never API keys. Each request asks the vault for its token; if the vault refuses, another vault account is tried before anything is sent. If none can serve, the request is refused locally. An HTTP 401 is reported against the exact vault credential version used; a refused WebSocket handshake reaches no reporting hook. A vault account starts serving after its first background quota reading.
- **Responses Lite** (`responsesLite: true`) applies to HTTP requests for the Lite models. Over the WebSocket the standard request shape is sent: the Lite shape moves `tools` and `instructions` into the input, which would put the server's view of the conversation out of step with OpenCode 2's own continuation.
- **Models**: the same allow and deny lists and context caps as on OpenCode 1.

## Model costs

On OpenCode 2, models show OpenCode's own prices, even when you use the plugin's ChatGPT accounts (on OpenCode 1 they show as free), and Pro reasoning models are not hidden. OpenCode 2's model-list hook can't tell which credential is in use when it runs, so changing costs there would also change them for an OpenAI API key.

## The `/openai` menu

On OpenCode 2, [`/openai`](commands.md#the-openai-command) shows the same sections as on OpenCode 1: Accounts, Quota, Routing, Limits, Cache, Diagnostics, Reset credits, This session and Vault. From it you can add accounts (browser or headless sign-in), turn accounts on and off, remove them after confirming, set their order and the routing mode, check quota, set quota floors and the killswitch, set the log level in Diagnostics, turn request dumps on and off, preview an account's [reset credits](accounts-and-routing.md#reset-credits), spend one or retry the last redemption, and clear the current session's account pin. The log level takes effect immediately and is saved for the next start. [Request dumps](troubleshooting.md#request-dumps) may contain prompt and session content; the menu warns you when you turn them on. Turn them off after debugging. Preview shows an account's quota, its reset credits and whether one can be spent, and spends nothing. A reset credit is spent only after you confirm it, and a spent credit can't be given back. The main account can't be removed; to replace the main login, use `opencode auth login`.

While connected to the [vault](vault.md), the menu shows only vault accounts, and local account changes are refused. Routing → **Set order** accepts the displayed vault names (email when available) and reorders the vault roster, not the local pool. Quota checks, routing, floors, the killswitch, log level changes, request dumps and clearing a pin still work. Reset credits works only with local accounts, so while connected it says the accounts are managed in the vault and spends nothing, as on OpenCode 1. Cache shows the tracked HTTP and WebSocket sessions and lets you turn keep-warm and subagent warming on or off, sustain main sessions past their idle cap, and set the hours when warming is allowed.

## Sidebar

OpenCode 2 shows the same quota sidebar as OpenCode 1: each account's quota bars, figures and time until reset, the account and route the current session uses, health and killswitch status, and saved reset credits. In vault mode it shows only vault accounts. Click its title to collapse or expand it.

Collapsed, the sidebar keeps one line per account it shows, in the order requests try them: the account name, then its remaining quota such as `5h 38% · 7d 59% left`, then a status dot (a red ⊘ when the killswitch blocks the account). The account serving the current session is drawn in its usage color and the others dimmed; an account whose last reading is old is dimmed too. A name too long for the sidebar ends in `…`, so the quota figures always show in full. An account without a reading yet shows `—`. Both OpenCode 1 and OpenCode 2 draw it this way.

Vault accounts stay listed even when they cannot serve a request, with their last quota reading and a short reason such as **needs sign-in**, **turned off in vault** or **unavailable**. **Off in /openai** is your own toggle, shown separately from the vault's state. **Blocked** means the account is below its configured quota floor. Switching to vault mode removes old local session records from the sidebar; vault pins still follow the usual routing rules.

One difference: OpenCode 2 always places the sidebar after its own panels, so the position preference (`priority` and `forceToTop` in `tui-preferences.jsonc`) has no effect there.

## Not on OpenCode 2 yet

The menu's vault enrollment and per-host account controls are not implemented on OpenCode 2 yet.

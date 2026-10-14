# Accounts and routing

## Multiple accounts

The plugin supports more than one ChatGPT account: a single **main** account plus any number of **fallback** accounts. When the account serving a request hits a rate limit, traffic rolls over to a healthy fallback for the rest of the limit window, then returns.

On OpenCode, the main account is the one you sign in to with a local ChatGPT method of `/login openai` (see [Configuration](configuration.md#signing-in-on-opencode-1)). On Pi, it is the login you signed in to Pi with (see [Pi](#pi)).

- **Add a fallback** from the Accounts section of [`/openai`](commands.md#the-openai-command) (browser or device-code sign-in), or from `opencode auth login`.
- **Remove, disable or reorder** accounts from the same section. Row `main` is never removed.
- Each account is identified by its stable ChatGPT account id, so the same account is never added twice.

Which account serves is decided by the [routing mode](#routing). There is no manual active-account selector: `sticky-balanced` creates a session pin automatically, while the other modes follow their configured order. A request that a fallback can serve is buffered so the retry is safe, and selection skips accounts the [killswitch](#killswitch) has gated out.

While a host is connected to the [Claustrum vault](vault.md), the vault's accounts take the place of all of these, under the same routing modes and limits.

## The account pool

On OpenCode, every local ChatGPT account and its credential live in one shared on-disk store, the account pool, in `~/.config/opencode/openai-auth.json` and its state file. OpenCode 1 and OpenCode 2 use the same files.

An install from before the pool keeps its main login in OpenCode 1's own login store (`~/.local/share/opencode/auth.json`). The plugin moves it into the pool as row `main`, and replaces OpenCode's login with an OAuth placeholder whose access token is empty. The move waits until no older openai-auth process is running; until every OpenCode process on the machine runs a version that understands the pool and the accounts have moved, `/openai` shows only that notice and the processes still holding the move back. A ChatGPT login written into OpenCode's `openai` slot later is adopted into the pool the same way.

Downgrading after the account-pool migration is unsupported. A pre-1.0 build that does not understand the placeholder would send an empty bearer instead of reading the account pool. Keep the pool-aware build, or sign in afresh in a separate store before using an older build.

When `OPENCODE_AUTH_CONTENT` supplies OpenCode 1's login, the slot is read-only for migration and adoption. The plugin leaves the environment login and `auth.json` untouched and keeps using the login as before; unset the override to migrate the login on disk.

Development installs that ran an unreleased build may hold an untagged placeholder, left by an interrupted move of the login from OpenCode's slot into the account pool, together with the unfinished record of that move. Placeholders written by released builds carry a tag recording which config root wrote them; an untagged one cannot show whether this store or another store sharing `auth.json` moved the login. Its credential is therefore kept but disabled, rather than deleted or assumed to belong to this store. The auth doctor lists the row: sign in again with `opencode auth login`, or re-enable it only if this config root is the only one using that `auth.json`. Development migrations that already completed with an untagged placeholder keep working unchanged, including later login adoption.

How the pool behaves in vault mode is described in [Claustrum vault](vault.md#vault-mode).

## Routing

The Routing section of `/openai` sets the routing mode and the roster order:

| Mode | Behavior |
| --- | --- |
| `ordered` | Try the accounts in roster order (set the order in the same section). |
| `main-first` (default) | Send on the main account; on a `401`, `403` or `429`, retry on the next usable fallback. |
| `fallback-first` | Try usable fallback accounts first (preserving the main account's quota), and fall through to the main account only if no fallback can serve. |
| `sticky-balanced` | For a cold session, choose the account with the lowest projected pressure against its usable quota, and keep that account pinned for the session. |

### Sticky-balanced

`sticky-balanced` does not rebalance mid-session. A pin stays in place until fresh quota confirms exhaustion or the account has a permanent authentication failure (`401`/`403`). A transient failure, stale or unknown quota, and a `429` without confirmed exhaustion keep the pin; there is no Retry-After hold. This avoids changing accounts while a session's continuation and cache context still belong to the first account.

Pins are keyed by a SHA-256 hash of the session id in the machine-global sidebar state, and expire after seven days. Cold placement excludes accounts with stale (older than 15 minutes) or unknown quota from weighted selection. If no account is left for weighted selection, placement fails open: it picks an account with applicable reset credits first, then follows configured order, then account id. When the killswitch is on, accounts below their floors are excluded from both weighted selection and the fail-open branch; if the killswitch excludes every account, the request is blocked rather than sent. Equal projected-pressure scores break by configured order, then account id; a shared pending-byte bridge makes simultaneous cold placements account for each other.

Subagents receive independent pins, and a resumed subagent reuses its own pin. The **This session** section of `/openai` clears only the current session's pin, so the next placement may choose the same account again.

## Killswitch

The killswitch blocks requests for an account once its quota drops below a floor, instead of letting the request through and using up the last of a window. The Limits section of `/openai` turns it on or off and sets each account's floors: the minimum percent left in the 5-hour (`primary`) and weekly (`secondary`) windows. A window without a floor never blocks. Turning the killswitch on before any floors are set gives every account the default floors: 5% left in the 5-hour window and 10% in the weekly window.

Thresholds saved by earlier versions (a `main` block, `5h`/`1w` names, accounts inheriting `main` or the 5%/10% defaults) are rewritten as explicit per-account floors the first time `/openai` saves a setting, so the same quota blocks the same requests.

## Quota

Codex reports usage on two rolling windows: a 5-hour primary window and a weekly secondary window. The plugin reads quota passively, per turn, from whichever transport is in use, so there is no extra polling during normal work:

- **HTTP/SSE:** the `x-codex-*` response headers on every reply.
- **WebSocket:** the in-band `codex.rate_limits` frame.

The Quota section of `/openai` shows every account's windows and credit budget; **Check now** polls the usage endpoint for the main account and every fallback, so even accounts that have never served show fresh numbers. Quota for the active account is also shown in the OpenCode sidebar (used percent, reset countdown and a pacing estimate).

## Reset credits

The Reset credits section of `/openai` previews an account, spends one rate-limit reset credit after explicit confirmation, or retries the last redemption.

## Pi

On Pi, every request goes out with one account's token, chosen by the routing mode:

- `main-first` tries your Pi login first, then the fallbacks in order; `fallback-first` tries the fallbacks first and your Pi login last. When an account answers with a rate-limit or authentication error before anything was streamed, the next one is tried.
- `sticky-balanced` keeps each Pi session on one account, spreading sessions by remaining quota, and moves a session for good only when its account is confirmed exhausted.

Your Pi login stays where Pi keeps it: Pi refreshes it, and the extension only uses the token Pi hands it. Fallback accounts live in the extension's own store (`openai-auth.json` in Pi's agent directory, `~/.pi/agent` unless `PI_AGENT_DIR` says otherwise, or the file `PI_OPENAI_AUTH_FILE` names) and are refreshed there. A fallback that is the same ChatGPT account as your Pi login is never used twice. An account is used only once its quota is known: each account's quota is checked as soon as the extension sees it, and quota from every response keeps it current. A store written by an earlier version is converted to the account-pool format the first time it is read, keeping its accounts.

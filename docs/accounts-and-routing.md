# Accounts and routing

## Multiple accounts

The plugin supports a **main** ChatGPT account plus **fallback** accounts to use when the chosen account cannot serve a request. The [routing mode](#routing) decides when to switch accounts.

On [OpenCode 1](configuration.md#signing-in-on-opencode-1), your initial ChatGPT login becomes `main`. On [OpenCode 2](opencode-2.md#signing-in), use the plugin's pool-login methods. On Pi, `main` is Pi's own login (see [Pi](#pi)).

- **Add a fallback** from the Accounts section of the plugin's [`/openai` slash command](commands.md#the-openai-command) (browser or device-code sign-in), or from `opencode auth login`.
- **Remove, disable or reorder** accounts from the same section. Row `main` is never removed.
- Each account is identified by its stable ChatGPT account id, so the same account is never added twice.

There is no manual active-account selector: `sticky-balanced` assigns each session to one account (a **pin**), while other modes follow their configured order. OpenCode 1 buffers eligible request bodies so a refused attempt can replay the same input on a fallback without losing the body or duplicating output. If the connection fails without a provider response, it does not switch accounts: the provider may already have processed the request. Selection skips accounts blocked by the [killswitch quota guard](#killswitch).

When OpenCode or Pi is connected to the [Claustrum vault](vault.md), the vault's accounts replace its local accounts, under the same routing modes and limits.

## The account pool

On OpenCode, every local ChatGPT account and its credential live in one shared on-disk store, the account pool, in `~/.config/opencode/openai-auth.json` and its state file. OpenCode 1 and OpenCode 2 use the same files.

An install from before the pool keeps its main login in OpenCode 1's login store (`~/.local/share/opencode/auth.json`). The plugin moves it into pool row `main` and replaces OpenCode's login with a **placeholder**: a non-secret login record with an empty access token. The plugin recognizes this marker and reads the real credentials from the pool instead.

Moving the main login waits until every running OpenCode process uses this plugin version or newer, so every process understands the pool. Until migration finishes, `/openai` shows an **Accounts are moving** notice and lists any processes blocking it. A ChatGPT login written into OpenCode's `openai` slot later is adopted into the pool the same way.

Downgrading after the account-pool migration is unsupported. A pre-1.0 build that does not understand the placeholder would send an empty bearer instead of reading the account pool. Keep the pool-aware build, or sign in afresh in a separate store before using an older build.

When `OPENCODE_AUTH_CONTENT` supplies OpenCode 1's login, the slot is read-only for migration and adoption. The plugin leaves the environment login and `auth.json` untouched and keeps using the login as before; unset the override to migrate the login on disk.

An interrupted migration in an unreleased development build may leave an untagged placeholder and an unfinished transfer record. Released builds tag placeholders with their configuration directory; without that tag, the plugin cannot tell which store sharing `auth.json` owns the login, so it keeps the credential but disables the row. **Auth doctor**, the credential checks and repairs in `opencode auth login`, lists it: sign in again, or re-enable it only if this configuration directory is the only one using that `auth.json`. If an unreleased build already finished moving the main login, its pool accounts remain usable and later slot logins can still be imported.

How the pool behaves in vault mode is described in [Claustrum vault](vault.md#vault-mode).

## Routing

The Routing section of `/openai` sets the routing mode and account order:

| Mode | Behavior |
| --- | --- |
| `ordered` | Try the accounts in roster order (set the order in the same section). |
| `main-first` (default) | Send on the main account; on a `401`, `403` or `429`, retry on the next usable fallback. |
| `fallback-first` | Try usable fallback accounts first (preserving the main account's quota), and fall through to the main account only if no fallback can serve. |
| `sticky-balanced` | For a session with no pin, choose the account with the lowest projected pressure: estimated request load relative to available quota capacity. Keep that assignment. |

### Sticky-balanced

`sticky-balanced` does not rebalance just to even out usage. Confirmed quota exhaustion, a [killswitch block](#killswitch), or a permanent authentication failure (`401`/`403`) can move the pin. Transient failures and stale or unknown quota keep the pin. A `429` without confirmed exhaustion is returned to OpenCode; the next request stays on the same account, without a timed pause imposed by the plugin. This keeps the session's continuation and prompt cache on their original account.

On OpenCode 1, pins are saved under hashed session ids in the machine-wide sidebar state and expire after seven days. On OpenCode 2, all locations using the same account store in one server process share pins and pending input bytes in memory. Pins survive location eviction and `/reload`, but not a server restart.

For a **cold session** (one with no pin), the score compares request size plus pending input bytes against capacity estimated from quota left, [reserved floors](#killswitch), reset timing and credit budget. Accounts with quota older than 15 minutes or unknown quota are excluded from this scoring. If no account can be scored, selection prefers accounts with usable [rate-limit reset credits](#reset-credits), then configured order, then account id. Accounts below their floors remain excluded even in that fallback; if none can serve, the request is blocked. Equal pressure scores break by configured order, then account id; simultaneous new placements count toward each other's estimated demand.

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
- `sticky-balanced` keeps each Pi session on one account, spreading new sessions by remaining quota; confirmed exhaustion causes a lasting account switch.

Your Pi login stays where Pi keeps it: Pi refreshes it, and the extension only uses the token Pi hands it. Fallback accounts live in the extension's own store (`openai-auth.json` in Pi's agent directory, `~/.pi/agent` unless `PI_AGENT_DIR` says otherwise, or the file `PI_OPENAI_AUTH_FILE` names) and are refreshed there. A fallback that is the same ChatGPT account as your Pi login is never used twice. An account is used only once its quota is known: each account's quota is checked as soon as the extension sees it, and quota from every response keeps it current. A store written by an earlier version is converted to the account-pool format the first time it is read, keeping its accounts.

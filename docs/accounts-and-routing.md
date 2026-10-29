# Accounts and routing

These instructions apply to Windows, Linux and macOS. Paths written with `~` mean the user's home directory; the plugin uses the operating system's native path separators.

## Multiple accounts

The plugin supports a **main** ChatGPT account plus **fallback** accounts to use when the chosen account cannot serve a request. The [routing mode](#routing) decides when to switch accounts.

On [OpenCode 1](configuration.md#signing-in-on-opencode-1), your initial ChatGPT login becomes `main`. On [OpenCode 2](opencode-2.md#signing-in), use the plugin's pool-login methods. On Pi, `main` is Pi's own login (see [Pi](#pi)).

- **Add a fallback** from the Accounts section of the plugin's [`/openai` slash command](commands.md#the-openai-command) (browser or device-code sign-in), or from `opencode auth login`.
- **Remove, disable or reorder** accounts from the same section. Row `main` is never removed.
- Each account is identified by its stable ChatGPT account id, so the same account is never added twice.

There is no manual active-account selector: `sticky-balanced` assigns each session to one account (a **pin**), while other modes follow their configured order. OpenCode 1 buffers eligible request bodies so a refused attempt can replay the same input on a fallback without losing the body or duplicating output. If the connection fails without a provider response, it does not switch accounts: the provider may already have processed the request. Selection skips accounts blocked by the [killswitch quota guard](#killswitch).

When OpenCode or Pi is connected to the [Claustrum vault](vault.md), the vault's accounts replace its local accounts, under the same routing modes and limits.

## The account pool

On OpenCode, every local ChatGPT account and its credential live in one shared on-disk store, the account pool. The default files are `openai-auth.json` in `.config/opencode` under the user's home directory (shown here as `~/.config/opencode`), and `openai-auth-state.json`, which holds the credentials, in the plugin's state folder `~/.local/state/cortexkit/openai-auth/opencode`, on Windows, Linux and macOS (see [Where the files live](configuration.md#where-the-files-live)). `XDG_CONFIG_HOME` changes the base config directory, `OPENCODE_CONFIG_DIR` overrides OpenCode's config directory, `XDG_STATE_HOME` changes the base state directory, and `OPENCODE_OPENAI_AUTH_FILE` and `OPENCODE_OPENAI_AUTH_STATE_FILE` can name the pool and state files directly. OpenCode 1 and OpenCode 2 use the same files.

An install from before the pool keeps its main login in OpenCode 1's login store (`auth.json`). The plugin moves it into pool row `main` and replaces OpenCode's login with a **placeholder**: a non-secret login record with an empty access token and a fixed refresh-token marker. The plugin recognizes this placeholder record and reads the real credentials from the pool instead.

Moving the main login waits until every running OpenCode process uses this plugin version or newer, so every process understands the pool. Until migration finishes, `/openai` shows an **Accounts are moving** notice and lists any processes blocking it. A ChatGPT login written into OpenCode's `openai` slot later is adopted into the pool the same way.

Downgrading after the account-pool migration is unsupported. A pre-1.0 build that does not understand the placeholder would send an empty bearer instead of reading the account pool. Keep the pool-aware build, or sign in afresh in a separate store before using an older build.

When `OPENCODE_AUTH_CONTENT` supplies OpenCode 1's login, the slot is read-only for migration and adoption. The plugin leaves the environment login and `auth.json` untouched and keeps using the login as before; unset the override to migrate the login on disk.

An interrupted migration in an unreleased development build may leave an untagged placeholder and an unfinished transfer record. Released builds tag placeholders with their configuration directory; without that tag, the plugin cannot tell which store sharing `auth.json` owns the login, so it keeps the credential but disables the row. **Auth doctor**, the credential checks and repairs in `opencode auth login`, lists the disabled account row: sign in again, or re-enable the row only if this configuration directory is the only one using that `auth.json`. If an unreleased build already finished moving the main login, its pool accounts remain usable and later slot logins can still be imported.

How the pool behaves in vault mode is described in [Claustrum vault](vault.md#vault-mode).

## Routing

The Routing section of `/openai` sets the routing mode and account order:

| Mode | Behavior |
| --- | --- |
| `ordered` | Try the accounts in roster order (set the order in the same section). |
| `main-first` (default) | Send on the main account; on a `401`, `403` or `429`, retry on the next usable fallback. |
| `fallback-first` | Try usable fallback accounts first (preserving the main account's quota), and fall through to the main account only if no fallback can serve. |
| `sticky-balanced` | For a session with no pin, choose the account with the lowest projected pressure: estimated request load relative to available quota capacity. Keep that assignment. |

In vault mode, **main** means the vault's default OpenAI account: the credential named exactly `chatgpt:openai`, without an alias suffix. **Main first** tries that account first; **Fallback first** tries it last. No local login is used. If the vault has only aliased accounts, both modes use roster order like **Ordered**, and Routing explains that there is no default vault account. Sticky balanced keeps a session's assigned vault account while it can serve. **Set order** in Routing changes this host's vault roster on OpenCode 1, OpenCode 2 and Pi, not its dormant local pool. Enter every displayed account name (email when available), separated by commas, in the desired order. Route ids are also accepted; use them when names are ambiguous. Local mode continues to order local account ids.

### Sticky-balanced

`sticky-balanced` does not rebalance just to even out usage. Confirmed quota exhaustion, a [killswitch block](#killswitch), or a permanent authentication failure (`401`/`403`) can move the pin. Transient failures and stale or unknown quota keep the pin. A `429` without confirmed exhaustion is returned to OpenCode; the next request stays on the same account, without a timed pause imposed by the plugin. This keeps the session's continuation and prompt cache on their original account.

On OpenCode 1, pins are saved under hashed session ids in the machine-wide sidebar state and expire after seven days. On OpenCode 2, all locations using the same account store in one server process share pins and pending input bytes in memory. Pins survive when OpenCode evicts a location's cached project state, and survive `/reload`, but not a server restart. In-flight primary choices and kept retries reserve pending input bytes before credential authorization can yield, so concurrent cold sessions in different projects still spread across accounts. A failure before a choice commits, or discarding a kept retry before its headers are used, releases only that choice's reservation; provisional reservations never evict another session's committed pin.

For a **cold session** (one with no pin), the score compares request size plus pending input bytes against capacity estimated from quota left, [reserved floors](#killswitch), reset timing and credit budget. Accounts with quota older than 15 minutes or unknown quota are excluded from this scoring. If no account can be scored, selection prefers accounts with usable [rate-limit reset credits](#reset-credits), then configured order, then account id. Accounts below their floors remain excluded even in that fallback; if none can serve, the request is blocked. Equal pressure scores break by configured order, then account id; simultaneous new placements count toward each other's estimated demand.

Subagents receive independent pins, and a resumed subagent reuses its own pin. The **This session** section of `/openai` clears only the current session's pin, so the next placement may choose the same account again.

### Prepaid credits

A ChatGPT workspace can hold prepaid credits, and Codex keeps answering on them after an account's 5-hour or weekly window is used up. Credits cost money, so routing uses them only after free quota runs out:

- An account with free quota left always serves before an account that could only serve on credits, in every routing mode and when a new session is placed. The one exception is a request that cannot be sent twice: it still goes to the main account alone, as before, even if that account is serving on credits.
- When no account has free quota, an account whose credits are usable serves next, ahead of accounts without credits, whatever the configured order. With several such accounts, the configured order decides.
- A session pinned to an account whose window runs out moves, as before: to an account with free quota when there is one, otherwise to an account with credits. A session serving on credits moves back to free quota at its next request once another account has some again.
- Credits count as usable only when the latest reading of them is no more than 15 minutes old, reports credits (unlimited, or with a balance above zero, or without a balance at all), and does not say the overage limit is reached. A missing or older reading means no usable credits.
- [Killswitch floors](#killswitch) and the workspace's own spending cap (its credit budget) still block an account, credits or not. With the killswitch on, a used-up window is below any floor above 0%, so that account does not serve on credits.
- When no account has free quota or usable credits, requests go out as before.

Codex does not say whether credits were granted or bought, so the plugin treats all of them the same. Each time an account starts serving on credits, its first such request writes one line to the log (the account's key, no balance), and the sidebar marks the session's account `serving on credits` beside its prepaid credits.

In vault mode, background readings from Insula also supply prepaid credits, stamped with Insula's fetch time rather than when the cache was read. A missing credits pool says nothing and keeps the previous reading, including its original age; it does not clear credits or make them fresh. Current Insula builds pass through Codex's explicit unlimited verdict. For older builds that omit it, the plugin conservatively records available credits (with a balance when published), never infers unlimited from an absent ceiling, and preserves an explicit unlimited reading from Codex when Insula reports neither that verdict nor a balance. Insula's explicit spending block is respected; an absent block is not invented as an affirmative overage verdict.

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

On Pi, every request goes out with one account's token, chosen by the [routing mode](#routing):

- In local mode, `main-first` tries your Pi login first, then the fallbacks in order; `fallback-first` tries the fallbacks first and your Pi login last. In vault mode, main is the vault's default OpenAI account instead. When an account answers with a rate-limit or authentication error before anything was streamed, the next account in the routing order is tried.
- `sticky-balanced` keeps each Pi session on one account, spreading new sessions by remaining quota; confirmed exhaustion causes a lasting account switch.

Your Pi login stays where Pi keeps it: Pi refreshes it, and the extension only uses the token Pi hands it. Fallback accounts live in the extension's own store, `openai-auth.json` in Pi's agent directory (`~/.pi/agent` by default on Windows, Linux and macOS). `PI_CODING_AGENT_DIR` changes that directory, and `PI_OPENAI_AUTH_FILE` can name the file directly; the extension refreshes those credentials there. If only the default directory has an existing store, the extension continues using it in place and logs a legacy-location warning once per process; it never copies or moves credentials. A fallback that is the same ChatGPT account as your Pi login is skipped, so retrying a request cannot try that account twice. An account is used only once its quota is known: each account's quota is checked as soon as the extension sees it, and quota from every response keeps it current. A store written by an earlier version is converted to the account-pool format the first time it is read, keeping its accounts.

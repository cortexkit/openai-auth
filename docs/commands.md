# Commands

## Setup

Run `npx @cortexkit/opencode-openai-auth setup` with OpenCode and Pi stopped. It detects installed hosts, registers the matching package, and offers Claustrum enrollment or local sign-in.

| Flag | What it does |
| --- | --- |
| `--yes` | Select all detected hosts without prompts; local sign-in remains interactive and vault enrollment needs `--claustrum`. |
| `--dry-run` | Print the registration and enrollment plan without changing files or signing in. |
| `--claustrum` | Connect detected hosts to the Claustrum vault. |
| `--no-claustrum` | Use local credentials instead of the vault; enrolled hosts refuse this mode. |
| `--login` | Force local sign-in rather than offering the vault. Pi uses its own `/login openai-codex`. |
| `--opencode=1\|2\|both` | Select which OpenCode generation to register when detection is ambiguous. |

Existing accounts migrate when the plugin first starts, not during setup. [Manual install](configuration.md#manual-install) remains available as a fallback.

## The `/openai` command

On OpenCode 1, one command, `/openai`, opens one menu in the TUI. Its sections, in order:

| Section | What it does |
| --- | --- |
| Accounts | List accounts; add one (browser or device-code sign-in), disable, enable, move or remove one. Row `main`, the account OpenCode signs in with, is never removed. |
| Quota | Every account's windows and credit budget; **Check now** polls them. |
| Routing | The routing mode and the roster order. |
| Limits | The killswitch and each account's floors. |
| Cache | Prompt-cache keep-warm, subagent warming, sustain and the warm window. |
| Diagnostics | Request dumps and the log level. |
| Reset credits | Preview an account, spend one reset credit after explicit confirmation, or retry the last redemption. |
| This session | The session's sticky pin, and clearing it. |
| Vault | Whether this host is connected to the Claustrum vault, the OpenAI accounts the vault serves it, and the last error. **Connect** asks the vault to enroll this host; **Disconnect** forgets its token. Each vault account can be disabled (it stays listed and is never sent from this host) or enabled again. |

What each section controls is described in [Accounts and routing](accounts-and-routing.md), [Cache keep-warm](cache-keep-warm.md), [Troubleshooting](troubleshooting.md) and [Claustrum vault](vault.md).

Settings the menu changes are saved through the account pool's store, under the names `routing.mode`, `killswitch.{enabled,accounts}`, `logging.level`, `cacheKeep.*` and `dump.enabled`. The menu needs the account pool: until every OpenCode process on the machine runs a version that understands it and the accounts have moved, `/openai` shows only that notice and the processes still holding the move back.

The eight earlier commands (`/openai-account`, `/openai-quota`, `/openai-routing`, `/openai-killswitch`, `/openai-cachekeep`, `/openai-dump`, `/openai-logging`, `/openai-reset`) are gone; their actions are sections of the menu.

The menu and the sidebar are not available on [OpenCode 2](opencode-2.md) yet.

## From a terminal, without a TUI session

Once a credential exists (OpenCode's own or a stored account), `opencode auth login` offers an account menu for this provider:

```text
Add account               add an account (device code when no browser is available)
Re-authenticate account   sign an account in again, replacing its credential
Remove account            remove one account (not main)
Enable or disable account
Check quotas              poll every account's quota now
Auth doctor               report problems with the stored credentials, and offer repairs
Connect to the Claustrum vault   serve OpenAI accounts held in the vault
Delete all accounts       remove every account except main
```

While the host is connected to the vault, the menu lists the vault's accounts and offers only **Check quotas** and **Disconnect from the Claustrum vault**; local account management returns after disconnecting.

This is the path for headless machines, where `/openai` is out of reach. The first login on a new machine goes straight to sign-in as usual. Before the accounts have moved to the account pool, the menu shows only that notice and the doctor. Connecting to the vault prints the `ck auth enroll approve` and `ck auth grant` commands to run, and waits for the approval (see [Claustrum vault](vault.md#connecting-a-host)).

The menu prints `Failed to authorize` when it returns, even when the action succeeded. The menu writes its own changes and deliberately reports nothing back as a sign-in, because a fallback account must not be filed as the main credential. Check the result with `/openai`.

## Pi

The Pi extension registers one command, `openai`, which opens a menu:

| Section | What it does |
| --- | --- |
| Accounts | Add a fallback account through OAuth; disable, enable, move or remove one. |
| Quota | Check every account's quota now. |
| Routing | `ordered`, `main-first`, `fallback-first` or `sticky-balanced`, and the roster order. |
| Limits | The killswitch and each account's floors. |
| Pi login | The quota of the account you signed in to Pi with, routed as `main`. |
| This session | Clear the session's pin. |
| Vault | Connect Pi to the Claustrum vault; disable or enable each vault account on Pi alone. See [Claustrum vault](vault.md). |

Pi's own login uses Pi's normal flow, `/login openai-codex`.

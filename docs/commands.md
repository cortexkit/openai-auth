# Commands

## Setup

Run `npx @cortexkit/opencode-openai-auth setup` with OpenCode and Pi stopped. It detects OpenCode and Pi installations, registers the matching package, and offers a [Claustrum vault connection](vault.md#connecting-a-host) or local sign-in.

| Flag | What it does |
| --- | --- |
| `--yes` | Select all detected hosts without prompts; local sign-in remains interactive and vault enrollment needs `--claustrum`. |
| `--dry-run` | Print the registration and enrollment plan without changing files or signing in. |
| `--claustrum` | Connect detected hosts to the Claustrum vault. |
| `--no-claustrum` | Use local credentials instead of the vault; enrolled hosts refuse this mode. |
| `--login` | Force local sign-in rather than offering the vault. Pi uses its own `/login openai-codex`. |
| `--opencode=1\|2\|both` | Select which OpenCode generation to register when detection is ambiguous. |

Existing accounts migrate when the plugin first starts, not during setup. [Manual install](configuration.md#manual-install) remains available as a fallback.

For OpenCode 2, setup prints the detected OpenCode 2 login command and names its browser and headless pool-login methods. Run that command to store the account in the shared [account pool](accounts-and-routing.md#the-account-pool) and make it OpenCode 2's active connection. `--opencode=both` signs in to OpenCode 1 during setup and also prints the OpenCode 2 step.

## The `/openai` command

On OpenCode 1 and 2, the plugin's `/openai` slash command opens its menu in the terminal UI. Its sections, in order:

| Section | What it does |
| --- | --- |
| Accounts | List accounts; add one (browser or device-code sign-in), disable, enable, move or remove one. Row `main`, the account OpenCode signs in with, is never removed. |
| Quota | Every account's windows and credit budget; **Check now** polls them. |
| Routing | The routing mode and the roster order. |
| Limits | Block requests below each account's minimum remaining quota ([killswitch floors](accounts-and-routing.md#killswitch)). |
| Cache | Prompt-cache keep-warm, subagent warming, sustain and the warm window. |
| Diagnostics | Request dumps and the log level. |
| Reset credits | Preview an account, spend one reset credit after explicit confirmation, or retry the last redemption. |
| This session | The account assigned to this session (its pin), and clearing that assignment. |
| Vault | This OpenCode's vault connection, available accounts and last error. **Connect** requests the vault owner's approval; **Disconnect** removes OpenCode's vault token. Accounts can be disabled for OpenCode without deleting them from the vault. |

What each section controls is described in [Accounts and routing](accounts-and-routing.md), [Cache keep-warm](cache-keep-warm.md), [Troubleshooting](troubleshooting.md) and [Claustrum vault](vault.md).

The menu saves settings in the account pool, under `routing.mode`, `killswitch.{enabled,accounts}`, `logging.level`, `cacheKeep.*` and `dump.enabled`. It opens after the main login is transferred from OpenCode 1's `auth.json` into the shared pool. To avoid leaving a process that still reads only `auth.json`, the transfer waits for every running OpenCode process to use this plugin version or newer. Until it finishes, `/openai` shows **Accounts are moving** and lists any blocking processes.

The eight earlier commands (`/openai-account`, `/openai-quota`, `/openai-routing`, `/openai-killswitch`, `/openai-cachekeep`, `/openai-dump`, `/openai-logging`, `/openai-reset`) are gone; their actions are sections of the menu.

See [OpenCode 2](opencode-2.md) for its login methods and host-specific differences.

## From a terminal, without a TUI session

On OpenCode 1, once a credential exists (OpenCode's own or a stored account), `opencode auth login` offers this provider's account menu:

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

While OpenCode 1 is connected to the vault, this account menu lists vault accounts and offers only **Check quotas** and **Disconnect from the Claustrum vault**. Local account management returns after OpenCode disconnects.

Use this menu on headless machines without the `/openai` terminal UI. The first login on a new machine goes straight to sign-in. Until [account-pool migration](accounts-and-routing.md#the-account-pool) finishes, the menu shows migration status and **Auth doctor** checks instead of account management. Connecting to the vault prints the approval and account-access commands to run (see [Claustrum vault](vault.md#connecting-a-host)).

OpenCode prints `Failed to authorize` when returning from the `opencode auth login` account menu, even when a change succeeded. The menu saves the change itself and tells OpenCode that no login happened, so OpenCode does not record a fallback as its main login. Open `/openai` to see the saved change.

## Pi

The Pi extension registers one command, `openai`, which opens a menu:

| Section | What it does |
| --- | --- |
| Accounts | Add a fallback account through OAuth; disable, enable, move or remove one. |
| Quota | Check every account's quota now. |
| Routing | `ordered`, `main-first`, `fallback-first` or `sticky-balanced`, and the roster order. |
| Limits | Block requests below each account's minimum remaining quota ([killswitch floors](accounts-and-routing.md#killswitch)). |
| Pi login | The quota of the account you signed in to Pi with. Routing treats this account as `main`. |
| This session | Clear this Pi session's account assignment (pin). |
| Vault | Connect Pi to the Claustrum vault; disable or enable each vault account on Pi alone. See [Claustrum vault](vault.md). |

Sign in to Pi itself with `/login openai-codex`; this is separate from adding fallback accounts in the plugin menu.

# Cache keep-warm

Keep-warm is available on OpenCode 1. It is not on [OpenCode 2](opencode-2.md) or Pi yet.

The Cache section of [`/openai`](commands.md#the-openai-command) keeps the Codex prompt cache warm while a session is idle, so the next real turn after a gap hits the cache instead of paying for a cold start. Codex evicts a session's prompt cache after roughly five minutes of inactivity; keep-warm replays the latest real request as a tiny shadow request (it stores no turn: `store: false`) just before the cache would expire.

## Settings

- **Keep-warm on/off.** The setting is saved (`cacheKeep.enabled`), so it stays on across restarts and applies to every session until you turn it off.
- **Subagent warming.** Also keep subagent sessions warm (off by default). Useful when the same subagent is reused repeatedly. Subagent sessions warm only while recently active: a 30-minute idle cap, against one hour for the main session.
- **Sustain.** Bypass main-session idle pruning. It defaults to off, applies to main-agent sessions only, and does not change subagent limits.
- **Warm window.** Warm only between local hours, such as `9-18` or `22-6`; empty warms at any hour.

The section also lists the timer, the tracked sessions and the TTL.

## Which sessions are warmed

Keep-warm only runs for main-agent sessions unless subagent warming is on, and it never warms an account that is not serving that session.

`sustain` is independent of the warm window: the configured window still controls capture and warming. `sustain` bypasses only the main idle-pruning bound; the target-count, memory-byte and LRU caps still apply. Subagent idle and warm-count limits remain unchanged.

`sustain` deliberately does not use the sibling `anthropic-auth` plugin's `always` term. In that plugin, `always` means ignore the clock schedule; here, `sustain` means bypass main idle pruning. They control different things.

## Cost

A GPT-5.6 session needs about two warms per hour, roughly 1K output tokens per hour at about a 99.4% cache hit rate. Other models need about twelve warms per hour, which is the more expensive case.

## Sustain prerequisite: Magic Context

Before enabling sustain for a main-session model, update `~/.config/cortexkit/magic-context.jsonc` with Magic Context's supported schema. Keep the existing per-model entries and set only the models used by sustained main sessions to `"never"`:

```jsonc
{
  "cache_ttl": {
    "default": "5m",
    "openai/gpt-5.6-sol": "never"
  }
}
```

Magic Context does not run in subagent sessions, so no subagent exception is needed. The setting is required because keeping a cache alive indefinitely breaks an elapsed-time heuristic in Magic Context, which assumes an old cache is cold and therefore safe to change for free.

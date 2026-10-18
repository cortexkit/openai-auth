# Cache keep-warm

Keep-warm is available on OpenCode 1 (the 1.x series) and for HTTP sessions on [OpenCode 2](opencode-2.md). OpenCode 2's WebSocket sessions are not warmed by the plugin yet. Keep-warm is not on Pi yet.

The Cache section of the plugin's [`/openai` slash-command menu](commands.md#the-openai-command) keeps an idle session's prompt cached so its next turn can reuse it. Keep-warm replays the latest real request just before the cache expires, with `store: false` so the replay stores no turn. The cache lifetime is 30 minutes for GPT-5.6 and later, and five minutes by default for other models.

## Settings

- **Keep-warm on/off.** The setting is saved (`cacheKeep.enabled`), so it stays on across restarts and applies to every session until you turn it off.
- **Subagent warming.** Also warm subagent sessions (off by default), subject to the idle and replay limits below.
- **Sustain.** Keep main-session warming past its one-hour idle cap. It defaults to off and does not change subagent limits.
- **Warm window.** Warm only between hours in the host machine's local time, such as `9-18` or `22-6`; leaving the setting empty allows warming at any hour.

The Cache section also shows its timer, tracked sessions and prompt-cache lifetime (TTL).

## OpenCode 2's own warming

The plugin's warming is invisible: it adds no message, visible answer or tool call, and the next turn does not include the warm's answer. OpenCode 2's built-in `warming` setting instead sends a keep-alive message that the model can see. Both can be on without double warming: when OpenCode sends its keep-alive, the plugin stops tracking that session until its next real request. If you turn off OpenCode's warming, the plugin waits for the session's next real request before warming it again.

## Which sessions are warmed

Keep-warm only runs for main-agent sessions unless subagent warming is on, and it uses the account serving that session. A main session stops warming after one hour without a real request, unless sustain is on. Subagents have a 30-minute idle cap; on GPT-5.6 and later they instead have a 75-minute idle cap and a limit of two successful warms per captured request. Reaching a cap discards the saved request and stops warming, not the session itself; a later real request can start tracking again.

`sustain` still obeys the warm window and limits on the number and total bytes of saved requests. When storage is full, the least recently used requests are discarded. Subagent idle and successful-warm-count limits remain unchanged.

In `anthropic-auth`, CortexKit's sister plugin for Claude, the `always` keep-warm option allows warming outside the configured warm window. Here, `sustain` means keep warming a main session past its idle cap; it still respects the configured warm window.

## Cost

Longer-lived caches need fewer warm requests: GPT-5.6 and later use a 30-minute prompt-cache lifetime, versus the five-minute default for other models. Warm requests still consume tokens and quota.

## Sustain prerequisite: Magic Context

If you use Magic Context, a prompt-rewriting plugin, set `cache_ttl` to `"never"` for each sustained main-session model in `~/.config/cortexkit/magic-context.jsonc`. Keep the existing per-model entries; for example:

```jsonc
{
  "cache_ttl": {
    "default": "5m",
    "openai/gpt-5.6-sol": "never"
  }
}
```

Magic Context uses cache age to decide when it can rewrite a prompt without invalidating still-cached input. Sustained warming keeps that input cached, so `"never"` disables the assumption that age alone means it has expired. Magic Context does not run in subagent sessions, so no subagent exception is needed.

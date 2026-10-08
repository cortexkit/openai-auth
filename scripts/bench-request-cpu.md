# Request preparation CPU benchmark

Run `bun scripts/bench-request-cpu.mjs --baseline` and then
`bun scripts/bench-request-cpu.mjs`. The baseline reads the actual private
functions from commit `20ecc8aba6d75cf17cae3c7c4b1ce93e57dc698d`, not a
reimplementation of the old comparison. Temporary sibling modules expose those
functions and are removed in `finally`; do not run two copies concurrently.

Measurements below used Bun 1.4.2 on macOS, 300 requests per row after 20 warmups,
with dumps explicitly disabled. Numbers are median **wall milliseconds per
request**, not network latency or a prediction of server-wide CPU savings. The
mixed message / function-call / output / reasoning histories have 30 tools and
50, 200, or 400 prior items plus one newly appended tool output. Their serialized
request sizes are 170,662 / 661,575 / 1,316,225 bytes. Parsed requests are fresh
objects; the retained prior state is established outside the measured interval.
The current request's preparation is included in each TOTAL row. WS component
rows after optimization consume a shared, already-prepared comparison; its cost
is shown separately, not hidden from the total. The necessary wire serialization
is included in both totals. Prewarm network I/O is not timed: these are steady
append-only tool-loop requests on an existing chain.

## Results

Each cell is **baseline → optimized**, in ms/request.

| Real function / path | 50 items | 200 items | 400 items |
| --- | ---: | ---: | ---: |
| `stableStringify`, one complete history (reference cost) | 0.186 → 0.199 | 0.684 → 1.011 | 1.400 → 1.830 |
| HTTP `updateHttpTurnMetadata` | 0.367 → 0.025 | 1.424 → 0.188 | 3.047 → 0.366 |
| **HTTP `prepareCodexRequest` TOTAL**, parse + decisions + full wire body | **0.556 → 0.290** | **2.240 → 1.496** | **5.739 → 2.809** |
| WS `bodySignature` (reference cost) | 0.033 → 0.026 | 0.041 → 0.033 | 0.048 → 0.036 |
| WS `requestComparison`, canonical items + signature, once per request | — → 0.044 | — → 0.119 | — → 0.308 |
| WS `shouldPrewarm` | 0.334 → 0.002 | 1.385 → 0.002 | 2.943 → 0.005 |
| WS `withContinuation` | 0.362 → 0.003 | 1.383 → 0.004 | 2.760 → 0.006 |
| WS `applyTurnId` | 0.364 → 0.002 | 1.388 → 0.005 | 2.773 → 0.007 |
| WS `updateContinuation` | 0.031 → 0.001 | 0.038 → 0.003 | 0.043 → 0.003 |
| WS disabled main dump, including argument construction | 0.109 → 0.001 | 0.414 → 0.003 | 0.864 → 0.004 |
| **WS TOTAL**, parse + decisions + dump + trimmed wire frame + completion | **1.275 → 0.224** | **5.358 → 0.709** | **9.457 → 1.683** |

Measurement preceded implementation. An initial 150-request arithmetic-mean run
on this busy worker machine measured HTTP totals of 4.043 / 14.449 / 23.023 ms
and WS totals of 6.917 / 26.543 / 16.527 ms. The non-monotonic WS results and
large variation motivated the reproducible median measurement above. Even the
unchanged reference serializer varies between runs; compare mechanisms as well
as timings. Both paths cost milliseconds at the representative 200-item size,
and wall means can reach tens of milliseconds under concurrent load.

## Mechanism and lifetime

- `packages/opencode/src/util/canonical-input.ts:19`: compare every JSON value
  against a **detached snapshot**, without sorting, copying or serializing
  unchanged items. Key insertion order is immaterial; array order remains
  significant. Changed/new items use the original `stableStringify`; comparisons
  use the full canonical strings, never a hash. Even an in-place edit cannot
  alter the saved snapshot and silently reuse an obsolete representation.
- `packages/opencode/src/util/canonical-input.ts:47`: retain canonical item
  strings and snapshots for at most 512 items and 2,097,152 canonical characters
  per history (at most 4 MiB of UTF-16 string data, plus bounded snapshot/node
  overhead). Over-limit requests remain exact but their extra representation is
  transient, not retained between requests. Larger requests therefore give up
  inter-request reuse rather than grow a permanent unbounded cache.
- `packages/opencode/src/index.ts:950`: one canonical representation per HTTP
  request, held alongside the existing host `metadata.input`, before effort
  instructions are inserted. Rewrites/compaction replace the snapshot; session
  deletion (`index.ts:1760`) removes it with the metadata. It is not persisted:
  the session file still stores only the thread id.
- `packages/opencode/src/ws-pool.ts:1037`: compute the current full input and
  tools/settings signature once, then thread that comparison through prewarm,
  continuation, turn selection, completion, and post-attempt HTTP fallback.
  A request-local map also prevents repeat canonicalization of uncached prior
  histories, including the turn state's array copy of the continuation input.
- `packages/opencode/src/ws-pool.ts:886`: continuation owns its canonical
  history alongside the prior body; turn state owns its canonical history
  alongside `turnInput`. They normally share the same representation. A prewarm
  stores an empty input and reuses the already-computed settings signature.
  Clearing/replacing continuation drops that reference. The turn cache survives
  reconnects **because the existing turn history does**, preventing false fresh
  turns on full replay. Removing, idle-pruning or closing pool entries drops
  both histories and caches (`ws-pool.ts:502-529`).
- `packages/opencode/src/dump.ts:112`: accept a body-text producer and evaluate
  it only after the per-request enabled check. Both WS call sites pass the exact
  old `JSON.stringify` expression lazily. Enabled dump content and invocation
  order are unchanged. `ws.ts:916` is the necessary `response.create` **wire
  serialization**, not a dump argument, and is deliberately unchanged.

Equality validation and unavoidable parsing/wire serialization are still linear
in the replay history. This removes repeat sorting/copying/stringifying; it does
not claim constant-time processing of a fresh, arbitrarily editable JSON body.
The finalized-call trimming filter, chain inheritance, strict-growth rule for
continuation, and equal-length rule for turn detection are unchanged.

## Added assertions

- `canonical input > matches the original exact comparison on varied histories`
- `canonical input > rejects a stale canonical item after an earlier in-place edit`
- `canonical input > reuses detached snapshots only for unchanged items and bounds retention`
- `request dumps > does not serialize lazy bodies when dumps are disabled`
- `request dumps > lazy enabled dumps preserve body bytes and prewarm main order`
- `request dumps > HTTP cached decisions still detect edits compaction and rewrites`
- `createWebSocketFetch > disabled dumps serialize only the wire frames`
- `createWebSocketFetch > cached WS decisions preserve append edits tool order compaction and prewarm`

The two dump-site mutations (`ws-disabled-main-dump-is-lazy`,
`ws-disabled-prewarm-dump-is-lazy`) target actual transport argument construction,
not just the dumper's callback API. The cache mutation
`canonical-input-validates-earlier-edits` removes value validation before reuse.
Each has a named assertion in `mutations.toml`. Existing transport/integration
assertions were not changed or renamed.

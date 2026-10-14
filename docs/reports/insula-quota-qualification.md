# Insula-backed vault quota qualification

## Candidate and installation

Qualified insula-backed vault quota against the common-auth **0.16.0** candidate
built from **ad11836**, installed from
`cortexkit-common-auth-0.16.0-2315d0f.tgz`. The candidate tarball's SHA-256 is:

```text
50755b5ed900f02373e6577cfa063efbd8e78944a517e72aef3cc21864032df7
```

The earlier common-auth 0.16.0 candidate built from d11d6af had SHA-256
(`7ce8cf8a1d1041867e899c3c7892ec3d325f26e78eec74bfbd0e955d3cfba0b7`).
It was superseded during qualification because its optional dynamic import
produced a late-loaded OpenCode chunk. The replacement imports subc-client
statically, as claustrum-client already did. **OpenCode's original `--splitting`
build and both existing packaging guards are unchanged.**

All three packages were installed from a worktree-local `file:` tarball for
qualification. Replacing the contents at the same filename and running
`bun install --force` still reused Bun's old tarball cache; a byte-identical copy
named `cortexkit-common-auth-0.16.0-cd7075f.tgz` forced a fresh installation.
The final candidate also has a unique filename, ending in `2315d0f.tgz`, and adds
`recordAccountQuota` for discovery-free quota writes. The installed `insula.js` was inspected on both Mac and Linux and contained
`import { SubcClient } from '@cortexkit/subc-client'`, not the old dynamic import.

The tarballs were staged only to let remote jobs install them; none is committed.
The committed manifests require **`^0.16.0`**. The lockfile is deliberately left
unchanged for regeneration after publication. Therefore a fresh install from
this commit requires publishing 0.16.0 and regenerating `bun.lock` first.

Remote setup installs the frozen candidate lock before each command. With parent
approval, qualification commands then changed **only their ephemeral manifests**
to `^0.16.0`, without reinstalling. This lets the installed-range build guard,
exact manifest regression assertion and strict mutation anchors check the final
manifest values while running the verified unpublished candidate.

## Behavior

- The shared `OpenAiVault` consumer opts into provider `codex` with the new
  normalizer, covering OpenCode 1, OpenCode 2 and Pi without host-specific forks.
- Background metadata ticks refresh the optional insula cache. A background
  `pollQuota` also refreshes it before a route lookup; common-auth shares and
  throttles attempts across consumers. A defined route match bypasses both
  credential acquisition and wham for that account. Misses use the existing poll.
- Background observations use `consumer.recordAccountQuota`, which merges under
  the roster lock only while the row still has that exact known provider account
  identity, then reloads the consumer's in-memory roster with a file read. It
  never discovers or binds an account. The locked identity check prevents a
  reading for the old account from being written to a row that another process
  has replaced, and supports identities retained when inventory later omits them,
  without an extra `list_scoped` or `get_scoped` call.
- When a request is refused because its account's quota is unknown, its one-shot
  reading uses the insula cache keyed by the account asserted in the vault's
  credential authorization receipt.
  It never refreshes insula; missing asserted identities or cache misses use wham.
- Primary and secondary windows use `rawUsedPercent ?? usedPercent`, carry the
  producer's `fetchedAt` as `checkedAt`, and preserve reset/window metadata.
  The roster observation also uses that timestamp, including spend-control
  readings/clears, so newer in-band quota cannot be overwritten by an old cache.
- Saved reset count is normalized, no credits field is invented, and
  `individual_limit` amounts are converted from integer minor units. Only
  `spendable === false` marks the budget reached. An absent individual pool
  explicitly clears spend control. Zero-limit reached budgets remain readings.
- Standalone mode and existing header/WebSocket recording are unchanged.

The existing manifest assertion and its mutation anchor advance from `^0.15.0`
to `^0.16.0`; the newer release still includes the Windows private-file safety
floor, rather than deleting or reversing that safety assertion.

## Three-account background traffic regression

The three-account test drives the metadata-plus-quota workflow from the base/main
branch at `cdda71fa8c61abf06d4ba9514e5ef1fa82054b75`: one
ordinary roster refresh, followed by `pollStale(0)`. All three accounts have current
insula entries. The pass makes **exactly one `list_scoped` call**, matching main's
single normal discovery, rather than the previous four calls. It also makes zero
credential gets, zero wham calls and one insula read, and all three normalized
windows are immediately visible through `routes()`.

To prove the background-traffic test detects the old behavior, the
`insula-vault-hit-no-discovery` mutation deliberately inserts `await this.refresh()`
before every account-quota write. Each added refresh discovers the vault's account
list again instead of only reloading the persisted roster. The test rejects those
extra calls with **expected 1, received 4** `list_scoped` requests, while the
admission-cache-miss control stays green. The quota write still uses the
account-identity comparison under the roster lock; the common-auth helper performs
the same post-write file reread as its receipt-based `recordQuota` path.

## Gates

Build server: Bun **1.4.2**, TypeScript **7.0.2**, Biome **2.5.15**.

| Command/check | Result |
| --- | --- |
| `bun run build` | Passed: core declarations; OpenCode 284 bundled modules, 13 declaration outputs and 136 TUI source files; Pi 129 bundled modules and one declaration bundle. Installed ranges checked 28 dependencies. |
| `bun run types` | Passed: all three package `tsc` invocations, exit 0. |
| `bun run lint` | Passed: 265 files, no fixes. |
| `ckdev-mutate check --strict` | Passed: 234 verified source anchors and discovered test-name selections, zero unverified rows. Used ckdev-mutate 0.12.1 from the `cortexkit-mutate` crate in `cortexkit/commons`, built from commit `9d6b663dac487bb982c7bfd18a96eee2292164ad`. CI pins that source revision so catalogue checks and mutation replay use the same runner implementation. |
| Core `bun run test` | Passed: 262 tests across 21 files. |
| OpenCode `bun run test` | Passed: 1547 pass, 26 skip, zero fail; 1573 tests across 91 files. |
| Pi `bun run test` | Passed: 75 tests across six files. |
| Restored quota controls plus request-reading regression | Passed: 24 tests across three core files after the traffic mutation restore. |
| Existing no-lazy-chunks guard | Passed unchanged; its planted-import detector test also passed. |
| Existing Node packed-package root/server identity contract | Passed unchanged: `./server carries the same OpenCode 1 plugin and id as the root`. |
| Scoped editor diagnostics | No errors/warnings in all five changed core source/test files; dead-code, unused-export, duplicate, cycle and complexity analysis was unavailable. |

The 26 OpenCode skips are the suite's opt-in real-host tests; they were not
requested separately. Network access was needed for the suite's npm-packed
consumer installation. An initial offline full run timed out while npm tried to
reach the registry. A subsequent run without a same-job build had missing-artifact
failures; remote `dist` output is not retained between jobs. Final suite commands
built before testing in the same job.

One full OpenCode suite run used the shared auth library from
`cortexkit/common-auth` commit `cd7075f`: the static-import candidate that replaced
the earlier `d11d6af` dynamic-import candidate. That run had two unrelated timing
failures: `two concurrent ticks against a real lock file refresh only once` and
`adding an account shows the sign-in URL and adds the row when the login finishes`.
The complete OpenCode suite was rerun without changing either test or its
implementation and passed all 1547 enabled tests; Pi then passed too. All 1547
OpenCode tests also passed on the final ad11836 candidate. On that final candidate,
Pi's `missing-token enrollment disables local work and retains menu Disconnect`
test exceeded its default five-second timeout once; the entire Pi suite then
passed all 75 tests without changing source or tests.

The build server's preinstalled mutation runner was 0.12.0 and rejected `--strict`.
The pinned 0.12.1 runner was installed privately under `target/qualification-tools`
using writable temporary Cargo state and network access. No tool installation or
build output is part of this commit.

## Mutation proofs

Each source was staged before mutation, with an empty unstaged `git diff --stat`.
The applied break carried `NON-VACUITY BREAK`, and was restored using
`git checkout -- <path> && touch <path>`. The unstaged diff was empty after every
restore. Only the expected guard failed in each selected run:

| Control | Expected red | Unaffected green control | Applied / restored diff |
| --- | --- | --- | --- |
| `insula-codex-raw-used-percent` | `insula codex normalization raw usage beats the saved-reset published zero`: expected 100, received 0 | `every reading time equals fetchedAt` | `insula-quota.ts`: one insertion / one deletion; then empty |
| `insula-vault-skip-wham-on-hit` | `vault insula quota current hit skips wham only for its matched account`: unexpected wham call for account-a | `admission cache miss polls wham without calling insula` | `vault.ts`: one insertion / one deletion; then empty |
| `insula-vault-miss-falls-back` | `vault insula quota missing source falls back to wham`: expected account-a wham call, received none | `standalone never opens insula` | `vault.ts`: one insertion; then empty |
| `insula-vault-hit-no-discovery` | `vault insula quota three matched accounts add no discovery to a background tick`: expected one list call, received four | `admission cache miss polls wham without calling insula` | `vault.ts`: one insertion; then empty |

All four rows are in `mutations.toml`; each red run had one fail and one pass.
The original three proofs preceded the traffic revision; their raw-usage,
skip-on-hit and fallback branches remain unchanged. The traffic proof was run on
the final ad11836 candidate.

## Distribution comparison

Built a temporary archive of base/main commit
`cdda71fa8c61abf06d4ba9514e5ef1fa82054b75` with its own frozen dependencies,
then built the replacement candidate in the task workspace on the same Linux
server. The temporary baseline archive is not committed.

**OpenCode has the same logical file set: 17 JavaScript files (eight entrypoints
and nine existing shared chunks) and 13 declaration files. No tenth/insula-only
chunk is emitted.** Content-hashed names necessarily change when bundled code
changes; literal filenames are listed below rather than claiming byte-for-byte
filename equality. These literal names were captured from the comparison build;
subsequent comment-only clarifications can change declaration hashes.

| Main shared JavaScript chunks | Qualified shared JavaScript chunks |
| --- | --- |
| `index-0vdathce.js` | `index-h2jvp6fc.js` |
| `index-f59xft9b.js` | `index-wc54vqkk.js` |
| `index-jrv6axgh.js` | `index-414hqxwj.js` |
| `index-4yzma699.js` | `index-qyfp10qh.js` |
| `index-9r138e3r.js` | `index-2fkrr4yq.js` |
| `index-ynvr4s58.js` | `index-7z5cehje.js` |
| `index-na9hkb07.js` | `index-zddd51d5.js` |
| `index-6nwk3e3x.js` | `index-e0z3f580.js` |
| `index-h6pr89yz.js` | `index-h6pr89yz.js` |

Identical non-hashed OpenCode files before and after:

```text
index.js                  index.d.ts
v2/server.js              v2/server.d.ts
sidebar-state.js          sidebar-state.d.ts
tui-preferences.js        tui-preferences.d.ts
rpc/rpc-client.js          rpc/rpc-client.d.ts
rpc/port-file.js           rpc/port-file.d.ts
rpc/protocol.js            rpc/protocol.d.ts
rpc/rpc-dir.js             rpc/rpc-dir.d.ts
                          tui.d.ts
```

| Main shared declarations | Qualified shared declarations |
| --- | --- |
| `pool-lifecycle-DXTdn7wx.d.ts` | `pool-lifecycle-Dl-2emhB.d.ts` |
| `port-file-BzYIKbas.d.ts` | `port-file-BZFbpg7O.d.ts` |
| `protocol-B2neTlvm.d.ts` | `protocol-DMKfYaiQ.d.ts` |
| `sidebar-state-BU_39nl2.d.ts` | `sidebar-state-yFbobVyw.d.ts` |

**Pi** has exactly `index.js` and `index.d.ts` before and after, no chunk.
**Core** builds declarations only, not JavaScript. Its before/after list is below;
the only addition is `insula-quota.d.ts`, the new normalizer's declaration, not a
runtime chunk:

```text
accounts.d.ts                  backoff.d.ts
commands.d.ts                  index.d.ts
internal.d.ts                  logger.d.ts
oauth.d.ts                     paths.d.ts
pool-quota.d.ts                pool-routing.d.ts
pool-session-pins.d.ts         pool-source-state.d.ts
protocol.d.ts                  provider.d.ts
quota-manager.d.ts             quota-normalize.d.ts
refresh-all-quota.d.ts          reset-credits.d.ts
tombstone.d.ts                  tui-support.d.ts
util/credential-redaction.d.ts  util/error.d.ts
util/open-url.d.ts              util/record.d.ts
vault-account-menu.d.ts         vault-command-menu.d.ts
vault.d.ts
After only: insula-quota.d.ts
```

The final OpenCode shared runtime chunk contains the subc-client implementation
(the SDK's `route.open returned no route handle` error string is present), and no
external `@cortexkit/subc-client` reference. Pi likewise bundles that implementation
into its single `index.js`. The updated producer uses a static import; module
code is available at startup, but construction opens no insula connection:
`getUsage()` still owns and opens its separate socket only when quota is read.
Existing unrelated dynamic imports of external packages do not load files from
the plugin's own `dist` directory; they add no late-loaded plugin chunk.

The final inspection examined the OpenCode and Pi JavaScript bundles in
`packages/opencode/dist` and `packages/pi/dist`, built with the common-auth
candidate from source commit `ad11836`. It checked that subc-client was included
in those bundles, not left as an external dependency, and that no relative
dynamic import could load a plugin chunk later. It also counted the output files
in `packages/core/dist` to confirm the core build emitted type declarations but
no JavaScript. Results:

```text
{"package":"opencode","jsFiles":17,"inlinedSubcClient":["index-h2jvp6fc.js"],"relativeDynamicImportFiles":0,"externalSubcClientReference":false}
{"package":"pi","jsFiles":1,"inlinedSubcClient":["index.js"],"relativeDynamicImportFiles":0,"externalSubcClientReference":false}
{"package":"core","jsFiles":0,"declarations":28}
```

## Read-only Mac qualification

The normal build of `packages/core` emits only `.d.ts` files describing TypeScript
types, not executable JavaScript. The read-only Mac inspection script needs
runnable quota-normalization code, so `packages/core/src/insula-quota.ts` was
compiled separately into a temporary JavaScript module. The committed inspection
script then loaded that module:

```sh
bun build packages/core/src/insula-quota.ts \
  --outfile packages/core/dist/insula-quota.js --target bun
bun docs/reports/insula-quota-live.mjs \
  "$HOME/.config/opencode/openai-auth-vault/opencode-enrollment.json" \
  "$HOME/.config/opencode/openai-auth-vault/opencode-roster.json"
```

The connection file is resolved by the real claustrum-client resolver (an
explicit third argument can override it). The script checks the protected token
is readable, reads the existing roster, calls the insula transport **once**, joins
by exact provider/account identity with the consumer's freshness conditions, and
prints the built normalizer's result. It does not instantiate `OpenAiVault`,
enroll, authorize, refresh credentials, call wham, write quota or change vault
state. Token and roster SHA-256 digests before and after were equal.

The following output used common-auth, the shared authentication library used by
openai-auth, at version 0.16.0 built from `cortexkit/common-auth` source commit
`ad11836`. This is the candidate being qualified for publication, not a released
registry dependency; the output demonstrates that its insula transport matches
the real vault accounts and that openai-auth normalizes their quota readings:

```text
{"routeId":"vault:chatgpt:openai~ffdbede18a","account":"291f5165-0a65-4635-b437-5174415ed928","matchedCurrentEntry":true,"normalized":{"primary":{"usedPercent":66,"remainingPercent":34,"checkedAt":1791995714662,"resetsAt":"2026-10-20T04:58:25Z","windowMinutes":10080},"resetCreditsAvailable":1,"spendControlCleared":true}}
{"routeId":"vault:chatgpt:openai:gmail~c34efc52ac","account":"7b66addd-4602-408f-84f3-dbcbb8e8fd88","matchedCurrentEntry":true,"normalized":{"primary":{"usedPercent":59,"remainingPercent":41,"checkedAt":1791995700658,"resetsAt":"2026-10-20T04:58:44Z","windowMinutes":10080},"resetCreditsAvailable":1,"spendControlCleared":true}}
{"routeId":"vault:chatgpt:openai:live~244c9c1338","account":"bafd1ac7-846c-4aee-a425-3d8b195eff95","matchedCurrentEntry":true,"normalized":{"primary":{"usedPercent":90,"remainingPercent":10,"checkedAt":1791995700619,"resetsAt":"2026-10-20T04:59:33Z","windowMinutes":10080},"resetCreditsAvailable":0,"spendControlCleared":true}}
Read-only check: enrollment token and roster bytes unchanged; usage.get called once.
```

All three accounts in this Mac's enrolled OpenCode vault roster matched insula
entries fetched less than four minutes earlier, with no stale/error marker.
Those entries had only primary windows; no secondary window was invented.

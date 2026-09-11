# Custody state machine

## Purpose & scope

This is the reviewer-facing Phase A custody state machine for OpenAI accounts. It names the startup verdict for every implemented coordinate, the barrier that changes global mode, and the recovery rules after an interrupted transition. Its governing rule is: a row that cannot prove a single refresher never serves local under `mode=claustrum`.

Phase A reads custody bindings and can write only the local custody tombstone under the guarded transition; it does not write bindings, enroll accounts, or export local tokens. Phase B remains a boundary, not an available surface: `/openai-account export-local <id> --output <path>` is the deferred 0600 local-token export verb for future coordination only.

## Coordinates

| axis | values | source |
|---|---|---|
| `mode` | `local` · `claustrum` | `openai-auth.json` → `claustrum.mode`; `claustrumMode()` defaults any absent/other value to `local` |
| `manifest` | `absent` · `present` · `unreadable` | custody-manifest reader result |
| `local` | `real` · `tombstone` · `empty` · `gone` · `slot-absent` | fallback row or main host slot classification |
| `vault` | `serves` · `cold` · `needs_reauth` · `identity_mismatch` · `no_handle` | custody cache outcome and served-JWT identity check |

`real` is parseable non-sentinel material. `tombstone` is the canonical local sentinel. `empty` has sentinel `refresh` but a non-canonical access/expiry shape; it remains custody evidence. `gone` is a retained corrupt OAuth fallback row, not a missing row. `slot-absent` is main-only and is confirmed through the host SDK. A missing fallback row is not a `local` value; it is an orphan binding.

Config absent is equivalent to `mode=local`. Config-unparseable never enters this table: `loadAccounts()` surfaces the actionable JSON, access, or permission failure rather than normalizing it into custody state.

## Persisted schema + fingerprint contract

The persisted custody portion of the account store is:

```ts
claustrum?: {
  mode?: 'local' | 'claustrum'
  transition?: {
    manifestRevision: string
    storeGeneration: string
    fingerprints: {
      main?: string
      fallbacks: Record<string, string>
    }
  }
  rowHistory?: string[]
}
```

`rowHistory` distinguishes an orphan whose row was removed from one awaiting first discovery. `transition` survives a committed mode write until all fingerprint-gated tombstones complete.

The canonical custody tombstone is `{ type: 'oauth', access: '', refresh: custodyTombstoneKey(provider), expires: 0 }`. Recognition is exact on `refresh`; the empty `access` prevents the tombstone from being usable as bearer material.

`custodySlotFingerprint(access, refresh)` is lowercase hexadecimal SHA-256 over:

```text
u32be(byteLength(access)) || utf8(access) || u32be(byteLength(refresh)) || utf8(refresh)
```

The length prefixes make distinct token pairs unambiguous. A later local family with a different fingerprint is operator-owned and is never tombstoned by resume logic.

## Predicates

The prefix is `claustrum-tombstone:v1:` and the per-provider sentinel is `claustrum-tombstone:v1:<provider>`.

**RECOGNISE** is exact: `refresh === custodyTombstoneKey(provider)`. Access and expiry are deliberately ignored, so a partial write (`empty`) remains custody evidence.

**REFUSE** is prefix-based: any refresh value whose `startsWith(CUSTODY_TOMBSTONE_PREFIX)` is rejected as bearer material. Refusal is therefore a strict superset of recognition: exact sentinels are recognised, while malformed or foreign values sharing the prefix are still refused.

## Verdict-reason vocabulary

- `INERT:needs-login`
- `INERT:mode-mismatch`
- `INERT:corrupt-under-binding`
- `INERT:manifest-unreadable`
- `INERT:unbound-under-claustrum`
- `INERT:orphan-tombstone`
- `INERT:vault-cold`
- `INERT:vault-reauth`
- `INERT:identity-mismatch`
- `INERT:no-handle`
- `INERT:takeover-incomplete`
- `INERT:new-local-family-under-claustrum`
- `INERT:takeover-incomplete/vault-unavailable`
- `INERT:takeover-incomplete/slot-absent`

`LOCAL` permits the local family; `VAULT` serves only the vault record; `INERT` excludes the account from candidates and local refresh; `NEEDS_LOGIN` has an optional `corrupt` presentation reason. The `canonicalize` flag on an `empty` result permits the sweep to repair only its write shape.

## Local-mode table

The vault axis is not read in local mode. These are the 15 implemented `manifest × local` coordinates; the verified-login fact refines only `present × real`.

| manifest | local | verified in-process login | verdict | implementation consequence |
|---|---|---|---|---|
| absent | real | n/a | `LOCAL` | ordinary local family |
| absent | tombstone | n/a | `NEEDS_LOGIN` | local mode does not make a tombstone usable |
| absent | empty | n/a | `NEEDS_LOGIN` | partial tombstone is still custody evidence |
| absent | gone | n/a | `NEEDS_LOGIN` (`corrupt`) | retained corrupt fallback row |
| absent | slot-absent | n/a | `NEEDS_LOGIN` | ordinary missing main slot |
| present | real | yes → `LOCAL`; no → `INERT:needs-login` | conditional | verified login in this process may complete the local exit; otherwise the binding remains and is never auto-cleared |
| present | tombstone | n/a | `INERT:mode-mismatch` | local intent and custody material disagree |
| present | empty | n/a | `INERT:mode-mismatch` | same verdict as tombstone |
| present | gone | n/a | `INERT:corrupt-under-binding` | bound corruption is not a local family |
| present | slot-absent | n/a | `INERT:mode-mismatch` | no main-slot install in local mode |
| unreadable | real | n/a | `INERT:manifest-unreadable` | manifest precedence wins |
| unreadable | tombstone | n/a | `INERT:manifest-unreadable` | manifest precedence wins |
| unreadable | empty | n/a | `INERT:manifest-unreadable` | manifest precedence wins |
| unreadable | gone | n/a | `INERT:manifest-unreadable` | manifest precedence wins |
| unreadable | slot-absent | n/a | `INERT:manifest-unreadable` | manifest precedence wins |

The `present × real` pair is one coordinate with an explicit verified-login boundary, not two different stored states.

## Claustrum-mode table

These are the 31 implemented rows: five `manifest=absent` rows, 25 `manifest=present` rows, and the unreadable collapse. `fingerprint match` matters only for `present × real × serves`.

| manifest | local | vault | verdict | write / recovery |
|---|---|---|---|---|
| absent | real | not consulted | `INERT:unbound-under-claustrum` | refuse; do not serve local |
| absent | tombstone | not consulted | `INERT:orphan-tombstone` | refuse; do not manufacture a binding |
| absent | empty | not consulted | `INERT:orphan-tombstone` | same as tombstone |
| absent | gone | not consulted | `INERT:unbound-under-claustrum` | no install |
| absent | slot-absent | not consulted | `INERT:unbound-under-claustrum` | no main-slot install |
| present | tombstone | serves | `VAULT` | steady state |
| present | tombstone | cold | `INERT:vault-cold` | retry on a later tick |
| present | tombstone | needs_reauth | `INERT:vault-reauth` | remain excluded |
| present | tombstone | identity_mismatch | `INERT:identity-mismatch` | remain excluded |
| present | tombstone | no_handle | `INERT:no-handle` | remain excluded |
| present | empty | serves | `VAULT` | canonicalize to the write shape |
| present | empty | cold | `INERT:vault-cold` | canonicalize when recovered |
| present | empty | needs_reauth | `INERT:vault-reauth` | canonicalize when recovered |
| present | empty | identity_mismatch | `INERT:identity-mismatch` | canonicalize when recovered |
| present | empty | no_handle | `INERT:no-handle` | canonicalize when recovered |
| present | real | serves | match or omitted → `INERT:takeover-incomplete`; differs → `INERT:new-local-family-under-claustrum` | fingerprint-gated resume may tombstone only a match; never write the new family |
| present | real | cold | `INERT:takeover-incomplete/vault-unavailable` | no rollback |
| present | real | needs_reauth | `INERT:takeover-incomplete/vault-unavailable` | no rollback |
| present | real | identity_mismatch | `INERT:identity-mismatch` | local material is not consulted |
| present | real | no_handle | `INERT:no-handle` | retain material; no rollback |
| present | gone | serves | `VAULT` | install the exact fallback tombstone |
| present | gone | cold | `INERT:vault-cold` | install the exact fallback tombstone |
| present | gone | needs_reauth | `INERT:vault-reauth` | install the exact fallback tombstone |
| present | gone | identity_mismatch | `INERT:identity-mismatch` | no install |
| present | gone | no_handle | `INERT:no-handle` | no install |
| present | slot-absent | serves | `INERT:takeover-incomplete/slot-absent` | main INSTALL withdrawn; do not write |
| present | slot-absent | cold | `INERT:takeover-incomplete/slot-absent` | main INSTALL withdrawn; do not write |
| present | slot-absent | needs_reauth | `INERT:takeover-incomplete/slot-absent` | main INSTALL withdrawn; do not write |
| present | slot-absent | identity_mismatch | `INERT:identity-mismatch` | no install |
| present | slot-absent | no_handle | `INERT:no-handle` | no install |
| unreadable | any | not consulted | `INERT:manifest-unreadable` | no local or vault inspection |

## Invariants A/B/C/E

**Invariant A.** Under `mode=local`, the vault is never consulted for serving or refresh decisions. A manifest binding can still make a local refresh inert.

**Invariant B.** An unreadable manifest refuses before examining the local coordinate or invoking the vault. Unreadable refusal is decided; only a distinct typed presentation remains open.

**Invariant C.** Under `manifest=absent`, no handle exists for that account, so the vault is never queried.

**Invariant E.** `empty` is verdict-equivalent to `tombstone`. The sweep alone distinguishes it by canonicalizing the write shape. The tables list both coordinates so their equality is reviewable.

## Identity

Every provider identity fall-through is minted by the same OpenAI JWT issuer; manifest labels and locally minted ids are never substitutes.

For the host main slot, `main: gone ≡ slot-absent via SDK`. The SDK drops unparseable entries, so only fallback rows retain a distinct `gone` coordinate through `CorruptOAuthAccount`.

OpenAI and Anthropic deliberately diverge on `identity_mismatch`. OpenAI treats a served JWT claim mismatch as provider-asserted evidence that the binding is disputed, so it refuses and does not install a tombstone. Anthropic may install for a typed mismatch because its identity evidence is operator-labelled and weaker.

## Main host slot

`classifyMainAuthSlot()` recognises canonical tombstones, partial tombstones, real OAuth material, and an indeterminate value. A main slot is `slot-absent` only after two `undefined` `auth.get()` reads at least 250 ms apart, with a non-empty `auth.all()` map on both observations. A short sleep or an empty map produces `indeterminate`, not absence.

Under `mode=claustrum`, a confirmed absent main slot yields `INERT:takeover-incomplete/slot-absent` for vault `serves`, `cold`, and `needs_reauth`; main INSTALL is withdrawn. The pre-write guard reads `auth.all()` and refuses a write when it is empty:

`host auth store read empty; refusing to write — possible torn read`

This is deliberately separate from fallback `gone` installation, which is allowed only for a present usable binding.

## Barrier

Entering claustrum uses the process-local custody mutex, then the renewable `claustrum-mode` lock, then renewable account locks in sorted identity order (main before fallback ids). Main custody work uses the `main-refresh` lock. A main login retains a process-local exclusion lease until host `auth.get()` readback observes the written access/refresh pair, or the 5-second readback lease expires and logs a warning before release.

The barrier is:

1. Acquire the mutex and mode/account locks; capture manifest revision, store generation, and each local-slot fingerprint.
2. Preflight every participant against a usable manifest handle and vault identity while fenced.
3. Re-read manifest revision and store generation; write `claustrum.mode = "claustrum"` with the persisted transition fingerprints.
4. For each fallback, re-read material, tombstone only on fingerprint match, then read it back; mismatches become a new local family.
5. For main, apply the same fingerprint check, require non-empty `auth.all()`, write the tombstone, and require post-tombstone host readback.

Crash rows are monotone: before step 3 the disk mode is local and no destructive write occurred; re-running the transition is safe. After step 3, boot/tick resumes only fingerprint-matching tombstones. Mid-step 4 or 5 produces mixed per-account rows that the claustrum table resolves independently. There is no rollback after the mode write.

The residual is cross-process host login: a host `Auth.set` can land outside this process's locks and become `INERT:new-local-family-under-claustrum`, never a target for deletion. The transition confirmation is exactly: `do not run a login in another OpenCode window during this transition`.

## Local exit rows

Leaving custody takes `claustrum-mode` and writes `mode=local`; it does not clear bindings or restore tokens. A crash immediately after that write yields `present × tombstone/empty → INERT:mode-mismatch` until each account has fresh local material and its binding is cleared outside Phase A.

The verified-login boundary is strict. For main real material with a surviving binding and no in-process verified-login record, the implemented verdict is `INERT:needs-login`, never `LOCAL`, and the binding is never auto-cleared. A verified login in this process may return `LOCAL`; a restored backup, another process, or a raced host login cannot prove that boundary.

## Operation table

| operation | `mode=local` | `mode=claustrum` |
|---|---|---|
| `/openai-account claustrum` | runs the guarded barrier | idempotent resume or a new guarded barrier |
| `/openai-account local` | remains local | writes local mode only; re-login and external binding removal complete exit |
| enable | ordinary toggle | under the account lock, require a usable binding and identity; otherwise refuse |
| disable | ordinary toggle | ordinary row toggle; does not remove binding or vault material |
| remove | removes the row | removes only the row; a manifest entry becomes an orphan binding |
| add | local OAuth flow may persist a fallback | the completion path re-checks mode under the account lock and refuses before credential write |
| `/login openai` | ordinary host login | host write is outside plugin lock; a raced login becomes a fingerprint mismatch on reconciliation |
| CLI login | ordinary local login | refused by the custody-aware path before credential write; an external host write follows the same mismatch rule |

Mode is checked under the relevant account lock immediately before any plugin-owned credential write.

## Binding-pending + orphan causes

A new manifest entry discovered under `mode=claustrum` creates a fallback row with the canonical tombstone, `enabled: true`, and no `accountId`. That is `binding-pending`: the first served OpenAI JWT binds `accountId`; it cannot be an identity mismatch before then.

An entry with no fallback row is an `orphan-binding`, not a local coordinate. Runtime logs either `orphan-binding: row removed` when `rowHistory` contains the label or `orphan-binding: awaiting discovery` otherwise. Claustrum mode discovers it under that fallback's refresh lock; local mode logs it and does not create a custodied row.

## Required-injection rule

`FallbackAccountManager` is constructed as `new FallbackAccountManager(options: AccountManagerOptions)`, where `AccountManagerOptions` requires `custody: { readManifest: () => Promise<CustodyManifestReadResult>; provider?: string }`. Every production call site must supply that `custody` object; an omitted policy reader would silently re-enable local refresh.

The requirement exists because anthropic-auth incident 1 demonstrated that optional custody wiring fails open. `CorruptOAuthAccount` preserves a malformed OAuth row as typed custody-relevant state rather than silently dropping it as an ordinary missing account.

## Test list

| file | assertions pinned |
|---|---|
| `src/tests/custody-state.test.ts` | `localCases` enumerates all 15 local coordinates; `claustrumCases` enumerates all 31 claustrum rows, including empty/tombstone equivalence, fingerprint mismatch, fallback INSTALL, and withdrawn main slot INSTALL. The present×tombstone/local case defensively pins `INERT:mode-mismatch` so the non-custody serving branch cannot serve it. |
| `src/tests/custody-transition.test.ts` | mode/account lock order, preflight and revalidation aborts, fingerprint-gated writes, post-write readback, torn-read deferral, and transition outcomes. |
| `src/tests/custody-main.test.ts` | main slot classification, two-read absence confirmation, host slot reconciliation, and main factory behavior. |
| `src/tests/custody-runtime.test.ts` | boot/tick mode gating, discovery, row history orphan causes, corrupt fallback installation, resume completion, and unavailable vault projection. |
| `src/tests/custody.test.ts` | exact tombstone recognition, prefix refusal, identity binding, enrollment completion, and refresh-lock serialization. |
| `src/tests/custody-authorize.test.ts` | custody-aware authorization and verified in-process main login records. |
| `src/tests/custody-refresh.test.ts` | refresh exclusion for tombstoned or bound fallback accounts and lock behavior. |
| `src/tests/custody-request.test.ts` | request-path custody loading, served-vault provenance, and identity checks. |
| `src/tests/commands.test.ts` | enter/leave command behavior, account enable refusal, add refusal under claustrum, and the transition confirmation text. |

## §17 debts folded

| debt | landing |
|---|---|
| S-DI | Required-injection rule gives the constructor shape, mandatory property, call-site rule, and incident rationale. |
| S-orphan | Binding-pending + orphan causes names both `row removed` and `awaiting discovery`. |
| S-mm-pin | Test list names the defensive present×tombstone/local pin. |
| S-intro | Purpose & scope restricts the no-local-serving claim to `mode=claustrum`. |
| S-order | Invariant B states that manifest unreadability takes precedence over local/tombstone inspection. |
| S-15.8 | Invariant B records that unreadable refusal is decided; only distinct typed presentation remains open. |
| S-mode-axis | Coordinates records config absent as local and config-unparseable as the actionable `loadAccounts()` error path. |

## Divergences from spec prose

- The local-exit `present × real × unverified` row is implemented as `INERT:needs-login`, not `INERT:enrolled-under-local`. The latter remains a listed but unused reason. The maintainer-ruled §15.6 wording says this row is `needs-login`; the §16 table and earlier plan prose use the older name. The evaluator and sidebar follow `needs-login`.
- The `present × slot-absent × serves/cold/needs_reauth` rows do not install main tombstones. The implementation returns `INERT:takeover-incomplete/slot-absent`; the prose that prescribed INSTALL is superseded by the implemented main-host carve-out.
- Unreadable refusal is implemented and unconditional before other predicate work. The remaining open question is presentation granularity, not whether refusal happens.

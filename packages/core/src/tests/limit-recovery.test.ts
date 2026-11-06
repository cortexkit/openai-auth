import { describe, expect, test } from 'bun:test'
import {
  createLimitsNamespace,
  type LimitsPersistenceSnapshot,
} from '@cortexkit/common-auth/limits'
import { LimitRecoveryLatch } from '../limit-recovery'
import { binding } from './limit-test-support'

const namespace = 'recovery-test'
const a = binding(namespace)
const b = binding(namespace, 'b')
function view(
  until = 100,
  evidenceAt = 50,
  revision = 1,
  generation = 'one',
  id = 'a',
): LimitsPersistenceSnapshot {
  const account = binding(namespace, id)
  return {
    snapshot: {
      ...createLimitsNamespace(namespace, generation),
      revision,
      marks: [
        {
          key: {
            account: account.account,
            scope: { kind: 'pool' },
            window: 'account',
          },
          mergeLaw: 'max-until',
          entries: [
            {
              cause: 'rate-limit',
              until,
              evidenceAt,
              baseRevision: 0,
              committedRevision: revision,
            },
          ],
        },
      ],
    },
    bindings: [a, b, account],
    authoritative: true,
  }
}
function adopt(
  latch: LimitRecoveryLatch,
  raw: LimitsPersistenceSnapshot,
  at = 100,
) {
  expect(latch.adopt(latch.capture(raw, at), raw.snapshot)).toBe(true)
}

describe('expired recovery evidence', () => {
  test('cold expired hydration and second-owner reload each earn one account-specific clear', () => {
    const latch = new LimitRecoveryLatch()
    adopt(latch, view())
    expect(latch.candidate(b, 100)).toBeUndefined()
    const candidate = latch.candidate(a, 100)
    expect(candidate).toEqual({
      account: a.account,
      until: 100,
      evidenceAt: 50,
      committedRevision: 1,
      generation: 'one',
    })
    expect(latch.consume(candidate!)).toBe(true)
    expect(latch.consume(candidate!)).toBe(false)
    adopt(latch, view(100, 50, 2))
    expect(latch.candidate(a, 100)).toBeUndefined()
    adopt(latch, view(120, 70, 3), 120)
    expect(latch.consume(latch.candidate(a, 120)!)).toBe(true)
  })

  test('an unrelated revision and delayed pre-clear evidence never re-arm a consumed mark', () => {
    const latch = new LimitRecoveryLatch()
    const raw = view()
    const delayed = latch.capture(raw, 100)
    adopt(latch, raw)
    expect(latch.consume(latch.candidate(a, 100)!)).toBe(true)
    adopt(latch, view(100, 50, 9))
    expect(latch.adopt(delayed, view(100, 50, 9).snapshot)).toBe(false)
    for (let i = 0; i < 20; i++) {
      adopt(latch, view(100, 50, 10 + i))
      expect(latch.candidate(a, 100)).toBeUndefined()
    }
  })

  test('non-authoritative equal revisions and delayed pre-replacement reads enable no clear', () => {
    const latch = new LimitRecoveryLatch()
    const old = latch.capture(view(), 100)
    const unverifiable = { ...view(), authoritative: false }
    expect(
      latch.adopt(latch.capture(unverifiable, 100), unverifiable.snapshot),
    ).toBe(false)
    expect(latch.candidate(a, 100)).toBeUndefined()
    const replacement = {
      ...view(100, 50, 1, 'two'),
      snapshot: createLimitsNamespace(namespace, 'two'),
    }
    adopt(latch, replacement)
    expect(latch.adopt(old, replacement.snapshot)).toBe(false)
    expect(latch.candidate(a, 100)).toBeUndefined()
    adopt(latch, view(100, 50, 1, 'two'))
    expect(latch.consume(latch.candidate(a, 100)!)).toBe(true)
  })

  test('replacement retires consumed identities even with equal expiry and revision', () => {
    const latch = new LimitRecoveryLatch()
    adopt(latch, view())
    expect(latch.consume(latch.candidate(a, 100)!)).toBe(true)
    adopt(latch, view(100, 50, 1, 'replacement'))
    const evidence = latch.candidate(a, 100)!
    expect(evidence.generation).toBe('replacement')
    expect(latch.consume(evidence)).toBe(true)
  })

  test('cross-account pruning stages remembered expiry but never live or withdrawn bindings', () => {
    const latch = new LimitRecoveryLatch()
    const raw = view(200)
    adopt(latch, raw, 100)
    expect(latch.candidate(a, 100)).toBeUndefined()
    const pruned = {
      ...raw,
      snapshot: { ...raw.snapshot, revision: 2, marks: [] },
    }
    adopt(latch, pruned, 200)
    // A later unrelated read must not discard evidence already pruned by B.
    adopt(
      latch,
      { ...pruned, snapshot: { ...pruned.snapshot, revision: 3 } },
      201,
    )
    expect(latch.candidate(b, 201)).toBeUndefined()
    expect(latch.consume(latch.candidate(a, 201)!)).toBe(true)
    adopt(latch, { ...raw, snapshot: { ...raw.snapshot, revision: 4 } }, 201)
    expect(latch.candidate(a, 201)).toBeUndefined()
    const second = new LimitRecoveryLatch()
    adopt(second, raw, 100)
    adopt(second, pruned, 199)
    adopt(second, pruned, 201)
    expect(second.candidate(a, 201)).toBeUndefined()
    const withdrawn = new LimitRecoveryLatch()
    adopt(withdrawn, raw, 100)
    adopt(withdrawn, { ...pruned, bindings: [b] }, 201)
    expect(withdrawn.candidate(a, 201)).toBeUndefined()
  })

  test('rejected-clear evidence re-arms only for later until or newer evidenceAt', () => {
    const latch = new LimitRecoveryLatch()
    adopt(latch, view())
    expect(latch.consume(latch.candidate(a, 100)!)).toBe(true)
    adopt(latch, view(100, 50, 20))
    expect(latch.candidate(a, 100)).toBeUndefined()
    adopt(latch, view(100, 51, 21))
    expect(latch.consume(latch.candidate(a, 100)!)).toBe(true)
    adopt(latch, view(101, 50, 22), 101)
    expect(latch.consume(latch.candidate(a, 101)!)).toBe(true)
  })

  test('an older tombstone cannot suppress recovery of a later mark pruned by another account', () => {
    const latch = new LimitRecoveryLatch()
    const raw = view(200, 150, 3)
    adopt(latch, raw, 199)
    const pruned = {
      ...raw,
      snapshot: {
        ...raw.snapshot,
        revision: 4,
        marks: [],
        tombstones: [
          {
            key: raw.snapshot.marks[0]!.key,
            revision: 2,
            cause: 'rate-limit' as const,
          },
        ],
      },
    }
    adopt(latch, pruned, 200)
    expect(latch.candidate(a, 200)?.evidenceAt).toBe(150)
    expect(latch.consume(latch.candidate(a, 200)!)).toBe(true)
  })

  test('remembered and staged overflow discard new entries without evicting old evidence', () => {
    for (const live of [false, true]) {
      const latch = new LimitRecoveryLatch()
      const rows = Array.from({ length: 257 }, (_, i) =>
        view(100, 50, 1, 'one', String(i)),
      )
      const raw = {
        ...rows[0]!,
        bindings: rows.map((row) => row.bindings[2]!),
        snapshot: {
          ...rows[0]!.snapshot,
          marks: rows.flatMap((row) => row.snapshot.marks),
        },
      }
      adopt(latch, raw, live ? 99 : 100)
      if (live)
        adopt(
          latch,
          { ...raw, snapshot: { ...raw.snapshot, marks: [], revision: 2 } },
          100,
        )
      expect(latch.candidate(binding(namespace, '256'), 100)).toBeUndefined()
      expect(
        latch.consume(latch.candidate(binding(namespace, '0'), 100)!),
      ).toBe(true)
      expect(latch.candidate(binding(namespace, '255'), 100)).toBeDefined()
    }
  })

  test('consumed overflow stops recovery permanently and logs once', () => {
    const logs: string[] = []
    const latch = new LimitRecoveryLatch((line) => logs.push(line))
    for (let i = 0; i < 1024; i++) {
      adopt(latch, view(100, i, i + 1))
      expect(latch.consume(latch.candidate(a, 100)!)).toBe(true)
    }
    adopt(latch, view(100, 1024, 1025))
    expect(latch.consume(latch.candidate(a, 100)!)).toBe(false)
    adopt(latch, view(100, 1025, 1026))
    expect(latch.candidate(a, 100)).toBeUndefined()
    adopt(latch, view(100, 0, 1, 'replacement'))
    expect(latch.candidate(a, 100)).toBeUndefined()
    expect(logs).toHaveLength(1)
  })
})

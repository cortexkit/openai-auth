import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { readVaultRoster } from '@cortexkit/common-auth/claustrum'
import {
  canonicalLimitsPath,
  createLimitsNamespace,
  LimitsEnvelopeConflictError,
  LimitsEnvelopeUnsupportedError,
  LimitsPersistenceRefusal,
} from '@cortexkit/common-auth/limits'
import { createVaultLimitsAdapter } from '@cortexkit/common-auth/limits/vault'
import { quotaCodec } from '@cortexkit/common-auth/quota'
import { openPoolStore } from '@cortexkit/common-auth/store'
import {
  limitAccountKey,
  poolLimitsBinding,
  poolLimitsNamespace,
  vaultLimitsBinding,
  vaultLimitsNamespace,
} from '../limit-identity'
import {
  acquireOpenAiLimits,
  createLimitsLeaseManager,
} from '../limit-registry'
import { poolAccountKey } from '../pool-source-state'
import { guardLocalStoreReads } from './fixtures/limit-local-store-guard'
import {
  binding,
  deferred,
  mark,
  memoryAdapter,
  settle,
  TestLimitsClock,
} from './limit-test-support'

function fixture() {
  const clock = new TestLimitsClock()
  const namespace = `test-${randomUUID()}`
  const memory = memoryAdapter(namespace, clock)
  const logs: string[] = []
  const manager = createLimitsLeaseManager(clock)
  let factories = 0
  const options = {
    namespace,
    adapter: async () => {
      factories++
      return memory.adapter
    },
    log: (line: string) => logs.push(line),
    isAccessRestrictive: () => false,
  }
  return {
    clock,
    namespace,
    ...memory,
    manager,
    options,
    logs,
    factories: () => factories,
  }
}

test('provenance is shared by namespace owners, retired on clear and not inherited by same-expiry foreign marks', async () => {
  const f = fixture()
  const first = f.manager.acquire(f.options)
  const second = f.manager.acquire(f.options)
  try {
    await first.forRequest(true)
    const account = binding(f.namespace)
    const now = f.clock.now()
    const until = now + 90000
    first.enqueue(mark(account, until, now), {
      accountKey: account.account,
      expiry: until,
      branch: 'provider',
      observedAt: now,
      evidenceAt: now,
    })
    await first.flush()
    expect(
      second.provenance.read(account.account, until, now, now)?.branch,
    ).toBe('provider')
    second.enqueue({
      type: 'clear',
      binding: account,
      baseRevision: second.snapshot()!.revision,
      producerId: 'control',
      operationId: 'clear',
      keys: [{ scope: { kind: 'pool' }, window: 'account' }],
      cause: 'rate-limit',
      evidenceAt: now,
    })
    await second.flush()
    expect(
      first.provenance.read(account.account, until, now, now),
    ).toBeUndefined()
    first.enqueue(mark(account, until, now + 1, first.snapshot()!.revision))
    await first.flush()
    expect(
      second.provenance.read(account.account, until, now + 1, now),
    ).toBeUndefined()
    const stale = { ...account, credentialEpoch: 'wrong' }
    first.enqueue(mark(stale, until + 1, now + 2, first.snapshot()!.revision), {
      accountKey: account.account,
      expiry: until + 1,
      branch: 'provider',
      observedAt: now,
      evidenceAt: now + 2,
    })
    await first.flush()
    expect(
      first.provenance.read(account.account, until + 1, now + 2, now),
    ).toBeUndefined()
  } finally {
    await first.dispose()
    await second.dispose()
  }
})

describe('core limits namespace lease', () => {
  test('canonical paths share aliases before store directories exist and isolate store tuples', async () => {
    const root = dirname(
      canonicalLimitsPath(
        join(await mkdtemp(join(tmpdir(), 'openai-limit-paths-')), '_'),
      ),
    )
    try {
      await mkdir(join(root, 'real'))
      await symlink(join(root, 'real'), join(root, 'alias-one'), 'dir')
      await symlink(join(root, 'real'), join(root, 'alias-two'), 'dir')
      const path = (parent: string, file: string) =>
        join(root, parent, 'not-yet-created', file)
      const expectedPool = JSON.stringify([
        'openai',
        'pool',
        path('real', 'config'),
        path('real', 'state'),
      ])
      // Saved limits use these exact path bytes. Compute expected paths without
      // the shared helper so a canonicalization change cannot silently reset them.
      const checkSharedPaths = () => {
        for (const parent of ['real', 'alias-one', 'alias-two']) {
          expect(canonicalLimitsPath(join(root, parent, 'config'))).toBe(
            join(root, 'real', 'config'),
          )
          for (const file of ['config', 'state', 'roster']) {
            expect(canonicalLimitsPath(path(parent, file))).toBe(
              path('real', file),
            )
          }
        }
      }
      checkSharedPaths()
      expect(
        poolLimitsNamespace(
          path('alias-one', 'config'),
          path('alias-two', 'state'),
        ),
      ).toBe(expectedPool)
      expect(vaultLimitsNamespace(path('alias-one', 'roster'))).toBe(
        JSON.stringify(['openai', 'vault', path('real', 'roster')]),
      )
      await mkdir(join(root, 'real', 'not-yet-created'))
      checkSharedPaths()
      expect(
        poolLimitsNamespace(
          path('alias-two', 'config'),
          path('alias-one', 'state'),
        ),
      ).toBe(expectedPool)
      expect(vaultLimitsNamespace(path('alias-two', 'roster'))).toBe(
        JSON.stringify(['openai', 'vault', path('real', 'roster')]),
      )
      expect(
        poolLimitsNamespace(path('real', 'config'), path('real', 'other')),
      ).not.toBe(expectedPool)
      expect(
        poolLimitsNamespace(path('real', 'other'), path('real', 'state')),
      ).not.toBe(expectedPool)
      expect(vaultLimitsNamespace(path('real', 'roster'))).not.toBe(
        vaultLimitsNamespace(path('real', 'other')),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keys isolate duplicate identities and relogin while refresh and receipt rotation retain them', () => {
    const row = { id: 'a', credentialEpoch: 1, identity: 'same-wire' }
    expect(poolLimitsBinding('n', row)).toEqual({
      account: { namespace: 'n', accountId: 'a', incarnation: '1' },
      credentialEpoch: '1',
      identity: 'same-wire',
    })
    expect(poolAccountKey(row)).toBe('["a",1]')
    expect(poolAccountKey({ ...row, id: 'b' })).not.toBe(poolAccountKey(row))
    expect(poolAccountKey({ ...row, credentialEpoch: 2 })).not.toBe(
      poolAccountKey(row),
    )
    expect(poolLimitsBinding('n', { id: 'a' })).toBeUndefined()
    expect(limitAccountKey('n', { kind: 'pool', ...row })).toEqual({
      namespace: 'n',
      accountId: 'a',
      incarnation: '1',
    })
    const route = { routeId: 'a', addedAt: 42, accountIdentity: 'wire' }
    expect(vaultLimitsBinding('v', route).account).toEqual({
      namespace: 'v',
      accountId: 'a',
      incarnation: '42',
    })
    expect(limitAccountKey('v', { kind: 'vault', ...route })).toEqual({
      namespace: 'v',
      accountId: 'a',
      incarnation: '42',
    })
    expect(
      vaultLimitsBinding('v', { ...route, addedAt: 43 }).account,
    ).not.toEqual(vaultLimitsBinding('v', route).account)
    for (const id of ['main', '__former_main__']) {
      expect(limitAccountKey('n', { kind: 'legacy', id })).toBeUndefined()
      expect(
        limitAccountKey('n', { kind: 'legacy', id, verifiedIdentity: 'wire' }),
      ).toEqual({ namespace: 'n', accountId: id, incarnation: 'wire' })
    }
  })

  test('one adapter and registry serve all owners lazily and release only the last owner', async () => {
    const f = fixture()
    const a = f.manager.acquire(f.options)
    const b = f.manager.acquire(f.options)
    expect(f.factories()).toBe(0)
    await a.forRequest(false)
    expect(f.factories()).toBe(0)
    await Promise.all([a.forRequest(true), b.forRequest(true)])
    expect(f.factories()).toBe(1)
    expect(a.registry).toBe(b.registry)
    a.enqueue(mark(binding(f.namespace), f.clock.now() + 100, f.clock.now()))
    await a.dispose()
    expect(b.snapshot()?.marks).toHaveLength(1)
    await b.dispose()
    expect(f.state.commits).toBe(1)
    expect(f.state.snapshot.revision).toBe(1)
  })

  test('distinct namespaces have isolated adapters, marks and recovery evidence', async () => {
    const f = fixture()
    const other = memoryAdapter(`${f.namespace}-other`, f.clock)
    const a = f.manager.acquire(f.options)
    const b = f.manager.acquire({
      ...f.options,
      namespace: other.adapter.namespace,
      adapter: async () => other.adapter,
    })
    await Promise.all([a.forRequest(true), b.forRequest(true)])
    a.enqueue(mark(binding(f.namespace), f.clock.now() + 100, f.clock.now()))
    expect(a.snapshot()?.marks).toHaveLength(1)
    expect(b.snapshot()?.marks).toHaveLength(0)
    await Promise.all([a.dispose(), b.dispose()])
  })

  test('cold transient failures retry at 1000 ms and never send before hydration', async () => {
    const f = fixture()
    f.state.error = new Error('contended')
    const a = f.manager.acquire(f.options)
    let sent = false
    const request = a.forRequest(true).then(() => {
      sent = true
    })
    await settle()
    expect(f.state.reads).toBe(1)
    await f.clock.tick(999)
    expect(sent).toBe(false)
    expect(f.state.reads).toBe(1)
    f.state.error = undefined
    await f.clock.tick(1)
    await request
    expect(sent).toBe(true)
    expect(f.state.reads).toBe(2)
    expect(a.registry).toBeDefined()
    await a.dispose()
  })

  test('one 5000 ms acquisition deadline covers concurrent requests and never restarts after fallback', async () => {
    const f = fixture()
    f.state.error = new Error('offline')
    const a = f.manager.acquire(f.options)
    const b = f.manager.acquire(f.options)
    let sends = 0
    const first = a.forRequest(true).then(() => sends++)
    await f.clock.tick(4000)
    const second = b.forRequest(true).then(() => sends++)
    await f.clock.tick(999)
    expect(sends).toBe(0)
    await f.clock.tick(1)
    await Promise.all([first, second])
    expect(sends).toBe(2)
    expect(f.state.reads).toBe(5)
    expect(f.logs).toHaveLength(1)
    f.state.error = undefined
    await f.clock.tick(60_000)
    await a.forRequest(true)
    expect(a.registry).toBeUndefined()
    expect(f.state.reads).toBe(5)
    a.enqueue(mark(binding(f.namespace), f.clock.now() + 100, f.clock.now()))
    b.enqueue(mark(binding(f.namespace), f.clock.now() + 200, f.clock.now()))
    expect(f.logs).toHaveLength(2)
    expect(f.state.commits).toBe(0)
    expect(a.observe(binding(f.namespace))).toBeUndefined()
    await Promise.all([a.dispose(), b.dispose()])
  })

  test('a hung acquisition also falls back at the original deadline', async () => {
    const f = fixture()
    const held = deferred()
    f.state.beforeRead = () => held.promise
    const owner = f.manager.acquire(f.options)
    const ready = owner.forRequest(true)
    await f.clock.tick(5000)
    await ready
    expect(owner.registry).toBeUndefined()
    expect(f.logs).toHaveLength(1)
    held.resolve()
    await settle()
    await owner.dispose()
  })

  test('pending migration at plus 60 seconds does not spend the acquisition deadline', async () => {
    const f = fixture()
    const owner = f.manager.acquire(f.options)
    await owner.forRequest(false)
    await f.clock.tick(60_000)
    expect(f.state.reads).toBe(0)
    f.state.error = new LimitsPersistenceRefusal('pool-not-ready')
    await owner.forRequest(true)
    expect(owner.registry).toBeUndefined()
    expect(f.logs).toHaveLength(0)
    await f.clock.tick(60_000)
    f.state.error = undefined
    await owner.forRequest(true)
    expect(owner.registry).toBeDefined()
    owner.enqueue(
      mark(binding(f.namespace), f.clock.now() + 1000, f.clock.now()),
    )
    await owner.flush()
    expect(f.state.snapshot.revision).toBe(1)
    await owner.dispose()
  })

  for (const kind of ['migrated-pool', 'oc2-pool', 'vault']) {
    for (const ErrorType of [
      LimitsEnvelopeConflictError,
      LimitsEnvelopeUnsupportedError,
    ]) {
      test(`${kind}: typed ${ErrorType.name} rejection serves without registry once for process life`, async () => {
        const f = fixture()
        f.state.error = new ErrorType()
        const owner = f.manager.acquire(f.options)
        const request = await owner.forRequest(true)
        expect(
          (
            await request.beforeDispatch(
              binding(f.namespace),
              () => f.state.bindings,
            )
          ).status,
        ).toBe('ready')
        expect(owner.registry).toBeUndefined()
        expect(f.logs).toHaveLength(1)
        f.state.error = undefined
        await owner.forRequest(true)
        expect(f.state.reads).toBe(1)
        owner.enqueue(
          mark(binding(f.namespace), f.clock.now() + 1000, f.clock.now()),
        )
        expect(owner.observe(binding(f.namespace))).toBeUndefined()
        expect(f.logs).toHaveLength(2)
        expect(f.state.commits).toBe(0)
        await owner.dispose()
        const successor = f.manager.acquire(f.options)
        await successor.forRequest(true)
        expect(successor.registry).toBeUndefined()
        expect(f.state.reads).toBe(1)
        await successor.dispose()
      })
    }
  }

  test('abandonment after hydration releases an in-flight dispatch without waiting for its pending control', async () => {
    const f = fixture()
    const owner = f.manager.acquire(f.options)
    const request = await owner.forRequest(true)
    const held = deferred()
    f.state.beforeCommit = () => held.promise
    owner.enqueue({
      type: 'clear',
      binding: binding(f.namespace),
      producerId: 'test',
      operationId: 'blocked-clear',
      baseRevision: 0,
      keys: [{ scope: { kind: 'pool' }, window: 'account' }],
    })
    const dispatch = request.beforeDispatch(
      binding(f.namespace),
      () => f.state.bindings,
    )
    await settle()
    f.state.error = new LimitsEnvelopeConflictError()
    await owner.reload()
    expect((await dispatch).status).toBe('ready')
    expect(owner.registry).toBeUndefined()
    expect(f.logs).toHaveLength(1)
    held.resolve()
    await settle()
    await owner.dispose()
  })

  test('post-hydration reload errors back off and a success resets the 60000 ms failure run', async () => {
    const f = fixture()
    const owner = f.manager.acquire(f.options)
    await owner.forRequest(true)
    owner.enqueue(
      mark(binding(f.namespace), f.clock.now() + 200_000, f.clock.now()),
    )
    await owner.flush()
    f.state.error = new Error('offline')
    await owner.reload()
    const reads = f.state.reads
    expect(owner.snapshot()?.marks).toHaveLength(1)
    await f.clock.tick(999)
    await owner.reload()
    expect(f.state.reads).toBe(reads)
    await f.clock.tick(1)
    await owner.reload()
    expect(f.state.reads).toBe(reads + 1)
    await f.clock.tick(1999)
    await owner.reload()
    expect(f.state.reads).toBe(reads + 1)
    f.state.error = undefined
    await f.clock.tick(1)
    expect(f.state.reads).toBe(reads + 2)
    await f.clock.tick(59_999)
    expect(owner.registry).toBeDefined()
    f.state.error = new Error('offline again')
    await owner.reload()
    await f.clock.tick(59_999)
    expect(owner.registry).toBeDefined()
    await f.clock.tick(1)
    expect(owner.registry).toBeUndefined()
    expect(f.logs).toHaveLength(1)
    await owner.dispose()
  })

  test('projection-only reload serves a newly published row inside the fresh interval in an old process', async () => {
    const f = fixture()
    f.state.bindings = []
    const owner = f.manager.acquire(f.options)
    await owner.forRequest(true)
    await f.clock.tick(60_001)
    await owner.reload()
    const reads = f.state.reads
    f.state.bindings = [binding(f.namespace)]
    const request = await owner.forRequest(true)
    await request.reloadForBindings(() => f.state.bindings)
    expect(f.state.reads).toBe(reads + 1)
    expect(
      (
        await request.beforeDispatch(
          binding(f.namespace),
          () => f.state.bindings,
        )
      ).status,
    ).toBe('ready')
    expect(f.state.reads).toBe(reads + 1)
    // Quota and mark writes do not change the binding projection.
    owner.enqueue(
      mark(binding(f.namespace), f.clock.now() + 100, f.clock.now()),
    )
    await owner.flush()
    await request.reloadForBindings(() => f.state.bindings)
    expect(f.state.reads).toBe(reads + 1)
    await owner.dispose()
  })

  test('projection churn stops at a per-request 5000 ms bound and validates the current binding', async () => {
    for (const change of ['stable-account', 'withdrawn', 'replaced']) {
      const f = fixture()
      const owner = f.manager.acquire(f.options)
      await owner.forRequest(true)
      const expected = binding(f.namespace)
      let iteration = 0
      let current = [expected, binding(f.namespace, 'other-0')]
      f.state.beforeRead = async () => {
        f.clock.time += 1000
        iteration++
        if (iteration === 5 && change === 'withdrawn') current = []
        else if (iteration === 5 && change === 'replaced')
          current = [binding(f.namespace, 'a', '2')]
        else current = [expected, binding(f.namespace, `other-${iteration}`)]
      }
      f.state.bindings = current
      const request = await owner.forRequest(true)
      const result = await request.beforeDispatch(expected, () => current)
      expect(iteration).toBe(5)
      expect(result.status).toBe(
        change === 'stable-account'
          ? 'ready'
          : change === 'withdrawn'
            ? 'absent'
            : 'changed',
      )
      f.state.beforeRead = undefined
      f.state.bindings = current
      if (change === 'stable-account') {
        const next = await owner.forRequest(true)
        await next.reloadForBindings(() => current)
        expect(f.state.reads).toBe(7)
      }
      await owner.dispose()
    }
  })

  test('a missing epoch has no registry binding fence or mark', async () => {
    const f = fixture()
    f.state.bindings = []
    const owner = f.manager.acquire(f.options)
    const request = await owner.forRequest(true)
    expect(
      (await request.beforeDispatch(undefined, () => [], 'legacy-row')).status,
    ).toBe('ready')
    expect(owner.observe(undefined)).toBeUndefined()
    owner.dropSignal()
    owner.dropSignal()
    expect(f.logs).toHaveLength(1)
    await owner.dispose()
  })

  test('healthy sends add no operations; one real mark and expired recovery add exactly two', async () => {
    const f = fixture()
    const owner = f.manager.acquire(f.options)
    const otherOwner = f.manager.acquire(f.options)
    const request = await owner.forRequest(true)
    await otherOwner.forRequest(true)
    const a = binding(f.namespace)
    for (let i = 0; i < 20; i++) {
      const probe = owner.observe(a)
      expect(
        (await request.beforeDispatch(a, () => f.state.bindings)).status,
      ).toBe('ready')
      owner.afterProbe(probe, true)
    }
    await owner.flush()
    expect(f.state.snapshot.revision).toBe(0)
    expect(f.state.snapshot.operationIds).toHaveLength(0)
    expect(f.state.commits).toBe(0)
    owner.enqueue(mark(a, f.clock.now() + 1000, f.clock.now()))
    await owner.flush()
    await owner.reload()
    await f.clock.tick(1000)
    await otherOwner.reload()
    const probe = otherOwner.observe(a)
    expect(probe?.evidence?.evidenceAt).toBe(100_000)
    otherOwner.afterProbe(probe, true)
    await otherOwner.flush()
    expect(f.state.snapshot.revision).toBe(2)
    expect(f.state.snapshot.tombstones).toHaveLength(1)
    expect(f.state.snapshot.tombstones[0]?.cause).toBe('rate-limit')
    for (let i = 0; i < 20; i++) owner.afterProbe(owner.observe(a), true)
    await owner.flush()
    expect(f.state.snapshot.revision).toBe(2)
    expect(f.state.snapshot.operationIds).toHaveLength(2)
    expect(
      f.state.commands.filter((command) => command.type === 'clear'),
    ).toEqual([
      expect.objectContaining({
        evidenceAt: 100_000,
        cause: 'rate-limit',
        baseRevision: 1,
      }),
    ])
    await Promise.all([owner.dispose(), otherOwner.dispose()])
  })

  test('timed-mark commit never blocks an unrelated dispatch', async () => {
    const f = fixture()
    const a = binding(f.namespace)
    const b = binding(f.namespace, 'b')
    f.state.bindings = [a, b]
    const owner = f.manager.acquire(f.options)
    const request = await owner.forRequest(true)
    const held = deferred()
    f.state.beforeCommit = () => held.promise
    owner.enqueue(mark(a, f.clock.now() + 1000, f.clock.now()))
    const flush = owner.flush()
    expect(
      (await request.beforeDispatch(b, () => f.state.bindings)).status,
    ).toBe('ready')
    held.resolve()
    await flush
    await owner.dispose()
  })

  test('live escape success, parsed limits and failed probes never earn recovery clears', async () => {
    const f = fixture()
    const owner = f.manager.acquire(f.options)
    await owner.forRequest(true)
    const a = binding(f.namespace)
    owner.enqueue(mark(a, f.clock.now() + 1000, f.clock.now()))
    await owner.flush()
    await owner.reload()
    owner.afterProbe(owner.observe(a), true)
    await owner.flush()
    expect(
      f.state.commands.filter((command) => command.type === 'clear'),
    ).toHaveLength(0)
    await f.clock.tick(1000)
    await owner.reload()
    owner.afterProbe(owner.observe(a), false)
    owner.afterProbe(owner.observe(a), true, true)
    await owner.flush()
    expect(
      f.state.commands.filter((command) => command.type === 'clear'),
    ).toHaveLength(0)
    owner.afterProbe(owner.observe(a), true)
    await owner.flush()
    expect(
      f.state.commands.filter((command) => command.type === 'clear'),
    ).toHaveLength(1)
    await owner.dispose()
  })
})

// These tests cover native foreign-envelope hydration. Envelope decoding and
// repair remain common-auth's job.
for (const mode of ['migrated-pool', 'oc2-pool', 'vault'] as const) {
  test(`${mode}: native foreign-envelope hydration serves its first request without speculative writes`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'openai-limits-adopter-'))
    const configPath = join(root, 'config.json')
    const statePath = join(root, 'state.json')
    const rosterPath = join(root, 'roster.json')
    const store =
      mode === 'vault'
        ? undefined
        : openPoolStore({
            provider: 'openai',
            configPath,
            statePath,
            quota: quotaCodec,
          })
    const foreign = {
      ...createLimitsNamespace('foreign', 'old-generation'),
      revision: 1,
      marks: [
        {
          key: {
            account: binding('foreign').account,
            scope: { kind: 'pool' },
            window: 'account',
          },
          mergeLaw: 'max-until',
          entries: [
            {
              cause: 'rate-limit',
              until: Date.now() + 600_000,
              evidenceAt: Date.now(),
              baseRevision: 0,
              committedRevision: 1,
            },
          ],
        },
      ],
    }
    let owner: ReturnType<typeof acquireOpenAiLimits> | undefined
    let guard: ReturnType<typeof guardLocalStoreReads> | undefined
    try {
      let expected = binding('unused')
      if (store) {
        await store.add({
          id: 'a',
          identity: 'wire-a',
          credential: {
            type: 'oauth',
            access: 'fake-access',
            refresh: 'fake-refresh',
          },
        })
        const config = JSON.parse(await readFile(configPath, 'utf8'))
        await writeFile(
          configPath,
          JSON.stringify({ ...config, commonAuthLimits: foreign }),
        )
        const pool = await store.read()
        expect(pool.status).toBe('ready')
        if (pool.status !== 'ready')
          throw new Error('test pool did not initialize')
        expected = poolLimitsBinding(
          poolLimitsNamespace(configPath, statePath),
          pool.rows[0]!,
        )!
      } else {
        const row = {
          routeId: 'a',
          credentialId: 'vault-login',
          credentialType: 'oauth',
          accountIdentity: 'wire-a',
          state: 'active',
          label: 'A',
          enabled: true,
          addedAt: 42,
        }
        await writeFile(
          rosterPath,
          JSON.stringify({
            version: 1,
            complete: true,
            rows: [row],
            declined: [],
            limits: foreign,
          }),
        )
        await writeFile(
          configPath,
          JSON.stringify({
            routing: { mode: 'ordered' },
            accounts: [{ secret: 'tripwire' }],
            commonAuthPool: { rows: [] },
          }),
        )
        await writeFile(statePath, 'local-credential-tripwire')
        guard = guardLocalStoreReads(configPath, statePath)
        expected = vaultLimitsBinding(vaultLimitsNamespace(rosterPath), row)
      }
      owner = acquireOpenAiLimits({
        source: store
          ? { kind: 'pool', configPath, statePath, store }
          : { kind: 'vault', rosterPath },
      })
      const request = await owner.forRequest(true)
      expect(
        (await request.beforeDispatch(expected, () => [expected])).status,
      ).toBe('ready')
      expect(owner.snapshot()?.marks).toHaveLength(0)
      for (let i = 0; i < 20; i++)
        owner.afterProbe(owner.observe(expected), true)
      await owner.flush()
      expect(owner.snapshot()?.revision).toBe(0)
      expect(owner.snapshot()?.operationIds).toHaveLength(0)
      if (guard)
        expect(guard.counts()).toEqual({ operations: 0, settingsReads: 0 })
      await owner.dispose()
      owner = undefined
      if (store) {
        expect(
          JSON.parse(await readFile(configPath, 'utf8')).commonAuthLimits,
        ).toEqual(foreign)
      } else {
        expect((await readVaultRoster(rosterPath))?.limits).toEqual(foreign)
        expect(guard?.counts()).toEqual({ operations: 0, settingsReads: 0 })
      }
    } finally {
      await owner?.dispose()
      guard?.restore()
      await store?.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('vault hydrate, reload, mark, recovery and disposal never touch local account files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openai-vault-limit-io-'))
  const configPath = join(root, 'config.json')
  const statePath = join(root, 'state.json')
  const rosterPath = join(root, 'roster.json')
  const row = {
    routeId: 'a',
    credentialId: 'vault-login',
    credentialType: 'oauth',
    accountIdentity: 'wire-a',
    state: 'active',
    label: 'A',
    enabled: true,
    addedAt: 42,
  }
  await writeFile(
    rosterPath,
    JSON.stringify({ version: 1, complete: true, rows: [row], declined: [] }),
  )
  await writeFile(
    configPath,
    JSON.stringify({
      routing: { mode: 'ordered' },
      accounts: [{ secret: 'tripwire' }],
      commonAuthPool: {},
    }),
  )
  await writeFile(statePath, 'local-credential-tripwire')
  const guard = guardLocalStoreReads(configPath, statePath)
  const clock = new TestLimitsClock()
  const namespace = vaultLimitsNamespace(rosterPath)
  const owner = createLimitsLeaseManager(clock).acquire({
    namespace,
    adapter: () =>
      createVaultLimitsAdapter({ namespace, path: rosterPath, now: clock.now }),
    log: () => {},
    isAccessRestrictive: () => false,
  })
  try {
    const expected = vaultLimitsBinding(vaultLimitsNamespace(rosterPath), row)
    const request = await owner.forRequest(true)
    for (let i = 0; i < 20; i++) {
      expect(
        (await request.beforeDispatch(expected, () => [expected])).status,
      ).toBe('ready')
      owner.afterProbe(owner.observe(expected), true)
    }
    await owner.reload()
    await owner.flush()
    expect(owner.snapshot()?.revision).toBe(0)
    expect(owner.snapshot()?.operationIds).toHaveLength(0)
    const evidenceAt = clock.now()
    owner.enqueue(mark(expected, clock.now() + 1000, evidenceAt))
    await owner.flush()
    expect(owner.snapshot()?.revision).toBe(1)
    await clock.tick(1000)
    await owner.reload()
    owner.afterProbe(owner.observe(expected), true)
    await owner.flush()
    expect(owner.snapshot()?.revision).toBe(2)
    for (let i = 0; i < 20; i++) owner.afterProbe(owner.observe(expected), true)
    await owner.flush()
    expect(owner.snapshot()?.revision).toBe(2)
    expect(owner.snapshot()?.operationIds).toHaveLength(2)
    expect(guard.counts()).toEqual({ operations: 0, settingsReads: 0 })
    await owner.dispose()
    expect(guard.counts()).toEqual({ operations: 0, settingsReads: 0 })
  } finally {
    await owner.dispose()
    guard.restore()
    await rm(root, { recursive: true, force: true })
  }
})

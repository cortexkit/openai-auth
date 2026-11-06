import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VaultRosterFile } from '@cortexkit/common-auth/claustrum'
import * as stores from '@cortexkit/common-auth/store'
import * as limitsCore from '@cortexkit/openai-auth-core/internal'
import { OpenCodeLimitSource, projectOpenCodeMarks } from '../core/limit-source'
import { PoolAccountSource } from '../core/pool-account-source'
import { poolFiles, seedPool } from './fixtures/opencode2-host'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function registryMark(source: PoolAccountSource, rowId: string, until: number) {
  const owner = source.limitsOwner()!
  const binding = source
    .limitsBindings()
    .find((binding) => binding.account.accountId === rowId)
  const probe = owner.observe(binding)
  if (!probe) {
    owner.dropSignal()
    return
  }
  owner.enqueue({
    type: 'mark',
    binding: probe.binding,
    baseRevision: probe.baseRevision,
    producerId: 'source-test',
    operationId: crypto.randomUUID(),
    scope: { kind: 'pool' },
    window: 'account',
    cause: 'rate-limit',
    until,
    evidenceAt: Date.now(),
    mergeLaw: 'max-until',
  })
}

function marks(source: PoolAccountSource) {
  return projectOpenCodeMarks(
    source.limitsOwner()?.snapshot(),
    source.limitsBindings(),
  )
}

function setup(
  rows: { id: string; identity?: string }[] = [{ id: 'a' }, { id: 'b' }],
) {
  const files = poolFiles()
  seedPool(files, 'main-first', rows)
  const firstRoster = Promise.withResolvers<void>()
  const sources: PoolAccountSource[] = []
  const create = (
    extra: Partial<ConstructorParameters<typeof PoolAccountSource>[0]> = {},
  ) => {
    const source = new PoolAccountSource({
      paths: files.paths,
      refreshProvider: async () => {
        throw new Error('unexpected refresh')
      },
      pullQuota: async () => {
        throw new Error('unexpected quota poll')
      },
      // Hold auxiliary first-sight polls; these tests exercise limits only.
      vaultFirstRoster: firstRoster.promise,
      ...extra,
    })
    sources.push(source)
    return source
  }
  cleanup.push(async () => {
    await Promise.all(sources.map((source) => source.dispose()))
    firstRoster.resolve()
    rmSync(files.dir, { recursive: true, force: true })
  })
  return { files, create }
}

function localVault() {
  return {
    authority: async () => 'local' as const,
    enrolled: () => false,
    awaitRequestRoster: async () => {},
    snapshot: () => undefined,
    routes: () => [],
    paths: { rosterPath: 'must-not-acquire-vault' },
  }
}

describe('OpenCode limits source', () => {
  for (const kind of ['disabled', 'cold', 'removed', 'static-key'] as const) {
    it(`does not acquire or read limits for a ${kind} vault route`, async () => {
      const { files, create } = setup()
      const roster: VaultRosterFile = {
        version: 1,
        complete: true,
        declined: [],
        rows:
          kind === 'removed'
            ? []
            : [
                {
                  routeId: 'vault-a',
                  credentialId: 'credential-a',
                  credentialType: kind === 'static-key' ? 'api_key' : 'oauth',
                  accountIdentity: 'chatgpt-vault-a',
                  state: kind === 'cold' ? 'needs_reauth' : 'active',
                  label: 'a',
                  enabled: kind !== 'disabled',
                  addedAt: 7,
                },
              ],
      }
      const acquire = spyOn(
        limitsCore,
        'acquireOpenAiLimits',
      ).mockImplementation(() => {
        throw new Error('ineligible route started a limits read')
      })
      const host = new OpenCodeLimitSource({
        pool: create(),
        vault: {
          ...localVault(),
          authority: async () => 'vault',
          enrolled: () => true,
          snapshot: () => roster,
          routes: () =>
            kind === 'static-key' ? [{ id: 'vault-a', kind: 'api-key' }] : [],
          paths: { rosterPath: join(files.dir, 'unused-roster.json') },
        },
      })
      try {
        expect(await host.forRequest()).toBeUndefined()
        expect(host.owner()).toBeUndefined()
        expect(host.marks()).toEqual(new Map())
        expect(acquire).not.toHaveBeenCalled()
      } finally {
        await host.dispose()
        acquire.mockRestore()
      }
    })
  }

  it('reconciles retained OAuth ownership without waiting for cold or disabled routes to become active', async () => {
    const { files, create } = setup()
    const rosterPath = join(files.dir, 'vault-roster.json')
    const roster: VaultRosterFile = {
      version: 1,
      complete: true,
      declined: [],
      rows: ['a', 'b', 'c'].map((id, index) => ({
        routeId: `vault-${id}`,
        credentialId: `credential-${id}`,
        credentialType: 'oauth',
        accountIdentity: `chatgpt-vault-${id}`,
        state: index === 1 ? 'needs_reauth' : 'active',
        label: id,
        enabled: index !== 2,
        addedAt: 7,
      })),
    }
    writeFileSync(rosterPath, JSON.stringify(roster))
    const host = new OpenCodeLimitSource({
      pool: create(),
      vault: {
        ...localVault(),
        authority: async () => 'vault',
        enrolled: () => true,
        snapshot: () => roster,
        routes: () => [{ id: 'vault-a', kind: 'oauth' }],
        paths: { rosterPath },
      },
    })
    cleanup.push(() => host.dispose())
    expect(await host.forRequest()).toBeDefined()
    expect(host.bindings().map((binding) => binding.account.accountId)).toEqual(
      ['vault-a'],
    )
    expect(
      host.ownershipBindings().map((binding) => binding.account.accountId),
    ).toEqual(['vault-a', 'vault-b', 'vault-c'])
    const reload = spyOn(host.owner()!.registry!, 'reload')
    try {
      expect(await host.forRequest()).toBeDefined()
      expect(reload).not.toHaveBeenCalled()
    } finally {
      reload.mockRestore()
    }
  })

  for (const rosterFirst of [true, false]) {
    it(`shares vault readiness with roster ${rosterFirst ? 'before' : 'after'} request initialization and never opens the pool`, async () => {
      const { files, create } = setup()
      const rosterPath = join(files.dir, 'vault-roster.json')
      const roster: VaultRosterFile = {
        version: 1,
        complete: true,
        declined: [],
        rows: [
          {
            routeId: 'vault-a',
            credentialId: 'credential-a',
            credentialType: 'oauth',
            accountIdentity: 'chatgpt-vault-a',
            state: 'active',
            label: 'a',
            enabled: true,
            addedAt: 7,
          },
        ],
      }
      writeFileSync(rosterPath, JSON.stringify(roster))
      const initialRoster = readFileSync(rosterPath, 'utf8')
      const initialPool = readFileSync(files.configPath, 'utf8')
      const ready = Promise.withResolvers<void>()
      let available = rosterFirst
      if (rosterFirst) ready.resolve()
      const vault = {
        ...localVault(),
        authority: async () => 'vault' as const,
        enrolled: () => true,
        awaitRequestRoster: async () => {
          await ready.promise
          available = true
        },
        snapshot: () => (available ? roster : undefined),
        routes: () =>
          available ? [{ id: 'vault-a', kind: 'oauth' as const }] : [],
        paths: { rosterPath },
      }
      const pools = [create(), create()]
      const loads = pools.map((pool) => spyOn(pool, 'load'))
      const hosts = pools.map(
        (pool) => new OpenCodeLimitSource({ pool, vault }),
      )
      try {
        const requests = hosts.map((host) => host.forRequest())
        await Promise.resolve()
        if (!rosterFirst) expect(hosts[0]!.owner()).toBeUndefined()
        ready.resolve()
        for (const request of await Promise.all(requests))
          expect(request).toBeDefined()
        expect(hosts[0]!.owner()!.registry).toBe(hosts[1]!.owner()!.registry)
        expect(hosts[0]!.accountKey('vault-a')).toEqual({
          namespace: hosts[0]!.owner()!.namespace,
          accountId: 'vault-a',
          incarnation: '7',
        })
        for (const load of loads) expect(load).not.toHaveBeenCalled()
        hosts[0]!.activity.recordAccepted({
          sessionId: 's',
          accountKey: hosts[0]!.accountKey('vault-a')!,
          currentAccountKey: hosts[0]!.accountKey('vault-a')!,
          lastAcceptedAt: 1,
        })
        hosts[0]!.forget('s')
        expect(hosts[0]!.activity.size).toBe(0)
      } finally {
        ready.resolve()
        await Promise.all(hosts.map((host) => host.dispose()))
        for (const load of loads) load.mockRestore()
      }
      expect(readFileSync(rosterPath, 'utf8')).toBe(initialRoster)
      expect(readFileSync(files.configPath, 'utf8')).toBe(initialPool)
    })
  }

  for (const first of ['OC1', 'OC2']) {
    it(`shares one core lease with ${first} initialized first and writes nothing on healthy paths`, async () => {
      const { files, create } = setup()
      const before = readFileSync(files.configPath, 'utf8')
      const sources = [create(), create()]
      const hosts = sources.map(
        (pool) => new OpenCodeLimitSource({ pool, vault: localVault() }),
      )
      const order = first === 'OC1' ? [0, 1] : [1, 0]
      await sources[order[0]!]!.load()
      expect(sources[order[0]!]!.limitsOwner()).toBeUndefined()
      for (const i of order) {
        for (let n = 0; n < 20; n++) {
          const request = await hosts[i]!.forRequest()
          const binding = sources[i]!.limitsBindings()[0]!
          expect(
            (
              await request!.beforeDispatch(binding, () =>
                sources[i]!.limitsBindings(),
              )
            ).status,
          ).toBe('ready')
        }
      }
      expect(sources[0]!.limitsOwner()!.registry).toBe(
        sources[1]!.limitsOwner()!.registry,
      )
      await Promise.all(sources.map((source) => source.limitsOwner()!.flush()))
      expect(sources[0]!.limitsOwner()!.snapshot()!.revision).toBe(0)
      expect(sources[0]!.limitsOwner()!.snapshot()!.operationIds).toEqual([])
      await Promise.all(hosts.map((host) => host.dispose()))
      expect(readFileSync(files.configPath, 'utf8')).toBe(before)
    })
  }

  it('projects shared marks by row and epoch', async () => {
    const { create } = setup([
      { id: 'a', identity: 'same' },
      { id: 'b', identity: 'same' },
    ])
    const a = create()
    const b = create()
    await a.limitsForRequest()
    await b.limitsForRequest()
    const until = Date.now() + 120_000
    registryMark(a, 'a', until)
    expect(marks(b)).toEqual(new Map([['a', until]]))
    marks(b).clear()
    expect(marks(a)).toEqual(new Map([['a', until]]))
    await a.limitsOwner()!.flush()
    const oldRow = a.peek().rows[0]!
    expect(
      projectOpenCodeMarks(a.limitsOwner()!.snapshot(), [
        a.limitsBinding({ ...oldRow, credentialEpoch: 2 })!,
      ]),
    ).toEqual(new Map())
    expect(a.limitsOwner()!.snapshot()!.marks[0]!.key.window).toBe('account')
    expect(a.limitsOwner()!.snapshot()!.marks[0]!.entries[0]!.cause).toBe(
      'rate-limit',
    )
  })

  it('last-owner disposal hands off a pending journal and a new owner hydrates it', async () => {
    const { create } = setup()
    const a = create()
    const b = create()
    await a.limitsForRequest()
    await b.limitsForRequest()
    const registry = b.limitsOwner()!.registry
    await a.dispose()
    expect(b.limitsOwner()!.registry).toBe(registry)
    const until = Date.now() + 180_000
    registryMark(b, 'b', until)
    await b.dispose()
    const successor = create()
    await successor.limitsForRequest()
    expect(marks(successor)).toEqual(new Map([['b', until]]))
    expect(successor.limitsOwner()!.snapshot()!.revision).toBe(1)
  })

  it('projects only live whole-account pool marks matching the current namespace and incarnation', async () => {
    const { create } = setup()
    const source = create()
    await source.limitsForRequest()
    const owner = source.limitsOwner()!
    registryMark(source, 'a', Date.now() + 120_000)
    const snapshot = owner.snapshot()!
    const mark = snapshot.marks[0]!
    const bindings = source.limitsBindings()
    const now = Date.now()
    for (const key of [
      { ...mark.key, scope: { kind: 'model' as const, model: 'gpt-5.6' } },
      { ...mark.key, window: 'primary' },
      {
        ...mark.key,
        account: { ...mark.key.account, namespace: 'other-store' },
      },
      { ...mark.key, account: { ...mark.key.account, incarnation: '2' } },
    ])
      expect(
        projectOpenCodeMarks(
          { ...snapshot, marks: [{ ...mark, key }] },
          bindings,
          now,
        ),
      ).toEqual(new Map())
    expect(
      projectOpenCodeMarks(
        {
          ...snapshot,
          marks: [{ ...mark, entries: [{ ...mark.entries[0]!, until: now }] }],
        },
        bindings,
        now,
      ),
    ).toEqual(new Map())
  })

  it('an abandoned registry drops signals and dispose writes nothing', async () => {
    const { files, create } = setup()
    const source = create()
    await source.limitsForRequest()
    const config = JSON.parse(readFileSync(files.configPath, 'utf8'))
    config.commonAuthLimits = { schemaVersion: 2 }
    writeFileSync(files.configPath, JSON.stringify(config))
    const write = spyOn(source.poolStore(), 'updateLimitsNamespace')
    try {
      await source.limitsOwner()!.reload()
      expect(source.limitsOwner()!.registry).toBeUndefined()
      registryMark(source, 'a', Date.now() + 120_000)
      await source.dispose()
      expect(write).not.toHaveBeenCalled()
      expect(
        JSON.parse(readFileSync(files.configPath, 'utf8')).commonAuthLimits,
      ).toEqual({ schemaVersion: 2 })
    } finally {
      write.mockRestore()
    }
  })

  it('waits for consumer authority before reading or acquiring in either initialization order', async () => {
    for (const sourceFirst of [true, false]) {
      const { create } = setup()
      const ready = Promise.withResolvers<'local'>()
      let reads = 0
      const open = stores.openPoolStore
      const store = spyOn(stores, 'openPoolStore').mockImplementation(
        (options) => {
          reads++
          return open(options)
        },
      )
      const pool = create({ vaultAuthority: () => ready.promise })
      const host = new OpenCodeLimitSource({
        pool,
        vault: { ...localVault(), authority: () => ready.promise },
      })
      try {
        const startup = sourceFirst ? pool.load() : undefined
        const request = host.forRequest()
        await Promise.resolve()
        expect(reads).toBe(0)
        expect(pool.limitsOwner()).toBeUndefined()
        ready.resolve('local')
        await startup
        expect(await request).toBeDefined()
        expect(
          pool.limitsBindings().map((binding) => binding.account.accountId),
        ).toEqual(['a', 'b'])
      } finally {
        ready.resolve('local')
        await host.dispose()
        store.mockRestore()
      }
    }
  })
})

import { afterEach, expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { quotaCodec } from '@cortexkit/common-auth/quota'
import { openPoolStore, type PoolStore } from '@cortexkit/common-auth/store'
import { writeLoginToPool } from '../v2/login'
import {
  type PoolSeedRow,
  poolFiles,
  seedPool,
} from './fixtures/opencode2-host'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function setupPool(rows: PoolSeedRow[], emptyMain = false) {
  const files = poolFiles()
  dirs.push(files.dir)
  seedPool(files, 'main-first', rows)
  if (emptyMain)
    writeFileSync(files.statePath, JSON.stringify({ version: 1, accounts: {} }))
  const store = openPoolStore({
    provider: 'openai',
    ...files.paths(),
    quota: quotaCodec,
  })
  return { files, store }
}

function pauseFirstReplace(store: PoolStore) {
  const selected = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  let first = true
  const gatedStore: PoolStore = {
    ...store,
    async replace(...args) {
      if (first) {
        first = false
        selected.resolve()
        await resume.promise
      }
      return store.replace(...args)
    },
  }
  return {
    store: gatedStore,
    selected: selected.promise,
    resume: resume.resolve,
  }
}

test('two OpenCode 2 sign-ins that select empty main keep both credentials', async () => {
  const { files, store } = setupPool(
    [{ id: 'main', identity: 'former-main' }],
    true,
  )
  const gate = pauseFirstReplace(store)
  const bob = writeLoginToPool(gate.store, files.paths(), {
    id: 'bob',
    accountId: 'bob',
    refresh: 'bob-login',
  })
  let bobResult: Awaited<typeof bob>
  try {
    await Promise.race([gate.selected, bob])
    expect(
      await writeLoginToPool(store, files.paths(), {
        id: 'alice',
        accountId: 'alice',
        refresh: 'alice-login',
      }),
    ).toEqual({ id: 'main', operation: 'replaced' })
  } finally {
    gate.resume()
    bobResult = await bob
  }
  expect(files.readState().accounts.main?.refresh).toBe('alice-login')
  expect(files.readState().accounts.bob?.refresh).toBe('bob-login')
  expect(bobResult).toEqual({ id: 'bob', operation: 'added' })
})

test('an OpenCode 2 sign-in reselects a row after its holder changes account', async () => {
  const { files, store } = setupPool([{ id: 'main', identity: 'alice' }])
  const gate = pauseFirstReplace(store)
  const alice = writeLoginToPool(gate.store, files.paths(), {
    id: 'alice',
    accountId: 'alice',
    refresh: 'alice-login',
  })
  let aliceResult: Awaited<typeof alice>
  try {
    await Promise.race([gate.selected, alice])
    await store.replace(
      'main',
      { type: 'oauth', refresh: 'bob-login' },
      { identity: 'bob' },
    )
  } finally {
    gate.resume()
    aliceResult = await alice
  }
  expect(files.readState().accounts.main?.refresh).toBe('bob-login')
  expect(files.readState().accounts.alice?.refresh).toBe('alice-login')
  expect(aliceResult).toEqual({ id: 'alice', operation: 'added' })
})

test('a refused add of main re-reads before adding the login as a new row', async () => {
  const { files, store } = setupPool([])
  const events: string[] = []
  const gatedStore: PoolStore = {
    ...store,
    async read() {
      events.push('read')
      return store.read()
    },
    async add(...args) {
      events.push(`add:${args[0].id}`)
      if (events.length === 2)
        await writeLoginToPool(store, files.paths(), {
          id: 'alice',
          accountId: 'alice',
          refresh: 'alice-login',
        })
      return store.add(...args)
    },
  }
  expect(
    await writeLoginToPool(gatedStore, files.paths(), {
      id: 'bob',
      accountId: 'bob',
      refresh: 'bob-login',
    }),
  ).toEqual({ id: 'bob', operation: 'added' })
  expect(events).toEqual(['read', 'add:main', 'read', 'add:bob'])
  expect(files.readState().accounts.main?.refresh).toBe('alice-login')
  expect(files.readState().accounts.bob?.refresh).toBe('bob-login')
})

test('a stale holder whose row ID matches the login is not replaced by ID', async () => {
  const { files, store } = setupPool([
    { id: 'main' },
    { id: 'alice', identity: 'alice' },
  ])
  const gate = pauseFirstReplace(store)
  const alice = writeLoginToPool(gate.store, files.paths(), {
    id: 'alice',
    accountId: 'alice',
    refresh: 'alice-login',
  })
  try {
    await Promise.race([gate.selected, alice])
    await store.replace(
      'alice',
      { type: 'oauth', refresh: 'bob-login' },
      { identity: 'bob' },
    )
  } finally {
    gate.resume()
    await expect(alice).rejects.toMatchObject({ kind: 'id-exists' })
  }
  expect(files.readState().accounts.alice?.refresh).toBe('bob-login')
})

test('persistent replacement of the same account exhausts the login retry budget', async () => {
  const { files, store } = setupPool([{ id: 'main', identity: 'alice' }])
  let writes = 0
  const contendedStore: PoolStore = {
    ...store,
    async replace(...args) {
      await store.replace(
        'main',
        { type: 'oauth', refresh: `other-login-${++writes}` },
        { identity: 'alice' },
      )
      return store.replace(...args)
    },
  }
  await expect(
    writeLoginToPool(contendedStore, files.paths(), {
      id: 'alice',
      accountId: 'alice',
      refresh: 'alice-login',
    }),
  ).rejects.toMatchObject({ kind: 'attribution' })
  expect(writes).toBe(3)
  expect(files.readState().accounts.main?.refresh).toBe('other-login-3')
})

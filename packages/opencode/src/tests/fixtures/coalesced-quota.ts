import { expect, spyOn } from 'bun:test'
import { acquireRefreshFileLock } from '@cortexkit/common-auth/fs'
import { isQuotaMap, quotaCodec } from '@cortexkit/common-auth/quota'
import { openPoolStore, type PoolStore } from '@cortexkit/common-auth/store'

/** Exercise the serving store, but verify durability through a fresh reader. */
export async function exerciseCoalescedQuota(
  store: PoolStore,
  paths: { configPath: string; statePath: string },
  shutdown: () => Promise<unknown>,
  rowId: string,
) {
  const initial = await store.read()
  if (initial.status !== 'ready') throw new Error('pool is not ready')
  const row = initial.rows.find((row) => row.id === rowId)
  if (row?.credentialEpoch === undefined) throw new Error('missing pool row')
  const attribution = {
    credentialEpoch: row.credentialEpoch,
    identity: row.identity,
  }
  let lock: Awaited<ReturnType<typeof acquireRefreshFileLock>> = null
  const lockDeadline = Date.now() + 2_000
  do {
    lock = await acquireRefreshFileLock({
      path: paths.configPath,
      name: 'save',
      ttlMs: 10_000,
      renew: true,
    })
    if (!lock) await Bun.sleep(10)
  } while (!lock && Date.now() < lockDeadline)
  if (!lock) throw new Error('could not hold store lock')
  const checkedAt = Date.now() + 1_000
  const labels = Array.from({ length: 32 }, (_, i) => `burst-${i}`)
  let closing: Promise<unknown> | undefined
  let recording: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const closeStarted = Promise.withResolvers<void>()
  const drained = Promise.withResolvers<void>()
  const finishClose = Promise.withResolvers<void>()
  const close = store.close.bind(store)
  const closeSpy = spyOn(store, 'close').mockImplementation(async () => {
    closeStarted.resolve()
    await close()
    drained.resolve()
    await finishClose.promise
  })
  try {
    recording = (async () => {
      for (const [i, label] of labels.entries()) {
        await store.recordQuota(rowId, attribution, {
          checkedAt: checkedAt + i,
          readings: [
            { label, usedPercent: i },
            { label: 'primary', usedPercent: i },
          ],
        })
      }
    })()
    const accepted = await Promise.race([
      recording.then(
        () => true,
        () => false,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 500)
      }),
    ])
    clearTimeout(timer)
    if (!accepted)
      throw new Error(
        'quota recording did not resolve while the store lock was held',
      )
    for (const view of [await store.read(), await store.load()]) {
      if (view.status !== 'ready') throw new Error('pool is not ready')
      const quota = view.rows.find((row) => row.id === rowId)?.quota
      expect(quota).toMatchObject({
        limits: expect.arrayContaining([
          {
            scope: 'all',
            label: 'primary',
            kind: 'reading',
            checkedAt: checkedAt + 31,
            usedPercent: 31,
          },
        ]),
      })
    }
    let closed = false
    closing = shutdown().then(() => {
      closed = true
    })
    const started = await Promise.race([
      closeStarted.promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 1_000)
      }),
    ])
    clearTimeout(timer)
    if (!started)
      throw new Error('shutdown did not close the serving pool store')
    await lock.release()
    await drained.promise
    // Keep close pending after the real drain so unrelated teardown work
    // cannot make an unawaited close look like an awaited one.
    await Bun.sleep(50)
    expect(closed).toBe(false)
  } finally {
    clearTimeout(timer)
    await lock.release()
    await recording?.catch(() => {})
    finishClose.resolve()
    await closing
    closeSpy.mockRestore()
  }
  const reader = openPoolStore({
    provider: 'openai',
    ...paths,
    quota: quotaCodec,
  })
  try {
    const durable = await reader.read()
    if (durable.status !== 'ready') throw new Error('pool is not ready')
    const quota = durable.rows.find((row) => row.id === rowId)?.quota
    if (!isQuotaMap(quota)) throw new Error('missing durable quota')
    expect(
      quota.limits
        .filter((limit) => labels.includes(limit.label))
        .map((limit) => limit.label)
        .sort(),
    ).toEqual([...labels].sort())
    expect(
      quota.limits.find((limit) => limit.label === 'primary'),
    ).toMatchObject({ usedPercent: 31 })
  } finally {
    await reader.close()
  }
}

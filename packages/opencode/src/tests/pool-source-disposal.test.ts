import { describe, expect, it, spyOn } from 'bun:test'
import { rmSync } from 'node:fs'
import * as poolStores from '@cortexkit/common-auth/store'
import { PoolAccountSource } from '../core/pool-account-source'
import { poolFiles, seedPool } from './fixtures/opencode2-host'

describe('pool source disposal', () => {
  it('settled joins a read that exceeded the request budget', async () => {
    const files = poolFiles()
    seedPool(files, 'main-first', [{ id: 'main' }])
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const open = poolStores.openPoolStore
    const storeSpy = spyOn(poolStores, 'openPoolStore').mockImplementation(
      (options) => {
        const store = open(options)
        const read = store.read
        store.read = async () => {
          entered.resolve()
          await resume.promise
          return read()
        }
        return store
      },
    )
    const source = new PoolAccountSource({
      paths: files.paths,
      readBudgetMs: 1,
      refreshProvider: async () => {
        throw new Error('no refresh expected')
      },
      pullQuota: async () => undefined,
    })
    let settling: Promise<void> | undefined
    try {
      const request = source.current()
      await entered.promise
      await request
      source.dispose()
      let returned = false
      settling = source.settled().then(() => {
        returned = true
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(returned).toBe(false)
      resume.resolve()
      await settling
      expect(returned).toBe(true)
    } finally {
      resume.resolve()
      await settling
      source.dispose()
      storeSpy.mockRestore()
      rmSync(files.dir, { recursive: true, force: true })
    }
  })

  it('a disposed source starts no new reads or authority checks', async () => {
    let pathReads = 0
    let authorityReads = 0
    const source = new PoolAccountSource({
      paths: () => {
        pathReads++
        throw new Error('disposed source must not touch its paths')
      },
      vaultAuthority: async () => {
        authorityReads++
        return 'local'
      },
      refreshProvider: async () => {
        throw new Error('no refresh expected')
      },
      pullQuota: async () => undefined,
    })
    source.dispose()
    expect(await source.load()).toEqual({ active: false, rows: [] })
    expect(await source.current()).toEqual({ active: false, rows: [] })
    expect(pathReads).toBe(0)
    expect(authorityReads).toBe(0)
  })
})

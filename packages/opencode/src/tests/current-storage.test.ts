import { expect, test } from 'bun:test'
import { createCurrentStorageReader } from '../core/current-storage'

type StorageSnapshot = {
  route: string
  state: string
}

test('an older config-and-state read that finishes last cannot replace the newer snapshot', async () => {
  let config = { route: 'main-first' }
  let stamp = { mtimeMs: 1, size: 10 }
  let readCount = 0
  const stateReads = [
    Promise.withResolvers<string>(),
    Promise.withResolvers<string>(),
  ]
  const published: StorageSnapshot[] = []
  const reader = createCurrentStorageReader<StorageSnapshot>({
    path: () => '/openai-auth.json',
    stat: () => stamp,
    read: async () => {
      const route = config.route
      const state = await stateReads[readCount++]!.promise
      return { route, state }
    },
    fallback: async (error) => {
      throw error
    },
    onRead: (value) => published.push(value),
  })

  const olderRead = Promise.resolve(reader.read())
  config = { route: 'fallback-first' }
  stamp = { mtimeMs: 2, size: 13 }
  const newerRead = Promise.resolve(reader.read())

  stateReads[1]!.resolve('new-state')
  const newerSnapshot = await newerRead
  stateReads[0]!.resolve('old-state')
  await olderRead

  expect(newerSnapshot).toEqual({ route: 'fallback-first', state: 'new-state' })
  expect(published).toEqual([newerSnapshot])
  expect(reader.read()).toEqual(newerSnapshot)
  expect(readCount).toBe(2)
})

export interface StorageFileStamp {
  mtimeMs: number
  size: number
}

/** Shares a stat-gated storage snapshot without letting late reads roll it back. */
export function createCurrentStorageReader<T>(options: {
  path: () => string
  stat: (path: string) => StorageFileStamp | undefined
  read: (path: string) => Promise<T>
  fallback: (error: unknown) => Promise<T>
  onRead: (value: T) => void
}) {
  let cache: (StorageFileStamp & { path: string; value: T }) | undefined
  let readGeneration = 0
  let publishedGeneration = 0
  let hasPublishedValue = false
  let publishedValue: T

  return {
    read(): T | Promise<T> {
      const path = options.path()
      const stamp = options.stat(path)
      if (
        stamp &&
        cache?.path === path &&
        cache.mtimeMs === stamp.mtimeMs &&
        cache.size === stamp.size
      ) {
        return cache.value
      }
      if (!stamp) cache = undefined
      const generation = ++readGeneration
      return options
        .read(path)
        .catch(options.fallback)
        .then((value) => {
          if (generation > publishedGeneration) {
            publishedGeneration = generation
            publishedValue = value
            hasPublishedValue = true
            if (stamp) cache = { ...stamp, path, value }
            options.onRead(value)
            return value
          }
          return hasPublishedValue ? publishedValue : value
        })
    },
    invalidate() {
      cache = undefined
    },
  }
}

import { spyOn } from 'bun:test'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'

/** Observe account-row and credential-state reads while allowing config preferences. */
export function guardLocalStoreReads(configPath: string, statePath: string) {
  const config = fs.readFileSync(configPath, 'utf8')
  const parse = JSON.parse
  const readFile = fsp.readFile
  const readFileSync = fs.readFileSync
  let local = false
  let stateReads = 0
  let rowReads = 0
  const parsed = spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
    const value = parse(text, reviver)
    if (text === config) {
      for (const key of ['accounts', 'commonAuthPool']) {
        const rows = value[key]
        if (rows === undefined) continue
        Object.defineProperty(value, key, {
          enumerable: true,
          get() {
            rowReads++
            if (!local) throw new Error('local account rows were read')
            return rows
          },
        })
      }
    }
    return value
  })
  const observeState = (path: unknown) => {
    if (String(path) !== statePath) return
    stateReads++
    if (!local) throw new Error('local credential state was read')
  }
  const asyncRead = spyOn(fsp, 'readFile').mockImplementation(((
    ...args: Parameters<typeof readFile>
  ) => {
    observeState(args[0])
    return readFile(...args)
  }) as typeof readFile)
  const syncRead = spyOn(fs, 'readFileSync').mockImplementation(((
    ...args: Parameters<typeof readFileSync>
  ) => {
    observeState(args[0])
    return readFileSync(...args)
  }) as typeof readFileSync)
  return {
    counts: () => ({ stateReads, rowReads }),
    allowLocal: () => {
      local = true
    },
    restore: () => {
      parsed.mockRestore()
      asyncRead.mockRestore()
      syncRead.mockRestore()
    },
  }
}

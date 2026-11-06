import { spyOn } from 'bun:test'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'

/** A vault may read preferences, but never local rows, credentials or writers. */
export function guardLocalStoreReads(configPath: string, statePath: string) {
  const config = fs.readFileSync(configPath, 'utf8')
  let operations = 0
  let settingsReads = 0
  const restore: (() => void)[] = []
  const parse = JSON.parse
  const parsed = spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
    const value = parse(text, reviver)
    if (text === config) {
      for (const key of ['accounts', 'commonAuthPool']) {
        Object.defineProperty(value, key, {
          get() {
            operations++
            throw new Error('local account rows were read')
          },
        })
      }
    }
    return value
  })
  restore.push(() => parsed.mockRestore())
  const local = (arg: unknown) =>
    [configPath, statePath].some(
      (path) =>
        String(arg) === path ||
        String(arg).startsWith(`${path}.`) ||
        String(arg).startsWith(`${path}/`),
    )
  for (const module of [fs, fsp]) {
    const object = module as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >
    for (const name of [
      'readFile',
      'readFileSync',
      'writeFile',
      'writeFileSync',
      'rename',
      'renameSync',
      'open',
      'openSync',
      'watch',
      'watchFile',
      'mkdir',
      'mkdirSync',
      'unlink',
      'unlinkSync',
      'rm',
      'rmSync',
    ]) {
      const original = object[name]
      if (typeof original !== 'function') continue
      const spy = spyOn(object, name).mockImplementation(
        (...args: unknown[]) => {
          if (local(args[0]) || (name.startsWith('rename') && local(args[1]))) {
            if (
              String(args[0]) === configPath &&
              (name === 'readFile' || name === 'readFileSync')
            )
              settingsReads++
            else {
              operations++
              throw new Error(`local account store ${name} was accessed`)
            }
          }
          return original(...args)
        },
      )
      restore.push(() => spy.mockRestore())
    }
  }
  return {
    counts: () => ({ operations, settingsReads }),
    restore: () => {
      for (const undo of restore.reverse()) undo()
    },
  }
}

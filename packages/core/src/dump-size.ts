import { lstat, opendir } from 'node:fs/promises'
import { join } from 'node:path'

/** A menu-only snapshot: count regular files without reading bodies or following links. */
export async function getDumpDirectorySize(
  dir: string,
): Promise<number | undefined> {
  try {
    if (!(await lstat(dir)).isDirectory()) return undefined
    let bytes = 0
    let failed = false
    let pending: Promise<void>[] = []
    const measure = async (name: string) => {
      try {
        const file = await lstat(join(dir, name))
        if (file.isFile()) bytes += file.size
      } catch (error) {
        // A retention sweep may remove a file between listing and measuring it.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failed = true
      }
    }
    for await (const entry of await opendir(dir)) {
      if (!entry.isFile()) continue
      pending.push(measure(entry.name))
      // Bound filesystem concurrency even for an existing, very large directory.
      if (pending.length === 32) {
        await Promise.all(pending)
        pending = []
      }
    }
    await Promise.all(pending)
    return failed ? undefined : bytes
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : undefined
  }
}

export function formatDumpBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let unit = 0
  let value = bytes
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${Number(value.toFixed(1))} ${units[unit]}`
}

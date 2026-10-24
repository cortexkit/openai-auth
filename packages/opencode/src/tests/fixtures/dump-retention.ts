import { readdir, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'

export async function ageDumpFiles(dir: string) {
  const files = (await readdir(dir)).sort()
  for (const [index, file] of files.entries()) {
    // Sweeps protect recent files while a dump is still being written.
    const time = new Date(Date.now() - 600_000 + index * 1000)
    await utimes(join(dir, file), time, time)
  }
  return files
}

export async function waitForDumpCap(dir: string, cap: number) {
  let files: string[] = []
  let bytes = Infinity
  for (let attempt = 0; attempt < 100; attempt++) {
    files = await readdir(dir)
    const sizes = await Promise.all(
      files.map(async (name) => {
        try {
          return (await stat(join(dir, name))).size
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return Infinity
          throw error
        }
      }),
    )
    bytes = sizes.reduce((sum, size) => sum + size, 0)
    const complete = files.every((file) => {
      const id = file.replace(/\.(body|meta|request)\.json$/, '')
      return ['.body.json', '.meta.json', '.request.json'].every((suffix) =>
        files.includes(`${id}${suffix}`),
      )
    })
    if (bytes <= cap && complete) break
    // The shared dumper schedules retention in the background after a write.
    await Bun.sleep(10)
  }
  return { files, bytes }
}

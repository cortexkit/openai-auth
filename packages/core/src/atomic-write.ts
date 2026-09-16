import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function writeJsonAtomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${randomUUID()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  try {
    await rename(tempPath, path)
  } catch (renameError) {
    // Clean up the orphaned temp file before re-throwing so it does not
    // accumulate on disk (e.g. on a cross-device rename failure).
    await rm(tempPath, { force: true }).catch(() => {})
    throw renameError
  }
}

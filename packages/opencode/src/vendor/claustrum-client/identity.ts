import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import type { BindIdentity } from '@cortexkit/subc-client'

export function storageFingerprint(storagePath: string): string {
  const absolutePath = storagePath
  let canonicalPath: string
  try {
    canonicalPath = realpathSync(absolutePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    let ancestor = absolutePath
    while (!existsSync(ancestor)) {
      const parent = dirname(ancestor)
      if (parent === ancestor) break
      ancestor = parent
    }
    canonicalPath = resolve(realpathSync(ancestor), relative(ancestor, absolutePath))
  }
  return createHash('sha256').update(canonicalPath).digest('hex')
}

export function storeIdentity(projectRoot: string, storagePath: string): BindIdentity {
  return {
    project_root: projectRoot,
    harness: 'opencode',
    session: `store-${storageFingerprint(storagePath)}`,
  }
}

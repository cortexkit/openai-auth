import { isAbsolute, join } from 'node:path'
import {
  type CustodyManifestIo,
  type CustodyManifestReadResult,
  readCustodyManifest as readCoreCustodyManifest,
} from '@cortexkit/openai-auth-core/internal'
import { createLogger } from '../logger.ts'

export type {
  CustodyManifestIo,
  CustodyManifestReadResult,
} from '@cortexkit/openai-auth-core/internal'
// Named rather than a blanket re-export: `export *` would make this module a
// second door onto the whole core internal surface, so an unrelated symbol
// could be imported from `custody-manifest` and the layering would read as
// intentional. Mirrors `account-paths.ts`, which re-exports only the names it
// layers over.
export {
  CUSTODY_OWNING_PROVIDER,
  CUSTODY_OWNING_SERVE,
  CUSTODY_OWNING_SHAPE,
  custodyManifestHandles,
  manifestRevision,
} from '@cortexkit/openai-auth-core/internal'

const logC = createLogger('custody')
const warnedRelativeManifestPaths = new Set<string>()

// Default location: $CLAUSTRUM_OPENCODE_HANDLES, then XDG_CONFIG_HOME or
// ~/.config/cortexkit/opencode-handles.json. The floor pre-set in
// tests/setup-env.ts makes this safe under the test runner.
export function defaultCustodyManifestPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configuredPath = env.CLAUSTRUM_OPENCODE_HANDLES
  if (configuredPath && isAbsolute(configuredPath)) return configuredPath
  if (configuredPath && !warnedRelativeManifestPaths.has(configuredPath)) {
    warnedRelativeManifestPaths.add(configuredPath)
    logC.warn('ignoring non-absolute CLAUSTRUM_OPENCODE_HANDLES', {
      configuredPath,
    })
  }
  const configHome =
    env.XDG_CONFIG_HOME || (env.HOME ? join(env.HOME, '.config') : '.config')
  return join(configHome, 'cortexkit', 'opencode-handles.json')
}

export function readCustodyManifest(
  path = defaultCustodyManifestPath(),
  io: CustodyManifestIo = {},
): Promise<CustodyManifestReadResult> {
  return readCoreCustodyManifest(path, io)
}

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Where the plugin keeps a config folder's runtime files in the state home
 * (`core/account-paths.ts`): `opencode-<first 16 hex of the sha256 of the
 * config folder's real path>`, since a host's isolated config folder is never
 * `<home>/.config/opencode`. Creates the config folder so its real path is
 * fixed.
 */
export function runtimeStateDir(stateHome: string, configDir: string): string {
  mkdirSync(configDir, { recursive: true })
  const identity = realpathSync.native(configDir)
  const hash = createHash('sha256').update(identity).digest('hex').slice(0, 16)
  return join(stateHome, 'cortexkit', 'openai-auth', `opencode-${hash}`)
}

export function hostBinary(host: 1 | 2): string {
  const fixture = join(import.meta.dir, `opencode${host}-host`)
  const platform = process.platform === 'win32' ? 'windows' : process.platform
  const packageName = `${host === 1 ? 'opencode' : '@opencode/cli'}-${platform}-${process.arch}`
  // The wrapper's postinstall replaces a stub. Fixture installs disable scripts,
  // so launch the executable shipped by the platform package itself.
  const binary = join(
    fixture,
    'node_modules',
    packageName,
    'bin',
    process.platform === 'win32' ? 'opencode.exe' : 'opencode',
  )
  if (!existsSync(binary))
    throw new Error(
      `missing OpenCode ${host} platform binary at ${binary}; install fixture ${fixture} with: npm ci --ignore-scripts --prefix "${fixture}"`,
    )
  return binary
}

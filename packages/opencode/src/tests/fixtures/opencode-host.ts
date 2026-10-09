import { existsSync } from 'node:fs'
import { join } from 'node:path'

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

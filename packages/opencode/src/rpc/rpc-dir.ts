import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const RPC_DIR_ENV = 'OPENCODE_OPENAI_AUTH_RPC_DIR'

/** Name prefix of this plugin's per-project RPC state directories. */
export const RPC_DIRECTORY_PREFIX = 'openai-auth-'

export interface RpcDirResolution {
  dir: string
  secureDir: boolean
  sweepRoot?: string
}

function rpcHash(projectDirectory: string): string {
  return createHash('sha256')
    .update(projectDirectory)
    .digest('hex')
    .slice(0, 16)
}

function defaultRpcRoot(): string {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
  return join(base, 'cortexkit', 'openai-auth', 'rpc')
}

// Both processes must resolve the SAME dir from the SAME project directory.
export function getRpcDir(projectDirectory: string): string {
  const override = process.env[RPC_DIR_ENV]?.trim()
  // A relative override is anchored to projectDirectory (shared by both processes)
  // so server and TUI halves always resolve the same dir. An absolute override is
  // used as-is (resolve(base, absolute) returns the absolute path unchanged).
  if (override) return resolve(projectDirectory, override)
  return join(
    defaultRpcRoot(),
    `${RPC_DIRECTORY_PREFIX}${rpcHash(projectDirectory)}`,
  )
}

export async function resolveRpcDir(
  projectDirectory: string,
): Promise<RpcDirResolution> {
  const override = process.env[RPC_DIR_ENV]?.trim()
  if (override) {
    return { dir: resolve(projectDirectory, override), secureDir: false }
  }
  const dir = getRpcDir(projectDirectory)
  return { dir, secureDir: true, sweepRoot: dirname(dir) }
}

export { tmpdir }

/**
 * Port-file records for the RPC server, on the shared RPC machinery.
 *
 * What stays here is which state directories belong to this plugin: the ones
 * named `openai-auth-<hash>`, plus the unprefixed `<hash>` names older
 * versions created. The sweep removes dead records only from those.
 */
import {
  createManagedRpcStateDirPredicate,
  writePortFile as writeCommonPortFile,
} from '@cortexkit/common-auth/rpc'
import { PackageVersion } from '../version'
import { RPC_DIRECTORY_PREFIX } from './rpc-dir'

export {
  discoverPortFile,
  type PortFileEntry,
} from '@cortexkit/common-auth/rpc'

/** Stamp the record itself; a heartbeat with the same pid may be stale. */
export function writePortFile(
  dir: string,
  entry: Parameters<typeof writeCommonPortFile>[1],
  options?: Parameters<typeof writeCommonPortFile>[2],
): Promise<string> {
  const versioned = { ...entry, version: PackageVersion }
  return writeCommonPortFile(dir, versioned, options)
}

export const isOpenaiRpcStateDir =
  createManagedRpcStateDirPredicate(RPC_DIRECTORY_PREFIX)

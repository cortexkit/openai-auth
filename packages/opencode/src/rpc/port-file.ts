/**
 * Port-file records for the RPC server, on the shared RPC machinery.
 *
 * What stays here is which state directories belong to this plugin: the ones
 * named `openai-auth-<hash>`, plus the unprefixed `<hash>` names older
 * versions created. The sweep removes dead records only from those.
 */
import { createManagedRpcStateDirPredicate } from '@cortexkit/common-auth/rpc'
import { RPC_DIRECTORY_PREFIX } from './rpc-dir'

export {
  discoverPortFile,
  type PortFileEntry,
  writePortFile,
} from '@cortexkit/common-auth/rpc'

export const isOpenaiRpcStateDir =
  createManagedRpcStateDirPredicate(RPC_DIRECTORY_PREFIX)

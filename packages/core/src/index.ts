/**
 * The command seam.
 *
 * A host enters the shared commands only through `buildDialogPayload` or
 * `applyCommand`. The individual `execute*` bodies stay module-private on
 * purpose: both entry points scrub credential-shaped knobs out of the payload
 * before returning it, and a host that could call a body directly would be able
 * to skip that.
 */
export {
  applyCommand,
  buildDialogPayload,
  type CommandContext,
  type HostCommandBodies,
  type HostCommandBody,
  MODAL_COMMANDS,
  OPENAI_ACCOUNT_COMMAND_NAME,
  OPENAI_CACHEKEEP_COMMAND_NAME,
  OPENAI_DUMP_COMMAND_NAME,
  OPENAI_KILLSWITCH_COMMAND_NAME,
  OPENAI_LOGGING_COMMAND_NAME,
  OPENAI_QUOTA_COMMAND_NAME,
  OPENAI_RESET_COMMAND_NAME,
  OPENAI_ROUTING_COMMAND_NAME,
  scrubKnobs,
} from './commands'
export type {
  ApplyRequest,
  ApplyResult,
  CommandModalName,
  OpenDialogPayload,
} from './protocol'

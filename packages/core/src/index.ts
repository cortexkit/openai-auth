/**
 * The command seam: the one `/openai` menu both hosts open.
 *
 * Every payload the menu produces comes from the shared command menu's seam
 * (`@cortexkit/common-auth/commands`), which projects accounts field by field
 * and scrubs credential-shaped names; the one payload built here, the
 * not-migrated notice, is scrubbed the same way (`scrubKnobs`).
 */
export {
  type AccountRules,
  type CacheKeepManager,
  createOpenAiMenu,
  FLOOR_LABELS,
  killswitchInFloors,
  killswitchWithDefaultFloors,
  loginAddInput,
  type MenuLoginDeps,
  type MenuLoginFlow,
  type MenuMigrationState,
  MIGRATION_NOTICE_SECTION_ID,
  type MigrationBlocker,
  menuLogin,
  migrateLegacySettings,
  migrationNoticeMenu,
  OPENAI_COMMAND_NAME,
  OPENAI_MENU_TITLE,
  type OpenAiMenuOptions,
  ORDERED_VARIANTS,
  type ResetCreditsDeps,
  type ResetStepResult,
  type ResetTargetIdentity,
  resetCreditsSection,
  type SessionSectionDeps,
  scrubKnobs,
  sessionSection,
  settingsMutateAccounts,
  type VaultSectionDeps,
  vaultSection,
  withAccountRules,
  withSettingsMigration,
  writeSettings,
} from './commands'
export {
  type ApplyRequest,
  type ApplyResult,
  isNotifyPayload,
  type NotifyPayload,
  type OpenDialogPayload,
  type RpcNotification,
} from './protocol'

/**
 * Type-level half of the export manifest check.
 *
 * A type-only export never appears in a module's runtime key set, so the
 * runtime test next door cannot see one disappear. This file names every type
 * the manifest lists and is compiled by `tsc`, which turns a removed or renamed
 * type into a build failure instead of a silent surface change.
 *
 * It exports nothing and runs nothing; being compiled is the whole job.
 */

import type {
  CommandContext,
  HostCommandBodies,
  HostCommandBody,
  ApplyRequest as RootApplyRequest,
  ApplyResult as RootApplyResult,
  CommandModalName as RootCommandModalName,
  OpenDialogPayload as RootOpenDialogPayload,
} from '../index.ts'
import type {
  AccountBase,
  AccountManagerOptions,
  AccountOperationError,
  AccountPaths,
  AccountQuotaWindow,
  AccountRefreshError,
  AccountRuntimeEntry,
  AccountRuntimeState,
  AccountStateSaveScope,
  AccountStorage,
  AccountStorageLike,
  ApiKeyAccount,
  ApplyRequest,
  ApplyResult,
  BeginAccountLoginOptions,
  BeginAccountLoginResult,
  CacheKeepManager,
  CommandModalName,
  DeviceAuthInit,
  FallbackAccount,
  IdTokenClaims,
  IngestAccount,
  InitLoggerOptions,
  KillswitchConfig,
  KillswitchThresholds,
  Level,
  OAuthAccount,
  OAuthQuotaSnapshot,
  OpenDialogPayload,
  PendingOAuth,
  PkceCodes,
  ProviderHttpError,
  ProviderQuotaFn,
  ProviderRefreshFn,
  QuotaEntry,
  QuotaManagerOptions,
  QuotaWindowName,
  RefreshAllQuotaDeps,
  RefreshAllQuotaOptions,
  RefreshAllQuotaResult,
  ResetAccountState,
  ResetConsumeKind,
  ResetConsumeOutcome,
  ResetCredit,
  ResetCreditErrorKind,
  ResetCreditList,
  ResetInFlight,
  ResetLastOutcome,
  ResetLocalAmbiguousOutcome,
  ResetPrecondition,
  ResetRedemptionErrorKind,
  ResetRedemptionOutcome,
  ResetResolvedTarget,
  ResetSelectedCredit,
  ResetStateByAccount,
  ResetStateDeps,
  ResetTargetIdentity,
  RoutingMode,
  RpcNotification,
  RunResetCreditDeps,
  RunResetCreditInput,
  RunResetCreditResult,
  SidebarQuotaReading,
  SidebarQuotaSnapshot,
  TokenResponse,
} from '../internal.ts'

type RootSurface = {
  applyRequest: RootApplyRequest
  applyResult: RootApplyResult
  commandContext: CommandContext
  commandModalName: RootCommandModalName
  hostCommandBodies: HostCommandBodies
  hostCommandBody: HostCommandBody
  openDialogPayload: RootOpenDialogPayload
}

type InternalSurface = {
  accountBase: AccountBase
  accountManagerOptions: AccountManagerOptions
  accountOperationError: AccountOperationError
  accountPaths: AccountPaths
  accountQuotaWindow: AccountQuotaWindow
  accountRefreshError: AccountRefreshError
  accountRuntimeEntry: AccountRuntimeEntry
  accountRuntimeState: AccountRuntimeState
  accountStateSaveScope: AccountStateSaveScope
  accountStorage: AccountStorage
  accountStorageLike: AccountStorageLike
  apiKeyAccount: ApiKeyAccount
  applyRequest: ApplyRequest
  applyResult: ApplyResult
  beginAccountLoginOptions: BeginAccountLoginOptions
  beginAccountLoginResult: BeginAccountLoginResult
  cacheKeepManager: CacheKeepManager
  commandModalName: CommandModalName
  deviceAuthInit: DeviceAuthInit
  fallbackAccount: FallbackAccount
  idTokenClaims: IdTokenClaims
  ingestAccount: IngestAccount
  initLoggerOptions: InitLoggerOptions
  killswitchConfig: KillswitchConfig
  killswitchThresholds: KillswitchThresholds
  level: Level
  oauthAccount: OAuthAccount
  oauthQuotaSnapshot: OAuthQuotaSnapshot
  openDialogPayload: OpenDialogPayload
  pendingOAuth: PendingOAuth
  pkceCodes: PkceCodes
  providerHttpError: ProviderHttpError
  providerQuotaFn: ProviderQuotaFn
  providerRefreshFn: ProviderRefreshFn
  quotaEntry: QuotaEntry
  quotaManagerOptions: QuotaManagerOptions
  quotaWindowName: QuotaWindowName
  refreshAllQuotaDeps: RefreshAllQuotaDeps
  refreshAllQuotaOptions: RefreshAllQuotaOptions
  refreshAllQuotaResult: RefreshAllQuotaResult
  resetAccountState: ResetAccountState
  resetConsumeKind: ResetConsumeKind
  resetConsumeOutcome: ResetConsumeOutcome
  resetCredit: ResetCredit
  resetCreditErrorKind: ResetCreditErrorKind
  resetCreditList: ResetCreditList
  resetInFlight: ResetInFlight
  resetLastOutcome: ResetLastOutcome
  resetLocalAmbiguousOutcome: ResetLocalAmbiguousOutcome
  resetPrecondition: ResetPrecondition
  resetRedemptionErrorKind: ResetRedemptionErrorKind
  resetRedemptionOutcome: ResetRedemptionOutcome
  resetResolvedTarget: ResetResolvedTarget
  resetSelectedCredit: ResetSelectedCredit
  resetStateByAccount: ResetStateByAccount
  resetStateDeps: ResetStateDeps
  resetTargetIdentity: ResetTargetIdentity
  routingMode: RoutingMode
  rpcNotification: RpcNotification
  runResetCreditDeps: RunResetCreditDeps
  runResetCreditInput: RunResetCreditInput
  runResetCreditResult: RunResetCreditResult
  sidebarQuotaReading: SidebarQuotaReading
  sidebarQuotaSnapshot: SidebarQuotaSnapshot
  tokenResponse: TokenResponse
}

// Referencing both aliases is what makes an unused-name error impossible to
// hide: if a type above vanishes, these two lines stop compiling.
export type ExportedTypeSurface = RootSurface & InternalSurface

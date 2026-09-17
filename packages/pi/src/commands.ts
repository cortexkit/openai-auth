import {
  buildDialogPayload,
  type CommandContext,
  type CommandModalName,
  OPENAI_ACCOUNT_COMMAND_NAME,
  OPENAI_QUOTA_COMMAND_NAME,
  OPENAI_ROUTING_COMMAND_NAME,
} from '@cortexkit/openai-auth-core'
import {
  type AccountPaths,
  isOAuthAccount,
  loadAccounts,
  QuotaManager,
} from '@cortexkit/openai-auth-core/internal'
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent'

import packageJson from '../package.json' with { type: 'json' }
import { getPiAccountPaths } from './paths.ts'
import { clearPiStickyRouting, getPiStickyRouting } from './routing.ts'

export type PiCommandDependencies = {
  accountPaths?: () => AccountPaths
  beginAccountLogin?: CommandContext['beginAccountLogin']
  fetchImpl?: typeof fetch
  loadAccounts?: typeof loadAccounts
  now?: () => number
  packageVersion?: string
  randomUUID?: () => string
}

const clientStub: CommandContext['client'] = {
  auth: { set: async () => {} },
}

async function createCommandContext(
  ctx: ExtensionCommandContext,
  dependencies: PiCommandDependencies,
): Promise<CommandContext> {
  const paths = (dependencies.accountPaths ?? getPiAccountPaths)()
  const load = dependencies.loadAccounts ?? loadAccounts
  const storage = await load(paths)
  const quotaManager = new QuotaManager({
    storage: null,
    configPath: paths.configPath,
    fetchImpl: dependencies.fetchImpl,
    now: dependencies.now,
  })
  quotaManager.seedFallbacksFromAccounts(
    (storage?.accounts ?? []).filter(isOAuthAccount),
  )

  return {
    accountStoragePath: paths.configPath,
    accountStatePath: paths.statePath,
    packageVersion: dependencies.packageVersion ?? packageJson.version,
    quotaManager,
    loadAccounts: load,
    client: clientStub,
    sessionId: ctx.sessionManager.getSessionId(),
    notify: (payload) => ctx.ui.notify(payload.text),
    clearStickyRouting: async (sessionId) => clearPiStickyRouting(sessionId),
    getStickyRouting: async (sessionId) => getPiStickyRouting(sessionId),
    fetchImpl: dependencies.fetchImpl,
    now: dependencies.now,
    randomUUID: dependencies.randomUUID,
    beginAccountLogin: dependencies.beginAccountLogin,
  }
}

export async function buildPiDialogPayload(
  command: CommandModalName,
  args: string,
  ctx: ExtensionCommandContext,
  dependencies: PiCommandDependencies = {},
) {
  return buildDialogPayload(
    command,
    args,
    await createCommandContext(ctx, dependencies),
  )
}

async function runCommand(
  command: CommandModalName,
  args: string,
  ctx: ExtensionCommandContext,
  dependencies: PiCommandDependencies,
): Promise<void> {
  const payload = await buildPiDialogPayload(command, args, ctx, dependencies)
  ctx.ui.notify(payload.text)
}

export function registerCommands(
  pi: ExtensionAPI,
  dependencies: PiCommandDependencies = {},
): void {
  pi.registerCommand(OPENAI_ACCOUNT_COMMAND_NAME, {
    description: 'List, add, remove, or reorder OpenAI fallback accounts',
    handler: (args, ctx) =>
      runCommand(OPENAI_ACCOUNT_COMMAND_NAME, args, ctx, dependencies),
  })

  pi.registerCommand(OPENAI_QUOTA_COMMAND_NAME, {
    description: 'Show persisted OpenAI quota for fallback accounts',
    handler: (args, ctx) =>
      runCommand(OPENAI_QUOTA_COMMAND_NAME, args, ctx, dependencies),
  })

  pi.registerCommand(OPENAI_ROUTING_COMMAND_NAME, {
    description: 'Show or change OpenAI account routing mode',
    handler: (args, ctx) =>
      runCommand(OPENAI_ROUTING_COMMAND_NAME, args, ctx, dependencies),
  })
}

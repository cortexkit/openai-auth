import type { Plugin } from '@opencode/plugin'

/** A configured Responses URL becomes the base the host appends /responses to. */
export function codexBaseURL(endpoint: string): string {
  return endpoint.replace(/\/responses\/?$/, '').replace(/\/$/, '')
}

export function applyCodexBaseURL(
  draft: { baseURL?: string },
  credentialKind: 'oauth' | 'api-key',
  endpoint: string,
): boolean {
  if (credentialKind !== 'oauth') return false
  if (
    draft.baseURL === undefined ||
    new URL(draft.baseURL).origin === 'https://api.openai.com'
  ) {
    draft.baseURL = codexBaseURL(endpoint)
    return false
  }
  return draft.baseURL !== codexBaseURL(endpoint)
}

export async function registerCodexRequestRules(
  ctx: Pick<Plugin.Context, 'session'>,
  endpoint: () => string,
  log: { info(message: string): void },
) {
  let loggedCustom = false
  // installOpenCode2Auth runs its account-selection hook first and refuses
  // requests without a usable ChatGPT OAuth login in the pool or vault.
  // OpenCode's built-in OpenAI plugin caches the active login at startup;
  // an auth.json import later in that first run can leave it sending to the
  // platform API. Set the Codex destination ourselves for these OAuth sends.
  const request = await ctx.session.hook(
    'model.request',
    (draft) => {
      if (applyCodexBaseURL(draft, 'oauth', endpoint()) && !loggedCustom) {
        loggedCustom = true
        log.info('keeping the custom OpenAI baseURL for account pool requests')
      }
      draft.headers['session-id'] = draft.sessionID
    },
    { providerID: 'openai' },
  )
  const context = await ctx.session.hook(
    'context',
    (draft) => {
      delete draft.options.maxTokens
    },
    { providerID: 'openai' },
  )
  const compaction = await ctx.session.hook(
    'compaction',
    (draft) => {
      delete draft.options.maxTokens
    },
    { providerID: 'openai' },
  )
  return {
    dispose: async () => {
      await Promise.all([
        request.dispose(),
        context.dispose(),
        compaction.dispose(),
      ])
    },
  }
}

// The OpenAI models a ChatGPT login is offered on OpenCode 2, and their
// context windows: the same allow and deny lists and caps the OpenCode 1
// models hook applies (`codexOAuthModelListed`, `codexOAuthModelLimit` in the
// plugin entry), applied through OpenCode 2's model transform.

import type { Plugin } from '@opencode/plugin'
import type { Registration } from '@opencode/plugin/promise/registration'
import { codexOAuthModelLimit, codexOAuthModelListed } from '../index'
import { OPENAI_PROVIDER_ID } from './adapter'

/** The model fields the rules read and write. */
export interface EditableModel {
  id: string
  modelID?: string
  enabled: boolean
  limit: { context: number; input?: number; output: number }
}

/**
 * Applies the rules to one model in place: an unlisted model is disabled,
 * and a listed one gets the ChatGPT context window when one is set for it.
 * The listing reads the API model id (`modelID`), the window the catalogue
 * id, as the OpenCode 1 hook reads `api.id` and `id`.
 */
export function applyCodexModelRules(model: EditableModel): void {
  if (!codexOAuthModelListed(model.modelID ?? model.id)) {
    model.enabled = false
    return
  }
  const limit = codexOAuthModelLimit(model.id)
  if (limit) model.limit = { ...limit }
}

export function registerCodexModelRules(ctx: {
  readonly model: Pick<Plugin.Context['model'], 'transform'>
}): Promise<Registration> {
  return ctx.model.transform((editor) => {
    for (const model of editor.list(OPENAI_PROVIDER_ID)) {
      editor.update(OPENAI_PROVIDER_ID, String(model.id), (draft) =>
        applyCodexModelRules(draft as unknown as EditableModel),
      )
    }
  })
}

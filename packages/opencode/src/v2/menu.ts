import {
  applyOpenAiMenu,
  type OpenCodeMenuContext,
  openOpenAiMenu,
} from '../commands'
import type { ControlPlaneMenu } from './control-plane'

/** OpenCode's normal menu, with createOpenAiMenu refusing every apply. */
export function createReadOnlyControlPlane(
  context: OpenCodeMenuContext,
): ControlPlaneMenu {
  const readOnly: OpenCodeMenuContext = {
    ...context,
    readOnly: true,
    unavailableSections: ['cache', 'diagnostics', 'reset'],
  }
  return {
    open: (sessionId) => openOpenAiMenu(readOnly, sessionId),
    apply: (input) => {
      const request =
        input !== null && typeof input === 'object'
          ? (input as Record<string, unknown>)
          : {}
      // User-supplied action values are unnecessary when every apply is refused.
      // Pass only the session, section, item and action identifiers to the menu;
      // arbitrary RPC fields must not be echoed into its response.
      return applyOpenAiMenu(readOnly, {
        command: 'openai',
        sectionId:
          typeof request.sectionId === 'string' ? request.sectionId : '',
        actionId: typeof request.actionId === 'string' ? request.actionId : '',
        ...(typeof request.itemId === 'string'
          ? { itemId: request.itemId }
          : {}),
        ...(typeof request.sessionId === 'string'
          ? { sessionId: request.sessionId }
          : {}),
      })
    },
  }
}

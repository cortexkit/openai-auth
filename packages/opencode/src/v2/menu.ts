import {
  applyOpenAiMenu,
  type OpenCodeMenuContext,
  openOpenAiMenu,
} from '../commands'
import type { ControlPlaneMenu } from './control-plane'

/** Only the menu actions supported by this host may run. */
function allowed(request: {
  sectionId: string
  actionId: string
  itemId?: string
}) {
  const item = request.itemId !== undefined
  switch (request.sectionId) {
    case 'accounts':
      return item
        ? ['enable', 'disable', 'remove', 'move'].includes(request.actionId)
        : request.actionId === 'add'
    case 'routing':
      return !item && ['order', 'mode'].includes(request.actionId)
    case 'quota':
      return request.actionId === 'check'
    case 'limits':
      return item
        ? request.actionId === 'floors'
        : request.actionId === 'killswitch'
    case 'session':
      return !item && request.actionId === 'clear-pin'
    case 'diagnostics':
      return !item && ['logging', 'dump'].includes(request.actionId)
    case 'cache':
      return (
        !item &&
        ['enabled', 'subagents', 'sustain', 'window'].includes(request.actionId)
      )
    case 'reset':
      // Spend and retry still need `confirmed: true`, which the shared menu
      // checks before it runs either one; preview spends nothing.
      return item && ['preview', 'spend', 'retry'].includes(request.actionId)
    default:
      return false
  }
}

/** OpenCode's shared menu with a server-side capability fence. */
export function createControlPlaneMenu(
  context: OpenCodeMenuContext,
): ControlPlaneMenu {
  const controls: OpenCodeMenuContext = {
    ...context,
    allowAction: allowed,
    unavailableSections: [],
  }
  return {
    open: (sessionId) => openOpenAiMenu(controls, sessionId),
    apply: (input) => {
      const request =
        input !== null && typeof input === 'object'
          ? (input as Record<string, unknown>)
          : {}
      // Copy only primitive knob values. The engine validates them against the
      // selected action and ignores unknown names; no arbitrary RPC object is echoed.
      const values =
        request.values &&
        typeof request.values === 'object' &&
        !Array.isArray(request.values)
          ? Object.fromEntries(
              Object.entries(request.values).filter(
                ([, value]) =>
                  value === null ||
                  ['string', 'number', 'boolean'].includes(typeof value),
              ),
            )
          : undefined
      return applyOpenAiMenu(controls, {
        command: 'openai',
        sectionId:
          typeof request.sectionId === 'string' ? request.sectionId : '',
        actionId: typeof request.actionId === 'string' ? request.actionId : '',
        ...(values ? { values } : {}),
        ...(request.confirmed === true ? { confirmed: true } : {}),
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

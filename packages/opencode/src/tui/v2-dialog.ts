import type { Plugin } from '@opencode/plugin/tui'
import type {
  ApplyRequest,
  ApplyResult,
  OpenDialogPayload,
} from '../rpc/protocol'

/** Native dialogs display the shared payload; only the server can apply an action. */
export async function openControlDialog(
  dialog: Plugin.Context['ui']['dialog'],
  initial: OpenDialogPayload,
  apply: (request: Omit<ApplyRequest, 'sessionId'>) => Promise<ApplyResult>,
  active: () => boolean = () => true,
) {
  let payload = initial
  menu: while (active()) {
    const sectionId = await dialog.select({
      title: payload.menu.title,
      options: payload.menu.sections.map((section) => ({
        title: section.title,
        value: section.id,
        description: section.lines.join('\n'),
      })),
    })
    if (!active() || sectionId === undefined) return
    const section = payload.menu.sections.find(
      (entry) => entry.id === sectionId,
    )
    if (!section) return
    const choices = [
      ...section.items.map((item) => ({
        title: item.label,
        description: [item.status, item.detail].filter(Boolean).join('\n'),
        value: { itemId: item.id, actions: item.actions },
      })),
      ...section.actions.map((action) => ({
        title: action.label,
        description: action.description,
        value: { itemId: undefined, actions: [action] },
      })),
    ]
    if (choices.length === 0) {
      await dialog.alert({
        title: section.title,
        message: section.lines.join('\n'),
      })
      continue
    }
    const choice = await dialog.select<
      (typeof choices)[number]['value'] | undefined
    >({
      title: section.title,
      options: [...choices, { title: 'Back', value: undefined }],
    })
    if (!active()) return
    if (!choice) continue
    let actionId: string | undefined
    if (choice.itemId !== undefined) {
      if (choice.actions.length === 0) continue
      actionId = await dialog.select({
        title:
          section.items.find((item) => item.id === choice.itemId)?.label ??
          section.title,
        options: [
          ...choice.actions.map((action) => ({
            title: action.label,
            value: action.id,
          })),
          { title: 'Back', value: undefined },
        ],
      })
    } else actionId = choice.actions[0]?.id
    if (!active()) return
    if (actionId === undefined) continue
    const action = choice.actions.find((entry) => entry.id === actionId)
    if (!action) continue
    try {
      const values: Record<string, string | number | boolean | null> = {}
      for (const knob of action.knobs) {
        let value: string | number | boolean | null | undefined
        if (knob.kind === 'choice') {
          value = await dialog.select({
            title: knob.label,
            options: knob.choices.map((entry) => ({
              title: entry.label,
              value: entry.value,
            })),
          })
        } else if (knob.kind === 'toggle') {
          value = await dialog.select({
            title: knob.label,
            options: [
              { title: `On${knob.value ? ' (current)' : ''}`, value: true },
              { title: `Off${!knob.value ? ' (current)' : ''}`, value: false },
            ],
          })
        } else {
          const text = await dialog.prompt({
            title: knob.label,
            ...(knob.value !== undefined ? { value: String(knob.value) } : {}),
            ...(knob.kind === 'text' && knob.placeholder
              ? { placeholder: knob.placeholder }
              : {}),
          })
          value =
            text === undefined
              ? undefined
              : text === ''
                ? null
                : knob.kind === 'number' && Number.isFinite(Number(text))
                  ? Number(text)
                  : text
        }
        if (!active()) return
        if (value === undefined) continue menu
        values[knob.id] = value
      }
      if (action.confirm) {
        const confirmed = await dialog.confirm({
          title: action.label,
          message: action.confirm.message,
        })
        if (!active()) return
        if (confirmed !== true) continue
      }
      const result = await apply({
        command: payload.command,
        sectionId,
        actionId,
        ...(choice.itemId !== undefined ? { itemId: choice.itemId } : {}),
        ...(action.knobs.length ? { values } : {}),
        ...(action.confirm ? { confirmed: true } : {}),
      })
      if (!active()) return
      payload = { command: result.command, menu: result.menu }
      await dialog.alert({ title: payload.menu.title, message: result.text })
    } catch (error) {
      if (!active()) return
      await dialog.alert({
        title: payload.menu.title,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

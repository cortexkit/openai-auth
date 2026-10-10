/** @jsxImportSource @opentui/solid */

// The `/openai` drawer: one generic renderer for the shared command menu's
// payload. The payload carries everything drawn here (sections with their
// lines, items, facts and actions; each action's typed inputs with their
// current values and its confirmation), so the drawer knows nothing about
// any one section. After every apply it redraws from the refreshed menu the
// result carries.

import type {
  TuiDialogSelectOption,
  TuiPluginApi,
} from '@opencode-ai/plugin/tui'
import { createLogger } from '../logger'
import type {
  ApplyRequest,
  ApplyResult,
  OpenDialogPayload,
} from '../rpc/protocol.js'

const log = createLogger('rpc-tui')

type Menu = OpenDialogPayload['menu']
type Section = Menu['sections'][number]
type Item = Section['items'][number]
type Action = Section['actions'][number]
type Knob = Action['knobs'][number]
type KnobValue = string | number | boolean | null

/** Sends one action to the plugin; the session id is added by the caller. */
export type ApplyFn = (
  request: Omit<ApplyRequest, 'sessionId'>,
) => Promise<ApplyResult>

export type DrawerOption = Omit<
  TuiDialogSelectOption<string>,
  'disabled' | 'onSelect'
>

const BACK = 'back'

/** One option per section, in the order the menu gives them. */
export function sectionListOptions(menu: Menu): DrawerOption[] {
  return menu.sections.map((section) => ({
    title: section.title,
    value: `section:${section.id}`,
    ...(section.lines[0] ? { description: section.lines[0] } : {}),
  }))
}

function factLines(facts: Record<string, unknown> | undefined): string[] {
  return Object.entries(facts ?? {}).map(
    ([name, value]) =>
      `${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
  )
}

/** Read-only text is a category header; every option navigates or runs an action. */
export function sectionOptions(section: Section): DrawerOption[] {
  const header = [
    ...section.lines,
    ...factLines(section.facts),
    ...section.items
      .filter((item) => item.actions.length === 0)
      .map((item) =>
        [
          item.group,
          [item.label, item.status].filter(Boolean).join(' · '),
          item.detail,
          ...factLines(item.facts),
        ]
          .filter(Boolean)
          .join('\n'),
      ),
  ]
  const options: DrawerOption[] = [
    ...section.items
      .filter((item) => item.actions.length > 0)
      .map((item) => ({
        title: item.label,
        value: `item:${item.id}`,
        ...(item.detail ? { description: item.detail } : {}),
        ...(item.group ? { category: item.group } : {}),
        ...(item.status ? { footer: item.status } : {}),
      })),
    ...section.actions.map((action) => ({
      title: action.label,
      value: `action:${action.id}`,
      ...(action.description ? { description: action.description } : {}),
      ...(action.group ? { category: action.group } : {}),
    })),
    { title: 'Back', value: BACK },
  ]
  const first = options[0]
  if (first && header.length > 0) {
    const category = first.category
    const text = [...header, category].filter(Boolean).join('\n')
    for (const option of options) {
      if (option.category !== category) break
      option.category = text
    }
  }
  return options
}

/** Item context is secondary text, never an option that cannot be acted on. */
export function itemOptions(item: Item): DrawerOption[] {
  const detail = [item.detail, ...factLines(item.facts)]
    .filter(Boolean)
    .join(' · ')
  return [
    ...item.actions.map((action) => ({
      title: action.label,
      value: `action:${action.id}`,
      ...(detail || action.description
        ? {
            description: [detail, action.description]
              .filter(Boolean)
              .join(' · '),
          }
        : {}),
      ...(action.group ? { category: action.group } : {}),
    })),
    { title: 'Back', value: BACK },
  ]
}

/**
 * The value a typed `number` or `text` input sends: empty is `null` (the
 * action receives that as "leave unset"), a number input sends a number
 * when the text parses as one and the text otherwise, so the plugin can say
 * what is wrong with it.
 */
export function promptValue(knob: Knob, raw: string): KnobValue {
  const text = raw.trim()
  if (text === '') return null
  if (knob.kind === 'number') {
    const number = Number(text)
    return Number.isFinite(number) ? number : text
  }
  return raw
}

function knobDefault(knob: Knob): string {
  if (knob.kind === 'toggle') return knob.value ? 'on' : 'off'
  return knob.value === undefined ? '' : String(knob.value)
}

export interface DrawerContext {
  api: TuiPluginApi
  apply: ApplyFn
}

/** Opens the drawer on a payload pushed by `/openai`. */
export function openCommandDialog(
  api: TuiPluginApi,
  payload: OpenDialogPayload,
  apply: ApplyFn,
) {
  showMenu({ api, apply }, payload.command, payload.menu)
}

function showMenu(context: DrawerContext, command: string, menu: Menu) {
  const { api } = context
  // A menu with one section (the not-migrated notice) opens on it directly.
  if (menu.sections.length === 1) {
    const [only] = menu.sections
    if (only) {
      showSection(context, command, menu, only.id)
      return
    }
  }
  const DialogSelect = api.ui.DialogSelect<string>
  api.ui.dialog.setSize('xlarge')
  api.ui.dialog.replace(() => (
    <DialogSelect
      title={menu.title}
      options={sectionListOptions(menu)}
      onSelect={(option) => {
        const id = String(option.value).slice('section:'.length)
        showSection(context, command, menu, id)
      }}
    />
  ))
}

function showSection(
  context: DrawerContext,
  command: string,
  menu: Menu,
  sectionId: string,
) {
  const { api } = context
  const section = menu.sections.find((entry) => entry.id === sectionId)
  if (!section) {
    showMenu(context, command, menu)
    return
  }
  const DialogSelect = api.ui.DialogSelect<string>
  api.ui.dialog.setSize('xlarge')
  api.ui.dialog.replace(() => (
    <DialogSelect
      title={section.title}
      options={sectionOptions(section)}
      onSelect={(option) => {
        const value = String(option.value)
        if (value === BACK) {
          if (menu.sections.length === 1) api.ui.dialog.clear()
          else showMenu(context, command, menu)
          return
        }
        if (value.startsWith('item:')) {
          showItem(context, command, menu, section, value.slice(5))
          return
        }
        if (value.startsWith('action:')) {
          const action = section.actions.find(
            (entry) => entry.id === value.slice(7),
          )
          if (action)
            void runAction(context, command, menu, section, undefined, action)
        }
      }}
    />
  ))
}

function showItem(
  context: DrawerContext,
  command: string,
  menu: Menu,
  section: Section,
  itemId: string,
) {
  const { api } = context
  const item = section.items.find((entry) => entry.id === itemId)
  if (!item) {
    showSection(context, command, menu, section.id)
    return
  }
  const DialogSelect = api.ui.DialogSelect<string>
  api.ui.dialog.setSize('xlarge')
  api.ui.dialog.replace(() => (
    <DialogSelect
      title={`${section.title}: ${item.label}`}
      options={itemOptions(item)}
      onSelect={(option) => {
        const value = String(option.value)
        if (value === BACK) {
          showSection(context, command, menu, section.id)
          return
        }
        if (value.startsWith('action:')) {
          const action = item.actions.find(
            (entry) => entry.id === value.slice(7),
          )
          if (action)
            void runAction(context, command, menu, section, item, action)
        }
      }}
    />
  ))
}

/** Asks for one input; resolves undefined when the user backs out. */
function askKnob(
  api: TuiPluginApi,
  title: string,
  knob: Knob,
): Promise<KnobValue | undefined> {
  return new Promise((resolve) => {
    api.ui.dialog.setSize('xlarge')
    if (knob.kind === 'choice' || knob.kind === 'toggle') {
      const DialogSelect = api.ui.DialogSelect<string>
      const options =
        knob.kind === 'choice'
          ? knob.choices.map((choice) => ({
              title: choice.label,
              value: choice.value,
            }))
          : [
              { title: 'On', value: 'on' },
              { title: 'Off', value: 'off' },
            ]
      api.ui.dialog.replace(() => (
        <DialogSelect
          title={`${title}: ${knob.label}`}
          current={knobDefault(knob)}
          options={[...options, { title: 'Cancel', value: `\u0000cancel` }]}
          onSelect={(option) => {
            const value = String(option.value)
            if (value === `\u0000cancel`) resolve(undefined)
            else resolve(knob.kind === 'toggle' ? value === 'on' : value)
          }}
        />
      ))
      return
    }
    const DialogPrompt = api.ui.DialogPrompt
    api.ui.dialog.replace(() => (
      <DialogPrompt
        title={`${title}: ${knob.label}`}
        placeholder={knob.kind === 'text' ? (knob.placeholder ?? '') : ''}
        value={knobDefault(knob)}
        onConfirm={(value: string) => resolve(promptValue(knob, value))}
        onCancel={() => resolve(undefined)}
      />
    ))
  })
}

function askConfirmation(
  api: TuiPluginApi,
  title: string,
  message: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const DialogConfirm = api.ui.DialogConfirm
    api.ui.dialog.setSize('xlarge')
    api.ui.dialog.replace(() => (
      <DialogConfirm
        title={title}
        message={message}
        onConfirm={() => resolve(true)}
        onCancel={() => resolve(false)}
      />
    ))
  })
}

function showResult(api: TuiPluginApi, title: string, text: string) {
  api.ui.dialog.setSize('xlarge')
  api.ui.dialog.replace(() => (
    <box flexDirection='column' padding={1} width='100%'>
      <text>{title}</text>
      <text>{text}</text>
    </box>
  ))
}

/**
 * Collects an action's inputs, confirms it when it carries a confirmation,
 * applies it and redraws the section from the refreshed menu. A long
 * message (a sign-in URL, a reset result) is shown in full; a short one is a
 * toast over the redrawn section.
 */
async function runAction(
  context: DrawerContext,
  command: string,
  menu: Menu,
  section: Section,
  item: Item | undefined,
  action: Action,
) {
  const { api, apply } = context
  const back = () =>
    item
      ? showItem(context, command, menu, section, item.id)
      : showSection(context, command, menu, section.id)
  const values: Record<string, KnobValue> = {}
  for (const knob of action.knobs) {
    const value = await askKnob(api, action.label, knob)
    if (value === undefined) {
      back()
      return
    }
    values[knob.id] = value
  }
  let confirmed = false
  if (action.confirm) {
    confirmed = await askConfirmation(api, action.label, action.confirm.message)
    if (!confirmed) {
      back()
      return
    }
  }
  const request: Omit<ApplyRequest, 'sessionId'> = {
    command,
    sectionId: section.id,
    ...(item ? { itemId: item.id } : {}),
    actionId: action.id,
    values,
    ...(confirmed ? { confirmed: true } : {}),
  }
  let result: ApplyResult
  try {
    result = await apply(request)
  } catch (error) {
    log.warn('menu apply failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    api.ui.toast({ message: 'The action could not reach OpenAI auth.' })
    back()
    return
  }
  // The shared RPC client answers a failed call with a body of its own that
  // carries no menu; redraw from the menu already shown then.
  const next = result.menu ?? menu
  if (result.needsConfirmation) {
    const yes = await askConfirmation(api, action.label, result.text)
    if (yes) {
      const again = await apply({ ...request, confirmed: true })
      finish(context, command, again.menu ?? next, section.id, again)
      return
    }
  }
  finish(context, command, next, section.id, result)
}

function finish(
  context: DrawerContext,
  command: string,
  menu: Menu,
  sectionId: string,
  result: ApplyResult,
) {
  const { api } = context
  if (result.text.includes('\n') || result.text.length > 120) {
    showResult(api, result.ok ? 'Done' : 'Not done', result.text)
    return
  }
  api.ui.toast({ message: result.text })
  showSection(context, command, menu, sectionId)
}

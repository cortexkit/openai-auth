// The `/openai` drawer: one generic renderer for the menu payload. A minimal
// stand-in for the TUI api captures what each dialog is given, so the tests
// can pick options and type values the way a user would.
import { describe, expect, test } from 'bun:test'
import type { CommandMenuModel } from '@cortexkit/common-auth/commands'
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import type { ApplyRequest, ApplyResult } from '../rpc/protocol.js'
import {
  itemOptions,
  openCommandDialog,
  promptValue,
  sectionListOptions,
  sectionOptions,
} from '../tui/command-dialogs'

type Captured =
  | {
      kind: 'select'
      title: string
      options: Array<{ title: string; value: string }>
      onSelect: (option: { value: string }) => void
    }
  | {
      kind: 'prompt'
      title: string
      value: string
      onConfirm: (value: string) => void
      onCancel: () => void
    }
  | {
      kind: 'confirm'
      message: string
      onConfirm: () => void
      onCancel: () => void
    }
  | { kind: 'view' }

function harness() {
  let current: Captured | undefined
  const toasts: string[] = []
  const api = {
    ui: {
      dialog: {
        setSize: () => {},
        replace: (render: () => unknown) => {
          current = { kind: 'view' }
          render()
        },
        clear: () => {
          current = undefined
        },
      },
      toast: (input: { message: string }) => toasts.push(input.message),
      DialogSelect: (
        props: Omit<Extract<Captured, { kind: 'select' }>, 'kind'>,
      ) => {
        current = { kind: 'select', ...props }
        return null
      },
      DialogPrompt: (
        props: Omit<Extract<Captured, { kind: 'prompt' }>, 'kind'>,
      ) => {
        current = { kind: 'prompt', ...props }
        return null
      },
      DialogConfirm: (
        props: Omit<Extract<Captured, { kind: 'confirm' }>, 'kind'>,
      ) => {
        current = { kind: 'confirm', ...props }
        return null
      },
    },
  } as unknown as TuiPluginApi
  return {
    api,
    toasts,
    current: () => current,
    select(value: string) {
      if (current?.kind !== 'select')
        throw new Error(`no select: ${current?.kind}`)
      current.onSelect({ value })
    },
  }
}

async function settle() {
  for (let i = 0; i < 5; i++) await Bun.sleep(1)
}

const MENU: CommandMenuModel = {
  command: 'openai',
  title: 'OpenAI accounts',
  sections: [
    {
      id: 'accounts',
      slot: 'accounts',
      title: 'Accounts',
      lines: ['2 account(s), 2 enabled.'],
      items: [
        {
          id: 'alpha',
          label: 'alpha',
          detail: 'OAuth · enabled',
          actions: [
            {
              id: 'remove',
              label: 'Remove',
              knobs: [],
              confirm: { message: 'Remove alpha?', irreversible: true },
            },
          ],
        },
      ],
      actions: [],
    },
    {
      id: 'limits',
      slot: 'limits',
      title: 'Limits',
      lines: ['Killswitch: off.'],
      items: [
        {
          id: 'alpha',
          label: 'alpha',
          facts: { primary: '42% used' },
          actions: [
            {
              id: 'floors',
              label: 'Set floors',
              knobs: [
                { kind: 'number', id: 'primary', label: 'primary', value: 5 },
              ],
            },
          ],
        },
      ],
      actions: [
        {
          id: 'killswitch',
          label: 'Turn killswitch on',
          knobs: [
            { kind: 'toggle', id: 'enabled', label: 'Killswitch', value: true },
          ],
        },
      ],
    },
    {
      id: 'diagnostics',
      slot: 'diagnostics',
      title: 'Diagnostics',
      lines: ['Log level: info.'],
      items: [],
      actions: [
        {
          id: 'logging',
          label: 'Set the log level',
          knobs: [
            {
              kind: 'choice',
              id: 'level',
              label: 'Level',
              choices: [
                { value: 'info', label: 'info' },
                { value: 'debug', label: 'debug' },
              ],
              value: 'info',
            },
          ],
        },
      ],
    },
  ],
}

function recordingApply(text = 'Done.') {
  const requests: Array<Omit<ApplyRequest, 'sessionId'>> = []
  const apply = async (
    request: Omit<ApplyRequest, 'sessionId'>,
  ): Promise<ApplyResult> => {
    requests.push(request)
    return { command: 'openai', ok: true, text, menu: MENU }
  }
  return { requests, apply }
}

describe('the /openai drawer', () => {
  test('lists every section, then a section’s lines, items, actions and Back', () => {
    expect(sectionListOptions(MENU).map((option) => option.title)).toEqual([
      'Accounts',
      'Limits',
      'Diagnostics',
    ])
    const [, limits] = MENU.sections
    expect(sectionOptions(limits!).map((option) => option.value)).toEqual([
      'line:0',
      'item:alpha',
      'action:killswitch',
      'back',
    ])
    expect(
      itemOptions(limits!.items[0]!).map((option) => option.title),
    ).toEqual(['primary: 42% used', 'Set floors', 'Back'])
  })

  test('a section action collects its toggle and applies it', async () => {
    const h = harness()
    const { requests, apply } = recordingApply('Killswitch on.')
    openCommandDialog(h.api, { command: 'openai', menu: MENU }, apply)

    h.select('section:limits')
    h.select('action:killswitch')
    h.select('on')
    await settle()

    expect(requests).toEqual([
      {
        command: 'openai',
        sectionId: 'limits',
        actionId: 'killswitch',
        values: { enabled: true },
      },
    ])
    expect(h.toasts).toEqual(['Killswitch on.'])
    // The drawer redraws the section from the refreshed menu.
    const current = h.current()
    expect(current?.kind === 'select' ? current.title : '').toBe('Limits')
  })

  test('a choice input sends the chosen value', async () => {
    const h = harness()
    const { requests, apply } = recordingApply()
    openCommandDialog(h.api, { command: 'openai', menu: MENU }, apply)

    h.select('section:diagnostics')
    h.select('action:logging')
    h.select('debug')
    await settle()

    expect(requests[0]?.values).toEqual({ level: 'debug' })
  })

  test('an item action prompts for a number; an empty answer sends null', async () => {
    const h = harness()
    const { requests, apply } = recordingApply()
    openCommandDialog(h.api, { command: 'openai', menu: MENU }, apply)

    h.select('section:limits')
    h.select('item:alpha')
    h.select('action:floors')
    const prompt = h.current()
    if (prompt?.kind !== 'prompt') throw new Error('no prompt')
    expect(prompt.value).toBe('5')
    prompt.onConfirm('')
    await settle()

    expect(requests[0]).toEqual({
      command: 'openai',
      sectionId: 'limits',
      itemId: 'alpha',
      actionId: 'floors',
      values: { primary: null },
    })
    expect(promptValue({ kind: 'number', id: 'n', label: 'n' }, ' 12 ')).toBe(
      12,
    )
  })

  test('an action with a confirmation is applied only after a yes, marked confirmed', async () => {
    const h = harness()
    const { requests, apply } = recordingApply()
    openCommandDialog(h.api, { command: 'openai', menu: MENU }, apply)

    h.select('section:accounts')
    h.select('item:alpha')
    h.select('action:remove')
    await settle()
    let confirm = h.current()
    if (confirm?.kind !== 'confirm') throw new Error('no confirmation')
    expect(confirm.message).toBe('Remove alpha?')
    confirm.onCancel()
    await settle()
    expect(requests).toEqual([])

    h.select('action:remove')
    await settle()
    confirm = h.current()
    if (confirm?.kind !== 'confirm') throw new Error('no confirmation')
    confirm.onConfirm()
    await settle()
    expect(requests).toEqual([
      {
        command: 'openai',
        sectionId: 'accounts',
        itemId: 'alpha',
        actionId: 'remove',
        values: {},
        confirmed: true,
      },
    ])
  })

  test('a one-section menu (the not-migrated notice) opens on that section', () => {
    const h = harness()
    const notice: CommandMenuModel = {
      command: 'openai',
      title: 'OpenAI accounts',
      sections: [
        {
          id: 'migration',
          slot: 'extra',
          title: 'Accounts are moving',
          lines: ['Accounts move once every process runs this version.'],
          items: [{ id: 'blocker-0', label: 'pid 42', actions: [] }],
          actions: [],
        },
      ],
    }
    openCommandDialog(h.api, { command: 'openai', menu: notice }, async () => {
      throw new Error('not applied')
    })

    const current = h.current()
    expect(current?.kind === 'select' ? current.title : '').toBe(
      'Accounts are moving',
    )
    expect(
      current?.kind === 'select' ? current.options.map((o) => o.title) : [],
    ).toEqual([
      'Accounts move once every process runs this version.',
      'pid 42',
      'Back',
    ])
  })
})

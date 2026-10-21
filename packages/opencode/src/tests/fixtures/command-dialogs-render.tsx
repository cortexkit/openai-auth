import assert from 'node:assert/strict'
import type { CommandMenuModel } from '@cortexkit/common-auth/commands'
import type {
  TuiDialogSelectOption,
  TuiPluginApi,
} from '@opencode-ai/plugin/tui'
import { type JSX, testRender } from '@opentui/solid'
import { For, Show } from 'solid-js'
import { openCommandDialog } from '../../tui/command-dialogs'
import { openControlDialog } from '../../tui/v2-dialog'

type Section = CommandMenuModel['sections'][number]
type Option = TuiDialogSelectOption<string> & { details?: string[] }
const dimensions = { width: 100, height: 80 }

// Layout-only extract of the fixture's opencode-ai 1.18.30 DialogSelect:
// https://github.com/anomalyco/opencode/blob/v1.18.30/packages/tui/src/ui/dialog-select.tsx
// Grouping/rows/height: 154-214; title: 557-598; list/categories: 599-714.
// OpenCode 2.0.22 uses the same sizing and inline description layout (232-241,
// 703-803, 864-883 in that tag). Its plugin/api.tsx:359-378 passes options through.
// The hosts reserve one row per category and option, but newlines in category
// or description text take extra rendered rows and push later actions below
// the list's maxHeight. Preserve that undercount here so a joined multiline
// header really clips actions in the captured frame instead of passing silently.
function DialogSelect(props: { title: string; options: Option[] }) {
  const grouped = new Map<string, Option[]>()
  for (const option of props.options.filter(
    (entry) => entry.disabled !== true,
  )) {
    const category = option.category ?? ''
    const entries = grouped.get(category) ?? []
    entries.push(option)
    grouped.set(category, entries)
  }
  const groups = [...grouped]
  const headers = groups.reduce(
    (count, [category], i) => count + (category ? (i > 0 ? 2 : 1) : 0),
    0,
  )
  const rows = groups
    .flatMap(([, options]) => options)
    .reduce(
      (count, option) => count + 1 + (option.details?.length ?? 0),
      headers,
    )
  const height = Math.min(rows, Math.floor(dimensions.height / 2) - 6)
  return (
    <box gap={1} paddingBottom={1} flexGrow={1}>
      <box paddingLeft={4} paddingRight={4}>
        <box flexDirection='row' justifyContent='space-between'>
          <text>{props.title}</text>
          <text>esc</text>
        </box>
        <box paddingTop={1}>
          <input placeholder='Search' />
        </box>
      </box>
      <box flexGrow={1} flexShrink={1}>
        <scrollbox
          paddingLeft={1}
          paddingRight={1}
          scrollbarOptions={{ visible: false }}
          maxHeight={height}
        >
          <For each={groups}>
            {([category, options], index) => (
              <>
                <Show when={category}>
                  <box paddingTop={index() > 0 ? 1 : 0} paddingLeft={3}>
                    <text>{category}</text>
                  </box>
                </Show>
                <For each={options}>
                  {(option) => (
                    <box flexDirection='column' position='relative'>
                      <box
                        flexDirection='row'
                        paddingLeft={3}
                        paddingRight={3}
                        gap={1}
                      >
                        <text
                          flexGrow={1}
                          overflow='hidden'
                          wrapMode='none'
                          paddingLeft={3}
                        >
                          {option.title}
                          <Show when={option.description}>
                            <span> {option.description}</span>
                          </Show>
                        </text>
                        {/* The right-aligned footer (2.0.22 dialog-select.tsx
                            884-897; 1.18.30 draws it the same way). */}
                        <Show when={option.footer}>
                          <box flexShrink={0}>
                            <text>{option.footer}</text>
                          </box>
                        </Show>
                      </box>
                      <For each={option.details}>
                        {(detail) => (
                          <box paddingLeft={3} paddingRight={3}>
                            <text wrapMode='none'>{detail}</text>
                          </box>
                        )}
                      </For>
                    </box>
                  )}
                </For>
              </>
            )}
          </For>
        </scrollbox>
      </box>
      <box flexShrink={0} />
    </box>
  )
}

async function frame(section: Section) {
  let render: () => JSX.Element = () => undefined
  const api = {
    ui: {
      dialog: {
        setSize() {},
        replace(next: () => JSX.Element) {
          render = next
        },
      },
      DialogSelect,
    },
  } as unknown as TuiPluginApi
  openCommandDialog(
    api,
    {
      command: 'openai',
      menu: { command: 'openai', title: 'OpenAI', sections: [section] },
    },
    async () => {
      throw new Error('Rendering must not run an action')
    },
  )
  return capture(render)
}

async function capture(render: () => JSX.Element) {
  const view = await testRender(render, dimensions)
  try {
    await view.renderOnce()
    return view.captureCharFrame()
  } finally {
    view.renderer.destroy()
  }
}

const diagnostics: Section = {
  id: 'diagnostics',
  slot: 'diagnostics',
  title: 'Diagnostics',
  lines: [
    'Dumps on',
    'Dump directory: /tmp/opencode-openai-auth-dumps',
    'Log level: info',
  ],
  items: [],
  actions: [
    { id: 'dump', label: 'Turn request dumps off', knobs: [] },
    { id: 'logging', label: 'Set the log level', knobs: [] },
  ],
}

if (process.argv[2] === 'v2') {
  const section: Section = {
    ...diagnostics,
    items: [
      {
        id: 'notice',
        label: 'Read-only note',
        detail: 'Not an option',
        actions: [],
      },
      {
        id: 'main',
        label: 'Main account',
        status: 'Enabled',
        detail: 'Local OAuth\nReady',
        actions: [{ id: 'inspect', label: 'Inspect', knobs: [] }],
      },
    ],
    actions: diagnostics.actions.map((action) => ({
      ...action,
      description: 'Diagnostic setting\nStored locally',
    })),
  }
  let step = 0
  await openControlDialog(
    {
      async select(input: { title: string; options: Option[] }) {
        const output = await capture(() => <DialogSelect {...input} />)
        step++
        if (step === 1) {
          for (const text of ['Diagnostics', 'Reset credits', 'Accounts']) {
            assert.ok(
              output.includes(text),
              `OpenCode 2 menu hides ${text}:\n${output}`,
            )
          }
          return 'diagnostics'
        }
        if (step === 2) {
          assert.ok(
            input.options.every((option) => option.title !== 'Read-only note'),
          )
          for (const text of [
            ...diagnostics.lines,
            'Read-only note',
            'Not an option',
            'Main account',
            // The item's status, drawn once in the footer.
            'Enabled',
            'Turn request dumps off',
            'Set the log level',
            'Back',
          ]) {
            assert.ok(
              output.includes(text),
              `OpenCode 2 section hides ${text}:\n${output}`,
            )
          }
        }
        return undefined
      },
    } as unknown as Parameters<typeof openControlDialog>[0],
    {
      command: 'openai',
      menu: {
        command: 'openai',
        title: 'OpenAI',
        sections: [
          section,
          {
            id: 'reset',
            slot: 'extra',
            title: 'Reset credits',
            lines: [
              'Reset credits are unavailable in vault mode.',
              'Use the vault to manage reset credits.',
            ],
            items: [],
            actions: [],
          },
          {
            id: 'accounts',
            slot: 'accounts',
            title: 'Accounts',
            lines: [],
            items: [],
            actions: [],
          },
        ],
      },
    },
    async () => {
      throw new Error('Rendering must not run an action')
    },
    () => step < 2,
  )
  assert.equal(step, 2)
  console.log('command-dialogs-render v2 passed (2 frames)')
  process.exit(0)
}

const rendered = await frame(diagnostics)
assert.ok(
  rendered.includes('Set the log level'),
  `Diagnostics hides Set the log level:\n${rendered}`,
)
for (const text of [...diagnostics.lines, 'Turn request dumps off', 'Back']) {
  assert.ok(rendered.includes(text), `Diagnostics hides ${text}:\n${rendered}`)
}

const reset: Section = {
  id: 'reset',
  slot: 'extra',
  title: 'Reset credits',
  lines: [
    'Reset credits are unavailable in vault mode.',
    'Use the vault to manage reset credits.',
  ],
  items: [],
  actions: [],
}
const resetFrame = await frame(reset)
for (const text of [...reset.lines, 'Back']) {
  assert.ok(
    resetFrame.includes(text),
    `Reset credits hides ${text}:\n${resetFrame}`,
  )
}

for (const count of [0, 1, 2, 4, 6]) {
  const lines = Array.from({ length: count }, (_, i) => `Header line ${i + 1}`)
  const section: Section = {
    ...diagnostics,
    lines,
    facts: { note: 'Section fact' },
    items: [
      {
        id: 'notice',
        label: 'Read-only item',
        group: 'Notice',
        detail: 'Details\nMore details',
        facts: { state: 'Ready' },
        actions: [],
      },
      {
        id: 'account',
        label: 'Main account',
        group: 'Accounts',
        actions: [{ id: 'inspect', label: 'Inspect', knobs: [] }],
      },
    ],
    actions: diagnostics.actions.map((action) => ({
      ...action,
      group: 'Actions',
    })),
  }
  const output = await frame(section)
  for (const text of [
    ...lines,
    'note: Section fact',
    'Notice',
    'Read-only item',
    'Details',
    'More details',
    'state: Ready',
    'Accounts',
    'Main account',
    'Actions',
    'Turn request dumps off',
    'Set the log level',
    'Back',
  ]) {
    assert.ok(
      output.includes(text),
      `${count}-line header hides ${text}:\n${output}`,
    )
  }
}
console.log('command-dialogs-render passed (7 frames)')
process.exit(0)

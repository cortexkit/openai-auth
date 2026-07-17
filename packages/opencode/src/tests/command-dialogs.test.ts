import { describe, expect, mock, test } from 'bun:test'
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import type { OpenDialogPayload } from '../rpc/protocol.js'
import {
  buildAccountDialogRows,
  buildCachekeepDialogOptions,
  formatQuotaWindows,
  openCommandDialog,
} from '../tui/command-dialogs'

describe('command dialogs', () => {
  test('cachekeep modal shows Turn on when disabled', () => {
    const options = buildCachekeepDialogOptions({
      command: 'openai-cachekeep',
      text: '',
      knobs: { enabled: false, running: false, tracked: 0 },
    })

    expect(options[0]!.title).toContain('○ Disabled')
    expect(options.map((option) => option.title)).toContain('Turn on')
    expect(options.map((option) => option.title)).not.toContain('Turn off')
  })

  test('cachekeep modal shows Turn off when enabled', () => {
    const options = buildCachekeepDialogOptions({
      command: 'openai-cachekeep',
      text: '',
      knobs: {
        enabled: true,
        running: true,
        tracked: 2,
        generatedAt: 1700000005000,
        lastWarmAt: 1700000000000,
        maxIdleWarmMs: 60 * 60 * 1000,
      },
    })

    expect(options[0]!.title).toContain('● Enabled')
    expect(options[0]!.title).toContain('2 tracked')
    expect(options[0]!.title).toContain('last warm 5s ago')
    expect(options.map((option) => option.title)).toContain('Turn off')
    expect(options.map((option) => option.title)).toContain('Refresh status')
  })

  // The cachekeep dialog is implemented as JSX over the runtime-provided
  // `TuiPluginApi`. To exercise its onSelect without spinning the real TUI,
  // intercept the renderer's render fn and the runtime DialogSelect
  // component factory — both are accessed via the api object at render time,
  // so a minimal harness can capture the onSelect closure.
  function makeCachekeepDialogHarness() {
    let capturedRenderer: (() => unknown) | null = null
    let capturedOnSelect: ((option: { value: string }) => void) | null = null
    const clearCount = { value: 0 }
    const replaceCount = { value: 0 }

    const api = {
      ui: {
        dialog: {
          setSize: () => {},
          replace: (fn: () => unknown) => {
            capturedRenderer = fn
            replaceCount.value += 1
          },
          clear: () => {
            clearCount.value += 1
          },
        },
        toast: () => {},
        DialogSelect: ((props: {
          onSelect: (option: { value: string }) => void
        }) => {
          capturedOnSelect = props.onSelect
          return null
        }) as unknown as TuiPluginApi['ui']['DialogSelect'],
      },
    } as unknown as TuiPluginApi

    return {
      api,
      renderDialog: () => {
        capturedRenderer?.()
      },
      getOnSelect: () => capturedOnSelect,
      clearCount,
      replaceCount,
    }
  }

  test('cachekeep dialog "clear_window" applies "window clear" (not the literal option value)', async () => {
    const { api, renderDialog, getOnSelect } = makeCachekeepDialogHarness()
    const apply = mock(async () => ({ text: 'window cleared', knobs: {} }))

    const payload: OpenDialogPayload = {
      command: 'openai-cachekeep',
      text: '',
      knobs: {
        enabled: true,
        running: true,
        tracked: 0,
        window: { startHour: 9, endHour: 18 },
      },
    }
    openCommandDialog(api, payload, apply)

    renderDialog()
    const onSelect = getOnSelect()
    expect(onSelect).not.toBeNull()

    onSelect!({ value: 'clear_window' })
    await Promise.resolve()

    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith('openai-cachekeep', 'window clear')
  })

  test('cachekeep dialog "set_window" does not call apply directly (opens the prompt dialog)', async () => {
    const { api, renderDialog, getOnSelect, replaceCount } =
      makeCachekeepDialogHarness()
    const apply = mock(async () => ({ text: '', knobs: {} }))

    openCommandDialog(
      api,
      {
        command: 'openai-cachekeep',
        text: '',
        knobs: {
          enabled: true,
          running: true,
          tracked: 0,
          window: { startHour: 9, endHour: 18 },
        },
      },
      apply,
    )

    renderDialog()
    const onSelect = getOnSelect()
    expect(onSelect).not.toBeNull()

    const replacesBeforeSelect = replaceCount.value
    onSelect!({ value: 'set_window' })
    await Promise.resolve()

    // set_window must NOT call apply directly — it shows a sub-prompt.
    expect(apply).not.toHaveBeenCalled()
    // Instead it installs the window-prompt dialog via dialog.replace, so a
    // further replace must have fired beyond the initial dialog open.
    expect(replaceCount.value).toBeGreaterThan(replacesBeforeSelect)
  })

  test('account dialog marks the current session routing entry as active', () => {
    const rows = buildAccountDialogRows(
      {
        main: { quota: null, killed: false },
        fallbacks: [
          {
            id: 'fallback-1',
            label: 'work',
            quota: null,
            killed: false,
            enabled: true,
          },
        ],
        activeId: 'main',
        route: 'main-first',
        activeRouting: {
          'session-a': {
            activeId: 'fallback-1',
            route: 'fallback-first',
            updatedAt: Date.now(),
          },
        },
        lastUpdated: Date.now(),
      },
      'session-a',
    )

    expect(rows[0]?.title).toBe('main')
    expect(rows[1]?.title).toBe('work • active')
  })

  test('account dialog without a session uses the legacy active account', () => {
    const rows = buildAccountDialogRows({
      main: { quota: null, killed: false },
      fallbacks: [
        {
          id: 'killed',
          label: 'killed',
          quota: null,
          killed: true,
          enabled: true,
        },
      ],
      activeId: 'main',
      route: 'fallback-first',
      lastUpdated: Date.now(),
    })

    expect(rows[0]?.title).toBe('main • active')
    expect(rows[1]?.title).toBe('killed')
  })

  test('account quota descriptions derive labels from present window lengths', () => {
    expect(
      formatQuotaWindows({
        primary: {
          usedPercent: 20,
          remainingPercent: 80,
          windowMinutes: 10_080,
        },
      }),
    ).toBe('7d: 20%')

    expect(
      formatQuotaWindows({
        primary: {
          usedPercent: 3,
          remainingPercent: 97,
          windowMinutes: 300,
        },
        secondary: {
          usedPercent: 20,
          remainingPercent: 80,
          windowMinutes: 10_080,
        },
      }),
    ).toBe('5h: 3% 7d: 20%')
  })

  test('account quota descriptions show reset credits without windows', () => {
    expect(formatQuotaWindows({ resetCreditsAvailable: 3 })).toBe('resets: 3')
  })

  test('account quota descriptions reserve no-data text for empty snapshots', () => {
    expect(formatQuotaWindows({})).toBe('no quota data')
    expect(formatQuotaWindows(null)).toBe('no quota data')
  })
})

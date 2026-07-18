import { describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import { flushForTest, setLogLevel } from '../logger.js'
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

  type ResetSelectOption = {
    title: string
    value: string
    description?: string
    disabled?: boolean
  }

  type ResetSelectProps = {
    title: string
    options: ResetSelectOption[]
    onSelect: (option: ResetSelectOption) => void
  }

  type ResetConfirmProps = {
    title: string
    message: string
    onConfirm: () => void
    onCancel: () => void
  }

  function makeResetDialogHarness() {
    let capturedRenderer: (() => unknown) | null = null
    let selectProps: ResetSelectProps | null = null
    let confirmProps: ResetConfirmProps | null = null
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
        DialogSelect: ((props: ResetSelectProps) => {
          selectProps = props
          confirmProps = null
          return null
        }) as unknown as TuiPluginApi['ui']['DialogSelect'],
        DialogConfirm: ((props: ResetConfirmProps) => {
          confirmProps = props
          selectProps = null
          return null
        }) as unknown as TuiPluginApi['ui']['DialogConfirm'],
      },
    } as unknown as TuiPluginApi

    return {
      api,
      renderDialog: () => capturedRenderer?.(),
      select: (value: string) => {
        const option = selectProps?.options.find(
          (candidate) => candidate.value === value,
        )
        if (!option || option.disabled) return false
        selectProps?.onSelect(option)
        return true
      },
      confirm: () => confirmProps?.onConfirm(),
      cancel: () => confirmProps?.onCancel(),
      getSelectProps: () => selectProps,
      getConfirmProps: () => confirmProps,
      renderedStrings: () =>
        JSON.stringify({
          select: selectProps
            ? {
                title: selectProps.title,
                options: selectProps.options,
              }
            : null,
          confirm: confirmProps
            ? { title: confirmProps.title, message: confirmProps.message }
            : null,
        }),
      clearCount,
      replaceCount,
    }
  }

  function resetAccountsPayload(): OpenDialogPayload {
    return {
      command: 'openai-reset',
      text: 'Reset account list',
      knobs: {
        stage: 'accounts',
        accessToken: 'must-not-render-token',
        redeemRequestId: 'must-not-render-uuid',
        accounts: [
          {
            accountKey: 'fallback/a b',
            label: 'Fallback A',
            chatgptAccountId: 'chatgpt/fallback a',
            usedPercent: 100,
            availableCount: 3,
            applicableAvailableCount: 2,
            eligible: true,
            selectedCreditId: 'credit-1',
            selectedCreditExpiresAt: '2026-08-01T00:00:00.000Z',
          },
          {
            accountKey: 'healthy',
            label: 'Healthy',
            chatgptAccountId: 'chatgpt-healthy',
            usedPercent: 42,
            availableCount: 2,
            applicableAvailableCount: 2,
            eligible: false,
            reason: 'not exhausted',
          },
          {
            accountKey: 'no-credits',
            label: 'No credits',
            chatgptAccountId: 'chatgpt-no-credits',
            usedPercent: 100,
            availableCount: 4,
            applicableAvailableCount: 0,
            eligible: false,
            reason: 'no applicable credits',
          },
        ],
      },
    }
  }

  function resetConfirmPayload(): OpenDialogPayload {
    return {
      command: 'openai-reset',
      text: [
        'Account: Fallback A',
        'Current quota: 100% used',
        'Spend 1 of 2 reset credits',
        'Credit expires: 2026-08-01T00:00:00.000Z',
        'Quota resets: 2026-07-18T00:00:00.000Z',
      ].join('\n'),
      knobs: {
        stage: 'confirm',
        accessToken: 'must-not-render-token',
        redeemRequestId: 'must-not-render-uuid',
        preview: {
          accountKey: 'fallback/a b',
          label: 'Fallback A',
          chatgptAccountId: 'chatgpt/fallback a',
          usedPercent: 100,
          applicableAvailableCount: 2,
          eligible: true,
          selectedCreditExpiresAt: '2026-08-01T00:00:00.000Z',
          resetTime: '2026-07-18T00:00:00.000Z',
        },
      },
    }
  }

  function resetResultPayload(
    code:
      | 'reset'
      | 'ambiguous'
      | 'http_error'
      | 'expired_unreconciled' = 'reset',
  ): OpenDialogPayload {
    return {
      command: 'openai-reset',
      text: `VERBATIM RESULT: ${code}`,
      knobs: {
        stage: 'result',
        accountKey: 'fallback/a b',
        code,
        retryGuidance:
          code === 'reset' ? undefined : 'same request and credit identifiers',
        chatgptAccountId: code === 'reset' ? undefined : 'chatgpt/fallback a',
        accessToken: 'must-not-render-token',
        redeemRequestId: 'must-not-render-uuid',
      },
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

  test('reset dialog routes initial, select, confirm, retry, and refresh stages through fresh replacement payloads', async () => {
    const harness = makeResetDialogHarness()
    const apply = mock(async (_command: string, args: string) => {
      if (args.startsWith('select ')) {
        return {
          text: resetConfirmPayload().text,
          knobs: resetConfirmPayload().knobs,
        }
      }
      if (args.startsWith('confirm ')) {
        return {
          text: resetResultPayload('ambiguous').text,
          knobs: resetResultPayload('ambiguous').knobs,
        }
      }
      return {
        text: resetAccountsPayload().text,
        knobs: resetAccountsPayload().knobs,
      }
    })

    openCommandDialog(harness.api, resetAccountsPayload(), apply)
    harness.renderDialog()
    expect(apply).not.toHaveBeenCalled()

    expect(harness.select('account:fallback/a b')).toBe(true)
    await Promise.resolve()
    expect(apply).toHaveBeenLastCalledWith(
      'openai-reset',
      `select ${encodeURIComponent('fallback/a b')}`,
    )
    harness.renderDialog()

    harness.confirm()
    await Promise.resolve()
    expect(apply).toHaveBeenLastCalledWith(
      'openai-reset',
      `confirm ${encodeURIComponent('fallback/a b')} ${encodeURIComponent('chatgpt/fallback a')}`,
    )
    harness.renderDialog()

    expect(harness.select('retry')).toBe(true)
    await Promise.resolve()
    expect(apply).toHaveBeenLastCalledWith(
      'openai-reset',
      `retry ${encodeURIComponent('fallback/a b')} ${encodeURIComponent('chatgpt/fallback a')}`,
    )
    harness.renderDialog()

    expect(harness.select('refresh')).toBe(true)
    await Promise.resolve()
    expect(apply).toHaveBeenLastCalledWith('openai-reset', 'refresh')
    expect(harness.clearCount.value).toBe(0)
    expect(harness.replaceCount.value).toBeGreaterThanOrEqual(5)
  })

  test('reset dialog ignores an older apply completion after a newer apply renders', async () => {
    const harness = makeResetDialogHarness()
    let resolveFirst!: (value: {
      text: string
      knobs: Record<string, unknown>
    }) => void
    let resolveSecond!: (value: {
      text: string
      knobs: Record<string, unknown>
    }) => void
    const first = new Promise<{ text: string; knobs: Record<string, unknown> }>(
      (resolve) => {
        resolveFirst = resolve
      },
    )
    const second = new Promise<{
      text: string
      knobs: Record<string, unknown>
    }>((resolve) => {
      resolveSecond = resolve
    })
    let calls = 0
    const apply = mock(async () => {
      calls += 1
      return calls === 1 ? first : second
    })
    openCommandDialog(harness.api, resetAccountsPayload(), apply)
    harness.renderDialog()

    expect(harness.select('account:fallback/a b')).toBe(true)
    expect(harness.select('account:fallback/a b')).toBe(true)
    resolveSecond({
      text: 'SECOND RESULT',
      knobs: { stage: 'result', code: 'reset' },
    })
    await Bun.sleep(0)
    harness.renderDialog()
    expect(harness.renderedStrings()).toContain('SECOND RESULT')

    resolveFirst({
      text: 'STALE FIRST RESULT',
      knobs: { stage: 'result', code: 'reset' },
    })
    await Bun.sleep(0)
    harness.renderDialog()
    expect(harness.renderedStrings()).toContain('SECOND RESULT')
    expect(harness.renderedStrings()).not.toContain('STALE FIRST RESULT')
  })

  test('reset dialog ignores an apply completion after close', async () => {
    const harness = makeResetDialogHarness()
    let resolveApply!: (value: {
      text: string
      knobs: Record<string, unknown>
    }) => void
    const pending = new Promise<{
      text: string
      knobs: Record<string, unknown>
    }>((resolve) => {
      resolveApply = resolve
    })
    const apply = mock(async () => pending)
    openCommandDialog(harness.api, resetAccountsPayload(), apply)
    harness.renderDialog()

    expect(harness.select('account:fallback/a b')).toBe(true)
    expect(harness.select('close')).toBe(true)
    const replacesAfterClose = harness.replaceCount.value
    resolveApply({
      text: 'LATE RESULT',
      knobs: { stage: 'result', code: 'reset' },
    })
    await Bun.sleep(0)

    expect(harness.clearCount.value).toBe(1)
    expect(harness.replaceCount.value).toBe(replacesAfterClose)
  })

  test('reset account rows lead with the verdict and keep details in the description', () => {
    const harness = makeResetDialogHarness()
    const payload = resetAccountsPayload()

    openCommandDialog(
      harness.api,
      payload,
      mock(async () => ({ text: '', knobs: {} })),
    )
    harness.renderDialog()

    const options = harness.getSelectProps()?.options ?? []
    expect(
      options.find((option) => option.value === 'account:fallback/a b'),
    ).toMatchObject({
      title: 'Fallback A — eligible',
      description: '100% · 2/3 · exp 2026-08-01',
    })
    expect(
      options.find((option) => option.value === 'account:healthy'),
    ).toMatchObject({
      title: 'Healthy — not exhausted',
      description: '42% · 2/2',
    })
    expect(
      options.find((option) => option.value === 'account:no-credits'),
    ).toMatchObject({
      title: 'No credits — no applicable credits',
      description: '100% · 0/4',
    })
  })

  test('reset account dialog keeps ineligible rows selectable and renders a non-confirm result', async () => {
    const harness = makeResetDialogHarness()
    const apply = mock(async () => ({
      text: 'Cannot reset: **not exhausted**',
      knobs: {
        stage: 'result',
        accountKey: 'healthy',
        code: 'not_eligible',
      },
    }))
    openCommandDialog(harness.api, resetAccountsPayload(), apply)
    harness.renderDialog()

    const options = harness.getSelectProps()?.options ?? []
    expect(
      options.find((option) => option.value === 'account:healthy'),
    ).toMatchObject({
      title: expect.stringContaining('not exhausted'),
    })
    expect(
      options.find((option) => option.value === 'account:healthy')?.disabled,
    ).not.toBe(true)
    expect(
      options.find((option) => option.value === 'account:no-credits'),
    ).toMatchObject({
      title: expect.stringContaining('no applicable credits'),
    })
    expect(
      options.find((option) => option.value === 'account:no-credits')?.disabled,
    ).not.toBe(true)

    expect(harness.select('account:healthy')).toBe(true)
    await Promise.resolve()
    expect(apply).toHaveBeenCalledWith('openai-reset', 'select healthy')
    harness.renderDialog()
    expect(harness.getConfirmProps()).toBeNull()
    expect(
      harness.getSelectProps()?.options.map((option) => option.value),
    ).toEqual(['result', 'refresh', 'close'])
    expect(
      harness.getSelectProps()?.options.map((option) => option.value),
    ).not.toContain('retry')
  })

  test('reset dialog renders a generic result when apply rejects', async () => {
    const harness = makeResetDialogHarness()
    const logDir = mkdtempSync(join(tmpdir(), 'oai-reset-dialog-reject-'))
    const logFile = join(logDir, 'test.log')
    const savedLogFile = process.env.OPENCODE_OPENAI_AUTH_LOG_FILE
    process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = logFile
    setLogLevel('warn')
    const apply = mock(async () => {
      throw new Error('/private/plugin/path: secret internal failure')
    })
    try {
      openCommandDialog(harness.api, resetAccountsPayload(), apply)
      harness.renderDialog()

      expect(harness.select('account:fallback/a b')).toBe(true)
      await Promise.resolve()
      await Promise.resolve()
      harness.renderDialog()
      await flushForTest()

      const rendered = harness.renderedStrings()
      const logged = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
      expect(rendered).toContain('Command failed')
      expect(rendered).toContain('plugin log has details')
      expect(rendered).not.toContain('/private/plugin/path')
      expect(logged).toContain('WARN [rpc-tui] reset dialog apply rejected')
      expect(logged).toContain('/private/plugin/path: secret internal failure')
      expect(
        harness.getSelectProps()?.options.map((option) => option.value),
      ).toContain('close')
      expect(harness.clearCount.value).toBe(0)
    } finally {
      process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = savedLogFile
      setLogLevel(undefined)
      rmSync(logDir, { recursive: true, force: true })
    }
  })

  test('reset dialog renders an honest result when apply returns no stage', async () => {
    const harness = makeResetDialogHarness()
    const apply = mock(async () => ({ text: 'apply failed', knobs: {} }))
    openCommandDialog(harness.api, resetAccountsPayload(), apply)
    harness.renderDialog()

    expect(harness.select('account:fallback/a b')).toBe(true)
    await Promise.resolve()
    harness.renderDialog()

    expect(harness.getSelectProps()?.title).toBe('OpenAI reset result')
    expect(harness.renderedStrings()).toContain(
      'The reset request is still completing or returned no result. Choose Refresh to check the current state — do NOT re-confirm.',
    )
  })

  test('reset account selection does not collide with dialog action names', async () => {
    const harness = makeResetDialogHarness()
    const payload = resetAccountsPayload()
    const accounts = payload.knobs.accounts as Array<Record<string, unknown>>
    const firstAccount = accounts[0]
    if (!firstAccount) throw new Error('reset account fixture is empty')
    firstAccount.accountKey = 'refresh'
    const apply = mock(async () => ({
      text: resetConfirmPayload().text,
      knobs: resetConfirmPayload().knobs,
    }))
    openCommandDialog(harness.api, payload, apply)
    harness.renderDialog()
    const accountOption = harness
      .getSelectProps()
      ?.options.find((option) => option.title.includes('Fallback A'))

    expect(accountOption).toBeDefined()
    if (!accountOption) throw new Error('reset account option was not rendered')
    expect(harness.select(accountOption.value)).toBe(true)
    await Promise.resolve()

    expect(apply).toHaveBeenCalledWith('openai-reset', 'select refresh')
  })

  test('reset confirmation shows binding details and destructive copy with Reset and Cancel actions', async () => {
    const harness = makeResetDialogHarness()
    const apply = mock(async () => ({
      text: resetAccountsPayload().text,
      knobs: resetAccountsPayload().knobs,
    }))
    openCommandDialog(harness.api, resetConfirmPayload(), apply)
    harness.renderDialog()

    const confirm = harness.getConfirmProps()
    expect(confirm?.title).toContain('Reset')
    expect(confirm?.message).toContain('Fallback A')
    expect(confirm?.message).toContain('100% used')
    expect(confirm?.message).toContain('Spend 1 of 2 reset credits')
    expect(confirm?.message).toContain('2026-08-01T00:00:00.000Z')
    expect(confirm?.message).toContain('2026-07-18T00:00:00.000Z')
    expect(confirm?.message).toContain('SPENDS 1 of 2 reset credits')
    expect(confirm?.message).toContain('irreversible')
    expect(confirm?.message).toContain('Reset')
    expect(confirm?.message).toContain('Cancel')
    expect(confirm?.message).toContain(
      'Enter = Cancel (host default). Press Tab then Enter to Reset.',
    )

    harness.cancel()
    await Promise.resolve()
    expect(apply).toHaveBeenLastCalledWith('openai-reset', 'refresh')
  })

  test('reset result renders payload text verbatim and exposes Retry only for bound retry-safe outcomes', async () => {
    for (const code of [
      'ambiguous',
      'http_error',
      'expired_unreconciled',
    ] as const) {
      const harness = makeResetDialogHarness()
      const apply = mock(async () => ({
        text: resetAccountsPayload().text,
        knobs: resetAccountsPayload().knobs,
      }))
      const payload = resetResultPayload(code)
      openCommandDialog(harness.api, payload, apply)
      harness.renderDialog()

      const options = harness.getSelectProps()?.options ?? []
      expect(options[0]).toMatchObject({
        title: payload.text,
      })
      expect(options[0]?.disabled).not.toBe(true)
      expect(options.map((option) => option.value)).toContain('retry')
      expect(harness.select('retry')).toBe(true)
      await Promise.resolve()
      expect(apply).toHaveBeenLastCalledWith(
        'openai-reset',
        `retry ${encodeURIComponent('fallback/a b')} ${encodeURIComponent('chatgpt/fallback a')}`,
      )
    }

    const terminalHarness = makeResetDialogHarness()
    openCommandDialog(
      terminalHarness.api,
      resetResultPayload('reset'),
      mock(async () => ({ text: '', knobs: {} })),
    )
    terminalHarness.renderDialog()
    expect(
      terminalHarness.getSelectProps()?.options.map((option) => option.value),
    ).not.toContain('retry')
  })

  test('reset result text is visible but inert when selected', async () => {
    const harness = makeResetDialogHarness()
    const apply = mock(async () => ({ text: '', knobs: {} }))
    const payload = resetResultPayload('reset')
    openCommandDialog(harness.api, payload, apply)
    harness.renderDialog()

    const resultOption = harness
      .getSelectProps()
      ?.options.find((option) => option.value === 'result')
    expect(resultOption).toMatchObject({ title: payload.text })
    expect(resultOption?.disabled).not.toBe(true)
    expect(harness.select('result')).toBe(true)
    await Promise.resolve()
    expect(apply).not.toHaveBeenCalled()
  })

  test('reset dialog never renders token or redemption UUID knob values', () => {
    for (const payload of [
      resetAccountsPayload(),
      resetConfirmPayload(),
      resetResultPayload('ambiguous'),
    ]) {
      const harness = makeResetDialogHarness()
      openCommandDialog(
        harness.api,
        payload,
        mock(async () => ({ text: '', knobs: {} })),
      )
      harness.renderDialog()
      const rendered = harness.renderedStrings()
      expect(rendered).not.toContain('must-not-render-token')
      expect(rendered).not.toContain('must-not-render-uuid')
    }
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

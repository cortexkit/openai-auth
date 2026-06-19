/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import type { OpenDialogPayload } from '../rpc/protocol.js'
import { getSidebarState } from '../sidebar-state.js'
import { openUrl } from '../util/open-url'

type ApplyFn = (
  command: OpenDialogPayload['command'],
  args: string,
) => Promise<{ text: string; knobs: Record<string, unknown> }>

export function buildCachekeepDialogOptions(payload: OpenDialogPayload) {
  const enabled = payload.knobs.enabled === true
  const subagents = payload.knobs.subagents === true
  const running = payload.knobs.running === true
  const tracked = Number(payload.knobs.tracked ?? 0)
  const generatedAt = Number(payload.knobs.generatedAt ?? Date.now())
  const lastWarmAt = Number(payload.knobs.lastWarmAt ?? 0)
  const maxIdleWarmMs = Number(payload.knobs.maxIdleWarmMs ?? 60 * 60 * 1000)
  const maxSubagentIdleMs = Number(
    payload.knobs.maxSubagentIdleMs ?? 30 * 60 * 1000,
  )
  const lastWarm = lastWarmAt
    ? `${Math.ceil((generatedAt - lastWarmAt) / 1000)}s ago`
    : 'none yet'
  const idleWindow = Math.round(maxIdleWarmMs / 60_000)
  const subIdleWindow = Math.round(maxSubagentIdleMs / 60_000)
  const statusParts = [
    enabled ? '● Enabled' : '○ Disabled',
    `timer ${running ? 'armed' : 'idle'}`,
    `${tracked} tracked`,
    `last warm ${lastWarm}`,
    `${idleWindow}m idle cap`,
    `subagent idle ${subIdleWindow}m`,
  ].filter((part) => part.length > 0)

  return [
    {
      title: statusParts.join(' | '),
      value: 'status',
      description: 'Current cachekeep state',
    },
    {
      title: enabled ? 'Turn off' : 'Turn on',
      value: enabled ? 'off' : 'on',
      description: enabled
        ? 'Stop capturing and warming prompt-cache prefixes'
        : 'Persistently enable capture; the timer self-arms on request capture',
    },
    {
      title: subagents ? 'Subagent warming: on' : 'Subagent warming: off',
      value: subagents ? 'subagents off' : 'subagents on',
      description: subagents
        ? `Warm subagent sessions (${subIdleWindow}m idle cap). Disable to skip subagents.`
        : `Skip subagent sessions. Enable to warm them too (${subIdleWindow}m idle cap).`,
    },
    {
      title: 'Refresh status',
      value: 'refresh',
      description: 'Re-read cachekeep status',
    },
    {
      title: 'Close',
      value: 'close',
      description: 'Close this dialog',
    },
  ]
}

function showText(api: TuiPluginApi, text: string) {
  api.ui.dialog.setSize('xlarge')
  api.ui.dialog.replace(() => (
    <box flexDirection='column' padding={1} width='100%'>
      <text>{text}</text>
    </box>
  ))
}

export function openCommandDialog(
  api: TuiPluginApi,
  payload: OpenDialogPayload,
  apply: ApplyFn,
) {
  if (payload.command === 'openai-routing') {
    const current = (payload.knobs.mode as string) ?? 'main-first'
    const DialogSelect = api.ui.DialogSelect<string>
    api.ui.dialog.setSize('xlarge')
    api.ui.dialog.replace(() => (
      <DialogSelect
        title='OpenAI routing'
        current={current}
        options={[
          {
            title: 'Main first',
            value: 'main-first',
            description: 'Use the main account until exhausted',
          },
          {
            title: 'Fallback first',
            value: 'fallback-first',
            description: 'Prefer fallback accounts, preserve main',
          },
        ]}
        onSelect={(option) => {
          void apply('openai-routing', String(option.value)).then((r) => {
            api.ui.toast({ message: r.text })
            api.ui.dialog.clear()
          })
        }}
      />
    ))
    return
  }

  if (payload.command === 'openai-dump') {
    const enabled = payload.knobs.enabled === true
    const DialogConfirm = api.ui.DialogConfirm
    api.ui.dialog.setSize('xlarge')
    api.ui.dialog.replace(() => (
      <DialogConfirm
        title='OpenAI request dump'
        message={`${payload.text}\n\n${enabled ? 'Disable' : 'Enable'} request dump?`}
        onConfirm={() => {
          void apply('openai-dump', enabled ? 'off' : 'on').then((r) => {
            api.ui.toast({ message: r.text })
            api.ui.dialog.clear()
          })
        }}
        onCancel={() => api.ui.dialog.clear()}
      />
    ))
    return
  }

  if (payload.command === 'openai-killswitch') {
    const config = (payload.knobs.config ?? {}) as {
      enabled?: boolean
      main?: Record<string, number>
      accounts?: Record<string, Record<string, number>>
    }
    const accountIds = (payload.knobs.accountIds as string[]) ?? []
    const enabled = config.enabled === true
    const readT = (t: Record<string, number> | undefined) => {
      const fh = t?.primary ?? t?.['5h'] ?? 5
      const sd = t?.secondary ?? t?.['1w'] ?? 10
      return { fh, sd }
    }
    const mainT = readT(config.main)
    const seedParts = [`main:${mainT.fh},${mainT.sd}`]
    for (const id of accountIds) {
      const t = readT(config.accounts?.[id] ?? config.main)
      seedParts.push(`${id}:${t.fh},${t.sd}`)
    }
    const seed = seedParts.join(' ')

    const openEdit = () => {
      const DialogPrompt = api.ui.DialogPrompt
      api.ui.dialog.setSize('xlarge')
      api.ui.dialog.replace(() => (
        <DialogPrompt
          title='Killswitch thresholds'
          description={() => <text>{payload.text}</text>}
          placeholder='main:5,10 work-alt:5,10'
          value={seed}
          onConfirm={(value: string) => {
            void apply('openai-killswitch', `set ${value.trim()}`).then((r) => {
              api.ui.toast({ message: r.text })
              api.ui.dialog.clear()
            })
          }}
          onCancel={() => api.ui.dialog.clear()}
        />
      ))
    }

    const DialogSelect = api.ui.DialogSelect<string>
    api.ui.dialog.setSize('xlarge')
    api.ui.dialog.replace(() => (
      <DialogSelect
        title='OpenAI killswitch'
        options={[
          {
            title: enabled ? 'Disable killswitch' : 'Enable killswitch',
            value: enabled ? 'off' : 'on',
            description: enabled
              ? 'Stop hard-blocking on low quota'
              : 'Hard-block requests when quota drops below thresholds',
          },
          {
            title: 'Edit thresholds\u2026',
            value: 'edit',
            description: 'Set per-account 5h,1w cutoffs',
          },
        ]}
        onSelect={(option) => {
          if (option.value === 'edit') {
            openEdit()
            return
          }
          void apply('openai-killswitch', String(option.value)).then((r) => {
            api.ui.toast({ message: r.text })
            api.ui.dialog.clear()
          })
        }}
      />
    ))
    return
  }

  if (payload.command === 'openai-logging') {
    const current = (payload.knobs.level as string) ?? 'info'
    const levels = ['error', 'warn', 'info', 'debug', 'trace']
    const DialogSelect = api.ui.DialogSelect<string>
    api.ui.dialog.setSize('xlarge')
    api.ui.dialog.replace(() => (
      <DialogSelect
        title='OpenAI logging'
        current={current}
        options={levels.map((level) => ({
          title: level,
          value: level,
          description:
            level === current
              ? 'currently active'
              : `Set log level to ${level}`,
        }))}
        onSelect={(option) => {
          void apply('openai-logging', String(option.value)).then((r) => {
            api.ui.toast({ message: r.text })
            api.ui.dialog.clear()
          })
        }}
      />
    ))
    return
  }

  if (payload.command === 'openai-cachekeep') {
    const render = (state: OpenDialogPayload) => {
      const options = buildCachekeepDialogOptions(state)
      const DialogSelect = api.ui.DialogSelect<string>
      api.ui.dialog.setSize('xlarge')
      api.ui.dialog.replace(() => (
        <DialogSelect
          title='OpenAI cachekeep'
          current='status'
          options={options}
          onSelect={(option) => {
            if (option.value === 'close') {
              api.ui.dialog.clear()
              return
            }
            const args =
              option.value === 'refresh' ? 'status' : String(option.value)
            void apply('openai-cachekeep', args).then((r) => {
              render({
                command: 'openai-cachekeep',
                text: r.text,
                knobs: r.knobs,
              })
            })
          }}
        />
      ))
    }
    render(payload)
    return
  }

  if (payload.command === 'openai-account') {
    openAccountDialog(api, apply)
    return
  }

  // fallback for quota (display-only)
  showText(api, payload.text)
}

// -- Accounts dialog ---------------------------------------------------------

function formatQuota5h7d(
  quota:
    | { primary?: { usedPercent: number }; secondary?: { usedPercent: number } }
    | null
    | undefined,
): string {
  if (!quota) return 'no quota data'
  const parts: string[] = []
  if (quota.primary) parts.push(`5h: ${Math.round(quota.primary.usedPercent)}%`)
  if (quota.secondary)
    parts.push(`7d: ${Math.round(quota.secondary.usedPercent)}%`)
  return parts.length > 0 ? parts.join(' ') : 'no quota data'
}

function osc52Copy(api: TuiPluginApi, text: string): boolean {
  try {
    const renderer = api.renderer as unknown as
      | {
          copyToClipboardOSC52?: (t: string) => boolean
        }
      | null
      | undefined
    if (renderer && typeof renderer.copyToClipboardOSC52 === 'function') {
      return renderer.copyToClipboardOSC52(text)
    }
  } catch {
    // best-effort
  }
  return false
}

function openAccountDialog(api: TuiPluginApi, apply: ApplyFn) {
  const DialogConfirm = api.ui.DialogConfirm

  function showL1() {
    void getSidebarState().then((state) => {
      const DialogSelectInner = api.ui.DialogSelect<string>
      api.ui.dialog.setSize('xlarge')
      api.ui.dialog.replace(() => (
        <DialogSelectInner
          title='OpenAI Accounts'
          options={[
            {
              title: `main${state.activeId === 'main' || !state.activeId ? ' \u2022 active' : ''}`,
              value: 'main',
              description: formatQuota5h7d(state.main.quota),
            },
            ...state.fallbacks.map((fb) => ({
              title: `${fb.label ?? fb.id}${state.activeId === fb.id ? ' \u2022 active' : ''}${!fb.enabled ? ' (disabled)' : ''}`,
              value: fb.id,
              description: formatQuota5h7d(fb.quota),
            })),
            {
              title: 'Add account\u2026',
              value: '__add__',
              description: 'Sign in to a new OpenAI account',
            },
          ]}
          onSelect={(option) => {
            if (option.value === '__add__') {
              showAddFlow()
              return
            }
            if (option.value === 'main') {
              showL2Main()
              return
            }
            showL2Fallback(option.value)
          }}
        />
      ))
    })
  }

  function showL2Main() {
    void getSidebarState().then((state) => {
      const DialogSelectInner = api.ui.DialogSelect<string>
      const isActive = state.activeId === 'main' || !state.activeId
      const options: Array<{
        title: string
        value: string
        description: string
      }> = []
      if (!isActive) {
        options.push({
          title: 'Switch to main account',
          value: 'switch',
          description: 'Make main the active account',
        })
      }
      options.push({
        title: 'Back',
        value: 'back',
        description: 'Return to account list',
      })
      api.ui.dialog.setSize('xlarge')
      api.ui.dialog.replace(() => (
        <DialogSelectInner
          title='Main account'
          options={options}
          onSelect={(option) => {
            if (option.value === 'switch') {
              void apply('openai-account', 'switch main').then((r) => {
                api.ui.toast({ message: r.text })
                showL1()
              })
              return
            }
            showL1()
          }}
        />
      ))
    })
  }

  function showL2Fallback(id: string) {
    void getSidebarState().then((state) => {
      const DialogSelectInner = api.ui.DialogSelect<string>
      const fbIndex = state.fallbacks.findIndex((f) => f.id === id)
      const fb = state.fallbacks[fbIndex]
      if (!fb) {
        showL1()
        return
      }
      const isActive = state.activeId === id
      const options: Array<{
        title: string
        value: string
        description: string
      }> = []

      if (!isActive) {
        options.push({
          title: 'Switch to this account',
          value: 'switch',
          description: 'Make this the active account',
        })
      }

      options.push({
        title: 'Remove',
        value: 'remove',
        description: `Remove ${fb.label ?? fb.id}`,
      })

      if (fbIndex > 0) {
        const neighbor = state.fallbacks[fbIndex - 1]
        if (neighbor) {
          options.push({
            title: 'Move up',
            value: 'move_up',
            description: `Swap with ${neighbor.label ?? neighbor.id}`,
          })
        }
      }

      if (fbIndex < state.fallbacks.length - 1) {
        const neighbor = state.fallbacks[fbIndex + 1]
        if (neighbor) {
          options.push({
            title: 'Move down',
            value: 'move_down',
            description: `Swap with ${neighbor.label ?? neighbor.id}`,
          })
        }
      }

      options.push({
        title: 'Back',
        value: 'back',
        description: 'Return to account list',
      })

      api.ui.dialog.setSize('xlarge')
      api.ui.dialog.replace(() => (
        <DialogSelectInner
          title={fb.label ?? fb.id}
          options={options}
          onSelect={(option) => {
            if (option.value === 'switch') {
              void apply('openai-account', `switch ${id}`).then((r) => {
                api.ui.toast({ message: r.text })
                showL1()
              })
              return
            }
            if (option.value === 'remove') {
              api.ui.dialog.setSize('xlarge')
              api.ui.dialog.replace(() => (
                <DialogConfirm
                  title='Remove account'
                  message={`Remove ${fb.label ?? fb.id}?`}
                  onConfirm={() => {
                    void apply('openai-account', `remove ${id}`).then((r) => {
                      api.ui.toast({ message: r.text })
                      showL1()
                    })
                  }}
                  onCancel={() => showL2Fallback(id)}
                />
              ))
              return
            }
            if (option.value === 'move_up') {
              const neighbor = state.fallbacks[fbIndex - 1]
              if (neighbor) {
                void apply('openai-account', `order ${id} ${neighbor.id}`).then(
                  (r) => {
                    api.ui.toast({ message: r.text })
                    showL1()
                  },
                )
              }
              return
            }
            if (option.value === 'move_down') {
              const neighbor = state.fallbacks[fbIndex + 1]
              if (neighbor) {
                void apply('openai-account', `order ${id} ${neighbor.id}`).then(
                  (r) => {
                    api.ui.toast({ message: r.text })
                    showL1()
                  },
                )
              }
              return
            }
            showL1()
          }}
        />
      ))
    })
  }

  // -- Add flow ---------------------------------------------------------------

  function showAddFlow() {
    const DialogSelectInner = api.ui.DialogSelect<string>
    api.ui.dialog.setSize('xlarge')
    api.ui.dialog.replace(() => (
      <DialogSelectInner
        title='Add account'
        options={[
          {
            title: 'Browser sign-in (local)',
            value: 'browser',
            description: 'Opens a browser window for OAuth on this machine',
          },
          {
            title: 'Device code (remote / no browser)',
            value: 'device',
            description: 'Enter a code on another device to authorize',
          },
          {
            title: 'Back',
            value: 'back',
            description: 'Return to account list',
          },
        ]}
        onSelect={(option) => {
          if (option.value === 'browser') {
            showLabelPrompt('browser')
            return
          }
          if (option.value === 'device') {
            showLabelPrompt('device')
            return
          }
          showL1()
        }}
      />
    ))
  }

  function showLabelPrompt(mode: 'browser' | 'device') {
    const DialogPromptInner = api.ui.DialogPrompt
    api.ui.dialog.setSize('xlarge')
    api.ui.dialog.replace(() => (
      <DialogPromptInner
        title='Label (optional)'
        description={() => (
          <text>
            Give this account a name (e.g. "work", "personal"). Leave empty to
            auto-detect.
          </text>
        )}
        placeholder='e.g. work'
        value=''
        onConfirm={(label: string) => {
          if (mode === 'browser') {
            startBrowserAdd(label.trim() || undefined)
          } else {
            startDeviceAdd(label.trim() || undefined)
          }
        }}
        onCancel={() => showAddFlow()}
      />
    ))
  }

  function startBrowserAdd(label: string | undefined) {
    const args = label ? `add ${label}` : 'add'
    void apply('openai-account', args).then((r) => {
      const url = r.knobs.url as string | undefined
      const instructions = r.knobs.instructions as string | undefined

      if (!url) {
        api.ui.toast({ message: 'Failed to get auth URL', variant: 'warning' })
        showL1()
        return
      }

      // Auto-open the browser (best-effort)
      try {
        openUrl(url)
      } catch {
        // best-effort
      }

      showBrowserAuthScreen(url, instructions)
    })
  }

  function showBrowserAuthScreen(
    url: string,
    _instructions: string | undefined,
  ) {
    const DialogSelectInner = api.ui.DialogSelect<string>
    api.ui.dialog.setSize('xlarge')
    api.ui.dialog.replace(() => (
      <DialogSelectInner
        title='Browser sign-in'
        options={[
          {
            title: 'Copy auth URL',
            value: 'copy_url',
            description: url,
          },
          {
            title: 'Open in browser',
            value: 'open',
            description: 'Try to open the URL in your browser',
          },
          {
            title: "Done / I've authorized",
            value: 'done',
            description: 'Return to account list',
          },
          {
            title: 'Cancel',
            value: 'cancel',
            description: 'Return to account list without adding',
          },
        ]}
        skipFilter={true}
        onSelect={(option) => {
          if (option.value === 'copy_url') {
            const ok = osc52Copy(api, url)
            api.ui.toast({
              message: ok
                ? 'Auth URL copied'
                : 'Copy unsupported — select the URL text manually',
              variant: ok ? 'success' : 'warning',
            })
            return
          }
          if (option.value === 'open') {
            try {
              openUrl(url)
            } catch {
              // best-effort
            }
            return
          }
          showL1()
        }}
      />
    ))
  }

  function startDeviceAdd(label: string | undefined) {
    const args = label ? `add --headless ${label}` : 'add --headless'
    void apply('openai-account', args).then((r) => {
      const verificationUrl = r.knobs.verificationUrl as string | undefined
      const userCode = r.knobs.userCode as string | undefined
      const instructions = r.knobs.instructions as string | undefined

      if (!verificationUrl) {
        api.ui.toast({
          message: 'Failed to get device code',
          variant: 'warning',
        })
        showL1()
        return
      }

      showDeviceCodeScreen(verificationUrl, userCode, instructions)
    })
  }

  function showDeviceCodeScreen(
    verificationUrl: string,
    userCode: string | undefined,
    _instructions: string | undefined,
  ) {
    const DialogSelectInner = api.ui.DialogSelect<string>
    api.ui.dialog.setSize('xlarge')
    api.ui.dialog.replace(() => (
      <DialogSelectInner
        title='Device code'
        options={[
          {
            title: userCode ? `Copy code: ${userCode}` : 'Copy code',
            value: 'copy_code',
            description: 'Copy the user code to clipboard',
          },
          {
            title: 'Copy URL',
            value: 'copy_url',
            description: verificationUrl,
          },
          {
            title: "Done / I've authorized",
            value: 'done',
            description: 'Return to account list',
          },
          {
            title: 'Cancel',
            value: 'cancel',
            description: 'Return to account list without adding',
          },
        ]}
        skipFilter={true}
        onSelect={(option) => {
          if (option.value === 'copy_code' && userCode) {
            const ok = osc52Copy(api, userCode)
            api.ui.toast({
              message: ok
                ? 'Code copied'
                : 'Copy unsupported — enter the code manually',
              variant: ok ? 'success' : 'warning',
            })
            return
          }
          if (option.value === 'copy_url') {
            const ok = osc52Copy(api, verificationUrl)
            api.ui.toast({
              message: ok
                ? 'URL copied'
                : 'Copy unsupported — enter the URL manually',
              variant: ok ? 'success' : 'warning',
            })
            return
          }
          showL1()
        }}
      />
    ))
  }

  void showL1()
}

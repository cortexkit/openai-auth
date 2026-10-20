import { describe, expect, test } from 'bun:test'
import { openUrl } from '@cortexkit/openai-auth-core/internal'
import { openBrowserForMenu } from '../auth/methods'

const oauthAuthorizeUrl =
  'https://auth.openai.com/oauth/authorize?client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&response_type=code&scope=openid%20profile%20email&code_challenge=challenge-value&code_challenge_method=S256&state=state-value'

function mockSpawn(pid: number | undefined) {
  const events: string[] = []
  const calls: unknown[][] = []
  let errorListener: (() => void) | undefined
  const spawn = (file: string, args: string[], options: unknown) => {
    calls.push([file, args, options])
    return {
      pid,
      on: (event: string, listener: () => void) => {
        events.push(`on:${event}`)
        if (event === 'error') errorListener = listener
      },
      unref: () => events.push('unref'),
    }
  }
  const emitError = () => {
    if (!errorListener) throw new Error('Unhandled error event')
    errorListener()
  }
  return { spawn, calls, events, emitError }
}

describe('browser opener', () => {
  test('uses a shell-free PowerShell command for a complete OAuth URL on Windows', () => {
    const { spawn, calls, events } = mockSpawn(4242)

    expect(openUrl(oauthAuthorizeUrl, 'win32', spawn)).toBe(true)

    const command = `Start-Process '${oauthAuthorizeUrl}'`
    const encodedCommand = Buffer.from(command, 'utf16le').toString('base64')
    expect(calls).toEqual([
      [
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-EncodedCommand',
          encodedCommand,
        ],
        { stdio: 'ignore', windowsHide: true },
      ],
    ])
    // Unreferenced, not awaited, and a late launch error is caught.
    expect(events).toEqual(['on:error', 'unref'])
    expect(Buffer.from(encodedCommand, 'base64').toString('utf16le')).toBe(
      command,
    )
    expect(command).toContain('&redirect_uri=')
    expect(command).toContain('%3A%2F%2F')
  })

  test('preserves quotes, percent escapes, ampersands, and spaces in URLs', () => {
    const url = `${oauthAuthorizeUrl}&note=it's 100% ready`
    const { spawn, calls } = mockSpawn(4242)

    expect(openBrowserForMenu(url, 'win32', spawn)).toBe(true)

    const args = calls[0]?.[1] as string[] | undefined
    expect(args?.[0]).toBe('-NoProfile')
    const encodedCommand = args?.[5]
    expect(encodedCommand).toBeString()
    const command = Buffer.from(encodedCommand!, 'base64').toString('utf16le')
    expect(command).toBe(`Start-Process '${url.replaceAll("'", "''")}'`)
    expect(
      command.slice("Start-Process '".length, -1).replaceAll("''", "'"),
    ).toBe(url)
  })

  test('returns false when a Windows browser launch fails', () => {
    expect(
      openUrl(oauthAuthorizeUrl, 'win32', () => {
        throw new Error('spawn unavailable')
      }),
    ).toBe(false)
    // Node reports an unstartable process with an undefined pid.
    expect(
      openUrl(oauthAuthorizeUrl, 'win32', mockSpawn(undefined).spawn),
    ).toBe(false)
  })

  test('launches open and xdg-open without waiting on macOS and Linux', () => {
    const mac = mockSpawn(4242)
    const linux = mockSpawn(4343)

    expect(openUrl('https://example.test/mac', 'darwin', mac.spawn)).toBe(true)
    expect(openUrl('https://example.test/linux', 'linux', linux.spawn)).toBe(
      true,
    )

    if (
      !mac.calls.some(([command]) => command === 'open') ||
      !linux.calls.some(([command]) => command === 'xdg-open')
    ) {
      throw new Error('macOS/Linux opener must launch asynchronously')
    }

    expect(mac.calls).toEqual([
      ['open', ['https://example.test/mac'], { stdio: 'ignore' }],
    ])
    expect(linux.calls).toEqual([
      ['xdg-open', ['https://example.test/linux'], { stdio: 'ignore' }],
    ])
    expect(mac.events).toEqual(['on:error', 'unref'])
    expect(linux.events).toEqual(['on:error', 'unref'])
  })

  test('returns false when a macOS or Linux browser launch fails', () => {
    expect(
      openUrl('https://example.test/mac', 'darwin', mockSpawn(undefined).spawn),
    ).toBe(false)
    expect(
      openUrl(
        'https://example.test/linux',
        'linux',
        mockSpawn(undefined).spawn,
      ),
    ).toBe(false)
    const failToSpawn = () => {
      throw new Error('spawn unavailable')
    }
    expect(openUrl('https://example.test/mac', 'darwin', failToSpawn)).toBe(
      false,
    )
    expect(openUrl('https://example.test/linux', 'linux', failToSpawn)).toBe(
      false,
    )
  })

  test('does not throw when a browser launch error arrives after return', () => {
    const opener = mockSpawn(4242)

    expect(openUrl('https://example.test/linux', 'linux', opener.spawn)).toBe(
      true,
    )
    try {
      opener.emitError()
    } catch {
      throw new Error('late browser launch errors must be handled')
    }
  })
})

import { describe, expect, mock, test } from 'bun:test'
import { openUrl } from '@cortexkit/openai-auth-core/internal'
import { openBrowserForMenu } from '../auth/methods'

const oauthAuthorizeUrl =
  'https://auth.openai.com/oauth/authorize?client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&response_type=code&scope=openid%20profile%20email&code_challenge=challenge-value&code_challenge_method=S256&state=state-value'

type MockExec = (
  file: string,
  args: string[],
  options: { stdio: 'ignore'; timeout: number },
) => unknown

const mockExec = () => mock((..._args: Parameters<MockExec>) => undefined)

// Windows must never wait on a synchronous opener: a cold PowerShell start
// can outlast any fixed timeout and get killed before the browser opens.
const noSyncOnWindows = () => {
  throw new Error('Windows must not wait on a synchronous opener')
}

function mockSpawn(pid: number | undefined = 4242) {
  const events: string[] = []
  const calls: unknown[][] = []
  const spawn = (file: string, args: string[], options: unknown) => {
    calls.push([file, args, options])
    return {
      pid,
      on: (event: string) => events.push(`on:${event}`),
      unref: () => events.push('unref'),
    }
  }
  return { spawn, calls, events }
}

describe('browser opener', () => {
  test('uses a shell-free PowerShell command for a complete OAuth URL on Windows', () => {
    const { spawn, calls, events } = mockSpawn()

    expect(openUrl(oauthAuthorizeUrl, 'win32', noSyncOnWindows, spawn)).toBe(
      true,
    )

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
    const { spawn, calls } = mockSpawn()

    expect(openBrowserForMenu(url, 'win32', noSyncOnWindows, spawn)).toBe(true)

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
      openUrl(oauthAuthorizeUrl, 'win32', noSyncOnWindows, () => {
        throw new Error('spawn unavailable')
      }),
    ).toBe(false)
    // Node reports an unstartable process with an undefined pid.
    expect(
      openUrl(
        oauthAuthorizeUrl,
        'win32',
        noSyncOnWindows,
        mockSpawn(undefined).spawn,
      ),
    ).toBe(false)
  })

  test('uses open on macOS and xdg-open elsewhere', () => {
    const execFileSync = mockExec()

    expect(openUrl('https://example.test/mac', 'darwin', execFileSync)).toBe(
      true,
    )
    expect(openUrl('https://example.test/linux', 'linux', execFileSync)).toBe(
      true,
    )

    expect(execFileSync).toHaveBeenCalledWith(
      'open',
      ['https://example.test/mac'],
      { stdio: 'ignore', timeout: 3000 },
    )
    expect(execFileSync).toHaveBeenCalledWith(
      'xdg-open',
      ['https://example.test/linux'],
      { stdio: 'ignore', timeout: 3000 },
    )
  })
})

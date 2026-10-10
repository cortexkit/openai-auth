import { describe, expect, mock, test } from 'bun:test'
import { openUrl } from '@cortexkit/openai-auth-core/internal'
import { openBrowserForMenu } from '../auth/methods'

const oauthAuthorizeUrl =
  'https://auth.openai.com/oauth/authorize?client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&response_type=code&scope=openid%20profile%20email&code_challenge=challenge-value&code_challenge_method=S256&state=state-value'

type MockExec = (
  file: string,
  args: string[],
  options: { stdio: 'ignore'; timeout: number; shell?: false },
) => unknown

const mockExec = () => mock((..._args: Parameters<MockExec>) => undefined)

describe('browser opener', () => {
  test('uses a shell-free PowerShell command for a complete OAuth URL on Windows', () => {
    const execFileSync = mockExec()

    expect(openUrl(oauthAuthorizeUrl, 'win32', execFileSync)).toBe(true)

    const command = `Start-Process '${oauthAuthorizeUrl}'`
    const encodedCommand = Buffer.from(command, 'utf16le').toString('base64')
    expect(execFileSync).toHaveBeenCalledWith(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-EncodedCommand',
        encodedCommand,
      ],
      { stdio: 'ignore', timeout: 3000, shell: false },
    )
    expect(Buffer.from(encodedCommand, 'base64').toString('utf16le')).toBe(
      command,
    )
    expect(command).toContain('&redirect_uri=')
    expect(command).toContain('%3A%2F%2F')
    expect(execFileSync.mock.calls[0]?.[1]).toHaveLength(6)
  })

  test('preserves quotes, percent escapes, ampersands, and spaces in URLs', () => {
    const url = `${oauthAuthorizeUrl}&note=it's 100% ready`
    const execFileSync = mockExec()

    expect(openBrowserForMenu(url, 'win32', execFileSync)).toBe(true)

    const args = execFileSync.mock.calls[0]?.[1]
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
    const execFileSync = mock((..._args: Parameters<MockExec>) => {
      throw new Error('browser unavailable')
    })

    expect(openUrl(oauthAuthorizeUrl, 'win32', execFileSync)).toBe(false)
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

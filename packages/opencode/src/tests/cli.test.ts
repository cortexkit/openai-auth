import { describe, expect, mock, test } from 'bun:test'

describe('CLI browser opener', () => {
  test('uses cmd /c start on Windows because start is a cmd.exe builtin', async () => {
    const execFileSync = mock(() => {})
    const { openBrowserForLogin } = await import('../cli')

    openBrowserForLogin('https://example.test/auth', 'win32', execFileSync)

    expect(execFileSync).toHaveBeenCalledWith(
      'cmd',
      ['/c', 'start', '', 'https://example.test/auth'],
      { stdio: 'ignore', timeout: 3000 },
    )
  })

  test('uses open on macOS and xdg-open elsewhere', async () => {
    const execFileSync = mock(() => {})
    const { openBrowserForLogin } = await import('../cli')

    openBrowserForLogin('https://example.test/mac', 'darwin', execFileSync)
    openBrowserForLogin('https://example.test/linux', 'linux', execFileSync)

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

import { describe, expect, mock, test } from 'bun:test'
import { openUrl } from '@cortexkit/openai-auth-core/internal'

describe('browser opener', () => {
  test('uses cmd /c start on Windows because start is a cmd.exe builtin', () => {
    const execFileSync = mock(() => {})

    openUrl('https://example.test/auth', 'win32', execFileSync)

    expect(execFileSync).toHaveBeenCalledWith(
      'cmd',
      ['/c', 'start', '', 'https://example.test/auth'],
      { stdio: 'ignore', timeout: 3000 },
    )
  })

  test('uses open on macOS and xdg-open elsewhere', () => {
    const execFileSync = mock(() => {})

    openUrl('https://example.test/mac', 'darwin', execFileSync)
    openUrl('https://example.test/linux', 'linux', execFileSync)

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

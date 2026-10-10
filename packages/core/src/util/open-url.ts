import { execFileSync as defaultExecFileSync } from 'node:child_process'

type BrowserExec = (
  file: string,
  args: string[],
  options: { stdio: 'ignore'; timeout: number; shell?: false },
) => unknown

export function openUrl(
  url: string,
  platform: NodeJS.Platform = process.platform,
  execFileSync: BrowserExec = defaultExecFileSync,
): boolean {
  try {
    if (platform === 'win32') {
      // Start-Process uses Windows' registered URL handler. The encoded script
      // keeps URL metacharacters out of cmd and preserves the URL as one string.
      const command = `Start-Process '${url.replaceAll("'", "''")}'`
      const encodedCommand = Buffer.from(command, 'utf16le').toString('base64')
      execFileSync(
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
      return true
    }

    execFileSync(platform === 'darwin' ? 'open' : 'xdg-open', [url], {
      stdio: 'ignore',
      timeout: 3000,
    })
    return true
  } catch {
    // Browser launch is best effort; the printed URL remains the fallback.
    return false
  }
}

import {
  execFileSync as defaultExecFileSync,
  spawn as defaultSpawn,
} from 'node:child_process'

type BrowserExec = (
  file: string,
  args: string[],
  options: { stdio: 'ignore'; timeout: number },
) => unknown

type BrowserSpawn = (
  file: string,
  args: string[],
  options: { stdio: 'ignore'; windowsHide: true },
) => {
  pid?: number
  unref(): void
  on(event: 'error', listener: () => void): unknown
}

export function openUrl(
  url: string,
  platform: NodeJS.Platform = process.platform,
  execFileSync: BrowserExec = defaultExecFileSync,
  spawn: BrowserSpawn = defaultSpawn,
): boolean {
  try {
    if (platform === 'win32') {
      // Start-Process uses Windows' registered URL handler. The encoded script
      // keeps URL metacharacters out of cmd and preserves the URL as one string.
      // PowerShell is launched without waiting for it: a cold Windows
      // PowerShell start took about 6 s on a Windows Server 2022 runner, and a
      // waiting caller with a short timeout killed it before the browser
      // opened. It is not detached: a detached PowerShell has no console and
      // never ran the command on any Windows runner.
      const command = `Start-Process '${url.replaceAll("'", "''")}'`
      const encodedCommand = Buffer.from(command, 'utf16le').toString('base64')
      const child = spawn(
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
      )
      // A failed launch reports asynchronously; without a listener it would
      // become an uncaught exception after this function has returned.
      child.on('error', () => {})
      child.unref()
      // Node leaves pid undefined when the process could not be started.
      return child.pid !== undefined
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

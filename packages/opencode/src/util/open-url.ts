import { execFileSync as defaultExecFileSync } from 'node:child_process'

type BrowserExec = (
  file: string,
  args: string[],
  options: { stdio: 'ignore'; timeout: number },
) => unknown

export function openUrl(
  url: string,
  platform: NodeJS.Platform = process.platform,
  execFileSync: BrowserExec = defaultExecFileSync,
) {
  try {
    if (platform === 'win32') {
      execFileSync('cmd', ['/c', 'start', '', url], {
        stdio: 'ignore',
        timeout: 3000,
      })
      return
    }

    execFileSync(platform === 'darwin' ? 'open' : 'xdg-open', [url], {
      stdio: 'ignore',
      timeout: 3000,
    })
  } catch {
    // Browser launch is best effort; the printed URL remains the fallback.
  }
}

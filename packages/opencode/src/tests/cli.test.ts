import { describe, expect, mock, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadAccounts,
  saveAccounts,
  withAccountStoreTransaction,
} from '../core/accounts.ts'

const packageRoot = fileURLToPath(new URL('../../', import.meta.url))

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

describe('CLI login guardrails', () => {
  test('rejects the reserved main label before starting OAuth', () => {
    const result = spawnSync(
      process.execPath,
      ['src/cli.ts', 'login', '--label', 'MaIn'],
      {
        cwd: packageRoot,
        encoding: 'utf8',
      },
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      '"main" is a reserved account id; choose a different label.',
    )
  })

  test('refuses a completed CLI login under Claustrum before writing credentials', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'oai-cli-claustrum-'))
    const path = join(directory, 'accounts.json')
    const errors: string[] = []
    try {
      await saveAccounts({ version: 1, accounts: [] }, path)
      await withAccountStoreTransaction(async (transaction) => {
        await transaction.writeMode('claustrum')
      }, path)

      const { runCli } = await import('../cli.ts')
      const code = await runCli(['login', '--headless'], {
        beginAccountLogin: async () => ({
          url: 'https://example.test/login',
          instructions: 'complete login',
          completion: Promise.resolve({
            id: 'fallback-new',
            type: 'oauth' as const,
            access: 'access',
            refresh: 'refresh',
            expires: 1,
            enabled: true,
            addedAt: 1,
            lastUsed: 1,
            lastRefreshedAt: 1,
          }),
        }),
        getAccountStoragePath: () => path,
        openUrl: () => {},
        error: (message) => errors.push(message),
        log: () => {},
      })

      expect(code).toBe(1)
      expect(errors).toContain(
        '\nError: Claustrum mode is active. Run /openai-account local before adding a fallback account.',
      )
      expect((await loadAccounts(path))?.accounts).toEqual([])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

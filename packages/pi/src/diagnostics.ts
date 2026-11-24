import { dirname, join } from 'node:path'
import {
  type AccountPaths,
  type CodexDumpInput,
  createCodexDumps,
  createLogger,
  DEFAULT_DUMP_MAX_BYTES,
  setupLogger,
} from '@cortexkit/openai-auth-core/internal'

const log = createLogger('pi-dump')

export function setupPiLogger(paths: AccountPaths): void {
  setupLogger({ file: join(dirname(paths.statePath), 'pi-openai-auth.log') })
}

export function createPiDumps(
  paths: () => AccountPaths,
  view: () =>
    | {
        dump?: { enabled?: boolean }
        dumpDir?: string
        dumpMaxBytes?: number
      }
    | undefined,
) {
  const dumper = createCodexDumps({
    enabled: () => view()?.dump?.enabled === true,
    dir: () =>
      view()?.dumpDir ||
      join(dirname(paths().statePath), 'pi-openai-auth-dumps'),
    maxBytes: () => view()?.dumpMaxBytes ?? DEFAULT_DUMP_MAX_BYTES,
  })
  return (input: CodexDumpInput, token: string) => {
    const { bodyText } = input
    // The diagnostic sink must not delay or fail a foreground request.
    void dumper
      .dumpCodexRequest({
        ...input,
        bodyText: () => {
          let text = typeof bodyText === 'string' ? bodyText : bodyText()
          const account = new Headers(input.headers).get('chatgpt-account-id')
          for (const secret of [token, account]) {
            if (secret)
              text = text.replaceAll(
                JSON.stringify(secret).slice(1, -1),
                '[credential]',
              )
          }
          return text
        },
      })
      .catch(() => log.warn('request dump failed'))
  }
}

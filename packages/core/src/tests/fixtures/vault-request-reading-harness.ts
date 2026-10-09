import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flushForTest, initLogger, resetLoggerForTest } from '../../logger.ts'
import { OpenAiVault } from '../../vault.ts'

const dir = mkdtempSync(join(tmpdir(), 'vault-request-reading-'))
const logFile = join(dir, 'vault.log')
const routeId = 'route-with-failed-poll'
const unhandled: string[] = []
const onUnhandled = (error: unknown) => {
  unhandled.push(error instanceof Error ? error.message : String(error))
}
let pollCalls = 0

process.on('unhandledRejection', onUnhandled)
initLogger({ file: logFile, level: 'debug' })

const vault = new OpenAiVault({
  host: 'opencode',
  stateDir: join(dir, 'vault-state'),
  fetchImpl: () => {
    pollCalls += 1
    throw new Error('quota poll setup failed')
  },
})

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

try {
  // The configured fetch factory runs before pollQuota's send catch and can
  // throw synchronously, making pollQuota's returned promise reject.
  vault.requestReading(routeId)
  vault.requestReading(routeId)
  await nextTurn()
  vault.requestReading(routeId)
  await nextTurn()
  await nextTurn()
  await flushForTest()

  const warnings = existsSync(logFile)
    ? readFileSync(logFile, 'utf8')
        .split('\n')
        .filter((line) => line.includes('vault quota poll failed'))
    : []
  console.log(JSON.stringify({ unhandled, pollCalls, warnings }))
} finally {
  process.off('unhandledRejection', onUnhandled)
  vault.close()
  resetLoggerForTest()
  rmSync(dir, { recursive: true, force: true })
}

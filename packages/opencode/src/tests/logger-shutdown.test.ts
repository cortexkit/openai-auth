import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const logger = join(import.meta.dir, '../logger.ts')

function probe(source: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' }
  delete env.OPENCODE_OPENAI_AUTH_LOG_FILE
  return spawnSync(process.execPath, ['--eval', source], {
    cwd: join(import.meta.dir, '../..'),
    env,
    encoding: 'utf8',
    timeout: 10_000,
  })
}

test('shutdown awaits an asynchronous Windows log drain', () => {
  const result = probe(`
    import { mock } from 'bun:test';
    Object.defineProperty(process, 'platform', { value: 'win32' });
    let drained = false;
    mock.module('@cortexkit/openai-auth-core/tui-support', () => ({
      initLogger() {},
      async flushLogs() {
        await new Promise(resolve => setTimeout(resolve, 25));
        drained = true;
      },
      createLogger() {}, flushForTest() {}, redact() {}, redactStrings() {}, setLogLevel() {},
    }));
    await import(${JSON.stringify(logger)});
    const hook = process.listeners('beforeExit').at(-1);
    process.removeAllListeners('beforeExit');
    const pending = hook(0);
    const wasPending = !drained;
    await pending;
    console.log(JSON.stringify({ wasPending, drained, async: pending instanceof Promise }));
  `)
  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')
  expect(JSON.parse(result.stdout)).toEqual({
    wasPending: true,
    drained: true,
    async: true,
  })
})

test('log defaults isolate Windows files and preserve the POSIX destination', () => {
  for (const platform of ['win32', 'linux']) {
    const result = probe(`
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      Object.defineProperty(process, 'platform', { value: '${platform}' });
      const { getLogFile } = await import(${JSON.stringify(logger)});
      const expected = ${platform === 'win32' ? "join(tmpdir(), 'opencode-openai-auth', 'opencode-openai-auth.log')" : "join(tmpdir(), 'opencode-openai-auth.log')"};
      console.log(getLogFile() === expected ? 'correct' : getLogFile());
      process.env.OPENCODE_OPENAI_AUTH_LOG_FILE = 'operator-managed.log';
      console.log(getLogFile());
    `)
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout.trim().split('\n')).toEqual([
      'correct',
      'operator-managed.log',
    ])
  }
})

test('refused Windows log writes cannot escape callers and warn only once at shutdown', () => {
  const result = probe(`
    import { mock } from 'bun:test';
    Object.defineProperty(process, 'platform', { value: 'win32' });
    let refusals = 0;
    // Each write attempt is refused at its first private-files call: the
    // parent-folder check, or the owner-only create when that check passes.
    mock.module('@cortexkit/private-files', () => ({
      PrivateFilesUnavailableError: class PrivateFilesUnavailableError extends Error {},
      async verifyPrivatePath() {
        // The native preflight probes a missing path before any real log write.
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      },
      async verifySafeParent(path) {
        refusals++;
        return { ok: false, reason: 'writable-by-others', path };
      },
      async createOwnerOnly() {
        refusals++;
        throw Object.assign(new Error('refused'), { code: 'EACCES' });
      },
    }));
    const { createLogger } = await import(${JSON.stringify(logger)});
    const log = createLogger('refusal-probe');
    for (let i = 0; i < 100; i++) log.info('dropped line');
    await new Promise(resolve => setTimeout(resolve, 50));
    log.info('timer-flushed dropped line');
    await new Promise(resolve => setTimeout(resolve, 550));
    console.log(JSON.stringify({ callersCompleted: true, refusals }));
  `)
  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({
    callersCompleted: true,
    refusals: 3,
  })
  expect(
    result.stderr.match(
      /OpenAI auth could not flush its log file at shutdown/g,
    ),
  ).toHaveLength(1)
  expect(result.stderr).not.toContain('Unhandled')
})

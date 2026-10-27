import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireRefreshFileLock } from '@cortexkit/common-auth/fs'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import type { CodexSessionMetadata } from '../codex-request'
import { loadCodexSessions, saveCodexSessions } from '../codex-sessions'
import { acquireCodexSessions, CodexSessionStore } from '../v2/codex-sessions'
import { CodexHttpState } from '../v2/codex-wire'
import { opencode1HostSlot } from '../v2/host-slot'
import { setupOpenAIAuth } from '../v2/setup'
import {
  fakeOpenCode2Host,
  poolFiles,
  scope,
  seedPool,
} from './fixtures/opencode2-host'
import type { SentRequest, SessionStep } from './fixtures/opencode2-sessions'

const OPENCODE1_FILE = 'openai-auth-sessions.json'
const OPENCODE2_FILE = 'openai-auth-sessions-opencode2.json'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'oai-oc2-sessions-'))
  roots.push(dir)
  return dir
}

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'))

const threadsOf = (store: CodexSessionStore) =>
  Object.fromEntries(
    [...store.sessions].map(([id, metadata]) => [id, metadata.threadID]),
  )

describe('Codex session file helpers', () => {
  test('OpenCode 1 save writes the whole map at the given path and load mints fresh turn ids', async () => {
    const path = join(tempDir(), 'nested', OPENCODE1_FILE)
    const sessions = new Map<string, CodexSessionMetadata>([
      [
        'ses_a',
        { threadID: 'thread-a', turnID: 'turn-a', windowID: 'thread-a:0' },
      ],
      [
        'ses_b',
        { threadID: 'thread-b', turnID: 'turn-b', windowID: 'thread-b:0' },
      ],
    ])
    await saveCodexSessions(path, sessions)
    // The exact bytes OpenCode 1 has always written.
    expect(readFileSync(path, 'utf8')).toBe(
      '{\n  "version": 1,\n  "sessions": {\n    "ses_a": {\n      "threadID": "thread-a"\n    },\n    "ses_b": {\n      "threadID": "thread-b"\n    }\n  }\n}\n',
    )
    let n = 0
    const loaded = loadCodexSessions(path, () => `fresh-${++n}`)
    expect([...loaded]).toEqual([
      [
        'ses_a',
        { threadID: 'thread-a', turnID: 'fresh-1', windowID: 'thread-a:0' },
      ],
      [
        'ses_b',
        { threadID: 'thread-b', turnID: 'fresh-2', windowID: 'thread-b:0' },
      ],
    ])
    expect(loadCodexSessions(join(tempDir(), 'missing.json')).size).toBe(0)
  })

  test("OpenCode 1 save waits for the file's sessions lock and writes it owner-only", async () => {
    const path = join(tempDir(), OPENCODE1_FILE)
    const held = await acquireRefreshFileLock({
      name: 'sessions',
      path,
      ttlMs: 10_000,
    })
    expect(held).not.toBeNull()
    const sessions = new Map<string, CodexSessionMetadata>([
      [
        'ses_a',
        { threadID: 'thread-a', turnID: 'turn-a', windowID: 'thread-a:0' },
      ],
    ])
    const saving = saveCodexSessions(path, sessions)
    await Bun.sleep(200)
    // Nothing is written while another writer (or the runtime-file move)
    // holds the lock.
    expect(existsSync(path)).toBe(false)
    await held?.release()
    await saving
    expect(readJson(path).sessions).toEqual({ ses_a: { threadID: 'thread-a' } })
    if (process.platform !== 'win32')
      expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})

describe('OpenCode 2 session store', () => {
  test('writes exactly version and thread ids, never turn ids or history', async () => {
    const path = join(tempDir(), OPENCODE2_FILE)
    const store = new CodexSessionStore(path)
    const a = store.get('ses_a')
    a.input = [{ role: 'user', content: 'secret prompt' }]
    store.get('ses_b')
    await store.settled()
    expect(readJson(path)).toEqual({
      version: 1,
      sessions: {
        ses_a: { threadID: a.threadID },
        ses_b: { threadID: store.get('ses_b').threadID },
      },
    })
  })

  test('the registry loads each path once and shares the map', async () => {
    const path = join(tempDir(), OPENCODE2_FILE)
    writeFileSync(
      path,
      JSON.stringify({ version: 1, sessions: { ses_a: { threadID: 't-a' } } }),
    )
    const first = acquireCodexSessions(path)
    const turn = first.get('ses_a').turnID
    writeFileSync(path, JSON.stringify({ version: 1, sessions: {} }))
    const second = acquireCodexSessions(join(path, '..', OPENCODE2_FILE))
    expect(second).toBe(first)
    expect(second.get('ses_a')).toEqual({
      threadID: 't-a',
      turnID: turn,
      windowID: 't-a:0',
    })
  })

  test('paused writers each commit a disjoint addition and both survive', async () => {
    const path = join(tempDir(), OPENCODE2_FILE)
    let releaseA!: () => void
    let pausedA!: () => void
    const aPaused = new Promise<void>((done) => {
      pausedA = done
    })
    const order: string[] = []
    // No save delay: B must start its save while A holds the lock.
    const a = new CodexSessionStore(path, {
      saveDelayMs: 0,
      afterRead: async () => {
        order.push('a read')
        pausedA()
        await new Promise<void>((done) => {
          releaseA = done
        })
      },
    })
    const b = new CodexSessionStore(path, {
      saveDelayMs: 0,
      afterRead: async () => {
        order.push('b read')
      },
    })
    const threadA = a.get('ses_a').threadID
    await aPaused
    const threadB = b.get('ses_b').threadID
    // B waits for A's lock instead of reading the file A is about to replace.
    await new Promise((done) => setTimeout(done, 100))
    expect(order).toEqual(['a read'])
    releaseA()
    await Promise.all([a.settled(), b.settled()])
    expect(order).toEqual(['a read', 'b read'])
    const restarted = new CodexSessionStore(path)
    expect(threadsOf(restarted)).toEqual({ ses_a: threadA, ses_b: threadB })
  })

  test('a stale writer does not resurrect a session another process deleted', async () => {
    const path = join(tempDir(), OPENCODE2_FILE)
    const a = new CodexSessionStore(path)
    const kept = a.get('ses_keep').threadID
    a.get('ses_gone')
    await a.settled()
    const b = new CodexSessionStore(path)
    expect(b.sessions.has('ses_gone')).toBe(true)
    a.delete('ses_gone')
    await a.settled()
    const added = b.get('ses_new').threadID
    await b.settled()
    const restarted = new CodexSessionStore(path)
    expect(threadsOf(restarted)).toEqual({ ses_keep: kept, ses_new: added })
  })

  test('a session id reused after deletion gets a new thread id', async () => {
    const path = join(tempDir(), OPENCODE2_FILE)
    const store = new CodexSessionStore(path)
    const before = store.get('ses_a').threadID
    await store.settled()
    store.delete('ses_a')
    const after = store.get('ses_a').threadID
    expect(after).not.toBe(before)
    await store.settled()
    expect(threadsOf(new CodexSessionStore(path))).toEqual({ ses_a: after })
  })

  test('a lock timeout keeps the changes for the next save', async () => {
    const path = join(tempDir(), OPENCODE2_FILE)
    const held = await acquireRefreshFileLock({
      name: 'sessions',
      path,
      ttlMs: 60_000,
    })
    expect(held).not.toBeNull()
    const store = new CodexSessionStore(path, { lockWaitMs: 50 })
    const thread = store.get('ses_a').threadID
    await store.settled()
    expect(() => readFileSync(path)).toThrow()
    await held?.release()
    await store.save()
    expect(readJson(path).sessions).toEqual({ ses_a: { threadID: thread } })
  })

  test('deleting a session the store never knew takes no lock and leaves the file alone', async () => {
    const path = join(tempDir(), OPENCODE2_FILE)
    const writer = new CodexSessionStore(path)
    const thread = writer.get('ses_a').threadID
    await writer.settled()
    const bytes = readFileSync(path, 'utf8')
    const before = statSync(path)
    // While another writer holds the lock, a save that tried to take it would
    // wait the whole 30 s lock wait instead of settling.
    const held = await acquireRefreshFileLock({
      name: 'sessions',
      path,
      ttlMs: 60_000,
    })
    expect(held).not.toBeNull()
    const store = new CodexSessionStore(path, {
      lockWaitMs: 30_000,
      saveDelayMs: 10,
    })
    store.delete('ses_never_used_openai')
    const outcome = await Promise.race([
      Bun.sleep(50).then(() => store.settled().then(() => 'settled')),
      Bun.sleep(1_000).then(() => 'waited for the lock'),
    ])
    await held?.release()
    await store.settled()
    expect(outcome).toBe('settled')
    expect(readFileSync(path, 'utf8')).toBe(bytes)
    const after = statSync(path)
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs])
    expect(threadsOf(new CodexSessionStore(path))).toEqual({ ses_a: thread })
  })

  test('deleting a session another process saved after this one loaded removes it', async () => {
    const path = join(tempDir(), OPENCODE2_FILE)
    const late = new CodexSessionStore(path)
    const writer = new CodexSessionStore(path)
    const kept = writer.get('ses_keep').threadID
    writer.get('ses_gone')
    await writer.settled()
    expect(late.sessions.has('ses_gone')).toBe(false)
    late.delete('ses_gone')
    await late.settled()
    expect(threadsOf(new CodexSessionStore(path))).toEqual({ ses_keep: kept })
  })

  test('a save whose merged sessions match the file re-reads it under the lock and does not replace it', async () => {
    const path = join(tempDir(), OPENCODE2_FILE)
    const a = new CodexSessionStore(path)
    const kept = a.get('ses_keep').threadID
    a.get('ses_gone')
    await a.settled()
    let reads = 0
    const b = new CodexSessionStore(path, {
      afterRead: async () => {
        reads++
      },
    })
    expect(b.sessions.has('ses_gone')).toBe(true)
    a.delete('ses_gone')
    await a.settled()
    const bytes = readFileSync(path, 'utf8')
    const before = statSync(path)
    // B still holds the session, so it records the deletion; the file it
    // re-reads under the lock no longer has it, so there is nothing to write.
    b.delete('ses_gone')
    await b.settled()
    expect(reads).toBe(1)
    expect(readFileSync(path, 'utf8')).toBe(bytes)
    const after = statSync(path)
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs])
    expect(threadsOf(new CodexSessionStore(path))).toEqual({ ses_keep: kept })
  })

  test('five sessions starting within the save delay are saved in one write', async () => {
    const path = join(tempDir(), OPENCODE2_FILE)
    let writes = 0
    const store = new CodexSessionStore(path, {
      saveDelayMs: 300,
      afterRead: async () => {
        writes++
      },
    })
    const ids = ['ses_1', 'ses_2', 'ses_3', 'ses_4', 'ses_5']
    for (const id of ids) {
      store.get(id)
      await Bun.sleep(20)
    }
    // Let the delayed save run on its own rather than flushing it.
    await Bun.sleep(600)
    await store.settled()
    expect(writes).toBe(1)
    expect(Object.keys(readJson(path).sessions).sort()).toEqual(ids)
  })

  test('stopping the plugin saves a session whose delayed save is still pending', async () => {
    const files = poolFiles(tempDir())
    seedPool(files, 'main-first', [{ id: 'main' }])
    const path = join(files.dir, OPENCODE2_FILE)
    const store = new CodexSessionStore(path, { saveDelayMs: 60_000 })
    const host = fakeOpenCode2Host()
    const offline = (async () => {
      throw new Error('offline in tests')
    }) as unknown as typeof fetch
    const stop = await setupOpenAIAuth(host.ctx, {
      codex: new CodexHttpState(undefined, undefined, store),
      paths: files.paths,
      sidebarStateFile: join(files.dir, 'sidebar.json'),
      slot: opencode1HostSlot(join(files.dir, 'auth.json')),
      fence: async () => ({ open: true }),
      heartbeat: false,
      fetch: offline,
    })
    const draft = {
      ...scope('ses_1'),
      request: new Request('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${placeholderSecret('openai')}`,
          'content-type': 'application/json',
          'session-id': 'ses_1',
        },
        body: JSON.stringify({
          model: 'gpt-5.5',
          stream: true,
          input: [
            { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
          ],
        }),
      }),
    }
    await host.fire('http.request', draft)
    const thread = draft.request.headers.get('thread-id')
    expect(thread).toBe(store.sessions.get('ses_1')?.threadID as string)
    expect(existsSync(path)).toBe(false)
    const started = performance.now()
    await stop?.()
    expect(performance.now() - started).toBeLessThan(5_000)
    expect(readJson(path).sessions).toEqual({ ses_1: { threadID: thread } })
  })
})

function runProcess(
  root: string,
  configDir: string,
  locations: number,
  steps: SessionStep[],
) {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const key of [
    'HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_CACHE_HOME',
    'XDG_RUNTIME_DIR',
  ]) {
    env[key] = join(root, key)
    mkdirSync(env[key] as string, { recursive: true })
  }
  Object.assign(env, {
    NODE_ENV: 'test',
    OPENCODE_CONFIG_DIR: configDir,
    OPENCODE_OPENAI_AUTH_FILE: join(root, 'openai-auth.json'),
    OPENCODE_OPENAI_AUTH_STATE_FILE: join(root, 'openai-auth-state.json'),
    OPENCODE_OPENAI_AUTH_LOG_FILE: join(root, 'plugin.log'),
    OPENCODE_OPENAI_AUTH_MODELS_CACHE: join(root, 'models.json'),
    OPENCODE_OPENAI_AUTH_SIDEBAR_STATE_FILE: join(root, 'sidebar.json'),
    CLAUSTRUM_SUBC_CONNECTION: join(root, 'no-vault.json'),
  })
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(
        new URL('./fixtures/opencode2-sessions.ts', import.meta.url),
      ),
      root,
      String(locations),
      JSON.stringify(steps),
    ],
    { env, stdout: 'pipe', stderr: 'pipe' },
  )
  return (async () => {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
    return JSON.parse(stdout) as SentRequest[]
  })()
}

function serverFixture() {
  const files = poolFiles(tempDir())
  seedPool(files, 'main-first', [{ id: 'main' }])
  const configDir = join(files.dir, 'config')
  mkdirSync(configDir, { recursive: true })
  return { root: files.dir, configDir }
}

const send = (location: number, session: string): SessionStep => ({
  op: 'send',
  location,
  session,
})

describe('OpenCode 2 sessions across locations and restarts', () => {
  test('thread id and prompt_cache_key survive a restart with a fresh turn id; locations remint none', async () => {
    const { root, configDir } = serverFixture()
    const first = await runProcess(root, configDir, 2, [
      send(0, 'ses_1'),
      send(1, 'ses_1'),
      { op: 'reload', location: 0 },
      send(0, 'ses_1'),
    ])
    const [opened, secondLocation, reloaded] = first
    expect(opened?.threadID).toEqual(expect.any(String))
    expect(opened?.sessionHeader).toBe(opened?.threadID as string)
    expect(opened?.cacheKey).toBe(opened?.threadID)
    // A second location and a location reload share the process's map: same
    // thread, and the unchanged conversation is still the same turn.
    for (const later of [secondLocation, reloaded]) {
      expect(later?.threadID).toBe(opened?.threadID as string)
      expect(later?.turnID).toBe(opened?.turnID as string)
    }
    expect(readJson(join(configDir, OPENCODE2_FILE))).toEqual({
      version: 1,
      sessions: { ses_1: { threadID: opened?.threadID } },
    })
    const [restarted] = await runProcess(root, configDir, 1, [send(0, 'ses_1')])
    expect(restarted?.threadID).toBe(opened?.threadID as string)
    expect(restarted?.cacheKey).toBe(opened?.threadID)
    expect(restarted?.turnID).toEqual(expect.any(String))
    expect(restarted?.turnID).not.toBe(opened?.turnID as string)
  })

  test('OpenCode 2 processes leave OpenCode 1 sessions unchanged and keep every thread id', async () => {
    const { root, configDir } = serverFixture()
    const opencode1 = join(configDir, OPENCODE1_FILE)
    const seeded = `${JSON.stringify(
      { version: 1, sessions: { ses_1: { threadID: 'opencode1-thread' } } },
      null,
      2,
    )}\n`
    writeFileSync(opencode1, seeded)
    const [one, two] = await Promise.all([
      runProcess(root, configDir, 2, [
        send(0, 'ses_1'),
        send(1, 'ses_2'),
        { op: 'reload', location: 0 },
        send(0, 'ses_3'),
        send(1, 'ses_gone'),
        { op: 'delete', location: 1, session: 'ses_gone' },
      ]),
      runProcess(root, configDir, 1, [send(0, 'ses_4'), send(0, 'ses_5')]),
    ])
    const created = [...(one ?? []), ...(two ?? [])].filter(
      (sent) => sent.session !== 'ses_gone',
    )
    expect(created.map((sent) => sent.session).sort()).toEqual([
      'ses_1',
      'ses_2',
      'ses_3',
      'ses_4',
      'ses_5',
    ])
    expect(created.find((sent) => sent.session === 'ses_1')?.threadID).not.toBe(
      'opencode1-thread',
    )
    const restarted = await runProcess(
      root,
      configDir,
      1,
      created.map((sent) => send(0, sent.session)),
    )
    expect(
      Object.fromEntries(
        restarted.map((sent) => [sent.session, sent.threadID]),
      ),
    ).toEqual(
      Object.fromEntries(created.map((sent) => [sent.session, sent.threadID])),
    )
    expect(
      readJson(join(configDir, OPENCODE2_FILE)).sessions,
    ).not.toHaveProperty('ses_gone')
    expect(readFileSync(opencode1, 'utf8')).toBe(seeded)
  })
})

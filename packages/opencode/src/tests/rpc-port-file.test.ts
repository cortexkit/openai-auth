import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverPortFile, writePortFile } from '../rpc/port-file'

let dir: string
const childProcesses: Array<ReturnType<typeof Bun.spawn>> = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oa-rpc-'))
})
afterEach(async () => {
  for (const child of childProcesses.splice(0)) {
    child.kill()
    await child.exited.catch(() => {})
  }
  await rm(dir, { recursive: true, force: true })
})

function spawnLivePid(): number {
  const child = Bun.spawn(['sleep', '30'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  childProcesses.push(child)
  return child.pid
}

describe('port-file', () => {
  test('writePortFile then discover returns the entry for a live pid', async () => {
    await writePortFile(dir, { port: 5123, token: 'tok', pid: process.pid })
    const found = await discoverPortFile(dir)
    expect(found?.port).toBe(5123)
    expect(found?.token).toBe('tok')
  })

  test('discover ignores dead pids', async () => {
    await writeFile(
      join(dir, 'port-99999999.json'),
      JSON.stringify({ port: 1, token: 'x', pid: 99999999, startedAt: 1 }),
      'utf8',
    )
    expect(await discoverPortFile(dir)).toBeNull()
  })

  test('discover picks the newest startedAt among live entries', async () => {
    await writePortFile(dir, { port: 1, token: 'a', pid: process.pid })
    await new Promise((r) => setTimeout(r, 5))
    await writePortFile(dir, { port: 2, token: 'b', pid: process.pid })
    expect((await discoverPortFile(dir))?.port).toBe(2)
  })

  test('discover returns live entry matching the expected pid instead of newer live entry', async () => {
    const expectedPid = spawnLivePid()
    await writeFile(
      join(dir, 'port-expected.json'),
      JSON.stringify({
        port: 1,
        token: 'expected',
        pid: expectedPid,
        startedAt: 1,
      }),
      'utf8',
    )
    await writeFile(
      join(dir, 'port-newer-other.json'),
      JSON.stringify({
        port: 2,
        token: 'newer-other',
        pid: process.pid,
        startedAt: 3,
      }),
      'utf8',
    )

    const found = await discoverPortFile(dir, expectedPid)
    expect(found?.port).toBe(1)
    expect(found?.pid).toBe(expectedPid)
    expect(found?.token).toBe('expected')
  })

  test('discover falls back to newest live entry when expected pid matches none', async () => {
    await writeFile(
      join(dir, 'port-older.json'),
      JSON.stringify({
        port: 1,
        token: 'older',
        pid: process.pid,
        startedAt: 1,
      }),
      'utf8',
    )
    await writeFile(
      join(dir, 'port-newer.json'),
      JSON.stringify({
        port: 2,
        token: 'newer',
        pid: process.pid,
        startedAt: 2,
      }),
      'utf8',
    )

    const found = await discoverPortFile(dir, 99999999)
    expect(found?.port).toBe(2)
    expect(found?.token).toBe('newer')
  })

  test('discover still picks newest live entry when expected pid is undefined', async () => {
    await writeFile(
      join(dir, 'port-older.json'),
      JSON.stringify({
        port: 1,
        token: 'older',
        pid: process.pid,
        startedAt: 1,
      }),
      'utf8',
    )
    await writeFile(
      join(dir, 'port-newer.json'),
      JSON.stringify({
        port: 2,
        token: 'newer',
        pid: process.pid,
        startedAt: 2,
      }),
      'utf8',
    )

    const found = await discoverPortFile(dir)
    expect(found?.port).toBe(2)
    expect(found?.token).toBe('newer')
  })

  test('discover never returns a dead pid even when it matches expected pid', async () => {
    await writeFile(
      join(dir, 'port-live.json'),
      JSON.stringify({
        port: 1,
        token: 'live',
        pid: process.pid,
        startedAt: 1,
      }),
      'utf8',
    )
    await writeFile(
      join(dir, 'port-dead.json'),
      JSON.stringify({
        port: 2,
        token: 'dead',
        pid: 99999999,
        startedAt: 2,
      }),
      'utf8',
    )

    const found = await discoverPortFile(dir, 99999999)
    expect(found?.port).toBe(1)
    expect(found?.pid).toBe(process.pid)
    expect(found?.token).toBe('live')
  })

  test('writePortFile keeps the liveness pid available for matching', async () => {
    await writePortFile(dir, {
      port: 1,
      token: 'matched',
      pid: process.pid,
    })
    await writeFile(
      join(dir, 'port-newer-other.json'),
      JSON.stringify({
        port: 2,
        token: 'other',
        pid: spawnLivePid(),
        startedAt: Date.now() + 1,
      }),
      'utf8',
    )

    const matched = await discoverPortFile(dir, process.pid)
    expect(matched?.port).toBe(1)
    expect(matched?.pid).toBe(process.pid)

    const fallback = await discoverPortFile(dir, 99999999)
    expect(fallback?.port).toBe(2)
    expect(fallback?.token).toBe('other')
  })
})

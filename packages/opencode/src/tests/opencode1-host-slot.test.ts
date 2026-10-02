// OpenCode 1's login slot as the plugin inside OpenCode 1 reads it: straight
// from `auth.json` in OpenCode 1's data directory, with OpenCode 1's own read
// rules, and written through the plugin client's `auth.set`.

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  confirmMainAuthSlot,
  opencode1ClientSlot,
  opencode1SlotForClient,
  opencodeAuthPath,
  readOpencodeAuthMap,
} from '../core/host-slot'
import { opencode1AuthPath } from '../v2/host-slot'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

/** A data directory of its own, with `auth.json` holding `content` if given. */
function dataDir(content?: string) {
  const root = mkdtempSync(join(tmpdir(), 'oai-oc1-slot-'))
  dirs.push(root)
  const env = { XDG_DATA_HOME: join(root, 'data') }
  const path = opencodeAuthPath(env)
  mkdirSync(join(root, 'data', 'opencode'), { recursive: true })
  if (content !== undefined) writeFileSync(path, content)
  return { root, env, path }
}

const LOGIN = {
  type: 'oauth',
  access: 'access-1',
  refresh: 'refresh-1',
  expires: 1_900_000_000_000,
}

describe('where OpenCode 1 keeps its logins', () => {
  it('is auth.json in $XDG_DATA_HOME/opencode', () => {
    expect(opencodeAuthPath({ XDG_DATA_HOME: '/x/data' }, '/home/u')).toBe(
      '/x/data/opencode/auth.json',
    )
  })

  it('is under ~/.local/share when XDG_DATA_HOME is unset or empty', () => {
    expect(opencodeAuthPath({}, '/home/u')).toBe(
      '/home/u/.local/share/opencode/auth.json',
    )
    expect(opencodeAuthPath({ XDG_DATA_HOME: '' }, '/home/u')).toBe(
      '/home/u/.local/share/opencode/auth.json',
    )
  })

  it('is the same file the OpenCode 2 entry reads', () => {
    expect(opencode1AuthPath({ XDG_DATA_HOME: '/x/data' })).toBe(
      opencodeAuthPath({ XDG_DATA_HOME: '/x/data' }),
    )
  })
})

describe('reading the logins', () => {
  it('reads the file afresh on every call', async () => {
    const { env, path } = dataDir(JSON.stringify({ openai: LOGIN }))
    const slot = opencode1ClientSlot({ set: async () => ({}), env })
    expect(await slot.get({ path: { id: 'openai' } })).toEqual(LOGIN)
    const next = { ...LOGIN, refresh: 'refresh-2' }
    writeFileSync(path, JSON.stringify({ openai: next }))
    expect(await slot.get({ path: { id: 'openai' } })).toEqual(next)
    expect(await slot.all()).toEqual({ openai: next })
  })

  it('reads a torn, missing or non-object file as no logins', async () => {
    for (const content of [
      '{"openai": {"type": "oauth", "acc',
      '',
      '[1, 2]',
      'null',
      undefined,
    ]) {
      const { env } = dataDir(content)
      const slot = opencode1ClientSlot({ set: async () => ({}), env })
      expect(await slot.all()).toEqual({})
      expect(await slot.get({ path: { id: 'openai' } })).toBeUndefined()
    }
  })

  it('leaves out the entries OpenCode 1 would not take for a login', async () => {
    const api = { type: 'api', key: 'sk-1' }
    const wellknown = { type: 'wellknown', key: 'k', token: 't' }
    const { path } = dataDir(
      JSON.stringify({
        openai: LOGIN,
        anthropic: api,
        known: wellknown,
        noExpiry: { type: 'oauth', access: 'a', refresh: 'r' },
        fraction: { ...LOGIN, expires: 1.5 },
        negative: { ...LOGIN, expires: -1 },
        nullAccount: { ...LOGIN, accountId: null },
        badMetadata: { ...api, metadata: { a: 1 } },
        unknownType: { type: 'other', key: 'k' },
        notObject: 'text',
      }),
    )
    expect(await readOpencodeAuthMap(path, {})).toEqual({
      openai: LOGIN,
      anthropic: api,
      known: wellknown,
    })
  })

  it('takes OPENCODE_AUTH_CONTENT over the file, as OpenCode 1 does', async () => {
    const { path } = dataDir(JSON.stringify({ openai: LOGIN }))
    const other = { ...LOGIN, refresh: 'from-env' }
    expect(
      await readOpencodeAuthMap(path, {
        OPENCODE_AUTH_CONTENT: JSON.stringify({ openai: other }),
      }),
    ).toEqual({ openai: other })
    // Not valid JSON: ignored, and the file is read.
    expect(
      await readOpencodeAuthMap(path, { OPENCODE_AUTH_CONTENT: '{nope' }),
    ).toEqual({ openai: LOGIN })
  })

  it('a torn read does not pass for an absent slot', async () => {
    const { env } = dataDir('{"openai": {"type": "oau')
    const slot = opencode1ClientSlot({ set: async () => ({}), env })
    let now = 0
    const verdict = await confirmMainAuthSlot({
      client: { auth: slot },
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
    })
    expect(verdict).toEqual({ kind: 'indeterminate' })
  })
})

describe('writing the slot', () => {
  it("goes through OpenCode 1's own writer", async () => {
    const { env } = dataDir('{}')
    const writes: unknown[] = []
    const slot = opencode1ClientSlot({
      set: async (input) => {
        writes.push(input)
        return { data: true }
      },
      env,
    })
    const request = { path: { id: 'openai' }, body: LOGIN }
    expect(await slot.set(request)).toEqual({ data: true })
    expect(writes).toEqual([request])
  })

  it('throws when OpenCode refuses the write', async () => {
    const { env } = dataDir('{}')
    const slot = opencode1ClientSlot({
      set: async () => ({ error: { name: 'BadRequest' } }),
      env,
    })
    await expect(
      slot.set({ path: { id: 'openai' }, body: LOGIN }),
    ).rejects.toThrow('OpenCode refused the write of its openai login')
  })

  it('calls the client method on its own object', async () => {
    const { env, path } = dataDir('{}')
    const auth = {
      written: [] as unknown[],
      async set(input: unknown) {
        this.written.push(input)
        writeFileSync(path, JSON.stringify({ openai: LOGIN }))
        return { data: true }
      },
    }
    const resolved = opencode1SlotForClient({ auth }, { env })
    if (!('slot' in resolved)) throw new Error(resolved.reason)
    await resolved.slot.set({ path: { id: 'openai' }, body: LOGIN })
    expect(auth.written).toHaveLength(1)
    expect(await resolved.slot.get({ path: { id: 'openai' } })).toEqual(LOGIN)
  })

  it('there is no slot for a client without auth.set', () => {
    for (const client of [undefined, {}, { auth: {} }, { auth: { set: 1 } }])
      expect(opencode1SlotForClient(client)).toEqual({
        reason:
          'the OpenCode client has no auth.set to write its login slot with',
      })
  })
})

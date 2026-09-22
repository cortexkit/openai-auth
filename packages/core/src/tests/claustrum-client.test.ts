import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ClaustrumClient,
  detectClaustrumConnection,
  getDefaultClaustrumConnectionPath,
} from '../internal'

// Every other custody test drives the vault through stubs, so a broken client
// release would pass the whole suite: the build inlines whatever version is
// installed, and nothing else here touches the real code. These run the actual
// package through the same re-export the plugin ships, on the paths that need
// no daemon.
describe('the published Claustrum client, through our re-export', () => {
  it('exports the three entry points the plugin calls', () => {
    expect(typeof ClaustrumClient).toBe('function')
    expect(typeof ClaustrumClient.connect).toBe('function')
    expect(typeof detectClaustrumConnection).toBe('function')
    expect(typeof getDefaultClaustrumConnectionPath).toBe('function')
  })

  it('names a default connection file', () => {
    const path = getDefaultClaustrumConnectionPath()
    expect(path.length).toBeGreaterThan(0)
    expect(path.endsWith('.json')).toBe(true)
  })

  it('reports a missing connection file as absent rather than throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claustrum-absent-'))
    try {
      const missing = join(dir, 'subc-connection.json')
      expect(await detectClaustrumConnection(missing)).toEqual({
        status: 'absent',
        path: missing,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Exercises the client's real parser, which is the part a bad release is most
  // likely to break and the part no stub has ever run.
  it('reports an unreadable connection file as malformed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claustrum-malformed-'))
    try {
      const path = join(dir, 'subc-connection.json')
      writeFileSync(path, '{ not json')
      const detection = await detectClaustrumConnection(path)
      expect(detection.status).toBe('malformed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

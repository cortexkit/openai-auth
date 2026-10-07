import { describe, expect, it } from 'bun:test'
import { scrubKnobs } from '../commands'

// The not-migrated notice is the one dialog payload this plugin builds itself
// rather than through the shared command seam, and scrubKnobs is what keeps a
// credential in it from crossing the RPC boundary to the TUI process.
describe('scrubKnobs', () => {
  it('drops credential-shaped fields at any depth and records only their paths', () => {
    const found: string[] = []
    const scrubbed = scrubKnobs(
      {
        title: 'OpenAI accounts',
        access: 'access-secret',
        sections: [
          {
            id: 'accounts',
            items: [
              {
                id: 'main',
                label: 'Main',
                refresh: 'refresh-secret',
                idToken: 'id-token-secret',
                api_key: 'api-key-secret',
              },
            ],
          },
        ],
        nested: {
          detail: 'kept',
          clientSecret: 'client-secret',
          'auth-header': 'Bearer header-secret',
        },
      },
      'menu',
      found,
    )

    expect(scrubbed).toEqual({
      title: 'OpenAI accounts',
      sections: [{ id: 'accounts', items: [{ id: 'main', label: 'Main' }] }],
      nested: { detail: 'kept' },
    })
    expect(found.sort()).toEqual([
      'menu.access',
      'menu.nested.auth-header',
      'menu.nested.clientSecret',
      'menu.sections[0].items[0].api_key',
      'menu.sections[0].items[0].idToken',
      'menu.sections[0].items[0].refresh',
    ])
    // Names only: no value reaches the list, which is logged.
    for (const value of [
      'access-secret',
      'refresh-secret',
      'id-token-secret',
      'api-key-secret',
      'client-secret',
      'header-secret',
    ])
      expect(JSON.stringify({ scrubbed, found })).not.toContain(value)
  })
})

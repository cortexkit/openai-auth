import { describe, expect, it } from 'bun:test'
import * as root from '../index.ts'
import * as internal from '../internal.ts'

describe('core export surface', () => {
  it('exposes no command body a host could call around the menu', () => {
    const everything = [...Object.keys(root), ...Object.keys(internal)]
    const bodies = everything.filter((name) => /^execute[A-Z]/.test(name))
    expect(bodies).toEqual([])
  })

  it('the root subpath carries the seam and nothing that reaches past it', () => {
    // The seam is what runs the scrubbing, so `.` is deliberately small. Store,
    // OAuth and reset entry points live on ./internal, where an import of them
    // is visible as a host reaching past the seam.
    const exported = Object.keys(root)
    expect(exported).toContain('createOpenAiMenu')
    expect(exported).toContain('scrubKnobs')
    expect(exported).not.toContain('loadAccounts')
    expect(exported).not.toContain('mutateAccounts')
    expect(exported).not.toContain('runResetCreditRedemption')
  })
})

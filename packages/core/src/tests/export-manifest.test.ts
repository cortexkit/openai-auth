import { describe, expect, it } from 'bun:test'
import * as root from '../index.ts'
import * as internal from '../internal.ts'
import {
  INTERNAL_VALUE_EXPORTS,
  ROOT_VALUE_EXPORTS,
} from './export-manifest.ts'

describe('core export surface', () => {
  it('the root subpath exports exactly the manifest value list', () => {
    expect(Object.keys(root).sort()).toEqual([...ROOT_VALUE_EXPORTS].sort())
  })

  it('the internal subpath exports exactly the manifest value list', () => {
    expect(Object.keys(internal).sort()).toEqual(
      [...INTERNAL_VALUE_EXPORTS].sort(),
    )
  })

  it('keeps the command bodies private so no host can skip the scrubbing', () => {
    const everything = [...Object.keys(root), ...Object.keys(internal)]
    const bodies = everything.filter((name) => /^execute[A-Z]/.test(name))
    expect(bodies).toEqual([])
  })

  it('the root subpath carries the seam and nothing that reaches past it', () => {
    // The seam is what runs the scrubbing, so `.` is deliberately small. Store,
    // OAuth and reset entry points live on ./internal, where an import of them
    // is visible as a host reaching past the seam.
    expect(ROOT_VALUE_EXPORTS).toContain('buildDialogPayload')
    expect(ROOT_VALUE_EXPORTS).toContain('applyCommand')
    expect(ROOT_VALUE_EXPORTS).toContain('scrubKnobs')
    expect(ROOT_VALUE_EXPORTS).not.toContain('loadAccounts')
    expect(ROOT_VALUE_EXPORTS).not.toContain('mutateAccounts')
    expect(ROOT_VALUE_EXPORTS).not.toContain('runResetCreditRedemption')
  })
})

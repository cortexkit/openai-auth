// The killswitch's older thresholds, rewritten once as the shared menu's
// per-account floors, must block exactly the requests they blocked before.
import { describe, expect, test } from 'bun:test'
import {
  type AccountStorage,
  getKillswitchThresholdsForAccount,
  KILLSWITCH_FLOORS_SCHEMA,
  killswitchPassesPolicy,
  type OAuthQuotaSnapshot,
} from '../accounts'
import { killswitchInFloors, migrateLegacySettings } from '../commands'

const NOW = Date.parse('2026-10-01T12:00:00.000Z')
const LATER = new Date(NOW + 3600_000).toISOString()

function storage(killswitch: Record<string, unknown>): AccountStorage {
  return {
    version: 1,
    accounts: [],
    killswitch,
  } as unknown as AccountStorage
}

function quota(primaryLeft: number, secondaryLeft: number): OAuthQuotaSnapshot {
  return {
    primary: {
      usedPercent: 100 - primaryLeft,
      remainingPercent: primaryLeft,
      resetsAt: LATER,
      checkedAt: NOW,
    },
    secondary: {
      usedPercent: 100 - secondaryLeft,
      remainingPercent: secondaryLeft,
      resetsAt: LATER,
      checkedAt: NOW,
    },
  } as OAuthQuotaSnapshot
}

// An older block exercising every rule of the older reader: `main`
// thresholds with an alias, an account with its own alias-only entry, an
// account with an empty entry (all defaults), and accounts with none (they
// inherit `main`).
const OLDER = {
  enabled: true,
  main: { primary: 20, '1w': 30 },
  accounts: {
    alpha: { '5h': 40 },
    beta: {},
  },
}
const ROSTER = ['main', 'alpha', 'beta', 'gamma']

describe('killswitch floors', () => {
  test('the mapping: own thresholds, else main, else the default, per window', () => {
    expect(killswitchInFloors(OLDER, ROSTER)).toEqual({
      enabled: true,
      accounts: {
        main: { primary: 20, secondary: 30 },
        alpha: { primary: 40, secondary: 10 },
        beta: { primary: 5, secondary: 10 },
        gamma: { primary: 20, secondary: 30 },
      },
      schema: KILLSWITCH_FLOORS_SCHEMA,
    })
  })

  test('an existing config blocks the same requests before and after the rewrite', () => {
    const before = storage(OLDER)
    const settings: Record<string, unknown> = {
      killswitch: structuredClone(OLDER),
    }
    expect(migrateLegacySettings(settings, ROSTER)).toBe(true)
    const after = storage(settings.killswitch as Record<string, unknown>)

    let blocked = 0
    for (const id of ROSTER) {
      // The request path judges the main row as the main account.
      const key = id === 'main' ? undefined : id
      for (let primary = 0; primary <= 100; primary += 5) {
        for (let secondary = 0; secondary <= 100; secondary += 5) {
          const reading = quota(primary, secondary)
          const was = killswitchPassesPolicy(reading, before, key, NOW)
          expect(killswitchPassesPolicy(reading, after, key, NOW)).toBe(was)
          if (!was) blocked += 1
        }
      }
      expect(getKillswitchThresholdsForAccount(after, key)).toEqual(
        getKillswitchThresholdsForAccount(before, key),
      )
    }
    // The grid reaches both sides of every floor.
    expect(blocked).toBeGreaterThan(0)
  })

  test('the rewrite runs once: a marked block is left alone', () => {
    const settings: Record<string, unknown> = {
      killswitch: killswitchInFloors(OLDER, ROSTER),
    }
    expect(migrateLegacySettings(settings, ROSTER)).toBe(false)
  })

  test('in the new vocabulary a window without a floor blocks nothing', () => {
    const marked = storage({
      enabled: true,
      accounts: { alpha: { primary: 25 } },
      schema: KILLSWITCH_FLOORS_SCHEMA,
    })

    expect(getKillswitchThresholdsForAccount(marked, 'alpha')).toEqual({
      primary: 25,
      secondary: 0,
    })
    expect(getKillswitchThresholdsForAccount(marked, 'gamma')).toEqual({
      primary: 0,
      secondary: 0,
    })
    expect(killswitchPassesPolicy(quota(30, 0), marked, 'alpha', NOW)).toBe(
      true,
    )
    expect(killswitchPassesPolicy(quota(20, 90), marked, 'alpha', NOW)).toBe(
      false,
    )
  })

  test('cachekeep becomes cacheKeep, keeping a value already under the new name', () => {
    const settings: Record<string, unknown> = {
      cachekeep: { enabled: true, startHour: 9, endHour: 18 },
      cacheKeep: { enabled: false },
    }
    expect(migrateLegacySettings(settings, [])).toBe(true)
    expect(settings).toEqual({
      cacheKeep: { enabled: false, startHour: 9, endHour: 18 },
    })
  })
})

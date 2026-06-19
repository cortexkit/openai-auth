import { beforeEach, describe, expect, test } from 'bun:test'
import {
  drainNotifications,
  isTuiConnected,
  pushNotification,
  resetNotificationsForTest,
} from '../rpc/notifications'
import type { OpenDialogPayload } from '../rpc/protocol'

const payload = (command: OpenDialogPayload['command']): OpenDialogPayload => ({
  command,
  text: 'x',
  knobs: {},
})

describe('notifications', () => {
  beforeEach(() => resetNotificationsForTest())

  test('push then drain returns the item once, ordered', () => {
    pushNotification(payload('openai-quota'), 's1')
    pushNotification(payload('openai-account'), 's1')
    const first = drainNotifications(0, 's1')
    expect(first.map((n) => n.payload.command)).toEqual([
      'openai-quota',
      'openai-account',
    ])
    expect(first[0]?.id).toBeLessThan(first[1]?.id as number)
    const second = drainNotifications(first[1]?.id as number, 's1')
    expect(second).toEqual([])
  })

  test('session scoping: a session only drains its own + global', () => {
    pushNotification(payload('openai-quota'), 's1')
    pushNotification(payload('openai-dump'), 's2')
    expect(drainNotifications(0, 's1').map((n) => n.payload.command)).toEqual([
      'openai-quota',
    ])
    expect(drainNotifications(0, 's2').map((n) => n.payload.command)).toEqual([
      'openai-dump',
    ])
  })

  test('isTuiConnected reflects a recent drain within the window', () => {
    expect(isTuiConnected('s1')).toBe(false)
    drainNotifications(0, 's1')
    expect(isTuiConnected('s1')).toBe(true)
  })

  test('queue cap evicts oldest beyond 100', () => {
    for (let i = 0; i < 130; i++)
      pushNotification(payload('openai-quota'), 's1')
    const all = drainNotifications(0, 's1')
    expect(all.length).toBe(100)
  })

  test('a global notification reaches every session and is not pruned by one ack', () => {
    // push a global (no sessionId) notification
    pushNotification(payload('openai-quota'))
    const a = drainNotifications(0, 's1')
    expect(a.length).toBe(1)
    // s1 acks it
    drainNotifications(a[0]?.id as number, 's1')
    // s2 must STILL receive it
    const b = drainNotifications(0, 's2')
    expect(b.length).toBe(1)
  })
})

import { describe, expect, test } from 'bun:test'
import { TerminalScreen } from './fixtures/terminal-screen'

describe('terminal screen for real-host PTY drivers', () => {
  test('a title changed in one cell reads whole from the screen but not from the bytes', () => {
    const screen = new TerminalScreen(140, 45)
    const first = '\x1b[34;100H\x1b[1mOpenAI P0 connection 1\x1b[0m'
    // A differential repaint of the next title writes only the changed digit.
    const second = '\x1b[34;121H2'
    screen.write(first)
    expect(screen.shows('OpenAI P0 connection 1')).toBe(true)
    screen.write(second)
    expect(`${first}${second}`).not.toContain('OpenAI P0 connection 2')
    expect(screen.shows('OpenAI P0 connection 2')).toBe(true)
    expect(screen.shows('OpenAI P0 connection 1')).toBe(false)
  })

  test('escape sequences and UTF-8 characters split across writes still land in place', () => {
    const screen = new TerminalScreen(40, 5)
    const bytes = new TextEncoder().encode(
      '\x1b]0;title\x07\x1b[38;2;1;2;3m\x1b[2;3H── 95% left\x1b[?2026l',
    )
    for (const byte of bytes) screen.write(new Uint8Array([byte]))
    expect(screen.lines()[1]).toBe('  ── 95% left')
  })

  test('erasing clears what was drawn', () => {
    const screen = new TerminalScreen(40, 5)
    screen.write('\x1b[1;1Hfirst line\x1b[2;1Hsecond line')
    screen.write('\x1b[1;6H\x1b[K')
    expect(screen.lines().slice(0, 2)).toEqual(['first', 'second line'])
    screen.write('\x1b[2J')
    expect(screen.lines().every((line) => line === '')).toBe(true)
  })
})

import { describe, expect, test } from 'bun:test'
import { buildCachekeepDialogOptions } from '../tui/command-dialogs'

describe('command dialogs', () => {
  test('cachekeep modal shows Turn on when disabled', () => {
    const options = buildCachekeepDialogOptions({
      command: 'openai-cachekeep',
      text: '',
      knobs: { enabled: false, running: false, tracked: 0 },
    })

    expect(options[0]!.title).toContain('○ Disabled')
    expect(options.map((option) => option.title)).toContain('Turn on')
    expect(options.map((option) => option.title)).not.toContain('Turn off')
  })

  test('cachekeep modal shows Turn off when enabled', () => {
    const options = buildCachekeepDialogOptions({
      command: 'openai-cachekeep',
      text: '',
      knobs: {
        enabled: true,
        running: true,
        tracked: 2,
        generatedAt: 1700000005000,
        lastWarmAt: 1700000000000,
        maxIdleWarmMs: 60 * 60 * 1000,
      },
    })

    expect(options[0]!.title).toContain('● Enabled')
    expect(options[0]!.title).toContain('2 tracked')
    expect(options[0]!.title).toContain('last warm 5s ago')
    expect(options.map((option) => option.title)).toContain('Turn off')
    expect(options.map((option) => option.title)).toContain('Refresh status')
  })
})

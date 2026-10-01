import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import { v1ShowsLine } from '../../src/main/a11y/live-feedback'

const ev = (kind: string, via: 'sr' | 'tts' | 'none') =>
  ({ type: 'a11y.announce', text: 'x', priority: 'polite', kind, via }) as const

describe('v1 status line for announcements', () => {
  it.each([
    ['command', 'none', false, true],
    ['command', 'tts', false, false],
    ['command', 'sr', true, true],
    ['focus', 'none', false, true],
    ['scan', 'none', false, false],
    ['scan', 'none', true, true],
    ['error', 'none', true, false],
    ['phase', 'none', true, false],
    ['answer', 'none', true, false]
  ] as const)('%s via %s (captions %s) → %s', (kind, via, captions, shows) => {
    expect(v1ShowsLine(ev(kind, via), captions)).toBe(shows)
  })
})

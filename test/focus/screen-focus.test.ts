import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
vi.mock('../../src/main/windows/factory', () => ({ createWindow: vi.fn(), loadRenderer: vi.fn() }))

import { localize } from '../../src/main/windows/screen-layer'
import { configPatchSchema, configV2Schema, withV2Defaults } from '../../src/shared/config'

describe('focus on the screen layer', () => {
  const left = { id: 1, bounds: { x: 0, y: 0, width: 1000, height: 800 } }
  const right = { id: 2, bounds: { x: 1000, y: 0, width: 1000, height: 800 } }
  const focus = {
    level: 'strong' as const,
    keep: [{ x: 100, y: 100, w: 200, h: 100 }],
    labels: [{ rect: { x: 1200, y: 10, w: 300, h: 200 }, text: 'Hidden: Outliner' }]
  }

  it('each display gets its kept rects and labels in its own DIP', () => {
    const a = localize({ highlights: [], focus }, left)
    expect(a.focus).toEqual({ level: 'strong', keep: [{ x: 100, y: 100, w: 200, h: 100 }] })
    const b = localize({ highlights: [], focus }, right)
    // Nothing kept here: the whole display is dimmed, with its label.
    expect(b.focus).toEqual({
      level: 'strong',
      keep: [],
      labels: [{ rect: { x: 200, y: 10, w: 300, h: 200 }, text: 'Hidden: Outliner' }]
    })
  })
})

describe('helpers config', () => {
  it('an older config gets the defaults, all off', () => {
    const cfg = configV2Schema.parse(withV2Defaults({ version: 2 }))
    expect(cfg.helpers).toMatchObject({
      undo: false,
      shortcutCoach: false,
      fatigue: false,
      errorRescue: false,
      whatChanged: false,
      journal: false,
      readingLevel: 'standard'
    })
  })

  it('a patch may carry one helper field', () => {
    const r = configPatchSchema.safeParse({ helpers: { journal: true } })
    expect(r.success && r.data).toEqual({ helpers: { journal: true } })
    expect(configPatchSchema.safeParse({ helpers: { readingLevel: 'genius' } }).success).toBe(false)
  })
})

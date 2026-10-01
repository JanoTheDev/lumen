import { describe, it, expect } from 'vitest'
import { filterSections } from '../src/renderer/src/panel/settings/meta'
import { parseRoute } from '../src/renderer/src/panel/routes'
import { comboFromEvent } from '../src/renderer/src/ui/hotkey'

type KeyLike = Parameters<typeof comboFromEvent>[0]

const key = (
  k: string,
  mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}
): KeyLike => ({
  key: k,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods
})

describe('settings search', () => {
  it('matches labels and keywords, all words required', () => {
    expect(filterSections('wake').map((s) => s.id)).toEqual(['voice'])
    expect(filterSections('dwell click').map((s) => s.id)).toEqual(['accessibility'])
    expect(filterSections('captions').map((s) => s.id)).toEqual(['accessibility'])
    expect(filterSections('').length).toBeGreaterThan(5)
    expect(filterSections('zzz')).toEqual([])
  })
})

describe('panel routes', () => {
  it('parses settings sections and the gallery', () => {
    expect(parseRoute('#/settings/voice')).toEqual({ name: 'settings', section: 'voice' })
    expect(parseRoute('')).toEqual({ name: 'settings', section: 'general' })
    expect(parseRoute('#/gallery')).toEqual({ name: 'gallery' })
  })
})

describe('shortcut capture', () => {
  it('builds accelerators and rejects bare keys', () => {
    expect(comboFromEvent(key(' ', { ctrlKey: true, shiftKey: true }))).toEqual({
      combo: 'Ctrl+Shift+Space'
    })
    expect(comboFromEvent(key('F9'))).toEqual({ combo: 'F9' })
    expect(comboFromEvent(key('a'))).toHaveProperty('problem')
    expect(comboFromEvent(key('Control', { ctrlKey: true }))).toEqual({ partial: 'Ctrl' })
  })
})

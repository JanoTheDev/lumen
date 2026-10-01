import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  formatSteps,
  groundingNames,
  shortcutIn,
  stepsFromHtml,
  stepsFromText,
  uiNamesIn
} from '../../src/main/howto/extract'

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8')

describe('stepsFromHtml', () => {
  it('takes the article list (not nav or scripts), bold = UI names, kbd = keys', () => {
    const steps = stepsFromHtml(fixture('learn-article.html'))
    expect(steps).toHaveLength(4)
    expect(steps[0]).toEqual({
      text: 'Open Notepad and select Settings (the gear icon).',
      ui: ['Settings']
    })
    expect(steps[1].ui).toEqual(['Appearance', 'Font'])
    expect(steps[2].shortcut).toBe('Ctrl+Plus')
    expect(groundingNames(steps)).toEqual(['Settings', 'Appearance', 'Font'])
  })

  it('needs at least two steps', () => {
    expect(stepsFromHtml('<ol><li>Only one</li></ol>')).toEqual([])
    expect(stepsFromHtml('<p>No list</p>')).toEqual([])
  })
})

describe('stepsFromText', () => {
  it('parses the paid-search format with UI and keys tags', () => {
    const steps = stepsFromText(fixture('paid-answer.txt'))
    expect(steps.map((s) => s.ui)).toEqual([
      ['Edit', 'Preferences'],
      ['Interface', 'Display'],
      ['Resolution Scale'],
      ['Save Preferences']
    ])
    expect(steps[0].text).toBe('Open the Edit menu and choose Preferences')
    expect(steps[3].shortcut).toBe('Ctrl+S')
  })

  it('finds menu paths, bold and quoted names without tags', () => {
    expect(uiNamesIn('Select File > Options > Advanced.')).toEqual(['File', 'Options', 'Advanced'])
    expect(uiNamesIn('Click **New layer** then "Rename"')).toEqual(['New layer', 'Rename'])
    expect(shortcutIn('or press ctrl + shift + n')).toBe('Ctrl+Shift+N')
    expect(shortcutIn('no keys here')).toBeUndefined()
  })

  it('caps steps and step length; formats compactly', () => {
    const many = Array.from({ length: 12 }, (_, i) => `${i + 1}. Step ${'x'.repeat(300)}`).join(
      '\n'
    )
    const steps = stepsFromText(many)
    expect(steps).toHaveLength(8)
    expect(steps[0].text.length).toBeLessThanOrEqual(220)
    expect(formatSteps([{ text: 'Open Font', ui: ['Font'], shortcut: 'Ctrl+F' }])).toBe(
      '1. Open Font [UI: Font] [keys: Ctrl+F]'
    )
  })
})

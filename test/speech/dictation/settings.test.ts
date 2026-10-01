import { describe, expect, it } from 'vitest'
import { snippetsSaveSchema } from '../../../src/shared/ipc'
import { configV2Schema, DEFAULT_CONFIG_V2 } from '../../../src/shared/config'
import {
  appDictionaryFromText,
  appDictionaryToText,
  spellAsFromText,
  spellAsToText,
  styleAppsFromText,
  styleAppsToText
} from '../../../src/renderer/src/panel/settings/sections/dictation-text'

describe('style apps text', () => {
  it('parses "app = kind" lines and drops unknown kinds', () => {
    const map = styleAppsFromText('Basecamp = work\nsignal.exe: personal\nfoo = nope\n\n')
    expect(map).toEqual({ basecamp: 'work', 'signal.exe': 'personal' })
    expect(styleAppsFromText(styleAppsToText(map))).toEqual(map)
  })
})

describe('snippetsSaveSchema', () => {
  it('accepts a list and rejects bad rows', () => {
    expect(snippetsSaveSchema.safeParse([{ trigger: 'sign off', text: 'Best' }]).success).toBe(true)
    expect(snippetsSaveSchema.safeParse([{ trigger: 'x', text: 'Best' }]).success).toBe(false)
    expect(snippetsSaveSchema.safeParse([{ trigger: 'ok go', text: '' }]).success).toBe(false)
    expect(snippetsSaveSchema.safeParse([{ trigger: 'ok go', text: 'a', extra: 1 }]).success).toBe(
      false
    )
  })
})

describe('dictation config', () => {
  it('fills the new dictation fields in an older config', () => {
    const old = { ...DEFAULT_CONFIG_V2.dictation } as Record<string, unknown>
    for (const k of ['backtrack', 'format', 'styles', 'styleApps', 'commandMode', 'snippets'])
      delete old[k]
    const parsed = configV2Schema.shape.dictation.parse(old)
    expect(parsed.backtrack).toBe(true)
    expect(parsed.styles.email).toBe('formal')
    expect(parsed.styleApps).toEqual({})
  })
})

describe('dictionary v2 text (T39)', () => {
  it('parses spell-as lines with =, -> or =>', () => {
    const rules = spellAsFromText(
      'cube control = kubectl\njano -> Jaño\nbad line\nCube Control => x'
    )
    expect(rules).toEqual([
      { from: 'cube control', to: 'kubectl' },
      { from: 'jano', to: 'Jaño' }
    ])
    expect(spellAsFromText(spellAsToText(rules))).toEqual(rules)
  })

  it('parses "app: term, term" lines', () => {
    const map = appDictionaryFromText('Figma: Auto layout, Frame, Frame\nslack = Acme\nempty:\n')
    expect(map).toEqual({ figma: ['Auto layout', 'Frame'], slack: ['Acme'] })
    expect(appDictionaryFromText(appDictionaryToText(map))).toEqual(map)
  })

  it('keeps the new config fields valid with their defaults', () => {
    const d = configV2Schema.shape.dictation.parse({ ...DEFAULT_CONFIG_V2.dictation })
    expect(d).toMatchObject({
      appDictionary: {},
      spellAs: [],
      screenNames: false,
      codingMode: true
    })
  })
})

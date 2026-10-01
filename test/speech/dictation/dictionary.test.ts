import { describe, expect, it } from 'vitest'
import {
  appKeyMatches,
  appTermsFor,
  applySpellAs,
  dictionaryFileSchema,
  exportDictionary,
  mergeImport,
  rulesFromCorrections,
  termsFor,
  withRules
} from '../../../src/main/speech/dictation/dictionary'
import { sttTerms } from '../../../src/main/speech/stt'
import { DEFAULT_CONFIG_V2 } from '../../../src/shared/config'

const figma = { process: 'figma.exe', title: 'Untitled - Figma' }
const slack = { process: 'chrome.exe', title: 'general - Acme - Slack' }

describe('per-app terms', () => {
  it('matches a process, a process without .exe or a title word', () => {
    expect(appKeyMatches('figma.exe', figma)).toBe(true)
    expect(appKeyMatches('figma', figma)).toBe(true)
    expect(appKeyMatches('slack', slack)).toBe(true)
    expect(appKeyMatches('sl', slack)).toBe(false)
    expect(appKeyMatches('', slack)).toBe(false)
  })

  it('collects the terms of every fitting entry', () => {
    const apps = { figma: ['Auto layout', 'Frame'], slack: ['Acme'], 'code.exe': ['tsconfig'] }
    expect(appTermsFor(apps, figma)).toEqual(['Auto layout', 'Frame'])
    expect(appTermsFor(apps, slack)).toEqual(['Acme'])
    expect(appTermsFor(undefined, slack)).toEqual([])
  })

  it('merges global, app and spell-as terms once', () => {
    expect(
      termsFor(
        {
          dictionary: ['Lumen', 'Figma'],
          appDictionary: { figma: ['Figma', 'Frame'] },
          spellAs: [{ from: 'cube control', to: 'kubectl' }]
        },
        figma
      )
    ).toEqual(['Lumen', 'Figma', 'Frame', 'kubectl'])
  })
})

describe('applySpellAs', () => {
  const rules = [
    { from: 'cube control', to: 'kubectl' },
    { from: 'jano', to: 'Jaño' },
    { from: 'cube', to: 'Cube' }
  ]

  it('replaces whole words and phrases, longest first', () => {
    expect(applySpellAs('Run cube control get pods', rules)).toBe('Run kubectl get pods')
    expect(applySpellAs('Ask Jano about the cube.', rules)).toBe('Ask Jaño about the Cube.')
    expect(applySpellAs('cube, control', rules)).toBe('kubectl')
  })

  it('leaves parts of words alone', () => {
    expect(applySpellAs('cubes and janos', rules)).toBe('cubes and janos')
    expect(applySpellAs('anything', [])).toBe('anything')
  })
})

describe('learned rules', () => {
  it('turns respellings that were learned into rules, not case fixes', () => {
    const found = [
      { from: 'Figmah', to: 'Figma' },
      { from: 'github', to: 'GitHub' },
      { from: 'Vinchi', to: 'Vinci' }
    ]
    expect(rulesFromCorrections(found, ['Figma', 'GitHub'])).toEqual([
      { from: 'figmah', to: 'Figma' }
    ])
  })

  it('replaces a rule for the same heard text', () => {
    expect(
      withRules(
        [
          { from: 'figmah', to: 'Figmah' },
          { from: 'x', to: 'X' }
        ],
        [{ from: 'Figmah', to: 'Figma' }]
      )
    ).toEqual([
      { from: 'x', to: 'X' },
      { from: 'Figmah', to: 'Figma' }
    ])
  })
})

describe('export / import', () => {
  const cfg = {
    dictionary: ['Lumen'],
    appDictionary: { figma: ['Frame'] },
    spellAs: [{ from: 'jano', to: 'Jaño' }]
  }

  it('round-trips through the file schema', () => {
    const file = dictionaryFileSchema.parse(JSON.parse(JSON.stringify(exportDictionary(cfg))))
    expect(file.dictionary).toEqual(['Lumen'])
    expect(file.appDictionary).toEqual({ figma: ['Frame'] })
  })

  it('rejects a file that is not a dictionary export', () => {
    expect(dictionaryFileSchema.safeParse({ dictionary: ['x'] }).success).toBe(false)
  })

  it('merges without duplicates and counts what was added', () => {
    const file = dictionaryFileSchema.parse({
      lumenDictionary: 1,
      dictionary: ['lumen', 'Kubernetes'],
      appDictionary: { Figma: ['frame', 'Auto layout'], slack: ['Acme'] },
      spellAs: [
        { from: 'Jano', to: 'Jano' },
        { from: 'cube control', to: 'kubectl' }
      ]
    })
    const r = mergeImport(cfg, file)
    expect(r.dictionary).toEqual(['Lumen', 'Kubernetes'])
    expect(r.appDictionary).toEqual({ figma: ['Frame', 'Auto layout'], slack: ['Acme'] })
    expect(r.spellAs).toEqual([
      { from: 'jano', to: 'Jaño' },
      { from: 'cube control', to: 'kubectl' }
    ])
    expect(r.added).toBe(4)
  })
})

describe('sttTerms (cloud prompt)', () => {
  it('adds the app terms and spell-as targets of the app in front', () => {
    const cfg = {
      voiceVocab: 'Lumen',
      dictation: {
        ...DEFAULT_CONFIG_V2.dictation,
        dictionary: ['Figma'],
        appDictionary: { slack: ['Acme'] },
        spellAs: [{ from: 'cube control', to: 'kubectl' }]
      }
    }
    expect(sttTerms(cfg, ['Glossary'], slack)).toEqual([
      'Lumen',
      'Figma',
      'Acme',
      'kubectl',
      'Glossary'
    ])
    expect(sttTerms(cfg, [], figma)).toEqual(['Lumen', 'Figma', 'kubectl'])
  })
})

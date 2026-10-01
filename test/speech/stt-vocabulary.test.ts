import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../helpers/electron-mock')).electronModule())
import {
  MAX_TERMS,
  glossaryTerms,
  mergeVocabulary,
  splitTerms
} from '../../src/main/speech/stt/vocabulary'
import {
  dictationPrompt,
  sttTerms,
  whisperLanguage,
  whisperPrompt
} from '../../src/main/speech/stt'
import { recognizerConfig } from '../../src/main/speech/sherpa-engine'
import {
  CANARY_MULTI,
  PARAKEET_EN,
  offlineLanguage,
  sttModelFor
} from '../../src/main/speech/stt/local-model'

describe('vocabulary', () => {
  it('splits user text', () => {
    expect(splitTerms('Kubernetes, DaVinci Resolve\nFigma,,')).toEqual([
      'Kubernetes',
      'DaVinci Resolve',
      'Figma'
    ])
  })

  it('reads glossary terms', () => {
    const md = [
      '# Figma glossary',
      '',
      '- **Auto layout** — frame setting',
      '- **Style / Variable** — saved values',
      'Some prose with **bold** words.'
    ].join('\n')
    expect(glossaryTerms(md)).toEqual(['Auto layout', 'Style', 'Variable'])
  })

  it('merges in priority order without duplicates', () => {
    expect(mergeVocabulary([['Figma', 'Lumen'], ['figma', 'GitHub'], ['Frame']])).toEqual([
      'Figma',
      'Lumen',
      'GitHub',
      'Frame'
    ])
  })

  it('caps the count and the length', () => {
    const many = Array.from({ length: 100 }, (_, i) => `term${i}`)
    expect(mergeVocabulary([many])).toHaveLength(MAX_TERMS)
    expect(mergeVocabulary([['x'.repeat(41), 'ok']])).toEqual(['ok'])
    expect(mergeVocabulary([['aaaa', 'bbbb', 'cccc']], 10, 12)).toEqual(['aaaa', 'bbbb'])
  })

  it('user words come before the dictionary and the app glossary', () => {
    const cfg = { voiceVocab: 'Kubernetes', dictation: { dictionary: ['Figma'] } }
    expect(sttTerms(cfg as never, ['Frame', 'figma'])).toEqual(['Kubernetes', 'Figma', 'Frame'])
  })
})

describe('whisper prompts by language', () => {
  it('English prompt carries the terms', () => {
    const p = whisperPrompt(['Figma'], 'en')
    expect(p).toContain('User speaks English')
    expect(p).toContain('Figma')
  })

  it('other languages only list names', () => {
    expect(whisperPrompt(['Figma'], 'es')).toBe('Figma, Lumen, Claude, Anthropic, GitHub, Gmail.')
    expect(dictationPrompt([], 'es')).toBe('')
    expect(dictationPrompt(['Figma'], 'en')).toContain('Names and terms: Figma.')
  })

  it('auto lets Whisper detect', () => {
    expect(whisperLanguage('auto')).toBeUndefined()
    expect(whisperLanguage('es')).toBe('es')
  })
})

describe('offline model per language', () => {
  it('picks Canary for es/de/fr and Parakeet otherwise', () => {
    expect(sttModelFor('es')).toBe(CANARY_MULTI)
    expect(sttModelFor('de-DE')).toBe(CANARY_MULTI)
    expect(sttModelFor('en')).toBe(PARAKEET_EN)
    expect(sttModelFor('auto')).toBe(PARAKEET_EN)
    expect(sttModelFor('it')).toBe(PARAKEET_EN)
  })

  it('knows which languages work offline', () => {
    expect(offlineLanguage('es')).toBe(true)
    expect(offlineLanguage('auto')).toBe(true)
    expect(offlineLanguage('it')).toBe(false)
  })

  it('builds the recognizer config per kind', () => {
    const canary = recognizerConfig({ dir: 'm', threads: 2, kind: 'canary', lang: 'es' }) as {
      featConfig: { featureDim: number }
      modelConfig: { canary: { srcLang: string; tgtLang: string } }
    }
    expect(canary.featConfig.featureDim).toBe(128)
    expect(canary.modelConfig.canary.srcLang).toBe('es')
    expect(canary.modelConfig.canary.tgtLang).toBe('es')
    const ctc = recognizerConfig({ dir: 'm', threads: 2 }) as {
      featConfig: { featureDim: number }
      modelConfig: { nemoCtc: { model: string } }
    }
    expect(ctc.featConfig.featureDim).toBe(80)
    expect(ctc.modelConfig.nemoCtc.model).toMatch(/model\.int8\.onnx$/)
  })
})

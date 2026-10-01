import { describe, expect, it } from 'vitest'
import {
  DETECTED_FRESH_MS,
  detectedLanguage,
  effectiveLanguage,
  languageCode,
  noteDetectedLanguage,
  replyLanguageLine
} from '../../src/main/speech/language'

describe('voice language (04 T43)', () => {
  it('maps Whisper language names and codes', () => {
    expect(languageCode('German')).toBe('de')
    expect(languageCode('english')).toBe('en')
    expect(languageCode('es-MX')).toBe('es')
    expect(languageCode('japanese')).toBe('japanese')
    expect(languageCode('')).toBeUndefined()
  })

  it('a fixed language ignores detection', () => {
    noteDetectedLanguage('german', 1000)
    expect(effectiveLanguage('fr', 1000)).toBe('fr')
    expect(replyLanguageLine('en', 1000)).toBe('')
    expect(replyLanguageLine('es', 1000)).toContain('Spanish')
  })

  it('auto follows the last detected language while fresh', () => {
    noteDetectedLanguage('german', 1000)
    expect(effectiveLanguage('auto', 2000)).toBe('de')
    expect(replyLanguageLine('auto', 2000)).toContain('German')
    expect(detectedLanguage(1000 + DETECTED_FRESH_MS + 1)).toBeUndefined()
    expect(replyLanguageLine('auto', 1000 + DETECTED_FRESH_MS + 1)).toBe('')
  })

  it('English or unknown detections add no line', () => {
    noteDetectedLanguage('english', 0)
    expect(replyLanguageLine('auto', 10)).toBe('')
    noteDetectedLanguage(undefined, 0)
    expect(effectiveLanguage('auto', 10)).toBe('auto')
  })
})

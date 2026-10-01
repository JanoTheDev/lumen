import { describe, expect, it } from 'vitest'
import {
  voiceFullyLocal,
  voicePrivacyRows,
  type VoicePrivacyInput
} from '../src/shared/voice-privacy'
import {
  dictionaryFromText,
  languageHint
} from '../src/renderer/src/panel/settings/sections/voice-language'

const base: VoicePrivacyInput = {
  sttEngine: 'local',
  tts: 'windows',
  wakeWord: false,
  bargeIn: false,
  cancelVoice: false,
  dictation: { enabled: false, cleanup: 'light' }
}

describe('voice privacy rows', () => {
  it('offline engines keep everything on this PC', () => {
    expect(voiceFullyLocal(base)).toBe(true)
    const rows = voicePrivacyRows(base)
    expect(rows.map((r) => r.what)).toEqual(['Your recording', 'Spoken answers', 'Audio files'])
  })

  it('cloud speech and voices are named', () => {
    const rows = voicePrivacyRows({ ...base, sttEngine: 'cloud', tts: 'cloud' })
    expect(rows.find((r) => r.what === 'Your recording')?.where).toContain('OpenAI')
    expect(rows.find((r) => r.what === 'Spoken answers')?.local).toBe(false)
    expect(voiceFullyLocal({ ...base, sttEngine: 'cloud' })).toBe(false)
  })

  it('lists wake word, stop phrases, barge-in and dictation when on', () => {
    const rows = voicePrivacyRows({
      ...base,
      wakeWord: true,
      cancelVoice: true,
      bargeIn: true,
      dictation: { enabled: true, cleanup: 'light' }
    })
    expect(rows.map((r) => r.what)).toEqual([
      'Your recording',
      'Wake word listening',
      'Stop phrases',
      'Talking over an answer',
      'Spoken answers',
      'Dictated text',
      'Audio files'
    ])
    expect(rows.find((r) => r.what === 'Dictated text')?.local).toBe(false)
  })
})

describe('voice language settings', () => {
  it('explains what each language needs', () => {
    expect(languageHint('es')).toContain('154 MB')
    expect(languageHint('it')).toContain('OpenAI key')
    expect(languageHint('auto')).toContain('detects')
  })

  it('parses the personal dictionary field', () => {
    expect(dictionaryFromText('Figma, GitHub\nFigma,, DaVinci ')).toEqual([
      'Figma',
      'GitHub',
      'DaVinci'
    ])
  })
})

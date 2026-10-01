import { describe, expect, it } from 'vitest'
import { forTheEar } from '../../src/main/speech/tts/ear'
import { TurnSpeech, ttsEngine } from '../../src/main/speech/tts/turns'

describe('forTheEar', () => {
  it('strips markdown emphasis, headings and list markers', () => {
    expect(forTheEar('## Steps\n- **Open** the _File_ menu\n1. Click `Save`')).toBe(
      'Steps Open the File menu Click Save'
    )
  })
  it('never reads URLs or links aloud', () => {
    expect(forTheEar('Go to https://example.com/a?b=1 now.')).toBe('Go to the link on screen now.')
    expect(forTheEar('See [the docs](https://x.y/z).')).toBe('See the docs.')
  })
  it('replaces code blocks with a pointer to the screen', () => {
    expect(forTheEar('Run this:\n```bash\nnpm i\n```\nDone.')).toBe(
      'Run this: I put the code on screen. Done.'
    )
  })
  it('says shortcuts the way people say them', () => {
    expect(forTheEar('Press Ctrl+Shift+S to save.')).toBe('Press Control Shift S to save.')
    expect(forTheEar('Use Alt + F4 or Win+E.')).toBe('Use Alt F4 or Windows E.')
  })
  it('turns paragraph breaks into pauses', () => {
    expect(forTheEar('First part\n\nSecond part')).toBe('First part. Second part')
  })
})

describe('ttsEngine', () => {
  it('defaults to Windows voices and needs a key for cloud', () => {
    expect(ttsEngine('windows', false)).toBe('windows')
    expect(ttsEngine('cloud', true)).toBe('cloud')
    expect(ttsEngine('cloud', false)).toBe('windows')
    expect(ttsEngine('off', true)).toBeNull()
  })
})

describe('TurnSpeech', () => {
  it('tracks the running turn and which turns already spoke', () => {
    const t = new TurnSpeech()
    t.start('a')
    expect(t.current).toBe('a')
    t.markSpoken('a')
    t.end('b')
    expect(t.current).toBe('a')
    t.end('a')
    expect(t.current).toBeNull()
    expect(t.hasSpoken('a')).toBe(true)
    expect(t.hasSpoken('b')).toBe(false)
  })
})

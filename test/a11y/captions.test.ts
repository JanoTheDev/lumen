import { describe, expect, it } from 'vitest'
import {
  CaptionSession,
  VocabLearner,
  actionRisk,
  applySpelling,
  confirmAnswer,
  describeActions,
  mergeVocab,
  needsTranscriptConfirm,
  parseCorrection
} from '../../src/main/a11y/captions'

describe('correction commands', () => {
  it.each([
    ['no, I said open Spotify', 'open Spotify'],
    ['No I said "open Spotify".', '"open Spotify"'],
    ['no i meant scroll up', 'scroll up'],
    ['No. I said, press enter!', 'press enter']
  ])('%s replaces the utterance', (u, text) => {
    expect(parseCorrection(u)).toEqual({ type: 'replace', text })
  })

  it.each([
    ['correct that', 'edit'],
    ['Fix that.', 'edit'],
    ['edit it', 'edit'],
    ['spell that', 'spell'],
    ['let me spell it', 'spell']
  ] as const)('%s opens the editor (%s)', (u, mode) => {
    expect(parseCorrection(u)).toEqual({ type: 'open', mode })
  })

  it.each(['I said hello to Sam yesterday', 'no', 'correct the spelling in this email', 'spell'])(
    '%s is not a correction',
    (u) => {
      expect(parseCorrection(u)).toBeNull()
    }
  )
})

describe('confirm answers', () => {
  it.each(['yes', 'Yes.', 'OK', 'go ahead', 'yes please', 'do it'])('%s is yes', (u) => {
    expect(confirmAnswer(u)).toBe('yes')
  })
  it.each(['no', 'No!', 'stop', 'cancel', "don't", 'never mind'])('%s is no', (u) => {
    expect(confirmAnswer(u)).toBe('no')
  })
  it.each(['yes open the other one', 'what is this', 'stopwatch'])('%s is neither', (u) => {
    expect(confirmAnswer(u)).toBeNull()
  })
})

describe('spelling', () => {
  it.each([
    ['h e l l o', 'hello'],
    ['H-E-L-L-O', 'hello'],
    ['H, E, L, L, O.', 'hello'],
    ['hotel echo lima lima oscar', 'hello'],
    ['capital s a m', 'Sam'],
    ['j o space d o e', 'jo doe'],
    ['four two', '42'],
    ['x-ray ray', 'xray'],
    ['figma', 'figma']
  ])('%s → %s', (u, out) => {
    expect(applySpelling('', u)).toBe(out)
  })

  it('appends to the draft and backspace removes the last letter', () => {
    expect(applySpelling('fig', 'm a x backspace')).toBe('figma')
  })
})

describe('CaptionSession', () => {
  it('"no, I said" re-runs the corrected text', () => {
    const s = new CaptionSession()
    s.heard('open spotty fly')
    expect(s.handle('no, I said open Spotify')).toEqual({ type: 'rerun', text: 'open Spotify' })
    expect(s.handle('scroll down')).toBeNull()
  })

  it('"correct that" opens the last utterance; dictation replaces it; done runs it', () => {
    const s = new CaptionSession()
    s.heard('open spotty fly')
    expect(s.handle('correct that')).toEqual({
      type: 'draft',
      edit: { mode: 'edit', draft: 'open spotty fly' }
    })
    expect(s.handle('open Spotify')).toEqual({
      type: 'draft',
      edit: { mode: 'edit', draft: 'open Spotify' }
    })
    expect(s.handle('done')).toEqual({ type: 'rerun', text: 'open Spotify' })
    expect(s.editing()).toBeNull()
  })

  it('"spell that" starts empty and collects letters until done', () => {
    const s = new CaptionSession()
    s.heard('open frigma')
    expect(s.handle('spell that')).toEqual({ type: 'draft', edit: { mode: 'spell', draft: '' } })
    s.handle('f i g')
    expect(s.handle('mike alpha')).toEqual({
      type: 'draft',
      edit: { mode: 'spell', draft: 'figma' }
    })
    expect(s.handle('clear')).toEqual({ type: 'draft', edit: { mode: 'spell', draft: '' } })
    expect(s.handle('cancel')).toEqual({ type: 'close' })
    expect(s.editing()).toBeNull()
  })

  it('done on an empty draft just closes', () => {
    const s = new CaptionSession()
    s.handle('spell it')
    expect(s.handle('done')).toEqual({ type: 'close' })
  })

  it('a typed submit closes the editor and returns the text', () => {
    const s = new CaptionSession()
    s.heard('x')
    s.startEdit('edit')
    expect(s.submit('  open Spotify ')).toBe('open Spotify')
    expect(s.editing()).toBeNull()
    expect(s.submit('   ')).toBeNull()
  })
})

describe('transcript confirmation policy', () => {
  it.each([
    [[{ type: 'scroll' }], 'low'],
    [[{ type: 'type', text: 'hi' }], 'medium'],
    [[{ type: 'open_url', url: 'https://example.com' }], 'medium'],
    [
      [
        { type: 'type', text: 'hi' },
        { type: 'hotkey', keys: ['enter'] }
      ],
      'high'
    ],
    [[{ type: 'hotkey', keys: ['Ctrl', 'W'] }], 'high'],
    [[{ type: 'hotkey', keys: ['ctrl', 'c'] }], 'low'],
    [[{ type: 'click_element', text: 'Send' }], 'high'],
    [[{ type: 'click_target', target: { kind: 'text', text: 'Delete forever' } }], 'high'],
    [[{ type: 'click_element', text: 'Inbox' }], 'low']
  ] as const)('%j → %s', (actions, risk) => {
    expect(actionRisk(actions as never)).toBe(risk)
  })

  it.each([
    ['always', 'low', true],
    ['risky', 'low', false],
    ['risky', 'medium', false],
    ['risky', 'high', true],
    ['off', 'high', false]
  ] as const)('%s + %s → %s', (policy, risk, asks) => {
    expect(needsTranscriptConfirm(policy, risk)).toBe(asks)
  })

  it('describes a batch in one line', () => {
    expect(
      describeActions([
        { type: 'type', text: 'see you at 5' },
        { type: 'hotkey', keys: ['enter'] }
      ])
    ).toBe('Type “see you at 5”, then press Enter')
    expect(describeActions([{ type: 'click_element', text: 'Send' }])).toBe('Click “Send”')
  })
})

describe('vocabulary from corrections', () => {
  it('adds a word after its second correction, once', () => {
    const v = new VocabLearner()
    expect(v.note('open spotty fly', 'open Spotify')).toEqual([])
    expect(v.note('open spot if I', 'open Spotify please')).toEqual(['Spotify'])
    expect(v.note('open spot', 'open Spotify')).toEqual([])
  })

  it('ignores words that were heard, short words and stop words', () => {
    const v = new VocabLearner(1)
    expect(v.note('send it to sam', 'send it to Sam and the team 42')).toEqual(['team'])
  })

  it('merges into the comma list without duplicates', () => {
    expect(mergeVocab('', ['Spotify'])).toBe('Spotify')
    expect(mergeVocab('Figma, spotify', ['Spotify', 'Blender'])).toBe('Figma, spotify, Blender')
    expect(mergeVocab('abc', ['defgh'], 6)).toBe('abc')
  })
})

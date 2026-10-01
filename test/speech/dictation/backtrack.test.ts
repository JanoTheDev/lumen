import { describe, expect, it } from 'vitest'
import { applyBacktrack } from '../../../src/main/speech/dictation/backtrack'
import { wordsPreserved } from '../../../src/main/speech/dictation/cleanup'

const bt = (t: string): string => applyBacktrack(t).text

describe('applyBacktrack', () => {
  it.each([
    ['send it Tuesday, actually Wednesday', 'send it Wednesday'],
    ['let us meet at five no wait meet at six', 'let us meet at six'],
    ['meet the team at the office, I mean at the cafe', 'meet the team at the cafe'],
    ['the red one, or rather the blue one', 'the blue one'],
    ['order two pizzas, make that three', 'order three pizzas'],
    ['call me at five, I mean six', 'call me at six'],
    ["Let's go. No wait, let's stay.", "let's stay."],
    ['Thanks for the call. Send the file to Bob scratch that', 'Thanks for the call.'],
    ['Send the file to Bob. Scratch that', ''],
    ['Send the file to Bob scratch that send it to Ann', 'send it to Ann'],
    ['Write to Bob scratch that call Ann', 'call Ann'],
    ['bring cake, I mean bring pie', 'bring pie'],
    ['bring cake, sorry, bring pie', 'bring pie']
  ])('%s', (raw, want) => {
    expect(bt(raw)).toBe(want)
  })

  it('leaves weak cues that are ordinary words', () => {
    for (const t of [
      'I actually like it',
      'It is, actually, fine',
      "I can't come, sorry about that",
      "It's late, actually let's go home",
      'What I mean is simple',
      'Actually that works'
    ])
      expect(bt(t)).toBe(t)
  })

  it('reports how many corrections it applied', () => {
    expect(applyBacktrack('Monday, actually Tuesday, no wait Wednesday').applied).toBe(2)
    expect(bt('Monday, actually Tuesday, no wait Wednesday')).toBe('Wednesday')
    expect(applyBacktrack('nothing to fix').applied).toBe(0)
  })
})

describe('wordsPreserved with a retraction', () => {
  it('lets the model drop one retracted span that ends at a cue', () => {
    const raw = 'send it next Tuesday actually Wednesday works'
    expect(wordsPreserved(raw, 'Send it Wednesday works.')).toBe(false)
    expect(wordsPreserved(raw, 'Send it Wednesday works.', { allowRetraction: true })).toBe(true)
  })

  it('still rejects added or reworded text', () => {
    const raw = 'send it Tuesday actually Wednesday'
    expect(wordsPreserved(raw, 'Send it Thursday.', { allowRetraction: true })).toBe(false)
    expect(wordsPreserved('no cue here at all', 'No here at all.', { allowRetraction: true })).toBe(
      false
    )
  })
})

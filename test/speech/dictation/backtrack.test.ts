import { describe, expect, it } from 'vitest'
import { applyBacktrack } from '../../../src/main/speech/dictation/backtrack'
import { wordsPreserved } from '../../../src/main/speech/dictation/cleanup'

const bt = (t: string): string => applyBacktrack(t).text

describe('applyBacktrack', () => {
  it.each([
    ['send it Tuesday, actually Wednesday', 'send it Wednesday'],
    ['let us meet at five, no wait, meet at six', 'let us meet at six'],
    ['let us meet at five, no wait meet at six', 'let us meet at six'],
    ['meet the team at the office, I mean at the cafe', 'meet the team at the cafe'],
    ['the red one, or rather the blue one', 'the blue one'],
    ['order two pizzas, make that three', 'order three pizzas'],
    ['call me at five, I mean six', 'call me at six'],
    ["Let's go. No wait, let's stay.", "let's stay."],
    ['Thanks for the call. Send the file to Bob, scratch that', 'Thanks for the call.'],
    ['Thanks for the call. Send the file to Bob, scratch that.', 'Thanks for the call.'],
    ['Send the file to Bob. Scratch that', ''],
    ['Send the file to Bob. Delete that.', ''],
    ['Send the file to Bob, scratch that, send it to Ann', 'send it to Ann'],
    ['Write to Bob, scratch that, call Ann', 'call Ann'],
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

  it('leaves strong cues that are words of the sentence (H1)', () => {
    for (const t of [
      'Please delete that file from the server.',
      'Can you delete that email',
      "There's no wait time at the clinic.",
      'I need to scratch that itch',
      'I need to scratch that',
      'Should I delete that?',
      'Please delete that.',
      'If it is spam, delete that.',
      'If you want, delete that line.',
      'Yes, no wait time at all.',
      'There is no wait.',
      'We had no wait at all and the food was great.',
      'Do not scratch that surface, it marks easily.',
      'You can strike that from the list.',
      'Delete that file now.',
      'No wait times were reported.',
      'Then scratch that idea and start over.',
      'Send the file to Bob scratch that send it to Ann',
      'He said there was no wait, which surprised me.',
      'Could you, scratch that?'
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
    const raw = 'send it next Tuesday, actually Wednesday works'
    expect(wordsPreserved(raw, 'Send it Wednesday works.')).toBe(false)
    expect(wordsPreserved(raw, 'Send it Wednesday works.', { allowRetraction: true })).toBe(true)
  })

  it('does not let the model drop words before a cue inside a phrase (H1)', () => {
    expect(
      wordsPreserved('Please delete that file from the server.', 'File from the server.', {
        allowRetraction: true
      })
    ).toBe(false)
    expect(wordsPreserved('I actually like it', 'Like it.', { allowRetraction: true })).toBe(false)
    expect(
      wordsPreserved('Send it to Bob, scratch that, send it to Ann', 'Send it to Ann.', {
        allowRetraction: true
      })
    ).toBe(true)
  })

  it('still rejects added or reworded text', () => {
    const raw = 'send it Tuesday actually Wednesday'
    expect(wordsPreserved(raw, 'Send it Thursday.', { allowRetraction: true })).toBe(false)
    expect(wordsPreserved('no cue here at all', 'No here at all.', { allowRetraction: true })).toBe(
      false
    )
  })
})

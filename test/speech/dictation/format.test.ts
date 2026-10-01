import { describe, expect, it } from 'vitest'
import {
  canonicalTokens,
  fieldKindOf,
  formatAddresses,
  formatDictation,
  formatLists
} from '../../../src/main/speech/dictation/format'
import { formatNumbers, parseRun } from '../../../src/main/speech/dictation/numbers'

describe('formatNumbers', () => {
  it.each([
    ['It costs twenty five dollars.', 'It costs $25.'],
    ['About fifty percent of them.', 'About 50% of them.'],
    ['We need two hundred and fifty chairs.', 'We need 250 chairs.'],
    ['Twelve thousand five hundred people', '12,500 people'],
    ['three point five stars', '3.5 stars'],
    ['Meet on March third.', 'Meet on March 3.'],
    ['the twenty first century', 'the 21st century'],
    ['See you at three thirty.', 'See you at 3:30.'],
    ['Call at three pm.', 'Call at 3 pm.'],
    ['five dollars', '$5'],
    ['one of them came first', 'one of them came first'],
    ['I have two cats', 'I have two cats'],
    ['one two three go', 'one two three go']
  ])('%s', (input, want) => {
    expect(formatNumbers(input)).toBe(want)
  })

  it('splits runs into the numbers said', () => {
    expect(parseRun('three thirty').map((g) => g.value)).toEqual([3, 30])
    expect(parseRun('one hundred and five').map((g) => g.value)).toEqual([105])
    expect(parseRun('two million three hundred thousand').map((g) => g.value)).toEqual([2_300_000])
  })
})

describe('formatAddresses', () => {
  it('writes spoken emails and web addresses', () => {
    expect(formatAddresses('Mail john dot smith at example dot com today')).toBe(
      'Mail john.smith@example.com today'
    )
    expect(formatAddresses('Go to lumen dot app slash docs.')).toBe('Go to lumen.app/docs.')
    expect(formatAddresses('back in the dot com days')).toBe('back in the dot com days')
  })
})

describe('formatLists', () => {
  const said = 'I need three things: first, eggs, second, milk, third, bread. Thanks!'
  it('numbers an ordinal list in a multi-line field', () => {
    expect(formatLists(said, 'rich')).toBe(
      'I need three things:\n1. Eggs\n2. Milk\n3. Bread\nThanks!'
    )
  })

  it('keeps a one-line field on one line', () => {
    expect(formatLists(said, 'single')).toBe('I need three things: Eggs, Milk, Bread Thanks!')
  })

  it('bullets on "bullet point"', () => {
    expect(formatLists('Groceries bullet point apples bullet point pears', 'plain')).toBe(
      'Groceries:\n- Apples\n- Pears'
    )
  })

  it('leaves prose with a single ordinal alone', () => {
    const t = 'First, I want to thank you all.'
    expect(formatLists(t, 'rich')).toBe(t)
  })
})

describe('formatDictation', () => {
  it('applies spoken commands only when the model did not', () => {
    const t = 'Hi Sam comma new line see you at the office period'
    expect(formatDictation(t, { kind: 'plain', spokenCommands: true })).toBe(
      'Hi Sam,\nSee you at the office.'
    )
    expect(formatDictation(t, { kind: 'plain' })).toBe(t)
  })

  it('keeps one line in a single-line field', () => {
    expect(formatDictation('Hello.\n\nBye.', { kind: 'single' })).toBe('Hello. Bye.')
  })

  it('keeps the canonical words of the cleaned text', () => {
    for (const t of [
      'It costs twenty five dollars, first, then second.',
      'Mail me at john at example dot com, number one, apples, number two, pears.',
      'Twelve thousand five hundred people came on March third at three thirty pm.'
    ]) {
      const out = formatDictation(t, { kind: 'rich' })
      expect(canonicalTokens(out)).toEqual(canonicalTokens(t))
    }
  })
})

describe('fieldKindOf', () => {
  it('reads the field kind from the focused app and role', () => {
    expect(fieldKindOf({ process: 'winword.exe', title: '', role: 'Edit' })).toBe('rich')
    expect(fieldKindOf({ process: 'chrome.exe', title: 'Inbox - Gmail', role: 'Edit' })).toBe(
      'rich'
    )
    expect(fieldKindOf({ process: 'chrome.exe', title: 'Search', role: 'Edit' })).toBe('single')
    expect(fieldKindOf({ process: 'notepad.exe', title: '', role: 'Document' })).toBe('rich')
    expect(fieldKindOf({ process: 'foo.exe', title: '', role: '' })).toBe('plain')
  })
})

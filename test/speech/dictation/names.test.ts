import { describe, expect, it } from 'vitest'
import { extractScreenNames, respellFromScreen } from '../../../src/main/speech/dictation/names'

const THREAD = `Re: Launch plan
Hi team, John and Priya Raman met with the GitHub folks today.
Priya will send the deck. Will said the Figma file is ready.
Thanks, John`

describe('extractScreenNames', () => {
  it('keeps names written mid-sentence and words with inner capitals', () => {
    const names = extractScreenNames(THREAD)
    expect(names).toEqual(expect.arrayContaining(['John', 'Priya', 'Raman', 'GitHub', 'Figma']))
  })

  it('drops words that also appear in lowercase, and sentence-start-only words', () => {
    const names = extractScreenNames(THREAD)
    expect(names).not.toContain('Will')
    expect(names).not.toContain('Thanks')
    expect(names).not.toContain('Launch')
  })

  it('caps the list', () => {
    const many = Array.from({ length: 50 }, (_, i) => `met Name${'abcdefghij'[i % 10]}x${i}`).join(
      ' '
    )
    expect(extractScreenNames(many, 5)).toHaveLength(5)
  })
})

describe('respellFromScreen', () => {
  const names = ['John', 'Priya', 'GitHub', 'Kowalski']

  it('fixes a capitalised near-miss of exactly one name', () => {
    expect(respellFromScreen('Please ask Jon and Pria about it', names)).toBe(
      'Please ask John and Priya about it'
    )
    expect(respellFromScreen('Tell Mr Kowalsky now', names)).toBe('Tell Mr Kowalski now')
  })

  it('fixes casing for names with inner capitals', () => {
    expect(respellFromScreen('push it to github', names)).toBe('push it to GitHub')
  })

  it('leaves sentence starts, lowercase words and short words alone', () => {
    expect(respellFromScreen('Jon will call. Pria too', names)).toBe('Jon will call. Pria too')
    expect(respellFromScreen('join the call', names)).toBe('join the call')
    expect(respellFromScreen('ask Jo', names)).toBe('ask Jo')
  })

  it('does nothing without names', () => {
    expect(respellFromScreen('ask Jon', [])).toBe('ask Jon')
  })
})

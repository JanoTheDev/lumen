import { describe, expect, it } from 'vitest'
import { PLAIN_STYLE_LINE, answerStyle, phrase } from '../../src/main/a11y/phrases'

describe('status phrases (T18)', () => {
  it('fills placeholders and has a plainer simple-mode wording', () => {
    expect(phrase('yielded', false, { who: 'Dragon' })).toBe(
      'Dragon handles that. Say "Lumen" first to have Lumen do it'
    )
    expect(phrase('yielded', true, { who: 'Dragon' })).toBe(
      'Dragon did that. Say "Lumen" first for me'
    )
    expect(phrase('blocked', true).length).toBeLessThanOrEqual(phrase('blocked').length)
  })

  it('asks for the plain answer style only in simple mode', () => {
    expect(answerStyle({ a11y: { simpleMode: true } })).toBe('plain')
    expect(answerStyle({ a11y: { simpleMode: false } })).toBeUndefined()
    expect(PLAIN_STYLE_LINE).toMatch(/^style: plain/)
  })
})

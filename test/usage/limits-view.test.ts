import { describe, it, expect } from 'vitest'
import type { UsageLimitRow } from '../../src/shared/usage'
import {
  fieldToTokens,
  limitProgressText,
  tokensToField
} from '../../src/renderer/src/panel/settings/sections/usage-limits-view'

const base: UsageLimitRow = {
  kind: 'overall',
  id: '',
  name: 'All of Lumen',
  usd: 4.2,
  tokens: 120_000,
  ratio: 0,
  level: 'none'
}

describe('usage limits view', () => {
  it('shows spend against the caps', () => {
    expect(limitProgressText(base)).toBe('$4.20 · 120k tokens, no limit')
    expect(limitProgressText({ ...base, capUsd: 5, ratio: 0.84, level: 'warn' })).toBe(
      '$4.20 of $5.00 · nearly there'
    )
    expect(
      limitProgressText({ ...base, capUsd: 4, capTokens: 500_000, ratio: 1.05, level: 'paused' })
    ).toBe('$4.20 of $4.00 · 120k of 500k tokens · paused')
  })

  it('marks spend counted at the standard rate as estimated (review M5)', () => {
    expect(
      limitProgressText({ ...base, capUsd: 5, ratio: 0.84, level: 'warn', estimated: 3 })
    ).toBe(
      '$4.20 of $5.00 · nearly there · estimated: 3 calls without a known price counted at a standard rate'
    )
  })

  it('edits tokens in thousands', () => {
    expect(tokensToField(undefined)).toBe(0)
    expect(tokensToField(250_000)).toBe(250)
    expect(fieldToTokens(250)).toBe(250_000)
  })
})

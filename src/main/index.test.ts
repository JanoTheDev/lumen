import { describe, it, expect } from 'vitest'
import { ocrNorm, correctNthElement } from './nth-utils'
import type { ClaudeResponse } from './claude'

describe('ocrNorm', () => {
  it('lowercases', () => expect(ocrNorm('HELLO')).toBe('hello'))
  it('maps 0 → o', () => expect(ocrNorm('0xGF')).toBe('oxgf'))
  it('maps 1 → l', () => expect(ocrNorm('1nput')).toBe('lnput'))
  it('maps I → l', () => expect(ocrNorm('Input')).toBe('lnput'))
  it('handles mixed', () => expect(ocrNorm('0xGF_1I')).toBe('oxgf_ll'))
})

describe('correctNthElement', () => {
  function makeResult(n: number, text: string, summary: string): ClaudeResponse {
    return { mode: 'action', actions: [{ type: 'click_nth_element', text, n }], summary }
  }

  it('corrects n=6 to n=3 when OxGF is rows 4,5,6', () => {
    const r = makeResult(6, 'OxGF', 'Row 1: Stripe, Row 2: Jobbier, Row 3: Wolt, Row 4: OxGF, Row 5: OxGF, Row 6: OxGF')
    const fixed = correctNthElement(r)
    expect(fixed.mode === 'action' && (fixed.actions[0] as any).n).toBe(3)
  })

  it('corrects n=7 to n=4 when OxGF is rows 4-7', () => {
    const r = makeResult(7, 'OxGF', 'Row 1: Stripe, Row 2: Jobbier, Row 3: Wolt, Row 4: OxGF, Row 5: OxGF, Row 6: OxGF, Row 7: OxGF')
    const fixed = correctNthElement(r)
    expect(fixed.mode === 'action' && (fixed.actions[0] as any).n).toBe(4)
  })

  it('does not change already-correct n=3 (occurrence) when row 6 is 3rd OxGF', () => {
    const r = makeResult(3, 'OxGF', 'Row 1: Stripe, Row 2: Jobbier, Row 3: Wolt, Row 4: OxGF, Row 5: OxGF, Row 6: OxGF')
    const fixed = correctNthElement(r)
    // n=3 → look for row n=3 in OxGF rows [4,5,6] → not found → no correction
    expect(fixed.mode === 'action' && (fixed.actions[0] as any).n).toBe(3)
  })

  it('normalizes 0/O: text=0xGF matches OxGF rows', () => {
    const r = makeResult(5, '0xGF', 'Row 1: Stripe, Row 2: Jobbier, Row 3: Wolt, Row 4: OxGF, Row 5: OxGF')
    const fixed = correctNthElement(r)
    expect(fixed.mode === 'action' && (fixed.actions[0] as any).n).toBe(2)
  })

  it('no-ops when mode is not action', () => {
    const r: ClaudeResponse = { mode: 'answer', text: 'hello' }
    expect(correctNthElement(r)).toBe(r)
  })

  it('no-ops when no summary', () => {
    const r: ClaudeResponse = { mode: 'action', actions: [{ type: 'click_nth_element', text: 'OxGF', n: 6 }] }
    const fixed = correctNthElement(r)
    expect(fixed.mode === 'action' && (fixed.actions[0] as any).n).toBe(6)
  })

  it('corrects unique sender: n=2 for Jobbier at row 2 → n=1', () => {
    const r = makeResult(2, 'Jobbier', 'Row 1: Stripe, Row 2: Jobbier, Row 3: Wolt')
    const fixed = correctNthElement(r)
    expect(fixed.mode === 'action' && (fixed.actions[0] as any).n).toBe(1)
  })

  it('no-ops when row number not in summary', () => {
    const r = makeResult(10, 'OxGF', 'Row 1: Stripe, Row 2: OxGF, Row 3: OxGF')
    const fixed = correctNthElement(r)
    // row 10 not in summary → findIndex = -1 → no correction
    expect(fixed.mode === 'action' && (fixed.actions[0] as any).n).toBe(10)
  })
})

import { describe, it, expect } from 'vitest'
import { compareReading, ocrNorm, parseOrdinal, pickNth, sortReading } from '../src/main/query/nth'

describe('ocrNorm', () => {
  it('lowercases', () => expect(ocrNorm('HELLO')).toBe('hello'))
  it('maps 0 → o', () => expect(ocrNorm('0xGF')).toBe('oxgf'))
  it('maps 1 → l', () => expect(ocrNorm('1nput')).toBe('lnput'))
  it('maps I → l', () => expect(ocrNorm('Input')).toBe('lnput'))
  it('handles mixed', () => expect(ocrNorm('0xGF_1I')).toBe('oxgf_ll'))
})

describe('parseOrdinal', () => {
  it('reads words, numerals and last', () => {
    expect(parseOrdinal('third')).toBe(3)
    expect(parseOrdinal('Second')).toBe(2)
    expect(parseOrdinal('12th')).toBe(12)
    expect(parseOrdinal('1st')).toBe(1)
    expect(parseOrdinal('last')).toBe(-1)
    expect(parseOrdinal('button')).toBeNull()
  })
})

describe('reading order', () => {
  const r = (x: number, y: number, h = 20): { x: number; y: number; w: number; h: number } => ({
    x,
    y,
    w: 50,
    h
  })

  it('sorts rows top to bottom, then left to right within a row', () => {
    const items = [r(300, 102), r(10, 200), r(10, 100), r(500, 98)]
    expect(sortReading(items, (i) => i)).toEqual([r(10, 100), r(300, 102), r(500, 98), r(10, 200)])
  })

  it('treats boxes whose centres differ by half a height as different rows', () => {
    expect(compareReading(r(500, 100), r(10, 115))).toBeLessThan(0)
    expect(compareReading(r(500, 100), r(10, 105))).toBeGreaterThan(0)
  })

  it('picks the nth (1-based) or counts from the end', () => {
    expect(pickNth(['a', 'b', 'c'], 2)).toBe('b')
    expect(pickNth(['a', 'b', 'c'], -1)).toBe('c')
    expect(pickNth(['a'], 3)).toBeUndefined()
    expect(pickNth(['a'], 0)).toBeUndefined()
  })
})

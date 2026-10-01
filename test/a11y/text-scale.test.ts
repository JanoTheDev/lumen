import { describe, expect, it, vi } from 'vitest'
import {
  effectiveScale,
  onTextScaleChange,
  parseTextScale,
  setTextScale,
  textScaleFactor
} from '../../src/main/a11y/text-scale'

describe('Windows text size', () => {
  it('accepts whole percentages in 100-225 only', () => {
    expect(parseTextScale(150)).toBe(150)
    expect(parseTextScale(225)).toBe(225)
    expect(parseTextScale(50)).toBeNull()
    expect(parseTextScale(300)).toBeNull()
    expect(parseTextScale(150.5)).toBeNull()
    expect(parseTextScale('150')).toBeNull()
  })

  it('defaults to 100 % so the zoom is the UI scale alone', () => {
    expect(textScaleFactor()).toBe(100)
    expect(effectiveScale(1.4)).toBeCloseTo(1.4)
  })

  it('applies the agent value and notifies only on change', () => {
    const fn = vi.fn()
    const off = onTextScaleChange(fn)
    setTextScale(150)
    setTextScale(150)
    expect(textScaleFactor()).toBe(150)
    expect(effectiveScale(1)).toBeCloseTo(1.5)
    setTextScale('bogus')
    expect(textScaleFactor()).toBe(100)
    expect(fn.mock.calls).toEqual([[150], [100]])
    off()
  })
})

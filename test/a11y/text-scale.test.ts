import { describe, expect, it } from 'vitest'
import { effectiveScale, parseTextScale, textScaleFactor } from '../../src/main/a11y/text-scale'

describe('Windows text size', () => {
  it('parses the reg query output', () => {
    const out = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Accessibility',
      '    TextScaleFactor    REG_DWORD    0x96',
      ''
    ].join('\r\n')
    expect(parseTextScale(out)).toBe(150)
    expect(parseTextScale('    TextScaleFactor    REG_DWORD    0xe1')).toBe(225)
  })

  it('ignores a missing value and values outside 100-225', () => {
    expect(
      parseTextScale('ERROR: The system was unable to find the specified registry key')
    ).toBeNull()
    expect(parseTextScale('TextScaleFactor    REG_DWORD    0x32')).toBeNull()
    expect(parseTextScale('TextScaleFactor    REG_DWORD    0x12c')).toBeNull()
  })

  it('defaults to 100 % so the zoom is the UI scale alone', () => {
    expect(textScaleFactor()).toBe(100)
    expect(effectiveScale(1.4)).toBeCloseTo(1.4)
  })
})

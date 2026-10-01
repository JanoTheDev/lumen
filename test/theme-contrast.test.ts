import { describe, it, expect } from 'vitest'
import { ensureContrast, luminance, pickOnColor, ratio } from '../src/renderer/src/theme/contrast'
import {
  ACCENT_PRESETS,
  THEME_V1_TO_V2,
  buildPalette,
  type BaseThemeName
} from '../src/renderer/src/theme/themes'
import { resolveTheme, rootFontPx } from '../src/renderer/src/theme/apply'

const BASES: BaseThemeName[] = ['light', 'dark', 'high-contrast']

describe('contrast maths', () => {
  it('matches WCAG reference values', () => {
    expect(luminance('#FFFFFF')).toBeCloseTo(1, 5)
    expect(luminance('#000000')).toBeCloseTo(0, 5)
    expect(ratio('#000000', '#FFFFFF')).toBeCloseTo(21, 5)
    expect(ratio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2)
  })

  it('picks black on yellow and white on navy', () => {
    expect(pickOnColor('#FFFF00')).toBe('#000')
    expect(pickOnColor('#1B2A6B')).toBe('#fff')
  })

  it('nudges a low-contrast colour until it passes', () => {
    const fixed = ensureContrast('#888888', '#FFFFFF', 4.5)
    expect(ratio(fixed, '#FFFFFF')).toBeGreaterThanOrEqual(4.5)
    const light = ensureContrast('#333333', '#000000', 4.5)
    expect(ratio(light, '#000000')).toBeGreaterThanOrEqual(4.5)
  })

  it('keeps colours that already pass', () => {
    expect(ensureContrast('#000000', '#FFFFFF', 4.5)).toBe('#000000')
  })
})

describe('built-in themes', () => {
  for (const base of BASES) {
    for (const accent of Object.keys(ACCENT_PRESETS)) {
      it(`${base} + ${accent} meets AA`, () => {
        const { palette: p } = buildPalette(base, accent)
        expect(ratio(p.fg, p.surface)).toBeGreaterThanOrEqual(4.5)
        expect(ratio(p.fgMuted, p.surface)).toBeGreaterThanOrEqual(4.5)
        expect(ratio(p.fg, p.bg)).toBeGreaterThanOrEqual(4.5)
        expect(ratio(p.accent, p.surface)).toBeGreaterThanOrEqual(3)
        expect(ratio(p.border, p.bg)).toBeGreaterThanOrEqual(3)
        expect(
          ratio(p.onAccent === '#000' ? '#000000' : '#FFFFFF', p.accent)
        ).toBeGreaterThanOrEqual(4.5)
        for (const s of [p.success, p.warning, p.danger]) {
          expect(ratio(s, p.surface)).toBeGreaterThanOrEqual(4.5)
        }
      })
    }
  }

  it('high contrast uses a yellow accent with black text on it', () => {
    const { palette } = buildPalette('high-contrast')
    expect(palette.accent).toBe('#FFFF00')
    expect(palette.onAccent).toBe('#000')
    expect(palette.shadow).toBe('none')
  })
})

describe('custom theme', () => {
  it('fixes an unreadable foreground and reports it', () => {
    const r = buildPalette('custom', undefined, {
      background: '#202020',
      foreground: '#303030',
      accent: '#222222'
    })
    expect(r.adjusted).toBe(true)
    expect(ratio(r.palette.fg, r.palette.surface)).toBeGreaterThanOrEqual(4.5)
    expect(ratio(r.palette.accent, r.palette.surface)).toBeGreaterThanOrEqual(3)
  })

  it('leaves a readable custom palette alone', () => {
    const r = buildPalette('custom', undefined, {
      background: '#101010',
      foreground: '#F0F0F0',
      accent: '#2F6FEB'
    })
    expect(r.adjusted).toBe(false)
  })
})

describe('resolveTheme', () => {
  const env = { prefersDark: true, prefersContrast: false }

  it('maps v1 colour themes to dark plus an accent', () => {
    for (const [v1, v2] of Object.entries(THEME_V1_TO_V2)) {
      const t = resolveTheme({ theme: v1 }, env)
      expect(t.name).toBe(v2.theme)
      expect(t.palette.accent).toBe(buildPalette('dark', v2.accent).palette.accent)
    }
  })

  it('follows the OS for system, including high contrast', () => {
    expect(resolveTheme({ theme: 'system' }, env).name).toBe('dark')
    expect(
      resolveTheme({ theme: 'system' }, { prefersDark: false, prefersContrast: false }).name
    ).toBe('light')
    expect(
      resolveTheme({ theme: 'system' }, { prefersDark: true, prefersContrast: true }).name
    ).toBe('high-contrast')
  })

  it('forces high contrast when the a11y setting is on', () => {
    expect(resolveTheme({ theme: 'light', a11y: { contrast: 'on' } }, env).name).toBe(
      'high-contrast'
    )
  })

  it('scales the root font by uiScale and the Windows text size', () => {
    expect(rootFontPx({})).toBe(16)
    expect(rootFontPx({ a11y: { uiScale: 2 } })).toBe(32)
    expect(rootFontPx({ a11y: { uiScale: 5 } })).toBe(32)
    expect(rootFontPx({ a11y: { uiScale: 1 }, textScaleFactor: 150 })).toBe(24)
    expect(rootFontPx({ a11y: { followWindowsText: false }, textScaleFactor: 150 })).toBe(16)
  })
})

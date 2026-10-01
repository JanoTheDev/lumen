// Built-in themes, accent presets and the v1 theme mapping. buildPalette() derives the
// accent-dependent roles and enforces contrast, so every theme passes WCAG AA.
import { ensureContrast, luminance, mix, pickOnColor } from './contrast'
import type { Palette } from './tokens'

export type BaseThemeName = 'light' | 'dark' | 'high-contrast'
export type ThemeChoice = 'system' | BaseThemeName | 'custom'

export const ACCENT_PRESETS = {
  blue: { label: 'Blue', hex: '#2F6FEB' },
  teal: { label: 'Teal', hex: '#0F8C83' },
  green: { label: 'Green', hex: '#2E8540' },
  orange: { label: 'Orange', hex: '#C75300' },
  pink: { label: 'Pink', hex: '#C2296E' },
  violet: { label: 'Violet', hex: '#6B4FD8' },
  yellow: { label: 'Yellow', hex: '#FFD400' }
} as const

export type AccentPreset = keyof typeof ACCENT_PRESETS
export const DEFAULT_ACCENT: AccentPreset = 'blue'

/** Config v1 themes that became accents. 01 uses this for the v1 → v2 migration. */
export const THEME_V1_TO_V2: Record<string, { theme: BaseThemeName; accent: AccentPreset }> = {
  ocean: { theme: 'dark', accent: 'teal' },
  forest: { theme: 'dark', accent: 'green' },
  sunset: { theme: 'dark', accent: 'orange' },
  midnight: { theme: 'dark', accent: 'violet' }
}

type BaseColors = Pick<
  Palette,
  | 'bg'
  | 'surface'
  | 'surfaceRaised'
  | 'surfaceSunken'
  | 'fg'
  | 'fgMuted'
  | 'border'
  | 'borderSubtle'
  | 'success'
  | 'warning'
  | 'danger'
  | 'scrim'
  | 'shadow'
>

const HALO = { ringHaloOuter: 'rgba(0, 0, 0, 0.85)', ringHaloInner: 'rgba(255, 255, 255, 0.95)' }

export const BASE_THEMES: Record<BaseThemeName, BaseColors> = {
  dark: {
    bg: '#111318',
    surface: '#1B1E24',
    surfaceRaised: '#252930',
    surfaceSunken: '#0D0F13',
    fg: '#ECEEF2',
    fgMuted: '#A9AFBA',
    border: '#6B7280',
    borderSubtle: '#30343C',
    success: '#4CC38A',
    warning: '#E8B339',
    danger: '#F2707A',
    scrim: 'rgba(0, 0, 0, 0.55)',
    shadow: '0 8px 24px rgba(0, 0, 0, 0.28), 0 0 0 1px var(--border-subtle)'
  },
  light: {
    bg: '#F3F4F6',
    surface: '#FFFFFF',
    surfaceRaised: '#FFFFFF',
    surfaceSunken: '#F3F4F6',
    fg: '#15171C',
    fgMuted: '#555B66',
    border: '#7A818C',
    borderSubtle: '#E2E5EA',
    success: '#1A7F37',
    warning: '#8A5A00',
    danger: '#CF222E',
    scrim: 'rgba(0, 0, 0, 0.55)',
    shadow: '0 8px 24px rgba(0, 0, 0, 0.14), 0 0 0 1px var(--border-subtle)'
  },
  'high-contrast': {
    bg: '#000000',
    surface: '#000000',
    surfaceRaised: '#000000',
    surfaceSunken: '#000000',
    fg: '#FFFFFF',
    fgMuted: '#FFFFFF',
    border: '#FFFFFF',
    borderSubtle: '#FFFFFF',
    success: '#3FF23F',
    warning: '#FFD400',
    danger: '#FF7A7A',
    scrim: 'rgba(0, 0, 0, 0.75)',
    shadow: 'none'
  }
}

export interface CustomColors {
  accent?: string
  background?: string
  foreground?: string
}

export interface BuiltPalette {
  palette: Palette
  /** True when a user colour had to be shifted to stay readable. */
  adjusted: boolean
}

function customBase(c: CustomColors): BaseColors {
  const bg = c.background ?? BASE_THEMES.dark.bg
  const dark = luminance(bg) < 0.18
  const base = BASE_THEMES[dark ? 'dark' : 'light']
  const fg = c.foreground ?? base.fg
  return {
    ...base,
    bg,
    surface: mix(fg, bg, 0.04),
    surfaceRaised: mix(fg, bg, 0.08),
    surfaceSunken: mix('#000000', bg, dark ? 0.2 : 0.04),
    fg,
    fgMuted: mix(fg, bg, 0.72),
    border: mix(fg, bg, 0.5),
    borderSubtle: mix(fg, bg, 0.14)
  }
}

/** Resolves an accent preset id or hex string. */
export function accentHex(accent: string | undefined, theme: BaseThemeName): string {
  if (accent && accent in ACCENT_PRESETS) return ACCENT_PRESETS[accent as AccentPreset].hex
  if (accent && /^#[0-9a-f]{6}$/i.test(accent)) return accent.toUpperCase()
  return theme === 'high-contrast' ? '#FFFF00' : ACCENT_PRESETS[DEFAULT_ACCENT].hex
}

export function buildPalette(
  theme: BaseThemeName | 'custom',
  accent?: string,
  custom: CustomColors = {}
): BuiltPalette {
  const base = theme === 'custom' ? customBase(custom) : BASE_THEMES[theme]
  const baseName: BaseThemeName =
    theme === 'custom' ? (luminance(base.bg) < 0.18 ? 'dark' : 'light') : theme
  const rawAccent = accentHex(theme === 'custom' ? (custom.accent ?? accent) : accent, baseName)

  const fg = ensureContrast(base.fg, base.surface, 4.5)
  const fgMuted = ensureContrast(base.fgMuted, base.surface, 4.5)
  const border = ensureContrast(base.border, base.bg, 3)
  // Accent must read against both the surface and the page background.
  const accentOnSurface = ensureContrast(rawAccent, base.surface, 3)
  const accentColor = ensureContrast(accentOnSurface, base.bg, 3)
  const status = (c: string): string => ensureContrast(c, base.surface, 4.5)
  const success = status(base.success)
  const warning = status(base.warning)
  const danger = status(base.danger)

  const adjusted =
    theme === 'custom' &&
    (fg.toUpperCase() !== base.fg.toUpperCase() ||
      accentColor.toUpperCase() !== rawAccent.toUpperCase())

  return {
    adjusted,
    palette: {
      ...base,
      ...HALO,
      fg,
      fgMuted,
      border,
      accent: accentColor,
      onAccent: pickOnColor(accentColor),
      accentSoft: mix(accentColor, base.surface, 0.16),
      success,
      onSuccess: pickOnColor(success),
      warning,
      onWarning: pickOnColor(warning),
      danger,
      onDanger: pickOnColor(danger),
      focus: accentColor
    }
  }
}

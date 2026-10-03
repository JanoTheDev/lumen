// Design tokens. Colours live in themes.ts; everything else is fixed here and written to
// :root by applyTheme() so every window shares one source.

export interface Palette {
  bg: string
  surface: string
  surfaceRaised: string
  surfaceSunken: string
  fg: string
  fgMuted: string
  /** Input and control borders (≥ 3:1 against bg). */
  border: string
  /** Decorative dividers, exempt from the 3:1 rule. */
  borderSubtle: string
  accent: string
  onAccent: string
  accentSoft: string
  success: string
  onSuccess: string
  warning: string
  onWarning: string
  danger: string
  onDanger: string
  focus: string
  scrim: string
  ringHaloOuter: string
  ringHaloInner: string
  shadow: string
}

export const COLOR_VARS: Record<keyof Palette, string> = {
  bg: '--bg',
  surface: '--surface',
  surfaceRaised: '--surface-raised',
  surfaceSunken: '--surface-sunken',
  fg: '--fg',
  fgMuted: '--fg-muted',
  border: '--border',
  borderSubtle: '--border-subtle',
  accent: '--accent',
  onAccent: '--on-accent',
  accentSoft: '--accent-soft',
  success: '--success',
  onSuccess: '--on-success',
  warning: '--warning',
  onWarning: '--on-warning',
  danger: '--danger',
  onDanger: '--on-danger',
  focus: '--focus',
  scrim: '--scrim',
  ringHaloOuter: '--ring-halo-outer',
  ringHaloInner: '--ring-halo-inner',
  shadow: '--shadow'
}

/** Non-colour tokens. Sizes are rem so they follow the root font size (uiScale). */
export const STATIC_TOKENS: Record<string, string> = {
  '--font-text': '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
  '--font-display': '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif',
  '--font-mono': '"Cascadia Mono", Consolas, monospace',
  '--text-sm': '0.875rem',
  '--text-md': '1rem',
  '--text-lg': '1.125rem',
  '--text-xl': '1.375rem',
  '--weight-regular': '400',
  '--weight-strong': '600',
  '--leading-body': '1.45',
  '--leading-heading': '1.2',
  '--space-1': '0.25rem',
  '--space-2': '0.5rem',
  '--space-3': '0.75rem',
  '--space-4': '1rem',
  '--space-5': '1.25rem',
  '--space-6': '1.5rem',
  '--space-7': '2rem',
  '--space-8': '2.5rem',
  '--radius-xs': '0.375rem',
  '--radius-sm': '0.5rem',
  '--radius-md': '0.75rem',
  '--radius-lg': '1rem',
  '--radius-pill': '999px',
  '--dur-instant': '80ms',
  '--dur-fast': '140ms',
  '--dur-base': '200ms',
  '--dur-slow': '260ms',
  '--ease-out': 'cubic-bezier(0.2, 0, 0, 1)',
  '--ease-in': 'cubic-bezier(0.4, 0, 1, 1)',
  '--ease-in-out': 'cubic-bezier(0.4, 0, 0.2, 1)',
  '--icon-size': '1.25rem',
  '--icon-stroke': '1.75'
}

/** Base root font size in px before uiScale and the Windows text size factor. */
export const BASE_FONT_PX = 16
export const UI_SCALE_MIN = 0.75
export const UI_SCALE_MAX = 2

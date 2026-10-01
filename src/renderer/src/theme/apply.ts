// Turns the saved config into CSS custom properties on :root. Every window calls
// bootstrapTheme() once; it re-applies on settings:changed and OS theme changes.
import {
  THEME_V1_TO_V2,
  buildPalette,
  type BaseThemeName,
  type BuiltPalette,
  type CustomColors
} from './themes'
import { BASE_FONT_PX, COLOR_VARS, STATIC_TOKENS, UI_SCALE_MAX, UI_SCALE_MIN } from './tokens'
import { springCss } from '../ui/motion'

// CSS transitions that should feel like springs use these (computed once).
const SPRING_VARS: Record<string, string> = (() => {
  const out: Record<string, string> = {}
  for (const name of ['snappy', 'glide'] as const) {
    const { easing, durationMs } = springCss(name)
    out[`--spring-${name}`] = easing
    out[`--spring-${name}-dur`] = `${durationMs}ms`
  }
  return out
})()

/** The config fields the theme engine reads. Everything is optional so old configs work. */
export interface ThemeConfig {
  theme?: string
  accent?: string
  themeCustom?: CustomColors
  a11y?: {
    uiScale?: number
    reduceMotion?: 'system' | 'on' | 'off'
    contrast?: 'system' | 'on' | 'off'
    followWindowsText?: boolean
  }
  /** Windows Accessibility → Text size (100–225), supplied by main when available. */
  textScaleFactor?: number
}

export interface ThemeEnv {
  prefersDark: boolean
  prefersContrast: boolean
}

export interface ResolvedTheme extends BuiltPalette {
  name: BaseThemeName | 'custom'
  reduceMotion: 'system' | 'on' | 'off'
  fontPx: number
}

export interface ApplyOptions {
  /**
   * Scale the root font size by uiScale. Off for windows that main already zooms with
   * setZoomFactor, so they are not scaled twice.
   */
  scaleText?: boolean
}

export function clampUiScale(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 1
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, n))
}

export function rootFontPx(cfg: ThemeConfig): number {
  const follow = cfg.a11y?.followWindowsText !== false
  const tsf = follow && cfg.textScaleFactor ? cfg.textScaleFactor / 100 : 1
  return BASE_FONT_PX * clampUiScale(cfg.a11y?.uiScale) * Math.min(2.25, Math.max(1, tsf))
}

export function resolveTheme(cfg: ThemeConfig, env: ThemeEnv): ResolvedTheme {
  let name = cfg.theme ?? 'system'
  let accent = cfg.accent
  const legacy = THEME_V1_TO_V2[name]
  if (legacy) {
    name = legacy.theme
    accent = accent ?? legacy.accent
  }
  const contrast = cfg.a11y?.contrast ?? 'system'
  let base: BaseThemeName | 'custom'
  if (contrast === 'on' || (contrast === 'system' && env.prefersContrast && name === 'system')) {
    base = 'high-contrast'
  } else if (name === 'light' || name === 'dark' || name === 'high-contrast') {
    base = name
  } else if (name === 'custom') {
    base = 'custom'
  } else {
    base = env.prefersDark ? 'dark' : 'light'
  }
  // High contrast always uses its own yellow accent.
  if (base === 'high-contrast') accent = undefined
  return {
    ...buildPalette(base, accent, cfg.themeCustom),
    name: base,
    reduceMotion: cfg.a11y?.reduceMotion ?? 'system',
    fontPx: rootFontPx(cfg)
  }
}

// Old windows read --ai-*; keep them fed from the same palette until they are replaced.
function legacyAliases(p: BuiltPalette['palette']): Record<string, string> {
  return {
    '--ai-accent': p.accent,
    '--ai-background': p.bg,
    '--ai-foreground': p.fg,
    '--ai-muted': p.fgMuted,
    '--ai-surface': p.surface,
    '--ai-border': p.borderSubtle,
    '--ai-success': p.success,
    '--ai-error': p.danger
  }
}

/** Writes the resolved theme to :root (or `root`). */
export function applyResolved(
  t: ResolvedTheme,
  opts: ApplyOptions = {},
  root: HTMLElement = document.documentElement
): void {
  const vars: Record<string, string> = {
    ...STATIC_TOKENS,
    ...SPRING_VARS,
    ...legacyAliases(t.palette)
  }
  for (const [key, cssVar] of Object.entries(COLOR_VARS)) {
    vars[cssVar] = t.palette[key as keyof typeof COLOR_VARS]
  }
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
  root.style.fontSize = opts.scaleText ? `${t.fontPx}px` : `${BASE_FONT_PX}px`
  root.dataset.theme = t.name
  root.style.colorScheme = t.name === 'light' ? 'light' : 'dark'
  if (t.reduceMotion === 'system') delete root.dataset.reduceMotion
  else root.dataset.reduceMotion = t.reduceMotion === 'on' ? 'true' : 'false'
}

function readEnv(): ThemeEnv {
  const mq = (q: string): boolean =>
    typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(q).matches
  return {
    prefersDark: mq('(prefers-color-scheme: dark)'),
    prefersContrast: mq('(prefers-contrast: more)') || mq('(forced-colors: active)')
  }
}

export function applyTheme(cfg: ThemeConfig, opts: ApplyOptions = {}): ResolvedTheme {
  const t = resolveTheme(cfg, readEnv())
  applyResolved(t, opts)
  return t
}

/**
 * Applies the theme now, then keeps it in sync with config and OS changes.
 * Returns an unsubscribe function.
 */
export function bootstrapTheme(opts: ApplyOptions = {}): () => void {
  let current: ThemeConfig = {}
  const apply = (cfg: ThemeConfig): void => {
    current = cfg
    applyTheme(cfg, opts)
  }
  apply({})
  const lumen = typeof window !== 'undefined' ? window.lumen : undefined
  if (!lumen) return () => {}
  lumen
    .invoke('settings:get')
    .then((c) => apply(c as ThemeConfig))
    .catch(() => {})
  const unsub = lumen.on('settings:changed', (c) => apply(c as ThemeConfig))
  const queries = ['(prefers-color-scheme: dark)', '(prefers-contrast: more)']
    .map((q) => window.matchMedia?.(q))
    .filter((m): m is MediaQueryList => !!m)
  const onOs = (): void => apply(current)
  queries.forEach((m) => m.addEventListener('change', onOs))
  return () => {
    unsub()
    queries.forEach((m) => m.removeEventListener('change', onOs))
  }
}

export type ThemeName = 'dark' | 'light' | 'high-contrast' | 'ocean' | 'forest' | 'sunset' | 'midnight' | 'custom'

export interface ThemeVars {
  '--ai-accent': string
  '--ai-background': string
  '--ai-foreground': string
  '--ai-muted': string
  '--ai-surface': string
  '--ai-border': string
  '--ai-success': string
  '--ai-error': string
  '--ai-opacity': string
  '--ai-blur': string
}

export const THEMES: Record<Exclude<ThemeName, 'custom'>, ThemeVars> = {
  dark: {
    '--ai-accent': '#5b8cff',
    '--ai-background': '#0d0f14',
    '--ai-foreground': '#e6e8ee',
    '--ai-muted': '#8a8f9c',
    '--ai-surface': '#1a1d24',
    '--ai-border': '#2a2e38',
    '--ai-success': '#4ade80',
    '--ai-error': '#f87171',
    '--ai-opacity': '0.92',
    '--ai-blur': '14px',
  },
  light: {
    '--ai-accent': '#2563eb',
    '--ai-background': '#ffffff',
    '--ai-foreground': '#0f172a',
    '--ai-muted': '#64748b',
    '--ai-surface': '#f1f5f9',
    '--ai-border': '#e2e8f0',
    '--ai-success': '#16a34a',
    '--ai-error': '#dc2626',
    '--ai-opacity': '0.95',
    '--ai-blur': '8px',
  },
  'high-contrast': {
    '--ai-accent': '#ffff00',
    '--ai-background': '#000000',
    '--ai-foreground': '#ffffff',
    '--ai-muted': '#cccccc',
    '--ai-surface': '#000000',
    '--ai-border': '#ffffff',
    '--ai-success': '#00ff00',
    '--ai-error': '#ff0000',
    '--ai-opacity': '1',
    '--ai-blur': '0px',
  },
  ocean: {
    '--ai-accent': '#06b6d4',
    '--ai-background': '#031728',
    '--ai-foreground': '#e0f2fe',
    '--ai-muted': '#7dd3fc',
    '--ai-surface': '#0c2a42',
    '--ai-border': '#164e63',
    '--ai-success': '#22d3ee',
    '--ai-error': '#fb7185',
    '--ai-opacity': '0.92',
    '--ai-blur': '14px',
  },
  forest: {
    '--ai-accent': '#22c55e',
    '--ai-background': '#0a1f14',
    '--ai-foreground': '#dcfce7',
    '--ai-muted': '#86efac',
    '--ai-surface': '#132e1d',
    '--ai-border': '#166534',
    '--ai-success': '#4ade80',
    '--ai-error': '#f87171',
    '--ai-opacity': '0.92',
    '--ai-blur': '14px',
  },
  sunset: {
    '--ai-accent': '#f97316',
    '--ai-background': '#1f1209',
    '--ai-foreground': '#fed7aa',
    '--ai-muted': '#fdba74',
    '--ai-surface': '#2c1b0e',
    '--ai-border': '#7c2d12',
    '--ai-success': '#fbbf24',
    '--ai-error': '#ef4444',
    '--ai-opacity': '0.92',
    '--ai-blur': '14px',
  },
  midnight: {
    '--ai-accent': '#a855f7',
    '--ai-background': '#0f0a1f',
    '--ai-foreground': '#ede9fe',
    '--ai-muted': '#c4b5fd',
    '--ai-surface': '#1c1233',
    '--ai-border': '#4c1d95',
    '--ai-success': '#4ade80',
    '--ai-error': '#f87171',
    '--ai-opacity': '0.92',
    '--ai-blur': '14px',
  },
}

export function applyTheme(name: ThemeName, custom?: Partial<ThemeVars>): void {
  const vars = name === 'custom' && custom ? { ...THEMES.dark, ...custom } : THEMES[name as Exclude<ThemeName, 'custom'>] ?? THEMES.dark
  const root = document.documentElement
  for (const [k, v] of Object.entries(vars)) {
    root.style.setProperty(k, v)
  }
  root.setAttribute('data-theme', name)
}

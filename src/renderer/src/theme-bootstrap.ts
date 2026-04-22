import { applyTheme, type ThemeName } from './themes'

interface ThemeCustom {
  accent: string
  background: string
  foreground: string
  opacity?: number
  blur?: number
}
interface ThemeCfg { theme: ThemeName; themeCustom?: ThemeCustom }
interface WindowApi {
  getConfig?: () => Promise<ThemeCfg>
  onConfigChanged?: (cb: (cfg: ThemeCfg) => void) => void
}

function customToVars(c: ThemeCustom): Record<string, string> {
  return {
    '--ai-accent': c.accent,
    '--ai-background': c.background,
    '--ai-foreground': c.foreground,
    ...(c.opacity != null ? { '--ai-opacity': String(c.opacity) } : {}),
    ...(c.blur != null ? { '--ai-blur': `${c.blur}px` } : {}),
  }
}

export function bootstrapTheme(): void {
  const api = (window as unknown as { api?: WindowApi }).api
  if (!api?.getConfig) { applyTheme('dark'); return }
  const apply = (cfg: ThemeCfg): void => {
    applyTheme(cfg.theme, cfg.theme === 'custom' && cfg.themeCustom ? customToVars(cfg.themeCustom) : undefined)
  }
  api.getConfig().then(apply).catch(() => applyTheme('dark'))
  api.onConfigChanged?.(apply)
}

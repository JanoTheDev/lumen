interface DwellConfig {
  theme?: string
  themeCustom?: { accent?: string }
}
interface DwellData {
  x: number
  y: number
  progress: number
  active: boolean
}
interface DwellApi {
  getConfig?: () => Promise<unknown>
  onConfigChanged?: (cb: (cfg: unknown) => void) => void
  onDwellProgress?: (cb: (data: DwellData) => void) => void
}

const api = (window as unknown as { api?: DwellApi }).api

const ring = document.getElementById('ring') as HTMLElement
const progEl = ring.querySelector('circle.progress') as SVGCircleElement
const CIRCUM = 2 * Math.PI * 18 // ~113.1

// Theme vars: inherit from config
api
  ?.getConfig?.()
  .then((raw) => {
    const cfg = raw as DwellConfig | undefined
    applyTheme(cfg?.theme, cfg?.themeCustom)
  })
  .catch(() => {})
api?.onConfigChanged?.((raw) => {
  const cfg = raw as DwellConfig | undefined
  applyTheme(cfg?.theme, cfg?.themeCustom)
})

const THEME_ACCENTS: Record<string, string> = {
  dark: '#5b8cff',
  light: '#2563eb',
  'high-contrast': '#ffff00',
  ocean: '#06b6d4',
  forest: '#22c55e',
  sunset: '#f97316',
  midnight: '#a855f7'
}
function applyTheme(name?: string, custom?: { accent?: string }): void {
  const r = document.documentElement
  if (name === 'custom' && custom?.accent) {
    r.style.setProperty('--ai-accent', custom.accent)
    return
  }
  const a = (name !== undefined ? THEME_ACCENTS[name] : undefined) ?? THEME_ACCENTS.dark
  r.style.setProperty('--ai-accent', a)
}

let hideTimer: ReturnType<typeof setTimeout> | undefined
function setProgress({ x, y, progress, active }: DwellData): void {
  clearTimeout(hideTimer)
  ring.style.left = x + 'px'
  ring.style.top = y + 'px'
  const offset = CIRCUM * (1 - Math.max(0, Math.min(1, progress)))
  progEl.style.strokeDashoffset = String(offset)
  if (progress >= 0.999) {
    ring.classList.remove('active')
    ring.classList.add('flash')
    setTimeout(() => ring.classList.remove('flash'), 300)
  } else if (active) {
    ring.classList.remove('flash')
    ring.classList.add('active')
  } else {
    // Cursor moved — fade quickly
    hideTimer = setTimeout(() => {
      ring.classList.remove('active')
      progEl.style.strokeDashoffset = String(CIRCUM)
    }, 80)
  }
}

api?.onDwellProgress?.((data) => setProgress(data))

export {}

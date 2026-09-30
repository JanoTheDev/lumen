interface ThemeCustom { background: string; foreground: string; accent: string }
interface AnswerConfig { theme?: string; themeCustom?: ThemeCustom; answerAutoCloseMs?: number }
interface AnswerApi {
  getConfig?: () => Promise<unknown>
  onConfigChanged?: (cb: (cfg: unknown) => void) => void
  hideAnswerOverlay?: () => void
  resizeAnswerOverlay?: (h: number) => void
  onShowAnswer?: (cb: (text: string) => void) => void
  onTtsAudio?: (cb: (p: { mime: string; data: string }) => void) => void
  openLink?: (url: string) => void
}

const api = (window as unknown as { api?: AnswerApi }).api

let CLOSE_MS = 10000

const THEME_MAP: Record<string, { bg: string; fg: string; acc: string }> = {
  dark:            { bg: '#0d0f14', fg: '#e6e8ee', acc: '#5b8cff' },
  light:           { bg: '#ffffff', fg: '#0f172a', acc: '#2563eb' },
  'high-contrast': { bg: '#000000', fg: '#ffffff', acc: '#ffff00' },
  ocean:           { bg: '#031728', fg: '#e0f2fe', acc: '#06b6d4' },
  forest:          { bg: '#0a1f14', fg: '#dcfce7', acc: '#22c55e' },
  sunset:          { bg: '#1f1209', fg: '#fed7aa', acc: '#f97316' },
  midnight:        { bg: '#0f0a1f', fg: '#ede9fe', acc: '#a855f7' }
}
function applyThemeVars(name?: string, custom?: ThemeCustom): void {
  const r = document.documentElement
  if (name === 'custom' && custom) {
    r.style.setProperty('--ai-background', custom.background)
    r.style.setProperty('--ai-foreground', custom.foreground)
    r.style.setProperty('--ai-accent', custom.accent)
    return
  }
  const t = (name && THEME_MAP[name]) || THEME_MAP.dark
  r.style.setProperty('--ai-background', t.bg)
  r.style.setProperty('--ai-foreground', t.fg)
  r.style.setProperty('--ai-accent', t.acc)
}
async function loadThemeAndConfig(): Promise<void> {
  try {
    const cfg = (await api?.getConfig?.()) as AnswerConfig | undefined
    if (cfg) {
      applyThemeVars(cfg.theme, cfg.themeCustom)
      if (cfg.answerAutoCloseMs) CLOSE_MS = cfg.answerAutoCloseMs
    }
    api?.onConfigChanged?.((raw) => {
      const c = raw as AnswerConfig
      applyThemeVars(c.theme, c.themeCustom)
      if (c.answerAutoCloseMs) CLOSE_MS = c.answerAutoCloseMs
    })
  } catch (e) { applyThemeVars('dark') }
}
loadThemeAndConfig()

const card = document.getElementById('card') as HTMLElement
const textEl = document.getElementById('text') as HTMLElement
const barEl = document.getElementById('bar') as HTMLElement
let closeTimer: ReturnType<typeof setTimeout> | undefined
let countdownInterval: ReturnType<typeof setInterval> | undefined

function dismiss(): void {
  clearTimeout(closeTimer)
  clearInterval(countdownInterval)
  card.classList.remove('visible')
  setTimeout(() => api?.hideAnswerOverlay?.(), 220)
}

card.addEventListener('click', dismiss)

textEl.addEventListener('click', (e) => {
  const target = e.target as Element | null
  const link = target?.closest?.('a[href]') as HTMLAnchorElement | null
  if (!link) return
  e.preventDefault()
  api?.openLink?.(link.href)
})

function startAutoClose(): void {
  clearTimeout(closeTimer)
  clearInterval(countdownInterval)
  let remaining = CLOSE_MS / 1000
  barEl.style.width = '100%'
  countdownInterval = setInterval(() => {
    remaining -= 1
    barEl.style.width = ((remaining / (CLOSE_MS / 1000)) * 100) + '%'
    if (remaining <= 0) clearInterval(countdownInterval)
  }, 1000)
  closeTimer = setTimeout(dismiss, CLOSE_MS)
}

function renderMarkdown(raw: string): string {
  return raw
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>')
}

function showAnswer(text: string): void {
  textEl.innerHTML = renderMarkdown(text)
  card.classList.add('visible')
  startAutoClose()
  requestAnimationFrame(() => {
    const h = card.offsetHeight + 16
    api?.resizeAnswerOverlay?.(h)
  })
}

if (api?.onShowAnswer) api.onShowAnswer(showAnswer)

// TTS playback
let currentAudio: HTMLAudioElement | null = null
api?.onTtsAudio?.(({ mime, data }) => {
  try {
    if (currentAudio) { currentAudio.pause(); currentAudio = null }
    const a = new Audio(`data:${mime};base64,${data}`)
    currentAudio = a
    a.play().catch(() => {})
  } catch (e) {}
})

export {}

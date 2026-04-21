import './globals.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { applyTheme, type ThemeName } from './themes'

interface WindowApi {
  getConfig?: () => Promise<{ theme: ThemeName }>
  onConfigChanged?: (cb: (cfg: { theme: ThemeName }) => void) => void
}

const api = (window as unknown as { api?: WindowApi }).api
if (api?.getConfig) {
  api.getConfig().then(cfg => applyTheme(cfg.theme)).catch(() => applyTheme('dark'))
  api.onConfigChanged?.(cfg => applyTheme(cfg.theme))
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)

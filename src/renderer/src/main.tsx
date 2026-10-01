import './globals.css'
import './theme/theme.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { bootstrapTheme } from './theme/apply'

// The HUD is zoomed by main (setZoomFactor), so the root font size stays at 16px.
bootstrapTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)

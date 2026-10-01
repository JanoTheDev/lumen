import '../theme/theme.css'
import '../ui/ui.css'
import '../panel/panel.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../panel/App'
import { bootstrapTheme } from '../theme/apply'

// The settings window is not zoomed by main, so uiScale goes through the root font size.
bootstrapTheme({ scaleText: true })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)

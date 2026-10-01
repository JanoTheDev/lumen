import '../theme/theme.css'
import '../ui/ui.css'
import './panel.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { bootstrapTheme } from '../theme/apply'

// The panel window is not zoomed by main, so uiScale goes through the root font size.
bootstrapTheme({ scaleText: true })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)

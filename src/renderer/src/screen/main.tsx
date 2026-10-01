import '../theme/theme.css'
import './screen.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ScreenApp } from './ScreenApp'
import { bootstrapTheme } from '../theme/apply'

// One window per display, never zoomed: SVG units are this display's DIP; labels follow uiScale.
bootstrapTheme({ scaleText: true })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ScreenApp />
  </StrictMode>
)

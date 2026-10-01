import '../theme/theme.css'
import '../ui/ui.css'
import './assistant.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AssistantApp } from './AssistantApp'
import { bootstrapTheme } from '../theme/apply'

// Zoomed by main (setZoomFactor), so the root font size stays at 16px.
bootstrapTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AssistantApp />
  </StrictMode>
)

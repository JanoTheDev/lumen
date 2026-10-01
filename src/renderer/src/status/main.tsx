import '../theme/theme.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { StatusApp } from './StatusApp'
import { bootstrapTheme } from '../theme/apply'

bootstrapTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StatusApp />
  </StrictMode>
)

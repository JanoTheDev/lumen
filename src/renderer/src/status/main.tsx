import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { StatusApp } from './StatusApp'
import { bootstrapTheme } from '../theme-bootstrap'

bootstrapTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StatusApp />
  </StrictMode>
)

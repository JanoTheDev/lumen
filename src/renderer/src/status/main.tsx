import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { StatusApp } from './StatusApp'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StatusApp />
  </StrictMode>
)

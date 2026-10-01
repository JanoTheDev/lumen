import '../theme/theme.css'
import '../ui/ui.css'
import './a11y-windows.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { bootstrapTheme } from '../theme/apply'
import { CommandSheet } from './CommandSheet'
import { DwellPalette } from './DwellPalette'
import { ScanKeyboard } from './ScanKeyboard'

// Small a11y windows (06): the "what can I say" sheet, the dwell click-type palette and the
// scan keyboard.
// Main zooms both by uiScale, so the root font size is not scaled again here.
bootstrapTheme()

const route = location.hash.replace(/^#\/?/, '')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {route === 'palette' ? (
      <DwellPalette />
    ) : route === 'keyboard' ? (
      <ScanKeyboard />
    ) : (
      <CommandSheet />
    )}
  </StrictMode>
)

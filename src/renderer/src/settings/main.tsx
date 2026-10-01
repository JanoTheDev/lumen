import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SettingsApp } from './SettingsApp'
import { Gallery } from '../ui/Gallery'
import './settings.css'
import '../theme/theme.css'
import '../ui/ui.css'

const showGallery = import.meta.env.DEV && location.hash.startsWith('#/gallery')

createRoot(document.getElementById('root')!).render(
  <StrictMode>{showGallery ? <Gallery /> : <SettingsApp />}</StrictMode>
)

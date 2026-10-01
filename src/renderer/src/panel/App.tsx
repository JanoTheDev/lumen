import { useEffect, useState } from 'react'
import { LiveRegion } from '../ui'
import { Gallery } from '../ui/Gallery'
import { useIpc } from '../lib/ipc'
import { SettingsPage } from './settings/SettingsPage'
import { Home } from './home/Home'
import './home/home.css'
import { Onboarding } from './onboarding/Onboarding'
import './onboarding/onboarding.css'
import { isSectionId, type SectionId } from './settings/meta'
import { parseRoute, type Route } from './routes'

function useRoute(): [Route, (hash: string) => void] {
  const [route, setRoute] = useState(() => parseRoute(location.hash))
  useEffect(() => {
    const on = (): void => setRoute(parseRoute(location.hash))
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  // Main switches an open panel to another route without reloading it.
  useIpc('panel:route', (next) => {
    location.hash = `#/${next}`
  })
  return [route, (hash) => (location.hash = hash)]
}

/** The panel window: settings, onboarding and the home flyout share this entry. */
export function App(): JSX.Element {
  const [route, go] = useRoute()
  const section: SectionId =
    route.name === 'settings' && isSectionId(route.section) ? route.section : 'general'
  return (
    <>
      <LiveRegion />
      {route.name === 'gallery' && import.meta.env.DEV ? (
        <Gallery />
      ) : route.name === 'home' ? (
        <Home />
      ) : route.name === 'onboarding' ? (
        <Onboarding />
      ) : (
        <SettingsPage section={section} onNavigate={(id) => go(`#/settings/${id}`)} />
      )}
    </>
  )
}

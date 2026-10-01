import { useEffect, useState } from 'react'
import { LiveRegion } from '../ui'
import { Gallery } from '../ui/Gallery'
import { SettingsPage } from './settings/SettingsPage'
import { isSectionId, type SectionId } from './settings/meta'
import { parseRoute, type Route } from './routes'

function useRoute(): [Route, (hash: string) => void] {
  const [route, setRoute] = useState(() => parseRoute(location.hash))
  useEffect(() => {
    const on = (): void => setRoute(parseRoute(location.hash))
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return [route, (hash) => (location.hash = hash)]
}

/** The panel window: settings now; onboarding and home join it later. */
export function App(): JSX.Element {
  const [route, go] = useRoute()
  const section: SectionId =
    route.name === 'settings' && isSectionId(route.section) ? route.section : 'general'
  return (
    <>
      <LiveRegion />
      {route.name === 'gallery' && import.meta.env.DEV ? (
        <Gallery />
      ) : (
        <SettingsPage section={section} onNavigate={(id) => go(`#/settings/${id}`)} />
      )}
    </>
  )
}

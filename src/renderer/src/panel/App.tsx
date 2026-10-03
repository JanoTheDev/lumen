import { lazy, Suspense, useEffect, useState } from 'react'
import { LiveRegion } from '../ui'
import { Gallery } from '../ui/Gallery'
import { useIpc } from '../lib/ipc'
import { SettingsPage } from './settings/SettingsPage'
import { Home } from './home/Home'
import './home/home.css'
import './onboarding/onboarding.css'
import './tasks/tasks.css'
import { isSectionId, type SectionId } from './settings/meta'
import { parseRoute, type Route } from './routes'

// Home is the window that stays loaded; the other pages load when first opened.
const Onboarding = lazy(() =>
  import('./onboarding/Onboarding').then((m) => ({ default: m.Onboarding }))
)
const TasksPage = lazy(() => import('./tasks/TasksPage').then((m) => ({ default: m.TasksPage })))
const AnswerPage = lazy(() =>
  import('../cards/AnswerPage').then((m) => ({ default: m.AnswerPage }))
)

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
        <Suspense fallback={<p className="ui-hint">Loading…</p>}>
          <Onboarding />
        </Suspense>
      ) : route.name === 'answer' ? (
        <Suspense fallback={<p className="ui-hint">Loading…</p>}>
          <AnswerPage id={route.id} table={route.table} />
        </Suspense>
      ) : route.name === 'tasks' ? (
        <Suspense fallback={<p className="ui-hint">Loading…</p>}>
          <TasksPage id={route.id} />
        </Suspense>
      ) : (
        <SettingsPage section={section} onNavigate={(id) => go(`#/settings/${id}`)} />
      )}
    </>
  )
}
